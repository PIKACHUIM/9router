import pkg from "../../../package.json" with { type: "json" };

// App configuration
export const APP_CONFIG = {
  name: "9Router Proxy",
  description: "AI Infrastructure Management",
  version: pkg.version,
};

// GitHub configuration
export const GITHUB_CONFIG = {
  changelogUrl: "https://raw.githubusercontent.com/decolua/9router/refs/heads/master/CHANGELOG.md",
  donateUrl: "https://9router.com/api/donate",
};

// Updater configuration
export const UPDATER_CONFIG = {
  npmPackageName: "9router",
  installCmd: "npm i -g 9router",
  installCmdLatest: "npm i -g 9router@latest --prefer-online",
  shutdownCountdownSec: 3,
  exitDelayMs: 500,
  statusPort: 20129,
  statusPollIntervalMs: 1000,
  statusLogTailLines: 8,
  installRetries: 3,
  installRetryDelayMs: 5000,
  lingerAfterDoneMs: 30000,
  waitForExitMinMs: 5000,
  waitForExitMaxMs: 20000,
  waitForExitCheckMs: 500,
  appPort: 20128,
};

// Theme configuration
export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system", // "light" | "dark" | "system"
};

// Subscription
export const SUBSCRIPTION_CONFIG = {
  price: 1.0,
  currency: "USD",
  interval: "month",
  planName: "Pro Plan",
};

// API endpoints
export const API_ENDPOINTS = {
  users: "/api/users",
  providers: "/api/providers",
  payments: "/api/payments",
  auth: "/api/auth",
};

export const CONSOLE_LOG_CONFIG = {
  maxLines: 200,
  pollIntervalMs: 1000,
};

// Client-side store TTL: how long fetched data stays fresh before re-fetching
export const CLIENT_STORE_TTL_MS = 60000;

// Quota auto-ping: keep 5h windows warm by sending a tiny request right after reset.
export const QUOTA_AUTOPING_CONFIG = {
  tickIntervalMs: 60000,                // scheduler tick
  pingLeadMs: 5000,                     // fire once reset passes (within tolerance)
  refreshAheadMs: 300000,               // refetch usage when within 5min of reset
  failureCooldownMs: 900000,            // avoid failed ping spam while upstream/auth is unhealthy
  providers: {
    claude: {
      settingsKey: "claudeAutoPing",    // preserve existing settings contract
      quotaKey: "session (5h)",         // quota key returned by usage handler
      pingModel: "claude-haiku-4-5-20251001",
      pingText: "hi",
      pingMaxTokens: 1,
    },
    codex: {
      settingsKey: "codexAutoPing",
      quotaKey: "session",
      pingWhenResetAtSlides: true,
      resetAtDriftMs: 30000,
      minPingIntervalMs: 600000,
      skipWhenBlockingQuotaExhausted: true,
      // Free and Plus Codex accounts both expose gpt-5.5; avoid fallback probes that waste requests.
      pingModel: "gpt-5.5",
      pingText: "hi",
      pingInstructions: "Reply with OK.",
      pingReasoningEffort: "none",
    },
  },
};

// Usage snapshot warm-up: keeps the quota-weighted scheduler's allowance cache fresh
// without anyone having to open the dashboard.
//
// The scheduler reads each account's live quota packages from an in-memory cache that
// GET /api/usage/[connectionId] publishes into. That endpoint is only called by the
// usage page and by the auto-ping tick, so on an install nobody is watching, the cache
// stays empty and quota-weighted scheduling silently falls back to its legacy scoring.
// This loop walks the accounts itself at a deliberately low frequency.
//
// Deliberately gentle: it reuses the SAME usage endpoints the dashboard already calls,
// one account may be polled at most once per perConnectionMinIntervalMs (30 min, i.e.
// >= the 10 min cadence the claude usage endpoint tolerates), at most perTickLimit calls
// are made per tick so a large install spreads out instead of bursting, and an account
// whose call fails is left alone for failureCooldownMs.
export const USAGE_SNAPSHOT_CONFIG = {
  tickIntervalMs: 60 * 1000,            // scheduler tick
  perConnectionMinIntervalMs: 30 * 60 * 1000,
  failureCooldownMs: 30 * 60 * 1000,
  perTickLimit: 20,                     // upstream calls allowed per tick
};

// Daily check-in: auto sign-in for supported providers (currently CodeBuddy CN).
export const CHECKIN_CONFIG = {
  tickIntervalMs: 30 * 60 * 1000,       // scheduler tick (30min) — cheap: only hits API when not yet checked in
  checkWindowStartHour: 0,              // local hour after which check-in should happen
  failureCooldownMs: 60 * 60 * 1000,    // retry cooldown after a failed check-in
  concurrency: 3,                       // parallel accounts per run
  providers: {
    "codebuddy-cn": {
      settingsKey: "codebuddyCheckin",  // settings[settingsKey].connections[connId] === true
    },
  },
};

// Re-export from providers.js for backward compatibility
export {
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers.js";

// Re-export from models.js for backward compatibility
export {
  PROVIDER_MODELS,
  AI_MODELS,
} from "./models.js";
