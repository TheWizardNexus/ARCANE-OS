import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const preferenceStoreUrl = pathToFileURL(
  path.join(repositoryRoot, 'arcane', 'modules', 'PreferenceStore.js')
).href;

test('PreferenceStore falls back to app-scoped local storage only when Android reports unsupported', async () => {
  delete globalThis.arcaneAndroid;
  const values = new Map();
  let nativeCalls = 0;
  globalThis.document = {
    documentElement: { dataset: {} },
    querySelector() {
      return { getAttribute: () => 'terminal' };
    },
  };
  globalThis.localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  globalThis.Arcane = {
    preferences: {
      async get() {
        nativeCalls += 1;
        throw Object.assign(new Error('unsupported'), { code: 'ANDROID_CAPABILITY_UNSUPPORTED' });
      },
      async set() {
        throw new Error('native set must not run after fallback');
      },
      async delete() {
        throw new Error('native delete must not run after fallback');
      },
    },
  };
  const { default: PreferenceStore } = await import(`${preferenceStoreUrl}?fallback`);
  const store = new PreferenceStore({
    namespace: 'terminal',
    schema: [{ key: 'theme', type: 'text', defaultValue: 'matrix' }],
  });
  assert.deepEqual(await store.load(), { theme: 'matrix' });
  await store.set('theme', 'midnight');
  assert.deepEqual(await store.load(), { theme: 'midnight' });
  assert.equal(nativeCalls, 1);
  assert.equal(values.get('arcane.apps.terminal:arcane.preferences:terminal.theme'), '"midnight"');
});

test('PreferenceStore does not downgrade native denials to local storage', async () => {
  delete globalThis.arcaneAndroid;
  globalThis.Arcane = {
    preferences: {
      async get() {
        throw Object.assign(new Error('denied'), { code: 'ANDROID_CAPABILITY_DENIED' });
      },
      async set() {},
      async delete() {},
    },
  };
  const { default: PreferenceStore } = await import(`${preferenceStoreUrl}?denial`);
  const store = new PreferenceStore({
    namespace: 'terminal',
    schema: [{ key: 'theme', type: 'text', defaultValue: 'matrix' }],
  });
  await assert.rejects(store.load(), (error) => error?.code === 'ANDROID_CAPABILITY_DENIED');
});

test('PreferenceStore selects app-scoped local storage synchronously on Android', async () => {
  let nativeCalls = 0;
  globalThis.localStorage.removeItem('arcane.apps.terminal:arcane.preferences:terminal.theme');
  globalThis.arcaneAndroid = { postMessage() {} };
  globalThis.Arcane = {
    preferences: {
      async get() { nativeCalls += 1; },
      async set() { nativeCalls += 1; },
      async delete() { nativeCalls += 1; },
    },
  };
  const { default: PreferenceStore } = await import(`${preferenceStoreUrl}?android-transport`);
  const store = new PreferenceStore({
    namespace: 'terminal',
    schema: [{ key: 'theme', type: 'text', defaultValue: 'matrix' }],
  });
  assert.deepEqual(await store.load(), { theme: 'matrix' });
  await store.set('theme', 'paper');
  assert.equal(nativeCalls, 0);
  assert.equal(globalThis.localStorage.getItem('arcane.apps.terminal:arcane.preferences:terminal.theme'), '"paper"');
  delete globalThis.arcaneAndroid;
});
