// Client identity profiles ("客户端转换").
//
// CodeBuddy / WorkBuddy gateways (and the relays in front of them) reject
// requests whose User-Agent and marker headers do not match the official desktop
// clients — the account token alone is not enough. Keep the identity strings in
// one place so the registry defaults, the runtime header builder and the UI
// selector can never drift apart.
//
// Upstream reference (official clients):
//   WorkBuddy/5.9.2 WorkBuddy/5.9.2 CLI/2.165.0
//   CodeBuddyIDE/5.0.0 CodeBuddy/2.177.1

export const CODEBUDDY_CLIENT_UA = "CodeBuddyIDE/5.0.0 CodeBuddy/2.177.1";
export const WORKBUDDY_CLIENT_UA = "WorkBuddy/5.9.2 WorkBuddy/5.9.2 CLI/2.165.0";

// Marker headers both clients send alongside the UA. The gateway keys its
// routing/quota logic on X-Product / X-IDE-* plus the two CodeBuddy markers.
const CODEBUDDY_MARKER_HEADERS = {
  "X-Product": "SaaS",
  "X-IDE-Type": "IDE",
  "X-IDE-Name": "IDE",
  "x-requested-with": "XMLHttpRequest",
  "x-codebuddy-request": "1",
};

const WORKBUDDY_MARKER_HEADERS = {
  ...CODEBUDDY_MARKER_HEADERS,
  // WorkBuddy reports itself as the CLI build, not the IDE build.
  "X-IDE-Type": "CLI",
  "X-IDE-Name": "CLI",
};

export const CLIENT_PROFILES = {
  codebuddy: {
    id: "codebuddy",
    label: "CodeBuddy",
    userAgent: CODEBUDDY_CLIENT_UA,
    headers: CODEBUDDY_MARKER_HEADERS,
  },
  workbuddy: {
    id: "workbuddy",
    label: "WorkBuddy",
    userAgent: WORKBUDDY_CLIENT_UA,
    headers: WORKBUDDY_MARKER_HEADERS,
  },
};

// Identity a conversion-enabled channel presents when the user has not chosen a
// profile or typed a UA. Product decision: default to the WorkBuddy client.
export const DEFAULT_CLIENT_UA = WORKBUDDY_CLIENT_UA;

// Selectable values. `auto` = detect from the channel (built-in provider, node
// name/prefix or baseUrl host); `none` = leave the request headers untouched.
export const CLIENT_PROFILE_CHOICES = ["auto", "codebuddy", "workbuddy", "none"];

// Select options shared by the node create/edit modals.
export const CLIENT_PROFILE_UI_OPTIONS = [
  { value: "auto", label: "Auto (detect CodeBuddy / WorkBuddy)" },
  { value: "codebuddy", label: "CodeBuddy client" },
  { value: "workbuddy", label: "WorkBuddy client" },
  { value: "none", label: "Off (leave headers unchanged)" },
];

const IDENTITY_HEADERS = ["user-agent", ...Object.keys(CODEBUDDY_MARKER_HEADERS).map((h) => h.toLowerCase())];

/** Normalize a stored/selected value to one of CLIENT_PROFILE_CHOICES. */
export function normalizeClientProfile(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return "auto";
  if (raw === "codebuddy" || raw === "codebuddy-ide" || raw === "cb" || raw === "cbcn" || raw === "cbai") return "codebuddy";
  if (raw === "workbuddy" || raw === "workbuddy-cli" || raw === "wb") return "workbuddy";
  if (raw === "none" || raw === "off" || raw === "default" || raw === "disabled") return "none";
  return "auto";
}

function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Hosts that belong to the CodeBuddy gateway family. A relay pointed straight at
// one of these is a CodeBuddy channel even when the node is named arbitrarily.
const CODEBUDDY_HOST_PATTERN = /(^|\.)(codebuddy\.(ai|cn|com)|copilot\.tencent\.com)$/;

/**
 * Detect which client family a channel belongs to.
 *
 * Order matters: provider id, then node/connection labels (relays are usually
 * named after the channel they resell), then the baseUrl host. Returns null when
 * the channel is not a CodeBuddy family channel.
 */
export function detectProfile(provider, credentials) {
  const data = credentials?.providerSpecificData || {};

  const providerId = String(provider || "").toLowerCase();
  if (providerId.includes("workbuddy")) return CLIENT_PROFILES.workbuddy;
  if (providerId.includes("codebuddy")) return CLIENT_PROFILES.codebuddy;

  // Node name, model prefix and connection name are what a reseller install
  // actually carries; both clients' names are distinctive enough to match.
  for (const label of [data.nodeName, data.prefix, data.name, credentials?.connectionName]) {
    const text = typeof label === "string" ? label.toLowerCase() : "";
    if (!text) continue;
    if (text.includes("workbuddy")) return CLIENT_PROFILES.workbuddy;
    if (text.includes("codebuddy")) return CLIENT_PROFILES.codebuddy;
  }

  const host = hostOf(data.baseUrl);
  if (host.includes("workbuddy")) return CLIENT_PROFILES.workbuddy;
  if (CODEBUDDY_HOST_PATTERN.test(host)) return CLIENT_PROFILES.codebuddy;

  return null;
}

/**
 * Resolve the client profile (marker set) a channel should use, honoring an
 * explicit selection and the off switch. Kept separate from
 * resolveClientIdentity() for callers that only need the family.
 */
export function resolveClientProfile({ provider, credentials } = {}) {
  const configured = normalizeClientProfile(credentials?.providerSpecificData?.clientProfile);
  if (configured === "none") return null;
  if (configured !== "auto") return CLIENT_PROFILES[configured] || null;
  return detectProfile(provider, credentials);
}

/**
 * Overwrite the identity headers in place. Any case variant of a marker header
 * is removed first, otherwise a node that declares its own `X-IDE-Type` would
 * end up sending two conflicting values.
 *
 * Accepts either a profile or the object returned by resolveClientIdentity().
 */
export function applyClientProfile(headers, identity) {
  if (!identity || !headers) return headers;
  const userAgent = identity.userAgent || CLIENT_PROFILES[identity.id]?.userAgent;
  const markers = identity.headers || CLIENT_PROFILES[identity.id]?.headers || {};
  for (const key of Object.keys(headers)) {
    if (IDENTITY_HEADERS.includes(key.toLowerCase())) delete headers[key];
  }
  if (userAgent) headers["User-Agent"] = userAgent;
  return Object.assign(headers, markers);
}

/** Header block a registry entry should ship as its static defaults. */
export function clientProfileHeaders(profileId) {
  const profile = CLIENT_PROFILES[profileId];
  if (!profile) return {};
  return { "User-Agent": profile.userAgent, ...profile.headers };
}

/**
 * A UA is attacker-adjacent input (it is written into an outbound header), so it
 * must never carry CR/LF or be unbounded.
 */
export function sanitizeClientUserAgent(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 256);
}

/** Marker set implied by a UA string, so custom UAs stay internally consistent. */
export function markersForUserAgent(userAgent) {
  const text = String(userAgent || "").toLowerCase();
  if (text.includes("workbuddy")) return CLIENT_PROFILES.workbuddy.headers;
  if (text.includes("codebuddy")) return CLIENT_PROFILES.codebuddy.headers;
  return null;
}

/**
 * Resolve the full outbound identity for a channel.
 *
 * UA precedence: per-connection/node override → selected profile → default
 * (WorkBuddy). Marker headers follow the UA family so a custom UA never ships
 * with markers from the other client; unknown UAs keep the profile's markers.
 *
 * Returns null for channels that are not CodeBuddy-family or where conversion
 * was explicitly disabled.
 */
export function resolveClientIdentity({ provider, credentials } = {}) {
  const data = credentials?.providerSpecificData || {};
  const mode = normalizeClientProfile(data.clientProfile);
  if (mode === "none") return null;

  const profile = mode === "auto" ? detectProfile(provider, credentials) : CLIENT_PROFILES[mode];
  if (!profile) return null;

  const custom = sanitizeClientUserAgent(data.clientUserAgent);
  const userAgent = custom || (mode === "auto" ? DEFAULT_CLIENT_UA : profile.userAgent);
  return {
    id: profile.id,
    userAgent,
    headers: markersForUserAgent(userAgent) || profile.headers,
  };
}
