import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as utils from '../src/utils.mjs';

// Run the worker's real workflow functions with an in-memory Chrome API.
async function worker() {
  const source = await readFile(new URL('../src/background.mjs', import.meta.url), 'utf8');
  const local = { roles: [
    { id: 'a', type: 'cookie', cookieName: 'session', cookieValue: 'role-a' },
    { id: 'b', type: 'cookie', cookieName: 'session', cookieValue: 'role-b' }
  ], proxyProfiles: [{ id: 'p', name: 'Proxy', scheme: 'http', host: 'localhost', port: 8080, bypassList: [] }] };
  const session = {};
  let cookie = { name: 'session', value: 'original', domain: 'example.com', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true };
  let effective;
  let blocked = false;
  const area = (data) => ({
    async get() { return { ...data }; },
    async set(values) { Object.assign(data, values); },
    async remove(key) { delete data[key]; }
  });
  const chrome = {
    runtime: {},
    storage: { local: area(local), session: area(session) },
    cookies: {
      async get() { return cookie && { ...cookie }; },
      async set(details) { cookie = { ...details, domain: details.domain || 'example.com' }; return cookie; },
      async remove() { cookie = null; }
    },
    declarativeNetRequest: { async updateDynamicRules() {} },
    proxy: { settings: {
      set({ value }, callback) { effective = value; callback(); },
      get(_, callback) { callback({ value: effective, levelOfControl: blocked ? 'controlled_by_other_extensions' : 'controlled_by_this_extension' }); }
    } }
  };
  const context = vm.createContext({ ...utils, chrome, URL, console, crypto });
  const declarations = source.slice(source.indexOf('const NETWORK_RULE_ID'), source.indexOf('chrome.runtime.onInstalled'));
  const functions = source.slice(source.indexOf('function queueContextMenuBuild'));
  vm.runInContext(declarations + functions + '\nglobalThis.api = { activateRole, deactivateRole, restoreRoleCookie, activateProxy, deactivateProxy, emergencyReset };', context);
  return { ...context.api, local, session, cookie: () => cookie, blockProxy: () => { blocked = true; } };
}

test('switching cookie roles restores the original cookie on deactivation', async () => {
  const w = await worker();
  await w.activateRole('a', 'https://example.com');
  assert.equal(w.cookie().value, 'role-a');
  await w.activateRole('b', 'https://example.com');
  assert.equal(w.cookie().value, 'role-b');
  await w.deactivateRole();
  assert.equal(w.cookie().value, 'original');
  assert.equal(w.cookie().httpOnly, true);
  assert.equal(w.local.roleCookieBackup, undefined);
  assert.equal(w.session.activeRole, undefined);
});

test('cookie restoration removes a role cookie when none existed before', async () => {
  const w = await worker();
  w.local.roleCookieBackup = { url: 'https://example.com/', name: 'session', original: null };
  await w.restoreRoleCookie();
  assert.equal(w.cookie(), null);
  assert.equal(w.local.roleCookieBackup, undefined);
});

test('proxy activation verifies control and deactivation clears the active profile', async () => {
  const w = await worker();
  await w.activateProxy('p');
  assert.equal(w.local.activeProxyId, 'p');
  await w.deactivateProxy();
  assert.equal(w.local.activeProxyId, null);
  assert.equal(w.local.proxyConfig.enabled, false);
  w.blockProxy();
  await assert.rejects(w.activateProxy('p'), /controlled by other extensions/);
  assert.equal(w.local.activeProxyId, null);
});


test('emergency reset disables controls while preserving saved profiles', async () => {
  const w = await worker();
  w.local.networkConfig = { enabled: true, scope: 'origin', origin: 'https://example.com', userAgentEnabled: true, activeUserAgentId: 'ua',
    userAgent: 'test', userAgentProfiles: [{ id: 'ua', name: 'Saved', value: 'test-agent' }],
    headers: [{ id: 'header', name: 'X-Test', value: 'saved', enabled: true }] };
  await w.activateRole('a', 'https://example.com');
  await w.activateProxy('p');
  const result = await w.emergencyReset();
  assert.equal(result.errors.length, 0);
  assert.equal(w.cookie().value, 'original');
  assert.equal(w.session.activeRole, undefined);
  assert.equal(w.local.networkConfig.enabled, false);
  assert.equal(w.local.networkConfig.headers[0].enabled, false);
  assert.equal(w.local.networkConfig.userAgentProfiles[0].name, 'Saved');
  assert.equal(w.local.activeProxyId, null);
  assert.equal(w.local.proxyConfig.enabled, false);
  assert.equal(w.local.roles.length, 2);
  assert.equal(w.local.proxyProfiles.length, 1);
});
