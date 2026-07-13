import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSource = await fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8');
const claimsStart = coreSource.indexOf('const WORKER_RELEASE_CLAIM_KEYS');
const claimsEnd = coreSource.indexOf('const hostReleaseClaims = validatedHostReleaseClaims();');
assert(claimsStart >= 0 && claimsEnd > claimsStart, 'release-claim parser source was not found');
const claimsSource = coreSource.slice(claimsStart, claimsEnd);

const unsignedClaims = Object.freeze({
  securityMode: 'unsigned-local-test',
  contentBinding: '',
  signerThumbprint: '',
  verifiedAt: '',
  revocationStatus: '',
  trustSource: '',
  timestampVerified: false,
});

function encodeClaims(claims) {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

function evaluateClaims({
  privilegedWorker = true,
  claimArguments = [`--release-claims=${encodeClaims(unsignedClaims)}`],
  allowUnsignedLocalRelease = true,
  environment = {},
} = {}) {
  const sandbox = {
    Buffer,
    privilegedWorker,
    workerReleaseClaimArguments: claimArguments,
    allowUnsignedLocalRelease,
    productionPackaged: false,
    platform: 'win32',
    process: { env: environment },
  };
  vm.runInNewContext(
    `${claimsSource}\n`
      + 'globalThis.parsedClaims = parseWorkerReleaseClaims();\n'
      + 'globalThis.validatedClaims = validatedHostReleaseClaims();',
    sandbox,
    { filename: 'arcane-worker-release-claims.cjs' },
  );
  return {
    parsed: structuredClone(sandbox.parsedClaims),
    validated: structuredClone(sandbox.validatedClaims),
  };
}

test('privileged worker accepts one exact explicit unsigned-local claim without environment forwarding', () => {
  const result = evaluateClaims({ environment: {} });
  assert.deepEqual(result.parsed, unsignedClaims);
  assert.deepEqual(result.validated, {
    mode: 'unsigned-local-test',
    contentBinding: '',
    signerThumbprint: '',
    verifiedAt: '',
    revocationStatus: '',
    trustSource: '',
    timestampVerified: false,
  });
});

test('privileged worker fails closed when explicit release claims are missing or duplicated', () => {
  assert.throws(
    () => evaluateClaims({ claimArguments: [] }),
    /requires exactly one release-claim argument/,
  );
  const encoded = encodeClaims(unsignedClaims);
  assert.throws(
    () => evaluateClaims({ claimArguments: [`--release-claims=${encoded}`, `--release-claims=${encoded}`] }),
    /requires exactly one release-claim argument/,
  );
});

test('privileged worker rejects malformed, incomplete, and extended claim documents', () => {
  assert.throws(
    () => evaluateClaims({ claimArguments: ['--release-claims=not-base64url!'] }),
    /malformed release claims/,
  );
  assert.throws(
    () => evaluateClaims({
      claimArguments: [`--release-claims=${encodeClaims({ ...unsignedClaims, trustSource: undefined })}`],
    }),
    /invalid release-claim document/,
  );
  assert.throws(
    () => evaluateClaims({
      claimArguments: [`--release-claims=${encodeClaims({ ...unsignedClaims, unexpected: 'claim' })}`],
    }),
    /invalid release-claim document/,
  );
});

test('standard broker rejects worker-only release-claim arguments', () => {
  assert.throws(
    () => evaluateClaims({ privilegedWorker: false }),
    /accepts release-claim arguments only for a privileged worker/,
  );
});
