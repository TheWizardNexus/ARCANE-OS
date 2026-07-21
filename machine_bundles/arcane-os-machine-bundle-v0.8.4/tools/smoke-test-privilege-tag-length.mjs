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
  ? `\\\\.\\pipe\\arcane-tag-test-${process.pid}-${crypto.randomBytes(12).toString('hex')}`
  : path.join(os.tmpdir(), `arcane-tag-test-${process.pid}-${crypto.randomBytes(12).toString('hex')}.sock`);
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
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function requestHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
const releaseClaimsEncoded = Buffer.from(canonicalJson(releaseClaims), 'utf8').toString('base64url');
const releaseClaimsSha256 = requestHash(releaseClaims);
function writeFrame(socket, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}
function frameIv(direction, sequence) {
  const value = Buffer.alloc(12);
  value.writeUInt32BE(direction === 'broker-to-worker' ? 0x41524231 : 0x41525731, 0);
  value.writeBigUInt64BE(BigInt(sequence), 4);
  return value;
}
function deriveKey(privateKey, peerText, context) {
  const peer = crypto.createPublicKey({ key: Buffer.from(peerText, 'base64url'), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey, publicKey: peer });
  const salt = crypto.createHash('sha256').update(canonicalJson(context), 'utf8').digest();
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('arcane-privilege-channel-v1:broker-to-worker'), 32));
}
function truncatedEnvelope(key, context) {
  const direction = 'broker-to-worker';
  const sequence = 0;
  const aad = Buffer.from(canonicalJson({ protocol: 'arcane/1', type: 'secure', direction, sequence, ...context }), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, frameIv(direction, sequence), { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(request), 'utf8')), cipher.final()]);
  const truncatedTag = cipher.getAuthTag().subarray(0, 12);
  assert.equal(truncatedTag.length, 12);
  return {
    protocol: 'arcane/1',
    type: 'secure',
    direction,
    sequence,
    ciphertext: ciphertext.toString('base64url'),
    authTag: truncatedTag.toString('base64url'),
  };
}

let worker = null;
let workerSocket = null;
let stderr = '';
let resolveSent;
let rejectSent;
const truncatedFrameSent = new Promise((resolve, reject) => { resolveSent = resolve; rejectSent = reject; });
const server = net.createServer((socket) => {
  workerSocket = socket;
  let buffer = Buffer.alloc(0);
  let expected = null;
  socket.on('error', rejectSent);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (expected === null) {
        const marker = buffer.indexOf('\r\n\r\n');
        if (marker < 0) return;
        const match = buffer.subarray(0, marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);
        if (!match) return rejectSent(new Error('Worker emitted an invalid frame header.'));
        expected = Number(match[1]);
        buffer = buffer.subarray(marker + 4);
      }
      if (buffer.length < expected) return;
      const frame = JSON.parse(buffer.subarray(0, expected).toString('utf8'));
      buffer = buffer.subarray(expected);
      expected = null;
      if (frame.type !== 'hello') continue;
      assert.equal(frame.releaseClaimsSha256, releaseClaimsSha256);

      const context = {
        brokerSession: session,
        brokerPid: process.pid,
        workerPid: frame.pid,
        app: 'provisioner',
        platform,
        version: manifest.version,
        releaseClaimsSha256,
        brokerExchangePublicKey: exchangePublicKey,
        workerExchangePublicKey: frame.workerExchangePublicKey,
      };
      const hash = requestHash(request);
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
        releaseClaimsSha256,
        requestId: request.id,
        requestMethod: request.method,
        requestSha256: hash,
        brokerExchangePublicKey: exchangePublicKey,
        workerExchangePublicKey: frame.workerExchangePublicKey,
      };
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
        releaseClaimsSha256,
        workerNonce: frame.workerNonce,
        requestId: request.id,
        requestMethod: request.method,
        requestSha256: hash,
        brokerExchangePublicKey: exchangePublicKey,
        workerExchangePublicKey: frame.workerExchangePublicKey,
        brokerSignature: crypto.sign(null, Buffer.from(canonicalJson(binding)), signingKeys.privateKey).toString('base64url'),
      });
      writeFrame(socket, truncatedEnvelope(deriveKey(exchangeKeys.privateKey, frame.workerExchangePublicKey, context), context));
      resolveSent();
    }
  });
});

if (platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => {});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
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

try {
  await Promise.race([
    truncatedFrameSent,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out sending truncated tag. ${stderr}`)), 15000)),
  ]);
  const exitCode = await Promise.race([
    new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Worker accepted a truncated GCM tag. ${stderr}`)), 15000)),
  ]);
  assert.equal(exitCode, 7);
  assert.match(stderr, /exact 16-byte authentication tag/i);
  console.log('Arcane privileged worker rejected a truncated AES-GCM authentication tag.');
} finally {
  try { worker?.kill(); } catch { }
  try { workerSocket?.destroy(); } catch { }
  await new Promise((resolve) => server.close(resolve));
  if (platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => {});
}
