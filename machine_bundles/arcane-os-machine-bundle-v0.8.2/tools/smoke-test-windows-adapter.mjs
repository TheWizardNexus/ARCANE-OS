import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync as spawnProcessSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8');
const sandbox = {
  process:{ env:{ SystemRoot:'C:\\Windows' },arch:'x64' },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(`${source}\nglobalThis.createAdapter=createWindowsNativeAdapter;`,sandbox,{
  filename:'windows.cjs',
});

const queries=[];
const adapter=sandbox.createAdapter({
  simulate:false,
  path:path.win32,
  fs:{ existsSync(){ return false; } },
  spawnSync(executable,args){
    queries.push({ executable,args });
    return {
      status:0,
      stdout:'    pv    REG_SZ    1.0.9999.0\r\n',
    };
  },
});

const status=adapter.rendererStatus();
assert.equal(status.available,true);
assert.equal(status.version,'1.0.9999.0');
assert.equal(queries.length,1);
assert.equal(queries[0].executable,'C:\\Windows\\System32\\reg.exe');
assert.equal(
  queries[0].args[1],
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
);

const scripts=[];
const hardened=sandbox.createAdapter({
  simulate:false,
  production:true,
  path:path.win32,
  fs:{
    existsSync(candidate){ return String(candidate).endsWith('ArcaneShell.exe'); },
    lstatSync(){ return { isDirectory:()=>true,isFile:()=>false,isSymbolicLink:()=>false }; },
    readdirSync(){ return []; },
  },
  psQuote(value){ return `'${String(value).replaceAll("'","''")}'`; },
  cleanPowerShellError(value){ return String(value||''); },
  arcaneError(code,message){ return Object.assign(new Error(message),{code}); },
  ensureDir:async()=>{},
  run:async()=>({code:0}),
  powershell:async(script,options={})=>{
    scripts.push({script,options});
    if(options.purpose==='prepare-user-shell-backup') return {stdout:'{"username":"arcane-test","accountExisted":false,"previousShell":null,"previousShellPresent":false,"previousPolicyShell":null,"previousPolicyShellPresent":false,"previousLegacyShell":null,"previousLegacyShellPresent":false,"shellBindingVersion":2,"assignmentMode":"windows-dual","verification":"verified"}\n'};
    if(options.purpose==='create-arcane-user') return {stdout:'{"username":"arcane-test","created":true,"sid":"S-1-5-21-TEST","profile":"C:\\\\Users\\\\arcane-test","shell":"arcane","enabled":false,"activationPending":true,"previousShell":null,"previousShellPresent":false,"previousPolicyShell":null,"previousPolicyShellPresent":false,"previousLegacyShell":null,"previousLegacyShellPresent":false,"shellBindingVersion":2,"assignmentMode":"windows-dual"}\n'};
    if(options.purpose==='activate-staged-arcane-user') return {stdout:'{"username":"arcane-test","sid":"S-1-5-21-TEST","enabled":true,"activated":true}\n'};
    if(options.purpose==='rollback-created-arcane-user') return {stdout:'{"username":"arcane-test","sid":"S-1-5-21-TEST","accountDisabled":true,"accountRemoved":true,"cleanupErrors":[]}\n'};
    if(options.purpose==='restore-arcane-user-shell') return {stdout:'{"username":"arcane-test","restored":true,"shell":null,"shellAssigned":false}\n'};
    return {stdout:'verified\n'};
  },
});
assert.equal(hardened.paths.installRoot,'C:\\Program Files\\Arcane OS');
assert.equal(hardened.paths.stateRoot,'C:\\ProgramData\\Arcane OS\\state');
const backup=await hardened.prepareUserShellBackup('arcane-test',{});
const staged=await hardened.provisionUser('arcane-test','secret-password',{},backup);
await hardened.activateProvisionedUser('arcane-test',staged,{});
await hardened.rollbackCreatedUser('arcane-test',staged,{});
await hardened.restoreUserShell('arcane-test',{...backup,shellMutationPhase:'assigned'},{});
await hardened.applyStatePermissions({});
await hardened.listArcaneUsers(['arcane-test']);
const provisionCall=scripts.find(entry=>entry.options.purpose==='create-arcane-user');
assert.equal(provisionCall.options.input,'secret-password\n');
assert.match(provisionCall.script,/expectedPolicyPresent/);
assert.match(provisionCall.script,/expectedLegacyPresent/);
assert.match(provisionCall.script,/New-LocalUser[^\r\n]+-Disabled/);
assert.match(provisionCall.script,/ARCANE_PROVISION_ROLLBACK:/);
assert.match(provisionCall.script,/Remove-LocalUser/);
assert.match(provisionCall.script,/could not release the temporary Arcane registry hive/);
assert.ok(provisionCall.script.includes('Windows\\CurrentVersion\\Policies\\System'));
assert.ok(provisionCall.script.includes('Windows NT\\CurrentVersion\\Winlogon'));
assert.match(provisionCall.script,/could not compensate both Windows shell bindings/);
assert.match(provisionCall.script,/policy verification failed/);
assert.match(provisionCall.script,/legacy verification failed/);
assert.doesNotMatch(provisionCall.script,/secret-password/);
assert.match(source, /async function resetUserPassword\(username, password, action\)/);
const restoreCall=scripts.find(entry=>entry.options.purpose==='restore-arcane-user-shell');
assert.match(restoreCall.script,/ARCANE_PREPARE_/);
assert.match(restoreCall.script,/\$policyAllowed/);
assert.match(restoreCall.script,/\$legacyAllowed/);
assert.match(restoreCall.script,/could not compensate both Windows shell bindings after restoration failed/);
const activationCall=scripts.find(entry=>entry.options.purpose==='activate-staged-arcane-user');
assert.match(activationCall.script,/SID\.Value -ne \$expectedSid/);
assert.match(activationCall.script,/\$policyMatches/);
assert.match(activationCall.script,/\$legacyMatches/);
assert.match(activationCall.script,/\$policyMatches -and \$legacyMatches/);
assert.match(activationCall.script,/Enable-LocalUser/);
const rollbackCall=scripts.find(entry=>entry.options.purpose==='rollback-created-arcane-user');
assert.match(rollbackCall.script,/SID\.Value -ne \$expectedSid/);
assert.match(rollbackCall.script,/Disable-LocalUser/);
assert.match(rollbackCall.script,/Remove-LocalUser/);
const aclCall=scripts.find(entry=>entry.options.purpose==='verify-arcane-state-acl');
assert.match(aclCall.script,/Directory\]::CreateDirectory/);
assert.match(aclCall.script,/recovery state changed while its ACL was being locked/);
assert.match(aclCall.script,/SetAccessRuleProtection\(\$true,\$false\)/);
assert.match(aclCall.script,/will not adopt pre-existing recovery state from a directory that was not already administrator-owned/);
const listUsersCall=scripts.find(entry=>entry.options.purpose==='list-arcane-users');
assert(listUsersCall, 'Windows user discovery must query the effective per-user shell.');
assert.match(
  listUsersCall.script,
  /\$assigned=\[bool\]\(\$policyAssigned -and \$legacyAssigned\)/,
);
assert.doesNotMatch(listUsersCall.script, /ArcaneShell\\\.exe|-match| -eq \$expected/);

const expectedShell=hardened.shellCommand();
for (const wrongShell of [
  expectedShell.replace('C:\\Program Files\\Arcane OS', 'C:\\Arcane Lookalike'),
  `${expectedShell} --extra-argument`,
  expectedShell.replace('ArcaneShell.exe', 'arcaneshell.exe'),
]) {
  assert.notEqual(wrongShell, expectedShell, 'lookalike shell fixture must differ from the exact Arcane command');
}

function simulatedAdapterContext(accounts, bindings, overrides={}) {
  return {
    simulate:true,
    production:true,
    path:path.win32,
    fs:{existsSync(){return true;}},
    simulatedAccounts:accounts,
    simulatedUsers:bindings,
    arcaneError(code,message,resolution,status){return Object.assign(new Error(message),{code,resolution,status});},
    ...overrides,
  };
}

const recoveryBaseline={
  previousShell:null,
  previousShellPresent:false,
  previousPolicyShell:'explorer-policy.exe',
  previousPolicyShellPresent:true,
  previousLegacyShell:null,
  previousLegacyShellPresent:false,
  shellBindingVersion:2,
  assignmentMode:'windows-dual',
  shellMutationPhase:'prepared',
};
for (const [name,policyArcane,legacyArcane] of [
  ['baseline-baseline',false,false],
  ['arcane-baseline',true,false],
  ['baseline-arcane',false,true],
  ['arcane-arcane',true,true],
]) {
  const accounts=new Set(['existing']);
  const bindings=new Map([['existing',{
    username:'existing',
    enabled:true,
    policyShell:policyArcane?expectedShell:'explorer-policy.exe',
    policyShellPresent:true,
    legacyShell:legacyArcane?expectedShell:null,
    legacyShellPresent:legacyArcane,
  }]]);
  const simulated=sandbox.createAdapter(simulatedAdapterContext(accounts,bindings));
  const restored=await simulated.restoreUserShell('existing',recoveryBaseline,{});
  assert.equal(restored.verification,'simulated',`${name} must be recoverable from a prepared record`);
  assert.deepEqual(
    {
      policyShell:bindings.get('existing').policyShell,
      policyShellPresent:bindings.get('existing').policyShellPresent,
      legacyShell:bindings.get('existing').legacyShell,
      legacyShellPresent:bindings.get('existing').legacyShellPresent,
    },
    {policyShell:'explorer-policy.exe',policyShellPresent:true,legacyShell:null,legacyShellPresent:false},
    `${name} must restore the exact captured baseline`,
  );
}

{
  const accounts=new Set(['existing']);
  const bindings=new Map([['existing',{username:'existing',enabled:true,policyShell:'third-party.exe',policyShellPresent:true,legacyShell:expectedShell,legacyShellPresent:true}]]);
  const simulated=sandbox.createAdapter(simulatedAdapterContext(accounts,bindings));
  await assert.rejects(
    ()=>simulated.restoreUserShell('existing',recoveryBaseline,{}),
    (error)=>error?.code==='SHELL_CHANGED_EXTERNALLY',
    'prepared recovery must reject an external third-party shell value',
  );
  assert.equal(bindings.get('existing').policyShell,'third-party.exe');
  await assert.rejects(
    ()=>simulated.restoreUserShell('existing',{...recoveryBaseline,shellMutationPhase:'assigned'},{}),
    (error)=>error?.code==='SHELL_CHANGED_EXTERNALLY',
    'assigned-state restore must require both exact Arcane bindings',
  );
}

{
  const accounts=new Set(['existing']);
  const bindings=new Map([['existing',{username:'existing',enabled:true,policyShell:'explorer-policy.exe',policyShellPresent:true,legacyShell:'explorer-legacy.exe',legacyShellPresent:true}]]);
  const context=simulatedAdapterContext(accounts,bindings,{simulatedShellWriteFailure:'after-policy'});
  const simulated=sandbox.createAdapter(context);
  const backup=await simulated.prepareUserShellBackup('existing',{});
  await assert.rejects(()=>simulated.provisionUser('existing','protected',{},backup),/Simulated failure after the policy shell write/);
  assert.equal(bindings.get('existing').policyShell,'explorer-policy.exe','failed assignment must compensate the policy binding');
  assert.equal(bindings.get('existing').legacyShell,'explorer-legacy.exe','failed assignment must preserve the legacy binding');
}

{
  const accounts=new Set(['existing']);
  const bindings=new Map([['existing',{username:'existing',enabled:false,policyShell:expectedShell,policyShellPresent:true,legacyShell:expectedShell,legacyShellPresent:true}]]);
  const simulated=sandbox.createAdapter(simulatedAdapterContext(accounts,bindings));
  const listed=await simulated.listArcaneUsers(['existing']);
  assert.equal(listed[0].shellAssigned,true,'simulation discovery must require and recognize the exact dual binding');
  assert.equal(listed[0].assignmentMode,'windows-dual');
  const activated=await simulated.activateProvisionedUser('existing',{created:true,sid:'SIMULATED',...recoveryBaseline,shellMutationPhase:'assigned'},{});
  assert.equal(activated.enabled,true,'activation must succeed only with both exact bindings');
  bindings.get('existing').legacyShell='lookalike.exe';
  await assert.rejects(
    ()=>simulated.activateProvisionedUser('existing',{created:true,sid:'SIMULATED',...recoveryBaseline,shellMutationPhase:'assigned'},{}),
    (error)=>error?.code==='SHELL_CHANGED_EXTERNALLY',
  );
}

let signatureMode='matching';
const signatureScripts=[];
const signatureAdapter=sandbox.createAdapter({
  simulate:false,
  production:true,
  path:path.win32,
  fs:{
    existsSync(){ return true; },
    statSync(){ return {isFile:()=>true}; },
  },
  psQuote(value){ return `'${String(value).replaceAll("'","''")}'`; },
  arcaneError(code,message){ return Object.assign(new Error(message),{code}); },
  actionLog(){},
  powershell:async(script,options)=>{
    signatureScripts.push({script,options});
    const valid=(thumbprint)=>({status:'Valid',thumbprint,subject:'CN=Arcane Test'});
    const records=signatureMode==='matching'
      ? [valid('A'.repeat(40)),valid('A'.repeat(40))]
      : signatureMode==='mismatch'
        ? [valid('A'.repeat(40)),valid('B'.repeat(40))]
        : [{status:'NotSigned',thumbprint:null,subject:null},{status:'NotSigned',thumbprint:null,subject:null}];
    return {stdout:`${JSON.stringify(records)}\n`};
  },
});
const signedTrust=await signatureAdapter.verifyPrivilegePipeGuardTrust('C:\\Arcane\\ArcanePipeGuard.exe','C:\\Arcane\\ArcaneCore.exe',{},{});
assert.equal(signedTrust.signed,true);
signatureMode='mismatch';
await assert.rejects(
  ()=>signatureAdapter.verifyPrivilegePipeGuardTrust('C:\\Arcane\\ArcanePipeGuard.exe','C:\\Arcane\\ArcaneCore.exe',{},{}),
  (error)=>error?.code==='PRIVILEGE_PIPE_GUARD_TRUST_FAILED',
);
signatureMode='unsigned';
const unsignedTrust=await signatureAdapter.verifyPrivilegePipeGuardTrust(
  'C:\\Arcane\\ArcanePipeGuard.exe','C:\\Arcane\\ArcaneCore.exe',{allowUnsignedLocalRelease:true},{}
);
assert.equal(unsignedTrust.unsignedLocal,true);
await assert.rejects(
  ()=>signatureAdapter.verifyPrivilegePipeGuardTrust('C:\\Arcane\\ArcanePipeGuard.exe','C:\\Arcane\\ArcaneCore.exe',{},{}),
  (error)=>error?.code==='PRIVILEGE_PIPE_GUARD_TRUST_FAILED',
);
assert(signatureScripts.every((entry)=>entry.options.purpose==='verify-arcane-pipe-guard-signature'));
assert.match(signatureScripts[0].script,/Get-AuthenticodeSignature/);

if (process.platform === 'win32') {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const policyAssignmentLine=listUsersCall.script.split(/\r?\n/).find((line)=>line.trim().startsWith('$policyAssigned='));
  const legacyAssignmentLine=listUsersCall.script.split(/\r?\n/).find((line)=>line.trim().startsWith('$legacyAssigned='));
  const assignmentLine=listUsersCall.script.split(/\r?\n/).find((line)=>line.trim().startsWith('$assigned='));
  assert(policyAssignmentLine && legacyAssignmentLine && assignmentLine, 'Windows user discovery must contain both exact shell-identity decisions.');
  const identityCases=[
    {name:'exact-dual',policy:expectedShell,legacy:expectedShell,expected:true},
    {name:'policy-only',policy:expectedShell,legacy:null,expected:false},
    {name:'legacy-only',policy:null,legacy:expectedShell,expected:false},
    {name:'wrong-policy-path',policy:expectedShell.replace('C:\\Program Files\\Arcane OS','C:\\Arcane Lookalike'),legacy:expectedShell,expected:false},
    {name:'extra-legacy-argument',policy:expectedShell,legacy:`${expectedShell} --extra-argument`,expected:false},
    {name:'case-altered-policy',policy:expectedShell.replace('ArcaneShell.exe','arcaneshell.exe'),legacy:expectedShell,expected:false},
  ];
  const psLiteral=(value)=>`'${String(value).replaceAll("'","''")}'`;
  const identityScript=`$ErrorActionPreference='Stop'\n$expected=${psLiteral(expectedShell)}\n$verified=$true\n$results=@()\n${identityCases.map((item)=>`$policyShellPresent=${item.policy === null ? '$false' : '$true'}\n$legacyShellPresent=${item.legacy === null ? '$false' : '$true'}\n$policyShell=${psLiteral(item.policy || '')}\n$legacyShell=${psLiteral(item.legacy || '')}\n${policyAssignmentLine}\n${legacyAssignmentLine}\n${assignmentLine}\n$results += [pscustomobject]@{name=${psLiteral(item.name)};assigned=$assigned}`).join('\n')}\n$results|ConvertTo-Json -Compress`;
  const identityResult=spawnProcessSync(powershell,['-NoProfile','-NonInteractive','-Command',identityScript],{
    encoding:'utf8',
    windowsHide:true,
  });
  assert.equal(identityResult.status,0,`PowerShell shell-identity cases failed:\n${identityResult.stdout||identityResult.stderr}`);
  const identityOutput=JSON.parse(String(identityResult.stdout).trim());
  assert.deepEqual(identityOutput.map((item)=>({name:item.name,expected:item.assigned})),identityCases.map(({name,expected})=>({name,expected})));
  const parserCommand = "$source=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}";
  for (const entry of [...scripts,...signatureScripts]) {
    const parsed = spawnProcessSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', parserCommand], {
      input: entry.script,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(parsed.status, 0, `${entry.options.purpose || 'PowerShell adapter script'} did not parse:\n${parsed.stdout || parsed.stderr}`);
  }
}

console.log('Arcane Windows native adapter smoke test passed.');
