import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiPath = path.resolve(here, '../src/frontend/shared/arcane-api.js');
const apiSource = await readFile(apiPath, 'utf8');

function loadArcaneWithWebView2Bridge(bridge) {
  let messageListener = null;
  let requestNumber = 0;
  const window = {
    chrome: {
      webview: {
        hostObjects: { arcaneBridge: bridge },
        addEventListener(eventName, listener) {
          if (eventName === 'message') messageListener = listener;
        },
      },
    },
    crypto: {
      randomUUID() {
        requestNumber += 1;
        return `frontend-bridge-test-${requestNumber}`;
      },
    },
  };

  const context = vm.createContext({
    window,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(apiSource, context, { filename: apiPath });

  return {
    window,
    dispatchNativeMessage(data) {
      assert.equal(typeof messageListener, 'function', 'WebView2 message listener was not installed');
      messageListener({ data });
    },
  };
}

async function verifySendAndReceiveContract() {
  const requests = [];
  const bridge = {
    async Send(serializedRequest) {
      requests.push(JSON.parse(serializedRequest));
      return JSON.stringify({ accepted: true });
    },
  };
  assert.equal('Invoke' in bridge, false, 'the regression bridge must expose only Send');

  const harness = loadArcaneWithWebView2Bridge(bridge);
  const pingPromise = harness.window.Arcane.system.ping();

  assert.equal(requests.length, 1, 'system.ping must call arcaneBridge.Send exactly once');
  assert.equal(requests[0].protocol, 'arcane/1');
  assert.equal(requests[0].type, 'request');
  assert.equal(requests[0].method, 'system.ping');
  assert.deepEqual(requests[0].parameters, {});

  const expectedResult = { ok: true, source: 'frontend-bridge-test' };
  harness.window.__arcaneReceive(JSON.stringify({
    protocol: 'arcane/1',
    type: 'response',
    id: requests[0].id,
    ok: true,
    result: expectedResult,
  }));

  const resolvedResult = JSON.parse(JSON.stringify(await pingPromise));
  assert.deepEqual(resolvedResult, expectedResult, '__arcaneReceive must resolve the matching request');
}

async function verifyBridgeFailureDiagnostics() {
  const nativeFailure = 'Unknown name. (0x80020006)';
  const bridge = {
    async Send() {
      throw new Error(nativeFailure);
    },
  };
  const harness = loadArcaneWithWebView2Bridge(bridge);

  let failure = null;
  await assert.rejects(
    harness.window.Arcane.system.ping(),
    error => {
      failure = error;
      return true;
    },
    'a rejected WebView2 Send call must reject system.ping',
  );

  assert.equal(failure.code, 'ARCANE_BRIDGE_CALL_FAILED');
  assert.equal(failure.method, 'system.ping');
  assert.equal(failure.transport, 'webview2');
  assert.match(failure.technicalMessage, /Unknown name/);
  assert.match(failure.technicalMessage, /0x80020006/i);
  assert.equal(String(failure.hresult).toLowerCase(), '0x80020006');
}

await verifySendAndReceiveContract();
await verifyBridgeFailureDiagnostics();
console.log('Arcane frontend WebView2 bridge smoke test passed.');
