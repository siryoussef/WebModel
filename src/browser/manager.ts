import type { Browser, BrowserContext, Page } from 'playwright-core';
import { findChromePath } from '../doctor.js';
import { InstanceStore } from './instance-store.js';
import { platform } from 'node:os';

export type BrowserStatus = 'running' | 'idle' | 'stopped';
export type BrowserMode = 'attach' | 'launch';
export type LoginStatus = 'idle' | 'opening' | 'waiting_for_user' | 'success' | 'failed';

export interface LoginState {
  providerId: string | null;
  instanceId: string | null;
  status: LoginStatus;
  message: string;
  startedAt: number | null;
}

export interface BrowserManagerOptions {
  profileDir: string;
  startupTimeout: number;
  idleShutdown: number;
  loginTimeout: number;
  instanceStore: InstanceStore;
  cdpUrl?: string;
  mode?: BrowserMode;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private rootContext: BrowserContext | null = null;
  private _status: BrowserStatus = 'stopped';
  private _mode: BrowserMode;
  private _loginState: LoginState = {
    providerId: null, instanceId: null, status: 'idle', message: '', startedAt: null,
  };
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly instanceStore: InstanceStore;

  constructor(private opts: BrowserManagerOptions) {
    this._mode = opts.mode ?? 'attach';
    this.instanceStore = opts.instanceStore;
  }

  // ── Root browser connection ────────────────────────────────────────────

  private async ensureRootBrowser(): Promise<void> {
    if (this.rootContext || this.browser) return;
    const { chromium } = await import('playwright-core');

    if (this._mode === 'attach') {
      const cdpUrl = this.opts.cdpUrl ?? 'http://127.0.0.1:9222';
      try {
        this.browser = await chromium.connectOverCDP(cdpUrl, { timeout: this.opts.startupTimeout });
        const contexts = this.browser.contexts();
        this.rootContext = contexts[0] ?? await this.browser.newContext();
        this._status = 'running';
        this.resetIdleTimer();
        return;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('ECONNREFUSED') || msg.includes('connect')) {
          throw new Error(
            `Cannot connect to browser at ${cdpUrl}.\n\n` +
            `Start your browser with remote debugging:\n\n` +
            this.getBrowserStartCommand() +
            `\n\nOr switch to launch mode: web-model-bridge --browser-mode launch`,
          );
        }
        throw err;
      }
    }

    // Launch mode root
    const executablePath = this.findChrome();
    if (!executablePath) throw new Error('No Chromium-based browser found. Install Chrome, Thorium, or Brave.');
    this.rootContext = await chromium.launchPersistentContext(this.opts.profileDir, {
      headless: true,
      executablePath,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling'],
      timeout: this.opts.startupTimeout,
    });
    this._status = 'running';
    this.resetIdleTimer();
  }

  // ── Per-instance isolated contexts ────────────────────────────────────

  /**
   * Get the isolated BrowserContext for a specific instance.
   * Cookies are restored from JSON on first access.
   */
  async getContextForInstance(instanceId: string): Promise<BrowserContext> {
    return this.instanceStore.getContext(instanceId, async () => {
      const { chromium } = await import('playwright-core');

      if (this._mode === 'attach') {
        await this.ensureRootBrowser();
        if (!this.browser) throw new Error('Browser not connected');
        // Fully isolated context — separate cookie jar
        return this.browser.newContext();
      }

      // Launch mode: per-instance profile sub-dir (headless)
      const executablePath = this.findChrome();
      if (!executablePath) throw new Error('No Chromium-based browser found.');
      const { join } = await import('node:path');
      const { mkdirSync } = await import('node:fs');
      const instanceProfileDir = join(this.opts.profileDir, 'instances', instanceId);
      mkdirSync(instanceProfileDir, { recursive: true });
      return chromium.launchPersistentContext(instanceProfileDir, {
        headless: true,
        executablePath,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling'],
        timeout: this.opts.startupTimeout,
      });
    });
  }

  // ── Domain-page cache (per instance) ──────────────────────────────────

  private domainPages = new Map<string, Map<string, Page>>();

  private getDomainCache(instanceId: string): Map<string, Page> {
    if (!this.domainPages.has(instanceId)) this.domainPages.set(instanceId, new Map());
    return this.domainPages.get(instanceId)!;
  }

  async getPageForOrigin(origin: string, instanceId?: string): Promise<Page> {
    const iid = instanceId ?? this.instanceStore.getDefaultInstance()?.id;
    if (!iid) throw new Error('No browser instance available. Add an instance first via the Dashboard.');

    const ctx = await this.getContextForInstance(iid);
    const cache = this.getDomainCache(iid);

    let page = cache.get(origin);
    if (page && page.isClosed()) { cache.delete(origin); page = undefined; }

    if (!page) {
      page = await ctx.newPage();
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        try { await page.goto(origin + '/', { waitUntil: 'commit', timeout: 10000 }); } catch {}
      }
      cache.set(origin, page);
    }

    return page;
  }

  async fetchInBrowser(url: string, init: RequestInit, instanceId?: string): Promise<Response> {
    const targetOrigin = new URL(url).origin;
    const page = await this.getPageForOrigin(targetOrigin, instanceId);

    const result = await page.evaluate(
      async ([fetchUrl, fetchInit]: [string, { method?: string; headers?: Record<string, string>; body?: string }]) => {
        const res = await fetch(fetchUrl, {
          method: fetchInit.method || 'GET',
          headers: fetchInit.headers,
          body: fetchInit.body,
          credentials: 'include',
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v: string, k: string) => { headers[k] = v; });
        const text = await res.text();
        return { status: res.status, headers, body: text, ok: res.ok };
      },
      [url, {
        method: init.method,
        headers: init.headers as Record<string, string>,
        body: init.body as string,
      }] as [string, { method?: string; headers?: Record<string, string>; body?: string }],
    );

    return new Response(result.body, { status: result.status, headers: result.headers });
  }

  // ── Login flow ────────────────────────────────────────────────────────

  /**
   * Open a login page inside the specified instance's context.
   * Brings the browser window to the foreground so the user sees it
   * regardless of which browser they used to open the Dashboard.
   * After login, cookies are saved to disk as a compact JSON file.
   */
  async startLogin(
    providerId: string,
    instanceId: string,
    loginUrl: string,
    onComplete: (success: boolean) => void,
  ): Promise<void> {
    if (this._loginState.status === 'opening' || this._loginState.status === 'waiting_for_user') {
      throw new Error(`Login already in progress for ${this._loginState.providerId}.`);
    }

    this._loginState = {
      providerId, instanceId, status: 'opening',
      message: 'Opening login tab...', startedAt: Date.now(),
    };

    try {
      if (this._mode === 'attach') {
        const ctx = await this.getContextForInstance(instanceId);
        const page = await ctx.newPage();

        this._loginState = {
          providerId, instanceId, status: 'waiting_for_user',
          message: `Log in at ${loginUrl} and close the tab when done.`,
          startedAt: Date.now(),
        };

        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: this.opts.startupTimeout });
        try { await page.bringToFront(); } catch {}

        const waitDone = async () => {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => { page.close().catch(() => {}); resolve(); }, this.opts.loginTimeout * 1000);
            page.on('close', () => { clearTimeout(timeout); resolve(); });
          });

          await this.instanceStore.saveCookies(instanceId);
          this.instanceStore.markProvider(instanceId, providerId);

          this._loginState = { providerId, instanceId, status: 'success', message: `Login completed for ${providerId}.`, startedAt: null };
          onComplete(true);
          setTimeout(() => {
            if (this._loginState.status === 'success') {
              this._loginState = { providerId: null, instanceId: null, status: 'idle', message: '', startedAt: null };
            }
          }, 10000);
        };

        waitDone().catch(() => {
          this._loginState = { providerId, instanceId, status: 'failed', message: 'Login tab closed unexpectedly.', startedAt: null };
          onComplete(false);
        });
        return;
      }

      // Launch mode: open headed window, then export cookies to headless context
      const { chromium } = await import('playwright-core');
      const executablePath = this.findChrome();
      if (!executablePath) {
        this._loginState = { providerId, instanceId, status: 'failed', message: 'No Chromium-based browser found.', startedAt: null };
        onComplete(false);
        return;
      }

      const { join } = await import('node:path');
      const { mkdirSync } = await import('node:fs');
      const instanceProfileDir = join(this.opts.profileDir, 'instances', instanceId);
      mkdirSync(instanceProfileDir, { recursive: true });

      const headedContext = await chromium.launchPersistentContext(instanceProfileDir, {
        headless: false,
        executablePath,
        args: ['--no-first-run', '--no-default-browser-check'],
        timeout: this.opts.startupTimeout,
      });

      const page: Page = await headedContext.newPage();
      this._loginState = {
        providerId, instanceId, status: 'waiting_for_user',
        message: `Browser window opened. Please log in at ${loginUrl}`,
        startedAt: Date.now(),
      };

      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      try { await page.bringToFront(); } catch {}

      const waitForCompletion = async () => {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { page.close().catch(() => {}); resolve(); }, this.opts.loginTimeout * 1000);
          page.on('close', () => { clearTimeout(timeout); resolve(); });
          headedContext.on('close', () => { clearTimeout(timeout); resolve(); });
        });

        // Export cookies from headed → save JSON → inject into headless context
        const cookies = await headedContext.cookies();
        await headedContext.close().catch(() => {});
        const headlessCtx = await this.getContextForInstance(instanceId);
        await headlessCtx.addCookies(cookies);
        await this.instanceStore.saveCookies(instanceId);
        this.instanceStore.markProvider(instanceId, providerId);

        this._loginState = { providerId, instanceId, status: 'success', message: `Login completed for ${providerId}.`, startedAt: null };
        onComplete(true);
        setTimeout(() => {
          if (this._loginState.status === 'success') {
            this._loginState = { providerId: null, instanceId: null, status: 'idle', message: '', startedAt: null };
          }
        }, 10000);
      };

      waitForCompletion().catch((err) => {
        this._loginState = { providerId, instanceId, status: 'failed', message: `Login failed: ${(err as Error).message}`, startedAt: null };
        onComplete(false);
      });

    } catch (err) {
      this._loginState = { providerId, instanceId, status: 'failed', message: `Failed: ${(err as Error).message}`, startedAt: null };
      onComplete(false);
    }
  }

  // ── Auth detection ────────────────────────────────────────────────────

  static readonly SESSION_COOKIES: Record<string, { domain: string; cookieNames: string[] }> = {
    'claude-web':     { domain: 'claude.ai',      cookieNames: ['sessionKey'] },
    'chatgpt-web':    { domain: 'chatgpt.com',     cookieNames: ['__Secure-next-auth.session-token', '__Secure-next-auth.session-token.0'] },
    'deepseek-web':   { domain: 'deepseek.com',    cookieNames: ['ds_session_id', 'token'] },
    'kimi-web':       { domain: 'moonshot.cn',     cookieNames: ['access_token'] },
    'qwen-web':       { domain: 'qwen.ai',         cookieNames: ['cna', 'ajs_anonymous_id'] },
    'glm-web':        { domain: 'chatglm.cn',      cookieNames: ['chatglm_refresh_token'] },
    'grok-web':       { domain: 'grok.com',        cookieNames: ['sso', 'ct0'] },
    'gemini-web':     { domain: 'google.com',      cookieNames: ['SID', '__Secure-1PSID'] },
    'perplexity-web': { domain: 'perplexity.ai',   cookieNames: ['__Secure-next-auth.session-token', 'next-auth.session-token'] },
    'doubao-web':     { domain: 'doubao.com',      cookieNames: ['sessionid'] },
    'xiaomimo-web':   { domain: 'xiaomimimo.com',  cookieNames: ['sessionid', 'token'] },
  };

  /** Scan saved cookie JSON files — no live browser needed. */
  detectAuthFromSavedCookies(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const instanceId of this.instanceStore.instanceIdsWithSavedCookies()) {
      const authenticated: string[] = [];
      for (const [pid, { domain, cookieNames }] of Object.entries(BrowserManager.SESSION_COOKIES)) {
        if (this.instanceStore.hasCookiesForProvider(instanceId, domain, cookieNames)) {
          authenticated.push(pid);
        }
      }
      if (authenticated.length > 0) result[instanceId] = authenticated;
    }
    return result;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  getLoginState(): LoginState { return { ...this._loginState }; }
  getMode(): BrowserMode { return this._mode; }
  getStatus(): BrowserStatus { return this._status; }

  async detectCDP(cdpUrl?: string): Promise<boolean> {
    const url = cdpUrl ?? this.opts.cdpUrl ?? 'http://127.0.0.1:9222';
    try {
      const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch { return false; }
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.domainPages.clear();
    this.instanceStore.closeAll();
    if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; }
    if (this.rootContext) { await this.rootContext.close().catch(() => {}); this.rootContext = null; }
    this._status = 'stopped';
  }

  private getBrowserStartCommand(): string {
    const chromePath = this.findChrome();
    const os = platform();
    if (os === 'darwin') return `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222`;
    if (os === 'win32') return `  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222`;
    return `  ${chromePath ?? 'google-chrome'} --remote-debugging-port=9222`;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.opts.idleShutdown > 0) {
      this.idleTimer = setTimeout(() => {
        this._status = 'idle';
        this.shutdown();
      }, this.opts.idleShutdown * 1000);
    }
  }

  private findChrome(): string | undefined { return findChromePath(); }
}
