import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'arcane-bundle.json'), 'utf8'));
const platform = process.platform === 'win32' ? 'win32' : 'linux';
const endpoint = platform === 'win32'
  ? `\\\\.\\pipe\\arcane-signature-test-${process.pid}-${crypto.randomBytes(12).toString('hex')}`
  : path.join(os.tmpdir(), `arcane-signature-test-${process.pid}-${crypto.randomBytes(12).toString('hex')}.sock`);
const token = crypto.randomBytes(32).toString('base64url');
const session = crypto.randomBytes(24).toString('base64url');
const publicKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const releaseClaims = {
  securityMode: '',
  contentBinding: '',
  signerThumbprint: '',
  verifiedAt: '',
  revocationStatus: '',
  trustSource: '',
  timestampVerified: false,
};

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const releaseClaimsJson = canonicalJson(releaseClaims);
const releaseClaimsEncoded = Buffer.from(releaseClaimsJson, 'utf8').toString('base64url');
const releaseClaimsSha256 = crypto.createHash('sha256').update(releaseClaimsJson, 'utf8').digest('hex');

function writeFrame(socket, message) {
  const body = Buffer.from(JSON.stringify(message));
  socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

let workerHello = null;
let buffer = Buffer.alloc(0);
let expected = null;
const server = net.createServer((socket) => {
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (expected === null) {
        const marker = buffer.indexOf('\r\n\r\n');
        if (marker < 0) return;
        expected = Number(buffer.subarray(0, marker).toString('ascii').match(/Content-Length:\s*(\d+)/i)?.[1]);
        buffer = buffer.subarray(marker + 4);
      }
      if (buffer.length < expected) return;
      workerHello = JSON.parse(buffer.subarray(0, expected).toString('utf8'));
      buffer = buffer.subarray(expected);
      expected = null;
      writeFrame(socket, {
        protocol: 'arcane/1',
        type: 'broker-hello',
        token,
        brokerSession: session,
        brokerPid: process.pid,
        workerPid: workerHello.pid,
        app: 'provisioner',
        platform,
        version: manifest.version,
        releaseClaimsSha256,
        workerNonce: workerHello.workerNonce,
        requestId: crypto.randomUUID(),
        requestMethod: 'installation.ensure',
        requestSha256: '0'.repeat(64),
        brokerSignature: crypto.randomBytes(64).toString('base64url'),
      });
      return;
    }
  });
});

if (platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => {});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(endpoint, resolve);
});

const worker = spawn(process.execPath, [
  path.join(root, 'runtime/arcane-core.cjs'),
  '--privileged-worker',
  '--simulate',
  `--simulate-platform=${platform}`,
  '--app=provisioner',
  `--bundle-root=${root}`,
  `--ipc=${endpoint}`,
  `--token=${token}`,
  `--broker-pid=${process.pid}`,
  `--broker-session=${session}`,
  `--broker-public-key=${publicKey}`,
  `--release-claims=${releaseClaimsEncoded}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
worker.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const exitCode = await Promise.race([
    new Promise((resolve) => worker.once('exit', resolve)),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Unsigned broker test timed out.')), 15_000); timer.unref(); }),
  ]);
  assert.equal(exitCode, 7);
  assert.ok(workerHello && workerHello.workerNonce && workerHello.pid === worker.pid);
  assert.equal(workerHello.releaseClaimsSha256, releaseClaimsSha256);
  assert.match(stderr, /invalid or unsigned broker identity/i);
  console.log('Arcane privileged worker broker-signature rejection smoke test passed.');
} finally {
  try { worker.kill(); } catch (_) {}
  await new Promise((resolve) => server.close(resolve));
  if (platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => {});
}
