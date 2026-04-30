'use strict';

// ── Static menu definitions ──────────────────────────────────────────────────

const PROXY_MENU = [
  { id: 'proxy-direct', title: '⊘ Direct (no proxy)' },
  { id: 'proxy-system', title: '⚙ System proxy' },
  { id: 'proxy-burp',   title: '🔴 Burp Suite (127.0.0.1:8080)' },
];
const UA_MENU_PRESETS = [
  {
    id: 'ua-preset-chrome-win',
    label: 'Chrome 147 — Windows 10',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.116 Safari/537.36',
  },
  {
    id: 'ua-preset-chrome-mac',
    label: 'Chrome 147 — macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.117 Safari/537.36',
  },
  {
    id: 'ua-preset-firefox-win',
    label: 'Firefox 150 — Windows 10',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
  },
  {
    id: 'ua-preset-safari-mac',
    label: 'Safari 26.4 — macOS Sonoma',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15',
  },
  {
    id: 'ua-preset-edge-win',
    label: 'Edge 147 — Windows 11',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.116 Safari/537.36 Edg/147.0.7727.116',
  },
  {
    id: 'ua-preset-curl',
    label: 'curl/8.13.0',
    ua: 'curl/8.13.0',
  },
  {
    id: 'ua-preset-iphone-safari',
    label: 'iPhone — Safari (iOS 26.4)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1',
  },
  {
    id: 'ua-preset-iphone-chrome',
    label: 'iPhone — Chrome (iOS 26.4)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/147.0.7727.116 Mobile/15E148 Safari/604.1',
  },
  {
    id: 'ua-preset-android-chrome',
    label: 'Pixel 9 — Chrome (Android 16)',
    ua: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.116 Mobile Safari/537.36',
  },
  {
    id: 'ua-preset-samsung-browser',
    label: 'Galaxy S24 Ultra — Samsung Browser 28',
    ua: 'Mozilla/5.0 (Linux; Android 16; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/147.0.7727.116 Mobile Safari/537.36',
  },
];

const ALL_RESOURCE_TYPES = [
  'main_frame','sub_frame','stylesheet','script','image',
  'font','object','xmlhttprequest','ping','media','websocket','other',
];

// ── Build all context menus (proxy + roles + utils) ──────────────────────────

const PROXY_ID_TO_MODE = {
  'proxy-direct': 'direct',
  'proxy-system': 'system',
  'proxy-burp': 'burp',
};

async function buildAllMenus() {
  await chrome.contextMenus.removeAll();

  const {
    roles = [],
    activeRoleId = null,
    proxyMode = 'direct',
    proxyProfileId = null,
    proxyProfiles = [],
    activeUA = null,
    uaProfiles = [],
    uaCustomAgents = [],
    headerProfiles = [],
    activeHeaderProfileId = null,
  } = await chrome.storage.local.get([
    'roles',
    'activeRoleId',
    'proxyMode',
    'proxyProfileId',
    'proxyProfiles',
    'activeUA',
    'uaProfiles',
    'uaCustomAgents',
    'headerProfiles',
    'activeHeaderProfileId',
  ]);
  const presetActive = ['direct', 'system', 'burp'].includes(proxyMode);

  // Proxy submenu
  chrome.contextMenus.create({ id: 'spectre-proxy', title: 'Spectre Proxy', contexts: ['action'] });
  PROXY_MENU.forEach(item => {
    const mode = PROXY_ID_TO_MODE[item.id];
    const checked = presetActive && mode === proxyMode;
    chrome.contextMenus.create({
      id: item.id,
      parentId: 'spectre-proxy',
      type: 'checkbox',
      checked,
      title: item.title,
      contexts: ['action'],
    });
  });
  if (proxyProfiles.length) {
    chrome.contextMenus.create({
      id: 'proxy-profile-sep',
      parentId: 'spectre-proxy',
      type: 'separator',
      contexts: ['action'],
    });
    proxyProfiles.forEach(profile => {
      const checked = proxyMode === 'profile' && Number(proxyProfileId) === Number(profile.id);
      const label = `${profile.name} (${profile.scheme}://${profile.host}:${profile.port})`;
      chrome.contextMenus.create({
        id: `proxy-profile-${profile.id}`,
        parentId: 'spectre-proxy',
        type: 'checkbox',
        checked,
        title: label,
        contexts: ['action'],
      });
    });
  }

  // User-Agent submenu
  chrome.contextMenus.create({ id: 'spectre-ua', title: 'Spectre User-Agent', contexts: ['action'] });
  chrome.contextMenus.create({
    id: 'ua-reset',
    parentId: 'spectre-ua',
    type: 'checkbox',
    checked: !activeUA,
    title: 'Default (browser)',
    contexts: ['action'],
  });
  chrome.contextMenus.create({ id: 'ua-sep-presets', parentId: 'spectre-ua', type: 'separator', contexts: ['action'] });
  UA_MENU_PRESETS.forEach(item => {
    chrome.contextMenus.create({
      id: item.id,
      parentId: 'spectre-ua',
      type: 'checkbox',
      checked: !!activeUA && activeUA === item.ua,
      title: item.label,
      contexts: ['action'],
    });
  });
  if (uaProfiles.length) {
    chrome.contextMenus.create({ id: 'ua-sep-custom', parentId: 'spectre-ua', type: 'separator', contexts: ['action'] });
    uaProfiles.forEach(profile => {
      const display = profile.ua.length > 78 ? `${profile.ua.slice(0, 75)}...` : profile.ua;
      chrome.contextMenus.create({
        id: `ua-profile-${profile.id}`,
        parentId: 'spectre-ua',
        type: 'checkbox',
        checked: !!activeUA && activeUA === profile.ua,
        title: `${profile.name} (${display})`,
        contexts: ['action'],
      });
    });
  }
  if (uaCustomAgents.length) {
    if (!uaProfiles.length) {
      chrome.contextMenus.create({ id: 'ua-sep-custom', parentId: 'spectre-ua', type: 'separator', contexts: ['action'] });
    }
    uaCustomAgents.forEach((ua, idx) => {
      const display = ua.length > 82 ? `${ua.slice(0, 79)}...` : ua;
      chrome.contextMenus.create({
        id: `ua-legacy-${idx}`,
        parentId: 'spectre-ua',
        type: 'checkbox',
        checked: !!activeUA && activeUA === ua,
        title: `Custom UA ${idx + 1} (${display})`,
        contexts: ['action'],
      });
    });
  }

  // Roles submenu (dynamic based on saved roles)
  if (roles.length) {
    chrome.contextMenus.create({ id: 'spectre-roles', title: 'Spectre Roles', contexts: ['action'] });
    roles.forEach(role => {
      const scope = role.domain
        ? `${role.subdomains ? '*.' : ''}${role.domain}`
        : 'current site';
      chrome.contextMenus.create({
        id: `role-${role.id}`,
        parentId: 'spectre-roles',
        type: 'checkbox',
        checked: activeRoleId != null && Number(activeRoleId) === Number(role.id),
        title: `${role.name}  [${scope}]`,
        contexts: ['action'],
      });
    });
    chrome.contextMenus.create({ type: 'separator', id: 'role-sep', parentId: 'spectre-roles', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'role-eject', parentId: 'spectre-roles', title: '⊘ Eject auth', contexts: ['action'] });
  }

  // Header Injection submenu
  if (headerProfiles.length) {
    chrome.contextMenus.create({ id: 'spectre-headers', title: 'Spectre Header Injection', contexts: ['action'] });
    headerProfiles.forEach(profile => {
      const domainLabel = profile.domain || 'current site';
      const headerCount = profile.headers?.length ?? 0;
      chrome.contextMenus.create({
        id: `hdr-profile-${profile.id}`,
        parentId: 'spectre-headers',
        type: 'checkbox',
        checked: activeHeaderProfileId != null && Number(activeHeaderProfileId) === Number(profile.id),
        title: `${profile.name}  [${domainLabel}] (${headerCount} header${headerCount !== 1 ? 's' : ''})`,
        contexts: ['action'],
      });
    });
    chrome.contextMenus.create({ type: 'separator', id: 'hdr-sep', parentId: 'spectre-headers', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'hdr-eject', parentId: 'spectre-headers', title: '⊘ Eject headers', contexts: ['action'] });
  }

  // Utility actions
  chrome.contextMenus.create({ id: 'spectre-clear-cookies', title: 'Clear Cookies (current site)', contexts: ['action'] });
}

chrome.runtime.onInstalled.addListener(() => buildAllMenus());
chrome.runtime.onStartup.addListener(() => buildAllMenus());

// ── Proxy helper (for context menu quick switch) ─────────────────────────────

function applyProxyFromMenu(mode) {
  return new Promise(resolve => {
    const persistAndRebuild = () => {
      chrome.storage.local.set({ proxyMode: mode, proxyProfileId: null }, () => {
        void buildAllMenus().then(() => resolve());
      });
    };
    if (mode === 'direct') {
      chrome.proxy.settings.clear({ scope: 'regular' }, persistAndRebuild);
    } else if (mode === 'system') {
      chrome.proxy.settings.set({ value: { mode: 'system' }, scope: 'regular' }, persistAndRebuild);
    } else {
      const presets = { burp: { host: '127.0.0.1', port: 8080 } };
      const p = presets[mode];
      chrome.proxy.settings.set({
        value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: p.host, port: p.port } } },
        scope: 'regular',
      }, persistAndRebuild);
    }
  });
}

function buildPacConfig(scheme, host, port, includes, excludes) {
  const proxyStr = scheme === 'socks4' || scheme === 'socks5'
    ? `SOCKS5 ${host}:${port}; SOCKS ${host}:${port}`
    : `PROXY ${host}:${port}`;

  const conditions = [];
  if (excludes.length) {
    excludes.forEach(p => {
      conditions.push(`if (shExpMatch(host, ${JSON.stringify(p)})) return "DIRECT";`);
    });
  }
  if (includes.length) {
    const checks = includes.map(p => `shExpMatch(host, ${JSON.stringify(p)})`).join(' || ');
    conditions.push(`if (${checks}) return "${proxyStr}";`);
    conditions.push('return "DIRECT";');
  } else {
    conditions.push(`return "${proxyStr}";`);
  }

  const script = `function FindProxyForURL(url, host) {\n  ${conditions.join('\n  ')}\n}`;
  return { mode: 'pac_script', pacScript: { data: script } };
}

async function applyProxyProfileFromMenu(profileId) {
  const { proxyProfiles = [] } = await chrome.storage.local.get(['proxyProfiles']);
  const profile = proxyProfiles.find(p => Number(p.id) === Number(profileId));
  if (!profile) return;

  const includes = (profile.include || '').split(',').map(s => s.trim()).filter(Boolean);
  const excludes = (profile.exclude || '').split(',').map(s => s.trim()).filter(Boolean);
  const fixedConfig = {
    mode: 'fixed_servers',
    rules: { singleProxy: { scheme: profile.scheme, host: profile.host, port: parseInt(profile.port, 10) } },
  };
  const config = (includes.length || excludes.length)
    ? buildPacConfig(profile.scheme, profile.host, profile.port, includes, excludes)
    : fixedConfig;

  await new Promise(resolve => {
    chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => resolve());
  });
  await new Promise(resolve => {
    chrome.storage.local.set({ proxyMode: 'profile', proxyProfileId: profile.id }, () => resolve());
  });
  await buildAllMenus();
}

async function applyUserAgentFromMenu(ua) {
  await new Promise(resolve => {
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [2],
      addRules: [{
        id: 2,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'User-Agent', operation: 'set', value: ua }],
        },
        condition: {
          resourceTypes: ALL_RESOURCE_TYPES,
        },
      }],
    }, resolve);
  });
  await new Promise(resolve => {
    chrome.storage.local.set({ activeUA: ua }, () => resolve());
  });
  await buildAllMenus();
}

async function clearUserAgentFromMenu() {
  await new Promise(resolve => {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [2] }, resolve);
  });
  await new Promise(resolve => {
    chrome.storage.local.remove('activeUA', () => resolve());
  });
  await buildAllMenus();
}

// Removes every cookie the browser would send to this URL for the given name (all domain/path variants)
function removeCookiesNamedForUrl(pageUrl, cookieName) {
  return new Promise(resolve => {
    chrome.cookies.getAll({ url: pageUrl }, cookies => {
      const matches = (cookies || []).filter(c => c.name === cookieName);
      if (!matches.length) { resolve(); return; }
      let pending = matches.length;
      for (const c of matches) {
        const scheme = c.secure ? 'https' : 'http';
        const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        chrome.cookies.remove(
          { url: `${scheme}://${host}${c.path}`, name: c.name },
          () => { if (--pending === 0) resolve(); }
        );
      }
    });
  });
}

// ── Role helper (apply from context menu) ────────────────────────────────────

async function applyRoleFromMenu(roleId, tab) {
  const { roles = [] } = await chrome.storage.local.get('roles');
  const role = roles.find(r => r.id === roleId);
  if (!role) return;

  let domain = role.domain;
  if (!domain && tab?.url) {
    try { domain = new URL(tab.url).hostname; } catch {}
  }
  if (!domain) return;

  if (role.type === 'cookie') {
    const cname = role.cookieName || 'auth';
    if (tab?.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
      await removeCookiesNamedForUrl(tab.url, cname);
    }
    const scheme = tab?.url?.startsWith('https') ? 'https' : 'http';
    await new Promise(resolve => {
      chrome.cookies.set({
        url: `${scheme}://${domain}/`,
        name: cname,
        value: role.token,
        domain,
        path: '/',
      }, resolve);
    });
  } else {
    const headerMap = { bearer: 'Authorization', basic: 'Authorization', custom: role.headerName };
    const headerName = headerMap[role.type] || 'Authorization';
    const tokenVal = role.type === 'bearer' ? `Bearer ${role.token}`
                   : role.type === 'basic'  ? `Basic ${role.token}`
                   : role.token;

    await new Promise(res => {
      chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [1],
        addRules: [{
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: headerName, operation: 'remove' },
              { header: headerName, operation: 'set', value: tokenVal },
            ],
          },
          condition: {
            requestDomains: [domain],
            resourceTypes: ALL_RESOURCE_TYPES,
          },
        }],
      }, res);
    });
  }

  await new Promise(res => { chrome.storage.local.set({ activeRoleId: roleId }, res); });
  await buildAllMenus();
}

// ── Context menu click handler ───────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Proxy quick switch
  const proxyMap = { 'proxy-direct': 'direct', 'proxy-system': 'system', 'proxy-burp': 'burp' };
  const proxyMode = proxyMap[info.menuItemId];
  if (proxyMode) { await applyProxyFromMenu(proxyMode); return; }
  if (info.menuItemId.startsWith('proxy-profile-')) {
    const profileId = Number(info.menuItemId.replace('proxy-profile-', ''));
    if (!Number.isNaN(profileId)) {
      await applyProxyProfileFromMenu(profileId);
    }
    return;
  }

  // User-Agent quick switch
  if (info.menuItemId === 'ua-reset') {
    await clearUserAgentFromMenu();
    return;
  }
  const presetUa = UA_MENU_PRESETS.find(item => item.id === info.menuItemId)?.ua;
  if (presetUa) {
    await applyUserAgentFromMenu(presetUa);
    return;
  }
  if (info.menuItemId.startsWith('ua-profile-')) {
    const profileId = Number(info.menuItemId.replace('ua-profile-', ''));
    if (!Number.isNaN(profileId)) {
      const { uaProfiles = [] } = await chrome.storage.local.get(['uaProfiles']);
      const profile = uaProfiles.find(p => Number(p.id) === Number(profileId));
      if (profile?.ua) await applyUserAgentFromMenu(profile.ua);
    }
    return;
  }
  if (info.menuItemId.startsWith('ua-legacy-')) {
    const idx = Number(info.menuItemId.replace('ua-legacy-', ''));
    if (!Number.isNaN(idx)) {
      const { uaCustomAgents = [] } = await chrome.storage.local.get(['uaCustomAgents']);
      const ua = uaCustomAgents[idx];
      if (ua) await applyUserAgentFromMenu(ua);
    }
    return;
  }

  // Header profile eject
  if (info.menuItemId === 'hdr-eject') {
    await new Promise(res => { chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [3] }, res); });
    await new Promise(res => { chrome.storage.local.remove('activeHeaderProfileId', res); });
    await buildAllMenus();
    return;
  }

  // Header profile apply
  if (info.menuItemId.startsWith('hdr-profile-')) {
    const profileId = Number(info.menuItemId.replace('hdr-profile-', ''));
    if (!Number.isNaN(profileId)) {
      const { headerProfiles = [] } = await chrome.storage.local.get(['headerProfiles']);
      const profile = headerProfiles.find(p => Number(p.id) === profileId);
      if (profile?.headers?.length) {
        let domain = profile.domain;
        if (!domain) {
          try { domain = new URL(tab?.url ?? '').hostname; } catch {}
        }
        if (domain) {
          await new Promise(res => {
            chrome.declarativeNetRequest.updateSessionRules({
              removeRuleIds: [3],
              addRules: [{
                id: 3,
                priority: 3,
                action: {
                  type: 'modifyHeaders',
                  requestHeaders: profile.headers.flatMap(h => [
                    { header: h.name, operation: 'remove' },
                    { header: h.name, operation: 'set', value: h.value },
                  ]),
                },
                condition: { requestDomains: [domain], resourceTypes: ALL_RESOURCE_TYPES },
              }],
            }, res);
          });
          await new Promise(res => { chrome.storage.local.set({ activeHeaderProfileId: profile.id }, res); });
          await buildAllMenus();
        }
      }
    }
    return;
  }

  // Role eject
  if (info.menuItemId === 'role-eject') {
    await new Promise(res => { chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] }, res); });
    await new Promise(res => { chrome.storage.local.remove('activeRoleId', res); });
    await buildAllMenus();
    return;
  }

  // Role apply
  if (info.menuItemId.startsWith('role-')) {
    const roleId = parseInt(info.menuItemId.replace('role-', ''), 10);
    if (!isNaN(roleId)) {
      await applyRoleFromMenu(roleId, tab);
    }
    return;
  }

  // Clear cookies
  if (info.menuItemId === 'spectre-clear-cookies') {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = tabs[0]?.url;
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return;
    const cookies = await chrome.cookies.getAll({ url });
    for (const c of cookies) {
      const scheme = c.secure ? 'https' : 'http';
      const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      await chrome.cookies.remove({ url: `${scheme}://${host}${c.path}`, name: c.name });
    }
  }
});

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'GET_COOKIES':
      chrome.cookies.getAll({ url: msg.url }, cookies =>
        sendResponse({ cookies: cookies || [] })
      );
      return true;

    case 'SET_COOKIE':
      chrome.cookies.set(msg.cookie, cookie =>
        sendResponse({ cookie, error: chrome.runtime.lastError || null })
      );
      return true;

    case 'REPLACE_NAMED_COOKIE': {
      const { forUrl, name, cookie } = msg;
      (async () => {
        try {
          if (forUrl && (forUrl.startsWith('http://') || forUrl.startsWith('https://')) && name) {
            await removeCookiesNamedForUrl(forUrl, name);
          }
          chrome.cookies.set(cookie, c => {
            sendResponse({ cookie: c, error: chrome.runtime.lastError || null });
          });
        } catch (e) {
          sendResponse({ error: e?.message || String(e) });
        }
      })();
      return true;
    }

    case 'REMOVE_COOKIE':
      chrome.cookies.remove({ url: msg.url, name: msg.name }, () =>
        sendResponse({ ok: true, error: chrome.runtime.lastError || null })
      );
      return true;

    case 'FETCH': {
      const { url, method = 'GET', headers = {}, body } = msg;
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        sendResponse({ error: 'Only http/https URLs supported' });
        return;
      }
      const opts = { method, headers };
      if (body && method !== 'GET' && method !== 'HEAD') opts.body = body;
      fetch(url, opts)
        .then(async r => {
          const text = await r.text();
          sendResponse({
            status: r.status,
            statusText: r.statusText,
            headers: Object.fromEntries(r.headers.entries()),
            body: text.substring(0, 2000),
            length: text.length,
          });
        })
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }

    case 'INJECT_AUTH': {
      const { headerName, token, domain } = msg;
      chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [1],
        addRules: [{
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: headerName, operation: 'remove' },
              { header: headerName, operation: 'set', value: token },
            ],
          },
          condition: {
            requestDomains: [domain],
            resourceTypes: ALL_RESOURCE_TYPES,
          },
        }],
      }, () => {
        const err = chrome.runtime.lastError?.message || null;
        sendResponse({ ok: !err, error: err });
      });
      return true;
    }

    case 'EJECT_AUTH': {
      chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [1],
      }, () => sendResponse({ ok: true }));
      return true;
    }

    case 'SET_UA': {
      chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [2],
        addRules: [{
          id: 2,
          priority: 2,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'User-Agent', operation: 'set', value: msg.ua }],
          },
          condition: {
            resourceTypes: ALL_RESOURCE_TYPES,
          },
        }],
      }, () => {
        const err = chrome.runtime.lastError?.message || null;
        if (err) { sendResponse({ ok: false, error: err }); return; }
        buildAllMenus().then(() => sendResponse({ ok: true, error: null }));
      });
      return true;
    }

    case 'CLEAR_UA': {
      chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [2],
      }, () => {
        buildAllMenus().then(() => sendResponse({ ok: true }));
      });
      return true;
    }

    case 'INJECT_HEADERS': {
      const { headers, domain } = msg;
      if (!headers?.length || !domain) { sendResponse({ ok: false, error: 'headers and domain required' }); return; }
      chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [3],
        addRules: [{
          id: 3,
          priority: 3,
          action: {
            type: 'modifyHeaders',
            requestHeaders: headers.flatMap(h => [
              { header: h.name, operation: 'remove' },
              { header: h.name, operation: 'set', value: h.value },
            ]),
          },
          condition: {
            requestDomains: [domain],
            resourceTypes: ALL_RESOURCE_TYPES,
          },
        }],
      }, () => {
        const err = chrome.runtime.lastError?.message || null;
        sendResponse({ ok: !err, error: err });
      });
      return true;
    }

    case 'EJECT_HEADERS': {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [3] }, () => {
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'SET_PROXY': {
      const { config } = msg;
      chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => {
        const err = chrome.runtime.lastError?.message || null;
        sendResponse({ ok: !err, error: err });
      });
      return true;
    }

    case 'CLEAR_PROXY': {
      chrome.proxy.settings.clear({ scope: 'regular' }, () => {
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'SYNC_ROLE_MENUS': {
      buildAllMenus().then(() => sendResponse({ ok: true }));
      return true;
    }

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});
