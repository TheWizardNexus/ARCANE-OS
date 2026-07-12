import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync as spawnProcessSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8');
const coreSource = await fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8');
assert.match(coreSource,/stage = `\$\{PATHS\.installRoot\}\.stage-\$\{process\.pid\}-\$\{simulate \? Date\.now\(\) : crypto\.randomBytes\(24\)\.toString\('hex'\)\}`/,
  'real install stages must use an unpredictable 192-bit name');
assert.doesNotMatch(coreSource,/fsp\.rm\(stage, \{ recursive: true, force: true \}\)/,
  'installation must never pre-delete an unowned path before atomic stage creation');
const sandbox = {
  process:{ env:{ SystemRoot:'C:\\Windows' },arch:'x64' },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(`${source}\nglobalThis.createAdapter=createWindowsNativeAdapter;`,sandbox,{
  filename:'windows.cjs',
});

function coreFunctionSource(start,end){
  const from=coreSource.indexOf(start);
  const to=coreSource.indexOf(end,from);
  assert.notEqual(from,-1,`Missing Core ${start}`);
  assert.notEqual(to,-1,`Missing Core boundary ${end}`);
  return coreSource.slice(from,to);
}

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

{
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'arcane-install-stage-'));
  const installRoot=path.join(fixture,'Arcane OS');
  const priorInstallRoot=sandbox.process.env.ARCANE_INSTALL_ROOT;
  sandbox.process.env.ARCANE_INSTALL_ROOT=installRoot;
  const cleanupLogs=[];
  try {
    const stageAdapter=sandbox.createAdapter({
      simulate:false,
      production:false,
      path,
      fs:fsSync,
      fsp:fs,
      actionLog(action,level,message,details){cleanupLogs.push({level,message,details});},
    });
    const stage=`${installRoot}.stage-123-${'a'.repeat(48)}`;
    await fs.mkdir(stage);
    await fs.writeFile(path.join(stage,'owned.txt'),'owned');
    const ownership=stageAdapter.captureInstallStageOwnership(stage);
    assert.equal(stageAdapter.installStageOwnershipStatus(ownership,stage).state,'owned');
    const cleaned=await stageAdapter.cleanupInstallStage(ownership,stage,{});
    assert.equal(cleaned.removed,true,'the exact owned install stage must be cleaned after failure');
    await assert.rejects(fs.access(stage));

    const replacedStage=`${installRoot}.stage-124-${'b'.repeat(48)}`;
    const displaced=path.join(fixture,'displaced-owned-stage');
    await fs.mkdir(replacedStage);
    const replacedOwnership=stageAdapter.captureInstallStageOwnership(replacedStage);
    await fs.rename(replacedStage,displaced);
    await fs.mkdir(replacedStage);
    await fs.writeFile(path.join(replacedStage,'do-not-delete.txt'),'replacement');
    const preservedReplacement=await stageAdapter.cleanupInstallStage(replacedOwnership,replacedStage,{});
    assert.equal(preservedReplacement.preserved,true,'a replacement at the old stage path must be preserved');
    assert.equal(await fs.readFile(path.join(replacedStage,'do-not-delete.txt'),'utf8'),'replacement');

    const outside=path.join(fixture,'outside-recovery-tree');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside,'do-not-delete.txt'),'outside');
    const preservedOutside=await stageAdapter.cleanupInstallStage(replacedOwnership,outside,{});
    assert.equal(preservedOutside.preserved,true,'cleanup must reject a candidate outside the exact install stage/recovery paths');
    assert.equal(await fs.readFile(path.join(outside,'do-not-delete.txt'),'utf8'),'outside');

    const activatedStage=`${installRoot}.stage-125-${'c'.repeat(48)}`;
    const failedTree=`${installRoot}.failed-125`;
    await fs.mkdir(activatedStage);
    await fs.writeFile(path.join(activatedStage,'activated.txt'),'failed-activation');
    const activatedOwnership=stageAdapter.captureInstallStageOwnership(activatedStage);
    await fs.rename(activatedStage,installRoot);
    assert.equal(stageAdapter.installStageOwnershipStatus(activatedOwnership,installRoot).state,'owned');
    await fs.rename(installRoot,failedTree);
    assert.equal(stageAdapter.installStageOwnershipStatus(activatedOwnership,failedTree).state,'owned');
    const cleanedFailure=await stageAdapter.cleanupInstallStage(activatedOwnership,failedTree,{});
    assert.equal(cleanedFailure.removed,true,'the same owned stage may be cleaned after an activation rollback rename');
    assert(cleanupLogs.some((entry)=>entry.message.includes('filesystem identity could not be proven')),'uncertain cleanup must be visibly preserved');
  } finally {
    if(priorInstallRoot===undefined)delete sandbox.process.env.ARCANE_INSTALL_ROOT;
    else sandbox.process.env.ARCANE_INSTALL_ROOT=priorInstallRoot;
    await fs.rm(fixture,{recursive:true,force:true});
  }
}

async function runInstallStageFailure(failurePoint){
  const fixture=await fs.mkdtemp(path.join(os.tmpdir(),`arcane-install-${failurePoint}-`));
  const installRoot=path.join(fixture,'Arcane OS');
  const stateRoot=path.join(fixture,'state');
  const sourceFile=path.join(fixture,'verified-payload.txt');
  const outside=path.join(fixture,'outside-recovery-tree');
  await fs.writeFile(sourceFile,'verified payload');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'preserve.txt'),'preserve');
  const priorInstallRoot=sandbox.process.env.ARCANE_INSTALL_ROOT;
  sandbox.process.env.ARCANE_INSTALL_ROOT=installRoot;
  try {
    const logs=[];
    let capturedInstallManifest=null;
    const stageAdapter=sandbox.createAdapter({
      simulate:false,
      production:false,
      path,
      fs:fsSync,
      fsp:fs,
      actionLog(action,level,message,details){logs.push({level,message,details});},
    });
    const native={
      ...stageAdapter,
      async acquireInstallLease(){return {test:true};},
      async releaseInstallLease(){},
      installPayload(){
        return {
          mode:'windows-webview2',
          releaseReady:true,
          selfHosted:false,
          files:[{source:sourceFile,installPath:'payload.txt'}],
          directories:[],
        };
      },
      assertNoRunningInstalledApplications(){},
      async writeLaunchers(){
        if(failurePoint==='pre-activation')throw new Error('synthetic pre-activation failure');
      },
      verifyStagedInstallation(){return {verified:true};},
      async applyInstallPermissions(){
        if(failurePoint==='activation')throw new Error('synthetic activation failure');
      },
      async applyStatePermissions(){},
    };
    const context=vm.createContext({
      native,
      simulate:false,
      platform:'win32',
      allowSourceInstall:false,
      PATHS:{installRoot,stateRoot},
      VERSION:'0.8.2',
      BUNDLE_MANIFEST:{requirements:{}},
      process:{pid:8123},
      crypto,
      fsp:fs,
      fs:fsSync,
      path,
      bundleRoot(){return fixture;},
      async recoverInterruptedInstallation(){return {recovered:false};},
      actionLog(action,level,message,details){logs.push({level,message,details});},
      normalizeIntegrityPath(value){return String(value);},
      integrityFilePath(base,relative){return path.join(base,...String(relative).split('/'));},
      async ensureDir(directory){await fs.mkdir(directory,{recursive:true});},
      async copyTree(){throw new Error('copyTree must not run for the native fixture');},
      verifyIntegrityEntries(){return {ok:true};},
      createInstalledIntegrity(){return {schemaVersion:2,hashAlgorithm:'sha256',scope:'installed-tree',files:[]};},
      currentIdentity(){return {username:'tester'};},
      osInfo(){return {platform:'windows'};},
      activeReleaseSecurityMode(){return 'unsigned-local-test';},
      async writeFile(file,contents){
        if(path.basename(file)==='arcane-install.json')capturedInstallManifest=JSON.parse(String(contents));
        await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);
      },
      verifyInstalledIntegrity(){return {ok:true};},
      async durableWriteFile(file,contents){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents);},
      readJsonFile(){return null;},
      verifyInstalledIntegrityAt(){return {ok:false,reason:'legacy'};},
      async snapshotActiveInstallationForRollback(){return null;},
      stamp(){return new Date(0).toISOString();},
      arcaneError(code,message,resolution,status,details){return Object.assign(new Error(message),{code,resolution,status,details});},
    });
    vm.runInContext(coreFunctionSource('async function installArcaneGlobally(action)', 'async function ensureArcaneInstallation'),context);
    await assert.rejects(
      context.installArcaneGlobally({id:`failure-${failurePoint}`}),
      new RegExp(`synthetic ${failurePoint} failure`),
    );
    if(failurePoint==='activation')assert.equal(capturedInstallManifest.securityMode,'unsigned-local-test','new installations must persist their verified security mode');
    const leftovers=(await fs.readdir(fixture)).filter((name)=>name.startsWith('Arcane OS.stage-')||name.startsWith('Arcane OS.failed-'));
    assert.deepEqual(leftovers,[],`${failurePoint} failure must clean the exact owned stage and failed activation tree`);
    assert.equal(await fs.readFile(path.join(outside,'preserve.txt'),'utf8'),'preserve','install cleanup must not remove an unrelated recovery tree');
  } finally {
    if(priorInstallRoot===undefined)delete sandbox.process.env.ARCANE_INSTALL_ROOT;
    else sandbox.process.env.ARCANE_INSTALL_ROOT=priorInstallRoot;
    await fs.rm(fixture,{recursive:true,force:true});
  }
}

await runInstallStageFailure('pre-activation');
await runInstallStageFailure('activation');

{
  const elevationScripts=[];
  const elevationAdapter=sandbox.createAdapter({
    simulate:false,
    production:true,
    processPkg:true,
    allowUnsignedLocalRelease:true,
    releaseSecurityModeClaim:'unsigned-local-test',
    path:path.win32,
    psQuote(value){ return `'${String(value).replaceAll("'","''")}'`; },
    powershell:async(script,options)=>{
      elevationScripts.push({script,options});
      return {stdout:'4242\n'};
    },
  });
  const elevated=await elevationAdapter.launchElevated(
    'C:\\Arcane\\ArcaneCore.exe',
    ['--privileged-worker','--allow-unsigned-local-release'],
    {},
  );
  assert.equal(elevated.launcherPid,4242);
  assert.match(elevationScripts[0].script,/\$env:ARCANE_RELEASE_SECURITY_MODE='unsigned-local-test'/);

  elevationScripts.length=0;
  await elevationAdapter.launchElevated('C:\\Arcane\\ArcaneCore.exe',['--privileged-worker'],{});
  assert.match(elevationScripts[0].script,/ARCANE_RELEASE_TIMESTAMP_VERIFIED/);
  assert.match(elevationScripts[0].script,/Remove-Item -LiteralPath \('Env:'\+\$name\)/);

  const signedScripts=[];
  const signedAdapter=sandbox.createAdapter({
    simulate:false,
    production:true,
    processPkg:true,
    allowUnsignedLocalRelease:false,
    releaseSecurityModeClaim:'publisher-verified',
    releaseContentBindingClaim:'ARCANE-MACHINE-BINDING|1|0.8.2|'+'a'.repeat(64),
    releaseSignerThumbprintClaim:'A'.repeat(40),
    releaseVerifiedAtClaim:new Date().toISOString(),
    releaseRevocationStatusClaim:'online-good',
    releaseTrustSourceClaim:'administrator-policy',
    releaseTimestampVerifiedClaim:true,
    path:path.win32,
    psQuote(value){ return `'${String(value).replaceAll("'","''")}'`; },
    powershell:async(script)=>{ signedScripts.push(script); return {stdout:'4243\n'}; },
  });
  await signedAdapter.launchElevated('C:\\Arcane\\ArcaneCore.exe',['--privileged-worker'],{});
  assert.match(signedScripts[0],/\$env:ARCANE_RELEASE_SECURITY_MODE='publisher-verified'/);
  assert.match(signedScripts[0],/\$env:ARCANE_RELEASE_CONTENT_BINDING='ARCANE-MACHINE-BINDING\|1\|0\.8\.2\|a{64}'/);
  assert.match(signedScripts[0],/\$env:ARCANE_RELEASE_SIGNER_THUMBPRINT='A{40}'/);
  assert.match(signedScripts[0],/\$env:ARCANE_RELEASE_REVOCATION_STATUS='online-good'/);
  assert.match(signedScripts[0],/\$env:ARCANE_RELEASE_TIMESTAMP_VERIFIED='1'/);
}

const scripts=[];
const hardened=sandbox.createAdapter({
  simulate:false,
  production:true,
  releaseSecurityModeClaim:'publisher-verified',
  releaseContentBindingClaim:'ARCANE-MACHINE-BINDING|1|0.8.2|'+'a'.repeat(64),
  releaseSignerThumbprintClaim:'A'.repeat(40),
  releaseVerifiedAtClaim:new Date().toISOString(),
  releaseRevocationStatusClaim:'online-good',
  releaseTrustSourceClaim:'administrator-policy',
  releaseTimestampVerifiedClaim:true,
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
staged.shell=hardened.shellCommand();
staged.securityMode='publisher-verified';
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
assert.match(
  provisionCall.script,
  /if\(\$created\)\{\s*\$usersGroupSid='S-1-5-32-545'[\s\S]+?Add-LocalGroupMember[\s\S]+?\n\}/,
  'Arcane must add only an account created by this transaction to the built-in Users group',
);
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
assert.equal(expectedShell,'"C:\\Program Files\\Arcane OS\\bin\\ArcaneShell.exe" --shell');
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

{
  const accounts=new Set(['existing']);
  const bindings=new Map([['existing',{
    username:'existing',
    enabled:true,
    policyShell:'explorer.exe',
    policyShellPresent:true,
    legacyShell:'explorer.exe',
    legacyShellPresent:true,
  }]]);
  const unsigned=sandbox.createAdapter(simulatedAdapterContext(accounts,bindings,{
    allowUnsignedLocalRelease:true,
    releaseSecurityModeClaim:'unsigned-local-test',
  }));
  const unsignedShell='"C:\\Program Files\\Arcane OS\\bin\\ArcaneShell.exe" --shell --allow-unsigned-local-release';
  assert.equal(unsigned.shellCommand(),unsignedShell,'unsigned-local shell assignment must carry the fixed host override');
  const backup=await unsigned.prepareUserShellBackup('existing',{});
  const assigned=await unsigned.provisionUser('existing','protected',{},backup);
  assert.equal(assigned.shell,unsignedShell);
  assert.equal((await unsigned.listArcaneUsers(['existing']))[0].shellAssigned,true,'unsigned detection must require the exact flagged command');

  const repaired=sandbox.createAdapter(simulatedAdapterContext(accounts,bindings));
  const beforeRepair=(await repaired.listArcaneUsers(['existing']))[0];
  assert.equal(beforeRepair.shellAssigned,false,'signed mode must not mistake the old unsigned command for its normalized assignment');
  assert.equal(beforeRepair.policyShell,unsignedShell);
  await repaired.restoreUserShell('existing',{
    ...backup,
    shell:unsignedShell,
    securityMode:'unsigned-local-test',
    shellMutationPhase:'assigned',
  },{});
  assert.equal(bindings.get('existing').policyShell,'explorer.exe','signed repair must restore the protected original baseline first');
  assert.equal(bindings.get('existing').legacyShell,'explorer.exe');
  const signedBackup=await repaired.prepareUserShellBackup('existing',{});
  const signedAssignment=await repaired.provisionUser('existing','protected',{},signedBackup);
  assert.equal(signedAssignment.shell,expectedShell,'signed repair must normalize the assignment without preserving the stale unsigned flag');
  await assert.rejects(
    ()=>repaired.restoreUserShell('existing',{...signedBackup,shell:'third-party.exe',shellMutationPhase:'assigned'},{}),
    (error)=>error?.code==='INVALID_SHELL_BACKUP',
    'protected recovery still rejects a non-canonical recorded shell command',
  );
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
  releaseSecurityModeClaim:'publisher-verified',
  releaseContentBindingClaim:'ARCANE-MACHINE-BINDING|1|0.8.2|'+'a'.repeat(64),
  releaseSignerThumbprintClaim:'A'.repeat(40),
  releaseVerifiedAtClaim:new Date().toISOString(),
  releaseRevocationStatusClaim:'online-good',
  releaseTrustSourceClaim:'administrator-policy',
  releaseTimestampVerifiedClaim:true,
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
const unsignedSignatureAdapter=sandbox.createAdapter({
  simulate:false,
  production:true,
  allowUnsignedLocalRelease:true,
  releaseSecurityModeClaim:'unsigned-local-test',
  path:path.win32,
  fs:{ existsSync(){ return true; }, statSync(){ return {isFile:()=>true}; } },
  psQuote(value){ return `'${String(value).replaceAll("'","''")}'`; },
  arcaneError(code,message){ return Object.assign(new Error(message),{code}); },
  actionLog(){},
  powershell:async()=>({stdout:`${JSON.stringify([{status:'NotSigned',thumbprint:null,subject:null},{status:'NotSigned',thumbprint:null,subject:null}])}\n`}),
});
const unsignedTrust=await unsignedSignatureAdapter.verifyPrivilegePipeGuardTrust(
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
