import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src', 'frontend', 'provisioner', 'index.html'), 'utf8');

function functionSource(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `Missing ${start}`);
  assert.notEqual(to, -1, `Missing boundary ${end}`);
  return source.slice(from, to);
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
        contains: (name) => classes.has(name),
      },
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
  functionSource('function renderCredentials(credentials)', 'function showUserSuccess'),
  functionSource('async function activatePendingAccounts()', 'async function resetPassword'),
  functionSource('async function applyPendingPasswords()', 'async function restoreShell'),
].join('\n'), context);

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
