import {
  encodeBasicAuth,
  normaliseDomainScope,
  normaliseProxyEndpoint,
  originRegex
} from "./utils.mjs";

const NETWORK_RULE_ID = 1001;
const ROLE_RULE_ID = 1002;
const OWNED_RULE_IDS = [NETWORK_RULE_ID, ROLE_RULE_ID];
const requestAuthAttempts = new Map();
const TRANSFORM_MENU_ACTIONS = {
  "spectre-base64-encode": { tool: "base64", operation: "encode" },
  "spectre-base64-decode": { tool: "base64", operation: "decode" },
  "spectre-url-encode": { tool: "url", operation: "encode" },
  "spectre-url-decode": { tool: "url", operation: "decode" }
};
const ACTION_MENU_PREFIXES = {
  proxy: "spectre-action-proxy:",
  header: "spectre-action-header:",
  userAgent: "spectre-action-user-agent:",
  role: "spectre-action-role:"
};
let contextMenuBuild = Promise.resolve();

const DEFAULT_NETWORK_CONFIG = {
  enabled: false,
  scope: "origin",
  origin: "",
  userAgentEnabled: false,
  userAgent: "",
  userAgentProfiles: [],
  activeUserAgentId: null,
  headers: []
};

const DEFAULT_PROXY_CONFIG = {
  enabled: false,
  scheme: "http",
  host: "127.0.0.1",
  port: 8080,
  username: "",
  password: "",
  bypassList: ["localhost", "127.0.0.1", "<local>"]
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get([
    "networkConfig",
    "proxyConfig",
    "proxyProfiles",
    "activeProxyId",
    "roles"
  ]);
  const legacyProxy = { ...DEFAULT_PROXY_CONFIG, ...(current.proxyConfig ?? {}) };
  let proxyProfiles = current.proxyProfiles;
  let activeProxyId = current.activeProxyId ?? null;

  if (!Array.isArray(proxyProfiles)) {
    const migratedProfile = proxyProfileFromConfig(legacyProxy, crypto.randomUUID(), "Local proxy");
    proxyProfiles = [migratedProfile];
    activeProxyId = legacyProxy.enabled ? migratedProfile.id : null;
  }
  if (activeProxyId && !proxyProfiles.some(({ id }) => id === activeProxyId)) {
    activeProxyId = null;
  }

  await chrome.storage.local.set({
    networkConfig: migrateNetworkConfig({ ...DEFAULT_NETWORK_CONFIG, ...(current.networkConfig ?? {}) }),
    proxyConfig: activeProxyId
      ? profileToProxyConfig(proxyProfiles.find(({ id }) => id === activeProxyId))
      : { ...legacyProxy, enabled: false },
    proxyProfiles,
    activeProxyId,
    roles: normaliseRoles(current.roles ?? [])
  });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await queueContextMenuBuild();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: OWNED_RULE_IDS });
  await syncNetworkRules();
  await applyStoredProxy();
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreRoleCookie();
  await chrome.storage.session.remove("activeRole");
  await syncNetworkRules();
  await applyStoredProxy();
  await queueContextMenuBuild();
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
syncNetworkRules().catch(() => {});
queueContextMenuBuild().catch(() => {});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenu(info, tab).catch(async (error) => {
    console.error(error);
    await queueContextMenuBuild().catch(() => {});
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const localStateChanged = areaName === "local" &&
    ["networkConfig", "proxyProfiles", "activeProxyId", "roles"].some((key) => key in changes);
  const sessionStateChanged = areaName === "session" && "activeRole" in changes;
  if (localStateChanged || sessionStateChanged) {
    queueContextMenuBuild().catch((error) => console.error(error));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.webRequest.onAuthRequired.addListener(
  async (details, callback) => {
    if (!details.isProxy) {
      callback({});
      return;
    }

    const { proxyConfig = DEFAULT_PROXY_CONFIG } = await chrome.storage.local.get("proxyConfig");
    if (!proxyConfig.enabled || !proxyConfig.username) {
      callback({});
      return;
    }

    const attempts = requestAuthAttempts.get(details.requestId) ?? 0;
    if (attempts >= 1) {
      requestAuthAttempts.delete(details.requestId);
      callback({ cancel: true });
      return;
    }

    requestAuthAttempts.set(details.requestId, attempts + 1);
    callback({
      authCredentials: {
        username: proxyConfig.username,
        password: proxyConfig.password ?? ""
      }
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

chrome.webRequest.onCompleted.addListener(
  ({ requestId }) => requestAuthAttempts.delete(requestId),
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  ({ requestId }) => requestAuthAttempts.delete(requestId),
  { urls: ["<all_urls>"] }
);

function queueContextMenuBuild() {
  contextMenuBuild = contextMenuBuild
    .catch(() => {})
    .then(() => setupContextMenus());
  return contextMenuBuild;
}

async function createContextMenu(properties) {
  await new Promise((resolve, reject) => {
    chrome.contextMenus.create(properties, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function setupContextMenus() {
  const state = await getState();
  await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
  await createContextMenu({
    id: "spectre-transform-selection",
    title: "Send selection to Spectre",
    contexts: ["selection", "editable"]
  });
  for (const [id, title] of [
    ["spectre-base64-encode", "Base64 Encode"],
    ["spectre-base64-decode", "Base64 Decode"],
    ["spectre-url-encode", "URL Encode"],
    ["spectre-url-decode", "URL Decode"]
  ]) {
    await createContextMenu({
      id,
      parentId: "spectre-transform-selection",
      title,
      contexts: ["selection", "editable"]
    });
  }

  for (const [id, title] of [
    ["spectre-action-proxy", "Proxy"],
    ["spectre-action-headers", "Headers"],
    ["spectre-action-user-agent", "User-Agent"],
    ["spectre-action-role", "Role"]
  ]) {
    await createContextMenu({ id, title, contexts: ["action"] });
  }

  await createContextMenu({
    id: `${ACTION_MENU_PREFIXES.proxy}none`,
    parentId: "spectre-action-proxy",
    title: "Direct / Off",
    type: "radio",
    checked: !state.activeProxyId,
    contexts: ["action"]
  });
  for (const profile of state.proxyProfiles) {
    await createContextMenu({
      id: `${ACTION_MENU_PREFIXES.proxy}${profile.id}`,
      parentId: "spectre-action-proxy",
      title: profile.name,
      type: "radio",
      checked: profile.id === state.activeProxyId,
      contexts: ["action"]
    });
  }

  if (!state.networkConfig.headers.length) {
    await createContextMenu({
      id: "spectre-action-headers:empty",
      parentId: "spectre-action-headers",
      title: "No saved headers",
      enabled: false,
      contexts: ["action"]
    });
  }
  for (const header of state.networkConfig.headers) {
    await createContextMenu({
      id: `${ACTION_MENU_PREFIXES.header}${header.id}`,
      parentId: "spectre-action-headers",
      title: header.name,
      type: "checkbox",
      checked: Boolean(header.enabled),
      contexts: ["action"]
    });
  }

  await createContextMenu({
    id: `${ACTION_MENU_PREFIXES.userAgent}none`,
    parentId: "spectre-action-user-agent",
    title: "Default / Off",
    type: "radio",
    checked: !state.networkConfig.activeUserAgentId,
    contexts: ["action"]
  });
  for (const profile of state.networkConfig.userAgentProfiles) {
    await createContextMenu({
      id: `${ACTION_MENU_PREFIXES.userAgent}${profile.id}`,
      parentId: "spectre-action-user-agent",
      title: profile.name,
      type: "radio",
      checked: profile.id === state.networkConfig.activeUserAgentId,
      contexts: ["action"]
    });
  }

  await createContextMenu({
    id: `${ACTION_MENU_PREFIXES.role}none`,
    parentId: "spectre-action-role",
    title: "None / Off",
    type: "radio",
    checked: !state.activeRole,
    contexts: ["action"]
  });
  for (const role of state.roles) {
    await createContextMenu({
      id: `${ACTION_MENU_PREFIXES.role}${role.id}`,
      parentId: "spectre-action-role",
      title: role.name,
      type: "radio",
      checked: role.id === state.activeRole?.roleId,
      contexts: ["action"]
    });
  }
}

async function handleContextMenu(info, tab) {
  if (TRANSFORM_MENU_ACTIONS[info.menuItemId]) {
    await handleTransformContextMenu(info, tab);
    return;
  }

  const menuId = String(info.menuItemId);
  if (menuId.startsWith(ACTION_MENU_PREFIXES.proxy)) {
    const proxyId = menuId.slice(ACTION_MENU_PREFIXES.proxy.length);
    if (proxyId === "none") await deactivateProxy();
    else await activateProxy(proxyId);
  } else if (menuId.startsWith(ACTION_MENU_PREFIXES.header)) {
    const headerId = menuId.slice(ACTION_MENU_PREFIXES.header.length);
    await setHeaderFromActionMenu(headerId, Boolean(info.checked), tab);
  } else if (menuId.startsWith(ACTION_MENU_PREFIXES.userAgent)) {
    const profileId = menuId.slice(ACTION_MENU_PREFIXES.userAgent.length);
    await setUserAgentFromActionMenu(profileId === "none" ? null : profileId, tab);
  } else if (menuId.startsWith(ACTION_MENU_PREFIXES.role)) {
    const roleId = menuId.slice(ACTION_MENU_PREFIXES.role.length);
    if (roleId === "none") await deactivateRole();
    else await activateRole(roleId, requireTabOrigin(tab));
  } else {
    return;
  }
  await queueContextMenuBuild();
}

async function handleTransformContextMenu(info, tab) {
  const transform = TRANSFORM_MENU_ACTIONS[info.menuItemId];
  if (!transform || !info.selectionText) return;
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}/`;
  const fromExtensionPage = info.pageUrl?.startsWith(extensionOrigin) ||
    info.frameUrl?.startsWith(extensionOrigin);
  const pendingTransform = {
    ...transform,
    id: crypto.randomUUID(),
    input: info.selectionText,
    tabId: fromExtensionPage ? null : tab?.id ?? null,
    createdAt: Date.now()
  };
  await chrome.storage.session.set({ pendingTransform });
  if (!fromExtensionPage && Number.isInteger(tab?.id)) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
}

async function handleMessage(message) {
  switch (message?.action) {
    case "getState":
      return getState();
    case "listCookies":
      return chrome.cookies.getAll({ url: requireHttpUrl(message.url) });
    case "saveCookie":
      return saveCookie(message.url, message.cookie, message.original);
    case "removeCookie":
      return removeCookie(message.url, message.cookie);
    case "clearCookies":
      return clearCookies(message.url);
    case "getWebStorage":
      return executeStorageAction(message.tabId, message.area, "get");
    case "setWebStorageItem":
      return executeStorageAction(message.tabId, message.area, "set", message.key, message.value);
    case "removeWebStorageItem":
      return executeStorageAction(message.tabId, message.area, "remove", message.key);
    case "clearWebStorage":
      return executeStorageAction(message.tabId, message.area, "clear");
    case "saveNetworkConfig":
      validateNetworkConfig(message.config);
      await chrome.storage.local.set({ networkConfig: message.config });
      await syncNetworkRules();
      return message.config;
    case "saveRoles": {
      const roles = normaliseRoles(message.roles);
      validateRoles(roles);
      await chrome.storage.local.set({ roles });
      const { activeRole } = await chrome.storage.session.get("activeRole");
      if (activeRole && roles.some(({ id }) => id === activeRole.roleId)) {
        await activateRole(activeRole.roleId, activeRole.origin);
      } else if (activeRole) {
        await deactivateRole();
      } else {
        await syncNetworkRules();
      }
      return roles;
    }
    case "activateRole":
      return activateRole(message.roleId, message.origin);
    case "deactivateRole":
      await deactivateRole();
      return null;
    case "saveProxyConfig":
      validateProxyConfig(message.config);
      await chrome.storage.local.set({ proxyConfig: message.config });
      await applyProxy(message.config);
      return message.config;
    case "saveProxyProfiles":
      return saveProxyProfiles(message.profiles);
    case "activateProxy":
      return activateProxy(message.proxyId);
    case "deactivateProxy":
      await deactivateProxy();
      return null;
    default:
      throw new Error("Unknown extension action.");
  }
}

async function getState() {
  const local = await chrome.storage.local.get([
    "networkConfig",
    "proxyConfig",
    "proxyProfiles",
    "activeProxyId",
    "roles"
  ]);
  const session = await chrome.storage.session.get("activeRole");
  const networkConfig = {
    ...DEFAULT_NETWORK_CONFIG,
    ...(local.networkConfig ?? {})
  };
  networkConfig.userAgentProfiles = networkConfig.userAgentProfiles ?? [];
  networkConfig.headers = networkConfig.headers ?? [];
  return {
    networkConfig,
    proxyConfig: { ...DEFAULT_PROXY_CONFIG, ...(local.proxyConfig ?? {}) },
    proxyProfiles: local.proxyProfiles ?? [],
    activeProxyId: local.activeProxyId ?? null,
    roles: normaliseRoles(local.roles ?? []),
    activeRole: session.activeRole ?? null
  };
}

function requireHttpUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("This feature requires an HTTP or HTTPS tab.");
  }
  return url.href;
}

function requireTabOrigin(tab) {
  if (!tab?.url) throw new Error("Open an HTTP or HTTPS target tab first.");
  return new URL(requireHttpUrl(tab.url)).origin;
}

function cookieUrl(cookie, fallbackUrl) {
  const fallback = new URL(requireHttpUrl(fallbackUrl));
  const hostname = (cookie.domain || fallback.hostname).replace(/^\./, "");
  const scheme = cookie.secure ? "https:" : fallback.protocol;
  const path = cookie.path?.startsWith("/") ? cookie.path : "/";
  return `${scheme}//${hostname}${path}`;
}

async function saveCookie(tabUrl, cookie, original) {
  if (!cookie?.name) throw new Error("Cookie name is required.");
  if (/[\r\n;]/.test(cookie.name)) throw new Error("Cookie name contains invalid characters.");

  if (
    original &&
    (original.name !== cookie.name ||
      original.domain !== cookie.domain ||
      original.path !== cookie.path)
  ) {
    await removeCookie(tabUrl, original);
  }

  const details = {
    url: cookieUrl(cookie, tabUrl),
    name: cookie.name,
    value: cookie.value ?? "",
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite || "unspecified"
  };

  if (cookie.domain) details.domain = cookie.domain;
  if (!cookie.session && cookie.expirationDate) {
    details.expirationDate = Number(cookie.expirationDate);
  }
  if (cookie.storeId) details.storeId = cookie.storeId;
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;

  const saved = await chrome.cookies.set(details);
  if (!saved) throw new Error("Chrome rejected the cookie.");
  return saved;
}

async function removeCookie(tabUrl, cookie) {
  const details = {
    url: cookieUrl(cookie, tabUrl),
    name: cookie.name
  };
  if (cookie.storeId) details.storeId = cookie.storeId;
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  return chrome.cookies.remove(details);
}

async function clearCookies(tabUrl) {
  const url = requireHttpUrl(tabUrl);
  const targetCookies = await chrome.cookies.getAll({ url });
  const results = await Promise.allSettled(
    targetCookies.map((cookie) => removeCookie(url, cookie))
  );
  const removed = results.filter(
    (result) => result.status === "fulfilled" && Boolean(result.value)
  ).length;
  return {
    requested: targetCookies.length,
    removed,
    failed: targetCookies.length - removed
  };
}

async function executeStorageAction(tabId, area, operation, key, value) {
  if (!Number.isInteger(tabId)) throw new Error("No active tab is available.");
  if (!["localStorage", "sessionStorage"].includes(area)) {
    throw new Error("Invalid web storage area.");
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (storageArea, storageOperation, itemKey, itemValue) => {
      const storage = window[storageArea];
      if (storageOperation === "set") storage.setItem(itemKey, itemValue);
      if (storageOperation === "remove") storage.removeItem(itemKey);
      if (storageOperation === "clear") storage.clear();
      return Object.fromEntries(
        Array.from({ length: storage.length }, (_, index) => {
          const currentKey = storage.key(index);
          return [currentKey, storage.getItem(currentKey)];
        }).sort(([a], [b]) => a.localeCompare(b))
      );
    },
    args: [area, operation, key ?? null, value ?? null]
  });
  return result;
}

function validateHeader(name, value) {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new Error(`Invalid header name: ${name || "(empty)"}`);
  }
  if (/[\r\n]/.test(value)) throw new Error(`Header ${name} contains a line break.`);
}

function validateNetworkConfig(config) {
  if (!config || !["origin", "all"].includes(config.scope)) {
    throw new Error("Invalid network control scope.");
  }
  if (config.enabled && config.scope === "origin") requireHttpUrl(config.origin);
  if (config.userAgentEnabled && !config.userAgent.trim()) {
    throw new Error("Enter a User-Agent value or disable the override.");
  }
  const profileNames = new Set();
  for (const profile of config.userAgentProfiles ?? []) {
    if (!profile.id || !profile.name?.trim() || !profile.value?.trim()) {
      throw new Error("Every User-Agent profile requires an ID, name, and value.");
    }
    const profileName = profile.name.trim().toLowerCase();
    if (profileNames.has(profileName)) throw new Error("User-Agent profile names must be unique.");
    profileNames.add(profileName);
  }
  const headerNames = new Set();
  for (const header of config.headers ?? []) {
    if (!header.id) throw new Error("Every custom header requires an ID.");
    if (header.enabled) validateHeader(header.name, header.value);
    const headerName = header.name.trim().toLowerCase();
    if (headerNames.has(headerName)) throw new Error("Custom header names must be unique.");
    headerNames.add(headerName);
  }
}

function migrateNetworkConfig(config) {
  const migrated = { ...DEFAULT_NETWORK_CONFIG, ...config };
  migrated.headers = (migrated.headers ?? [])
    .filter((header) => header.name?.trim())
    .map((header) => ({
      id: header.id ?? crypto.randomUUID(),
      enabled: Boolean(config.enabled) && header.enabled !== false,
      name: header.name,
      value: header.value ?? ""
    }));
  migrated.userAgentProfiles = Array.isArray(migrated.userAgentProfiles)
    ? migrated.userAgentProfiles
    : [];

  if (!migrated.userAgentProfiles.length && migrated.userAgent) {
    const id = crypto.randomUUID();
    migrated.userAgentProfiles = [{
      id,
      name: "Imported User-Agent",
      value: migrated.userAgent
    }];
    migrated.activeUserAgentId = config.enabled && migrated.userAgentEnabled ? id : null;
  }

  if (
    migrated.activeUserAgentId &&
    !migrated.userAgentProfiles.some(({ id }) => id === migrated.activeUserAgentId)
  ) {
    migrated.activeUserAgentId = null;
  }
  const activeProfile = migrated.userAgentProfiles.find(
    ({ id }) => id === migrated.activeUserAgentId
  );
  migrated.userAgentEnabled = Boolean(activeProfile);
  migrated.userAgent = activeProfile?.value ?? "";
  migrated.enabled = migrated.userAgentEnabled || migrated.headers.some(({ enabled }) => enabled);
  return migrated;
}

function refreshEffectiveNetworkConfig(config) {
  const activeProfile = (config.userAgentProfiles ?? [])
    .find(({ id }) => id === config.activeUserAgentId);
  config.activeUserAgentId = activeProfile?.id ?? null;
  config.userAgentEnabled = Boolean(activeProfile);
  config.userAgent = activeProfile?.value ?? "";
  config.enabled = config.userAgentEnabled || (config.headers ?? []).some(({ enabled }) => enabled);
  return config;
}

async function getEditableNetworkConfig() {
  const { networkConfig = DEFAULT_NETWORK_CONFIG } =
    await chrome.storage.local.get("networkConfig");
  return {
    ...DEFAULT_NETWORK_CONFIG,
    ...networkConfig,
    userAgentProfiles: (networkConfig.userAgentProfiles ?? []).map((profile) => ({ ...profile })),
    headers: (networkConfig.headers ?? []).map((header) => ({ ...header }))
  };
}

async function saveActionMenuNetworkConfig(config, tab, enabling) {
  if (enabling && config.scope === "origin") {
    config.origin = requireTabOrigin(tab);
  }
  refreshEffectiveNetworkConfig(config);
  validateNetworkConfig(config);
  await chrome.storage.local.set({ networkConfig: config });
  await syncNetworkRules();
}

async function setHeaderFromActionMenu(headerId, enabled, tab) {
  const config = await getEditableNetworkConfig();
  const header = config.headers.find(({ id }) => id === headerId);
  if (!header) throw new Error("The selected header no longer exists.");
  header.enabled = enabled;
  await saveActionMenuNetworkConfig(config, tab, enabled);
}

async function setUserAgentFromActionMenu(profileId, tab) {
  const config = await getEditableNetworkConfig();
  if (profileId && !config.userAgentProfiles.some(({ id }) => id === profileId)) {
    throw new Error("The selected User-Agent no longer exists.");
  }
  config.activeUserAgentId = profileId;
  await saveActionMenuNetworkConfig(config, tab, Boolean(profileId));
}

function validateRoles(roles) {
  if (!Array.isArray(roles)) throw new Error("Roles must be an array.");
  const names = new Set();
  for (const role of roles) {
    if (!role.id || !role.name?.trim()) throw new Error("Every role requires an ID and name.");
    if (names.has(role.name.trim().toLowerCase())) throw new Error("Role names must be unique.");
    names.add(role.name.trim().toLowerCase());
    if (!["bearer", "basic", "cookie", "custom"].includes(role.type)) {
      throw new Error(`Unsupported authentication type for ${role.name}.`);
    }
    if (!["origin", "domain", "all"].includes(role.scope)) {
      throw new Error(`Unsupported request scope for ${role.name}.`);
    }
    if (role.scope === "domain" && role.scopeDomain) {
      normaliseDomainScope(role.scopeDomain);
    }
    if (role.type === "cookie" && role.scope === "all") {
      throw new Error(`Cookie role ${role.name} cannot use an all-sites scope.`);
    }
    if (role.type === "custom") validateHeader(role.headerName, role.headerValue ?? "");
    if (role.type === "cookie" && (!role.cookieName || /[\r\n;]/.test(role.cookieName))) {
      throw new Error(`Invalid cookie name for ${role.name}.`);
    }
  }
}

function normaliseRoles(roles) {
  if (!Array.isArray(roles)) return roles;
  return roles.map((role) => ({
    ...role,
    scope: role.scope ?? "origin",
    scopeDomain: role.scope === "domain"
      ? normaliseDomainScope(role.scopeDomain)
      : ""
  }));
}

function ruleCondition(scope, origin, scopeDomain = "") {
  if (scope === "all") return { regexFilter: "^https?://" };
  if (scope === "domain") {
    const domain = normaliseDomainScope(scopeDomain) || new URL(origin).hostname;
    return {
      regexFilter: "^https?://",
      requestDomains: [domain]
    };
  }
  return { regexFilter: originRegex(origin) };
}

async function syncNetworkRules() {
  const { networkConfig = DEFAULT_NETWORK_CONFIG, roles = [] } =
    await chrome.storage.local.get(["networkConfig", "roles"]);
  const { activeRole = null } = await chrome.storage.session.get("activeRole");
  const addRules = [];

  if (networkConfig.enabled) {
    validateNetworkConfig(networkConfig);
    const requestHeaders = [];
    if (networkConfig.userAgentEnabled) {
      requestHeaders.push({
        header: "user-agent",
        operation: "set",
        value: networkConfig.userAgent
      });
    }
    for (const header of networkConfig.headers ?? []) {
      if (!header.enabled) continue;
      requestHeaders.push({
        header: header.name.toLowerCase(),
        operation: "set",
        value: header.value
      });
    }
    if (requestHeaders.length) {
      addRules.push({
        id: NETWORK_RULE_ID,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders },
        condition: ruleCondition(networkConfig.scope, networkConfig.origin)
      });
    }
  }

  const role = activeRole ? roles.find(({ id }) => id === activeRole.roleId) : null;
  if (role && role.type !== "cookie") {
    const header = roleHeader(role);
    addRules.push({
      id: ROLE_RULE_ID,
      priority: 10,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: header.name.toLowerCase(), operation: "set", value: header.value }]
      },
      condition: ruleCondition(
        role.scope ?? "origin",
        activeRole.origin,
        activeRole.scopeDomain ?? role.scopeDomain
      )
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: OWNED_RULE_IDS,
    addRules
  });
}

function roleHeader(role) {
  if (role.type === "bearer") {
    if (!role.token) throw new Error("Bearer token is empty.");
    return { name: "Authorization", value: `Bearer ${role.token}` };
  }
  if (role.type === "basic") {
    return { name: "Authorization", value: encodeBasicAuth(role.username ?? "", role.password ?? "") };
  }
  if (role.type === "custom") {
    validateHeader(role.headerName, role.headerValue ?? "");
    return { name: role.headerName, value: role.headerValue ?? "" };
  }
  throw new Error("Cookie roles do not use a request-header rule.");
}

async function activateRole(roleId, origin) {
  const targetOrigin = new URL(requireHttpUrl(origin)).origin;
  const { roles = [] } = await chrome.storage.local.get("roles");
  const role = roles.find(({ id }) => id === roleId);
  if (!role) throw new Error("The selected role no longer exists.");
  const scope = role.scope ?? "origin";
  const scopeDomain = scope === "domain"
    ? normaliseDomainScope(role.scopeDomain) || new URL(targetOrigin).hostname
    : "";
  if (role.type === "cookie" && scope === "all") {
    throw new Error("Cookie roles cannot be applied to all sites.");
  }

  await restoreRoleCookie();
  const activeRole = {
    roleId,
    origin: targetOrigin,
    scope,
    scopeDomain,
    activatedAt: Date.now()
  };
  try {
    if (role.type === "cookie") await applyRoleCookie(role, targetOrigin, scope, scopeDomain);
    await chrome.storage.session.set({ activeRole });
    await syncNetworkRules();
    return activeRole;
  } catch (error) {
    await restoreRoleCookie().catch(() => {});
    await chrome.storage.session.remove("activeRole");
    await syncNetworkRules().catch(() => {});
    throw error;
  }
}

async function deactivateRole() {
  await restoreRoleCookie();
  await chrome.storage.session.remove("activeRole");
  await syncNetworkRules();
}

async function applyRoleCookie(role, origin, scope, scopeDomain) {
  const url = `${origin}/`;
  const activationHost = new URL(origin).hostname;
  if (
    scope === "domain" &&
    activationHost !== scopeDomain &&
    !activationHost.endsWith(`.${scopeDomain}`)
  ) {
    throw new Error(`Cannot set a ${scopeDomain} cookie from ${activationHost}.`);
  }
  const existing = await chrome.cookies.get({ url, name: role.cookieName });
  await chrome.storage.local.set({
    roleCookieBackup: {
      url,
      name: role.cookieName,
      original: existing ?? null
    }
  });

  const details = {
    url,
    name: role.cookieName,
    value: role.cookieValue ?? "",
    path: role.cookiePath || existing?.path || "/",
    secure: new URL(origin).protocol === "https:",
    httpOnly: existing?.httpOnly ?? false,
    sameSite: existing?.sameSite ?? "unspecified"
  };
  if (scope === "domain") details.domain = scopeDomain;
  else if (existing?.domain && !existing.hostOnly) details.domain = existing.domain;
  if (existing?.storeId) details.storeId = existing.storeId;
  if (existing?.partitionKey) details.partitionKey = existing.partitionKey;
  if (!existing?.session && existing?.expirationDate) {
    details.expirationDate = existing.expirationDate;
  }
  const applied = await chrome.cookies.set(details);
  if (!applied) throw new Error("Chrome rejected the role cookie.");
  const { roleCookieBackup } = await chrome.storage.local.get("roleCookieBackup");
  await chrome.storage.local.set({
    roleCookieBackup: { ...roleCookieBackup, applied }
  });
}

async function restoreRoleCookie() {
  const { roleCookieBackup } = await chrome.storage.local.get("roleCookieBackup");
  if (!roleCookieBackup) return;

  if (roleCookieBackup.original) {
    const cookie = roleCookieBackup.original;
    const details = {
      url: cookieUrl(cookie, roleCookieBackup.url),
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite
    };
    if (cookie.domain && !cookie.hostOnly) details.domain = cookie.domain;
    if (!cookie.session && cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    if (cookie.storeId) details.storeId = cookie.storeId;
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    await chrome.cookies.set(details);
  } else {
    const applied = roleCookieBackup.applied;
    const details = {
      url: applied ? cookieUrl(applied, roleCookieBackup.url) : roleCookieBackup.url,
      name: roleCookieBackup.name
    };
    if (applied?.storeId) details.storeId = applied.storeId;
    if (applied?.partitionKey) details.partitionKey = applied.partitionKey;
    await chrome.cookies.remove(details);
  }
  await chrome.storage.local.remove("roleCookieBackup");
}

function validateProxyConfig(config) {
  if (!config) throw new Error("Proxy configuration is missing.");
  const endpoint = normaliseProxyEndpoint(config.host, config.port);
  const scheme = endpoint.scheme ?? config.scheme;
  if (!["http", "https", "socks4", "socks5"].includes(scheme)) {
    throw new Error("Unsupported proxy scheme.");
  }
}

function validateProxyProfiles(profiles) {
  if (!Array.isArray(profiles)) throw new Error("Proxy profiles must be an array.");
  const names = new Set();
  for (const profile of profiles) {
    if (!profile.id || !profile.name?.trim()) {
      throw new Error("Every proxy profile requires an ID and name.");
    }
    const normalisedName = profile.name.trim().toLowerCase();
    if (names.has(normalisedName)) throw new Error("Proxy profile names must be unique.");
    names.add(normalisedName);
    validateProxyConfig({ ...profile, enabled: true });
  }
}

function proxyProfileFromConfig(config, id, name) {
  const endpoint = normaliseProxyEndpoint(config.host, config.port);
  return {
    id,
    name,
    scheme: endpoint.scheme ?? config.scheme,
    host: endpoint.host,
    port: endpoint.port,
    username: config.username ?? "",
    password: config.password ?? "",
    bypassList: config.bypassList ?? []
  };
}

function profileToProxyConfig(profile) {
  if (!profile) return { ...DEFAULT_PROXY_CONFIG, enabled: false };
  const endpoint = normaliseProxyEndpoint(profile.host, profile.port);
  return {
    enabled: true,
    scheme: endpoint.scheme ?? profile.scheme,
    host: endpoint.host,
    port: endpoint.port,
    username: profile.username ?? "",
    password: profile.password ?? "",
    bypassList: profile.bypassList ?? []
  };
}

async function saveProxyProfiles(profiles) {
  const normalisedProfiles = profiles.map((profile) => {
    const endpoint = normaliseProxyEndpoint(profile.host, profile.port);
    return {
      ...profile,
      scheme: endpoint.scheme ?? profile.scheme,
      host: endpoint.host,
      port: endpoint.port
    };
  });
  validateProxyProfiles(normalisedProfiles);
  const { activeProxyId = null } = await chrome.storage.local.get("activeProxyId");
  await chrome.storage.local.set({ proxyProfiles: normalisedProfiles });
  if (activeProxyId && normalisedProfiles.some(({ id }) => id === activeProxyId)) {
    await activateProxy(activeProxyId);
  } else if (activeProxyId) {
    await deactivateProxy();
  }
  return normalisedProfiles;
}

async function activateProxy(proxyId) {
  const { proxyProfiles = [] } = await chrome.storage.local.get("proxyProfiles");
  const profile = proxyProfiles.find(({ id }) => id === proxyId);
  if (!profile) throw new Error("The selected proxy profile no longer exists.");
  validateProxyProfiles(proxyProfiles);
  const proxyConfig = profileToProxyConfig(profile);
  const effective = await applyProxy(proxyConfig);
  await chrome.storage.local.set({ activeProxyId: proxyId, proxyConfig });
  return {
    proxyId,
    scheme: proxyConfig.scheme,
    host: proxyConfig.host,
    port: proxyConfig.port,
    effective
  };
}

async function deactivateProxy() {
  const { proxyConfig = DEFAULT_PROXY_CONFIG } = await chrome.storage.local.get("proxyConfig");
  const directConfig = { ...proxyConfig, enabled: false };
  await applyProxy(directConfig);
  await chrome.storage.local.set({ activeProxyId: null, proxyConfig: directConfig });
}

async function applyStoredProxy() {
  const { proxyProfiles = [], activeProxyId = null } =
    await chrome.storage.local.get(["proxyProfiles", "activeProxyId"]);
  if (activeProxyId && proxyProfiles.some(({ id }) => id === activeProxyId)) {
    await activateProxy(activeProxyId);
  } else {
    await deactivateProxy();
  }
}

async function applyProxy(config) {
  validateProxyConfig(config);
  const endpoint = normaliseProxyEndpoint(config.host, config.port);
  const scheme = endpoint.scheme ?? config.scheme;
  const value = config.enabled
    ? {
        mode: "fixed_servers",
        rules: {
          singleProxy: {
            scheme,
            host: endpoint.host,
            port: endpoint.port
          },
          bypassList: (config.bypassList ?? []).filter(Boolean)
        }
      }
    : { mode: "direct" };

  await new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ value, scope: "regular" }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });

  const effective = await getEffectiveProxySettings();
  if (config.enabled) {
    if (effective.levelOfControl !== "controlled_by_this_extension") {
      throw new Error(`Chrome proxy settings are ${effective.levelOfControl.replaceAll("_", " ")}.`);
    }
    const rules = effective.value?.rules ?? {};
    const servers = [
      rules.singleProxy,
      rules.proxyForHttp,
      rules.proxyForHttps,
      rules.fallbackProxy
    ].filter(Boolean);
    const matchesEndpoint = servers.some((server) =>
      (server.scheme ?? "http") === scheme &&
      server.host === endpoint.host &&
      Number(server.port) === endpoint.port
    );
    if (effective.value?.mode !== "fixed_servers" || !matchesEndpoint) {
      throw new Error(
        `Chrome did not apply ${scheme.toUpperCase()} ${endpoint.host}:${endpoint.port} as the effective proxy.`
      );
    }
  }
  return effective;
}

async function getEffectiveProxySettings() {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.get({ incognito: false }, (settings) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(settings);
    });
  });
}
