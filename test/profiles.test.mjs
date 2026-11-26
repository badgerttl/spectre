import test from 'node:test';
import assert from 'node:assert/strict';
import { exportProfiles, readProfiles, mergeProfiles } from '../src/profiles.mjs';

const state = {
  roles: [{ id: 'r', name: 'Role', type: 'bearer', token: 'secret', extra: 'must drop' }],
  headers: [{ id: 'h', name: 'Authorization', value: 'secret', enabled: true }],
  proxyProfiles: [{ id: 'p', name: 'Proxy', host: 'localhost', port: 8080, username: 'user', password: 'secret' }],
  customPayloads: [{ id: 'c', category: 'Mine', value: 'probe', note: 'note' }],
  payloadFavorites: ['favorite']
};

test('exports omit credential values by default and preserve non-secret data', () => {
  const data = exportProfiles(state);
  assert.equal(data.roles[0].token, '');
  assert.equal(data.headers[0].value, '');
  assert.equal(data.proxyProfiles[0].password, '');
  assert.equal(data.proxyProfiles[0].username, '');
  assert.equal(data.roles[0].extra, undefined);
  assert.equal(data.headers[0].enabled, undefined);
  assert.equal(data.customPayloads[0].value, 'probe');
  assert.deepEqual(data.payloadFavorites, ['favorite']);
  assert.equal(state.roles[0].token, 'secret');
  assert.equal(exportProfiles(state, true).roles[0].token, 'secret');
});

test('profile imports reject malformed files before use', () => {
  assert.throws(() => readProfiles({ version: 50 }), /Unsupported/);
  assert.throws(() => readProfiles({ format: 'spectre-profiles', version: 1, roles: {} }), /Invalid roles/);
  assert.throws(() => readProfiles({ format: 'spectre-profiles', version: 1, proxyProfiles: [{ port: '8080' }] }), /port/);
  assert.throws(() => readProfiles({ format: 'spectre-profiles', version: 1, customPayloads: [{ id: 'x', value: '' }] }), /category and value/);
});

test('merging keeps existing names and activation, and gives new imports safe identities', () => {
  const existing = [{ id: 'existing', name: 'Admin', enabled: true, value: 'keep' }];
  const merged = mergeProfiles(existing, [{ id: 'existing', name: 'admin', value: 'replace' }, { id: 'existing', name: 'Viewer', enabled: true }]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], existing[0]);
  assert.notEqual(merged[1].id, 'existing');
  assert.equal(merged[1].enabled, false);
});
