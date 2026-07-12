import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-installed-integrity-'));
const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'arcane-installed-state-'));
const payloadPath = path.join(installRoot, 'bin', 'ArcaneShell.exe');
const originalPayload = Buffer.from('ARCANE-INTEGRITY-FIXTURE');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const manifest = {
  name: 'Arcane OS integrity fixture',
  version: '0.8.2',
  payloadMode: 'release',
  integrity: {
    schemaVersion: 2,
    hashAlgorithm: 'sha256',
    scope: 'installed-tree',
    files: [{ path: 'bin/ArcaneShell.exe', size: originalPayload.length, sha256: digest(originalPayload) }],
  },
};

await fs.mkdir(path.dirname(payloadPath), { recursive: true });
await fs.writeFile(payloadPath, originalPayload);
await fs.writeFile(path.join(installRoot, 'arcane-install.json'), JSON.stringify(manifest, null, 2));

const child = spawn(process.execPath, [
  path.join(root, 'runtime/arcane-core.cjs'),
  '--app=provisioner',
  `--bundle-root=${root}`,
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ARCANE_INSTALL_ROOT: installRoot, ARCANE_STATE_ROOT: stateRoot },
});
let buffer = Buffer.alloc(0);
let expected = null;
const pending = new Map();
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (expected === null) {
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const match = buffer.subarray(0, marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);
      if (!match) throw new Error('Missing Content-Length.');
      expected = Number(match[1]);
      buffer = buffer.subarray(marker + 4);
    }
    if (buffer.length < expected) return;
    const message = JSON.parse(buffer.subarray(0, expected).toString('utf8'));
    buffer = buffer.subarray(expected);
    expected = null;
    if (message.type !== 'response') continue;
    const callback = pending.get(message.id);
    if (!callback) continue;
    pending.delete(message.id);
    message.ok ? callback.resolve(message.result) : callback.reject(Object.assign(new Error(message.error.message), message.error));
  }
});

function call(method) {
  const id = crypto.randomUUID();
  const body = Buffer.from(JSON.stringify({ protocol: 'arcane/1', type: 'request', id, method, parameters: {} }));
  child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20_000);
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
  });
}

try {
  const clean = await call('installation.status');
  assert.equal(clean.installedIntegrity.ok, true);
  assert.equal(clean.installedIntegrity.checkedFiles, 1);

  const changed = Buffer.from(originalPayload);
  changed[0] ^= 1;
  await fs.writeFile(payloadPath, changed);
  const sameSizeTamper = await call('installation.status');
  assert.equal(sameSizeTamper.installedIntegrity.ok, false);
  assert.match(sameSizeTamper.installedIntegrity.reason, /SHA-256/i);

  await fs.writeFile(payloadPath, originalPayload);
  await fs.writeFile(path.join(installRoot, 'unlisted.txt'), 'not in manifest');
  const unlisted = await call('installation.status');
  assert.equal(unlisted.installedIntegrity.ok, false);
  assert.match(unlisted.installedIntegrity.reason, /inventory/i);
  await fs.rm(path.join(installRoot, 'unlisted.txt'));

  await fs.writeFile(path.join(installRoot, 'arcane-install.json'), JSON.stringify({ ...manifest, integrity: null }));
  const legacy = await call('installation.status');
  assert.equal(legacy.installedIntegrity.ok, false);
  assert.match(legacy.installedIntegrity.reason, /missing or obsolete/i);

  const traversal = structuredClone(manifest);
  traversal.integrity.files[0].path = '../outside.exe';
  await fs.writeFile(path.join(installRoot, 'arcane-install.json'), JSON.stringify(traversal));
  const escaped = await call('installation.status');
  assert.equal(escaped.installedIntegrity.ok, false);
  assert.match(escaped.installedIntegrity.reason, /normalized|invalid/i);

  console.log('Arcane installed-tree integrity smoke test passed.');
} finally {
  child.stdin.end();
  child.kill();
  await fs.rm(installRoot, { recursive: true, force: true });
  await fs.rm(stateRoot, { recursive: true, force: true });
}
