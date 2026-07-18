import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const apiSource = await readFile(path.join(toolsRoot, '../src/frontend/shared/arcane-api.js'), 'utf8');

function installFrontend(window) {
  vm.runInNewContext(apiSource, { clearTimeout, console, setTimeout, window }, { filename: 'arcane-api.js' });
  return window.Arcane;
}

function androidWindow() {
  return {
    arcaneAndroid: {
      onmessage: null,
      postMessage() {},
    },
    crypto: {
      randomUUID() { return 'completion-event-request'; },
    },
  };
}

function sendEvent(window, event, data, includeData = true) {
  const message = { protocol: 'arcane/1', type: 'event', event };
  if (includeData) message.data = data;
  window.__arcaneReceive(message);
}

test('transport readiness is durable and replays asynchronously to late consumers', async function () {
  const window = androidWindow();
  const arcane = installFrontend(window);
  assert.equal(arcane.events.completed('transport.ready'), true);

  const observed = [];
  let subscribing = true;
  arcane.events.when('transport.ready', function (value) {
    assert.equal(subscribing, false);
    assert.equal(typeof window.arcaneAndroid.onmessage, 'function');
    observed.push(JSON.parse(JSON.stringify(value)));
  });
  assert.deepEqual(observed, []);
  subscribing = false;
  await Promise.resolve();

  assert.deepEqual(observed, [{ protocol: 'arcane/1', transport: 'android-webview' }]);
});

test('a cancelled late completion subscription does not run', async function () {
  const arcane = installFrontend(androidWindow());
  let calls = 0;
  const unsubscribe = arcane.events.when('transport.ready', function () { calls += 1; });
  unsubscribe();
  await Promise.resolve();
  assert.equal(calls, 0);
});

test('completion state is recorded before callbacks and the first immutable payload wins', async function () {
  const window = androidWindow();
  const arcane = installFrontend(window);
  const early = [];
  arcane.events.when('core.ready', function (value) {
    assert.equal(arcane.events.completed('core.ready'), true);
    early.push(value.version);
    try { value.nested.count = 99; } catch {}
  });

  const original = { version: 'first', nested: { count: 1 } };
  sendEvent(window, 'core.ready', original);
  original.version = 'mutated-after-dispatch';
  original.nested.count = 88;
  sendEvent(window, 'core.ready', { version: 'second', nested: { count: 2 } });
  assert.deepEqual(early, ['first']);

  const late = [];
  arcane.events.when('core.ready', function (value) {
    late.push({
      version: value.version,
      count: value.nested.count,
      frozen: Object.isFrozen(value),
      nestedFrozen: Object.isFrozen(value.nested),
    });
  });
  assert.deepEqual(late, []);
  await Promise.resolve();
  assert.deepEqual(late, [{ version: 'first', count: 1, frozen: true, nestedFrozen: true }]);
});

test('eager completion reports the selected cross-host transport with unchanged precedence', async function () {
  const cases = [
    {
      expected: 'webview2',
      window: {
        chrome: {
          webview: {
            addEventListener() {},
            hostObjects: { arcaneBridge: { Send() {} } },
          },
        },
      },
    },
    {
      expected: 'webkitgtk',
      window: { webkit: { messageHandlers: { arcane: { postMessage() {} } } } },
    },
    {
      expected: 'development-http',
      window: { __ARCANE_DEV_HTTP__: true },
    },
    {
      expected: 'webview2',
      window: {
        __ARCANE_DEV_HTTP__: true,
        arcaneAndroid: { postMessage() {} },
        chrome: {
          webview: {
            addEventListener() {},
            hostObjects: { arcaneBridge: { Send() {} } },
          },
        },
        webkit: { messageHandlers: { arcane: { postMessage() {} } } },
      },
    },
  ];

  for (const item of cases) {
    item.window.crypto = { randomUUID() { return `transport-${item.expected}`; } };
    const arcane = installFrontend(item.window);
    const observed = [];
    arcane.events.when('transport.ready', function (value) { observed.push(value.transport); });
    await Promise.resolve();
    assert.deepEqual(observed, [item.expected]);
  }
});

test('a malformed selected transport defers its constructor failure to invocation', async function () {
  const expected = new Error('listener setup failed');
  const window = {
    chrome: {
      webview: {
        addEventListener() { throw expected; },
        hostObjects: { arcaneBridge: { Send() {} } },
      },
    },
    crypto: { randomUUID() { return 'malformed-transport'; } },
  };
  const originalError = console.error;
  console.error = function () {};
  let arcane;
  try {
    assert.doesNotThrow(() => { arcane = installFrontend(window); });
  } finally {
    console.error = originalError;
  }
  assert.equal(arcane.events.completed('transport.ready'), false);
  await assert.rejects(arcane.system.ping(), error => error === expected);
});

test('completion payloads preserve JSON falsy values and default only missing data', async function () {
  for (const value of [false, 0, '', null]) {
    const window = androidWindow();
    const arcane = installFrontend(window);
    sendEvent(window, 'core.ready', value);
    let replay = Symbol('unset');
    arcane.events.when('core.ready', function (received) { replay = received; });
    await Promise.resolve();
    assert.equal(replay, value);
  }

  const missingWindow = androidWindow();
  const missingArcane = installFrontend(missingWindow);
  sendEvent(missingWindow, 'core.ready', undefined, false);
  let missing = null;
  missingArcane.events.when('core.ready', function (received) { missing = received; });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(missing)), {});
});

test('ordinary once subscriptions remain future-only and are never made durable', function () {
  const window = androidWindow();
  const arcane = installFrontend(window);
  sendEvent(window, 'operation.progress', { step: 1 });

  const observed = [];
  arcane.events.once('operation.progress', function (value) { observed.push(value.step); });
  assert.deepEqual(observed, []);
  sendEvent(window, 'operation.progress', { step: 2 });
  sendEvent(window, 'operation.progress', { step: 3 });

  assert.deepEqual(observed, [2]);
  assert.equal(arcane.events.completed('operation.progress'), false);
  assert.throws(
    () => arcane.events.when('operation.progress', function () {}),
    /not designated as durable/
  );
});

test('wildcards observe a live completion but never a historical replay', async function () {
  const window = androidWindow();
  const arcane = installFrontend(window);
  const wildcard = [];
  arcane.events.on('*', function (value) { wildcard.push(value.event); });
  sendEvent(window, 'core.ready', { version: 'first' });
  assert.deepEqual(wildcard, ['core.ready']);

  arcane.events.when('core.ready', function () {});
  await Promise.resolve();
  assert.deepEqual(wildcard, ['core.ready']);
});

test('an unhosted document preserves transport-unavailable behavior', async function () {
  const window = { crypto: { randomUUID() { return 'unhosted-request'; } } };
  const arcane = installFrontend(window);
  assert.equal(arcane.events.completed('transport.ready'), false);
  await assert.rejects(
    arcane.system.ping(),
    error => error && error.code === 'ARCANE_TRANSPORT_UNAVAILABLE'
  );
});
