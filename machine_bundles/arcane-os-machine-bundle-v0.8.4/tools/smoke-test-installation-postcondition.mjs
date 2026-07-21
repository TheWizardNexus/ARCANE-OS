import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8');
assert.match(source, /case 'installation\.ensure': \{\s*assertChangesAllowed\(\{ allowIdentityRepair: true \}\)/,
  'the verified installation endpoint must be allowed to repair an invalid installed identity');
assert.match(source, /installedReleaseEntry[\s\S]+candidateReleaseEntry[\s\S]+installedReleaseEntry\.sha256 !== candidateReleaseEntry\.sha256/,
  'equal-version packages with a different verified release must be classified for repair');
const start = source.indexOf('async function ensureArcaneInstallation(action)');
const end = source.indexOf('function validateProvisioningUsername', start);
assert.notEqual(start, -1, 'Core must define ensureArcaneInstallation');
assert.notEqual(end, -1, 'Core must retain the ensure function test boundary');
const ensureSource = source.slice(start, end);

function currentInstallation(overrides = {}) {
  return {
    present: true,
    installedVersion: '0.8.2',
    packageVersion: '0.8.2',
    blocked: false,
    blockedReason: null,
    repairRequired: false,
    repairReason: null,
    disposition: 'current',
    action: 'current',
    installedIntegrity: { ok: true, checkedFiles: 3, reason: null },
    installedIdentity: { ok: true, version: '0.8.2', reason: null },
    payloadRepairRequired: false,
    payload: { mode: 'windows-webview2', releaseReady: true },
    manifest: { version: '0.8.2' },
    ...overrides,
  };
}

async function runEnsure({ states, requirements, installResult = { version: '0.8.2' } }) {
  const queue = states.map((state) => structuredClone(state));
  let installs = 0;
  let modelEnsures = 0;
  const context = vm.createContext({
    VERSION: '0.8.2',
    installationState() {
      assert(queue.length, 'ensure requested an unexpected installation state');
      return queue.shift();
    },
    async ensureRequirements() {},
    async ensureManagedArcaneModel() { modelEnsures += 1; return { model: 'arcane:latest', created: false, modelsRoot: 'simulated' }; },
    checkRequirements() { return structuredClone(requirements); },
    async installArcaneGlobally() { installs += 1; return structuredClone(installResult); },
    actionStep() {},
    actionLog() {},
    arcaneError(code, message, resolution, status, details) {
      return Object.assign(new Error(message), { code, resolution, status, details });
    },
  });
  vm.runInContext(ensureSource, context, { filename: 'ensure-installation.test.cjs' });
  return {
    promise: context.ensureArcaneInstallation({ id: 'postcondition-test' }),
    installs: () => installs,
    modelEnsures: () => modelEnsures,
    remaining: () => queue.length,
  };
}

{
  const ready = currentInstallation();
  const test = await runEnsure({
    states: [ready, ready, ready],
    requirements: [
      { id: 'required', required: true, status: 'ready' },
      { id: 'optional', required: false, status: 'optional-missing' },
    ],
  });
  const result = await test.promise;
  assert.equal(result.installation.disposition, 'current');
  assert.equal(result.installation.action, 'current');
  assert.equal(result.requirements.length, 2);
  assert.equal(test.installs(), 0, 'a healthy equal-version install must not be replaced');
  assert.equal(test.modelEnsures(), 1, 'Microsoft NT-compatible readiness must preserve managed-model setup');
  assert.equal(test.remaining(), 0);
}

{
  const ready = currentInstallation({ payload: { mode: 'linux-webkitgtk', releaseReady: true } });
  const test = await runEnsure({
    states: [ready, ready, ready],
    requirements: [
      { id: 'ollama', required: false, status: 'missing' },
      { id: 'renderer', required: true, status: 'ready' },
      { id: 'session-control', required: true, status: 'ready' },
    ],
  });
  const result = await test.promise;
  assert.equal(result.installation.disposition, 'current');
  assert.equal(result.model.status, 'deferred');
  assert.equal(result.model.reason, 'ollama-not-ready');
  assert.equal(result.model.requiredBefore, 'local-ai');
  assert.equal(test.modelEnsures(), 0,
    'base Linux installation must not start managed-model setup while optional Ollama is unavailable');
}

{
  const ready = currentInstallation({ payload: { mode: 'linux-webkitgtk', releaseReady: true } });
  const test = await runEnsure({
    states: [ready, ready, ready],
    requirements: [
      { id: 'ollama', required: false, status: 'ready' },
      { id: 'renderer', required: true, status: 'ready' },
      { id: 'session-control', required: true, status: 'ready' },
    ],
  });
  const result = await test.promise;
  assert.equal(result.model.status, 'deferred');
  assert.equal(result.model.reason, 'base-install-local-ai-decoupled');
  assert.equal(test.modelEnsures(), 0,
    'base Linux installation must remain independent of model download/build work even when Ollama is healthy');
}

{
  const repair = currentInstallation({
    installedIdentity: { ok: false, version: '0.8.2', reason: 'unreadable installed tree' },
    installedIntegrity: { ok: false, checkedFiles: 0, reason: 'access denied' },
    repairRequired: true,
    repairReason: 'identity-invalid',
    disposition: 'repair-required',
    action: 'repair',
  });
  const ready = currentInstallation();
  const test = await runEnsure({
    states: [repair, repair, ready],
    requirements: [{ id: 'required', required: true, status: 'ready' }],
  });
  const result = await test.promise;
  assert.equal(result.installation.disposition, 'current');
  assert.equal(test.installs(), 1, 'identity-invalid installation must be repaired from the verified release');
}

{
  const installing = currentInstallation({ present: false, installedVersion: null, disposition: 'missing', action: 'install' });
  const failedFinal = currentInstallation({
    installedIdentity: { ok: false, version: '0.8.2', reason: 'post-install identity failure' },
    installedIntegrity: { ok: false, checkedFiles: 0, reason: 'post-install access denied' },
    repairRequired: true,
    repairReason: 'identity-invalid',
    disposition: 'repair-required',
    action: 'repair',
  });
  const test = await runEnsure({
    states: [installing, installing, failedFinal],
    requirements: [{ id: 'required', required: true, status: 'ready' }],
  });
  await assert.rejects(test.promise, (error) => {
    assert.equal(error.code, 'INSTALL_POSTCONDITION_FAILED');
    assert.equal(error.status, 500);
    assert.equal(error.details.installation.repairReason, 'identity-invalid');
    return true;
  });
  assert.equal(test.installs(), 1);
}

{
  const ready = currentInstallation();
  const test = await runEnsure({
    states: [ready, ready, ready],
    requirements: [{ id: 'renderer', required: true, status: 'blocked' }],
  });
  await assert.rejects(test.promise, (error) => {
    assert.equal(error.code, 'INSTALL_POSTCONDITION_FAILED');
    assert.equal(error.details.failedRequirements.length, 1);
    assert.equal(error.details.failedRequirements[0].id, 'renderer');
    return true;
  });
}

{
  const downgrade = currentInstallation({
    installedVersion: '0.9.0',
    blocked: true,
    blockedReason: 'downgrade',
    disposition: 'downgrade-blocked',
    action: 'blocked',
  });
  const test = await runEnsure({
    states: [downgrade],
    requirements: [],
  });
  await assert.rejects(test.promise, (error) => error && error.code === 'DOWNGRADE_BLOCKED');
  assert.equal(test.installs(), 0);
}

console.log('Arcane installation postcondition smoke test passed.');
