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
  ? `\\\\.\\pipe\\arcane-encryption-test-${process.pid}-${crypto.randomBytes(12).toString('hex')}`
  : path.join(os.tmpdir(), `arcane-encryption-test-${process.pid}-${crypto.randomBytes(12).toString('hex')}.sock`);
const token = crypto.randomBytes(32).toString('base64url');
const session = crypto.randomBytes(24).toString('base64url');
const signingKeys = crypto.generateKeyPairSync('ed25519');
const signingPublicKey = signingKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const exchangeKeys = crypto.generateKeyPairSync('x25519');
const exchangePublicKey = exchangeKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const request = { protocol: 'arcane/1', type: 'request', id: crypto.randomUUID(), method: 'users.add', parameters: { usernames: ['arcane-wire-test'] } };
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
function sha(value) { return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
const releaseClaimsEncoded = Buffer.from(canonicalJson(releaseClaims), 'utf8').toString('base64url');
const releaseClaimsSha256 = sha(releaseClaims);
function writeFrame(socket, message) {
  const body = Buffer.from(JSON.stringify(message));
  socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}
function channel(privateKey, peerText, context) {
  const peer = crypto.createPublicKey({ key: Buffer.from(peerText, 'base64url'), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey, publicKey: peer });
  const salt = crypto.createHash('sha256').update(canonicalJson(context), 'utf8').digest();
  const derive = (direction) => Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(`arcane-privilege-channel-v1:${direction}`), 32));
  return { brokerToWorkerKey: derive('broker-to-worker'), workerToBrokerKey: derive('worker-to-broker') };
}
function iv(direction, sequence) {
  const value = Buffer.alloc(12);
  value.writeUInt32BE(direction === 'broker-to-worker' ? 0x41524231 : 0x41525731, 0);
  value.writeBigUInt64BE(BigInt(sequence), 4);
  return value;
}
function aad(direction, sequence, context) {
  return Buffer.from(canonicalJson({ protocol: 'arcane/1', type: 'secure', direction, sequence, ...context }));
}
function encrypt(key, direction, sequence, context, message) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv(direction, sequence), { authTagLength: 16 });
  cipher.setAAD(aad(direction, sequence, context));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(message))), cipher.final()]);
  return { protocol: 'arcane/1', type: 'secure', direction, sequence, ciphertext: ciphertext.toString('base64url'), authTag: cipher.getAuthTag().toString('base64url') };
}
function decrypt(key, direction, sequence, context, envelope) {
  const authTagText = String(envelope.authTag || '');
  if (!/^[A-Za-z0-9_-]{22}$/.test(authTagText)) throw new Error('exact 16-byte authentication tag required');
  const authTag = Buffer.from(authTagText, 'base64url');
  if (authTag.length !== 16 || authTag.toString('base64url') !== authTagText) throw new Error('exact 16-byte authentication tag required');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv(direction, sequence), { authTagLength: 16 });
  decipher.setAAD(aad(direction, sequence, context));
  decipher.setAuthTag(authTag);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}

let worker;
let socket;
let buffer = Buffer.alloc(0);
let expected = null;
let secureChannel;
let channelContext;
let receiveSequence = 0;
const wireFrames = [];
const plaintextFrames = [];
let resolveResponse;
let rejectResponse;
const responseReceived = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });

const server = net.createServer((incoming) => {
  socket = incoming;
  incoming.on('error', rejectResponse);
  incoming.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (expected === null) {
        const marker = buffer.indexOf('\r\n\r\n');
        if (marker < 0) return;
        expected = Number(buffer.subarray(0, marker).toString('ascii').match(/Content-Length:\s*(\d+)/i)?.[1]);
        buffer = buffer.subarray(marker + 4);
      }
      if (buffer.length < expected) return;
      const raw = buffer.subarray(0, expected).toString('utf8');
      const frame = JSON.parse(raw);
      buffer = buffer.subarray(expected);
      expected = null;
      wireFrames.push(raw);
      if (frame.type === 'hello') {
        assert.equal(frame.releaseClaimsSha256, releaseClaimsSha256);
        channelContext = {
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
        secureChannel = channel(exchangeKeys.privateKey, frame.workerExchangePublicKey, channelContext);
        const requestSha256 = sha(request);
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
          requestSha256,
          brokerExchangePublicKey: exchangePublicKey,
          workerExchangePublicKey: frame.workerExchangePublicKey,
        };
        writeFrame(incoming, {
          protocol: 'arcane/1', type: 'broker-hello', token, brokerSession: session, brokerPid: process.pid, workerPid: frame.pid,
          app: 'provisioner', platform, version: manifest.version, workerNonce: frame.workerNonce,
          releaseClaimsSha256,
          requestId: request.id, requestMethod: request.method, requestSha256,
          brokerExchangePublicKey: exchangePublicKey, workerExchangePublicKey: frame.workerExchangePublicKey,
          brokerSignature: crypto.sign(null, Buffer.from(canonicalJson(binding)), signingKeys.privateKey).toString('base64url'),
        });
        writeFrame(incoming, encrypt(secureChannel.brokerToWorkerKey, 'broker-to-worker', 0, channelContext, request));
      } else {
        assert.equal(frame.type, 'secure');
        const plaintext = decrypt(secureChannel.workerToBrokerKey, 'worker-to-broker', receiveSequence++, channelContext, frame);
        plaintextFrames.push({ envelope: frame, plaintext });
        if (plaintext.type === 'response' && plaintext.id === request.id) resolveResponse(plaintext);
      }
    }
  });
});

if (platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => {});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
worker = spawn(process.execPath, [
  path.join(root, 'runtime/arcane-core.cjs'), '--privileged-worker', '--simulate', `--simulate-platform=${platform}`,
  '--app=provisioner', `--bundle-root=${root}`, `--ipc=${endpoint}`, `--token=${token}`,
  `--broker-pid=${process.pid}`, `--broker-session=${session}`, `--broker-public-key=${signingPublicKey}`,
  `--release-claims=${releaseClaimsEncoded}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
worker.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const response = await Promise.race([responseReceived, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Encrypted broker response timed out. ${stderr}`)), 20_000); timer.unref(); })]);
  assert.equal(response.ok, true);
  const credential = response.result.credentials.find((item) => item.username === 'arcane-wire-test');
  assert.ok(credential && credential.temporaryPassword && credential.activationRequired);
  const capturedWire = wireFrames.slice(1).join('\n');
  assert.ok(wireFrames.slice(1).every((raw) => JSON.parse(raw).type === 'secure'));
  assert.equal(capturedWire.includes(credential.temporaryPassword), false, 'a relay must not observe the temporary password');
  assert.equal(capturedWire.includes('temporaryPassword'), false, 'a relay must not observe response field names');

  const responseRecord = plaintextFrames.find((item) => item.plaintext.type === 'response');
  const tampered = { ...responseRecord.envelope };
  const bytes = Buffer.from(tampered.ciphertext, 'base64url');
  bytes[0] ^= 1;
  tampered.ciphertext = bytes.toString('base64url');
  assert.throws(
    () => decrypt(secureChannel.workerToBrokerKey, 'worker-to-broker', tampered.sequence, channelContext, tampered),
    /authenticate|Unsupported state/i,
    'a relay-modified response must fail authentication',
  );
  console.log('Arcane privilege-channel relay confidentiality and authentication smoke test passed.');
} finally {
  try { worker.kill(); } catch (_) {}
  try { socket?.destroy(); } catch (_) {}
  await new Promise((resolve) => server.close(resolve));
  if (platform !== 'win32') await fs.rm(endpoint, { force: true }).catch(() => {});
}
