/**
 * InstanceStore — manages named browser instances.
 *
 * An "instance" is a named, isolated Playwright BrowserContext that can hold
 * cookies for multiple providers simultaneously. For example:
 *
 *   "Personal"  → logged into claude.ai + chatgpt.com + gemini.google.com
 *   "Work"      → logged into claude.ai (different account) + chatgpt.com
 *
 * Cookies are saved to / restored from JSON files under stateDir/sessions/,
 * so the whole browser profile directory is NOT needed for persistence.
 * Only the minimal cookie data (~5-50KB per instance) is stored.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserContext, Cookie } from 'playwright-core';

export interface BrowserInstance {
  id: string;
  label: string;
  createdAt: string;
  /** Providers this instance is known to be logged into */
  providers: string[];
}

interface InstanceIndex {
  instances: BrowserInstance[];
}

export class InstanceStore {
  private readonly sessionsDir: string;
  private readonly indexPath: string;
  private index: InstanceIndex;

  /** Live Playwright contexts, keyed by instance ID */
  private contexts = new Map<string, BrowserContext>();

  constructor(stateDir: string) {
    this.sessionsDir = join(stateDir, 'sessions');
    this.indexPath = join(this.sessionsDir, 'index.json');
    mkdirSync(this.sessionsDir, { recursive: true });
    this.index = this.loadIndex();
  }

  // ── Instance lifecycle ─────────────────────────────────────────────────

  getInstances(): BrowserInstance[] {
    return this.index.instances;
  }

  getInstance(id: string): BrowserInstance | undefined {
    return this.index.instances.find(i => i.id === id);
  }

  getDefaultInstance(): BrowserInstance | undefined {
    return this.index.instances[0];
  }

  createInstance(label: string): BrowserInstance {
    const inst: BrowserInstance = {
      id: randomUUID(),
      label: label.trim() || 'Default',
      createdAt: new Date().toISOString(),
      providers: [],
    };
    this.index.instances.push(inst);
    this.saveIndex();
    return inst;
  }

  renameInstance(id: string, label: string): void {
    const inst = this.getInstance(id);
    if (inst) { inst.label = label.trim(); this.saveIndex(); }
  }

  removeInstance(id: string): void {
    this.index.instances = this.index.instances.filter(i => i.id !== id);
    this.saveIndex();
    // Close live context if open
    const ctx = this.contexts.get(id);
    if (ctx) { ctx.close().catch(() => {}); this.contexts.delete(id); }
    // Delete saved cookies
    const cookiePath = this.cookiePath(id);
    if (existsSync(cookiePath)) { try { unlinkSync(cookiePath); } catch {} }
  }

  /** Mark that an instance is now logged into a provider. */
  markProvider(instanceId: string, providerId: string): void {
    const inst = this.getInstance(instanceId);
    if (!inst) return;
    if (!inst.providers.includes(providerId)) {
      inst.providers.push(providerId);
      this.saveIndex();
    }
  }

  /** Remove a provider from an instance's provider list. */
  unmarkProvider(instanceId: string, providerId: string): void {
    const inst = this.getInstance(instanceId);
    if (!inst) return;
    inst.providers = inst.providers.filter(p => p !== providerId);
    this.saveIndex();
  }

  // ── Context management ─────────────────────────────────────────────────

  /**
   * Get (or create) the live Playwright BrowserContext for an instance.
   * If a saved cookie JSON exists, cookies are restored into the context.
   *
   * In attach mode: creates an isolated context on top of the CDP-connected browser.
   * In launch mode: creates an isolated context on top of the persistent browser.
   */
  async getContext(
    instanceId: string,
    createContext: () => Promise<BrowserContext>,
  ): Promise<BrowserContext> {
    let ctx = this.contexts.get(instanceId);
    if (ctx) return ctx;

    ctx = await createContext();

    // Restore saved cookies if available
    const saved = this.loadCookies(instanceId);
    if (saved.length > 0) {
      try {
        await ctx.addCookies(saved);
      } catch {
        // Cookies may be stale/invalid — not fatal
      }
    }

    this.contexts.set(instanceId, ctx);

    // Auto-save cookies whenever the context is used (on close)
    ctx.on('close', () => {
      this.contexts.delete(instanceId);
    });

    return ctx;
  }

  /**
   * Persist all cookies from a live context to disk as JSON.
   * Called after a successful login so sessions survive restarts.
   */
  async saveCookies(instanceId: string): Promise<void> {
    const ctx = this.contexts.get(instanceId);
    if (!ctx) return;
    try {
      const cookies = await ctx.cookies();
      writeFileSync(
        this.cookiePath(instanceId),
        JSON.stringify(cookies, null, 2),
        'utf-8',
      );
    } catch {
      // Non-fatal
    }
  }

  /**
   * Check if a specific provider's session cookies exist in an instance's
   * saved cookie file (without needing a live context).
   */
  hasCookiesForProvider(instanceId: string, domain: string, cookieNames: string[]): boolean {
    const cookies = this.loadCookies(instanceId);
    const matching = cookies.filter(c => c.domain?.includes(domain));
    return cookieNames.some(name => matching.some(c => c.name === name && c.value?.length > 0));
  }

  /** List all instance IDs that have a saved cookie file on disk. */
  instanceIdsWithSavedCookies(): string[] {
    try {
      return readdirSync(this.sessionsDir)
        .filter(f => f.endsWith('.cookies.json'))
        .map(f => f.replace('.cookies.json', ''));
    } catch {
      return [];
    }
  }

  closeAll(): void {
    for (const [id, ctx] of this.contexts) {
      ctx.close().catch(() => {});
      this.contexts.delete(id);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private cookiePath(instanceId: string): string {
    return join(this.sessionsDir, `${instanceId}.cookies.json`);
  }

  private loadCookies(instanceId: string): Cookie[] {
    try {
      const raw = readFileSync(this.cookiePath(instanceId), 'utf-8');
      return JSON.parse(raw) as Cookie[];
    } catch {
      return [];
    }
  }

  private loadIndex(): InstanceIndex {
    try {
      const raw = readFileSync(this.indexPath, 'utf-8');
      return JSON.parse(raw) as InstanceIndex;
    } catch {
      return { instances: [] };
    }
  }

  private saveIndex(): void {
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8');
  }
}
