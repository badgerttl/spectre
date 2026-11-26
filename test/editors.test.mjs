import test from 'node:test';
import assert from 'node:assert/strict';
import { installEditors } from '../src/editors.mjs';

test('unsaved edits require a discard choice and successful saves clear the warning', async () => {
  const listeners = {};
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  let accepted = false;
  let prompts = 0;
  globalThis.document = {
    addEventListener(name, callback) { listeners[name] = callback; },
    querySelector() { return { addEventListener() {} }; },
    querySelectorAll() { return []; }
  };
  globalThis.window = { addEventListener() {} };
  try {
    const protection = installEditors({ showError: assert.fail, confirmDiscard: async () => { prompts++; return accepted; } });
    listeners.input({ target: { closest: () => ({ id: 'cookie-form', closest: () => null }) } });
    assert.equal(await protection.ask(), false);
    accepted = true;
    assert.equal(await protection.ask(), true);
    assert.equal(await protection.ask(), true);
    assert.equal(prompts, 2);
    listeners.input({ target: { closest: () => ({ id: 'cookie-form', closest: () => null }) } });
    protection.saved('cookie-form');
    await protection.ask();
    assert.equal(prompts, 2);
  } finally { globalThis.document = oldDocument; globalThis.window = oldWindow; }
});
