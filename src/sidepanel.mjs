import { enhanceDropdown } from "./dropdown.mjs";
import { changedRecords, cookieKey, favoriteKey } from "./history.mjs";
import {
  analyseJwt,
  base64ToText,
  bytesToBase64,
  dateToEpoch,
  decodeJwt,
  encodeJwt,
  extractJwt,
  identifyHash,
  isJwt,
  normaliseEpoch,
  normaliseDomainScope,
  normaliseProxyEndpoint,
  prettyPrintValue,
  serialisePrettyValue,
  signJwtHmac,
  urlDecodeValue,
  urlEncodePayload,
  verifyJwtHmac
} from "./utils.mjs";
import { PAYLOADS } from "./payloads.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const POPUP_MODE = new URL(location.href).searchParams.get("mode") === "popup";
const SURFACE_SESSION_KEYS = {
  dockWindowId: "spectreDockWindowId",
  popupWindowId: "spectrePopupWindowId",
  activePanel: "spectreActivePanel"
};

const USER_AGENT_PRESETS = [
  {
    id: "chrome-windows",
    label: "Chrome — Windows",
    value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  },
  {
    id: "chrome-macos",
    label: "Chrome — macOS",
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  },
  {
    id: "edge-windows",
    label: "Edge — Windows",
    value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
  },
  {
    id: "firefox-windows",
    label: "Firefox — Windows",
    value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"
  },
  {
    id: "firefox-macos",
    label: "Firefox — macOS",
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:133.0) Gecko/20100101 Firefox/133.0"
  },
  {
    id: "safari-macos",
    label: "Safari — macOS",
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15"
  },
  {
    id: "safari-iphone",
    label: "Safari — iPhone",
    value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"
  },
  {
    id: "chrome-android",
    label: "Chrome — Android",
    value: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  },
  {
    id: "googlebot",
    label: "Googlebot",
    value: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
  },
  { id: "curl", label: "curl", value: "curl/8.10.1" }
];

let activeTab = null;
let pinEnabled = true;
let pinnedTabId = null;
let favorites = new Set();
let undoEntry = null;
let editBusy = false;
let extensionState = {
  networkConfig: {},
  proxyConfig: {},
  proxyProfiles: [],
  activeProxyId: null,
  roles: [],
  activeRole: null
};
let cookies = [];
let storageArea = "localStorage";
let storageItems = {};
let editingCookie = null;
let editingUserAgentId = null;
let editingHeaderId = null;
let editingProxyId = null;
let editingRoleId = null;
let cookieValueState = null;
let storageValueState = null;
let internalSelectionText = "";
let internalJwtText = "";
let toastTimer = null;
let dockWindowId = null;

bindEvents();
initialise().catch(showError);

async function initialise() {
  await initialiseSurface();
  await initialiseTheme();
  await initialiseTextSize();
  $$(".appearance-tools select").forEach(enhanceDropdown);
  new ResizeObserver(([entry]) => {
    document.documentElement.style.setProperty("--posture-height", `${entry.target.getBoundingClientRect().height}px`);
  }).observe($(".posture-bar"));
  const preferences = await chrome.storage.local.get(["pinTargetEnabled", "payloadFavorites"]);
  pinEnabled = preferences.pinTargetEnabled !== false;
  favorites = new Set(preferences.payloadFavorites || []);
  const pinned = await chrome.storage.session.get(`pinnedTarget:${dockWindowId}`);
  pinnedTabId = pinned[`pinnedTarget:${dockWindowId}`] ?? null;
  populateUserAgentPresets();
  populatePayloadCategories();
  renderPayloads();
  loadValueEditor("storage", "");
  await refreshContext();
  await refreshState();
  await consumePendingTransform();
}

function bindEvents() {
  $("#emergency-reset").addEventListener("click", resetSecurityControls);
  $("#pin-target").addEventListener("change", async (event) => {
    try {
      const enabled = event.target.checked;
      await chrome.storage.local.set({ pinTargetEnabled: enabled });
      pinEnabled = enabled;
      pinnedTabId = pinEnabled ? activeTab?.id : null;
      await refreshContext();
    } catch (error) {
      $("#pin-target").checked = pinEnabled;
      showError(error);
    }
  });
  $("#use-current-tab").addEventListener("click", () => refreshContext(false, true).catch(showError));
  $("#undo-edit").addEventListener("click", undoLastEdit);
  $("#favorites-only").addEventListener("change", renderPayloads);
  $("#surface-toggle").addEventListener("click", toggleSurface);
  $("#text-size-select").addEventListener("change", saveTextSize);
  $("#theme-select").addEventListener("change", saveTheme);
  $$("[data-panel-jump]").forEach((button) =>
    button.addEventListener("click", () => {
      showPanel(button.dataset.panelJump);
      if (button.dataset.scrollTarget) {
        document.getElementById(button.dataset.scrollTarget)?.scrollIntoView({ behavior: "smooth" });
      }
    })
  );
  $$(".nav-item").forEach((button) =>
    button.addEventListener("click", () => showPanel(button.dataset.panel))
  );
  $("#refresh-context").addEventListener("click", async () => {
    await refreshContext(true);
    await refreshState();
  });
  $("#refresh-cookies").addEventListener("click", refreshCookies);
  $("#clear-cookies").addEventListener("click", clearCookies);
  $("#new-cookie").addEventListener("click", () => openCookieEditor());
  $("#close-cookie-editor").addEventListener("click", closeCookieEditor);
  $("#cookie-filter").addEventListener("input", renderCookies);
  $("#cookie-form").addEventListener("submit", saveCookie);
  $("#delete-cookie").addEventListener("click", deleteCookie);
  $("#cookie-session").addEventListener("change", syncCookieExpirationState);
  $("#cookie-mode-raw").addEventListener("click", () => switchValueMode("cookie", "raw"));
  $("#cookie-mode-pretty").addEventListener("click", () => switchValueMode("cookie", "pretty"));
  $("#cookie-value").addEventListener("blur", () => autoDetectPrettyValue("cookie"));

  $$(".storage-tab").forEach((button) =>
    button.addEventListener("click", async () => {
      storageArea = button.dataset.area;
      $$(".storage-tab").forEach((item) => item.classList.toggle("active", item === button));
      $("#storage-key").value = "";
      loadValueEditor("storage", "");
      await refreshStorage();
    })
  );
  $("#refresh-storage").addEventListener("click", refreshStorage);
  $("#storage-form").addEventListener("submit", saveStorageItem);
  $("#delete-storage").addEventListener("click", deleteStorageItem);
  $("#clear-storage").addEventListener("click", clearStorage);
  $("#storage-mode-raw").addEventListener("click", () => switchValueMode("storage", "raw"));
  $("#storage-mode-pretty").addEventListener("click", () => switchValueMode("storage", "pretty"));
  $("#storage-value").addEventListener("blur", () => autoDetectPrettyValue("storage"));

  $("#base64-encode").addEventListener("click", encodeBase64);
  $("#base64-decode").addEventListener("click", decodeBase64);
  $("#base64-swap").addEventListener("click", swapBase64);
  $("#base64-clear").addEventListener("click", clearBase64);
  $("#copy-base64-output").addEventListener("click", () =>
    copyText($("#base64-output").value, "Base64 output copied.")
  );
  $("#url-encode").addEventListener("click", encodeUrl);
  $("#url-decode").addEventListener("click", decodeUrl);
  $("#url-swap").addEventListener("click", swapUrl);
  $("#url-clear").addEventListener("click", clearUrl);
  $("#copy-url-output").addEventListener("click", () =>
    copyText($("#url-output").value, "URL transform output copied.")
  );
  $("#identify-hashes").addEventListener("click", renderHashResults);
  $("#epoch-to-date").addEventListener("click", epochToDate);
  $("#date-to-epoch").addEventListener("click", humanToEpoch);

  $("#jwt-analyse").addEventListener("click", analyseJwtInput);
  $("#jwt-clear").addEventListener("click", clearJwtWorkbench);
  $("#jwt-rebuild-unsigned").addEventListener("click", rebuildUnsignedJwt);
  $("#jwt-verify").addEventListener("click", verifyJwtSignature);
  $("#jwt-sign").addEventListener("click", signEditedJwt);
  $("#jwt-copy-result").addEventListener("click", () =>
    copyText($("#jwt-result").value, "JWT result copied.")
  );
  $("#jwt-use-result").addEventListener("click", useJwtResult);
  $("#jwt-input").addEventListener("input", () => {
    setJwtBadge("#jwt-status-badge", "Not analysed", "neutral");
    setJwtBadge("#jwt-signature-status", "Unverified", "neutral");
  });
  for (const selector of ["#jwt-header", "#jwt-claims"]) {
    $(selector).addEventListener("input", () =>
      setJwtBadge("#jwt-signature-status", "Edits pending", "caution")
    );
  }

  $("#ua-preset").addEventListener("change", applyUserAgentPreset);
  $("#user-agent").addEventListener("input", () => {
    const matching = USER_AGENT_PRESETS.find(({ value }) => value === $("#user-agent").value);
    $("#ua-preset").value = matching?.id ?? ($("#user-agent").value === navigator.userAgent ? "current" : "custom");
  });
  $("#new-user-agent").addEventListener("click", () => openUserAgentEditor());
  $("#close-user-agent-editor").addEventListener("click", closeUserAgentEditor);
  $("#user-agent-form").addEventListener("submit", saveUserAgent);
  $("#delete-user-agent").addEventListener("click", deleteUserAgent);
  $("#new-header").addEventListener("click", () => openHeaderEditor());
  $("#close-header-editor").addEventListener("click", closeHeaderEditor);
  $("#header-form").addEventListener("submit", saveHeader);
  $("#delete-header").addEventListener("click", deleteHeader);
  $("#network-scope").addEventListener("change", async () => {
    updateNetworkScopeHint();
    await persistNetworkConfig("Request scope updated.");
  });
  $("#new-proxy").addEventListener("click", () => openProxyEditor());
  $("#close-proxy-editor").addEventListener("click", closeProxyEditor);
  $("#proxy-form").addEventListener("submit", saveProxy);
  $("#delete-proxy").addEventListener("click", deleteProxy);

  $("#new-role").addEventListener("click", () => openRoleEditor());
  $("#close-role-editor").addEventListener("click", closeRoleEditor);
  $("#role-type").addEventListener("change", syncRoleFields);
  $("#role-scope").addEventListener("change", syncRoleFields);
  $("#role-form").addEventListener("submit", saveRole);
  $("#delete-role").addEventListener("click", deleteRole);

  $("#payload-search").addEventListener("input", renderPayloads);
  $("#payload-category").addEventListener("change", renderPayloads);
  $("#copy-all-payloads").addEventListener("click", copyAllPayloads);

  document.addEventListener("contextmenu", openInternalSelectionMenu);
  document.addEventListener("click", (event) => {
    if (!$("#selection-transform-menu").contains(event.target)) closeInternalSelectionMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeInternalSelectionMenu();
  });
  document.addEventListener("scroll", closeInternalSelectionMenu, true);
  $$("[data-selection-tool]").forEach((button) =>
    button.addEventListener("click", () => {
      const successful = applySelectionTransform({
        tool: button.dataset.selectionTool,
        operation: button.dataset.selectionOperation,
        input: button.dataset.selectionTool === "jwt" ? internalJwtText : internalSelectionText
      });
      closeInternalSelectionMenu();
      if (successful) {
        const destination = button.dataset.selectionTool === "jwt"
          ? "JWT Workbench"
          : `${button.dataset.selectionTool === "base64" ? "Base64" : "URL"} ${button.dataset.selectionOperation}`;
        showToast(`Value sent to ${destination}.`);
      }
    })
  );

  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (!POPUP_MODE || windowId === dockWindowId) refreshContext();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === pinnedTabId || tabId === activeTab?.id) refreshContext().catch(showError);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if ((tabId === activeTab?.id || tabId === pinnedTabId) && (changeInfo.url || changeInfo.title)) refreshContext().catch(showError);
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "session" && changes.pendingTransform?.newValue) {
      consumePendingTransform(changes.pendingTransform.newValue).catch(showError);
    }
    if (
      POPUP_MODE &&
      areaName === "session" &&
      Number.isInteger(changes[SURFACE_SESSION_KEYS.dockWindowId]?.newValue)
    ) {
      dockWindowId = changes[SURFACE_SESSION_KEYS.dockWindowId].newValue;
      refreshContext().catch(showError);
    }
    if (areaName === "local" && changes.uiTextSize) {
      applyTextSize(changes.uiTextSize.newValue);
    }
    if (areaName === "local" && changes.payloadFavorites) {
      favorites = new Set(changes.payloadFavorites.newValue || []);
      renderPayloads();
    }
    const localStateChanged = areaName === "local" &&
      ["networkConfig", "proxyConfig", "proxyProfiles", "activeProxyId", "roles"]
        .some((key) => key in changes);
    const sessionStateChanged = areaName === "session" && "activeRole" in changes;
    if (localStateChanged || sessionStateChanged) {
      refreshState().catch(showError);
    }
  });
}

async function initialiseSurface() {
  document.body.classList.toggle("popup-mode", POPUP_MODE);
  const surfaceButton = $("#surface-toggle");
  surfaceButton.textContent = POPUP_MODE ? "↙" : "↗";
  surfaceButton.title = POPUP_MODE
    ? "Return Spectre to the browser side panel"
    : "Open Spectre in its own window";
  surfaceButton.setAttribute("aria-label", surfaceButton.title);
  document.title = POPUP_MODE ? "Spectre Security Toolkit — Window" : "Spectre Security Toolkit";

  const session = await chrome.storage.session.get([
    SURFACE_SESSION_KEYS.dockWindowId,
    SURFACE_SESSION_KEYS.activePanel
  ]);
  if (POPUP_MODE) {
    dockWindowId = await resolveNormalWindowId(session[SURFACE_SESSION_KEYS.dockWindowId]);
    if (!Number.isInteger(dockWindowId)) {
      throw new Error("No browser window is available for Spectre to target.");
    }
    const currentWindow = await chrome.windows.getCurrent();
    await chrome.storage.session.set({
      [SURFACE_SESSION_KEYS.dockWindowId]: dockWindowId,
      [SURFACE_SESSION_KEYS.popupWindowId]: currentWindow.id
    });
  } else {
    const currentWindow = await chrome.windows.getCurrent();
    dockWindowId = currentWindow.id;
  }

  showPanel(session[SURFACE_SESSION_KEYS.activePanel] ?? "inspect");
}

async function resolveNormalWindowId(preferredWindowId) {
  if (Number.isInteger(preferredWindowId)) {
    try {
      const preferred = await chrome.windows.get(preferredWindowId);
      if (preferred.type === "normal") return preferred.id;
    } catch {
      // The original browser window was closed while Spectre was popped out.
    }
  }
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return windows.find(({ focused }) => focused)?.id ?? windows[0]?.id ?? null;
}

async function toggleSurface() {
  const button = $("#surface-toggle");
  button.disabled = true;
  try {
    if (POPUP_MODE) await returnToSidePanel();
    else await openInPopupWindow();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

async function openInPopupWindow() {
  const currentWindow = await chrome.windows.getCurrent();
  dockWindowId = currentWindow.id;
  const session = await chrome.storage.session.get(SURFACE_SESSION_KEYS.popupWindowId);
  await chrome.storage.session.set({ [SURFACE_SESSION_KEYS.dockWindowId]: dockWindowId });

  const existingPopupId = session[SURFACE_SESSION_KEYS.popupWindowId];
  if (Number.isInteger(existingPopupId)) {
    try {
      const existingPopup = await chrome.windows.get(existingPopupId);
      if (existingPopup.type === "popup") {
        await chrome.windows.update(existingPopupId, { focused: true });
        await closeSidePanel(currentWindow.id);
        return;
      }
    } catch {
      await chrome.storage.session.remove(SURFACE_SESSION_KEYS.popupWindowId);
    }
  }

  const popup = await chrome.windows.create({
    url: chrome.runtime.getURL("sidepanel.html?mode=popup"),
    type: "popup",
    width: 500,
    height: 850,
    focused: true
  });
  await chrome.storage.session.set({ [SURFACE_SESSION_KEYS.popupWindowId]: popup.id });
  await closeSidePanel(currentWindow.id);
}

async function closeSidePanel(windowId) {
  if (typeof chrome.sidePanel.close === "function") {
    try {
      await chrome.sidePanel.close({ windowId });
      return;
    } catch {
      // window.close() is supported by extension side-panel documents.
    }
  }
  window.close();
}

async function returnToSidePanel() {
  if (!Number.isInteger(dockWindowId)) {
    throw new Error("The original browser window is no longer available.");
  }

  await chrome.sidePanel.open({ windowId: dockWindowId });
  await chrome.windows.update(dockWindowId, { focused: true }).catch(() => {});
  await chrome.storage.session.remove(SURFACE_SESSION_KEYS.popupWindowId);
  window.close();
}

function showPanel(name) {
  if (!$$(".nav-item").some((button) => button.dataset.panel === name)) return;
  $$(".nav-item").forEach((button) => (button.classList.toggle("active", button.dataset.panel === name), button.setAttribute("aria-current", button.dataset.panel === name ? "page" : "false")));
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${name}`));
  chrome.storage.session.set({ [SURFACE_SESSION_KEYS.activePanel]: name }).catch(() => {});
}

const COOKIE_EDITS = ["saveCookie", "removeCookie", "clearCookies"];
const STORAGE_EDITS = ["setWebStorageItem", "removeWebStorageItem", "clearWebStorage"];

async function snapshotEdit(kind, target) {
  if (kind === "cookie") {
    const values = await sendRaw("listCookies", { url: target.url });
    return Object.fromEntries(values.map((cookie) => [cookieKey(cookie), cookie]));
  }
  const tab = await chrome.tabs.get(target.tabId);
  if (new URL(tab.url).origin !== target.origin) throw new Error("The edited tab has navigated to another origin.");
  return sendRaw("getWebStorage", target);
}

function renderUndo() {
  $("#undo-edit").disabled = editBusy || !undoEntry;
  $("#undo-description").textContent = undoEntry
    ? `${undoEntry.label} · ${undoEntry.target.origin}` : "No edits to undo.";
}

async function send(action, payload = {}) {
  const kind = COOKIE_EDITS.includes(action) ? "cookie" : STORAGE_EDITS.includes(action) ? "storage" : null;
  if (!kind) return sendRaw(action, payload);
  if (editBusy) throw new Error("Wait for the current edit to finish.");
  editBusy = true;
  renderUndo();
  const target = { ...payload, origin: new URL(payload.url || activeTab.url).origin };
  target.expectedOrigin = target.origin;
  try {
    const before = await snapshotEdit(kind, target);
    const result = await sendRaw(action, target);
    // The new edit supersedes the previous undo, even if the follow-up read fails.
    undoEntry = null;
    const after = await snapshotEdit(kind, target);
    const changes = changedRecords(before, after);
    if (changes.length) undoEntry = { kind, target, changes, label: {
      saveCookie: "Cookie saved", removeCookie: "Cookie deleted", clearCookies: "Cookies cleared",
      setWebStorageItem: "Storage item saved", removeWebStorageItem: "Storage item deleted",
      clearWebStorage: "Storage cleared"
    }[action] };
    return result;
  } finally { editBusy = false; renderUndo(); }
}

async function undoLastEdit() {
  if (!undoEntry || editBusy) return;
  const entry = undoEntry;
  editBusy = true;
  renderUndo();
  try {
    const current = await snapshotEdit(entry.kind, entry.target);
    if (entry.changes.some(({ key, after }) => JSON.stringify(current[key]) !== JSON.stringify(after))) {
      throw new Error("These records have changed since your edit. Undo was stopped to preserve the newer values.");
    }
    for (const change of [...entry.changes]) {
      if (entry.kind === "cookie") {
        if (change.before) await sendRaw("saveCookie", { url: entry.target.url, cookie: change.before });
        else await sendRaw("removeCookie", { url: entry.target.url, cookie: change.after });
      } else {
        await sendRaw(change.before === undefined ? "removeWebStorageItem" : "setWebStorageItem", {
          ...entry.target, key: change.key, value: change.before
        });
      }
      // Retain only unfinished records if Chrome rejects a later restoration.
      entry.changes.splice(entry.changes.indexOf(change), 1);
    }
    undoEntry = null;
    closeCookieEditor();
    await refreshContext();
    showToast("Last edit undone.");
  } catch (error) { showError(error); }
  finally { editBusy = false; renderUndo(); }
}

async function sendRaw(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...payload });
  if (!response?.ok) throw new Error(response?.error || "The extension service worker did not respond.");
  return response.data;
}

async function refreshContext(withNotice = false, useCurrent = false) {
  const previous = activeTab;
  let tab;
  if (pinEnabled && pinnedTabId != null && !useCurrent) {
    try { tab = await chrome.tabs.get(pinnedTabId); }
    catch { tab = null; }
  }
  if (!tab && (!pinEnabled || pinnedTabId == null || useCurrent)) {
    const query = Number.isInteger(dockWindowId)
      ? { active: true, windowId: dockWindowId }
      : { active: true, lastFocusedWindow: true };
    [tab] = await chrome.tabs.query(query);
  }
  activeTab = tab ?? null;
  if (previous && (previous.id !== activeTab?.id || previous.url !== activeTab?.url)) {
    closeCookieEditor();
    $("#storage-key").value = "";
    loadValueEditor("storage", "");
  }
  pinnedTabId = pinEnabled ? activeTab?.id ?? pinnedTabId : null;
  await chrome.storage.session.set({ [`pinnedTarget:${dockWindowId}`]: pinnedTabId });
  $("#pin-target").checked = pinEnabled;
  const origin = getActiveOrigin();
  const targetClosed = pinEnabled && pinnedTabId != null && !activeTab;
  $("#target-title").textContent = targetClosed ? "Pinned target closed" : activeTab?.title || origin || "No target selected";
  $("#target-title").title = activeTab?.title || "";
  $("#target-origin").textContent = targetClosed ? "Choose Use current tab to select a new target." : origin || "No HTTP target selected";
  $("#target-origin").title = activeTab?.url || "";
  $("#target-dot").classList.toggle("ready", Boolean(origin));

  if (origin) {
    await Promise.allSettled([refreshCookies(), refreshStorage()]);
    if (withNotice) showToast("Target context refreshed.");
  } else {
    cookies = [];
    storageItems = {};
    renderCookies();
    renderStorage();
    if (withNotice) showToast("Select an HTTP or HTTPS tab.", true);
  }
}

function getActiveOrigin() {
  try {
    const url = new URL(activeTab?.url);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
}

async function resetSecurityControls() {
  const button = $("#emergency-reset");
  button.disabled = true;
  $("#reset-result").textContent = "Resetting active controls…";
  try {
    const { errors } = await send("emergencyReset");
    $("#reset-result").textContent = errors.length
      ? `Reset incomplete. ${errors.join(" ")} Retry after resolving these errors.`
      : "Reset complete. Role, headers and User-Agent are off. Connection is direct.";
    await refreshState();
    await refreshCookies();
  } catch (error) {
    $("#reset-result").textContent = `Reset failed: ${error.message}`;
    showError(error);
  } finally { button.disabled = false; }
}

async function refreshState() {
  extensionState = await send("getState");
  fillNetworkForm();
  renderProxies();
  renderRoles();
  renderPosture();
}

async function initialiseTheme() {
  const { uiTheme = "spectre" } = await chrome.storage.local.get("uiTheme");
  const theme = ["spectre", "cobalt", "violet", "ember", "falcon", "light"].includes(uiTheme)
    ? uiTheme
    : "spectre";
  document.documentElement.dataset.theme = theme;
  $("#theme-select").value = theme;
}

async function saveTheme() {
  const uiTheme = $("#theme-select").value;
  document.documentElement.dataset.theme = uiTheme;
  await chrome.storage.local.set({ uiTheme });
  showToast(`${$("#theme-select").selectedOptions[0].textContent} colour scheme applied.`);
}

const TEXT_SIZES = ["compact", "standard", "large", "extra-large"];

function applyTextSize(value) {
  const size = TEXT_SIZES.includes(value) ? value : "standard";
  document.documentElement.dataset.textSize = size;
  $("#text-size-select").value = size;
  $("#text-size-select").dispatchEvent?.(new Event("dropdown-sync"));
}

async function initialiseTextSize() {
  const { uiTextSize } = await chrome.storage.local.get("uiTextSize");
  applyTextSize(uiTextSize);
}

async function saveTextSize() {
  const uiTextSize = $("#text-size-select").value;
  applyTextSize(uiTextSize);
  try {
    await chrome.storage.local.set({ uiTextSize });
  } catch (error) {
    showError(error);
  }
}

function renderPosture() {
  const role = extensionState.activeRole
    ? extensionState.roles.find(({ id }) => id === extensionState.activeRole.roleId)
    : null;
  const roleValue = $("#status-role-value");
  const roleItem = roleValue.closest(".posture-item");
  roleValue.textContent = role?.name ?? "None";
  roleItem.classList.toggle("live", Boolean(role));
  roleItem.title = role
    ? `${role.name} is active for ${roleScopeDescription(
        extensionState.activeRole.scope ?? role.scope ?? "origin",
        extensionState.activeRole.origin,
        extensionState.activeRole.scopeDomain ?? role.scopeDomain
      )}`
    : "No role is active. Open role settings.";

  const proxy = extensionState.proxyConfig;
  const proxyProfile = extensionState.proxyProfiles.find(({ id }) => id === extensionState.activeProxyId);
  const proxyValue = $("#status-proxy-value");
  const proxyItem = proxyValue.closest(".posture-item");
  proxyValue.textContent = proxy?.enabled
    ? proxyProfile?.name ?? `${String(proxy.scheme).toUpperCase()} ${proxy.host}:${proxy.port}`
    : "Direct";
  proxyItem.classList.toggle("live", Boolean(proxy?.enabled));
  proxyItem.classList.toggle("warning", Boolean(proxy?.enabled));
  proxyItem.title = proxy?.enabled
    ? `Profile-wide proxy: ${proxy.scheme}://${proxy.host}:${proxy.port}`
    : "Direct connection mode. Open proxy settings.";

  const network = extensionState.networkConfig;
  const networkValue = $("#status-network-value");
  const networkItem = networkValue.closest(".posture-item");
  const headerCount = (network?.headers ?? []).filter(({ enabled }) => enabled).length;
  const mutationCount = headerCount + (network?.userAgentEnabled ? 1 : 0);
  networkValue.textContent = network?.enabled
    ? `${network.scope === "all" ? "All sites" : "Origin"} · ${mutationCount}`
    : "Off";
  networkItem.classList.toggle("live", Boolean(network?.enabled));
  networkItem.title = network?.enabled
    ? `${mutationCount} request mutation${mutationCount === 1 ? "" : "s"} active for ${network.scope === "all" ? "all HTTP(S) sites" : network.origin}`
    : "Request mutation rules are disabled.";
}

async function refreshCookies() {
  if (!getActiveOrigin()) {
    cookies = [];
    renderCookies();
    return;
  }
  cookies = await send("listCookies", { url: activeTab.url });
  cookies.sort((a, b) =>
    Number(isJwt(b.value)) - Number(isJwt(a.value)) ||
    a.name.localeCompare(b.name) ||
    a.domain.localeCompare(b.domain)
  );
  renderCookies();
}

function renderCookies() {
  const list = $("#cookie-list");
  list.replaceChildren();
  const query = $("#cookie-filter").value.trim().toLowerCase();
  const visible = cookies.filter((cookie) =>
    `${cookie.name} ${cookie.value} ${cookie.domain} ${cookie.path}`.toLowerCase().includes(query)
  );
  list.classList.toggle("empty-state", visible.length === 0);
  if (!visible.length) {
    list.textContent = getActiveOrigin() ? "No matching cookies." : "Select an HTTP target tab.";
    return;
  }

  for (const cookie of visible) {
    const jwt = isJwt(cookie.value);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "record-row";
    row.classList.toggle("jwt-record", jwt);
    const heading = document.createElement("span");
    heading.className = "record-heading";
    const key = document.createElement("span");
    key.className = "record-key";
    key.textContent = cookie.name;
    heading.append(key);
    if (jwt) heading.append(createJwtBadge());
    const value = document.createElement("span");
    value.className = "record-value";
    value.textContent = cookie.value || "(empty)";
    const meta = document.createElement("span");
    meta.className = "record-meta";
    meta.textContent = [cookie.domain, cookie.path, cookie.httpOnly ? "HttpOnly" : "", cookie.secure ? "Secure" : ""]
      .filter(Boolean)
      .join(" · ");
    row.append(heading, value, meta);
    row.addEventListener("click", () => openCookieEditor(cookie));
    row.addEventListener("contextmenu", (event) =>
      openRecordTransformMenu(event, cookie.value, `Cookie · ${cookie.name}`)
    );
    list.append(row);
  }
}

function createJwtBadge() {
  const badge = document.createElement("span");
  badge.className = "record-jwt-badge";
  badge.textContent = "JWT";
  badge.title = "JSON Web Token detected";
  return badge;
}

function openCookieEditor(cookie = null) {
  if (!getActiveOrigin()) {
    showToast("Select an HTTP or HTTPS target tab first.", true);
    return;
  }
  editingCookie = cookie ? structuredClone(cookie) : null;
  $("#cookie-form-title").textContent = cookie ? "Edit cookie" : "New cookie";
  $("#cookie-name").value = cookie?.name ?? "";
  loadValueEditor("cookie", cookie?.value ?? "");
  $("#cookie-domain").value = cookie?.domain ?? new URL(activeTab.url).hostname;
  $("#cookie-path").value = cookie?.path ?? "/";
  $("#cookie-samesite").value = cookie?.sameSite ?? "unspecified";
  $("#cookie-session").checked = cookie?.session ?? true;
  $("#cookie-secure").checked = cookie?.secure ?? new URL(activeTab.url).protocol === "https:";
  $("#cookie-httponly").checked = cookie?.httpOnly ?? false;
  $("#cookie-expires").value =
    cookie && !cookie.session && cookie.expirationDate
      ? toLocalDateTime(cookie.expirationDate * 1000)
      : "";
  $("#delete-cookie").classList.toggle("hidden", !cookie);
  $("#cookie-form").classList.remove("hidden");
  syncCookieExpirationState();
  $("#cookie-name").focus();
}

function closeCookieEditor() {
  editingCookie = null;
  $("#cookie-form").classList.add("hidden");
}

function syncCookieExpirationState() {
  $("#cookie-expires").disabled = $("#cookie-session").checked;
}

async function saveCookie(event) {
  event.preventDefault();
  try {
    const session = $("#cookie-session").checked;
    const cookie = {
      name: $("#cookie-name").value.trim(),
      value: readValueEditor("cookie"),
      domain: $("#cookie-domain").value.trim(),
      path: $("#cookie-path").value.trim() || "/",
      sameSite: $("#cookie-samesite").value,
      session,
      secure: $("#cookie-secure").checked,
      httpOnly: $("#cookie-httponly").checked,
      expirationDate: session || !$("#cookie-expires").value
        ? undefined
        : new Date($("#cookie-expires").value).getTime() / 1000,
      storeId: editingCookie?.storeId,
      partitionKey: editingCookie?.partitionKey
    };
    await send("saveCookie", { url: activeTab.url, cookie, original: editingCookie });
    closeCookieEditor();
    await refreshCookies();
    showToast("Cookie saved.");
  } catch (error) {
    showError(error);
  }
}

async function deleteCookie() {
  if (!editingCookie) return;
  const confirmed = await confirmAction({
    title: "Delete cookie?",
    message: `Delete “${editingCookie.name}” from ${getActiveOrigin()}?`,
    detail: "This can invalidate the current application session.",
    confirmLabel: "Delete cookie"
  });
  if (!confirmed) return;
  try {
    await send("removeCookie", { url: activeTab.url, cookie: editingCookie });
    closeCookieEditor();
    await refreshCookies();
    showToast("Cookie deleted.");
  } catch (error) {
    showError(error);
  }
}

async function clearCookies() {
  const origin = getActiveOrigin();
  if (!origin) return showToast("Select an HTTP or HTTPS target tab first.", true);
  if (!cookies.length) return showToast("There are no cookies to clear for this target.");
  const count = cookies.length;
  const confirmed = await confirmAction({
    title: `Clear ${count} cookie${count === 1 ? "" : "s"}?`,
    message: `Remove all cookies currently applicable to ${origin}?`,
    detail: "This can sign you out, reset application state, and remove an active cookie-based role.",
    confirmLabel: "Clear cookies"
  });
  if (!confirmed) return;
  try {
    const result = await send("clearCookies", { url: activeTab.url });
    closeCookieEditor();
    await refreshCookies();
    if (result.failed) {
      showToast(`${result.removed} cleared; ${result.failed} could not be removed.`, true);
    } else {
      showToast(`${result.removed} cookie${result.removed === 1 ? "" : "s"} cleared.`);
    }
  } catch (error) {
    showError(error);
  }
}

async function refreshStorage() {
  if (!activeTab?.id || !getActiveOrigin()) {
    storageItems = {};
    renderStorage();
    return;
  }
  try {
    storageItems = await send("getWebStorage", { tabId: activeTab.id, area: storageArea });
    renderStorage();
  } catch (error) {
    storageItems = {};
    renderStorage(error.message);
  }
}

function renderStorage(errorMessage = "") {
  const list = $("#storage-list");
  list.replaceChildren();
  const entries = Object.entries(storageItems);
  list.classList.toggle("empty-state", entries.length === 0);
  if (!entries.length) {
    list.textContent = errorMessage || (getActiveOrigin() ? "No items in this storage area." : "Select an HTTP target tab.");
    return;
  }
  for (const [keyName, itemValue] of entries) {
    const jwt = isJwt(itemValue);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "record-row";
    row.classList.toggle("jwt-record", jwt);
    const heading = document.createElement("span");
    heading.className = "record-heading";
    const key = document.createElement("span");
    key.className = "record-key";
    key.textContent = keyName;
    heading.append(key);
    if (jwt) heading.append(createJwtBadge());
    const value = document.createElement("span");
    value.className = "record-value";
    value.textContent = itemValue;
    row.append(heading, value);
    row.addEventListener("click", () => {
      $("#storage-key").value = keyName;
      loadValueEditor("storage", itemValue);
    });
    row.addEventListener("contextmenu", (event) =>
      openRecordTransformMenu(event, itemValue, `${storageArea} · ${keyName}`)
    );
    list.append(row);
  }
}

async function saveStorageItem(event) {
  event.preventDefault();
  try {
    const value = readValueEditor("storage");
    storageItems = await send("setWebStorageItem", {
      tabId: activeTab?.id,
      area: storageArea,
      key: $("#storage-key").value,
      value
    });
    renderStorage();
    loadValueEditor("storage", value);
    showToast(`${storageArea} item saved.`);
  } catch (error) {
    showError(error);
  }
}

async function deleteStorageItem() {
  const key = $("#storage-key").value;
  if (!key) return showToast("Enter or select a storage key.", true);
  const confirmed = await confirmAction({
    title: "Delete storage item?",
    message: `Delete “${key}” from ${storageArea}?`,
    detail: `The change applies to ${getActiveOrigin() || "the active target"}.`,
    confirmLabel: "Delete item"
  });
  if (!confirmed) return;
  try {
    storageItems = await send("removeWebStorageItem", { tabId: activeTab?.id, area: storageArea, key });
    $("#storage-key").value = "";
    loadValueEditor("storage", "");
    renderStorage();
    showToast("Storage item deleted.");
  } catch (error) {
    showError(error);
  }
}

async function clearStorage() {
  const itemCount = Object.keys(storageItems).length;
  if (!itemCount) return showToast(`${storageArea} is already empty.`);
  const confirmed = await confirmAction({
    title: `Clear ${storageArea}?`,
    message: `Remove all ${itemCount} item${itemCount === 1 ? "" : "s"} from ${storageArea}?`,
    detail: `The change applies to ${getActiveOrigin() || "the active target"} and can be restored with Undo while this panel remains open.`,
    confirmLabel: "Clear storage"
  });
  if (!confirmed) return;
  try {
    storageItems = await send("clearWebStorage", { tabId: activeTab?.id, area: storageArea });
    $("#storage-key").value = "";
    loadValueEditor("storage", "");
    renderStorage();
    showToast(`${storageArea} cleared.`);
  } catch (error) {
    showError(error);
  }
}

function renderHashResults() {
  const lines = $("#hash-input").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const results = $("#hash-results");
  results.replaceChildren();
  results.classList.toggle("empty-state", lines.length === 0);
  if (!lines.length) {
    results.textContent = "Enter at least one hash.";
    return;
  }
  for (const value of lines) {
    const matches = identifyHash(value);
    const row = document.createElement("div");
    row.className = "result-row";
    const code = document.createElement("code");
    code.textContent = value;
    const result = document.createElement("strong");
    result.textContent = matches.length ? matches.join(" · ") : "Unknown format";
    row.append(code, result);
    results.append(row);
  }
}

function encodeBase64() {
  try {
    $("#base64-output").value = bytesToBase64($("#base64-input").value);
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}

function decodeBase64() {
  try {
    $("#base64-output").value = base64ToText($("#base64-input").value);
    return true;
  } catch {
    $("#base64-output").value = "";
    showToast("Input is not valid UTF-8 Base64 or Base64URL.", true);
    return false;
  }
}

function swapBase64() {
  const input = $("#base64-input").value;
  $("#base64-input").value = $("#base64-output").value;
  $("#base64-output").value = input;
}

function clearBase64() {
  $("#base64-input").value = "";
  $("#base64-output").value = "";
  $("#base64-input").focus();
}

function encodeUrl() {
  $("#url-output").value = urlEncodePayload($("#url-input").value);
  return true;
}

function decodeUrl() {
  try {
    $("#url-output").value = urlDecodeValue($("#url-input").value);
    return true;
  } catch {
    $("#url-output").value = "";
    showToast("Input contains invalid percent encoding.", true);
    return false;
  }
}

function swapUrl() {
  const input = $("#url-input").value;
  $("#url-input").value = $("#url-output").value;
  $("#url-output").value = input;
}

function clearUrl() {
  $("#url-input").value = "";
  $("#url-output").value = "";
  $("#url-input").focus();
}

async function consumePendingTransform(pendingTransform = null) {
  const pending = pendingTransform ??
    (await chrome.storage.session.get("pendingTransform")).pendingTransform;
  if (!pending) return;
  if (pending.tabId != null && activeTab?.id !== pending.tabId) return;

  if (Date.now() - pending.createdAt > 5 * 60 * 1000) {
    const current = (await chrome.storage.session.get("pendingTransform")).pendingTransform;
    if (current?.id === pending.id) await chrome.storage.session.remove("pendingTransform");
    return;
  }

  const successful = applySelectionTransform(pending);

  const current = (await chrome.storage.session.get("pendingTransform")).pendingTransform;
  if (current?.id === pending.id) await chrome.storage.session.remove("pendingTransform");
  if (successful) {
    showToast(`Selection sent to ${pending.tool === "base64" ? "Base64" : "URL"} ${pending.operation}.`);
  }
}

function applySelectionTransform({ tool, operation, input }) {
  if (!input || !["base64", "url", "jwt"].includes(tool)) return false;
  if (tool === "jwt") {
    const token = extractJwt(input);
    if (!token) return false;
    showPanel("jwt");
    $("#jwt-input").value = token;
    const successful = Boolean(analyseJwtInput(false));
    $("#panel-jwt").scrollIntoView({ behavior: "smooth" });
    $("#jwt-input").focus();
    return successful;
  }

  showPanel("transform");
  if (tool === "base64") {
    $("#base64-input").value = input;
    const successful = operation === "decode" ? decodeBase64() : encodeBase64();
    $("#base64-tool").scrollIntoView({ behavior: "smooth" });
    $("#base64-input").focus();
    return successful;
  }

  $("#url-input").value = input;
  const successful = operation === "decode" ? decodeUrl() : encodeUrl();
  $("#url-tool").scrollIntoView({ behavior: "smooth" });
  $("#url-input").focus();
  return successful;
}

function openInternalSelectionMenu(event) {
  const selection = selectedTextFromEvent(event);
  if (!selection) {
    closeInternalSelectionMenu();
    return;
  }
  openTransformMenu(event, selection, "Selected text");
}

function openRecordTransformMenu(event, value, label) {
  if (!String(value ?? "").length) {
    closeInternalSelectionMenu();
    return;
  }
  openTransformMenu(event, String(value), label);
}

function openTransformMenu(event, value, label) {
  event.preventDefault();
  event.stopPropagation();
  internalSelectionText = value;
  internalJwtText = extractJwt(value) ?? "";
  const menu = $("#selection-transform-menu");
  $("#selection-transform-title").textContent = `${label} to`;
  $("#selection-jwt-workbench").classList.toggle("hidden", !internalJwtText);
  menu.classList.remove("hidden");
  const left = Math.max(4, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 4));
  const top = Math.max(4, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function selectedTextFromEvent(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (target instanceof HTMLInputElement && target.type === "password") return "";
    try {
      const start = target.selectionStart;
      const end = target.selectionEnd;
      if (Number.isInteger(start) && Number.isInteger(end) && end > start) {
        return target.value.slice(start, end);
      }
    } catch {
      return "";
    }
  }
  return window.getSelection()?.toString() ?? "";
}

function closeInternalSelectionMenu() {
  $("#selection-transform-menu").classList.add("hidden");
}

function valueEditorElements(kind) {
  return {
    textarea: $(`#${kind}-value`),
    format: $(`#${kind}-value-format`),
    rawButton: $(`#${kind}-mode-raw`),
    prettyButton: $(`#${kind}-mode-pretty`)
  };
}

function valueEditorState(kind) {
  return kind === "cookie" ? cookieValueState : storageValueState;
}

function setValueEditorState(kind, state) {
  if (kind === "cookie") cookieValueState = state;
  else storageValueState = state;
}

function loadValueEditor(kind, rawValue) {
  const preview = prettyPrintValue(rawValue);
  const state = {
    codec: preview.codec,
    format: preview.format,
    mode: "pretty",
    originalFormatted: preview.formatted,
    originalRaw: String(rawValue ?? "")
  };
  setValueEditorState(kind, state);
  valueEditorElements(kind).textarea.value = preview.formatted;
  updateValueModeUi(kind);
}

function switchValueMode(kind, targetMode) {
  const state = valueEditorState(kind);
  if (!state || state.mode === targetMode) return;

  try {
    const elements = valueEditorElements(kind);
    if (targetMode === "raw") {
      elements.textarea.value = readValueEditor(kind);
      state.mode = "raw";
      updateValueModeUi(kind);
      return;
    }

    loadValueEditor(kind, elements.textarea.value);
  } catch (error) {
    showError(error);
  }
}

function readValueEditor(kind) {
  const state = valueEditorState(kind);
  const value = valueEditorElements(kind).textarea.value;
  if (!state || state.mode === "raw") return value;
  if (value === state.originalFormatted) return state.originalRaw;

  try {
    return serialisePrettyValue(value, state.codec);
  } catch (error) {
    throw new Error(`Invalid ${state.format} value: ${error.message}`);
  }
}

function autoDetectPrettyValue(kind) {
  const state = valueEditorState(kind);
  if (!state || state.mode !== "pretty" || state.codec !== "text") return;
  const value = valueEditorElements(kind).textarea.value;
  const detected = prettyPrintValue(value);
  if (detected.codec !== "text") loadValueEditor(kind, value);
}

function updateValueModeUi(kind) {
  const state = valueEditorState(kind);
  const elements = valueEditorElements(kind);
  elements.rawButton.classList.toggle("active", state.mode === "raw");
  elements.prettyButton.classList.toggle("active", state.mode === "pretty");
  const jwtWarning = state.mode === "pretty" && state.codec === "jwt"
    ? " · edits invalidate signature"
    : "";
  elements.format.textContent = `${state.mode === "pretty" ? "Pretty" : "Raw"} · ${state.format}${jwtWarning}`;
}

function epochToDate() {
  try {
    const milliseconds = normaliseEpoch($("#epoch-input").value, $("#epoch-input-unit").value);
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) throw new Error("Epoch is outside the supported date range.");
    const results = $("#epoch-results");
    results.classList.remove("empty-state");
    results.replaceChildren();
    for (const [label, value] of [["ISO", date.toISOString()], ["Local", date.toLocaleString()]]) {
      const row = document.createElement("div");
      row.className = "result-row";
      const strong = document.createElement("strong");
      strong.textContent = label;
      const code = document.createElement("code");
      code.textContent = value;
      row.append(strong, code);
      results.append(row);
    }
    $("#date-input").value = toLocalDateTime(milliseconds);
  } catch (error) {
    showError(error);
  }
}

function humanToEpoch() {
  try {
    $("#date-result").value = String(dateToEpoch($("#date-input").value, $("#epoch-output-unit").value));
  } catch (error) {
    showError(error);
  }
}

function analyseJwtInput(showNotice = true) {
  try {
    const decoded = decodeJwt($("#jwt-input").value);
    $("#jwt-header").value = JSON.stringify(decoded.header, null, 2);
    $("#jwt-claims").value = JSON.stringify(decoded.payload, null, 2);
    renderJwtAnalysis(decoded);
    if (showNotice) showToast("JWT analysed.");
    return decoded;
  } catch (error) {
    showError(error);
    return null;
  }
}

function readJwtEditors() {
  let header;
  let payload;
  try {
    header = JSON.parse($("#jwt-header").value);
  } catch (error) {
    throw new Error(`Invalid JWT header JSON: ${error.message}`);
  }
  try {
    payload = JSON.parse($("#jwt-claims").value);
  } catch (error) {
    throw new Error(`Invalid JWT claims JSON: ${error.message}`);
  }
  encodeJwt(header, payload);
  return { header, payload };
}

function rebuildUnsignedJwt() {
  try {
    const { header, payload } = readJwtEditors();
    const token = encodeJwt(header, payload);
    $("#jwt-result").value = token;
    renderJwtAnalysis(decodeJwt(token));
    showToast("Unsigned JWT rebuilt; the signature segment is empty.");
  } catch (error) {
    showError(error);
  }
}

async function verifyJwtSignature() {
  try {
    const token = $("#jwt-input").value;
    const secret = $("#jwt-secret").value;
    const verified = await verifyJwtHmac(token, secret);
    const decoded = decodeJwt(token);
    $("#jwt-header").value = JSON.stringify(decoded.header, null, 2);
    $("#jwt-claims").value = JSON.stringify(decoded.payload, null, 2);
    renderJwtAnalysis(decoded, verified);
    showToast(verified ? "JWT HMAC signature verified." : "JWT HMAC signature is invalid.", !verified);
  } catch (error) {
    showError(error);
  }
}

async function signEditedJwt() {
  try {
    const { header, payload } = readJwtEditors();
    const token = await signJwtHmac(header, payload, $("#jwt-secret").value);
    $("#jwt-result").value = token;
    renderJwtAnalysis(decodeJwt(token), true);
    showToast(`${header.alg} JWT signed.`);
  } catch (error) {
    showError(error);
  }
}

function useJwtResult() {
  const result = $("#jwt-result").value;
  if (!result) {
    showToast("There is no JWT result to load.", true);
    return;
  }
  $("#jwt-input").value = result;
  analyseJwtInput();
}

function clearJwtWorkbench() {
  for (const selector of [
    "#jwt-input",
    "#jwt-header",
    "#jwt-claims",
    "#jwt-secret",
    "#jwt-result"
  ]) {
    $(selector).value = "";
  }
  const analysis = $("#jwt-analysis");
  analysis.className = "jwt-analysis empty-state";
  analysis.textContent = "Token details appear here.";
  setJwtBadge("#jwt-status-badge", "Not analysed", "neutral");
  setJwtBadge("#jwt-signature-status", "Unverified", "neutral");
  $("#jwt-input").focus();
}

function renderJwtAnalysis(decoded, verification = null) {
  const summary = analyseJwt(decoded);
  const analysis = $("#jwt-analysis");
  analysis.replaceChildren();
  analysis.className = "jwt-analysis";

  const details = [
    ["Algorithm", summary.algorithm],
    ["Type", summary.type],
    ["Subject", summary.subject],
    ["Issuer", summary.issuer],
    ["Audience", summary.audience],
    ["JWT ID", summary.jwtId],
    ["Expires", formatJwtNumericDate(summary.expiration)],
    ["Not before", formatJwtNumericDate(summary.notBefore)],
    ["Issued at", formatJwtNumericDate(summary.issuedAt)],
    ["Signature", decoded.signature ? `Present · ${decoded.signature.length} chars` : "Missing"]
  ];
  for (const [label, value] of details) {
    const item = document.createElement("div");
    item.className = "jwt-detail";
    const name = document.createElement("span");
    name.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(name, content);
    analysis.append(item);
  }

  if (summary.warnings.length) {
    const warnings = document.createElement("ul");
    warnings.className = "jwt-warnings";
    for (const warning of summary.warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      warnings.append(item);
    }
    analysis.append(warnings);
  }

  if (summary.expired) {
    setJwtBadge("#jwt-status-badge", "Expired", "danger");
  } else if (summary.notYetValid) {
    setJwtBadge("#jwt-status-badge", "Not yet valid", "caution");
  } else if (summary.issuedInFuture) {
    setJwtBadge("#jwt-status-badge", "Future iat", "caution");
  } else if (!decoded.signature || summary.algorithm.toLowerCase() === "none") {
    setJwtBadge("#jwt-status-badge", "Unsigned", "caution");
  } else if (summary.expiration == null) {
    setJwtBadge("#jwt-status-badge", "No expiry", "caution");
  } else {
    setJwtBadge("#jwt-status-badge", "Time valid", "good");
  }

  if (verification === true) {
    setJwtBadge("#jwt-signature-status", "Verified", "good");
  } else if (verification === false) {
    setJwtBadge("#jwt-signature-status", "Invalid", "danger");
  } else if (!decoded.signature) {
    setJwtBadge("#jwt-signature-status", "Unsigned", "caution");
  } else {
    setJwtBadge("#jwt-signature-status", "Unverified", "neutral");
  }
}

function formatJwtNumericDate(value) {
  if (value == null) return "—";
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString()} · ${value}`
    : `Out of range · ${value}`;
}

function setJwtBadge(selector, text, tone) {
  const badge = $(selector);
  badge.textContent = text;
  badge.className = `jwt-status-badge ${tone}`;
}

function toLocalDateTime(timestamp) {
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 23);
}

function fillNetworkForm() {
  const config = normaliseNetworkConfig(extensionState.networkConfig);
  extensionState.networkConfig = config;
  $("#network-scope").value = config.scope ?? "origin";
  renderUserAgents();
  renderHeaders();
  updateNetworkScopeHint();
}

function normaliseNetworkConfig(config) {
  const normalised = {
    ...config,
    userAgentProfiles: Array.isArray(config.userAgentProfiles)
      ? config.userAgentProfiles.map((profile) => ({ ...profile }))
      : [],
    headers: (config.headers ?? [])
      .filter(({ name }) => name?.trim())
      .map((header) => ({ ...header, id: header.id ?? crypto.randomUUID() }))
  };

  if (!normalised.userAgentProfiles.length && config.userAgent) {
    const id = crypto.randomUUID();
    normalised.userAgentProfiles = [{
      id,
      name: "Imported User-Agent",
      value: config.userAgent
    }];
    normalised.activeUserAgentId = config.enabled && config.userAgentEnabled ? id : null;
  }
  if (
    normalised.activeUserAgentId &&
    !normalised.userAgentProfiles.some(({ id }) => id === normalised.activeUserAgentId)
  ) {
    normalised.activeUserAgentId = null;
  }
  return syncEffectiveNetworkConfig(normalised);
}

function syncEffectiveNetworkConfig(config) {
  const activeProfile = (config.userAgentProfiles ?? [])
    .find(({ id }) => id === config.activeUserAgentId);
  config.activeUserAgentId = activeProfile?.id ?? null;
  config.userAgentEnabled = Boolean(activeProfile);
  config.userAgent = activeProfile?.value ?? "";
  config.enabled = config.userAgentEnabled || (config.headers ?? []).some(({ enabled }) => enabled);
  return config;
}

function renderUserAgents() {
  const config = extensionState.networkConfig;
  const list = $("#user-agent-list");
  list.replaceChildren();
  list.classList.toggle("empty-state", config.userAgentProfiles.length === 0);
  if (!config.userAgentProfiles.length) list.textContent = "No saved User-Agents.";

  for (const profile of config.userAgentProfiles) {
    const active = profile.id === config.activeUserAgentId;
    const row = document.createElement("div");
    row.className = "record-row profile-row";
    row.classList.toggle("selected", active);

    const summary = document.createElement("div");
    summary.className = "profile-summary";
    const key = document.createElement("span");
    key.className = "record-key";
    key.textContent = profile.name;
    const meta = document.createElement("span");
    meta.className = "record-value";
    meta.textContent = profile.value;
    summary.append(key, meta);

    const controls = document.createElement("div");
    controls.className = "profile-controls";
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "switch row-switch";
    toggleLabel.title = active ? "Disable User-Agent" : "Enable User-Agent";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.setAttribute("aria-label", `${toggleLabel.title}: ${key.textContent}`);
    toggle.checked = active;
    const slider = document.createElement("span");
    toggle.addEventListener("change", () => toggleUserAgent(profile.id, toggle.checked));
    toggleLabel.append(toggle, slider);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button secondary small";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openUserAgentEditor(profile));
    controls.append(toggleLabel, edit);
    row.append(summary, controls);
    list.append(row);
  }
}

function openUserAgentEditor(profile = null) {
  editingUserAgentId = profile?.id ?? null;
  $("#user-agent-form-title").textContent = profile ? "Edit User-Agent" : "New User-Agent";
  $("#user-agent-name").value = profile?.name ?? "";
  $("#user-agent").value = profile?.value ?? navigator.userAgent;
  const matching = USER_AGENT_PRESETS.find(({ value }) => value === $("#user-agent").value);
  $("#ua-preset").value = matching?.id ??
    ($("#user-agent").value === navigator.userAgent ? "current" : "custom");
  $("#delete-user-agent").classList.toggle("hidden", !profile);
  $("#user-agent-form").classList.remove("hidden");
  $("#user-agent-name").focus();
}

function closeUserAgentEditor() {
  editingUserAgentId = null;
  $("#user-agent-form").classList.add("hidden");
}

async function saveUserAgent(event) {
  event.preventDefault();
  const profile = {
    id: editingUserAgentId ?? crypto.randomUUID(),
    name: $("#user-agent-name").value.trim(),
    value: $("#user-agent").value.trim()
  };
  const config = extensionState.networkConfig;
  config.userAgentProfiles = editingUserAgentId
    ? config.userAgentProfiles.map((item) => (item.id === editingUserAgentId ? profile : item))
    : [...config.userAgentProfiles, profile];
  if (await persistNetworkConfig("User-Agent profile saved.")) closeUserAgentEditor();
}

async function deleteUserAgent() {
  const config = extensionState.networkConfig;
  const profile = config.userAgentProfiles.find(({ id }) => id === editingUserAgentId);
  if (!profile) return;
  const confirmed = await confirmAction({
    title: "Delete User-Agent?",
    message: `Delete the “${profile.name}” User-Agent profile?`,
    detail: config.activeUserAgentId === profile.id
      ? "This profile is active and will be disabled."
      : "",
    confirmLabel: "Delete profile"
  });
  if (!confirmed) return;
  config.userAgentProfiles = config.userAgentProfiles.filter(({ id }) => id !== profile.id);
  if (config.activeUserAgentId === profile.id) config.activeUserAgentId = null;
  if (await persistNetworkConfig("User-Agent profile deleted.")) closeUserAgentEditor();
}

async function toggleUserAgent(profileId, enabled) {
  extensionState.networkConfig.activeUserAgentId = enabled ? profileId : null;
  await persistNetworkConfig(enabled ? "User-Agent enabled." : "User-Agent disabled.");
}

function populateUserAgentPresets() {
  const select = $("#ua-preset");
  const options = [
    { id: "current", label: "Current browser", value: navigator.userAgent },
    ...USER_AGENT_PRESETS,
    { id: "custom", label: "Custom…", value: "" }
  ];
  select.replaceChildren();
  for (const preset of options) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    option.dataset.userAgent = preset.value;
    select.append(option);
  }
}

function applyUserAgentPreset() {
  const option = $("#ua-preset").selectedOptions[0];
  if (option.value === "custom") {
    $("#user-agent").focus();
    return;
  }
  $("#user-agent").value = option.dataset.userAgent;
  if (!$("#user-agent-name").value.trim()) {
    $("#user-agent-name").value = option.textContent;
  }
}

function renderHeaders() {
  const headers = extensionState.networkConfig.headers;
  const list = $("#header-list");
  list.replaceChildren();
  list.classList.toggle("empty-state", headers.length === 0);
  if (!headers.length) list.textContent = "No custom headers.";

  for (const header of headers) {
    const row = document.createElement("div");
    row.className = "record-row profile-row";
    row.classList.toggle("selected", Boolean(header.enabled));

    const summary = document.createElement("div");
    summary.className = "profile-summary";
    const key = document.createElement("span");
    key.className = "record-key";
    key.textContent = header.name;
    const meta = document.createElement("span");
    meta.className = "record-value";
    meta.textContent = header.value || "(empty)";
    summary.append(key, meta);

    const controls = document.createElement("div");
    controls.className = "profile-controls";
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "switch row-switch";
    toggleLabel.title = header.enabled ? "Disable header" : "Enable header";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.setAttribute("aria-label", `${toggleLabel.title}: ${key.textContent}`);
    toggle.checked = Boolean(header.enabled);
    const slider = document.createElement("span");
    toggle.addEventListener("change", () => toggleHeader(header.id, toggle.checked));
    toggleLabel.append(toggle, slider);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button secondary small";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openHeaderEditor(header));
    controls.append(toggleLabel, edit);
    row.append(summary, controls);
    list.append(row);
  }
}

function openHeaderEditor(header = null) {
  editingHeaderId = header?.id ?? null;
  $("#header-form-title").textContent = header ? "Edit header" : "New header";
  $("#header-name").value = header?.name ?? "";
  $("#header-value").value = header?.value ?? "";
  $("#delete-header").classList.toggle("hidden", !header);
  $("#header-form").classList.remove("hidden");
  $("#header-name").focus();
}

function closeHeaderEditor() {
  editingHeaderId = null;
  $("#header-form").classList.add("hidden");
}

async function saveHeader(event) {
  event.preventDefault();
  const config = extensionState.networkConfig;
  const existing = config.headers.find(({ id }) => id === editingHeaderId);
  const header = {
    id: editingHeaderId ?? crypto.randomUUID(),
    enabled: existing?.enabled ?? false,
    name: $("#header-name").value.trim(),
    value: $("#header-value").value
  };
  config.headers = editingHeaderId
    ? config.headers.map((item) => (item.id === editingHeaderId ? header : item))
    : [...config.headers, header];
  if (await persistNetworkConfig("Custom header saved.")) closeHeaderEditor();
}

async function deleteHeader() {
  const config = extensionState.networkConfig;
  const header = config.headers.find(({ id }) => id === editingHeaderId);
  if (!header) return;
  const confirmed = await confirmAction({
    title: "Delete custom header?",
    message: `Delete the “${header.name}” header?`,
    detail: header.enabled ? "This header is active and will stop being sent." : "",
    confirmLabel: "Delete header"
  });
  if (!confirmed) return;
  config.headers = config.headers.filter(({ id }) => id !== header.id);
  if (await persistNetworkConfig("Custom header deleted.")) closeHeaderEditor();
}

async function toggleHeader(headerId, enabled) {
  const config = extensionState.networkConfig;
  config.headers = config.headers.map((header) =>
    header.id === headerId ? { ...header, enabled } : header
  );
  await persistNetworkConfig(enabled ? "Custom header enabled." : "Custom header disabled.");
}

function updateNetworkScopeHint() {
  $("#network-scope-hint").textContent =
    $("#network-scope").value === "all"
      ? "Rules will affect every HTTP(S) site in this browser profile."
      : `Rules will be restricted to ${getActiveOrigin() || "the current target origin"}.`;
}

async function persistNetworkConfig(successMessage = "") {
  try {
    const config = syncEffectiveNetworkConfig({
      ...extensionState.networkConfig,
      scope: $("#network-scope").value,
      origin: getActiveOrigin() || extensionState.networkConfig.origin,
      userAgentProfiles: extensionState.networkConfig.userAgentProfiles.map((profile) => ({ ...profile })),
      headers: extensionState.networkConfig.headers.map((header) => ({ ...header }))
    });
    await send("saveNetworkConfig", { config });
    extensionState.networkConfig = config;
    renderUserAgents();
    renderHeaders();
    renderPosture();
    if (successMessage) showToast(successMessage);
    return true;
  } catch (error) {
    await refreshState().catch(() => {});
    showError(error);
    return false;
  }
}

function renderProxies() {
  const list = $("#proxy-list");
  list.replaceChildren();
  list.classList.toggle("empty-state", extensionState.proxyProfiles.length === 0);
  if (!extensionState.proxyProfiles.length) list.textContent = "No saved proxies.";

  for (const proxy of extensionState.proxyProfiles) {
    const row = document.createElement("div");
    row.className = "record-row profile-row";
    row.classList.toggle("selected", proxy.id === extensionState.activeProxyId);

    const summary = document.createElement("div");
    summary.className = "profile-summary";
    const key = document.createElement("span");
    key.className = "record-key";
    key.textContent = proxy.name;
    const meta = document.createElement("span");
    meta.className = "record-meta";
    meta.textContent = `${proxy.scheme.toUpperCase()} · ${proxy.host}:${proxy.port}`;
    summary.append(key, meta);

    const controls = document.createElement("div");
    controls.className = "profile-controls";
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "switch row-switch";
    toggleLabel.title = proxy.id === extensionState.activeProxyId ? "Disable proxy" : "Enable proxy";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.setAttribute("aria-label", `${toggleLabel.title}: ${key.textContent}`);
    toggle.checked = proxy.id === extensionState.activeProxyId;
    const slider = document.createElement("span");
    toggle.addEventListener("change", () => toggleProxy(proxy.id, toggle.checked));
    toggleLabel.append(toggle, slider);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button secondary small";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openProxyEditor(proxy));
    controls.append(toggleLabel, edit);
    row.append(summary, controls);
    list.append(row);
  }
}

function openProxyEditor(proxy = null) {
  editingProxyId = proxy?.id ?? null;
  $("#proxy-form-title").textContent = proxy ? "Edit proxy" : "New proxy";
  $("#proxy-name").value = proxy?.name ?? "";
  $("#proxy-scheme").value = proxy?.scheme ?? "http";
  $("#proxy-host").value = proxy?.host ?? "127.0.0.1";
  $("#proxy-port").value = String(proxy?.port ?? 8080);
  $("#proxy-username").value = proxy?.username ?? "";
  $("#proxy-password").value = proxy?.password ?? "";
  $("#proxy-bypass").value = (proxy?.bypassList ?? ["localhost", "127.0.0.1", "<local>"]).join("\n");
  $("#delete-proxy").classList.toggle("hidden", !proxy);
  $("#proxy-form").classList.remove("hidden");
  $("#proxy-name").focus();
}

function closeProxyEditor() {
  editingProxyId = null;
  $("#proxy-form").classList.add("hidden");
}

async function saveProxy(event) {
  event.preventDefault();
  try {
    const endpoint = normaliseProxyEndpoint($("#proxy-host").value, $("#proxy-port").value);
    const profile = {
      id: editingProxyId ?? crypto.randomUUID(),
      name: $("#proxy-name").value.trim(),
      scheme: endpoint.scheme ?? $("#proxy-scheme").value,
      host: endpoint.host,
      port: endpoint.port,
      username: $("#proxy-username").value,
      password: $("#proxy-password").value,
      bypassList: $("#proxy-bypass").value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
    };
    const profiles = editingProxyId
      ? extensionState.proxyProfiles.map((item) => (item.id === editingProxyId ? profile : item))
      : [...extensionState.proxyProfiles, profile];
    await send("saveProxyProfiles", { profiles });
    closeProxyEditor();
    await refreshState();
    showToast("Proxy profile saved.");
  } catch (error) {
    showError(error);
  }
}

async function deleteProxy() {
  const profile = extensionState.proxyProfiles.find(({ id }) => id === editingProxyId);
  if (!profile) return;
  const confirmed = await confirmAction({
    title: "Delete proxy?",
    message: `Delete the “${profile.name}” proxy profile?`,
    detail: extensionState.activeProxyId === profile.id
      ? "This proxy is active. Direct connection mode will be restored."
      : "",
    confirmLabel: "Delete proxy"
  });
  if (!confirmed) return;
  try {
    if (extensionState.activeProxyId === profile.id) await send("deactivateProxy");
    await send("saveProxyProfiles", {
      profiles: extensionState.proxyProfiles.filter(({ id }) => id !== profile.id)
    });
    closeProxyEditor();
    await refreshState();
    showToast("Proxy profile deleted.");
  } catch (error) {
    showError(error);
  }
}

async function toggleProxy(proxyId, enabled) {
  try {
    const applied = enabled ? await send("activateProxy", { proxyId }) : null;
    if (!enabled) await send("deactivateProxy");
    await refreshState();
    showToast(enabled
      ? `${applied.scheme.toUpperCase()} proxy active at ${applied.host}:${applied.port}.`
      : "Proxy disabled; direct mode restored.");
  } catch (error) {
    await refreshState().catch(() => {});
    showError(error);
  }
}

function renderRoles() {
  const list = $("#role-list");
  list.replaceChildren();
  list.classList.toggle("empty-state", extensionState.roles.length === 0);
  if (!extensionState.roles.length) list.textContent = "No saved roles.";

  for (const role of extensionState.roles) {
    const row = document.createElement("div");
    row.className = "record-row profile-row";
    const isActive = extensionState.activeRole?.roleId === role.id;
    row.classList.toggle("selected", isActive);

    const summary = document.createElement("div");
    summary.className = "profile-summary";
    const key = document.createElement("span");
    key.className = "record-key";
    key.textContent = role.name;
    const meta = document.createElement("span");
    meta.className = "record-meta";
    meta.textContent = `${role.type} · ${roleScopeLabel(role.scope ?? "origin")}`;
    summary.append(key, meta);

    const controls = document.createElement("div");
    controls.className = "profile-controls";
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "switch row-switch";
    toggleLabel.title = isActive ? "Disable role" : "Enable role";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.setAttribute("aria-label", `${toggleLabel.title}: ${key.textContent}`);
    toggle.checked = isActive;
    const slider = document.createElement("span");
    toggle.addEventListener("change", () => toggleRole(role.id, toggle.checked));
    toggleLabel.append(toggle, slider);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button secondary small";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openRoleEditor(role));
    controls.append(toggleLabel, edit);
    row.append(summary, controls);
    list.append(row);
  }
  renderPosture();
}

function openRoleEditor(role = null) {
  editingRoleId = role?.id ?? null;
  $("#role-form-title").textContent = role ? "Edit role" : "New role";
  $("#role-name").value = role?.name ?? "";
  $("#role-type").value = role?.type ?? "bearer";
  $("#role-scope").value = role?.scope ?? (role ? "origin" : "domain");
  $("#role-scope-domain").value = role?.scopeDomain ?? "";
  $("#role-token").value = role?.token ?? "";
  $("#role-cookie-name").value = role?.cookieName ?? "";
  $("#role-cookie-value").value = role?.cookieValue ?? "";
  $("#role-cookie-path").value = role?.cookiePath ?? "/";
  $("#role-username").value = role?.username ?? "";
  $("#role-password").value = role?.password ?? "";
  $("#role-header-name").value = role?.headerName ?? "";
  $("#role-header-value").value = role?.headerValue ?? "";
  $("#delete-role").classList.toggle("hidden", !role);
  $("#role-form").classList.remove("hidden");
  syncRoleFields();
  $("#role-name").focus();
}

function closeRoleEditor() {
  editingRoleId = null;
  $("#role-form").classList.add("hidden");
}

function syncRoleFields() {
  const selected = $("#role-type").value;
  $$(".role-fields").forEach((fields) =>
    fields.classList.toggle("hidden", fields.id !== `role-${selected}-fields`)
  );
  const scope = $("#role-scope");
  const allSitesOption = scope.querySelector('option[value="all"]');
  allSitesOption.disabled = selected === "cookie";
  if (selected === "cookie" && scope.value === "all") scope.value = "domain";
  $("#role-domain-fields").classList.toggle("hidden", scope.value !== "domain");
  $("#role-scope-hint").textContent = roleScopeHint(scope.value, selected);
}

async function saveRole(event) {
  event.preventDefault();
  try {
    const scope = $("#role-scope").value;
    const role = {
      id: editingRoleId ?? crypto.randomUUID(),
      name: $("#role-name").value.trim(),
      type: $("#role-type").value,
      scope,
      scopeDomain: scope === "domain"
        ? normaliseDomainScope($("#role-scope-domain").value)
        : "",
      token: $("#role-token").value.trim(),
      cookieName: $("#role-cookie-name").value.trim(),
      cookieValue: $("#role-cookie-value").value,
      cookiePath: $("#role-cookie-path").value.trim() || "/",
      username: $("#role-username").value,
      password: $("#role-password").value,
      headerName: $("#role-header-name").value.trim(),
      headerValue: $("#role-header-value").value
    };
    const roles = editingRoleId
      ? extensionState.roles.map((item) => (item.id === editingRoleId ? role : item))
      : [...extensionState.roles, role];
    extensionState.roles = await send("saveRoles", { roles });
    closeRoleEditor();
    renderRoles();
    showToast("Role saved.");
  } catch (error) {
    showError(error);
  }
}

async function deleteRole() {
  const role = extensionState.roles.find(({ id }) => id === editingRoleId);
  if (!role) return;
  const confirmed = await confirmAction({
    title: "Delete role?",
    message: `Delete the “${role.name}” role?`,
    detail: extensionState.activeRole?.roleId === role.id
      ? "This role is active and will be deactivated first."
      : "",
    confirmLabel: "Delete role"
  });
  if (!confirmed) return;
  try {
    if (extensionState.activeRole?.roleId === role.id) await send("deactivateRole");
    extensionState.roles = await send("saveRoles", {
      roles: extensionState.roles.filter(({ id }) => id !== role.id)
    });
    extensionState.activeRole = null;
    closeRoleEditor();
    renderRoles();
    showToast("Role deleted.");
  } catch (error) {
    showError(error);
  }
}

async function toggleRole(roleId, enabled) {
  if (!enabled) return deactivateRole();
  return activateRole(roleId);
}

async function activateRole(roleId) {
  const origin = getActiveOrigin();
  if (!origin) {
    showToast("Select an HTTP or HTTPS target tab first.", true);
    renderRoles();
    return;
  }
  try {
    const role = extensionState.roles.find(({ id }) => id === roleId);
    if (role?.scope === "all") {
      const confirmed = await confirmAction({
        title: "Activate role on all sites?",
        message: `Apply “${role.name}” to every HTTP(S) request?`,
        detail: "Authorization or custom-header credentials may be sent to unrelated third-party destinations.",
        confirmLabel: "Activate globally"
      });
      if (!confirmed) {
        renderRoles();
        return;
      }
    }
    const activated = await send("activateRole", { roleId, origin });
    await refreshState();
    showToast(`Role active for ${roleScopeDescription(
      activated.scope,
      activated.origin,
      activated.scopeDomain
    )}. Reload the target page.`);
  } catch (error) {
    await refreshState().catch(() => {});
    showError(error);
  }
}

function roleScopeLabel(scope) {
  return {
    origin: "exact origin",
    domain: "domain",
    all: "all sites"
  }[scope] ?? "exact origin";
}

function roleScopeDescription(scope, origin, scopeDomain = "") {
  if (scope === "all") return "all HTTP(S) sites";
  if (scope === "domain") {
    const domain = scopeDomain || new URL(origin).hostname;
    return `${domain} and subdomains`;
  }
  return origin;
}

function roleScopeHint(scope, roleType) {
  if (scope === "all") {
    return "High exposure: this credential will be attached to every HTTP(S) destination.";
  }
  if (scope === "domain") {
    return roleType === "cookie"
      ? "Creates a domain cookie for the configured domain and its subdomains."
      : "Matches the configured domain and all of its subdomains across HTTP, HTTPS, and ports.";
  }
  return roleType === "cookie"
    ? "Cookies cannot be port-scoped; this uses a host-only cookie where possible."
    : "Matches only the activation scheme, hostname, and port.";
}

async function deactivateRole() {
  try {
    await send("deactivateRole");
    await refreshState();
    showToast("Role deactivated and cookie state restored.");
  } catch (error) {
    await refreshState().catch(() => {});
    showError(error);
  }
}

function populatePayloadCategories() {
  const select = $("#payload-category");
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All categories";
  select.append(all);
  for (const group of PAYLOADS) {
    const option = document.createElement("option");
    option.value = group.category;
    option.textContent = group.category;
    select.append(option);
  }
}

function filteredPayloadGroups() {
  const query = $("#payload-search").value.trim().toLowerCase();
  const category = $("#payload-category").value || "all";
  return PAYLOADS
    .filter((group) => category === "all" || group.category === category)
    .map((group) => ({
      ...group,
      payloads: group.payloads.filter(({ value, note }) =>
        (!$("#favorites-only").checked || favorites.has(favoriteKey(group.category, value))) &&
        `${group.category} ${value} ${note}`.toLowerCase().includes(query)
      )
    }))
    .filter((group) => group.payloads.length);
}

function renderPayloads() {
  const groups = filteredPayloadGroups();
  const container = $("#payload-list");
  container.replaceChildren();
  const count = groups.reduce((total, group) => total + group.payloads.length, 0);
  $("#payload-count").textContent = String(count);
  if (!count) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No matching payloads.";
    container.append(empty);
    return;
  }

  for (const group of groups) {
    const heading = document.createElement("h3");
    heading.className = "payload-category";
    heading.textContent = group.category;
    container.append(heading);
    for (const payload of group.payloads) {
      const card = document.createElement("article");
      card.className = "payload-card";
      const code = document.createElement("div");
      code.className = "payload-code";
      code.textContent = payload.value;
      const footer = document.createElement("div");
      footer.className = "payload-footer";
      const note = document.createElement("span");
      note.className = "payload-note";
      note.textContent = payload.note;
      const raw = document.createElement("button");
      raw.type = "button";
      raw.className = "payload-action";
      raw.textContent = "Copy raw";
      raw.addEventListener("click", () => copyText(payload.value, "Raw payload copied."));
      const encoded = document.createElement("button");
      encoded.type = "button";
      encoded.className = "payload-action";
      encoded.textContent = "Copy URL";
      encoded.addEventListener("click", () => copyText(urlEncodePayload(payload.value), "URL-encoded payload copied."));
      const favorite = document.createElement("button");
      const id = favoriteKey(group.category, payload.value);
      favorite.type = "button";
      favorite.className = "payload-action";
      favorite.textContent = favorites.has(id) ? "★ Saved" : "☆ Favorite";
      favorite.setAttribute("aria-pressed", String(favorites.has(id)));
      favorite.setAttribute("aria-label", `Favorite payload: ${payload.note || payload.value}`);
      favorite.addEventListener("click", async () => {
        favorite.disabled = true;
        const next = new Set(favorites);
        if (next.has(id)) next.delete(id); else next.add(id);
        try {
          await chrome.storage.local.set({ payloadFavorites: [...next] });
          favorites = next;
          renderPayloads();
        } catch (error) { favorite.disabled = false; showError(error); }
      });
      footer.append(note, favorite, raw, encoded);
      card.append(code, footer);
      container.append(card);
    }
  }
}

function copyAllPayloads() {
  const values = filteredPayloadGroups().flatMap((group) => group.payloads.map(({ value }) => value));
  if (!values.length) return showToast("No visible payloads to copy.", true);
  copyText(values.join("\n"), `${values.length} raw payloads copied.`);
}

async function copyText(value, successMessage) {
  if (!value) return showToast("Nothing to copy.", true);
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage);
  } catch (error) {
    showError(error);
  }
}

function confirmAction({
  title = "Confirm action?",
  message,
  detail = "",
  confirmLabel = "Confirm"
}) {
  const dialog = $("#confirm-dialog");
  $("#confirm-dialog-title").textContent = title;
  $("#confirm-dialog-message").textContent = message;
  $("#confirm-dialog-detail").textContent = detail;
  $("#confirm-dialog-detail").classList.toggle("hidden", !detail);
  $("#confirm-dialog-accept").textContent = confirmLabel;
  dialog.returnValue = "";

  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "confirm");
    }, { once: true });
    dialog.showModal();
    $("#confirm-dialog-cancel").focus();
  });
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function showError(error) {
  console.error(error);
  showToast(error?.message || String(error), true);
}
