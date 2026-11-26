import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as history from '../src/history.mjs';

async function panel() {
  let source = await readFile(new URL('../src/sidepanel.mjs', import.meta.url), 'utf8');
  source = source.replace(/import[\s\S]*?from "[^"]+";/g, '').replace('bindEvents();\ninitialise().catch(showError);', '');
  const elements = new Map();
  const element = (key) => {
    if (!elements.has(key)) elements.set(key, { value: '', textContent: '', classList: { toggle() {}, add() {} }, setAttribute() {} });
    return elements.get(key);
  };
  let current = { id: 1, url: 'https://example.com/' };
  const tabs = new Map([[1, current], [2, { id: 2, url: 'https://other.com/' }]]);
  let cookies = [{ name: 'sid', value: 'old', domain: 'example.com', path: '/', hostOnly: true }];
  const values = { token: 'old', untouched: 'keep' };
  const context = vm.createContext({
    ...history, URL, console, structuredClone, location: { href: 'https://extension.test/' },
    document: { querySelector: element, querySelectorAll: () => [] },
    chrome: {
      tabs: { get: async (id) => tabs.get(id), query: async () => [current] },
      storage: { session: { async set() {} } },
      runtime: { async sendMessage(message) {
        if (message.action === 'listCookies') return { ok: true, data: structuredClone(cookies) };
        if (message.action === 'saveCookie') {
          cookies = cookies.filter((c) => history.cookieKey(c) !== history.cookieKey(message.cookie));
          cookies.push(structuredClone(message.cookie));
        }
        if (message.action === 'removeCookie') cookies = cookies.filter((c) => history.cookieKey(c) !== history.cookieKey(message.cookie));
        if (message.action === 'clearCookies') cookies = [];
        if (message.action === 'setWebStorageItem') values[message.key] = message.value;
        if (message.action === 'removeWebStorageItem') delete values[message.key];
        if (message.action === 'clearWebStorage') for (const key of Object.keys(values)) delete values[key];
        return { ok: true, data: { ...values } };
      } }
    }
  });
  vm.runInContext(source + `
    renderCookies = () => {};
    renderStorage = () => {};
    refreshCookies = async () => {};
    refreshStorage = async () => {};
    loadValueEditor = () => {};
    showToast = () => {};
    showError = (error) => { globalThis.lastError = error.message; };
    globalThis.api = { refreshContext, send, undoLastEdit,
      target: () => activeTab?.id, follow: () => { pinEnabled = false; },
      history: () => undoEntry };
  `, context);
  return { ...context.api, context, values, elements, cookies: () => cookies, closeTarget: () => tabs.delete(1), navigate: () => { current = tabs.get(2); } };
}

test('target is pinned by default, can be replaced, and follows tabs when disabled', async () => {
  const p = await panel();
  await p.refreshContext();
  p.navigate();
  await p.refreshContext();
  assert.equal(p.target(), 1);
  await p.refreshContext(false, true);
  assert.equal(p.target(), 2);
  p.follow();
  await p.refreshContext();
  assert.equal(p.target(), 2);
});

test('undo restores edits and leaves unrelated newer storage values intact', async () => {
  const p = await panel();
  await p.refreshContext();
  await p.send('setWebStorageItem', { tabId: 1, area: 'localStorage', key: 'token', value: 'new' });
  p.values.untouched = 'updated by app';
  await p.undoLastEdit();
  assert.equal(p.values.token, 'old');
  assert.equal(p.values.untouched, 'updated by app');
  assert.equal(p.history(), null);
});

test('undo refuses to overwrite a newer value of the edited record', async () => {
  const p = await panel();
  await p.refreshContext();
  await p.send('setWebStorageItem', { tabId: 1, area: 'localStorage', key: 'token', value: 'new' });
  p.values.token = 'newer';
  await p.undoLastEdit();
  assert.equal(p.values.token, 'newer');
  assert.match(p.context.lastError, /newer values/);
});

test('undo restores cleared storage and removes newly created keys', async () => {
  const p = await panel();
  await p.refreshContext();
  await p.send('clearWebStorage', { tabId: 1, area: 'localStorage' });
  await p.undoLastEdit();
  assert.equal(p.values.token, 'old');
  await p.send('setWebStorageItem', { tabId: 1, area: 'localStorage', key: 'created', value: 'x' });
  await p.undoLastEdit();
  assert.equal(p.values.created, undefined);
});

test('favorite identifiers distinguish categories and survive storage serialization', () => {
  const favorites = new Set([history.favoriteKey('XSS', '<probe>')]);
  const restored = new Set(JSON.parse(JSON.stringify([...favorites])));
  assert.ok(restored.has(history.favoriteKey('XSS', '<probe>')));
  assert.ok(!restored.has(history.favoriteKey('Other', '<probe>')));
});


test('undo restores cleared cookies and the original value after a cookie edit', async () => {
  const p = await panel();
  await p.refreshContext();
  await p.send('clearCookies', { url: 'https://example.com/' });
  assert.equal(p.cookies().length, 0);
  await p.undoLastEdit();
  assert.equal(p.cookies()[0].value, 'old');
  await p.send('saveCookie', { url: 'https://example.com/', cookie: { ...p.cookies()[0], value: 'new' } });
  await p.undoLastEdit();
  assert.equal(p.cookies()[0].value, 'old');
});


test('closing the pinned tab shows a closed message without adopting another target', async () => {
  const p = await panel();
  await p.refreshContext();
  p.navigate();
  p.closeTarget();
  await p.refreshContext();
  assert.equal(p.target(), undefined);
  assert.equal(p.elements.get('#target-title').textContent, 'Pinned target closed');
  await p.refreshContext(false, true);
  assert.equal(p.target(), 2);
});
