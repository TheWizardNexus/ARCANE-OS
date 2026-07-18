import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { replaceTemplateTokenExactlyOnce } from './exact-template-replacement.mjs';
import { readMethodContracts, renderCoreMethodContracts } from './method-contracts.mjs';
import { readMethodPolicies, renderCoreMethodPolicies } from './method-policies.mjs';

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-preferences-core-'));
const runtimePath = path.join(fixtureRoot, 'runtime', 'arcane-core.cjs');
const baseManifest = JSON.parse(await fs.readFile(path.join(bundleRoot, 'arcane-bundle.json'), 'utf8'));
const manifest = Object.freeze({
  ...baseManifest,
  name: 'Arcane preferences isolation fixture',
  apps: Object.freeze({
    alpha: Object.freeze({
      displayName: 'Alpha',
      type: 'app',
      entry: 'alpha/index.html',
      capabilities: Object.freeze(['preferences.read', 'preferences.write', 'storage.read', 'storage.write']),
    }),
    beta: Object.freeze({
      displayName: 'Beta',
      type: 'app',
      entry: 'beta/index.html',
      capabilities: Object.freeze(['preferences.read', 'preferences.write', 'storage.read', 'storage.write']),
    }),
  }),
});

async function compileFixtureCore() {
  const [template, windowsNative, linuxNative, platformAdapters, policies] = await Promise.all([
    fs.readFile(path.join(bundleRoot, 'src', 'core', 'arcane-core.template.cjs'), 'utf8'),
    fs.readFile(path.join(bundleRoot, 'src', 'native', 'windows.cjs'), 'utf8'),
    fs.readFile(path.join(bundleRoot, 'src', 'native', 'linux.cjs'), 'utf8'),
    fs.readFile(path.join(bundleRoot, 'src', 'native', 'platform-adapters.cjs'), 'utf8'),
    readMethodPolicies(bundleRoot),
  ]);
  const contracts = await readMethodContracts(bundleRoot, policies);
  let core = replaceTemplateTokenExactlyOnce(
    template,
    '__ARCANE_NATIVE_ADAPTERS__',
    `${windowsNative}\n\n${linuxNative}\n\n${platformAdapters}`,
  );
  core = replaceTemplateTokenExactlyOnce(core, '__ARCANE_METHOD_POLICIES__', renderCoreMethodPolicies(policies));
  core = replaceTemplateTokenExactlyOnce(core, '__ARCANE_METHOD_CONTRACTS__', renderCoreMethodContracts(contracts, policies));
  core = replaceTemplateTokenExactlyOnce(core, '__VERSION_JSON__', JSON.stringify(manifest.version));
  core = replaceTemplateTokenExactlyOnce(core, '__BUNDLE_MANIFEST_JSON__', JSON.stringify(manifest));
  await fs.mkdir(path.dirname(runtimePath), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(fixtureRoot, 'arcane-bundle.json'), `${JSON.stringify(manifest)}\n`, 'utf8'),
    fs.writeFile(runtimePath, core, { mode: 0o755 }),
  ]);
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function createClient(app, stateRoot) {
  const stateEnvironment = process.platform === 'win32'
    ? { LOCALAPPDATA: stateRoot }
    : { XDG_STATE_HOME: stateRoot };
  const child = spawn(process.execPath, [
    runtimePath,
    `--app=${app}`,
    `--bundle-root=${fixtureRoot}`,
  ], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      ...stateEnvironment,
      ARCANE_RELEASE_CONTENT_BINDING: '',
      ARCANE_RELEASE_REVOCATION_STATUS: '',
      ARCANE_RELEASE_SECURITY_MODE: '',
      ARCANE_RELEASE_SIGNER_THUMBPRINT: '',
      ARCANE_RELEASE_TIMESTAMP_VERIFIED: '',
      ARCANE_RELEASE_TRUST_SOURCE: '',
      ARCANE_RELEASE_VERIFIED_AT: '',
      ARCANE_SIMULATE_PLATFORM: '',
      ARCANE_SIMULATE_PROVISIONING: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = Buffer.alloc(0);
  let expectedLength = null;
  let stderr = '';
  const pending = new Map();

  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-16384); });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (expectedLength === null) {
        const marker = buffer.indexOf('\r\n\r\n');
        if (marker < 0) return;
        const header = buffer.subarray(0, marker).toString('ascii');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) throw new Error(`Invalid Arcane frame header: ${header}`);
        expectedLength = Number(match[1]);
        buffer = buffer.subarray(marker + 4);
      }
      if (buffer.length < expectedLength) return;
      const message = JSON.parse(buffer.subarray(0, expectedLength).toString('utf8'));
      buffer = buffer.subarray(expectedLength);
      expectedLength = null;
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

  return {
    call(method, parameters = {}) {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timeout: ${method}\n${stderr}`));
        }, 20000);
        pending.set(id, {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); },
        });
        child.stdin.write(frame({ protocol: 'arcane/1', type: 'request', id, method, parameters }), (error) => {
          if (!error) return;
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        });
      });
    },
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

async function withStateRoot(work) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-preferences-state-'));
  try {
    return await work(stateRoot);
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
}

await compileFixtureCore();

test.after(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

test('preferences list, get, set, and delete remain inside the calling application scope', async () => {
  await withStateRoot(async (stateRoot) => {
    const alpha = createClient('alpha', stateRoot);
    const beta = createClient('beta', stateRoot);
    try {
      assert.equal((await alpha.call('app.current')).id, 'alpha');
      assert.equal((await beta.call('app.current')).id, 'beta');
      await alpha.call('preferences.set', { key: 'shared-name', value: { owner: 'alpha' } });
      const alphaList = await alpha.call('preferences.list');
      assert.deepEqual(alphaList.keys, ['shared-name']);
      assert(alphaList.usedBytes > 32);
      assert.equal(alphaList.maximumBytes, 1024 * 1024);
      const betaList = await beta.call('preferences.list');
      assert.deepEqual(betaList.keys, []);
      assert.equal(betaList.usedBytes, 32);
      assert.equal(betaList.maximumBytes, 1024 * 1024);
      assert.deepEqual(await beta.call('preferences.get', { key: 'shared-name' }), {
        key: 'shared-name',
        found: false,
        value: null,
      });

      await beta.call('preferences.set', { key: 'shared-name', value: { owner: 'beta' } });
      await beta.call('preferences.delete', { key: 'shared-name' });
      assert.deepEqual(await alpha.call('preferences.get', { key: 'shared-name' }), {
        key: 'shared-name',
        found: true,
        value: { owner: 'alpha' },
      });
    } finally {
      await Promise.all([alpha.close(), beta.close()]);
    }
  });
});

test('native storage uses separate app folders for identical keys', async () => {
  await withStateRoot(async (stateRoot) => {
    const alpha = createClient('alpha', stateRoot);
    const beta = createClient('beta', stateRoot);
    try {
      await alpha.call('storage.set', { key: 'shared-name', value: { owner: 'alpha' } });
      assert.deepEqual(await beta.call('storage.get', { key: 'shared-name' }), {
        key: 'shared-name',
        found: false,
        value: null,
      });
      await beta.call('storage.set', { key: 'shared-name', value: { owner: 'beta' } });
      await beta.call('storage.delete', { key: 'shared-name' });
      assert.deepEqual(await alpha.call('storage.get', { key: 'shared-name' }), {
        key: 'shared-name',
        found: true,
        value: { owner: 'alpha' },
      });
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(stateRoot, 'Arcane OS', 'apps', 'alpha', 'storage.json'), 'utf8')),
        { schemaVersion: 1, entries: { 'shared-name': { owner: 'alpha' } } },
      );
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(stateRoot, 'Arcane OS', 'apps', 'beta', 'storage.json'), 'utf8')),
        { schemaVersion: 1, entries: {} },
      );
    } finally {
      await Promise.all([alpha.close(), beta.close()]);
    }
  });
});

test('Core rejects traversal application identities before creating app data', async () => {
  await withStateRoot(async (stateRoot) => {
    const stateEnvironment = process.platform === 'win32'
      ? { LOCALAPPDATA: stateRoot }
      : { XDG_STATE_HOME: stateRoot };
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        runtimePath,
        '--app=../escape',
        `--bundle-root=${fixtureRoot}`,
      ], {
        cwd: fixtureRoot,
        env: { ...process.env, ...stateEnvironment },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
    });
    assert.equal(result.signal, null);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /invalid application identity/i);
    await assert.rejects(
      fs.access(path.join(stateRoot, 'Arcane OS', 'escape')),
      (error) => error.code === 'ENOENT',
    );
    await assert.rejects(
      fs.access(path.join(stateRoot, 'Arcane OS', 'apps')),
      (error) => error.code === 'ENOENT',
    );
  });
});

test('malformed unowned legacy preferences fail closed and are not rewritten', async () => {
  await withStateRoot(async (stateRoot) => {
    const legacyPath = path.join(stateRoot, 'Arcane OS', 'preferences.json');
    const malformedLegacy = '{"schemaVersion":1,"entries":';
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, malformedLegacy, 'utf8');
    const alpha = createClient('alpha', stateRoot);
    try {
      assert.deepEqual((await alpha.call('preferences.list')).keys, []);
      await alpha.call('preferences.set', { key: 'safe', value: true });
      assert.equal(await fs.readFile(legacyPath, 'utf8'), malformedLegacy);
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(stateRoot, 'Arcane OS', 'apps', 'alpha', 'preferences.json'), 'utf8')),
        { schemaVersion: 1, entries: { safe: true } },
      );
    } finally {
      await alpha.close();
    }
  });
});

test('valid unowned legacy preferences are not guessed into either application scope', async () => {
  await withStateRoot(async (stateRoot) => {
    const legacyPath = path.join(stateRoot, 'Arcane OS', 'preferences.json');
    const legacyPreferences = `${JSON.stringify({
      schemaVersion: 1,
      entries: {
        'alpha.private-token': 'legacy-sensitive-value',
        'shared.appearance': 'legacy-unowned-value',
      },
    })}\n`;
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, legacyPreferences, 'utf8');
    const alpha = createClient('alpha', stateRoot);
    const beta = createClient('beta', stateRoot);
    try {
      assert.deepEqual((await alpha.call('preferences.list')).keys, []);
      assert.deepEqual((await beta.call('preferences.list')).keys, []);
      assert.deepEqual(await alpha.call('preferences.get', { key: 'alpha.private-token' }), {
        key: 'alpha.private-token',
        found: false,
        value: null,
      });
      assert.deepEqual(await beta.call('preferences.get', { key: 'alpha.private-token' }), {
        key: 'alpha.private-token',
        found: false,
        value: null,
      });

      await alpha.call('preferences.set', { key: 'explicitly-scoped', value: true });
      assert.equal(await fs.readFile(legacyPath, 'utf8'), legacyPreferences);
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(stateRoot, 'Arcane OS', 'apps', 'alpha', 'preferences.json'), 'utf8')),
        { schemaVersion: 1, entries: { 'explicitly-scoped': true } },
      );
      await assert.rejects(
        fs.access(path.join(stateRoot, 'Arcane OS', 'apps', 'beta', 'preferences.json')),
        (error) => error.code === 'ENOENT',
      );
    } finally {
      await Promise.all([alpha.close(), beta.close()]);
    }
  });
});

test('the preferences quota remains enforced independently for each application', async () => {
  await withStateRoot(async (stateRoot) => {
    const alpha = createClient('alpha', stateRoot);
    const beta = createClient('beta', stateRoot);
    const value = 'x'.repeat(120 * 1024);
    try {
      for (let index = 0; index < 8; index += 1) {
        await alpha.call('preferences.set', { key: `quota.${index}`, value });
      }
      await assert.rejects(
        alpha.call('preferences.set', { key: 'quota.8', value }),
        (error) => error.code === 'PREFERENCES_QUOTA_EXCEEDED' && error.status === 413,
      );
      assert.equal((await alpha.call('preferences.list')).keys.length, 8);
      const betaSet = await beta.call('preferences.set', { key: 'still-available', value: true });
      assert.equal(betaSet.key, 'still-available');
      assert.equal(betaSet.value, true);
      assert.equal(betaSet.bytes, 4);
      assert.equal(betaSet.maximumBytes, 1024 * 1024);
    } finally {
      await Promise.all([alpha.close(), beta.close()]);
    }
  });
});

test('parallel preference mutations in one application preserve every update', async () => {
  await withStateRoot(async (stateRoot) => {
    const alpha = createClient('alpha', stateRoot);
    const records = Array.from({ length: 48 }, (_, index) => ({
      key: `parallel.${String(index).padStart(2, '0')}`,
      value: { index },
    }));
    try {
      await Promise.all(records.map(({ key, value }) => alpha.call('preferences.set', { key, value })));
      assert.deepEqual(
        (await alpha.call('preferences.list')).keys,
        records.map(({ key }) => key),
      );
      const loaded = await Promise.all(records.map(({ key }) => alpha.call('preferences.get', { key })));
      assert.deepEqual(loaded.map(({ value }) => value), records.map(({ value }) => value));
    } finally {
      await alpha.close();
    }
  });
});
