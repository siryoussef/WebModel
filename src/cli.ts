import { program } from 'commander';
import chalk from 'chalk';
import open from 'open';
import { serve } from '@hono/node-server';
import { createApp } from './server.js';
import { loadConfig } from './config/loader.js';
import { ProviderRegistry } from './core/registry.js';
import { AuthStore } from './auth/store.js';
import { BrowserManager } from './browser/manager.js';
import { InstanceStore } from './browser/instance-store.js';
import { ClaudeProvider } from './providers/claude/index.js';
import { ChatGPTProvider } from './providers/chatgpt/index.js';
import { DeepSeekProvider } from './providers/deepseek/index.js';
import { KimiProvider } from './providers/kimi-web/index.js';
import { QwenProvider } from './providers/qwen-web/index.js';
import { GLMProvider } from './providers/glm-web/index.js';
import { GrokProvider } from './providers/grok-web/index.js';
import { GeminiProvider } from './providers/gemini-web/index.js';
import { PerplexityProvider } from './providers/perplexity-web/index.js';
import { DoubaoProvider } from './providers/doubao-web/index.js';
import { XiaomimoProvider } from './providers/xiaomimo-web/index.js';
import type { BaseProvider } from './core/provider.js';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { runDoctor, printDoctorResults, findChromePath } from './doctor.js';

const PROVIDER_MAP: Record<string, new (auth: AuthStore, fetch?: (url: string, init: RequestInit) => Promise<Response>, getPage?: (origin: string) => Promise<import('playwright-core').Page>) => BaseProvider> = {
  'claude-web': ClaudeProvider,
  'chatgpt-web': ChatGPTProvider,
  'deepseek-web': DeepSeekProvider,
  'kimi-web': KimiProvider,
  'qwen-web': QwenProvider,
  'glm-web': GLMProvider,
  'grok-web': GrokProvider,
  'gemini-web': GeminiProvider,
  'perplexity-web': PerplexityProvider,
  'doubao-web': DoubaoProvider,
  'xiaomimo-web': XiaomimoProvider,
};

const DEFAULT_STATE_DIR = join(homedir(), '.webmodel');

// ─── Helpers ───

/** Check if a port is available */
function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port, host);
  });
}

/** Find an available port starting from preferred */
async function findAvailablePort(preferred: number, host: string): Promise<number> {
  for (let port = preferred; port < preferred + 100; port++) {
    if (await isPortAvailable(port, host)) return port;
  }
  throw new Error(`No available port found in range ${preferred}-${preferred + 99}`);
}

/** Check if a Chromium-based browser is running (any instance) */
function isChromeRunning(): boolean {
  try {
    const os = platform();
    if (os === 'darwin') {
      execSync('pgrep -x "Google Chrome|Thorium|Brave Browser|Chromium|Microsoft Edge|Vivaldi"', { stdio: 'ignore' });
      return true;
    } else if (os === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf-8' });
      return out.includes('chrome.exe');
    } else {
      execSync('pgrep -x "chrome|chromium|google-chrome|thorium|thorium-browser|brave|brave-browser|msedge|vivaldi"', { stdio: 'ignore' });
      return true;
    }
  } catch {
    return false;
  }
}

/** Check if CDP is available */
async function checkCDP(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Try to launch Chrome with debugging port */
async function launchChromeWithCDP(cdpPort: number, profileDir: string): Promise<boolean> {
  const chromePath = findChromePath();
  if (!chromePath) return false;

  // Must use non-default profile dir — Chrome refuses CDP on default profile
  mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check'
  ];

  try {
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    // Wait for CDP to become available (up to 10 seconds)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await checkCDP(`http://127.0.0.1:${cdpPort}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Get platform-specific Chrome launch command for display */
function getChromeCommand(port: number): string {
  const os = platform();
  if (os === 'darwin') {
    return `/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}`;
  } else if (os === 'win32') {
    return `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${port}`;
  }
  return `google-chrome --remote-debugging-port=${port}`;
}

// ─── Main ───

program
  .name('web-model-bridge')
  .description('Bridge web AI models through OpenAI-compatible API')
  .version('0.1.0')
  .option('-p, --port <port>', 'listen port', parseInt)
  .option('--host <host>', 'bind address')
  .option('--auth-token <token>', 'require Bearer token for API access')
  .option('--no-open', 'do not open dashboard in browser')
  .option('--state-dir <dir>', 'data directory', DEFAULT_STATE_DIR)
  .option('--config <file>', 'config file path')
  .option('-v, --verbose', 'verbose logging')
  .option('--browser-mode <mode>', 'browser mode: attach (default) or launch', 'attach')
  .option('--cdp-url <url>', 'Chrome CDP URL for attach mode', 'http://127.0.0.1:9222')
  .option('--chrome-profile <dir>', 'Chrome user data directory (e.g. ~/.openclaw/browser/openclaw/user-data)')
  .action(async (opts) => {
    console.log('');

    const stateDir = opts.stateDir;
    mkdirSync(stateDir, { recursive: true });

    // ── Step 1: Environment check ──
    const doctorResults = await runDoctor();
    const hasFatal = doctorResults.some(r => r.status === 'fail');
    if (hasFatal) {
      printDoctorResults(doctorResults);
      console.log(chalk.red('  Cannot start. Please fix the issues above.'));
      process.exit(1);
    }
    if (opts.verbose) {
      printDoctorResults(doctorResults);
    }

    const config = loadConfig({
      stateDir,
      configFile: opts.config,
      port: opts.port,
      host: opts.host,
      authToken: opts.authToken,
      verbose: opts.verbose,
    });

    // ── Step 2: Find available port ──
    let serverPort = config.server.port;
    const serverHost = config.server.host;
    if (!(await isPortAvailable(serverPort, serverHost))) {
      const oldPort = serverPort;
      serverPort = await findAvailablePort(serverPort + 1, serverHost);
      console.log(chalk.yellow(`  ⚠ Port ${oldPort} in use, using ${serverPort} instead`));
    }

    // ── Step 3: Browser setup ──
    const browserMode = (opts.browserMode === 'launch' ? 'launch' : 'attach') as 'attach' | 'launch';
    const cdpPort = parseInt(new URL(opts.cdpUrl).port, 10) || 9222;
    const cdpUrl = opts.cdpUrl;
    // Chrome profile: custom > config > default
    const chromeProfileDir = opts.chromeProfile ?? config.browser.profileDir ?? join(stateDir, 'chrome-profile');

    if (browserMode === 'attach') {
      const cdpAvailable = await checkCDP(cdpUrl);

      if (cdpAvailable) {
        console.log(chalk.green('  ✓') + ` Chrome CDP connected at ${cdpUrl}`);
      } else {
        // CDP not available — figure out why and try to fix
        const chromeRunning = isChromeRunning();

        if (chromeRunning) {
          // Chrome is running but WITHOUT debugging port
          // Try launching a SECOND Chrome with independent profile + CDP
          console.log(chalk.gray('  … Chrome running without CDP. Launching a dedicated instance...'));

          const launched = await launchChromeWithCDP(cdpPort, chromeProfileDir);
          if (launched) {
            console.log(chalk.green('  ✓') + ` Dedicated Chrome launched with CDP at port ${cdpPort}`);
            console.log(chalk.gray(`    Profile: ${chromeProfileDir}`));
            console.log(chalk.gray('    First time? Login via Dashboard after server starts.'));
          } else {
            console.log(chalk.yellow('  ⚠ Could not launch dedicated Chrome.'));
            console.log(chalk.yellow('    Option 1: Quit Chrome (Cmd+Q), then run web-model-bridge again'));
            console.log(chalk.yellow('    Option 2: Use launch mode: web-model-bridge --browser-mode launch'));
            console.log('');
          }
        } else {
          // Chrome not running at all — auto-launch with CDP + dedicated profile
          console.log(chalk.gray('  … Chrome not running, launching with debug port...'));

          const launched = await launchChromeWithCDP(cdpPort, chromeProfileDir);
          if (launched) {
            console.log(chalk.green('  ✓') + ` Chrome launched with CDP at port ${cdpPort}`);
            console.log(chalk.gray(`    Profile: ${chromeProfileDir}`));
          } else {
            console.log(chalk.yellow('  ⚠ Could not auto-launch Chrome with debug port.'));
            console.log(chalk.yellow('    Please start manually:'));
            console.log(chalk.cyan(`    ${getChromeCommand(cdpPort)}`));
            console.log('');
          }
        }
      }
    } else {
      console.log(chalk.green('  ✓') + ' Browser mode: launch (independent Chrome)');
    }

    const instanceStore = new InstanceStore(stateDir);
    // Ensure there's always at least one default instance
    if (instanceStore.getInstances().length === 0) {
      instanceStore.createInstance('Default');
    }

    const browserManager = new BrowserManager({
      profileDir: config.browser.profileDir,
      startupTimeout: config.browser.startupTimeout,
      idleShutdown: config.browser.idleShutdown,
      loginTimeout: config.browser.loginTimeout,
      instanceStore,
      cdpUrl,
      mode: browserMode,
    });

    // ── Step 4: Register providers ──
    const registry = new ProviderRegistry();
    const authStore = new AuthStore(stateDir);

    // Instance-aware fetch/getPage — picks the right cookie jar per request
    const browserFetch = (url: string, init: RequestInit, instanceId?: string) =>
      browserManager.fetchInBrowser(url, init, instanceId);
    const getPage = (origin: string, instanceId?: string) =>
      browserManager.getPageForOrigin(origin, instanceId);

    // Providers that need getPage for multi-step browser-context API calls
    const NEEDS_GET_PAGE = new Set([
      'claude-web', 'deepseek-web', 'qwen-web', 'doubao-web',
      'glm-web', 'kimi-web',
    ]);

    const enabled = new Set(config.providers.enabled);
    for (const [id, Ctor] of Object.entries(PROVIDER_MAP)) {
      if (enabled.has(id)) {
        if (NEEDS_GET_PAGE.has(id)) {
          registry.register(new Ctor(authStore, browserFetch, getPage));
        } else {
          registry.register(new Ctor(authStore, browserFetch));
        }
      }
    }

    // ── Step 4b: Auto-detect authenticated providers from saved cookies ──
    const savedAuth = browserManager.detectAuthFromSavedCookies();
    let autoAuthCount = 0;
    for (const [instanceId, providerIds] of Object.entries(savedAuth)) {
      const inst = instanceStore.getInstance(instanceId);
      if (!inst) continue;
      for (const providerId of providerIds) {
        if (!enabled.has(providerId)) continue;
        const existing = authStore.getAccounts(providerId)
          .find(a => a.instanceId === instanceId);
        if (!existing) {
          authStore.addAccount(providerId, inst.label, instanceId);
        } else {
          authStore.setAccountStatus(providerId, existing.id, 'active');
        }
        autoAuthCount++;
      }
    }
    if (autoAuthCount > 0) {
      console.log(chalk.green('  ✓') + ` Restored ${autoAuthCount} authenticated provider sessions from saved cookies`);
    }

    // ── Step 5: Create and start server ──
    const app = createApp({
      registry,
      authStore,
      instanceStore,
      authToken: config.server.authToken,
      getBrowserStatus: () => browserManager.getStatus(),
      onLogin: async (providerId: string, instanceId: string, accountLabel?: string) => {
        const provider = registry.getProvider(providerId);
        if (!provider) return { status: 'error', message: `Provider "${providerId}" not found.` };

        const inst = instanceStore.getInstance(instanceId);
        const instLabel = inst?.label ?? 'Default';
        const label = accountLabel?.trim() || instLabel;
        const account = authStore.addAccount(providerId, label, instanceId);

        await browserManager.startLogin(providerId, instanceId, provider.info.loginUrl, (success) => {
          if (success) {
            authStore.setAccountStatus(providerId, account.id, 'active');
            console.log(chalk.green(`  ✓ ${providerId} [${label} @ ${instLabel}] login completed.`));
          } else {
            authStore.removeAccount(providerId, account.id);
            console.log(chalk.yellow(`  ⚠ ${providerId} login did not complete.`));
          }
        });

        return {
          status: 'login_started',
          message: browserMode === 'attach'
            ? 'A new tab opened in your Chrome. Log in and close the tab when done.'
            : 'A Chrome window opened. Log in and close it when done.',
        };
      },
      getLoginState: () => browserManager.getLoginState(),
    });

    serve({
      fetch: app.fetch,
      port: serverPort,
      hostname: serverHost,
    });

    const url = `http://${serverHost === '0.0.0.0' ? 'localhost' : serverHost}:${serverPort}`;

    console.log(chalk.green('  ✓') + ` Server running at ${chalk.cyan(url)}`);
    console.log(chalk.green('  ✓') + ` API Base: ${chalk.cyan(url + '/v1')}`);

    const providerStatuses = await registry.providerStatus();
    const authCount = providerStatuses.filter(p => p.authenticated).length;
    console.log(chalk.green('  ✓') + ` ${providerStatuses.length} providers, ${authCount} authenticated`);

    if (opts.open !== false && config.server.openDashboard) {
      console.log(chalk.green('  ✓') + ` Dashboard: ${chalk.cyan(url)} (opening in browser)`);
      await open(url);
    } else {
      console.log(chalk.green('  ✓') + ` Dashboard: ${chalk.cyan(url)}`);
    }

    if (authCount === 0 && browserMode === 'attach') {
      const cdpNow = await checkCDP(cdpUrl);
      if (cdpNow) {
        console.log('');
        console.log(chalk.green('  ✓ Chrome is connected. Your existing login sessions are available.'));
        console.log(chalk.gray('    Requests will use cookies from your Chrome browser.'));
      }
    }

    console.log('');
    console.log(chalk.gray('  Press Ctrl+C to stop'));
    console.log('');

    process.on('SIGINT', async () => {
      console.log(chalk.gray('\n  Shutting down...'));
      await browserManager.shutdown();
      process.exit(0);
    });
  });

program
  .command('install-service')
  .description('Register as system service (launchd/systemd)')
  .action(() => {
    console.log(chalk.yellow('install-service is planned for Phase 2.'));
  });

program
  .command('uninstall-service')
  .description('Uninstall system service')
  .action(() => {
    console.log(chalk.yellow('uninstall-service is planned for Phase 2.'));
  });

program.parse();
