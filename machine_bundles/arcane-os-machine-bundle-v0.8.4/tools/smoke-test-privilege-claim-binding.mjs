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
  ? `\\\\.\\pipe\\arcane-claim-binding-test-${process.pid}-${crypto.randomBytes(12).toString('hex')}`
  : path.join(os.tmpdir(), `arcane-claim-binding-test-${process.pid}-${crypto.randomBytes(12).toString('hex')}.sock`);
const token = crypto.randomBytes(32).toString('base64url');
const session = crypto.randomBytes(24).toString('base64url');
const signingKeys = crypto.generateKeyPairSync('ed25519');
const signingPublicKey = signingKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const exchangeKeys = crypto.generateKeyPairSync('x25519');
const exchangePublicKey = exchangeKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const request = {
  protocol: 'arcane/1',
  type: 'request',
  id: crypto.randomUUID(),
  method: 'installation.ensure',
  parameters: {},
};
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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function writeFrame(socket, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}

const releaseClaimsEncoded = Buffer.from(canonicalJson(releaseClaims), 'utf8').toString('base64url');
const releaseClaimsSha256 = sha256(releaseClaims);
const differentReleaseClaimsSha256 = crypto.createHash('sha256')
  .update(`different-${releaseClaimsSha256}`, 'utf8')
  .digest('hex');
assert.notEqual(differentReleaseClaimsSha256, releaseClaimsSha256);

let worker = null;
let workerSocket = null;
let stderr = '';
let resolveBrokerHelloSent;
let rejectBrokerHelloSent;
const brokerHelloSent = new Promise((resolve, reject) => {
  resolveBrokerHelloSent = resolve;
  rejectBrokerHelloSent = reject;
});

const server = net.createServer((socket) => {
  workerSocket = socket;
  let buffer = Buffer.alloc(0);
  let expected = null;
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (expected === null) {
          const marker = buffer.indexOf('\r\n\r\n');
          if (marker < 0) return;
          const match = buffer.subarray(0, marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);
          if (!match) throw new Error('Worker emitted an invalid frame header.');
          expected = Number(match[1]);
          buffer = buffer.subarray(marker + 4);
        }
        if (buffer.length < expected) return;
        const frame = JSON.parse(buffer.subarray(0, expected).toString('utf8'));
        buffer = buffer.subarray(expected);
        expected = null;
        if (frame.type !== 'hello') continue;

        assert.equal(frame.releaseClaimsSha256, releaseClaimsSha256);
        const requestSha256 = sha256(request);
        const binding = {
          protocol: 'arcane/1',
          type: 'arcane-privilege-binding-v1',
          brokerSession: session,
          brokerPid: process.pid,
          workerPid: frame.pid,
          workerNonce: frame.workerNonce,
          app: 'provisioner',
          platform,
          version: manifest.version,
          releaseClaimsSha256: differentReleaseClaimsSha256,
          requestId: request.id,
          requestMethod: request.method,
          requestSha256,
          brokerExchangePublicKey: exchangePublicKey,
          workerExchangePublicKey: frame.workerExchangePublicKey,
        };
        const brokerSignature = crypto.sign(
          null,
          Buffer.from(canonicalJson(binding), 'utf8'),
          signingKeys.privateKey,
        ).toString('base64url');
        assert.equal(
          crypto.verify(
            null,
            Buffer.from(canonicalJson(binding), 'utf8'),
            signingKeys.publicKey,
            Buffer.from(brokerSignature, 'base64url'),
          ),
          true,
          'the negative fixture must carry a valid signature over its mismatched binding',
        );
        writeFrame(socket, {
          protocol: 'arcane/1',
          type: 'broker-hello',
          token,
          brokerSession: session,
          brokerPid: process.pid,
          workerPid: frame.pid,
          app: 'provisioner',
          platform,
          version: manifest.version,
          releaseClaimsSha256: differentReleaseClaimsSha256,
          workerNonce: frame.workerNonce,
          requestId: request.id,
          requestMethod: request.method,
          requestSha256,
          brokerExchangePublicKey: exchangePublicKey,
          workerExchangePublicKey: frame.workerExchangePublicKey,
          brokerSignature,
        });
        resolveBrokerHelloSent();
        return;
      }
    } catch (error) {
      rejectBrokerHelloSent(error);
    }
  });
});

if (platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => {});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(endpoint, resolve);
});

worker = spawn(process.execPath, [
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
  `--broker-public-key=${signingPublicKey}`,
  `--release-claims=${releaseClaimsEncoded}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
worker.stderr.setEncoding('utf8');
worker.stderr.on('data', (chunk) => { stderr += chunk; });
const workerExit = new Promise((resolve, reject) => {
  worker.once('error', reject);
  worker.once('exit', resolve);
});

try {
  await Promise.race([
    brokerHelloSent,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out sending the mismatched release-claim binding. ${stderr}`)), 15_000);
      timer.unref();
    }),
  ]);
  const exitCode = await Promise.race([
    workerExit,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker accepted a mismatched release-claim binding. ${stderr}`)), 15_000);
      timer.unref();
    }),
  ]);
  assert.equal(exitCode, 7);
  assert.match(stderr, /invalid or unsigned broker identity/i);
  console.log('Arcane privileged worker rejected a validly signed broker binding with mismatched release claims.');
} finally {
  try { worker?.kill(); } catch { }
  try { workerSocket?.destroy(); } catch { }
  await new Promise((resolve) => server.close(resolve));
  if (platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => {});
}
