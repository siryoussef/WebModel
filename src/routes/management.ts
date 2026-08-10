import { Hono } from 'hono';
import { ProviderRegistry } from '../core/registry.js';
import { AuthStore } from '../auth/store.js';
import { InstanceStore } from '../browser/instance-store.js';
import type { BrowserStatus, LoginState } from '../browser/manager.js';
import type { MetricsCollector } from '../core/metrics.js';

export interface ManagementDeps {
  registry: ProviderRegistry;
  authStore: AuthStore;
  instanceStore: InstanceStore;
  onLogin?: (providerId: string, instanceId: string, accountLabel?: string) => Promise<{ status: string; message: string }>;
  getLoginState?: () => LoginState;
  getBrowserStatus?: () => BrowserStatus;
  startTime?: number;
  metrics?: MetricsCollector;
}

export function managementRoutes(deps: ManagementDeps): Hono {
  const { registry, authStore, instanceStore, onLogin } = deps;
  const routeStartTime = deps.startTime ?? Date.now();
  const app = new Hono();

  // ── Instance management ────────────────────────────────────────────────

  app.get('/webmodel/instances', (c) => {
    return c.json({ instances: instanceStore.getInstances() });
  });

  app.post('/webmodel/instances/create', async (c) => {
    let body: { label: string };
    try { body = await c.req.json<{ label: string }>(); } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const inst = instanceStore.createInstance(body.label || 'Default');
    return c.json({ status: 'created', instance: inst });
  });

  app.post('/webmodel/instances/rename', async (c) => {
    let body: { instanceId: string; label: string };
    try { body = await c.req.json<{ instanceId: string; label: string }>(); } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    instanceStore.renameInstance(body.instanceId, body.label);
    return c.json({ status: 'ok' });
  });

  app.post('/webmodel/instances/remove', async (c) => {
    let body: { instanceId: string };
    try { body = await c.req.json<{ instanceId: string }>(); } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    instanceStore.removeInstance(body.instanceId);
    return c.json({ status: 'removed', instanceId: body.instanceId });
  });

  // ── Provider list (enriched with accounts + instances) ─────────────────

  app.get('/webmodel/providers', async (c) => {
    const statuses = await registry.providerStatus();
    const enriched = statuses.map(s => ({
      ...s,
      accounts: authStore.getAccounts(s.id),
      activeAccountId: authStore.getActiveAccountId(s.id),
    }));
    return c.json({ providers: enriched });
  });

  // ── Login: add account to an instance ─────────────────────────────────

  app.post('/webmodel/auth/login', async (c) => {
    let body: { providerId: string; instanceId?: string; accountLabel?: string };
    try { body = await c.req.json<{ providerId: string; instanceId?: string; accountLabel?: string }>(); } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const provider = registry.getProvider(body.providerId);
    if (!provider) {
      return c.json({ error: 'Unknown provider', message: `Provider "${body.providerId}" not found.` }, 404);
    }
    if (!onLogin) {
      return c.json({ error: 'Browser not available', message: 'Browser manager is not configured.' }, 503);
    }

    // Resolve instanceId — use provided, or default, or create one
    let instanceId = body.instanceId;
    if (!instanceId) {
      const def = instanceStore.getDefaultInstance();
      instanceId = def?.id ?? instanceStore.createInstance('Default').id;
    } else if (!instanceStore.getInstance(instanceId)) {
      return c.json({ error: 'Instance not found', instanceId }, 404);
    }

    try {
      const result = await onLogin(body.providerId, instanceId, body.accountLabel);
      return c.json(result);
    } catch (err) {
      return c.json({ status: 'error', message: (err as Error).message }, 500);
    }
  });

  app.get('/webmodel/auth/login-status', (c) => {
    if (!deps.getLoginState) return c.json({ providerId: null, instanceId: null, status: 'idle', message: '' });
    return c.json(deps.getLoginState());
  });

  // ── Account management ─────────────────────────────────────────────────

  app.get('/webmodel/auth/accounts', (c) => {
    const providerId = c.req.query('providerId');
    if (!providerId) return c.json({ error: 'providerId query param required' }, 400);
    return c.json({ accounts: authStore.getAccounts(providerId) });
  });

  app.post('/webmodel/auth/accounts/activate', async (c) => {
    let body: { providerId: string; accountId: string };
    try { body = await c.req.json<{ providerId: string; accountId: string }>(); } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    authStore.setActiveAccount(body.providerId, body.accountId);
    return c.json({ status: 'ok', activeAccountId: body.accountId });
  });

  app.post('/webmodel/auth/accounts/rename', async (c) => {
    let body: { providerId: string; accountId: string; label: string };
    try { body = await c.req.json<{ providerId: string; accountId: string; label: string }>(); } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const account = authStore.getAccount(body.providerId, body.accountId);
    if (!account) return c.json({ error: 'Account not found' }, 404);
    account.label = body.label;
    authStore.setAccountStatus(body.providerId, body.accountId, account.status);
    return c.json({ status: 'ok' });
  });

  app.post('/webmodel/auth/accounts/remove', async (c) => {
    let body: { providerId: string; accountId: string };
    try { body = await c.req.json<{ providerId: string; accountId: string }>(); } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    authStore.removeAccount(body.providerId, body.accountId);
    return c.json({ status: 'removed' });
  });

  app.post('/webmodel/auth/check', async (c) => {
    let body: { providerId: string };
    try { body = await c.req.json<{ providerId: string }>(); } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    return c.json(authStore.getStatus(body.providerId));
  });

  app.post('/webmodel/auth/logout', async (c) => {
    let body: { providerId: string; accountId?: string };
    try { body = await c.req.json<{ providerId: string; accountId?: string }>(); } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (body.accountId) {
      authStore.removeAccount(body.providerId, body.accountId);
      return c.json({ status: 'logged_out', providerId: body.providerId, accountId: body.accountId });
    }
    authStore.clearStatus(body.providerId);
    return c.json({ status: 'logged_out', providerId: body.providerId });
  });

  // ── Health ─────────────────────────────────────────────────────────────

  app.get('/webmodel/health', async (c) => {
    const statuses = await registry.providerStatus();
    const browserStatus = deps.getBrowserStatus ? deps.getBrowserStatus() : 'stopped';
    return c.json({
      status: 'healthy',
      uptime: Math.floor((Date.now() - routeStartTime) / 1000),
      browser: { status: browserStatus },
      instances: instanceStore.getInstances().length,
      providers: Object.fromEntries(
        statuses.map(s => [s.id, {
          authenticated: s.authenticated,
          models: s.modelCount,
          accounts: authStore.getAccounts(s.id).length,
        }])
      ),
    });
  });

  app.get('/webmodel/metrics', (c) => {
    if (!deps.metrics) return c.json({ error: 'Metrics not available' }, 503);
    return c.json(deps.metrics.getSummary());
  });

  app.get('/webmodel/logs', (c) => {
    if (!deps.metrics) return c.json({ error: 'Metrics not available' }, 503);
    const count = parseInt(c.req.query('count') ?? '50', 10);
    return c.json({ logs: deps.metrics.getRecent(count) });
  });

  return app;
}
