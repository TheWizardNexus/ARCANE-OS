import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src', 'frontend', 'provisioner', 'index.html'), 'utf8');
const coreSource = fs.readFileSync(path.join(root, 'src', 'core', 'arcane-core.template.cjs'), 'utf8');
assert.match(source,/id="securityBanner"/,'the Provisioner must reserve a visible release-trust warning');
assert.match(source,/securityMode !== 'publisher-verified'/,'only publisher verification may hide the Provisioner warning');
assert.match(source,/Unsigned local-test mode is active/);
assert.doesNotMatch(source,/automatically install or update every required dependency|Repair Arcane requirements|installation and dependencies are ready/);
assert.match(coreSource, /'users\.restoreShell': Object\.freeze\(\{ capability:'users\.manage', appTypes:\['provisioner'\], privileged:true/,
  'deferred restore must still cross the privileged worker boundary');
assert.match(coreSource, /if \(target && !target\.shellAssigned && !preparedRecovery\)[\s\S]*?SHELL_CHANGED_EXTERNALLY/,
  'the elevated restore must fail closed when native discovery does not verify the assigned shell');

function functionSource(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `Missing ${start}`);
  assert.notEqual(to, -1, `Missing boundary ${end}`);
  return source.slice(from, to);
}

function coreFunctionSource(start, end) {
  const from = coreSource.indexOf(start);
  const to = coreSource.indexOf(end, from);
  assert.notEqual(from, -1, `Missing Core ${start}`);
  assert.notEqual(to, -1, `Missing Core boundary ${end}`);
  return coreSource.slice(from, to);
}

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    const classes = new Set();
    elements.set(id, {
      style: { display: '' },
      textContent: '',
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, force) => {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force);
          if (enabled) classes.add(name); else classes.delete(name);
          return enabled;
        },
        contains: (name) => classes.has(name),
      },
      className: '',
      disabled: false,
    });
  }
  return elements.get(id);
}

const calls = { activate: [], applyPassword: [] };
const failures = { activate: new Set(), applyPassword: new Set() };
const context = vm.createContext({
  console,
  String,
  state: {
    credentials: [],
    pendingActivations: [],
    pendingPasswordApplications: [],
  },
  $: (selector) => element(selector.replace(/^#/, '')),
  hideError() {},
  setBusy() {},
  showUserSuccess() {},
  requirementReady() { return true; },
  renderRequirements() {},
  async showError() {},
  async refreshUsers() {},
  Arcane: {
    users: {
      async activate(username) {
        calls.activate.push(username);
        if (failures.activate.delete(username)) throw new Error(`activation failed for ${username}`);
      },
      async applyPassword(username) {
        calls.applyPassword.push(username);
        if (failures.applyPassword.delete(username)) throw new Error(`password apply failed for ${username}`);
      },
    },
  },
});

vm.runInContext([
  functionSource('function installReady()', 'function renderMachine'),
  functionSource('function renderMachine(machine)', 'function renderControls'),
  functionSource('function renderControls()', 'function addUserRow'),
  functionSource('function renderCredentials(credentials)', 'function showUserSuccess'),
  functionSource('function restoreShellPresentation(user)', 'function renderUsers'),
  functionSource('async function activatePendingAccounts()', 'async function resetPassword'),
  functionSource('async function applyPendingPasswords()', 'async function restoreShell'),
].join('\n'), context);

const machineFixture = {
  version: '0.8.2',
  os: { displayName: 'Windows', architecture: 'x64' },
  permissions: { elevated: false, level: 'standard', mechanism: 'UAC' },
  protectedUsernames: ['codex'],
  usernamePolicy: { description: 'Use a standard Windows account name.' },
  requirements: [],
  simulation: false,
  installation: {
    present: false,
    blocked: false,
    installedVersion: null,
    packageVersion: '0.8.2',
    action: 'install',
    payloadRepairRequired: false,
    payload: { releaseReady: true },
  },
};
context.machineFixture = machineFixture;
for (const securityMode of ['publisher-verified', 'unsigned-local-test', 'unverified']) {
  context.machineFixture = { ...machineFixture, securityMode };
  vm.runInContext('renderMachine(machineFixture)', context);
  const warningVisible = element('securityBanner').classList.contains('visible');
  assert.equal(warningVisible, securityMode !== 'publisher-verified');
  assert.equal(element('installArcaneButton').disabled, securityMode === 'unverified');
  assert.equal(element('createUsersButton').disabled, securityMode === 'unverified');
  if (securityMode === 'unsigned-local-test') {
    assert.equal(element('securityTitle').textContent, 'Unsigned local-test mode is active');
    assert.match(element('securityText').textContent, /controlled local acceptance testing/);
    assert.match(element('versionPill').textContent, /local test/);
  }
  if (securityMode === 'unverified') {
    assert.match(element('securityText').textContent, /Machine-changing actions remain unavailable/);
    assert.match(element('userReadiness').textContent, /will not make machine changes/);
  }
}
context.machineFixture = { ...machineFixture, securityMode: 'unverified', simulation: true };
vm.runInContext('renderMachine(machineFixture)', context);
assert.equal(element('securityBanner').classList.contains('visible'), true);
assert.equal(element('securityTitle').textContent, 'Simulation mode is active');
assert.match(element('securityText').textContent, /cannot change Windows accounts/);
assert.equal(element('installArcaneButton').disabled, false);
assert.equal(element('createUsersButton').disabled, false);

const deferredPresentation = context.restoreShellPresentation({
  restoreRequiresElevatedVerification: true,
  previousShellPresent: false,
  previousShell: null,
});
assert.equal(deferredPresentation.deferredVerification, true);
assert.equal(deferredPresentation.buttonText, 'Verify and restore previous shell');
assert.match(deferredPresentation.note, /reload the signed-out profile and recheck both exact Windows shell bindings/);
assert.match(source, /restoreButton\.disabled = state\.busy;/, 'a trusted deferred restore affordance must remain actionable');

const recoveryContext = vm.createContext({});
vm.runInContext(coreFunctionSource('function arcaneUserRestoreStatus(user, record)', 'async function listArcaneUsers'), recoveryContext);
const activeOffline = recoveryContext.arcaneUserRestoreStatus(
  { shellAssigned: false, verification: 'recorded-only' },
  { previousShellCaptured: true, shellMutationPhase: 'assigned', accountMutationPhase: 'active', accountExistedBefore: false },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(activeOffline)),
  { canRestoreShell: true, restoreRequiresElevatedVerification: true },
  'a signed-out active Arcane user must retain a restore affordance backed by the protected journal',
);
const stagedOffline = recoveryContext.arcaneUserRestoreStatus(
  { shellAssigned: false, verification: 'recorded-only' },
  { previousShellCaptured: true, shellMutationPhase: 'assigned', accountMutationPhase: 'activation-pending', accountExistedBefore: false },
);
assert.equal(stagedOffline.canRestoreShell, false, 'a disabled staged account must not expose shell-only recovery');
const unverifiedWithoutJournal = recoveryContext.arcaneUserRestoreStatus(
  { shellAssigned: false, verification: 'recorded-only' },
  null,
);
assert.equal(unverifiedWithoutJournal.canRestoreShell, false, 'recorded-only discovery without a protected recovery record must remain fail closed');

context.state.credentials = [
  { username: 'arcane-one', temporaryPassword: 'one', activationRequired: true },
  { username: 'arcane-two', temporaryPassword: 'two', activationRequired: true },
];
vm.runInContext('renderCredentials(state.credentials)', context);
failures.activate.add('arcane-two');
await vm.runInContext('activatePendingAccounts()', context);
assert.deepEqual(calls.activate, ['arcane-one', 'arcane-two']);
assert.deepEqual(context.state.pendingActivations, ['arcane-two']);
assert.equal(context.state.credentials[0].activationRequired, false);
assert.equal(context.state.credentials[1].activationRequired, true);
assert.equal(element('credentials').classList.contains('visible'), true);
assert.equal(element('activateCredentials').style.display, '');

await vm.runInContext('activatePendingAccounts()', context);
assert.deepEqual(calls.activate, ['arcane-one', 'arcane-two', 'arcane-two']);
assert.deepEqual(context.state.pendingActivations, []);
assert.equal(context.state.credentials.every((item) => item.activationRequired === false), true);
assert.equal(element('credentials').classList.contains('visible'), true);
assert.equal(element('activateCredentials').style.display, 'none');

context.state.credentials = [
  { username: 'arcane-one', temporaryPassword: 'one', applyPasswordRequired: true },
  { username: 'arcane-two', temporaryPassword: 'two', applyPasswordRequired: true },
];
vm.runInContext('renderCredentials(state.credentials)', context);
failures.applyPassword.add('arcane-two');
await vm.runInContext('applyPendingPasswords()', context);
assert.deepEqual(calls.applyPassword, ['arcane-one', 'arcane-two']);
assert.deepEqual(context.state.pendingPasswordApplications.map((item) => item.username), ['arcane-two']);
assert.equal(context.state.credentials[0].applyPasswordRequired, false);
assert.equal(context.state.credentials[1].applyPasswordRequired, true);
assert.equal(element('credentials').classList.contains('visible'), true);
assert.equal(element('applyPasswordCredentials').style.display, '');

await vm.runInContext('applyPendingPasswords()', context);
assert.deepEqual(calls.applyPassword, ['arcane-one', 'arcane-two', 'arcane-two']);
assert.deepEqual(context.state.pendingPasswordApplications, []);
assert.equal(context.state.credentials.every((item) => item.applyPasswordRequired === false), true);
assert.equal(element('credentials').classList.contains('visible'), true);
assert.equal(element('applyPasswordCredentials').style.display, 'none');

console.log('Arcane provisioner partial multi-user retry smoke test passed.');
