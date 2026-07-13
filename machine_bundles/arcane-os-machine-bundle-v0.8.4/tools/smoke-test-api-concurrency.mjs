import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'runtime', 'arcane-core.cjs');
const simulatedPlatform = process.platform === 'win32' ? 'win32' : 'linux';

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function createClient({ app, simulate = true, extraArgs = [], env = {} }) {
  const child = spawn(process.execPath, [
    runtime,
    `--app=${app}`,
    `--bundle-root=${root}`,
    ...(simulate ? ['--simulate', `--simulate-platform=${simulatedPlatform}`] : []),
    ...extraArgs,
  ], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = Buffer.alloc(0);
  let expected = null;
  let stderr = '';
  const pending = new Map();
  const events = [];

  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (expected === null) {
        const marker = buffer.indexOf('\r\n\r\n');
        if (marker < 0) return;
        const header = buffer.subarray(0, marker).toString('ascii');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) throw new Error(`Invalid Arcane frame header: ${header}`);
        expected = Number(match[1]);
        buffer = buffer.subarray(marker + 4);
      }
      if (buffer.length < expected) return;
      const message = JSON.parse(buffer.subarray(0, expected).toString('utf8'));
      buffer = buffer.subarray(expected);
      expected = null;
      if (message.type === 'event') {
        events.push(message);
        continue;
      }
      if (message.type !== 'response') continue;
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(Object.assign(new Error(message.error.message), message.error));
    }
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`Arcane Core exited before completing requests (code=${code}, signal=${signal}).\n${stderr}`);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });

  function request(method, parameters = {}) {
    const id = crypto.randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}\n${stderr}`));
      }, 30000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(frame({ protocol: 'arcane/1', type: 'request', id, method, parameters }), (error) => {
        if (!error) return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.reject(error);
      });
    });
    return { id, promise };
  }

  return {
    events,
    request,
    call(method, parameters) { return request(method, parameters).promise; },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-storage-concurrency-'));
const storageEnvironment = process.platform === 'win32'
  ? { LOCALAPPDATA: storageRoot }
  : { XDG_STATE_HOME: storageRoot };
const storageClient = createClient({ app: 'shell', simulate: false, env: storageEnvironment });
try {
  const records = Array.from({ length: 64 }, (_, index) => ({
    key: `parallel.record.${String(index).padStart(2, '0')}`,
    value: { index, checksum: crypto.createHash('sha256').update(String(index)).digest('hex') },
  }));
  await Promise.all(records.map(({ key, value }) => storageClient.call('storage.set', { key, value })));
  const listed = await storageClient.call('storage.list');
  assert.deepEqual(listed.keys, records.map(({ key }) => key), 'parallel storage.set requests must preserve every distinct update');
  const loaded = await Promise.all(records.map(({ key }) => storageClient.call('storage.get', { key })));
  assert.deepEqual(loaded.map(({ value }) => value), records.map(({ value }) => value));

  const orderedSet = storageClient.request('storage.set', { key: 'parallel.ordered', value: 'first' });
  const orderedDelete = storageClient.request('storage.delete', { key: 'parallel.ordered' });
  const orderedFinal = storageClient.request('storage.set', { key: 'parallel.ordered', value: 'last' });
  await Promise.all([orderedSet.promise, orderedDelete.promise, orderedFinal.promise]);
  assert.deepEqual(
    await storageClient.call('storage.get', { key: 'parallel.ordered' }),
    { key: 'parallel.ordered', found: true, value: 'last' },
    'set/delete ordering must match framed request order'
  );

  const deletedKeys = records.filter(({ value }) => value.index % 2 === 0).map(({ key }) => key);
  await Promise.all(deletedKeys.map((key) => storageClient.call('storage.delete', { key })));
  const afterDelete = await storageClient.call('storage.list');
  assert.deepEqual(
    afterDelete.keys,
    [...records.filter(({ value }) => value.index % 2 === 1).map(({ key }) => key), 'parallel.ordered'].sort(),
    'parallel storage.delete requests must not resurrect or lose unrelated records'
  );
} finally {
  await storageClient.close();
  await fs.rm(storageRoot, { recursive: true, force: true });
}

const systemOnlyClient = createClient({
  app: 'shell',
  extraArgs: ['--simulate-capabilities=system.read'],
});
try {
  const capabilities = await systemOnlyClient.call('capabilities.list');
  assert.deepEqual(capabilities.grants, ['system.read']);
  assert(capabilities.methods.includes('platform.status'));
  assert(!capabilities.methods.includes('user.current'));

  const platformStatus = await systemOnlyClient.call('platform.status');
  assert(!Object.hasOwn(platformStatus, 'identity'), 'platform.status must not bypass identity.read');
  assert(!Object.hasOwn(platformStatus, 'hostname'), 'platform.status must not disclose a machine identity');
  const forbiddenIdentityKeys = new Set(['domain', 'homedirectory', 'hostname', 'identity', 'user', 'username']);
  const pendingValues = [platformStatus];
  while (pendingValues.length) {
    const value = pendingValues.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      assert(!forbiddenIdentityKeys.has(key.toLowerCase()), `platform.status leaked identity field ${key}`);
      pendingValues.push(child);
    }
  }
  const serializedStatus = JSON.stringify(platformStatus).toLowerCase();
  const normalizedHostname = String(os.hostname() || '').trim().toLowerCase();
  if (normalizedHostname.length >= 3) assert(!serializedStatus.includes(normalizedHostname), `platform.status leaked identity value ${normalizedHostname}`);
  const readyEvent = systemOnlyClient.events.find((event) => event.event === 'core.ready');
  assert(readyEvent && readyEvent.data && readyEvent.data.platform);
  assert(!Object.hasOwn(readyEvent.data.platform, 'hostname'), 'core.ready must not bypass identity capability separation');
  await assert.rejects(
    systemOnlyClient.call('user.current'),
    (error) => error.code === 'METHOD_NOT_ALLOWED' && error.requiredCapability === 'identity.read'
  );
} finally {
  await systemOnlyClient.close();
}

const simulatedInstallFixture = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-simulated-install-'));
const simulatedInstallRoot = path.join(simulatedInstallFixture, 'Arcane OS');
const mutationClient = createClient({
  app: 'provisioner',
  extraArgs: ['--simulate-exclusive-mutation-delay-ms=700'],
  env: {
    ARCANE_INSTALL_ROOT: simulatedInstallRoot,
    ARCANE_STATE_ROOT: path.join(simulatedInstallFixture, 'state'),
  },
});
try {
  const active = mutationClient.request('installation.ensure');
  let activeSettled = false;
  active.promise.finally(() => { activeSettled = true; });

  const read = mutationClient.request('platform.status');
  const competing = [
    ['requirements.ensure', {}],
    ['users.add', { usernames: ['arcane-concurrent-test'] }],
    ['users.activate', { username: 'arcane-concurrent-test' }],
    ['users.resetPassword', { username: 'arcane-concurrent-test' }],
    ['users.applyPassword', { username: 'arcane-concurrent-test', temporaryPassword: 'A!AAAAAAAAAAAAAAAA9z' }],
    ['users.restoreShell', { username: 'arcane-concurrent-test' }],
  ].map(([method, parameters]) => {
    const request = mutationClient.request(method, parameters);
    return {
      method,
      ...request,
      outcome: request.promise.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error })
      ),
    };
  });

  const firstCompletion = await Promise.race([
    read.promise.then(() => 'read'),
    active.promise.then(() => 'mutation'),
  ]);
  assert.equal(firstCompletion, 'read', 'read-only RPC must remain available during a machine mutation');
  assert.equal(activeSettled, false, 'the read-only response must not wait for the active mutation');

  for (const request of competing) {
    const outcome = await request.outcome;
    assert.equal(outcome.ok, false, `${request.method} must be rejected while another mutation is active`);
    const error = outcome.error;
    assert.equal(error.code, 'OPERATION_BUSY', `${request.method} must receive the deterministic busy code`);
    assert.equal(error.status, 409);
    assert.equal(error.retryable, true);
    assert.deepEqual(error.activeOperation && {
      method: error.activeOperation.method,
      requestId: error.activeOperation.requestId,
      }, {
      method: 'installation.ensure',
      requestId: active.id,
    });
    assert(!mutationClient.events.some((event) => event.data && event.data.requestId === request.id), `${request.method} must not emit operation events after busy rejection`);
  }

  const installed = await active.promise;
  assert.equal(installed.installation.present, true);
  assert(mutationClient.events.some((event) => event.event === 'operation.started' && event.data.requestId === active.id));
  assert(mutationClient.events.some((event) => event.event === 'operation.completed' && event.data.requestId === active.id));
  const retry = await mutationClient.call('installation.ensure');
  assert.equal(retry.installation.present, true, 'the exclusive mutation gate must release after success');
  await assert.rejects(
    mutationClient.call('users.resetPassword', { username: 'arcane-missing-user' }),
    (error) => error.code === 'USER_NOT_FOUND'
  );
  const afterFailure = await mutationClient.call('installation.ensure');
  assert.equal(afterFailure.installation.present, true, 'the exclusive mutation gate must release after failure');
} finally {
  await mutationClient.close();
  assert.deepEqual(
    await fs.readdir(simulatedInstallFixture),
    [],
    'simulated installation must not create an active, staged, backup, failed, or state path'
  );
  await fs.rm(simulatedInstallFixture, { recursive: true, force: true });
}

async function runSessionCommandSelfTest(mode) {
  const startedAt = Date.now();
  const { stdout, stderr } = await execFile(process.execPath, [
    runtime,
    '--app=shell',
    '--simulate',
    `--simulate-platform=${simulatedPlatform}`,
    `--bundle-root=${root}`,
    `--self-test-session-command=${mode}`,
  ], { timeout: 10000, windowsHide: true });
  const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  assert(line, `session-command ${mode} self-test returned no result: ${stderr}`);
  return { elapsedMs: Date.now() - startedAt, payload: JSON.parse(line) };
}

const acceptedDispatch = await runSessionCommandSelfTest('accepted');
assert.equal(acceptedDispatch.payload.ok, true);
assert.equal(acceptedDispatch.payload.result.accepted, true);
assert.equal(acceptedDispatch.payload.result.simulated, false);
assert(Number.isSafeInteger(acceptedDispatch.payload.result.pid) && acceptedDispatch.payload.result.pid > 0);
assert(acceptedDispatch.elapsedMs < 5000, 'accepted dispatch must resolve on spawn instead of waiting for session-command exit');
try { process.kill(acceptedDispatch.payload.result.pid); } catch (_) {}

const rejectedDispatch = await runSessionCommandSelfTest('error');
assert.equal(rejectedDispatch.payload.ok, false);
assert.equal(rejectedDispatch.payload.error.code, 'SESSION_COMMAND_DISPATCH_FAILED');
assert.equal(rejectedDispatch.payload.error.status, 503);
assert.equal(rejectedDispatch.payload.error.reason, 'ENOENT');

console.log('Arcane API concurrency, capability isolation, and session dispatch smoke test passed.');
