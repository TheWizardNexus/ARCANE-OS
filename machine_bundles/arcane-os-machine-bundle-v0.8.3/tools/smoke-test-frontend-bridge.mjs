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

async function verifyApplicationsApiContract() {
  const requests = [];
  const bridge = {
    async Send(serializedRequest) {
      requests.push(JSON.parse(serializedRequest));
      return JSON.stringify({ accepted: true });
    },
  };
  const harness = loadArcaneWithWebView2Bridge(bridge);

  const listPromise = harness.window.Arcane.applications.list();
  assert.equal(requests[0].method, 'apps.list');
  assert.deepEqual(requests[0].parameters, {});
  harness.window.__arcaneReceive({
    protocol: 'arcane/1', type: 'response', id: requests[0].id, ok: true,
    result: { verified: true, applications: [] },
  });
  assert.equal((await listPromise).verified, true);

  const launchPromise = harness.window.Arcane.applications.launch('boss', {
    path: 'C:\\untrusted.exe', args: ['--unsafe'], env: { PATH: 'untrusted' },
  });
  assert.equal(requests[1].method, 'apps.launch');
  assert.deepEqual(requests[1].parameters, { id: 'boss' }, 'the frontend API must pass an application ID only');
  harness.window.__arcaneReceive({
    protocol: 'arcane/1', type: 'response', id: requests[1].id, ok: true,
    result: { id: 'boss', accepted: true },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await launchPromise)), { id: 'boss', accepted: true });
}

async function verifyTerminalApiContract() {
  const requests = [];
  const bridge = { async Send(serializedRequest) { requests.push(JSON.parse(serializedRequest)); return JSON.stringify({ accepted:true }); } };
  const harness = loadArcaneWithWebView2Bridge(bridge);
  const start = harness.window.Arcane.terminal.start({ shell:'powershell',cwd:'C:\\work',columns:100,rows:30,executable:'untrusted.exe' });
  assert.equal(requests[0].method,'terminal.start');
  assert.deepEqual(requests[0].parameters,{ shell:'powershell',cwd:'C:\\work',columns:100,rows:30 });
  harness.window.__arcaneReceive({ protocol:'arcane/1',type:'response',id:requests[0].id,ok:true,result:{ id:'term-1',shell:'powershell' } });
  assert.equal((await start).id,'term-1');
  const write = harness.window.Arcane.terminal.write('term-1','echo ready\n');
  assert.equal(requests[1].method,'terminal.write');
  assert.deepEqual(requests[1].parameters,{ sessionId:'term-1',data:'echo ready\n' });
  harness.window.__arcaneReceive({ protocol:'arcane/1',type:'response',id:requests[1].id,ok:true,result:{ accepted:true } });
  assert.equal((await write).accepted,true);
}

async function verifyOllamaApiContract() {
  const requests = [];
  const bridge = {
    async Send(serializedRequest) {
      requests.push(JSON.parse(serializedRequest));
      return JSON.stringify({ accepted: true });
    },
  };
  const harness = loadArcaneWithWebView2Bridge(bridge);

  const modelsPromise = harness.window.Arcane.ollama.models();
  assert.equal(requests[0].method, 'ollama.models');
  harness.window.__arcaneReceive({ protocol:'arcane/1',type:'response',id:requests[0].id,ok:true,result:{ models:[] } });
  assert.deepEqual(JSON.parse(JSON.stringify(await modelsPromise)), { models:[] });

  const chunks = [];
  const chatPromise = harness.window.Arcane.ollama.chat({ model:'gemma4',messages:[{ role:'user',content:'Hello' }] }, { onChunk:chunk=>chunks.push(chunk) });
  assert.equal(requests[1].method, 'ollama.chat');
  assert.equal(requests[1].parameters.stream, true);
  assert.match(requests[1].parameters.streamId, /^frontend-bridge-test-/);
  harness.window.__arcaneReceive({
    protocol:'arcane/1',type:'event',event:'ollama.chunk',
    data:{ streamId:requests[1].parameters.streamId,operation:'chat',chunk:{ message:{ content:'Hi' },done:false } },
  });
  harness.window.__arcaneReceive({ protocol:'arcane/1',type:'response',id:requests[1].id,ok:true,result:{ message:{ content:'' },done:true } });
  await chatPromise;
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].message.content, 'Hi');

  const pullPromise = harness.window.Arcane.ollama.pull('gemma4', { insecure:false });
  assert.equal(requests[2].method, 'ollama.pull');
  assert.deepEqual(requests[2].parameters, { insecure:false,model:'gemma4' });
  harness.window.__arcaneReceive({ protocol:'arcane/1',type:'response',id:requests[2].id,ok:true,result:{ status:'success' } });
  assert.equal((await pullPromise).status, 'success');
}

await verifySendAndReceiveContract();
await verifyBridgeFailureDiagnostics();
await verifyApplicationsApiContract();
await verifyTerminalApiContract();
await verifyOllamaApiContract();
console.log('Arcane frontend WebView2 bridge smoke test passed.');
