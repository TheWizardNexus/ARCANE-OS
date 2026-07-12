import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'arcane-bundle.json'), 'utf8'));
const simulatedPlatform = process.platform === 'win32' ? 'win32' : 'linux';
const child = spawn(process.execPath, [path.join(root, 'runtime/arcane-core.cjs'), '--app=provisioner', '--simulate', `--simulate-platform=${simulatedPlatform}`, `--bundle-root=${root}`], { stdio: ['pipe','pipe','pipe'] });
let buffer = Buffer.alloc(0);
let expected = null;
const pending = new Map();
const events = [];
child.stderr.on('data', chunk => process.stderr.write(chunk));
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (expected === null) {
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const header = buffer.subarray(0, marker).toString('ascii');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) throw new Error('Missing Content-Length');
      expected = Number(match[1]); buffer = buffer.subarray(marker + 4);
    }
    if (buffer.length < expected) return;
    const message = JSON.parse(buffer.subarray(0, expected).toString('utf8'));
    buffer = buffer.subarray(expected); expected = null;
    if (message.type === 'event') events.push(message);
    else if (message.type === 'response') {
      const callback = pending.get(message.id); if (callback) { pending.delete(message.id); message.ok ? callback.resolve(message.result) : callback.reject(Object.assign(new Error(message.error.message), message.error)); }
    }
  }
});
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}
function call(method, parameters={}) {
  const id = crypto.randomUUID();
  child.stdin.write(frame({ protocol:'arcane/1', type:'request', id, method, parameters }));
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve:value=>{clearTimeout(timer);resolve(value);}, reject:error=>{clearTimeout(timer);reject(error);} });
  });
}
try {
  const ping = await call('system.ping');
  if (!ping.ok || ping.version !== manifest.version) throw new Error('Ping failed');
  const currentVersion = await call('version.current');
  if (currentVersion !== manifest.version) throw new Error('Version API failed');
  const network = await call('network.status');
  if (typeof network.online !== 'boolean' || !Number.isSafeInteger(network.interfaceCount)) throw new Error('Network status API failed');
  const requirements = await call('requirements.list');
  if (!Array.isArray(requirements) || !requirements.some((item) => item.id === 'renderer')) throw new Error('Requirements API failed');
  const validation = await call('users.validate', { usernames: ['arcane-valid','invalid name'] });
  if (validation.valid || validation.users.length !== 1 || validation.errors.length !== 1) throw new Error('Username validation API failed');
  let diagnosticId = null;
  try {
    await call('unsupported.test.method');
    throw new Error('Unsupported method was accepted');
  } catch (error) {
    if (error.code !== 'METHOD_NOT_ALLOWED' || !error.diagnosticId) throw error;
    diagnosticId = error.diagnosticId;
  }
  const recentDiagnostics = await call('diagnostics.recent');
  if (!Array.isArray(recentDiagnostics) || !recentDiagnostics.some((item) => item.id === diagnosticId)) throw new Error('Recent diagnostics API failed');
  const diagnostic = await call('diagnostics.get', { diagnosticId });
  if (!diagnostic || diagnostic.id !== diagnosticId || diagnostic.code !== 'METHOD_NOT_ALLOWED') throw new Error('Diagnostic lookup API failed');
  const machine = await call('machine.status');
  if (!machine.simulation || machine.protocol !== 'arcane/1') throw new Error('Machine status failed');
  if (!['publisher-verified','unsigned-local-test','unverified'].includes(machine.securityMode)) throw new Error('Machine status omitted release security mode');
  if (machine.installedSecurityMode !== 'not-installed') throw new Error('Machine status conflated active-package trust with a missing installed release');
  const ensuredRequirements = await call('requirements.ensure');
  if (!Array.isArray(ensuredRequirements.requirements) || !ensuredRequirements.requirements.some((item) => item.id === 'renderer')) throw new Error('Requirements ensure API failed');
  const install = await call('installation.ensure');
  if (!install.installation.present || install.installation.installedVersion !== manifest.version) throw new Error('Installation simulation failed');
  const users = await call('users.add', { usernames: ['arcane-test'] });
  if (!users.users.some(user => user.username === 'arcane-test' && Boolean(user.shell))) throw new Error('User provisioning simulation failed');
  if (!users.credentials.some(item => item.username === 'arcane-test' && item.temporaryPassword && item.activationRequired)) throw new Error('Temporary credentials or activation gate missing');
  if (!users.users.some(user => user.username === 'arcane-test' && user.enabled === false && user.activationRequired)) throw new Error('New account was not staged disabled before credential delivery');
  const activated = await call('users.activate', { username: 'arcane-test' });
  if (!activated.user.activated || !activated.user.enabled) throw new Error('Staged account activation failed');
  const preparedPassword = await call('users.resetPassword', { username: 'arcane-test' });
  const passwordCredential = preparedPassword.credentials.find(item => item.username === 'arcane-test');
  if (!passwordCredential || !passwordCredential.temporaryPassword || !passwordCredential.applyPasswordRequired || preparedPassword.user.passwordReset) throw new Error('Password reset was not safely staged before mutation');
  const appliedPassword = await call('users.applyPassword', { username: 'arcane-test', temporaryPassword: passwordCredential.temporaryPassword });
  if (!appliedPassword.user.passwordReset || appliedPassword.user.applyPasswordRequired) throw new Error('Saved temporary password was not applied');
  const listed = await call('users.list');
  const listedUser = listed.users.find(user => user.username === 'arcane-test');
  if (!listedUser || !listedUser.shellAssigned || !listedUser.canRestoreShell || listedUser.shellMutationPhase !== 'assigned') throw new Error('Verified Arcane user or durable shell journal missing');
  const restored = await call('users.restoreShell', { username: 'arcane-test' });
  if (!restored.user.restored || restored.user.shellAssigned) throw new Error('Shell restore simulation failed');
  const afterRestore = await call('users.list');
  const restoredUser = afterRestore.users.find(user => user.username === 'arcane-test');
  if (!restoredUser || restoredUser.shellAssigned || restoredUser.canRestoreShell || restoredUser.shellMutationPhase !== 'restored') throw new Error('Restored user verification failed');
  const reassigned = await call('users.add', { usernames: ['arcane-test'] });
  if (!reassigned.users.some(user => user.username === 'arcane-test' && !user.created)) throw new Error('Existing user shell reassignment failed');
  if (reassigned.credentials.length) throw new Error('Existing user shell reassignment must not issue a new password');
  await call('users.restoreShell', { username: 'arcane-test' });
  const duplicateNames = simulatedPlatform === 'win32' ? ['Arcane-Dupe', 'arcane-dupe'] : ['arcane-dupe', 'arcane-dupe'];
  const duplicateCase = await call('users.add', { usernames: duplicateNames });
  if (duplicateCase.users.length !== 1 || duplicateCase.credentials.length !== 1) throw new Error('Windows case-insensitive account deduplication failed');
  await call('users.activate', { username: duplicateNames[0] });
  await call('users.restoreShell', { username: duplicateNames[0] });
  if (!events.some(event => event.event === 'operation.completed')) throw new Error('Progress events missing');
  console.log('Arcane framed RPC smoke test passed.');
} finally {
  child.stdin.end(); child.kill();
}
