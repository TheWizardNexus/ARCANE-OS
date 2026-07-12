import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phases = ['after-create', 'after-profile', 'after-shell', 'after-state'];

function startCore(phase, options={}) {
  const platform=options.platform || 'win32';
  const coreArgs=[
    path.join(root, 'runtime/arcane-core.cjs'),
    '--app=provisioner',
    '--simulate',
    `--simulate-platform=${platform}`,
    `--simulate-user-failure=${phase}`,
    `--bundle-root=${root}`,
  ];
  if(options.existingUser)coreArgs.push(`--simulate-existing-user=${options.existingUser}`);
  if(options.legacyUser)coreArgs.push(`--simulate-legacy-arcane-user=${options.legacyUser}`);
  if(options.legacyDriftUser)coreArgs.push(`--simulate-legacy-drift-user=${options.legacyDriftUser}`);
  const child = spawn(process.execPath, coreArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  let expected = null;
  const pending = new Map();
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (expected === null) {
        const marker = buffer.indexOf('\r\n\r\n');
        if (marker < 0) return;
        const match = buffer.subarray(0, marker).toString('ascii').match(/Content-Length:\s*(\d+)/i);
        if (!match) throw new Error('Missing Content-Length.');
        expected = Number(match[1]);
        buffer = buffer.subarray(marker + 4);
      }
      if (buffer.length < expected) return;
      const message = JSON.parse(buffer.subarray(0, expected).toString('utf8'));
      buffer = buffer.subarray(expected);
      expected = null;
      if (message.type !== 'response') continue;
      const callback = pending.get(message.id);
      if (!callback) continue;
      pending.delete(message.id);
      message.ok ? callback.resolve(message.result) : callback.reject(Object.assign(new Error(message.error.message), message.error));
    }
  });

  function call(method, parameters = {}) {
    const id = crypto.randomUUID();
    const body = Buffer.from(JSON.stringify({ protocol: 'arcane/1', type: 'request', id, method, parameters }));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 20_000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
    });
  }

  return { child, call };
}

{
  const phase='crash-after-policy-shell-write';
  const username='arcane-retry-user';
  const {child,call}=startCore(phase,{existingUser:username});
  try{
    await call('installation.ensure');
    await assert.rejects(
      call('users.add',{usernames:[username]}),
      (error)=>error.code==='SIMULATED_USER_TRANSACTION_FAILURE',
      'a process loss after the first Windows shell write must leave the original durable record prepared',
    );
    const interrupted=(await call('users.list')).users.find((item)=>item.username===username);
    assert.equal(interrupted.shellMutationPhase,'prepared');
    assert.equal(interrupted.shellAssigned,false);
    assert.equal(interrupted.assignmentMode,'windows-partial');
    assert.equal(interrupted.canRestoreShell,true,'an existing-account prepared record must expose its safe recovery action');

    const retry=await call('users.add',{usernames:[username]});
    assert.ok(retry.users.some((item)=>item.username===username && item.created===false && item.assignmentMode==='windows-dual'));
    const assigned=(await call('users.list')).users.find((item)=>item.username===username);
    assert.equal(assigned.shellAssigned,true,'retry must recover the original baseline before assigning a new exact dual binding');
    assert.equal(assigned.recordedShellBindingVersion,2);
    assert.equal(assigned.recordedAssignmentMode,'windows-dual');
    await call('users.restoreShell',{username});
  }finally{
    child.stdin.end();
    child.kill();
  }
}

{
  const username='arcane-legacy-user';
  const {child,call}=startCore('',{legacyUser:username});
  try{
    await call('installation.ensure');
    const migrated=await call('users.add',{usernames:[username]});
    assert.ok(migrated.users.some((item)=>item.username===username && item.created===false && item.assignmentMode==='windows-dual'));
    const assigned=(await call('users.list')).users.find((item)=>item.username===username);
    assert.equal(assigned.previousLegacyShell,'explorer.exe','migration must preserve the original v1 recovery baseline');
    assert.equal(assigned.previousLegacyShellPresent,true);
    assert.equal(assigned.recordedShellBindingVersion,2);
    await call('users.restoreShell',{username});
    const restored=(await call('users.list')).users.find((item)=>item.username===username);
    assert.equal(restored.legacyShell,'explorer.exe','dual restore after migration must return to the original legacy baseline');
    assert.equal(restored.policyShellPresent,false);
  }finally{
    child.stdin.end();
    child.kill();
  }
}

{
  const username='arcane-legacy-drift';
  const {child,call}=startCore('',{legacyDriftUser:username});
  try{
    await call('installation.ensure');
    await assert.rejects(
      call('users.add',{usernames:[username]}),
      (error)=>error.code==='SHELL_CHANGED_EXTERNALLY',
      'legacy migration must refuse an externally changed legacy shell',
    );
    const preserved=(await call('users.list')).users.find((item)=>item.username===username);
    assert.equal(preserved.legacyShell,'third-party-shell.exe');
    assert.equal(preserved.shellMutationPhase,'assigned','external drift must not overwrite the original journal');
  }finally{
    child.stdin.end();
    child.kill();
  }
}

{
  const username='arcane-linux-legacy';
  const {child,call}=startCore('',{platform:'linux',existingUser:username});
  try{
    await call('installation.ensure');
    const provisioned=await call('users.add',{usernames:[username]});
    assert.ok(provisioned.users.some((item)=>item.username===username && item.created===false));
    assert.equal(provisioned.credentials.length,0,'an existing Linux account must retain its password');
    const assigned=(await call('users.list')).users.find((item)=>item.username===username);
    assert.equal(assigned.shellAssigned,true);
    assert.equal(assigned.recordedShellBindingVersion,1,'Linux must retain its single POSIX login-shell recovery contract');
    assert.equal(assigned.recordedAssignmentMode,'linux-login-shell');
    const restored=await call('users.restoreShell',{username});
    assert.equal(restored.user.shellAssigned,false);
  }finally{
    child.stdin.end();
    child.kill();
  }
}

for (const phase of phases) {
  const { child, call } = startCore(phase);
  const username = `arcane-tx-${phase.replace('after-', '')}`;
  try {
    await call('installation.ensure');
    await assert.rejects(
      call('users.add', { usernames: [username] }),
      (error) => error.code === 'SIMULATED_USER_TRANSACTION_FAILURE',
      `${phase} must fail at the injected transaction boundary`,
    );
    const afterFailure = await call('users.list');
    const rolledBack = afterFailure.users.find((item) => item.username === username);
    assert.ok(rolledBack, `${phase} must retain a non-secret recovery journal entry`);
    assert.equal(rolledBack.shellAssigned, false, `${phase} must not leave the Arcane shell assigned`);
    assert.notEqual(rolledBack.enabled, true, `${phase} must not leave an enabled account with an undisclosed password`);
    assert.equal(rolledBack.shellMutationPhase, 'rolled-back', `${phase} must durably record rollback`);

    const retry = await call('users.add', { usernames: [username] });
    assert.ok(retry.users.some((item) => item.username === username && item.enabled === false && item.activationRequired), `${phase} retry must leave the staged account disabled while returning credentials`);
    assert.ok(retry.credentials.some((item) => item.username === username && item.temporaryPassword && item.activationRequired), `${phase} retry must return the usable temporary password before activation`);
    const activated = await call('users.activate', { username });
    assert.equal(activated.user.enabled, true, `${phase} account must activate after credential delivery`);
    await call('users.restoreShell', { username });
  } finally {
    child.stdin.end();
    child.kill();
  }
}

{
  const phase = 'crash-before-native-return';
  const { child, call } = startCore(phase);
  const username = 'arcane-tx-no-sid';
  try {
    await call('installation.ensure');
    await assert.rejects(call('users.add', { usernames: [username] }), (error) => error.code === 'SIMULATED_USER_TRANSACTION_FAILURE');
    const prepared = (await call('users.list')).users.find((item) => item.username === username);
    assert.equal(prepared.canRestoreShell, false, 'an incomplete newly-created account must not expose shell-only recovery');
    await assert.rejects(
      call('users.add', { usernames: [username] }),
      (error) => error.code === 'PARTIAL_ACCOUNT_RECOVERY_REQUIRED',
      'an interrupted creation without a durable SID must fail closed rather than delete by username',
    );
    const listed = await call('users.list');
    const partial = listed.users.find((item) => item.username === username);
    assert.ok(partial && partial.enabled === false && partial.accountMutationPhase === 'cleanup-required');
  } finally {
    child.stdin.end();
    child.kill();
  }
}

{
  const phase = 'crash-activation-pending';
  const { child, call } = startCore(phase);
  const username = 'arcane-tx-pending';
  try {
    await call('installation.ensure');
    await assert.rejects(call('users.add', { usernames: [username] }), (error) => error.code === 'SIMULATED_USER_TRANSACTION_FAILURE');
    const retry = await call('users.add', { usernames: [username] });
    assert.ok(retry.credentials.some((item) => item.username === username && item.temporaryPassword));
    assert.ok(retry.users.some((item) => item.username === username && item.enabled === false));
    await call('users.activate', { username });
    await call('users.restoreShell', { username });
  } finally {
    child.stdin.end();
    child.kill();
  }
}

for (const [phase, username] of [['crash-during-activation', 'arcane-tx-act'], ['crash-after-enable', 'arcane-tx-enable']]) {
  const { child, call } = startCore(phase);
  try {
    await call('installation.ensure');
    const staged = await call('users.add', { usernames: [username] });
    assert.ok(staged.credentials.some((item) => item.username === username && item.temporaryPassword), `${phase} must deliver the password before activation starts`);
    await assert.rejects(call('users.activate', { username }), (error) => error.code === 'SIMULATED_USER_TRANSACTION_FAILURE');
    const pending = await call('users.list');
    assert.ok(pending.users.some((item) => item.username === username && item.activationRequired), `${phase} must retain a retryable activation journal`);
    const retried = await call('users.activate', { username });
    assert.equal(retried.user.enabled, true, `${phase} activation retry must reconcile safely`);
    await call('users.restoreShell', { username });
  } finally {
    child.stdin.end();
    child.kill();
  }
}

{
  const phase = 'crash-after-password-apply';
  const { child, call } = startCore(phase);
  const username = 'arcane-tx-password';
  try {
    await call('installation.ensure');
    const staged = await call('users.add', { usernames: [username] });
    assert.ok(staged.credentials.some((item) => item.username === username && item.temporaryPassword), 'password crash test must deliver the initial account credential before activation');
    await call('users.activate', { username });

    const prepared = await call('users.resetPassword', { username });
    const credential = prepared.credentials.find((item) => item.username === username && item.applyPasswordRequired);
    assert.ok(credential && credential.temporaryPassword, 'password reset must return the saved credential before the native apply phase');
    const before = (await call('users.list')).users.find((item) => item.username === username);

    await assert.rejects(
      call('users.applyPassword', { username, temporaryPassword: credential.temporaryPassword }),
      (error) => error.code === 'SIMULATED_USER_TRANSACTION_FAILURE',
      'a crash after the native password change must surface as an interrupted apply',
    );
    const interrupted = (await call('users.list')).users.find((item) => item.username === username);
    assert.equal(interrupted.passwordChangedAt, before.passwordChangedAt, 'a crash before state persistence must leave the prior durable password metadata intact');
    assert.equal(interrupted.shellAssigned, true, 'an interrupted password apply must not disturb the Arcane shell assignment');
    assert.equal(interrupted.enabled, true, 'an interrupted password apply must not disable an active Arcane user');

    const retried = await call('users.applyPassword', { username, temporaryPassword: credential.temporaryPassword });
    assert.equal(retried.user.passwordReset, true, 'retrying the already-saved credential must safely reconcile the native password change');
    assert.equal(retried.user.applyPasswordRequired, false, 'a successful retry must complete the staged password handoff');
    const reconciled = (await call('users.list')).users.find((item) => item.username === username);
    assert.equal(reconciled.passwordStatus, 'temporary-issued', 'a successful retry must durably record the new temporary-password status');
    assert.ok(reconciled.passwordChangedAt, 'a successful retry must durably record when the password was changed');
    await call('users.restoreShell', { username });
  } finally {
    child.stdin.end();
    child.kill();
  }
}

console.log('Arcane staged-account transaction failure-injection smoke test passed.');
