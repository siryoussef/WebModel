import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AuthStatus = 'active' | 'expired' | 'none';

// ── Single-account status (for backward compat with providers/registry) ──
export interface ProviderAuthStatus {
  providerId: string;
  status: AuthStatus;
  lastCheck: string | null;
}

// ── Multi-account structures ──
export interface Account {
  id: string;           // UUID
  label: string;        // user-facing name, e.g. "Personal", "Work"
  instanceId: string;   // which BrowserInstance this account's cookies live in
  status: AuthStatus;
  lastCheck: string;
}

export interface ProviderAccounts {
  accounts: Account[];
  /** ID of the account used for round-robin / default routing */
  activeId: string | null;
}

interface AuthData {
  [providerId: string]: ProviderAccounts;
}

export class AuthStore {
  private data: AuthData;
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, 'auth.json');
    this.data = this.load();
  }

  // ── Account management ─────────────────────────────────────────────────

  getAccounts(providerId: string): Account[] {
    return this.data[providerId]?.accounts ?? [];
  }

  getAccount(providerId: string, accountId: string): Account | undefined {
    return this.data[providerId]?.accounts.find(a => a.id === accountId);
  }

  getActiveAccountId(providerId: string): string | null {
    return this.data[providerId]?.activeId ?? null;
  }

  getActiveAccount(providerId: string): Account | undefined {
    const entry = this.data[providerId];
    if (!entry || !entry.activeId) return entry?.accounts[0];
    return entry.accounts.find(a => a.id === entry.activeId) ?? entry.accounts[0];
  }

  /**
   * Add a new account for a provider tied to a specific browser instance.
   */
  addAccount(providerId: string, label: string, instanceId: string): Account {
    if (!this.data[providerId]) {
      this.data[providerId] = { accounts: [], activeId: null };
    }
    const entry = this.data[providerId];
    const id = randomUUID();
    const account: Account = {
      id,
      label,
      instanceId,
      status: 'active',
      lastCheck: new Date().toISOString(),
    };
    entry.accounts.push(account);
    if (!entry.activeId) entry.activeId = id;
    this.save();
    return account;
  }

  /**
   * Update an account's status after a successful/failed login or auth check.
   */
  setAccountStatus(providerId: string, accountId: string, status: AuthStatus): void {
    const account = this.getAccount(providerId, accountId);
    if (!account) return;
    account.status = status;
    account.lastCheck = new Date().toISOString();
    this.save();
  }

  setActiveAccount(providerId: string, accountId: string): void {
    if (!this.data[providerId]) return;
    this.data[providerId].activeId = accountId;
    this.save();
  }

  removeAccount(providerId: string, accountId: string): void {
    const entry = this.data[providerId];
    if (!entry) return;
    entry.accounts = entry.accounts.filter(a => a.id !== accountId);
    if (entry.activeId === accountId) {
      entry.activeId = entry.accounts[0]?.id ?? null;
    }
    if (entry.accounts.length === 0) {
      delete this.data[providerId];
    }
    this.save();
  }

  // ── Round-robin selection for load balancing ────────────────────────────

  private rrIndex: Record<string, number> = {};

  /**
   * Pick the next active account for a provider in round-robin fashion.
   * Falls back to the first active account if round-robin exhausts.
   */
  pickAccount(providerId: string): Account | undefined {
    const active = (this.data[providerId]?.accounts ?? []).filter(a => a.status === 'active');
    if (active.length === 0) return undefined;
    const idx = (this.rrIndex[providerId] ?? 0) % active.length;
    this.rrIndex[providerId] = idx + 1;
    return active[idx];
  }

  // ── Backward-compatible single-status API ───────────────────────────────

  /** Returns 'active' if ANY account is active, 'none' otherwise. */
  getStatus(providerId: string): ProviderAuthStatus {
    const accounts = this.getAccounts(providerId);
    const active = accounts.find(a => a.status === 'active');
    if (!active) return { providerId, status: 'none', lastCheck: null };
    return { providerId, status: active.status, lastCheck: active.lastCheck };
  }

  getAllStatuses(): ProviderAuthStatus[] {
    return Object.keys(this.data).map(id => this.getStatus(id));
  }

  /** Compat: add/update a single unnamed account. */
  setStatus(providerId: string, status: AuthStatus, instanceId?: string): void {
    const accounts = this.getAccounts(providerId);
    if (accounts.length === 0) {
      this.addAccount(providerId, 'Default', instanceId ?? 'default');
      this.setAccountStatus(providerId, this.data[providerId].accounts[0].id, status);
    } else {
      const active = this.getActiveAccount(providerId);
      if (active) this.setAccountStatus(providerId, active.id, status);
    }
  }

  /** Compat: remove all accounts for a provider. */
  clearStatus(providerId: string): void {
    delete this.data[providerId];
    this.save();
  }

  private load(): AuthData {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const migrated: AuthData = {};
      for (const [pid, val] of Object.entries(parsed as Record<string, any>)) {
        if (val && typeof val === 'object' && 'accounts' in val) {
          // Current format — ensure instanceId exists (migration from storageKey era)
          const entry = val as ProviderAccounts;
          entry.accounts = entry.accounts.map((a: any) => ({
            ...a,
            instanceId: a.instanceId ?? a.storageKey ?? 'default',
          }));
          migrated[pid] = entry;
        } else if (val && typeof val === 'object' && 'status' in val) {
          // Old flat format — migrate to single default account
          const id = randomUUID();
          migrated[pid] = {
            accounts: [{
              id,
              label: 'Default',
              instanceId: 'default',
              status: val.status as AuthStatus,
              lastCheck: val.lastCheck ?? new Date().toISOString(),
            }],
            activeId: id,
          };
        }
      }
      return migrated;
    } catch {
      return {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}
