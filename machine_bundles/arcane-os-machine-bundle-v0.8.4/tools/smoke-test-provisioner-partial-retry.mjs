import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src', 'frontend', 'provisioner', 'index.html'), 'utf8');
const sharedApiSource = fs.readFileSync(path.join(root, 'src', 'frontend', 'shared', 'arcane-api.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(root, 'src', 'core', 'arcane-core.template.cjs'), 'utf8');
const linuxNativeSource = fs.readFileSync(path.join(root, 'src', 'native', 'linux.cjs'), 'utf8');
const methodPoliciesSource = fs.readFileSync(path.join(root, 'src', 'api', 'method-policies.json'), 'utf8');
const platformPresentationSource = fs.readFileSync(path.resolve(root, '../../arcane/modules/SystemPlatformPresentation.js'), 'utf8');
assert.match(source,/id="securityBanner"/,'the Provisioner must reserve a visible release-trust warning');
assert.match(source,/id="accessBanner"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/,
  'the dynamic permission banner must announce platform-specific access status');
assert.match(source,/id="accessTitle"/);
assert.match(source,/id="accessText"/);
assert.match(source,/id="linuxInstallDisclosure"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*hidden/,
  'fresh Linux installation consequences must be exposed as one accessible status');
assert.match(source,/id="linuxInstallDisclosureTitle"/);
assert.match(source,/id="linuxInstallDisclosureText"/);
assert.match(source,/if \(!confirmFreshLinuxInstallation\(\)\) return;[\s\S]*?Arcane\.installation\.ensure\(\)/,
  'fresh Linux installation must be confirmed before starting any machine-changing request');
assert.match(linuxNativeSource,/sessionType: isWindowsSubsystemForLinux\(\) \? 'wslg' : \(process\.env\.XDG_SESSION_TYPE \|\| null\)/,
  'real WSL status must identify WSLg through the existing platform sessionType field');
assert.match(source,/<script src="\.\.\/shared\/SystemPlatformPresentation\.js"><\/script>/,
  'native interfaces must load the shared system-platform presentation helper');
assert.match(source,/id="operationNotice"[\s\S]*?<progress id="operationNoticeProgress"/,
  'long Arcane operations must spawn an accessible progress notification');
assert.match(source,/updateOperationNotice\(event\)/,
  'operation progress events must update the progress notification');
assert.match(coreSource,/async function ensureManagedArcaneModelOnce\(action,requestedSelection\)[\s\S]*requestLocalOllama\('pull',[\s\S]*requestLocalOllama\('create'/,
  'installation must pull the base model when needed and create the managed Arcane model');
assert.match(coreSource,/\['provisioner','shell'\]\.includes\(appMode\)[\s\S]*withAction\('ollama\.model\.ensure'/,
  'Provisioner and Shell production boots must start the model check asynchronously');
assert.match(source,/securityMode !== 'publisher-verified'/,'only publisher verification may hide the Provisioner warning');
assert.match(source,/Unsigned local-test mode is active/);
assert.doesNotMatch(source,/automatically install or update every required dependency|Repair Arcane requirements|installation and dependencies are ready/);
assert.doesNotMatch(coreSource, /\{ id: 'node', name: 'Node\.js'/,
  'the packaged Arcane runtime must not advertise build-time Node.js as a machine requirement');
assert.match(source, /hydrateGuiCache\(\);[\s\S]*await Arcane\.system\.ping\(\)/,
  'the non-secret GUI cache must paint before waiting for Arcane Core');
assert.match(source, /const quickChecks = \[[\s\S]*refreshPlatform\(\)[\s\S]*refreshUsers\(\)[\s\S]*Promise\.allSettled\(quickChecks\)[\s\S]*await refreshMachine\(\)/,
  'basic platform and user information must render before the expensive machine integrity status');
assert.match(source, /renderUsers\(payload, \{ live: true \}\);[\s\S]*updateGuiCache\(\{ users: cacheableUsers\(payload\) \}\)/,
  'a successful live users.list result must replace and persist the GUI user cache');
assert.match(source, /\.banner\{[^}]*max-height:0[^}]*opacity:0[^}]*transition:[^}]*max-height[^}]*opacity/,
  'provisioner banners must animate height and opacity');
assert.match(source, /Set Microsoft NT shell/,
  'the NT-default action must use Microsoft NT shell wording');
assert.match(source, /activationAction\.className = 'machine-user-action activation-action'/,
  'an activation-pending user must expose its completion controls inside its own row');
assert.match(source, /activatePendingAccounts\(\[user\.username\]\)/,
  'each activation row must activate only its own account');
assert.match(source, /reissuePendingAccount\(user\.username\)/,
  'a pending row from an older session must offer in-place credential reissue');
assert.doesNotMatch(source, /id="activateCredentials"/,
  'activation must not remain detached in the global credential panel');
assert.match(source, /Verify shell as administrator/,
  'a signed-out profile must expose an explicit administrator verification action');
assert.match(source, /Arcane\.users\.verifyShell\(username\)/,
  'the administrator verification action must use the dedicated read-only Arcane API');
assert.match(methodPoliciesSource, /"users\.verifyShell": \{ "capability": "users\.manage", "appTypes": \["provisioner"\], "privileged": true \}/,
  'shell verification must cross the privileged worker boundary without being classified as a mutation');
assert.match(methodPoliciesSource, /"users\.restoreShell": \{ "capability": "users\.manage", "appTypes": \["provisioner"\], "privileged": true/,
  'deferred restore must still cross the privileged worker boundary');
assert.match(source, /id="userProvisioningUnavailable"[^>]*role="status"/,
  'unsupported platforms must receive an accessible user-provisioning explanation');
assert.match(source, /id="userProvisioningControls"[^>]*hidden/,
  'account-changing controls must remain hidden until a supported operating system is verified');
assert.match(source, /\['windows', 'linux'\]\.includes\(state\.platform\.platform\)/,
  'the shared Provisioner user workflow must support both Microsoft NT and Linux');
assert.match(source, /state\.platform\.platform !== 'linux'[\s\S]*permissions\.elevated \|\| permissions\.level === 'root'/,
  'Linux account mutations must require an explicitly authorized root Provisioner while NT retains on-demand elevation');
assert.match(source, /activateButton\.disabled = state\.busy \|\| !state\.usersLive \|\| !userMutationAuthorized\(\)/);
assert.match(source, /restoreButton\.disabled = state\.busy \|\| !state\.usersLive \|\| !userMutationAuthorized\(\)/);
assert.doesNotMatch(source, /User provisioning is unavailable on Linux/,
  'Linux must not be presented as unsupported for Arcane user provisioning');
assert.match(source, /id="userValidationHint"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/,
  'username validation must be announced without interrupting unrelated output');
assert.match(source, /aria-describedby="usernamePolicyHint userValidationHint userReadiness protectedUserHint"[^>]*aria-invalid="false"/,
  'each username field must remain associated with its policy, validation, readiness, and protected-account guidance');
assert.match(source, /row\.remove\(\);[\s\S]*focusTarget\.focus\(\)/,
  'removing a username row must preserve keyboard focus');
assert.match(source, /const input = showUsernameValidation\(first\);[\s\S]*if \(input\) input\.focus\(\)/,
  'a rejected username must return focus to the field that needs correction');
assert.match(source, /id="arcaneUsersList"[^>]*aria-live="polite"[^>]*aria-atomic="false"[^>]*aria-busy="true"/,
  'verified Arcane user-list refreshes must expose their live loading state');
assert.doesNotMatch(source, /id="credentials"[^>]*aria-live=/,
  'temporary credentials must never be placed in a live region');
assert.match(sharedApiSource, /Arcane could not communicate with its native host\./,
  'shared bridge errors must remain accurate on both Microsoft NT and Linux');
assert.match(source, /Prepare temporary password/,
  'the active-account password action must describe its preparation stage');
assert.doesNotMatch(source, /Replaces the current OS password/,
  'the preparation action must not claim that it changes the OS password before explicit application');
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
    const attributes = new Map();
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
      dataset: {},
      disabled: false,
      hidden: false,
      setAttribute(name, value) { attributes.set(name, String(value)); },
      removeAttribute(name) { attributes.delete(name); },
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
      scrollOptions: null,
      scrollIntoView(options) { this.scrollOptions = options; },
    });
  }
  return elements.get(id);
}

const calls = { activate: [], applyPassword: [] };
const failures = { activate: new Set(), applyPassword: new Set() };
const confirmationMessages = [];
let confirmationResult = false;
const context = vm.createContext({
  console,
  String,
  state: {
    credentials: [],
    pendingActivations: [],
    pendingPasswordApplications: [],
    platform: { platform: 'windows', displayName: 'Windows' },
  },
  document: { documentElement: element('documentElement') },
  window: { confirm(message) { confirmationMessages.push(message); return confirmationResult; } },
  $: (selector) => element(selector.replace(/^#/, '')),
  setBannerVisible(target, visible) { target.classList.toggle('visible', Boolean(visible)); },
  hideError() {},
  setBusy() {},
  showUserSuccess() {},
  requirementReady() { return true; },
  renderRequirements() {},
  appendOutput() {},
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

vm.runInContext(platformPresentationSource, context, { filename: 'SystemPlatformPresentation.js' });
vm.runInContext([
  functionSource('function showOperationOutput()', 'function showToast'),
  functionSource('function requirementReady(requirement)', 'function renderRequirements'),
  functionSource('function installReady()', 'function renderSystemPresentation'),
  functionSource('function renderSystemPresentation(system, permissions, options = {})', 'function renderMachine'),
  functionSource('function renderMachine(machine, options)', 'function userProvisioningAvailable'),
  functionSource('function userProvisioningAvailable()', 'function renderControls'),
  functionSource('function renderControls()', 'function addUserRow'),
  functionSource('function renderPlatformStatus(platform)', 'async function refreshPlatform'),
  functionSource('function renderCredentials(credentials)', 'function showUserSuccess'),
  functionSource('function restoreShellPresentation(user)', 'function renderUsers'),
  functionSource('async function activatePendingAccounts()', 'async function resetPassword'),
  functionSource('async function applyPendingPasswords()', 'async function restoreShell'),
].join('\n'), context);

assert.equal(context.requirementReady({ blocking: false, status: 'optional-missing' }), true,
  'an unavailable explicitly nonblocking component must not block Arcane readiness');
assert.equal(context.requirementReady({ blocking: false, status: 'update-required' }), true,
  'an outdated explicitly nonblocking component must not block Arcane readiness');
assert.equal(context.requirementReady({ blocking: true, status: 'global-install-required' }), false,
  'a user-only Ollama installation must block global Arcane-user readiness');
assert.equal(context.requirementReady({ blocking: true, ready: true, status: 'ready' }), true);
vm.runInContext('showOperationOutput()', context);
assert.deepEqual(
  JSON.parse(JSON.stringify(element('operationOutput').scrollOptions)),
  { behavior: 'smooth', block: 'start' },
  'starting installation must bring the live operation console into view',
);
assert.match(source, /showOperationOutput\(\);[\s\S]*?Arcane\.installation\.ensure\(\)/,
  'the Provisioner must reveal operation output before beginning installation');
assert.match(source, /await Arcane\.installation\.ensure\(\);[\s\S]*?const machine = await refreshAll\(\);[\s\S]*?if \(!installReady\(\)\)[\s\S]*?showUserSuccess\('Arcane OS installation completed and was verified successfully\.'\)/,
  'the Provisioner must verify refreshed standard-session state before reporting success');

context.platformFixture = {
  platform: 'windows',
  rawPlatform: 'win32',
  displayName: 'Windows',
  architecture: 'x64',
  version: '0.8.4',
  permissions: { elevated: false, level: 'standard', canElevate: true, mechanism: 'uac' },
};
vm.runInContext('renderPlatformStatus(platformFixture)', context);
assert.equal(element('osSummary').textContent, 'Microsoft NT · x64');
assert.equal(element('modeSummary').textContent, 'Standard scope · UAC on demand');
assert.equal(element('accessBanner').classList.contains('visible'), true);
assert.match(element('accessTitle').textContent, /Administrator approval will be requested/);
assert.match(element('accessText').textContent, /Microsoft NT User Account Control \(UAC\)/);
assert.equal(element('documentElement').classList.contains('arcane-kernel-nt'), true);
assert.equal(element('documentElement').dataset.arcaneKernel, 'nt');

context.platformFixture = {
  platform: 'linux',
  rawPlatform: 'linux',
  displayName: 'Linux',
  architecture: 'x64',
  version: '0.8.4',
  permissions: { elevated: false, level: 'standard', canElevate: false, mechanism: null },
};
vm.runInContext('renderPlatformStatus(platformFixture)', context);
assert.equal(element('osSummary').textContent, 'Linux · x64');
assert.equal(element('modeSummary').textContent, 'Standard scope · no automatic elevation');
assert.equal(element('accessBanner').classList.contains('visible'), true);
assert.match(element('accessTitle').textContent, /unavailable on Linux/);
assert.match(element('accessText').textContent, /cannot securely start a temporary root worker/);
assert.doesNotMatch(element('accessTitle').textContent + element('accessText').textContent, /will be requested|on demand|\bUAC\b/i);
assert.equal(element('documentElement').classList.contains('arcane-kernel-linux'), true);
assert.equal(element('documentElement').classList.contains('arcane-kernel-nt'), false);
assert.equal(element('documentElement').dataset.arcaneKernel, 'linux');

context.platformFixture = {
  ...context.platformFixture,
  permissions: { elevated: true, level: 'root', canElevate: false, mechanism: null },
};
vm.runInContext('renderPlatformStatus(platformFixture)', context);
assert.equal(element('modeSummary').textContent, 'root scope');
assert.equal(element('accessBanner').classList.contains('visible'), false);
context.state.platform = { platform: 'windows', rawPlatform: 'win32', displayName: 'Windows' };

const machineFixture = {
  version: '0.8.2',
  os: { displayName: 'Windows', architecture: 'x64' },
  permissions: { elevated: false, level: 'standard', mechanism: 'UAC' },
  protectedUsernames: ['codex'],
  usernamePolicy: { description: 'Use a standard Microsoft NT account name.' },
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
  vm.runInContext('renderMachine(machineFixture, { live: true })', context);
  const warningVisible = element('securityBanner').classList.contains('visible');
  assert.equal(warningVisible, securityMode !== 'publisher-verified');
  assert.equal(element('installArcaneButton').disabled, securityMode === 'unverified');
  assert.equal(element('createUsersButton').disabled, true, 'user creation is unavailable before installation readiness');
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

context.state.platform = { platform: 'linux', rawPlatform: 'linux', displayName: 'Linux', sessionType: 'wslg' };
context.machineFixture = {
  ...machineFixture,
  securityMode: 'unsigned-local-test',
  requirements: [{
    id: 'ollama',
    name: 'Ollama',
    required: false,
    blocking: false,
    ready: false,
    status: 'missing',
    message: 'Ollama does not block base Arcane OS installation on Linux; complete it before using local AI.',
  }],
};
vm.runInContext('renderMachine(machineFixture, { live: true })', context);
assert.equal(element('installArcaneButton').disabled, false,
  'a missing nonblocking Ollama runtime must leave base Linux installation actionable');
assert.match(element('installArcaneButton').textContent, /Install Arcane OS/);

context.state.platform = { platform: 'linux', rawPlatform: 'linux', displayName: 'Linux', sessionType: 'x11' };
vm.runInContext('renderControls()', context);
assert.equal(element('linuxInstallDisclosure').hidden, false);
assert.equal(element('linuxInstallDisclosure').style.display, '');
assert.match(element('linuxInstallDisclosureTitle').textContent, /Fresh Linux installation/);
assert.match(element('linuxInstallDisclosureText').textContent, /register an Arcane X11 login session/);
assert.match(element('linuxInstallDisclosureText').textContent, /next-boot systemd default to graphical\.target/);
assert.equal(element('installArcaneButton').getAttribute('aria-describedby'), 'linuxInstallDisclosureText');
confirmationResult = false;
assert.equal(vm.runInContext('confirmFreshLinuxInstallation()', context), false);
assert.match(confirmationMessages.at(-1), /register an Arcane X11 login session/);
assert.match(confirmationMessages.at(-1), /Cancel to leave the machine unchanged/);

context.state.platform = { platform: 'linux', rawPlatform: 'linux', displayName: 'Linux', sessionType: 'wslg' };
vm.runInContext('renderControls()', context);
assert.match(element('linuxInstallDisclosureTitle').textContent, /WSLg manual launch/);
assert.match(element('linuxInstallDisclosureText').textContent, /does not register a Linux login session or change the boot target/);
assert.match(element('linuxInstallDisclosureText').textContent, /\.\/start-shell\.sh/);
confirmationResult = true;
assert.equal(vm.runInContext('confirmFreshLinuxInstallation()', context), true);
assert.match(confirmationMessages.at(-1), /start Arcane Shell manually through WSLg/);
assert.doesNotMatch(confirmationMessages.at(-1), /graphical\.target/);

context.state.machine = {
  ...context.state.machine,
  installation: { ...context.state.machine.installation, present: true, action: 'current' },
};
vm.runInContext('renderControls()', context);
assert.equal(element('linuxInstallDisclosure').hidden, true);
assert.equal(element('linuxInstallDisclosure').style.display, 'none');
assert.equal(element('installArcaneButton').getAttribute('aria-describedby'), null);
const confirmationCount = confirmationMessages.length;
assert.equal(vm.runInContext('confirmFreshLinuxInstallation()', context), true);
assert.equal(confirmationMessages.length, confirmationCount, 'updates and repairs must not receive the fresh-install confirmation');

context.state.platform = { platform: 'windows', rawPlatform: 'win32', displayName: 'Microsoft NT' };
context.machineFixture = {
  ...machineFixture,
  securityMode: 'publisher-verified',
  requirements: [{ id: 'ollama', name: 'Ollama', blocking: true, ready: true, status: 'ready' }],
  installation: {
    ...machineFixture.installation,
    present: true,
    installedVersion: '0.8.2',
    action: 'current',
    installedIdentity: { ok: true },
  },
};
vm.runInContext('renderMachine(machineFixture, { live: true })', context);
assert.equal(element('installBadge').textContent, 'installed');
assert.equal(element('installBadge').className, 'badge ready');
assert.match(element('installDetail').textContent, /up to date/);
assert.equal(element('installArcaneButton').disabled, true);
assert.equal(element('createUsersButton').disabled, false);

context.state.platform = { platform: 'linux', displayName: 'Linux', sessionType: 'x11', permissions: { elevated: true, level: 'root' } };
vm.runInContext('renderControls()', context);
assert.equal(element('userSetupTitle').textContent, 'Add Arcane users');
assert.equal(element('userProvisioningUnavailable').hidden, true);
assert.equal(element('userProvisioningUnavailable').style.display, 'none');
assert.equal(element('userProvisioningControls').hidden, false);
assert.equal(element('userProvisioningControls').style.display, '');
assert.equal(element('addUserRow').hidden, false);
assert.equal(element('createUsersButton').disabled, false,
  'Linux must expose the shared account-provisioning controls when installation status is ready');
assert.match(element('userSetupDescription').textContent, /standard local Linux account/);
assert.match(element('userSetupDescription').textContent, /POSIX login shell/);
assert.match(element('userProvisioningShellText').textContent, /installed Arcane Shell wrapper/);
assert.doesNotMatch(element('userProvisioningShellText').textContent, /Microsoft NT|UAC/);

context.state.platform = { platform: 'linux', displayName: 'Linux', sessionType: 'wslg', permissions: { elevated: true, level: 'root' } };
vm.runInContext('renderControls()', context);
assert.equal(element('createUsersButton').disabled, false);
assert.match(element('userSetupDescription').textContent, /WSLg desktop launch remains manual/);
assert.match(element('userProvisioningShellText').textContent, /does not register a WSL desktop login session/);
assert.match(element('userReadiness').textContent, /Launch the desktop manually through WSLg/);

context.state.platform = { platform: 'linux', displayName: 'Linux', sessionType: 'wslg', permissions: { elevated: false, level: 'standard', canElevate: false } };
vm.runInContext('renderControls()', context);
assert.equal(element('userProvisioningControls').hidden, false,
  'standard Linux must remain visibly supported');
assert.equal(element('createUsersButton').disabled, true,
  'standard Linux must not offer an account mutation without root authorization');
assert.equal(element('addUserRow').disabled, true);
assert.equal(element('applyPasswordCredentials').disabled, true);
assert.match(element('userReadiness').textContent, /Relaunch this explicitly accepted, integrity-verified Provisioner/);
assert.match(element('userReadiness').textContent, /separately authorized root session/);
assert.doesNotMatch(element('userReadiness').textContent, /UAC|automatically|on demand/i);

context.state.platform = { platform: 'android', displayName: 'Android' };
vm.runInContext('renderControls()', context);
assert.equal(element('userSetupTitle').textContent, 'Android user setup');
assert.equal(element('userProvisioningUnavailable').hidden, false);
assert.equal(element('userProvisioningControls').hidden, true);
assert.equal(element('addUserRow').hidden, true);
assert.equal(element('createUsersButton').disabled, true);
assert.match(element('userProvisioningUnavailableTitle').textContent, /unavailable on Android/);
assert.match(element('userProvisioningUnavailableDetail').textContent, /Microsoft NT and Linux/);

context.state.platform = { platform: 'windows', displayName: 'Windows' };
vm.runInContext('renderControls()', context);
assert.equal(element('userSetupTitle').textContent, 'Add Arcane users');
assert.equal(element('userProvisioningUnavailable').hidden, true);
assert.equal(element('userProvisioningControls').hidden, false);
assert.equal(element('addUserRow').hidden, false);
assert.equal(element('createUsersButton').disabled, false);

context.machineFixture = {
  ...context.machineFixture,
  installation: {
    ...context.machineFixture.installation,
    installedVersion: '0.8.2',
    packageVersion: '0.8.3',
    action: 'update',
  },
};
vm.runInContext('renderMachine(machineFixture, { live: true })', context);
assert.equal(element('installBadge').textContent, 'update available');
assert.equal(element('installArcaneButton').disabled, false, 'available updates must remain actionable');
assert.equal(element('createUsersButton').disabled, true, 'user creation must wait until the available update is installed');

context.machineFixture = {
  ...context.machineFixture,
  installation: {
    ...context.machineFixture.installation,
    action: 'current',
  },
  requirements: [{
    id: 'ollama',
    name: 'Ollama',
    blocking: true,
    ready: false,
    status: 'global-install-required',
    message: 'Ollama is installed only for the current administrator. Arcane users require the machine-wide Ollama service.',
    globalInstall: { available: true, action: 'install' },
  }],
};
vm.runInContext('renderMachine(machineFixture)', context);
assert.equal(element('installBadge').textContent, 'installed');
assert.equal(element('installBadge').className, 'badge ready');
assert.equal(element('installArcaneButton').textContent, 'Install Ollama globally');
assert.match(element('installTitle').textContent, /global setup incomplete/);
assert.equal(element('createUsersButton').disabled, true);

context.machineFixture = {
  ...context.machineFixture,
  requirements: [],
  installation: {
    ...context.machineFixture.installation,
    action: 'repair',
    blocked: false,
    blockedReason: 'identity-invalid',
    installedIdentity: { ok: false, reason: 'Standard Arcane sessions cannot read the installed release.' },
  },
};
vm.runInContext('renderMachine(machineFixture)', context);
assert.equal(element('downgradeBanner').classList.contains('visible'), false);
assert.equal(element('installBadge').textContent, 'repair required');
assert.equal(element('installArcaneButton').disabled, false, 'same-version identity repair must remain actionable');
assert.equal(element('createUsersButton').disabled, true);

context.machineFixture = {
  ...context.machineFixture,
  installation: {
    ...context.machineFixture.installation,
    action: 'blocked',
    blocked: true,
    blockedReason: 'downgrade',
    installedVersion: '0.9.0',
    installedIdentity: { ok: true },
  },
};
vm.runInContext('renderMachine(machineFixture)', context);
assert.equal(element('downgradeBanner').classList.contains('visible'), true);
assert.equal(element('installBadge').textContent, 'blocked');

const deferredPresentation = context.restoreShellPresentation({
  restoreRequiresElevatedVerification: true,
  previousShellPresent: false,
  previousShell: null,
});
assert.equal(deferredPresentation.deferredVerification, true);
assert.equal(deferredPresentation.buttonText, 'Set Microsoft NT shell');
assert.match(deferredPresentation.note, /Administrator approval is required to verify the signed-out profile/);
assert.match(source, /verifyButton\.disabled = state\.busy \|\| !state\.usersLive;/, 'a live deferred verification affordance must remain actionable');

context.state.platform = { platform: 'linux', displayName: 'Linux', sessionType: 'x11' };
const linuxRestorePresentation = context.restoreShellPresentation({
  restoreRequiresElevatedVerification: false,
  previousShellPresent: true,
  previousShell: '/bin/bash',
});
assert.equal(linuxRestorePresentation.deferredVerification, false);
assert.equal(linuxRestorePresentation.buttonText, 'Restore previous POSIX login shell');
assert.match(linuxRestorePresentation.note, /Linux account back to \/bin\/bash/);
assert.match(linuxRestorePresentation.confirmation, /stop being this account’s POSIX login shell/);
assert.doesNotMatch(JSON.stringify(linuxRestorePresentation), /Microsoft NT|UAC/);
context.state.platform = null;
const earlyLinuxRestorePresentation = context.restoreShellPresentation({
  source: 'native-linux',
  recordedAssignmentMode: 'linux-login-shell',
  previousShellPresent: true,
  previousShell: '/bin/sh',
});
assert.equal(earlyLinuxRestorePresentation.buttonText, 'Restore previous POSIX login shell',
  'a Linux users.list result must never receive NT restore wording when it paints before platform status');

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

await vm.runInContext('activatePendingAccounts()', context);
assert.deepEqual(calls.activate, ['arcane-one', 'arcane-two', 'arcane-two']);
assert.deepEqual(context.state.pendingActivations, []);
assert.equal(context.state.credentials.every((item) => item.activationRequired === false), true);
assert.equal(element('credentials').classList.contains('visible'), true);

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
