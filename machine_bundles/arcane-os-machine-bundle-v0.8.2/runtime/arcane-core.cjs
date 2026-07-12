#!/usr/bin/env node
'use strict';

const http = require('node:http');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Duplex } = require('node:stream');

function createWindowsNativeAdapter(ctx) {
  'use strict';

  const env = process.env;
  const programFiles = ctx.production ? 'C:\\Program Files' : env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = ctx.production ? 'C:\\Program Files (x86)' : env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const systemRoot = ctx.production ? 'C:\\Windows' : env.SystemRoot || 'C:\\Windows';
  const programData = ctx.production ? 'C:\\ProgramData' : env.ProgramData || 'C:\\ProgramData';
  const system32 = ctx.path.join(systemRoot, 'System32');
  const powershellExe = ctx.path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const whereExe = ctx.path.join(system32, 'where.exe');
  const scExe = ctx.path.join(system32, 'sc.exe');
  const icaclsExe = ctx.path.join(system32, 'icacls.exe');
  const cmdExe = ctx.path.join(system32, 'cmd.exe');
  const rundll32Exe = ctx.path.join(system32, 'rundll32.exe');
  const regExe = ctx.path.join(system32, 'reg.exe');
  const simulatedAccounts = new Set();
  const simulatedUsers = new Map();

  function unloadTemporaryHiveScript(context) {
    return `$key=$null;$previous=$null;$remaining=$null
    $arcaneHiveReleased=$false
    for($arcaneUnloadAttempt=0;$arcaneUnloadAttempt -lt 20;$arcaneUnloadAttempt++){
      [gc]::Collect();[gc]::WaitForPendingFinalizers();Start-Sleep -Milliseconds 250
      & ${ctx.psQuote(regExe)} unload "HKU\\$hive" | Out-Null
      if($LASTEXITCODE -eq 0){$arcaneHiveReleased=$true;break}
    }
    if(-not $arcaneHiveReleased){throw "Windows could not release the temporary Arcane registry hive after ${context}. The profile remains locked and requires administrator recovery."}`;
  }
  const paths = Object.freeze({
    installRoot: !ctx.production && env.ARCANE_INSTALL_ROOT || ctx.path.join(programFiles, 'Arcane OS'),
    stateRoot: !ctx.production && env.ARCANE_STATE_ROOT || ctx.path.join(programData, 'Arcane OS', 'state'),
    nodeRoot: ctx.path.join(programFiles, 'nodejs'),
    ollamaRoot: ctx.path.join(programFiles, 'Ollama'),
    modelsRoot: ctx.path.join(programData, 'Arcane OS', 'ollama-models'),
  });

  function commandExists(command) {
    return ctx.spawnSync(whereExe, [command], { stdio: 'ignore', windowsHide: true }).status === 0;
  }

  function candidateExecutable(candidates) {
    for (const value of candidates.filter(Boolean)) {
      if (ctx.path.isAbsolute(value)) {
        if (ctx.fs.existsSync(value)) return value;
      } else if (!ctx.production && commandExists(value)) return value;
    }
    return null;
  }

  function currentIdentity() {
    let username = env.USERNAME || 'unknown';
    try { username = ctx.os.userInfo().username || username; } catch (_) {}
    const domain = env.USERDOMAIN || '';
    return {
      username,
      accountName: (domain ? domain + '\\' : '') + username,
      displayName: env.ARCANE_DISPLAY_NAME || username,
      computerName: env.COMPUTERNAME || ctx.os.hostname(),
      domain: domain || null,
      source: 'windows',
    };
  }

  function protectedUsernames(elevationProtectedUsername) {
    const values = [elevationProtectedUsername, currentIdentity().username]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    return [...new Map(values.map((value) => [value.toLowerCase(), value])).values()];
  }

  function osInfo(simulatedPlatform) {
    return {
      platform: 'windows',
      rawPlatform: 'win32',
      displayName: 'Windows',
      architecture: process.arch,
      hostname: ctx.os.hostname(),
      release: ctx.os.release(),
      desktop: null,
      sessionType: null,
      simulated: Boolean(simulatedPlatform),
      adapter: 'windows',
    };
  }

  let elevatedTrueCache = null;
  function permissionStatus(options) {
    const refresh = Boolean(options && options.refresh);
    if (ctx.simulate) {
      return {
        elevated: true,
        level: 'administrator',
        canElevate: true,
        mechanism: 'simulation',
        detectedBy: 'simulation',
        probes: [{ id: 'simulation', ok: true, exitCode: 0 }],
      };
    }
    if (!ctx.production && process.env.ARCANE_FORCE_ELEVATED === '1') {
      return {
        elevated: true,
        level: 'administrator',
        canElevate: true,
        mechanism: 'forced',
        detectedBy: 'environment-override',
        probes: [{ id: 'environment-override', ok: true, exitCode: 0 }],
      };
    }
    if (!ctx.production && process.env.ARCANE_FORCE_ELEVATED === '0') {
      return {
        elevated: false,
        level: 'standard',
        canElevate: true,
        mechanism: 'uac',
        detectedBy: 'environment-override',
        probes: [{ id: 'environment-override', ok: false, exitCode: 1 }],
      };
    }
    if (!refresh && elevatedTrueCache) return elevatedTrueCache;

    const probes = [];
    const whoami = ctx.path.join(systemRoot, 'System32', 'whoami.exe');
    const whoamiResult = ctx.spawnSync(whoami, ['/groups', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    const groups = `${whoamiResult.stdout || ''}\n${whoamiResult.stderr || ''}`;
    const integrityMatch = groups.match(/S-1-16-(12288|16384)/i);
    probes.push({
      id: 'integrity-level',
      ok: Boolean(whoamiResult.status === 0 && integrityMatch),
      exitCode: whoamiResult.status,
      detail: integrityMatch ? `S-1-16-${integrityMatch[1]}` : null,
    });
    if (whoamiResult.status === 0 && integrityMatch) {
      elevatedTrueCache = {
        elevated: true,
        level: integrityMatch[1] === '16384' ? 'system' : 'administrator',
        canElevate: true,
        mechanism: 'uac',
        detectedBy: 'integrity-level',
        probes,
      };
      return elevatedTrueCache;
    }

    // `net session` is a practical secondary probe for a high-integrity
    // administrator token. It may fail when the Server service is disabled,
    // so failure is not treated as definitive.
    const netExe = ctx.path.join(systemRoot, 'System32', 'net.exe');
    const netResult = ctx.spawnSync(netExe, ['session'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    probes.push({ id: 'net-session', ok: netResult.status === 0, exitCode: netResult.status });
    if (netResult.status === 0) {
      elevatedTrueCache = {
        elevated: true,
        level: 'administrator',
        canElevate: true,
        mechanism: 'uac',
        detectedBy: 'net-session',
        probes,
      };
      return elevatedTrueCache;
    }

    const fallback = ctx.spawnSync(powershellExe, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      '[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))',
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const principalAdmin = String(fallback.stdout || '').trim().toLowerCase() === 'true';
    probes.push({ id: 'windows-principal', ok: principalAdmin, exitCode: fallback.status });
    if (principalAdmin) {
      elevatedTrueCache = {
        elevated: true,
        level: 'administrator',
        canElevate: true,
        mechanism: 'uac',
        detectedBy: 'windows-principal',
        probes,
      };
      return elevatedTrueCache;
    }

    return {
      elevated: false,
      level: 'standard',
      canElevate: true,
      mechanism: 'uac',
      detectedBy: 'none',
      probes,
    };
  }

  function isElevated(refresh) {
    return permissionStatus({ refresh: Boolean(refresh) }).elevated;
  }

  function hideHostWindow() {
    if (!ctx.hideConsole || ctx.processPkg) return;
    // windowsHide must remain false here so PowerShell attaches to the current
    // console and can hide the shared console window rather than a new one.
    const script = "Add-Type -Namespace Arcane -Name Native -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);'; $h=[Arcane.Native]::GetConsoleWindow(); if($h -ne [IntPtr]::Zero){[Arcane.Native]::ShowWindow($h,0)|Out-Null}";
    ctx.spawnSync(powershellExe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: false,
    });
  }

  function nodeExecutable() {
    return candidateExecutable([ctx.path.join(paths.nodeRoot, 'node.exe')]);
  }

  function ollamaExecutable() {
    return candidateExecutable([
      ctx.path.join(paths.ollamaRoot, 'ollama.exe'),
      ctx.path.join(paths.ollamaRoot, 'bin', 'ollama.exe'),
    ]);
  }

  function browserCandidates() {
    return [
      !ctx.production&&env.ARCANE_BROWSER_PATH,
      ctx.path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ctx.path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      !ctx.production&&env.LOCALAPPDATA && ctx.path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ctx.path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter(Boolean).filter((value) => ctx.path.isAbsolute(value) ? ctx.fs.existsSync(value) : commandExists(value));
  }

  function browserExecutable() {
    return browserCandidates()[0] || null;
  }

  function rendererStatus() {
    if (ctx.simulate) return { id: 'webview2', available: true, executable: 'Microsoft Edge WebView2 Runtime', version: 'simulated', adapter: 'windows-webview2' };
    const reg = ctx.path.join(systemRoot, 'System32', 'reg.exe');
    const guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
    const keys = [
      `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${guid}`,
      `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${guid}`,
      `HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${guid}`,
    ];
    for (const key of keys) {
      const result = ctx.spawnSync(reg, ['query', key, '/v', 'pv'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (result.status !== 0) continue;
      const match = String(result.stdout || '').match(/\bpv\s+REG_SZ\s+([^\r\n]+)/i);
      const version = match ? match[1].trim() : null;
      if (version && version !== '0.0.0.0') return { id: 'webview2', available: true, executable: 'Microsoft Edge WebView2 Runtime', version, registryKey: key, adapter: 'windows-webview2' };
    }
    return { id: 'webview2', available: false, executable: null, version: null, adapter: 'windows-webview2' };
  }

  async function verifyMicrosoftSignature(file, action) {
    const script = `$signature=Get-AuthenticodeSignature -LiteralPath ${ctx.psQuote(file)}
$subject=if($signature.SignerCertificate){$signature.SignerCertificate.Subject}else{$null}
[pscustomobject]@{status=[string]$signature.Status;subject=$subject}|ConvertTo-Json -Compress`;
    const result = await ctx.powershell(script, { action, purpose: 'verify-microsoft-signature' });
    let signature = null;
    try { signature = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()); } catch (_) {}
    if (!signature || signature.status !== 'Valid' || !/\bMicrosoft Corporation\b/i.test(String(signature.subject || ''))) {
      throw ctx.arcaneError(
        'UNTRUSTED_INSTALLER_SIGNATURE',
        'Windows could not verify this installer as a valid Microsoft-signed file.',
        'The installer was not executed. Install the Microsoft Edge WebView2 Evergreen Runtime manually from Microsoft.',
        409,
        { signature }
      );
    }
    ctx.actionLog(action, 'info', 'Verified the Microsoft Authenticode signature.', signature);
  }

  async function verifyPrivilegePipeGuardTrust(guardFile, coreFile, options, action) {
    if (ctx.simulate) return { trusted: true, simulated: true, unsignedLocal: false };
    for (const file of [guardFile, coreFile]) {
      if (!ctx.path.isAbsolute(file) || !ctx.fs.existsSync(file) || !ctx.fs.statSync(file).isFile()) {
        throw ctx.arcaneError(
          'PRIVILEGE_PIPE_GUARD_TRUST_FAILED',
          'Arcane could not verify its Windows privilege boundary executables.',
          'Repair or reinstall Arcane OS from a verified signed release.'
        );
      }
    }
    const script = `$ErrorActionPreference='Stop'
$records=@()
foreach($file in @(${ctx.psQuote(coreFile)},${ctx.psQuote(guardFile)})){
  $signature=Get-AuthenticodeSignature -LiteralPath $file
  $records += [pscustomobject]@{
    path=$file
    status=[string]$signature.Status
    thumbprint=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Thumbprint}else{$null}
    subject=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Subject}else{$null}
  }
}
ConvertTo-Json -InputObject @($records) -Compress`;
    const result = await ctx.powershell(script, {
      action,
      purpose: 'verify-arcane-pipe-guard-signature',
      redactArgs: true,
      displayCommand: '$ powershell.exe [verify Arcane privilege boundary signatures]',
    });
    let signatures = null;
    try { signatures = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()); } catch (_) {}
    if (!Array.isArray(signatures) || signatures.length !== 2) {
      throw ctx.arcaneError(
        'PRIVILEGE_PIPE_GUARD_TRUST_FAILED',
        'Windows did not return valid signature records for the Arcane privilege boundary.',
        'Repair or reinstall Arcane OS from a verified signed release.'
      );
    }
    const [coreSignature, guardSignature] = signatures;
    const coreThumbprint = String(coreSignature && coreSignature.thumbprint || '').replace(/\s/g, '').toUpperCase();
    const guardThumbprint = String(guardSignature && guardSignature.thumbprint || '').replace(/\s/g, '').toUpperCase();
    if (coreSignature.status === 'Valid' && guardSignature.status === 'Valid' && /^[A-F0-9]{40,128}$/.test(coreThumbprint) && guardThumbprint === coreThumbprint) {
      ctx.actionLog(action, 'info', 'Verified ArcanePipeGuard and ArcaneCore share the same valid Authenticode signer.', {
        signerSubject: guardSignature.subject || null,
        signerThumbprint: guardThumbprint,
      });
      return { trusted: true, signed: true, unsignedLocal: false, signerThumbprint: guardThumbprint };
    }
    const unsignedLocal = Boolean(options && options.allowUnsignedLocalRelease)
      && coreSignature.status === 'NotSigned'
      && guardSignature.status === 'NotSigned';
    if (unsignedLocal) {
      ctx.actionLog(action, 'warn', 'Using the explicit unsigned-local-release test mode; SHA-256 release binding is still required.', {
        coreStatus: coreSignature.status,
        guardStatus: guardSignature.status,
      });
      return { trusted: false, signed: false, unsignedLocal: true };
    }
    throw ctx.arcaneError(
      'PRIVILEGE_PIPE_GUARD_TRUST_FAILED',
      'Arcane refused to start its Windows privilege pipe guard because its Authenticode signer does not match Arcane Core.',
      'Install a distribution-signed Arcane release. For controlled local testing only, launch the unsigned local build with --allow-unsigned-local-release.',
      409,
      {
        coreStatus: coreSignature && coreSignature.status || null,
        guardStatus: guardSignature && guardSignature.status || null,
      }
    );
  }

  async function installRenderer(action) {
    if (ctx.simulate) {
      ctx.actionLog(action, 'info', 'Simulation: would install the Microsoft Edge WebView2 Evergreen Runtime.');
      return;
    }
    const setup = ctx.tempPath('MicrosoftEdgeWebview2Setup.exe');
    await ctx.download('https://go.microsoft.com/fwlink/p/?LinkId=2124703', setup, action);
    await verifyMicrosoftSignature(setup, action);
    await ctx.run(setup, ['/silent', '/install'], { action, displayCommand: '$ MicrosoftEdgeWebview2Setup.exe /silent /install' });
    const status = rendererStatus();
    if (!status.available) throw ctx.arcaneError('WEBVIEW2_INSTALL_FAILED', 'Microsoft Edge WebView2 Runtime did not become available after installation.', 'Restart Windows and try again, or install the Evergreen WebView2 Runtime manually from Microsoft.');
    ctx.actionLog(action, 'info', `Microsoft Edge WebView2 Runtime ${status.version || ''} is ready.`);
  }

  function sessionControlExecutable() {
    const executable = ctx.path.join(systemRoot, 'System32', 'shutdown.exe');
    return ctx.fs.existsSync(executable) || ctx.simulate ? executable : null;
  }

  function lockSpec() {
    return [rundll32Exe, ['user32.dll,LockWorkStation']];
  }

  function logoutSpec() {
    const executable = sessionControlExecutable();
    return executable ? [executable, ['/l']] : null;
  }

  function provisionerCandidates(base, installRoot) {
    return [
      ctx.path.join(base, 'ArcaneProvisioner.exe'),
      ctx.path.join(installRoot, 'bin', 'ArcaneProvisioner.exe'),
      ctx.path.join(installRoot, 'bin', 'arcane-provisioner.cmd'),
    ];
  }

  function nodeArchiveName(version) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return `node-${version}-${arch}.msi`;
  }

  async function installNodePackage(packageFile, release, action) {
    await ctx.run(ctx.path.join(systemRoot, 'System32', 'msiexec.exe'), [
      '/i', packageFile, '/qn', '/norestart', 'ADDLOCAL=ALL',
    ], { action });
    ctx.actionLog(action, 'info', `Node.js ${release.version} installation completed.`);
  }

  async function installOllama(action) {
    if (ctx.simulate) {
      ctx.actionLog(action, 'info', 'Simulation: would install the latest official Ollama Windows package and service.');
      return;
    }
    const release = await ctx.latestOllamaRelease();
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    let asset = release.assets.find((item) => item.name === `ollama-windows-${arch}.zip`);
    if (!asset && arch === 'arm64') asset = release.assets.find((item) => item.name === 'ollama-windows-amd64.zip');
    if (!asset) throw ctx.arcaneError('OLLAMA_PACKAGE_NOT_FOUND', 'Arcane could not find a compatible official Ollama Windows package.', 'Check the internet connection or install Ollama manually, then choose Check again.');

    const zipFile = ctx.tempPath(asset.name);
    await ctx.download(asset.browser_download_url, zipFile, action);
    const digestMatch = /^sha256:([a-f0-9]{64})$/i.exec(String(asset.digest || ''));
    if (!digestMatch) {
      throw ctx.arcaneError(
        'OLLAMA_DIGEST_UNAVAILABLE',
        'The official Ollama release did not provide a SHA-256 digest for this package.',
        'Arcane did not install the unverified package. Install Ollama manually from the official release, then choose Check again.',
        409
      );
    }
    const actualDigest = await ctx.sha256(zipFile);
    if (actualDigest.toLowerCase() !== digestMatch[1].toLowerCase()) {
      throw ctx.arcaneError(
        'OLLAMA_CHECKSUM_MISMATCH',
        'The downloaded Ollama package did not match its official SHA-256 digest.',
        'The package was not installed. Check the network and try again.',
        409
      );
    }
    ctx.actionLog(action, 'info', `Verified Ollama ${release.version || 'latest'} SHA-256.`, { sha256: actualDigest });
    await ctx.ensureDir(paths.ollamaRoot);
    await ctx.fsp.rm(paths.ollamaRoot, { recursive: true, force: true });
    await ctx.fsp.mkdir(paths.ollamaRoot, { recursive: true });
    await ctx.powershell(`Expand-Archive -LiteralPath ${ctx.psQuote(zipFile)} -DestinationPath ${ctx.psQuote(paths.ollamaRoot)} -Force`, { action });

    const findExe = (directory) => {
      if (!ctx.fs.existsSync(directory)) return null;
      for (const entry of ctx.fs.readdirSync(directory, { withFileTypes: true })) {
        const full = ctx.path.join(directory, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === 'ollama.exe') return full;
        if (entry.isDirectory()) {
          const found = findExe(full);
          if (found) return found;
        }
      }
      return null;
    };

    const executable = findExe(paths.ollamaRoot);
    if (!executable) throw ctx.arcaneError('OLLAMA_EXECUTABLE_NOT_FOUND', 'Ollama was downloaded, but its executable could not be located.', 'Retry the installation. If it continues to fail, install Ollama manually and choose Check again.');
    await ctx.ensureDir(paths.modelsRoot);
    await ctx.run(scExe, ['stop', 'ArcaneOllama'], { action, allowFailure: true });
    await ctx.run(scExe, ['delete', 'ArcaneOllama'], { action, allowFailure: true });
    await ctx.run(scExe, ['create', 'ArcaneOllama', 'binPath=', `"${executable}" serve`, 'start=', 'auto', 'DisplayName=', 'Arcane Ollama Service'], { action });
    await ctx.powershell(`New-Item -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\ArcaneOllama' -Force | Out-Null; New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\ArcaneOllama' -Name Environment -PropertyType MultiString -Value @(${ctx.psQuote(`OLLAMA_MODELS=${paths.modelsRoot}`)}) -Force | Out-Null`, { action });
    await ctx.run(scExe, ['start', 'ArcaneOllama'], { action, allowFailure: true });
    await addMachinePath(ctx.path.dirname(executable), action);
    ctx.actionLog(action, 'info', `Installed Ollama ${release.version || 'latest'} as ArcaneOllama.`);
  }

  async function installBrowser(action) {
    if (ctx.simulate) return;
    throw ctx.arcaneError(
      'BROWSER_INSTALL_MANUAL_REQUIRED',
      'Arcane does not run a user-scoped package-manager alias with administrator rights.',
      'Install Microsoft Edge from Microsoft, then choose Check again.'
    );
  }

  async function addMachinePath(directory, action) {
    if (ctx.simulate) return;
    const script = `$p=[Environment]::GetEnvironmentVariable('Path','Machine');$d=${ctx.psQuote(directory)};if(-not (($p -split ';') -contains $d)){[Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';'+$d),'Machine')}`;
    await ctx.powershell(script, { action });
  }

  function installPayload(root) {
    const dist = ctx.fs.existsSync(ctx.path.join(root, 'arcane-release.json')) && ctx.fs.existsSync(ctx.path.join(root, 'app'))
      ? root
      : ctx.path.join(root, 'dist');
    const requiredReleaseFiles = [
      'ArcaneShell.exe',
      'ArcaneProvisioner.exe',
      'ArcaneCore.exe',
      'ArcanePipeGuard.exe',
      'Microsoft.Web.WebView2.Core.dll',
      'Microsoft.Web.WebView2.WinForms.dll',
      'WebView2Loader.dll',
      'arcane-bundle.json',
      'app/shared/arcane-api.js',
      'app/shared/arcane-sigil.svg',
      'app/shared/arcane-sigil-512.png',
      'app/shared/arcane-sigil.ico',
      'app/provisioner/index.html',
      'app/provisioner/manifest.webmanifest',
      'app/shell/index.html',
      'app/shell/manifest.webmanifest',
    ];
    const appDirectory = ctx.path.join(dist, 'app');
    const releaseManifestPath = ctx.path.join(dist, 'arcane-release.json');
    const missingRelease = requiredReleaseFiles.filter((name) => !ctx.fs.existsSync(ctx.path.join(dist, ...name.split('/'))));
    if (!ctx.fs.existsSync(appDirectory)) missingRelease.push('app/');
    if (!ctx.fs.existsSync(releaseManifestPath)) missingRelease.push('arcane-release.json');

    let releaseManifest = null;
    let releaseProblem = null;
    let verifiedEntries = [];
    if (!missingRelease.length) {
      try {
        releaseManifest = JSON.parse(ctx.fs.readFileSync(releaseManifestPath, 'utf8'));
        if (releaseManifest.schemaVersion !== 2) releaseProblem = 'The release manifest must use integrity schema 2.';
        else if (releaseManifest.hashAlgorithm !== 'sha256') releaseProblem = 'The release manifest must use SHA-256.';
        else if (releaseManifest.version !== ctx.bundleVersion) releaseProblem = `The verified release is ${releaseManifest.version || 'unknown'}, not ${ctx.bundleVersion}.`;
        else if (releaseManifest.platform !== 'windows') releaseProblem = `The release manifest targets ${releaseManifest.platform || 'an unknown platform'}, not Windows.`;
        else {
          const actualPaths = [];
          const collect = (directory, relativeDirectory) => {
            const entries = ctx.fs.readdirSync(directory, { withFileTypes: true });
            for (const entry of entries) {
              if (!relativeDirectory && (entry.name === 'arcane-release.json' || entry.name === '.gitkeep')) continue;
              const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
              const source = ctx.path.join(directory, entry.name);
              if (entry.isSymbolicLink()) throw new Error(`The release contains a symbolic link: ${relativePath}.`);
              if (entry.isDirectory()) {
                if (!relativeDirectory && entry.name !== 'app') throw new Error(`The release contains an unexpected directory: ${entry.name}.`);
                collect(source, relativePath);
              } else if (entry.isFile()) actualPaths.push(relativePath);
              else throw new Error(`The release contains an unsupported entry: ${relativePath}.`);
            }
          };
          collect(dist, '');
          actualPaths.sort();
          const entries = new Map();
          for (const entry of Array.isArray(releaseManifest.files) ? releaseManifest.files : []) {
            const releasePath = entry && entry.path;
            const parts = typeof releasePath === 'string' ? releasePath.split('/') : [];
            if (!parts.length || parts.some((part) => !part || part === '.' || part === '..') || releasePath.includes('\\') || releasePath.includes(':')) {
              throw new Error(`The release manifest contains an unsafe path: ${String(releasePath)}.`);
            }
            if (entries.has(releasePath)) throw new Error(`The release manifest contains a duplicate path: ${releasePath}.`);
            if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`The release manifest contains an invalid size for ${releasePath}.`);
            if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) throw new Error(`The release manifest contains an invalid SHA-256 for ${releasePath}.`);
            entries.set(releasePath, entry);
          }
          if (entries.size !== actualPaths.length || actualPaths.some((releasePath) => !entries.has(releasePath))) {
            throw new Error('The release manifest file inventory does not exactly match the dist payload.');
          }
          for (const name of requiredReleaseFiles) {
            if (!entries.has(name)) throw new Error(`The release manifest does not verify ${name}.`);
          }
          for (const releasePath of actualPaths) {
            const entry = entries.get(releasePath);
            const source = ctx.path.join(dist, ...releasePath.split('/'));
            const stat = ctx.fs.statSync(source);
            if (stat.size !== entry.size) throw new Error(`${releasePath} does not match the release manifest size.`);
            const actual = ctx.crypto.createHash('sha256').update(ctx.fs.readFileSync(source)).digest('hex');
            if (actual.toLowerCase() !== String(entry.sha256).toLowerCase()) throw new Error(`${releasePath} does not match the release manifest SHA-256.`);
          }
          verifiedEntries = actualPaths.map((releasePath) => ({ ...entries.get(releasePath) }));
        }
      } catch (error) { releaseProblem = `The release manifest could not be read: ${error.message}`; }
    }

    if (!missingRelease.length && !releaseProblem) {
      const topLevelFiles = verifiedEntries.filter((entry) => !entry.path.includes('/') && entry.path !== 'arcane-bundle.json');
      const integrityFiles = verifiedEntries.map((entry) => ({
        ...entry,
        installPath: entry.path === 'arcane-bundle.json' || entry.path.startsWith('app/') ? entry.path : `bin/${entry.path}`,
      }));
      return {
        mode: 'windows-webview2',
        releaseReady: true,
        verified: true,
        releaseManifest,
        integrity: {
          schemaVersion: releaseManifest.schemaVersion,
          hashAlgorithm: releaseManifest.hashAlgorithm,
          sourceManifest: releaseManifestPath,
          files: integrityFiles,
        },
        bundleManifestSource: ctx.path.join(dist, 'arcane-bundle.json'),
        assetFiles: ['arcane-sigil.svg', 'arcane-sigil-512.png', 'arcane-sigil.ico'].map((name) => ({
          source: ctx.path.join(appDirectory, 'shared', name),
          destinationName: name,
        })),
        description: 'Verified Windows WebView2 hosts, packaged Arcane Core, and application assets are ready for installation.',
        files: topLevelFiles.map((entry) => ({ source: ctx.path.join(dist, entry.path), destinationName: entry.path })),
        directories: [{ source: appDirectory, destinationName: 'app' }],
        missingRelease: [],
      };
    }
    const sourceCore = ctx.path.join(root, 'runtime', 'arcane-core.cjs');
    return {
      mode: 'source',
      releaseReady: false,
      verified: false,
      description: releaseProblem || 'The source Arcane Core is available, but a verified Windows WebView2 release has not been built.',
      files: ctx.fs.existsSync(sourceCore) ? [{ source: sourceCore, destinationName: 'arcane-core.cjs' }] : [],
      directories: [],
      missingRelease: [...new Set(missingRelease)],
      releaseProblem,
    };
  }

  async function writeLaunchers(stage, payload) {
    const executable = payload && payload.mode === 'windows-webview2';
    const shellLauncher = executable
      ? '@echo off\r\nstart "" "%~dp0ArcaneShell.exe" %*\r\n'
      : '@echo off\r\nnode "%~dp0arcane-shell.cjs" %*\r\n';
    const provisionerLauncher = executable
      ? '@echo off\r\nstart "" "%~dp0ArcaneProvisioner.exe" %*\r\n'
      : '@echo off\r\nnode "%~dp0arcane-provisioner.cjs" %*\r\n';
    await ctx.writeFile(ctx.path.join(stage, 'bin', 'arcane-shell.cmd'), shellLauncher);
    await ctx.writeFile(ctx.path.join(stage, 'bin', 'arcane-provisioner.cmd'), provisionerLauncher);
  }

  async function applyInstallPermissions(action) {
    await ctx.run(icaclsExe, [
      paths.installRoot,
      '/inheritance:r',
      '/grant:r',
      'SYSTEM:(OI)(CI)F',
      'Administrators:(OI)(CI)F',
      'Users:(OI)(CI)RX',
      '/T', '/C',
    ], { action });
    await addMachinePath(ctx.path.join(paths.installRoot, 'bin'), action);
    if (!ctx.simulate) {
      const shellExe = ctx.path.join(paths.installRoot, 'bin', 'ArcaneShell.exe');
      const provisionerExe = ctx.path.join(paths.installRoot, 'bin', 'ArcaneProvisioner.exe');
      const script = `$programs=[Environment]::GetFolderPath('CommonPrograms')
$folder=Join-Path $programs 'Arcane OS'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$ws=New-Object -ComObject WScript.Shell
$items=@(
  @{Name='Arcane Shell';Target=${ctx.psQuote(shellExe)};Arguments='--shell'},
  @{Name='Arcane Provisioner';Target=${ctx.psQuote(provisionerExe)};Arguments=''}
)
foreach($item in $items){
  if(Test-Path -LiteralPath $item.Target){
    $link=$ws.CreateShortcut((Join-Path $folder ($item.Name+'.lnk')))
    $link.TargetPath=$item.Target
    $link.Arguments=$item.Arguments
    $link.WorkingDirectory=(Split-Path -Parent $item.Target)
    $link.IconLocation=$item.Target+',0'
    $link.Save()
  }
}`;
      await ctx.powershell(script, { action, purpose: 'start-menu-shortcuts' });
    }
  }

  async function applyStatePermissions(action) {
    if (ctx.fs.existsSync(paths.stateRoot)) {
      const rootStat = ctx.fs.lstatSync(paths.stateRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw ctx.arcaneError('ARCANE_STATE_PATH_UNSAFE', 'The Arcane machine-state path is not a regular directory.', 'Remove the reparse point or unexpected file as an administrator, then retry.');
      }
      for (const entry of ctx.fs.readdirSync(paths.stateRoot, { withFileTypes: true })) {
        const file = ctx.path.join(paths.stateRoot, entry.name);
        const stat = ctx.fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw ctx.arcaneError('ARCANE_STATE_PATH_UNSAFE', `Arcane refused the unsafe machine-state entry ${entry.name}.`, 'Replace it with a regular administrator-owned file, then retry.');
        }
      }
    }
    const verifyScript = `$ErrorActionPreference='Stop'
$root=${ctx.psQuote(paths.stateRoot)}
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$admins=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$users=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
$allow=[Security.AccessControl.AccessControlType]::Allow
$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$none=[Security.AccessControl.InheritanceFlags]::None
$propagate=[Security.AccessControl.PropagationFlags]::None
$writeMask=[Security.AccessControl.FileSystemRights]::WriteData -bor
  [Security.AccessControl.FileSystemRights]::AppendData -bor
  [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
  [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
  [Security.AccessControl.FileSystemRights]::Delete -bor
  [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership
function New-ArcaneStateAcl([bool]$container){
  if($container){$acl=New-Object Security.AccessControl.DirectorySecurity;$flags=$inherit}
  else{$acl=New-Object Security.AccessControl.FileSecurity;$flags=$none}
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner($admins)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,[Security.AccessControl.FileSystemRights]::FullControl,$flags,$propagate,$allow)))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($admins,[Security.AccessControl.FileSystemRights]::FullControl,$flags,$propagate,$allow)))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users,[Security.AccessControl.FileSystemRights]::ReadAndExecute,$flags,$propagate,$allow)))
  return $acl
}
function Test-ArcaneAclWriteSafe($acl){
  foreach($rule in $acl.Access){
    $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    $writeCapable=(($rule.FileSystemRights -band $writeMask) -ne 0)
    if($rule.AccessControlType -eq $allow -and $writeCapable -and $sid -notin @('S-1-5-18','S-1-5-32-544')){return $false}
  }
  return $true
}
function Assert-TrustedRecoveryAcl([string]$path,[bool]$trustedRoot){
  if(-not $trustedRoot){
    throw "Arcane will not adopt pre-existing recovery state from a directory that was not already administrator-owned, protected, and write-safe. Preserve $path for administrator review."
  }
  $existingAcl=Get-Acl -LiteralPath $path
  $existingOwner=(New-Object Security.Principal.NTAccount($existingAcl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  if(-not (Test-ArcaneAclWriteSafe $existingAcl)){
    throw "Arcane will not trust pre-existing recovery state with an unsafe write ACL. Preserve $path for administrator review."
  }
  if($existingOwner -notin @('S-1-5-18','S-1-5-32-544') -or -not $existingAcl.AreAccessRulesProtected){
    throw "Arcane will not trust pre-existing recovery state with an unprotected owner or ACL. Preserve $path for administrator review."
  }
}
$snapshot=@{}
$rootWasTrusted=$false
if(Test-Path -LiteralPath $root){
  $rootAclBefore=Get-Acl -LiteralPath $root
  $rootOwnerBefore=(New-Object Security.Principal.NTAccount($rootAclBefore.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  $rootWasTrusted=($rootAclBefore.AreAccessRulesProtected -and $rootOwnerBefore -in @('S-1-5-18','S-1-5-32-544') -and (Test-ArcaneAclWriteSafe $rootAclBefore))
  foreach($name in @('users.json','users.json.previous')){
    $recoveryFile=Join-Path $root $name
    if(-not (Test-Path -LiteralPath $recoveryFile)){continue}
    $item=Get-Item -LiteralPath $recoveryFile -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Unsafe Arcane recovery entry: $recoveryFile"}
    Assert-TrustedRecoveryAcl $recoveryFile $rootWasTrusted
    $snapshot[$name]=(Get-FileHash -Algorithm SHA256 -LiteralPath $recoveryFile).Hash
  }
}
if(-not (Test-Path -LiteralPath $root)){
  [IO.Directory]::CreateDirectory($root,(New-ArcaneStateAcl $true)) | Out-Null
}
$rootItem=Get-Item -LiteralPath $root -Force
if(-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'The Arcane state root is not a regular directory.'}
Set-Acl -LiteralPath $root -AclObject (New-ArcaneStateAcl $true)
$entries=@(Get-ChildItem -LiteralPath $root -Force)
foreach($entry in $entries){
  if($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Unsafe Arcane state entry after ACL lock: $($entry.FullName)"}
}
foreach($name in @('users.json','users.json.previous')){
  $recoveryFile=Join-Path $root $name
  $present=Test-Path -LiteralPath $recoveryFile
  if($present -ne $snapshot.ContainsKey($name)){throw "Arcane recovery state changed while its ACL was being locked: $name"}
  if($present -and (Get-FileHash -Algorithm SHA256 -LiteralPath $recoveryFile).Hash -ne $snapshot[$name]){
    throw "Arcane recovery state content changed while its ACL was being locked: $name"
  }
}
$files=@($entries | Where-Object {-not $_.PSIsContainer})
foreach($file in $files){Set-Acl -LiteralPath $file.FullName -AclObject (New-ArcaneStateAcl $false)}
$targets=@(Get-Item -LiteralPath $root)+$files
foreach($target in $targets){
  $acl=Get-Acl -LiteralPath $target.FullName
  $ownerSid=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  if($ownerSid -ne 'S-1-5-32-544'){ throw "Unexpected Arcane state owner on $($target.FullName): $ownerSid" }
  if(-not $acl.AreAccessRulesProtected){ throw "Arcane state ACL inheritance is not protected on $($target.FullName)." }
  foreach($rule in $acl.Access){
    $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    $writeCapable=(($rule.FileSystemRights -band $writeMask) -ne 0)
    if($rule.AccessControlType -eq $allow -and $writeCapable -and $sid -notin @('S-1-5-18','S-1-5-32-544')){
      throw "An untrusted identity retains write access to Arcane state on $($target.FullName): $sid"
    }
  }
}
'verified'`;
    await ctx.powershell(verifyScript, { action, purpose: 'verify-arcane-state-acl' });
  }

  function shellCommand() {
    const executable = ctx.path.join(paths.installRoot, 'bin', 'ArcaneShell.exe');
    if (ctx.fs.existsSync(executable) || ctx.simulate) return `"${executable}" --shell`;
    const launcher = ctx.path.join(paths.installRoot, 'bin', 'arcane-shell.cmd');
    return `cmd.exe /d /c ""${launcher}" --shell"`;
  }

  function usernamePolicy() {
    return {
      platform: 'windows',
      minimumLength: 1,
      maximumLength: 20,
      description: 'Use 1–20 letters, numbers, periods, underscores, or hyphens. Begin with a letter or number. Spaces are not allowed.',
      example: 'arcane-user',
    };
  }

  function validateUsername(input) {
    const value = String(input || '').trim();
    const policy = usernamePolicy();
    const fail = (message, resolution, reason) => {
      const error = ctx.arcaneError('INVALID_USERNAME', message, resolution, 400);
      error.field = 'username';
      error.input = value;
      error.reason = reason;
      error.policy = policy;
      throw error;
    };
    if (!value) fail('Enter a username for the Arcane account.', `Example: ${policy.example}.`, 'empty');
    if (/\s/.test(value)) fail(`“${value}” cannot be used because local Windows usernames cannot contain spaces.`, `Try “${value.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '') || policy.example}”. ${policy.description}`, 'contains-spaces');
    if (value.length > policy.maximumLength) fail(`“${value}” is ${value.length} characters long; Windows local usernames can be at most ${policy.maximumLength} characters.`, `Shorten the name. Example: ${policy.example}.`, 'too-long');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) fail(`“${value}” contains a character that Windows cannot use in this local username.`, policy.description, 'invalid-characters');
    if (/[.]$/.test(value)) fail(`“${value}” cannot end with a period.`, `Remove the final period. Example: ${policy.example}.`, 'invalid-ending');
    const reserved = ['administrator', 'guest', 'defaultaccount', 'wdagutilityaccount'];
    if (reserved.includes(value.toLowerCase())) {
      const error = ctx.arcaneError('RESERVED_USERNAME', `“${value}” is a Windows-reserved account name.`, `Choose another name, such as ${policy.example}.`, 409);
      error.field = 'username';
      error.input = value;
      error.policy = policy;
      throw error;
    }
    return value;
  }

  function userExists(username) {
    if (ctx.simulate) return simulatedAccounts.has(String(username).toLowerCase());
    const script = `if(Get-LocalUser -Name ${ctx.psQuote(username)} -ErrorAction SilentlyContinue){'true'}else{'false'}`;
    const result = ctx.spawnSync(powershellExe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return String(result.stdout || '').trim() === 'true';
  }

  async function listArcaneUsers(recordedUsernames) {
    const expectedShell = shellCommand();
    const recorded = [...new Set((recordedUsernames || []).map((value) => String(value || '').trim()).filter(Boolean))];
    if (ctx.simulate) {
      const names = [...new Map([...recorded, ...[...simulatedUsers.values()].map((item) => item.username)].map((value) => [value.toLowerCase(), value])).values()];
      return names.map((username) => {
        const key = username.toLowerCase();
        const assigned = simulatedUsers.get(key) || null;
        const exists = simulatedAccounts.has(key);
        return {
          username,
          shell: assigned ? expectedShell : null,
          shellAssigned: Boolean(assigned),
          enabled: exists ? assigned && assigned.enabled !== false : null,
          profile: exists ? 'SIMULATED' : null,
          verification: 'simulated',
          source: 'native-windows',
        };
      });
    }

    const recordedLiteral = recorded.length ? recorded.map((value) => ctx.psQuote(value)).join(',') : '';
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$expected=${ctx.psQuote(expectedShell)}
$recorded=@(${recordedLiteral})
$isAdmin=[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
$results=@()
foreach($user in (Get-LocalUser -ErrorAction Stop)){
  $sid=$user.SID.Value
  $profile=Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue
  $profilePath=if($profile){$profile.LocalPath}else{$null}
  $shellValue=$null
  $verified=$false
  $hive=$sid
  $temporary=$false
  try {
    if(Test-Path "Registry::HKEY_USERS\\$sid"){
      $verified=$true
    } elseif($isAdmin -and $profilePath -and (Test-Path -LiteralPath (Join-Path $profilePath 'NTUSER.DAT'))){
      $hive='ARCANE_SCAN_'+($sid -replace '-','_')
      & ${ctx.psQuote(regExe)} load "HKU\\$hive" (Join-Path $profilePath 'NTUSER.DAT') | Out-Null
      if($LASTEXITCODE -eq 0){$temporary=$true;$verified=$true}
    }
    if($verified){
      $key="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
      $shellValue=(Get-ItemProperty -LiteralPath $key -Name Shell -ErrorAction SilentlyContinue).Shell
    }
  } finally {
    if($temporary){
      ${unloadTemporaryHiveScript('user-shell discovery')}
    }
  }
  $assigned=[bool]($verified -and [String]::Equals([string]$shellValue,[string]$expected,[StringComparison]::Ordinal))
  if($assigned -or ($recorded -contains $user.Name)){
    $results += [pscustomobject]@{
      username=$user.Name
      sid=$sid
      enabled=[bool]$user.Enabled
      profile=$profilePath
      shell=$shellValue
      shellAssigned=$assigned
      verification=if($verified){'verified'}else{'recorded-only'}
      source='native-windows'
    }
  }
}
@($results)|ConvertTo-Json -Compress -Depth 4`;

    try {
      const result = await ctx.powershell(script, { purpose: 'list-arcane-users' });
      const raw = String(result.stdout || '').trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw.split(/\r?\n/).filter(Boolean).pop());
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      return recorded.map((username) => ({
        username,
        shell: null,
        shellAssigned: false,
        enabled: null,
        profile: null,
        verification: 'recorded-only',
        source: 'arcane-state',
        warning: ctx.cleanPowerShellError(error.stderr || error.message || ''),
      }));
    }
  }

  async function prepareUserShellBackup(username, action) {
    if (ctx.simulate) {
      const key = username.toLowerCase();
      return {
        username,
        accountExisted: simulatedAccounts.has(key),
        previousShell: simulatedUsers.has(key) ? shellCommand() : null,
        previousShellPresent: simulatedUsers.has(key),
        verification: 'simulated',
      };
    }
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$name=${ctx.psQuote(username)}
$user=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if(-not $user){
  [pscustomobject]@{username=$name;accountExisted=$false;previousShell=$null;previousShellPresent=$false;profile=$null;sid=$null;verification='verified'}|ConvertTo-Json -Compress
  exit 0
}
$adminGroupSid='S-1-5-32-544'
$adminMember=Get-LocalGroupMember -SID $adminGroupSid -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $user.SID }
if($adminMember){ throw "Arcane will not replace the login shell of administrator account '$name'." }
$sid=$user.SID.Value
$profile=(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue).LocalPath
$previousShell=$null
$previousShellPresent=$false
$loaded=Test-Path "Registry::HKEY_USERS\\$sid"
$temporary=$false
$hive=$sid
if(-not $loaded -and $profile){
  $ntUser=Join-Path $profile 'NTUSER.DAT'
  if(Test-Path -LiteralPath $ntUser){
    $hive='ARCANE_PREPARE_'+($sid -replace '-','_')
    & ${ctx.psQuote(regExe)} load "HKU\\$hive" $ntUser | Out-Null
    if($LASTEXITCODE -ne 0){ throw "Windows could not load the registry profile for '$name' to back up its shell." }
    $temporary=$true
  }
}
try {
  if($loaded -or $temporary){
    $key="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
    $previous=Get-ItemProperty -LiteralPath $key -Name Shell -ErrorAction SilentlyContinue
    if($null -ne $previous){$previousShellPresent=$true;$previousShell=$previous.Shell}
  }
} finally {
  if($temporary){
    ${unloadTemporaryHiveScript('shell backup preparation')}
  }
}
[pscustomobject]@{username=$name;accountExisted=$true;previousShell=$previousShell;previousShellPresent=$previousShellPresent;profile=$profile;sid=$sid;verification='verified'}|ConvertTo-Json -Compress`;
    try {
      const result = await ctx.powershell(script, { action, purpose: 'prepare-user-shell-backup' });
      return JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop());
    } catch (error) {
      const readable = ctx.cleanPowerShellError(error.stderr || error.stdout || '');
      error.code = error.code === 'COMMAND_FAILED' ? 'WINDOWS_SHELL_BACKUP_FAILED' : error.code;
      error.userMessage = `Windows could not capture the current login shell for “${username}”.`;
      error.resolution = readable
        ? `${readable} No shell change was made.`
        : 'Confirm the account is signed out and retry from an administrator session. No shell change was made.';
      error.username = username;
      throw error;
    }
  }

  async function provisionUser(username, password, action, shellBackup) {
    const shell = shellCommand();
    if (ctx.simulate) {
      const key = username.toLowerCase();
      const created = !simulatedAccounts.has(key);
      simulatedAccounts.add(key);
      simulatedUsers.set(key, { username, shell, enabled: !created });
      if (created && ctx.simulatedUserFailure === 'crash-before-native-return' && !ctx.simulatedUserFailureTriggered) {
        ctx.simulatedUserFailureTriggered = true;
        const error = ctx.arcaneError(
          'SIMULATED_USER_TRANSACTION_FAILURE',
          'Simulated process loss before the native account operation returned its SID.',
          'The staged account remains disabled and must fail closed because no SID was durably recorded.',
          500
        );
        error.simulatedCrash = true;
        throw error;
      }
      if (created && ['after-create', 'after-profile', 'after-shell'].includes(ctx.simulatedUserFailure) && !ctx.simulatedUserFailureTriggered) {
        ctx.simulatedUserFailureTriggered = true;
        simulatedUsers.delete(key);
        simulatedAccounts.delete(key);
        const error = ctx.arcaneError(
          'SIMULATED_USER_TRANSACTION_FAILURE',
          `Simulated failure ${ctx.simulatedUserFailure}.`,
          'The staged account was removed by the native transaction.',
          500
        );
        error.accountRollback = {
          createdByThisAttempt: true,
          accountRemoved: true,
          accountDisabled: true,
          simulatedFailure: ctx.simulatedUserFailure,
        };
        throw error;
      }
      return { username, created, sid: 'SIMULATED', profile: 'SIMULATED', shell, enabled: !created, activationPending: created, previousShell: null, previousShellPresent: false };
    }
    const shellExecutable=ctx.path.join(paths.installRoot,'bin','ArcaneShell.exe');
    if(!ctx.fs.existsSync(shellExecutable)){
      throw ctx.arcaneError(
        'ARCANE_SHELL_MISSING',
        'Arcane will not change a user shell because ArcaneShell.exe is missing.',
        'Repair the global Arcane installation, verify the release, and try again.'
      );
    }

    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$name=${ctx.psQuote(username)}
$password=[Console]::In.ReadLine()
if([string]::IsNullOrEmpty($password)){ throw 'Arcane did not receive the protected temporary password.' }
$shell=${ctx.psQuote(shell)}
$expectedAccountExisted=${shellBackup && shellBackup.accountExisted ? '$true' : '$false'}
$expectedPreviousPresent=${shellBackup && shellBackup.previousShellPresent ? '$true' : '$false'}
$expectedPrevious=${ctx.psQuote(shellBackup && shellBackup.previousShell !== null && shellBackup.previousShell !== undefined ? shellBackup.previousShell : '')}
$created=$false
$createdSid=$null
$profilePath=$null
$hive=$null
try {
$user=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if([bool]($null -ne $user) -ne $expectedAccountExisted){ throw "The account changed after Arcane prepared its shell backup. No shell change was made." }
if(-not $user){
  $secure=ConvertTo-SecureString $password -AsPlainText -Force
  $user=New-LocalUser -Name $name -Password $secure -Disabled -AccountNeverExpires -PasswordNeverExpires:$false -UserMayNotChangePassword:$false
  $created=$true
  $createdSid=$user.SID.Value
}
$adminGroupSid='S-1-5-32-544'
$adminMember=Get-LocalGroupMember -SID $adminGroupSid -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $user.SID }
if($adminMember){ throw "Arcane will not replace the login shell of administrator account '$name'." }
$usersGroupSid='S-1-5-32-545'
$alreadyMember=Get-LocalGroupMember -SID $usersGroupSid -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $user.SID }
if(-not $alreadyMember){ Add-LocalGroupMember -SID $usersGroupSid -Member $user -ErrorAction Stop }
$sid=(New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME,$name)).Translate([System.Security.Principal.SecurityIdentifier]).Value
$profilePath=(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue).LocalPath
if(-not $profilePath){
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ArcaneProfile {
  [DllImport("userenv.dll", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)]
  public static extern int CreateProfile(
    [MarshalAs(UnmanagedType.LPWStr)] string sid,
    [MarshalAs(UnmanagedType.LPWStr)] string user,
    [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path,
    uint size
  );
}
'@
  $buffer=[System.Text.StringBuilder]::new(260,260)
  $result=[ArcaneProfile]::CreateProfile($sid,$name,$buffer,[uint32]$buffer.Capacity)
  $alreadyExistsHresult=-2147024713
  if($result -ne 0 -and $result -ne 183 -and $result -ne $alreadyExistsHresult){
    $hex=('0x{0:X8}' -f ($result -band 0xffffffffL))
    $nativeError=[Runtime.InteropServices.Marshal]::GetExceptionForHR($result)
    $nativeMessage=if($nativeError){$nativeError.Message}else{'Unknown Windows profile error'}
    throw "Windows could not initialize the profile for '$name' ($hex): $nativeMessage"
  }
  $profilePath=$buffer.ToString()
  if(-not $profilePath){
    $profilePath=(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue).LocalPath
  }
}
if(-not $profilePath -or -not (Test-Path -LiteralPath $profilePath)){
  throw "Windows created the account '$name', but its profile directory was not available."
}
if($created){
  $adsi=[ADSI]("WinNT://./"+$name+",user")
  $adsi.Put('PasswordExpired',1)
  $adsi.SetInfo()
}
$ntUser=Join-Path $profilePath 'NTUSER.DAT'
for($attempt=0;$attempt -lt 20 -and -not (Test-Path -LiteralPath $ntUser);$attempt++){
  Start-Sleep -Milliseconds 250
}
if(-not (Test-Path -LiteralPath $ntUser)){
  throw "Windows created the profile directory for '$name', but NTUSER.DAT was not created after waiting five seconds."
}
$loaded=Test-Path "Registry::HKEY_USERS\\$sid"
$hive=$sid
$previousShell=$null
$previousShellPresent=$false
if(-not $loaded){
  $hive='ARCANE_'+($sid -replace '-','_')
  & ${ctx.psQuote(regExe)} load "HKU\\$hive" $ntUser | Out-Null
  if($LASTEXITCODE -ne 0){ throw "Windows could not load the registry profile for '$name'." }
}
try {
  $key="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
  $previous=Get-ItemProperty -LiteralPath $key -Name Shell -ErrorAction SilentlyContinue
  if($null -ne $previous){$previousShellPresent=$true;$previousShell=$previous.Shell}
  if($previousShellPresent -ne $expectedPreviousPresent -or ($previousShellPresent -and -not [String]::Equals([string]$previousShell,[string]$expectedPrevious,[StringComparison]::Ordinal))){
    throw "The login shell for '$name' changed after Arcane saved its recovery record. No shell change was made."
  }
  try {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name Shell -PropertyType String -Value $shell -Force | Out-Null
    $assigned=(Get-ItemProperty -LiteralPath $key -Name Shell -ErrorAction Stop).Shell
    if(-not [String]::Equals([string]$assigned,[string]$shell,[StringComparison]::Ordinal)){ throw "Windows did not retain the Arcane shell assignment for '$name'." }
  } catch {
    if($previousShellPresent){
      New-ItemProperty -Path $key -Name Shell -PropertyType String -Value $previousShell -Force | Out-Null
    } else {
      Remove-ItemProperty -LiteralPath $key -Name Shell -ErrorAction SilentlyContinue
    }
    throw
  }
} finally {
  if(-not $loaded){
    ${unloadTemporaryHiveScript('shell assignment')}
  }
}
[pscustomobject]@{username=$name;created=$created;sid=$sid;profile=$profilePath;shell=$shell;enabled=[bool]$user.Enabled;activationPending=$created;previousShell=$previousShell;previousShellPresent=$previousShellPresent}|ConvertTo-Json -Compress
} catch {
  $originalError=$_
  if($created){
    $cleanupErrors=@()
    $accountDisabled=$false
    $accountRemoved=$false
    try {
      $cleanupUser=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
      if($cleanupUser -and $createdSid -and $cleanupUser.SID.Value -eq $createdSid){
        Disable-LocalUser -Name $name -ErrorAction Stop
        $accountDisabled=$true
      }
    } catch {$cleanupErrors+=('disable: '+$_.Exception.Message)}
    if($hive -and $sid -and $hive -ne $sid -and (Test-Path "Registry::HKEY_USERS\\$hive")){
      try {
        $released=$false
        for($attempt=0;$attempt -lt 20;$attempt++){
          [gc]::Collect();[gc]::WaitForPendingFinalizers();Start-Sleep -Milliseconds 250
          & ${ctx.psQuote(regExe)} unload "HKU\\$hive" | Out-Null
          if($LASTEXITCODE -eq 0){$released=$true;break}
        }
        if(-not $released){throw 'temporary registry hive remained loaded'}
      } catch {$cleanupErrors+=('hive: '+$_.Exception.Message)}
    }
    try {
      if($createdSid){
        $createdProfile=Get-CimInstance Win32_UserProfile -Filter "SID='$createdSid'" -ErrorAction SilentlyContinue
        if($createdProfile){$createdProfile|Remove-CimInstance -ErrorAction Stop}
      }
    } catch {$cleanupErrors+=('profile: '+$_.Exception.Message)}
    try {
      $cleanupUser=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
      if($cleanupUser -and $createdSid -and $cleanupUser.SID.Value -eq $createdSid){Remove-LocalUser -Name $name -ErrorAction Stop}
      $accountRemoved=-not [bool](Get-LocalUser -Name $name -ErrorAction SilentlyContinue)
    } catch {$cleanupErrors+=('account: '+$_.Exception.Message)}
    $rollback=[pscustomobject]@{createdByThisAttempt=$true;sid=$createdSid;accountDisabled=$accountDisabled;accountRemoved=$accountRemoved;cleanupErrors=@($cleanupErrors)}
    $rollbackJson=$rollback|ConvertTo-Json -Compress -Depth 4
    Write-Output ('ARCANE_PROVISION_ROLLBACK:'+([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($rollbackJson))))
  }
  throw $originalError
}`;

    try {
      const result = await ctx.powershell(script, { action, purpose: 'create-arcane-user', input:`${password}\n`,redactArgs: true, displayCommand: '$ powershell.exe [protected Arcane user provisioning]' });
      let payload = { username, created: false, shell };
      try { payload = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()); } catch (_) {}
      return payload;
    } catch (error) {
      const rollbackMarker = String(error.stdout || '').split(/\r?\n/).find((line) => line.startsWith('ARCANE_PROVISION_ROLLBACK:'));
      if (rollbackMarker) {
        try {
          error.accountRollback = JSON.parse(Buffer.from(rollbackMarker.slice('ARCANE_PROVISION_ROLLBACK:'.length), 'base64').toString('utf8'));
        } catch (_) { /* Preserve the original provisioning failure. */ }
      }
      if (error.stderr) error.stderr = String(error.stderr).split(password).join('[redacted]');
      if (error.stdout) error.stdout = String(error.stdout).split(password).join('[redacted]');
      if (error.message) error.message = String(error.message).split(password).join('[redacted]');
      const readable = ctx.cleanPowerShellError(error.stderr || error.stdout || '');
      error.code = error.code === 'COMMAND_FAILED' ? 'WINDOWS_USER_PROVISION_FAILED' : error.code;
      error.userMessage = readable && readable.includes('profile')
        ? `Windows created or found the account “${username}”, but could not finish initializing its user profile.`
        : `Windows could not finish adding the Arcane user “${username}”.`;
      const rollbackComplete = Boolean(error.accountRollback && error.accountRollback.accountRemoved);
      error.resolution = readable
        ? `${readable} ${rollbackComplete ? 'Arcane removed the disabled account created by this failed attempt.' : 'If Arcane created an account during this attempt, it was left disabled and requires administrator recovery.'} The protected provisioning account was not changed.`
        : rollbackComplete
          ? 'Arcane removed the disabled account created by this failed attempt. Correct the reported issue and try again.'
          : 'Open full diagnostics and recover any recorded disabled partial account before trying again.';
      error.username = username;
      throw error;
    }
  }

  async function activateProvisionedUser(username, staged, action) {
    if (!staged || !staged.created || !staged.sid) {
      throw ctx.arcaneError('INVALID_STAGED_ACCOUNT', 'Arcane cannot activate an account without its staged creation record.', 'Retry the complete Add Arcane user operation.', 409);
    }
    if (ctx.simulate) {
      const key = username.toLowerCase();
      const assigned = simulatedUsers.get(key);
      if (!assigned || !simulatedAccounts.has(key)) throw new Error('The simulated staged account is missing.');
      assigned.enabled = true;
      if (ctx.simulatedUserFailure === 'crash-during-activation' && !ctx.simulatedUserFailureTriggered) {
        ctx.simulatedUserFailureTriggered = true;
        const error = ctx.arcaneError(
          'SIMULATED_USER_TRANSACTION_FAILURE',
          'Simulated process loss during staged account activation.',
          'The next run must remove the exact staged SID before retrying.',
          500
        );
        error.simulatedCrash = true;
        throw error;
      }
      return { username, sid: staged.sid, enabled: true, activated: true };
    }
    const expectedShell = shellCommand();
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$name=${ctx.psQuote(username)}
$expectedSid=${ctx.psQuote(staged.sid)}
$expectedShell=${ctx.psQuote(expectedShell)}
$user=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if(-not $user){throw "The staged local account '$name' no longer exists."}
if($user.SID.Value -ne $expectedSid){throw "Arcane refused to activate '$name' because its security identifier changed."}
$adminGroupSid='S-1-5-32-544'
$adminMember=Get-LocalGroupMember -SID $adminGroupSid -ErrorAction SilentlyContinue|Where-Object{$_.SID -eq $user.SID}
if($adminMember){throw "Arcane will not activate administrator account '$name'."}
$profile=(Get-CimInstance Win32_UserProfile -Filter "SID='$expectedSid'" -ErrorAction SilentlyContinue).LocalPath
if(-not $profile){throw "The staged profile for '$name' is missing."}
$ntUser=Join-Path $profile 'NTUSER.DAT'
if(-not (Test-Path -LiteralPath $ntUser)){throw "NTUSER.DAT for '$name' is missing."}
$hive=$expectedSid
$temporary=$false
if(-not (Test-Path "Registry::HKEY_USERS\\$expectedSid")){
  $suffix=($expectedSid -replace '-','_')
  foreach($prefix in @('ARCANE_','ARCANE_ACTIVATE_','ARCANE_PREPARE_','ARCANE_RECOVERY_')){
    $candidate=$prefix+$suffix
    if(Test-Path "Registry::HKEY_USERS\\$candidate"){$hive=$candidate;$temporary=$true;break}
  }
  if(-not $temporary){
    $hive='ARCANE_ACTIVATE_'+$suffix
    & ${ctx.psQuote(regExe)} load "HKU\\$hive" $ntUser|Out-Null
    if($LASTEXITCODE -ne 0){throw "Windows could not verify the staged shell for '$name'."}
    $temporary=$true
  }
}
try {
  $key="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
  $currentShell=(Get-ItemProperty -LiteralPath $key -Name Shell -ErrorAction SilentlyContinue).Shell
  if(-not [String]::Equals([string]$currentShell,[string]$expectedShell,[StringComparison]::Ordinal)){throw "Arcane refused to activate '$name' because its staged shell no longer matches Arcane."}
} finally {
  if($temporary){${unloadTemporaryHiveScript('staged account activation')}}
}
Enable-LocalUser -Name $name -ErrorAction Stop
$verified=Get-LocalUser -Name $name -ErrorAction Stop
if(-not $verified.Enabled){throw "Windows did not enable the staged Arcane account '$name'."}
[pscustomobject]@{username=$name;sid=$expectedSid;enabled=$true;activated=$true}|ConvertTo-Json -Compress`;
    const result = await ctx.powershell(script, { action, purpose: 'activate-staged-arcane-user', redactArgs: true, displayCommand: '$ powershell.exe [activate staged Arcane user]' });
    return JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop());
  }

  async function rollbackCreatedUser(username, staged, action) {
    if (!staged || !staged.created || !staged.sid) {
      throw ctx.arcaneError('INVALID_STAGED_ACCOUNT', 'Arcane refused to remove an account without its exact staged creation record.', 'Recover the account manually as an administrator.', 409);
    }
    if (ctx.simulate) {
      const key = username.toLowerCase();
      simulatedUsers.delete(key);
      simulatedAccounts.delete(key);
      return { username, sid: staged.sid, accountDisabled: true, accountRemoved: true, cleanupErrors: [] };
    }
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$name=${ctx.psQuote(username)}
$expectedSid=${ctx.psQuote(staged.sid)}
$errors=@()
$accountDisabled=$false
$user=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if(-not $user){[pscustomobject]@{username=$name;sid=$expectedSid;accountDisabled=$true;accountRemoved=$true;cleanupErrors=@()}|ConvertTo-Json -Compress;exit 0}
if($user.SID.Value -ne $expectedSid){throw "Arcane refused to remove '$name' because its security identifier changed."}
$adminGroupSid='S-1-5-32-544'
$adminMember=Get-LocalGroupMember -SID $adminGroupSid -ErrorAction SilentlyContinue|Where-Object{$_.SID -eq $user.SID}
if($adminMember){throw "Arcane will not remove administrator account '$name'."}
try{Disable-LocalUser -Name $name -ErrorAction Stop;$accountDisabled=$true}catch{$errors+=('disable: '+$_.Exception.Message)}
$suffix=($expectedSid -replace '-','_')
foreach($prefix in @('ARCANE_','ARCANE_ACTIVATE_','ARCANE_PREPARE_','ARCANE_RESTORE_','ARCANE_SCAN_','ARCANE_RECOVERY_')){
  $candidate=$prefix+$suffix
  if(Test-Path "Registry::HKEY_USERS\\$candidate"){
    try{
      $released=$false
      for($attempt=0;$attempt -lt 20;$attempt++){
        [gc]::Collect();[gc]::WaitForPendingFinalizers();Start-Sleep -Milliseconds 250
        & ${ctx.psQuote(regExe)} unload "HKU\\$candidate"|Out-Null
        if($LASTEXITCODE -eq 0){$released=$true;break}
      }
      if(-not $released){throw 'temporary registry hive remained loaded'}
    }catch{$errors+=('hive: '+$_.Exception.Message)}
  }
}
try{
  $profile=Get-CimInstance Win32_UserProfile -Filter "SID='$expectedSid'" -ErrorAction SilentlyContinue
  if($profile){$profile|Remove-CimInstance -ErrorAction Stop}
}catch{$errors+=('profile: '+$_.Exception.Message)}
try{Remove-LocalUser -Name $name -ErrorAction Stop}catch{$errors+=('account: '+$_.Exception.Message)}
$remaining=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
[pscustomobject]@{username=$name;sid=$expectedSid;accountDisabled=$accountDisabled;accountRemoved=[bool](-not $remaining);cleanupErrors=@($errors)}|ConvertTo-Json -Compress`;
    const result = await ctx.powershell(script, { action, purpose: 'rollback-created-arcane-user', redactArgs: true, displayCommand: '$ powershell.exe [rollback staged Arcane user]' });
    return JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop());
  }

  async function resetUserPassword(username, password, action) {
    if (ctx.simulate) return { username, passwordReset: true, mustChangeAtNextSignIn: true };
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$name=${ctx.psQuote(username)}
$password=[Console]::In.ReadLine()
if([string]::IsNullOrEmpty($password)){ throw 'Arcane did not receive the protected temporary password.' }
$user=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if(-not $user){ throw "The local Windows account '$name' does not exist." }
$secure=ConvertTo-SecureString $password -AsPlainText -Force
Set-LocalUser -Name $name -Password $secure -ErrorAction Stop
$adsi=[ADSI]("WinNT://./"+$name+",user")
$adsi.Put('PasswordExpired',1)
$adsi.SetInfo()
[pscustomobject]@{username=$name;passwordReset=$true;mustChangeAtNextSignIn=$true;enabled=[bool]$user.Enabled}|ConvertTo-Json -Compress`;
    try {
      const result = await ctx.powershell(script, {
        action,
        purpose: 'reset-arcane-user-password',
        input: `${password}\n`,
        redactArgs: true,
        displayCommand: '$ powershell.exe [protected Arcane password reset]',
      });
      let payload = { username, passwordReset: true, mustChangeAtNextSignIn: true };
      try { payload = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()); } catch (_) {}
      return payload;
    } catch (error) {
      if (error.stderr) error.stderr = String(error.stderr).split(password).join('[redacted]');
      if (error.stdout) error.stdout = String(error.stdout).split(password).join('[redacted]');
      if (error.message) error.message = String(error.message).split(password).join('[redacted]');
      const readable = ctx.cleanPowerShellError(error.stderr || error.stdout || '');
      error.code = error.code === 'COMMAND_FAILED' ? 'WINDOWS_PASSWORD_RESET_FAILED' : error.code;
      error.userMessage = `Windows could not set a temporary password for “${username}”.`;
      error.resolution = readable
        ? `${readable} Confirm the account still exists and that administrator approval is active, then try again.`
        : 'Confirm the account exists, approve administrator access, and try again.';
      error.username = username;
      throw error;
    }
  }

  async function restoreUserShell(username, previousShell, previousShellPresent, action) {
    if (ctx.simulate) {
      simulatedUsers.delete(username.toLowerCase());
      return {
        username,
        restored: true,
        shell: previousShellPresent ? previousShell : null,
        shellAssigned: false,
        verification: 'simulated',
      };
    }
    const expectedShell = shellCommand();
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$name=${ctx.psQuote(username)}
$expected=${ctx.psQuote(expectedShell)}
$previous=${ctx.psQuote(previousShell === null || previousShell === undefined ? '' : previousShell)}
$previousPresent=${previousShellPresent ? '$true' : '$false'}
$user=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if(-not $user){ throw "The local Windows account '$name' does not exist." }
$sid=$user.SID.Value
$profile=(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue).LocalPath
if(-not $profile){ throw "Windows could not locate the user profile for '$name'." }
$ntUser=Join-Path $profile 'NTUSER.DAT'
if(-not (Test-Path -LiteralPath $ntUser)){ throw "Windows could not locate NTUSER.DAT for '$name'." }
$loaded=Test-Path "Registry::HKEY_USERS\\$sid"
$hive=$sid
$temporary=$false
if(-not $loaded){
  $suffix=($sid -replace '-','_')
  foreach($prefix in @('ARCANE_','ARCANE_PREPARE_','ARCANE_RESTORE_','ARCANE_SCAN_','ARCANE_RECOVERY_')){
    $candidate=$prefix+$suffix
    if(Test-Path "Registry::HKEY_USERS\\$candidate"){$hive=$candidate;$temporary=$true;break}
  }
  if(-not $temporary){
    $hive='ARCANE_RECOVERY_'+$suffix
    & ${ctx.psQuote(regExe)} load "HKU\\$hive" $ntUser | Out-Null
    if($LASTEXITCODE -ne 0){ throw "Windows could not load the registry profile for '$name'." }
    $temporary=$true
  }
}
try {
  $key="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
  $current=(Get-ItemProperty -LiteralPath $key -Name Shell -ErrorAction SilentlyContinue).Shell
  if(-not [String]::Equals([string]$current,[string]$expected,[StringComparison]::Ordinal)){
    throw "Arcane refused to overwrite the current shell for '$name' because it no longer matches the installed Arcane shell."
  }
  if($previousPresent){
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name Shell -PropertyType String -Value $previous -Force | Out-Null
    $verified=(Get-ItemProperty -LiteralPath $key -Name Shell -ErrorAction Stop).Shell
    if(-not [String]::Equals([string]$verified,[string]$previous,[StringComparison]::Ordinal)){ throw "Windows did not retain the restored shell for '$name'." }
  } else {
    Remove-ItemProperty -LiteralPath $key -Name Shell -ErrorAction Stop
    $remaining=Get-ItemProperty -LiteralPath $key -Name Shell -ErrorAction SilentlyContinue
    if($null -ne $remaining){ throw "Windows did not remove the Arcane shell override for '$name'." }
  }
} finally {
  if($temporary){
    ${unloadTemporaryHiveScript('shell restoration')}
  }
}
$restoredShell=if($previousPresent){$previous}else{$null}
[pscustomobject]@{username=$name;restored=$true;shell=$restoredShell;shellAssigned=$false;profile=$profile;sid=$sid;verification='verified'}|ConvertTo-Json -Compress`;
    try {
      const result = await ctx.powershell(script, {
        action,
        purpose: 'restore-arcane-user-shell',
        redactArgs: true,
        displayCommand: '$ powershell.exe [restore previous user shell]',
      });
      return JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop());
    } catch (error) {
      const readable = ctx.cleanPowerShellError(error.stderr || error.stdout || '');
      error.code = error.code === 'COMMAND_FAILED' ? 'WINDOWS_SHELL_RESTORE_FAILED' : error.code;
      error.userMessage = `Windows could not restore the previous login shell for “${username}”.`;
      error.resolution = readable
        ? `${readable} Confirm the account profile is not in use, then retry from an administrator session.`
        : 'Confirm the account exists, sign it out, approve administrator access, and try again.';
      error.username = username;
      throw error;
    }
  }

  function launchBrowser(url, options) {
    if (ctx.noBrowser) return null;
    const candidates = browserCandidates();
    if (candidates.length) {
      const executable = candidates[0];
      const browserArgs = options && options.shellMode
        ? ['--kiosk', url, '--no-first-run', '--disable-session-crashed-bubble']
        : ['--app=' + url, '--no-first-run'];
      const child = ctx.spawn(executable, browserArgs, { stdio: 'ignore', windowsHide: true });
      return child;
    }
    const child = ctx.spawn(cmdExe, ['/d', '/s', '/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return child;
  }

  function quoteWindowsArgument(value) {
    const text = String(value);
    if (text === '') return '""';
    if (!/[\s"]/u.test(text)) return text;
    return '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  }

  function quoteVbsString(value) {
    return '"' + String(value).replace(/"/g, '""') + '"';
  }

  function elevationTarget(currentExecutable) {
    // Elevate the packaged Node host itself. Elevating the GUI launcher added
    // a second process boundary where arguments and the UAC token could be
    // lost or misreported. The public launcher remains the normal entrypoint;
    // privilege handoff uses the host directly and keeps it hidden.
    return currentExecutable;
  }

  async function launchElevated(executable, relaunchArgs, action) {
    if (ctx.simulate) {
      ctx.actionLog(action, 'info', 'Simulation: authorizing a temporary privileged Arcane worker.');
      const child = ctx.spawn(executable, relaunchArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return {
        launcher: 'simulated-uac',
        launcherPid: child.pid || null,
        bootstrapFile: null,
      };
    }

    const argumentLine = relaunchArgs.map(quoteWindowsArgument).join(' ');
    const script = `$ErrorActionPreference='Stop'
foreach($name in @('NODE_OPTIONS','NODE_PATH','DOTNET_STARTUP_HOOKS')){Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}
Get-ChildItem Env: | Where-Object { $_.Name -like 'COR_*' -or $_.Name -like 'CORECLR_*' } | ForEach-Object { Remove-Item -LiteralPath ("Env:"+$_.Name) -ErrorAction SilentlyContinue }
$env:SystemRoot='C:\\Windows'
$env:windir='C:\\Windows'
$env:ProgramFiles='C:\\Program Files'
[Environment]::SetEnvironmentVariable('ProgramFiles(x86)','C:\\Program Files (x86)','Process')
$env:ProgramData='C:\\ProgramData'
$env:PATH='C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
$env:PATHEXT='.COM;.EXE;.BAT;.CMD'
$env:ComSpec='C:\\Windows\\System32\\cmd.exe'
$env:PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'
try {
  $process=Start-Process -FilePath ${ctx.psQuote(executable)} -ArgumentList ${ctx.psQuote(argumentLine)} -Verb RunAs -WindowStyle Hidden -PassThru
  [Console]::Out.WriteLine($process.Id)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1223
}`;

    try {
      const result = await ctx.powershell(script, { action, purpose: 'elevation-launch', redactArgs: true, displayCommand: '$ powershell.exe [Arcane privileged worker authorization]' });
      const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
      return {
        launcher: ctx.processPkg ? 'windows-uac-direct-host' : 'windows-uac-direct-node',
        launcherPid: Number(line) || null,
        bootstrapFile: null,
      };
    } catch (error) {
      const text = `${error.message || ''} ${error.stderr || ''}`.toLowerCase();
      if (error.exitCode === 1223 || text.includes('canceled') || text.includes('cancelled')) {
        error.code = 'ELEVATION_CANCELLED';
        error.userMessage = 'Administrator approval was cancelled.';
        error.resolution = 'No machine changes were made. Choose the action again when you are ready to approve the Windows prompt.';
      } else {
        error.code = error.code === 'COMMAND_FAILED' ? 'ELEVATION_LAUNCH_FAILED' : error.code;
        error.userMessage = 'Windows could not start the elevated Arcane Provisioner host.';
        error.resolution = 'Check whether Windows security policy blocked the request, then review the full diagnostics.';
      }
      throw error;
    }
  }

  return Object.freeze({
    id: 'windows',
    supportsUserProvisioning: true,
    paths,
    commandExists,
    currentIdentity,
    protectedUsernames,
    osInfo,
    permissionStatus,
    isElevated,
    hideHostWindow,
    nodeExecutable,
    ollamaExecutable,
    browserExecutable,
    browserCandidates,
    rendererStatus,
    sessionControlExecutable,
    lockSpec,
    logoutSpec,
    provisionerCandidates,
    nodeArchiveName,
    installNodePackage,
    installOllama,
    installBrowser,
    installRenderer,
    addMachinePath,
    installPayload,
    writeLaunchers,
    applyInstallPermissions,
    applyStatePermissions,
    shellCommand,
    usernamePolicy,
    validateUsername,
    userExists,
    listArcaneUsers,
    prepareUserShellBackup,
    provisionUser,
    activateProvisionedUser,
    rollbackCreatedUser,
    resetUserPassword,
    restoreUserShell,
    launchBrowser,
    verifyPrivilegePipeGuardTrust,
    elevationTarget,
    launchElevated,
  });
}


function createLinuxNativeAdapter(ctx) {
  'use strict';

  const simulatedAccounts = new Set();
  const simulatedShellAssignments = new Map();

  const paths = Object.freeze({
    installRoot: !ctx.production&&process.env.ARCANE_INSTALL_ROOT || '/opt/arcane-os',
    stateRoot: !ctx.production&&process.env.ARCANE_STATE_ROOT || '/var/lib/arcane-os/state',
    nodeRoot: '/usr/local/lib/nodejs',
    ollamaRoot: '/usr',
    modelsRoot: '/var/lib/arcane-os/ollama-models',
  });

  function systemCommand(command) {
    if(ctx.path.isAbsolute(command))return ctx.fs.existsSync(command)?command:null;
    for(const directory of ['/usr/local/sbin','/usr/local/bin','/usr/sbin','/usr/bin','/sbin','/bin']){
      const candidate=ctx.path.join(directory,command);
      if(ctx.fs.existsSync(candidate))return candidate;
    }
    return null;
  }

  function commandExists(command) {
    return Boolean(systemCommand(command));
  }

  function candidateExecutable(candidates) {
    for (const value of candidates.filter(Boolean)) {
      if (ctx.path.isAbsolute(value)) {
        if (ctx.fs.existsSync(value)) return value;
      } else {
        const resolved=systemCommand(value);
        if(resolved)return resolved;
      }
    }
    return null;
  }

  function usernameFromUid(uid) {
    if (uid === undefined || uid === null || uid === '') return null;
    const id = systemCommand('id');
    if (!id) return null;
    const result = ctx.spawnSync(id, ['-nu', String(uid)], { encoding: 'utf8' });
    return result.status === 0 ? String(result.stdout || '').trim() || null : null;
  }

  function currentIdentity() {
    let username = process.env.USER || 'unknown';
    try { username = ctx.os.userInfo().username || username; } catch (_) {}
    return {
      username,
      accountName: username,
      displayName: process.env.ARCANE_DISPLAY_NAME || username,
      computerName: ctx.os.hostname(),
      domain: null,
      source: 'linux',
    };
  }

  function protectedUsernames(elevationProtectedUsername) {
    const values = [
      elevationProtectedUsername,
      process.env.SUDO_USER,
      usernameFromUid(process.env.PKEXEC_UID),
      currentIdentity().username,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    return [...new Map(values.map((value) => [value.toLowerCase(), value])).values()];
  }

  function osInfo(simulatedPlatform) {
    return {
      platform: 'linux',
      rawPlatform: 'linux',
      displayName: 'Linux',
      architecture: process.arch,
      hostname: ctx.os.hostname(),
      release: ctx.os.release(),
      desktop: process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || null,
      sessionType: process.env.XDG_SESSION_TYPE || null,
      simulated: Boolean(simulatedPlatform),
      adapter: 'linux',
    };
  }

  function permissionStatus() {
    const elevated = ctx.simulate || (typeof process.getuid === 'function' && process.getuid() === 0);
    return {
      elevated,
      level: elevated ? 'root' : 'standard',
      canElevate: Boolean(ctx.simulate),
      mechanism: ctx.simulate ? 'privileged-worker-simulation' : null,
      detectedBy: ctx.simulate ? 'simulation' : 'uid',
      probes: [
        { id: 'uid', ok: elevated, value: typeof process.getuid === 'function' ? process.getuid() : null },
        { id: 'kernel-peer-credentials', ok: Boolean(ctx.simulate), value: ctx.simulate ? 'simulation' : 'SO_PEERCRED guard unavailable' },
      ],
    };
  }

  function isElevated() {
    return permissionStatus().elevated;
  }

  function hideHostWindow() {}

  function nodeExecutable() {
    return candidateExecutable(['node']);
  }

  function ollamaExecutable() {
    return candidateExecutable(['ollama']);
  }

  function browserCandidates() {
    return ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser', 'firefox']
      .map(systemCommand)
      .filter(Boolean);
  }

  function browserExecutable() {
    return browserCandidates()[0] || null;
  }

  function rendererStatus() {
    if (ctx.simulate) return { id: 'webkitgtk', available: true, executable: 'webkitgtk-6.0', version: 'simulated', adapter: 'linux-webkitgtk' };
    const pkgConfig = systemCommand('pkg-config');
    if (!pkgConfig) return { id: 'webkitgtk', available: false, executable: null, version: null, adapter: 'linux-webkitgtk' };
    const result = ctx.spawnSync(pkgConfig, ['--modversion', 'webkitgtk-6.0'], { encoding: 'utf8', timeout: 10000 });
    const version = result.status === 0 ? String(result.stdout || '').trim() : null;
    return { id: 'webkitgtk', available: Boolean(version), executable: version ? 'webkitgtk-6.0' : null, version, adapter: 'linux-webkitgtk' };
  }

  function logoutCandidates() {
    const desktop = String(process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase();
    const candidates = [];
    if (desktop.includes('gnome')) candidates.push(['gnome-session-quit', ['--logout', '--no-prompt']]);
    if (desktop.includes('kde') || desktop.includes('plasma')) {
      candidates.push(['qdbus6', ['org.kde.Shutdown', '/Shutdown', 'logout']]);
      candidates.push(['qdbus', ['org.kde.Shutdown', '/Shutdown', 'logout']]);
    }
    if (desktop.includes('xfce')) candidates.push(['xfce4-session-logout', ['--logout']]);
    if (desktop.includes('mate')) candidates.push(['mate-session-save', ['--logout-dialog']]);
    candidates.push(['loginctl', ['terminate-user', currentIdentity().username]]);
    return candidates;
  }

  function sessionControlExecutable() {
    if (ctx.simulate) return 'loginctl';
    const candidate = logoutCandidates().find(([command]) => commandExists(command));
    return candidate ? systemCommand(candidate[0]) : null;
  }

  function logoutSpec() {
    if (ctx.simulate) return ['loginctl', ['terminate-user', currentIdentity().username]];
    const candidate = logoutCandidates().find(([command]) => commandExists(command));
    return candidate ? [systemCommand(candidate[0]), candidate[1]] : null;
  }

  function lockSpec() {
    if (ctx.simulate) return ['loginctl', ['lock-session']];
    const candidate = [
      ['loginctl', ['lock-session']],
      ['gnome-screensaver-command', ['-l']],
      ['xdg-screensaver', ['lock']],
    ].find(([command]) => commandExists(command));
    return candidate ? [systemCommand(candidate[0]), candidate[1]] : null;
  }

  function provisionerCandidates(base, installRoot) {
    return [
      ctx.path.join(base, 'ArcaneProvisioner'),
      ctx.path.join(installRoot, 'bin', 'ArcaneProvisioner'),
      ctx.path.join(installRoot, 'bin', 'arcane-provisioner'),
    ];
  }

  function nodeArchiveName(version) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return `node-${version}-linux-${arch}.tar.xz`;
  }

  async function installNodePackage(packageFile, release, action) {
    const destination = ctx.path.join(paths.nodeRoot, release.version);
    await ctx.ensureDir(paths.nodeRoot);
    await ctx.run('tar', ['-xJf', packageFile, '-C', paths.nodeRoot], { action });
    const extracted = ctx.path.join(paths.nodeRoot, `node-${release.version}-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
    if (extracted !== destination) {
      await ctx.fsp.rm(destination, { recursive: true, force: true });
      await ctx.fsp.rename(extracted, destination);
    }
    for (const name of ['node', 'npm', 'npx', 'corepack']) {
      const target = ctx.path.join(destination, 'bin', name);
      const link = ctx.path.join('/usr/local/bin', name);
      await ctx.fsp.rm(link, { force: true });
      await ctx.fsp.symlink(target, link);
    }
    ctx.actionLog(action, 'info', `Node.js ${release.version} installation completed.`);
  }

  async function installOllama(action) {
    if (ctx.simulate) {
      ctx.actionLog(action, 'info', 'Simulation: would run the official Ollama Linux installer and configure its service.');
      return;
    }
    throw ctx.arcaneError(
      'OLLAMA_MANUAL_INSTALL_REQUIRED',
      'Arcane will not execute an unpinned remote Ollama installation script with root privileges.',
      'Install Ollama from your Linux distribution or a verified official package, then choose Check again.'
    );
  }

  async function detectPackageManager() {
    for (const name of ['apt-get', 'dnf', 'yum', 'zypper', 'pacman']) {
      const executable = systemCommand(name);
      if (executable) return executable;
    }
    return null;
  }

  async function installBrowser(action) {
    if (ctx.simulate) {
      ctx.actionLog(action, 'info', 'Simulation: would install Chromium through the detected Linux package manager.');
      return;
    }
    const manager = await detectPackageManager();
    if (!manager) throw ctx.arcaneError('PACKAGE_MANAGER_NOT_FOUND', 'Arcane could not find a supported Linux package manager.', 'Install Chromium or Firefox manually, then choose Check again.');
    const managerName = ctx.path.basename(manager);
    if (managerName === 'apt-get') {
      await ctx.run(manager, ['update'], { action });
      const result = await ctx.run(manager, ['install', '-y', 'chromium'], { action, allowFailure: true });
      if (result.code !== 0) await ctx.run(manager, ['install', '-y', 'chromium-browser'], { action });
    } else if (managerName === 'dnf' || managerName === 'yum') {
      await ctx.run(manager, ['install', '-y', 'chromium'], { action });
    } else if (managerName === 'zypper') {
      await ctx.run(manager, ['--non-interactive', 'install', 'chromium'], { action });
    } else {
      await ctx.run(manager, ['-Sy', '--noconfirm', 'chromium'], { action });
    }
  }

  async function installRenderer(action) {
    if (ctx.simulate) {
      ctx.actionLog(action, 'info', 'Simulation: would install GTK 4 and WebKitGTK 6.0 through the detected Linux package manager.');
      return;
    }
    const manager = await detectPackageManager();
    if (!manager) throw ctx.arcaneError('PACKAGE_MANAGER_NOT_FOUND', 'Arcane could not find a supported Linux package manager.', 'Install GTK 4 and WebKitGTK 6.0 manually, then reopen Arcane.');
    const managerName = ctx.path.basename(manager);
    if (managerName === 'apt-get') {
      await ctx.run(manager, ['update'], { action });
      await ctx.run(manager, ['install', '-y', 'libgtk-4-1', 'libwebkitgtk-6.0-4'], { action });
    } else if (managerName === 'dnf' || managerName === 'yum') {
      await ctx.run(manager, ['install', '-y', 'gtk4', 'webkitgtk6.0'], { action });
    } else if (managerName === 'zypper') {
      await ctx.run(manager, ['--non-interactive', 'install', 'gtk4', 'webkitgtk-6_0'], { action });
    } else {
      await ctx.run(manager, ['-Sy', '--noconfirm', 'gtk4', 'webkitgtk-6.0'], { action });
    }
    const status = rendererStatus();
    if (!status.available) throw ctx.arcaneError('WEBKITGTK_INSTALL_FAILED', 'WebKitGTK 6.0 did not become available after installation.', 'Install the WebKitGTK 6.0 runtime and development package provided by this Linux distribution.');
  }

  async function addMachinePath() {
    if (ctx.simulate) return;
    for (const name of ['arcane-shell', 'arcane-provisioner']) {
      const target = ctx.path.join(paths.installRoot, 'bin', name);
      const link = ctx.path.join('/usr/local/bin', name);
      await ctx.fsp.rm(link, { force: true });
      await ctx.fsp.symlink(target, link);
    }
  }

  function installPayload(root) {
    const dist = ctx.fs.existsSync(ctx.path.join(root, 'arcane-release.json')) && ctx.fs.existsSync(ctx.path.join(root, 'app'))
      ? root
      : ctx.path.join(root, 'dist');
    const requiredReleaseFiles = [
      'ArcaneShell',
      'ArcaneProvisioner',
      'ArcaneCore',
      'arcane-bundle.json',
      'app/shared/arcane-api.js',
      'app/shared/arcane-sigil.svg',
      'app/shared/arcane-sigil-512.png',
      'app/shared/arcane-sigil.ico',
      'app/provisioner/index.html',
      'app/provisioner/manifest.webmanifest',
      'app/shell/index.html',
      'app/shell/manifest.webmanifest',
    ];
    const appDirectory = ctx.path.join(dist, 'app');
    const releaseManifestPath = ctx.path.join(dist, 'arcane-release.json');
    const missingRelease = requiredReleaseFiles.filter((name) => !ctx.fs.existsSync(ctx.path.join(dist, ...name.split('/'))));
    if (!ctx.fs.existsSync(appDirectory)) missingRelease.push('app/');
    if (!ctx.fs.existsSync(releaseManifestPath)) missingRelease.push('arcane-release.json');
    let releaseManifest = null;
    let releaseProblem = null;
    let verifiedEntries = [];
    if (!missingRelease.length) {
      try {
        releaseManifest = JSON.parse(ctx.fs.readFileSync(releaseManifestPath, 'utf8'));
        if (releaseManifest.schemaVersion !== 2) releaseProblem = 'The release manifest must use integrity schema 2.';
        else if (releaseManifest.hashAlgorithm !== 'sha256') releaseProblem = 'The release manifest must use SHA-256.';
        else if (releaseManifest.version !== ctx.bundleVersion) releaseProblem = `The verified release is ${releaseManifest.version || 'unknown'}, not ${ctx.bundleVersion}.`;
        else if (releaseManifest.platform !== 'linux') releaseProblem = `The release manifest targets ${releaseManifest.platform || 'an unknown platform'}, not Linux.`;
        else {
          const actualPaths = [];
          const collect = (directory, relativeDirectory) => {
            const entries = ctx.fs.readdirSync(directory, { withFileTypes: true });
            for (const entry of entries) {
              if (!relativeDirectory && (entry.name === 'arcane-release.json' || entry.name === '.gitkeep')) continue;
              const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
              const source = ctx.path.join(directory, entry.name);
              if (entry.isSymbolicLink()) throw new Error(`The release contains a symbolic link: ${relativePath}.`);
              if (entry.isDirectory()) {
                if (!relativeDirectory && entry.name !== 'app') throw new Error(`The release contains an unexpected directory: ${entry.name}.`);
                collect(source, relativePath);
              } else if (entry.isFile()) actualPaths.push(relativePath);
              else throw new Error(`The release contains an unsupported entry: ${relativePath}.`);
            }
          };
          collect(dist, '');
          actualPaths.sort();
          const entries = new Map();
          for (const entry of Array.isArray(releaseManifest.files) ? releaseManifest.files : []) {
            const releasePath = entry && entry.path;
            const parts = typeof releasePath === 'string' ? releasePath.split('/') : [];
            if (!parts.length || parts.some((part) => !part || part === '.' || part === '..') || releasePath.includes('\\') || releasePath.includes(':')) {
              throw new Error(`The release manifest contains an unsafe path: ${String(releasePath)}.`);
            }
            if (entries.has(releasePath)) throw new Error(`The release manifest contains a duplicate path: ${releasePath}.`);
            if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`The release manifest contains an invalid size for ${releasePath}.`);
            if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) throw new Error(`The release manifest contains an invalid SHA-256 for ${releasePath}.`);
            entries.set(releasePath, entry);
          }
          if (entries.size !== actualPaths.length || actualPaths.some((releasePath) => !entries.has(releasePath))) {
            throw new Error('The release manifest file inventory does not exactly match the dist payload.');
          }
          for (const name of requiredReleaseFiles) {
            if (!entries.has(name)) throw new Error(`The release manifest does not verify ${name}.`);
          }
          for (const releasePath of actualPaths) {
            const entry = entries.get(releasePath);
            const source = ctx.path.join(dist, ...releasePath.split('/'));
            const stat = ctx.fs.statSync(source);
            if (stat.size !== entry.size) throw new Error(`${releasePath} does not match the release manifest size.`);
            const actual = ctx.crypto.createHash('sha256').update(ctx.fs.readFileSync(source)).digest('hex');
            if (actual.toLowerCase() !== String(entry.sha256).toLowerCase()) throw new Error(`${releasePath} does not match the release manifest SHA-256.`);
          }
          verifiedEntries = actualPaths.map((releasePath) => ({ ...entries.get(releasePath) }));
        }
      } catch (error) { releaseProblem = `The release manifest could not be read: ${error.message}`; }
    }
    if (!missingRelease.length && !releaseProblem) {
      const topLevelFiles = verifiedEntries.filter((entry) => !entry.path.includes('/') && entry.path !== 'arcane-bundle.json');
      const integrityFiles = verifiedEntries.map((entry) => ({
        ...entry,
        installPath: entry.path === 'arcane-bundle.json' || entry.path.startsWith('app/') ? entry.path : `bin/${entry.path}`,
      }));
      return {
        mode: 'linux-webkitgtk',
        releaseReady: true,
        verified: true,
        releaseManifest,
        integrity: {
          schemaVersion: releaseManifest.schemaVersion,
          hashAlgorithm: releaseManifest.hashAlgorithm,
          sourceManifest: releaseManifestPath,
          files: integrityFiles,
        },
        bundleManifestSource: ctx.path.join(dist, 'arcane-bundle.json'),
        assetFiles: ['arcane-sigil.svg', 'arcane-sigil-512.png', 'arcane-sigil.ico'].map((name) => ({
          source: ctx.path.join(appDirectory, 'shared', name),
          destinationName: name,
        })),
        description: 'Verified Linux WebKitGTK hosts, packaged Arcane Core, and application assets are ready for installation.',
        files: topLevelFiles.map((entry) => ({ source: ctx.path.join(dist, entry.path), destinationName: entry.path, executable: true })),
        directories: [{ source: appDirectory, destinationName: 'app' }],
        missingRelease: [],
      };
    }
    const sourceCore = ctx.path.join(root, 'runtime', 'arcane-core.cjs');
    return {
      mode: 'source',
      releaseReady: false,
      verified: false,
      description: releaseProblem || 'The source Arcane Core is available, but a verified Linux WebKitGTK release has not been built.',
      files: ctx.fs.existsSync(sourceCore) ? [{ source: sourceCore, destinationName: 'arcane-core.cjs' }] : [],
      directories: [],
      missingRelease: [...new Set(missingRelease)],
      releaseProblem,
    };
  }

  async function writeLaunchers(stage, payload) {
    const executable = payload && payload.mode === 'linux-webkitgtk';
    const shellLauncher = executable
      ? '#!/bin/sh\nexec "$(dirname "$0")/ArcaneShell" "$@"\n'
      : '#!/bin/sh\nexec node "$(dirname "$0")/arcane-shell.cjs" "$@"\n';
    const provisionerLauncher = executable
      ? '#!/bin/sh\nexec "$(dirname "$0")/ArcaneProvisioner" "$@"\n'
      : '#!/bin/sh\nexec node "$(dirname "$0")/arcane-provisioner.cjs" "$@"\n';
    await ctx.writeFile(ctx.path.join(stage, 'bin', 'arcane-shell'), shellLauncher, 0o755);
    await ctx.writeFile(ctx.path.join(stage, 'bin', 'arcane-provisioner'), provisionerLauncher, 0o755);
  }

  async function applyInstallPermissions(action) {
    await ctx.run('chown', ['-R', 'root:root', paths.installRoot], { action });
    await ctx.run('chmod', ['-R', 'a+rX,u+w', paths.installRoot], { action });
    await addMachinePath();
    if (!ctx.simulate) {
      const iconSource = ctx.path.join(paths.installRoot, 'assets', 'arcane-sigil-512.png');
      const iconTarget = '/usr/share/pixmaps/arcane-os.png';
      await ctx.ensureDir('/usr/share/pixmaps');
      if (ctx.fs.existsSync(iconSource)) await ctx.fsp.copyFile(iconSource, iconTarget);
      await ctx.ensureDir('/usr/share/applications');
      const shellDesktop = `[Desktop Entry]
Type=Application
Name=Arcane Shell
Comment=Open the Arcane operating environment
Exec=${ctx.path.join(paths.installRoot, 'bin', 'arcane-shell')} --shell
Icon=arcane-os
Terminal=false
Categories=System;
`;
      const provisionerDesktop = `[Desktop Entry]
Type=Application
Name=Arcane Provisioner
Comment=Install and provision Arcane OS
Exec=${ctx.path.join(paths.installRoot, 'bin', 'arcane-provisioner')}
Icon=arcane-os
Terminal=false
Categories=System;Settings;
`;
      await ctx.writeFile('/usr/share/applications/arcane-shell.desktop', shellDesktop, 0o644);
      await ctx.writeFile('/usr/share/applications/arcane-provisioner.desktop', provisionerDesktop, 0o644);
      if (commandExists('update-desktop-database')) await ctx.run('update-desktop-database', ['/usr/share/applications'], { action, allowFailure: true });
    }
  }

  async function applyStatePermissions(action) {
    await ctx.ensureDir(paths.stateRoot);
    await ctx.run('chown', ['-R', 'root:root', paths.stateRoot], { action });
    await ctx.run('chmod', ['0755', paths.stateRoot], { action });
    for (const name of ['users.json', 'users.json.previous', 'install.json']) {
      const file = ctx.path.join(paths.stateRoot, name);
      if (ctx.fs.existsSync(file)) await ctx.run('chmod', ['0600', file], { action });
    }
  }

  function shellCommand() {
    return ctx.path.join(paths.installRoot, 'bin', 'arcane-shell');
  }

  function usernamePolicy() {
    return {
      platform: 'linux',
      minimumLength: 1,
      maximumLength: 32,
      description: 'Use 1–32 lowercase letters, numbers, underscores, or hyphens. Begin with a lowercase letter or underscore. Spaces are not allowed.',
      example: 'arcane-user',
    };
  }

  function validateUsername(input) {
    const value = String(input || '').trim();
    const policy = usernamePolicy();
    const fail = (message, resolution, reason) => {
      const error = ctx.arcaneError('INVALID_USERNAME', message, resolution, 400);
      error.field = 'username';
      error.input = value;
      error.reason = reason;
      error.policy = policy;
      throw error;
    };
    if (!value) fail('Enter a username for the Arcane account.', `Example: ${policy.example}.`, 'empty');
    if (/\s/.test(value)) fail(`“${value}” cannot be used because Linux usernames cannot contain spaces.`, `Try “${value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '') || policy.example}”. ${policy.description}`, 'contains-spaces');
    if (value.length > policy.maximumLength) fail(`“${value}” is ${value.length} characters long; this Linux account name can be at most ${policy.maximumLength} characters.`, `Shorten the name. Example: ${policy.example}.`, 'too-long');
    if (!/^[a-z_][a-z0-9_-]*$/.test(value)) fail(`“${value}” is not a valid Linux account name.`, policy.description, 'invalid-characters');
    const reserved = ['root', 'daemon', 'nobody'];
    if (reserved.includes(value)) {
      const error = ctx.arcaneError('RESERVED_USERNAME', `“${value}” is a protected Linux account name.`, `Choose another name, such as ${policy.example}.`, 409);
      error.field = 'username';
      error.input = value;
      error.policy = policy;
      throw error;
    }
    return value;
  }

  function userExists(username) {
    if (ctx.simulate) return simulatedAccounts.has(String(username).toLowerCase());
    const id = systemCommand('id');
    return Boolean(id && ctx.spawnSync(id, ['-u', username], { stdio: 'ignore' }).status === 0);
  }

  function passwdRecord(username) {
    if (ctx.simulate) {
      const key = String(username).toLowerCase();
      if (!simulatedAccounts.has(key)) return null;
      return {
        username,
        uid: 1000,
        profile: `/home/${username}`,
        shell: simulatedShellAssignments.has(key) ? shellCommand() : defaultLoginShell(),
      };
    }
    const passwd = ctx.fs.readFileSync('/etc/passwd', 'utf8');
    for (const line of passwd.split(/\r?\n/)) {
      const fields = line.split(':');
      if (fields.length >= 7 && fields[0] === username) {
        return { username, uid: Number(fields[2]), profile: fields[5] || null, shell: fields[6] || null };
      }
    }
    return null;
  }

  function defaultLoginShell() {
    return ['/bin/bash', '/bin/sh'].find((candidate) => ctx.fs.existsSync(candidate)) || '/bin/sh';
  }

  async function listArcaneUsers(recordedUsernames) {
    const expectedShell = shellCommand();
    const recorded = new Set((recordedUsernames || []).map((value) => String(value || '').trim()).filter(Boolean));
    if (ctx.simulate) {
      const names = [...new Map([...recorded, ...[...simulatedShellAssignments.values()].map((item) => item.username)].map((value) => [value.toLowerCase(), value])).values()];
      return names.map((username) => ({
        username,
        shell: simulatedShellAssignments.has(username.toLowerCase()) ? expectedShell : defaultLoginShell(),
        shellAssigned: simulatedShellAssignments.has(username.toLowerCase()),
        enabled: true,
        profile: `/home/${username}`,
        verification: 'simulated',
        source: 'native-linux',
      }));
    }
    const passwd = await ctx.fsp.readFile('/etc/passwd', 'utf8').catch(() => '');
    const users = [];
    for (const line of passwd.split(/\r?\n/)) {
      if (!line) continue;
      const fields = line.split(':');
      if (fields.length < 7) continue;
      const [username, , uidText, , , home, shell] = fields;
      const assigned = shell === expectedShell;
      if (!assigned && !recorded.has(username)) continue;
      users.push({
        username,
        uid: Number(uidText),
        enabled: shell !== '/usr/sbin/nologin' && shell !== '/bin/false',
        profile: home || null,
        shell: shell || null,
        shellAssigned: assigned,
        verification: 'verified',
        source: 'native-linux',
      });
    }
    for (const username of recorded) {
      if (!users.some((item) => item.username === username)) {
        users.push({ username, shell: null, shellAssigned: false, enabled: null, profile: null, verification: 'recorded-only', source: 'arcane-state' });
      }
    }
    return users;
  }

  async function prepareUserShellBackup(username) {
    const existing = passwdRecord(username);
    return {
      username,
      accountExisted: Boolean(existing),
      previousShell: existing && existing.shell || defaultLoginShell(),
      previousShellPresent: true,
      profile: existing && existing.profile || null,
      uid: existing && existing.uid !== undefined ? existing.uid : null,
      verification: ctx.simulate ? 'simulated' : 'verified',
    };
  }

  async function provisionUser(username, password, action, shellBackup) {
    const shell = shellCommand();
    const existing = passwdRecord(username);
    const exists = Boolean(existing);
    const previousShell = existing && existing.shell || defaultLoginShell();
    if (!shellBackup || Boolean(shellBackup.accountExisted) !== exists || !shellBackup.previousShellPresent || shellBackup.previousShell !== previousShell) {
      throw ctx.arcaneError(
        'SHELL_CHANGED_EXTERNALLY',
        `The Linux account or login shell for “${username}” changed after Arcane saved its recovery record.`,
        'No shell change was made. Refresh the account list and try again.',
        409
      );
    }
    if (ctx.simulate) {
      const key = username.toLowerCase();
      simulatedAccounts.add(key);
      simulatedShellAssignments.set(key, { username, shell });
      return { username, created: !exists, uid: 1000, profile: `/home/${username}`, shell, previousShell, previousShellPresent: true };
    }
    throw ctx.arcaneError(
      'LINUX_DESKTOP_SESSION_REQUIRED',
      'Arcane will not replace a Linux account’s POSIX login shell with a graphical application.',
      'Install an Arcane desktop-session entry or launch Arcane manually. User provisioning remains disabled until a display-manager-safe session wrapper is installed.',
      409
    );
    /* istanbul ignore next -- retained as the future desktop-session implementation boundary. */
    if (!ctx.fs.existsSync(shell)) {
      throw ctx.arcaneError(
        'ARCANE_SHELL_MISSING',
        'Arcane will not change a user shell because the Arcane shell launcher is missing.',
        'Repair the global Arcane installation, verify the release, and try again.'
      );
    }
    const shells = await ctx.fsp.readFile('/etc/shells', 'utf8').catch(() => '');
    if (!shells.split(/\r?\n/).includes(shell)) await ctx.fsp.appendFile('/etc/shells', `\n${shell}\n`);
    if (!exists) {
      await ctx.run('useradd', ['-m', '-s', previousShell, username], { action });
      await ctx.run('chpasswd', [], { action, input: `${username}:${password}\n` });
      await ctx.run('chage', ['-d', '0', username], { action });
    }
    await ctx.run('usermod', ['-s', shell, username], { action });
    const verified = passwdRecord(username);
    if (!verified || verified.shell !== shell) {
      throw ctx.arcaneError(
        'LINUX_SHELL_ASSIGNMENT_FAILED',
        `Linux did not retain the Arcane shell assignment for “${username}”.`,
        'Confirm the account is signed out and Arcane has root authorization, then retry.'
      );
    }
    return {
      username,
      created: !exists,
      uid: verified.uid,
      profile: verified.profile,
      shell,
      previousShell,
      previousShellPresent: true,
    };
  }

  async function activateProvisionedUser(username, staged) {
    if (!staged || !staged.created) {
      throw ctx.arcaneError('INVALID_STAGED_ACCOUNT', 'Arcane cannot activate an account without its staged creation record.', 'Retry the complete Add Arcane user operation.', 409);
    }
    if (ctx.simulate) return { username, uid: staged.uid, enabled: true, activated: true };
    throw ctx.arcaneError(
      'LINUX_DESKTOP_SESSION_REQUIRED',
      'Linux account activation remains disabled until Arcane uses a display-manager-safe desktop session.',
      'Use the supported Windows provisioner or launch Arcane manually on Linux.',
      409
    );
  }

  async function rollbackCreatedUser(username, staged) {
    if (!staged || !staged.created) {
      throw ctx.arcaneError('INVALID_STAGED_ACCOUNT', 'Arcane refused to remove an account without its staged creation record.', 'Recover the account manually as an administrator.', 409);
    }
    if (ctx.simulate) {
      const key = username.toLowerCase();
      simulatedShellAssignments.delete(key);
      simulatedAccounts.delete(key);
      return { username, uid: staged.uid, accountDisabled: true, accountRemoved: true, cleanupErrors: [] };
    }
    throw ctx.arcaneError(
      'LINUX_DESKTOP_SESSION_REQUIRED',
      'Linux account rollback is unavailable because real Linux account provisioning is disabled.',
      'No Linux account should have been created by this build.',
      409
    );
  }

  async function resetUserPassword(username, password, action) {
    if (ctx.simulate) return { username, passwordReset: true, mustChangeAtNextSignIn: true };
    if (!userExists(username)) {
      throw ctx.arcaneError('USER_NOT_FOUND', `The Linux account “${username}” does not exist.`, 'Add the Arcane user first, then set its temporary password.', 404);
    }
    try {
      await ctx.run('chpasswd', [], {
        action,
        input: `${username}:${password}\n`,
        displayCommand: '$ chpasswd [protected Arcane password reset]',
      });
      await ctx.run('chage', ['-d', '0', username], { action });
      return { username, passwordReset: true, mustChangeAtNextSignIn: true };
    } catch (error) {
      error.code = error.code === 'COMMAND_FAILED' ? 'LINUX_PASSWORD_RESET_FAILED' : error.code;
      error.userMessage = `Linux could not set a temporary password for “${username}”.`;
      error.resolution = 'Confirm the account exists and that Arcane has root authorization, then try again.';
      error.username = username;
      throw error;
    }
  }

  async function restoreUserShell(username, previousShell, previousShellPresent, action) {
    const restoredShell = previousShellPresent && previousShell ? previousShell : defaultLoginShell();
    if (ctx.simulate) {
      simulatedShellAssignments.delete(username.toLowerCase());
      return { username, restored: true, shell: restoredShell, shellAssigned: false, verification: 'simulated' };
    }
    const current = passwdRecord(username);
    if (!current) {
      throw ctx.arcaneError('USER_NOT_FOUND', `The Linux account “${username}” does not exist.`, 'Confirm the account name and retry.', 404);
    }
    if (current.shell !== shellCommand()) {
      throw ctx.arcaneError(
        'SHELL_CHANGED_EXTERNALLY',
        `Arcane refused to overwrite the current login shell for “${username}” because it is no longer the Arcane shell.`,
        'Review the account manually. No shell change was made.',
        409
      );
    }
    if (!ctx.fs.existsSync(restoredShell)) {
      throw ctx.arcaneError(
        'PREVIOUS_SHELL_MISSING',
        `The previous login shell for “${username}” is no longer installed.`,
        `Install ${restoredShell} or select another login shell manually before removing Arcane.`,
        409,
        { previousShell: restoredShell }
      );
    }
    await ctx.run('usermod', ['-s', restoredShell, username], { action });
    const verified = passwdRecord(username);
    if (!verified || verified.shell !== restoredShell) {
      throw ctx.arcaneError(
        'LINUX_SHELL_RESTORE_FAILED',
        `Linux did not retain the restored shell for “${username}”.`,
        'Confirm the account is signed out and Arcane has root authorization, then retry.'
      );
    }
    return {
      username,
      restored: true,
      shell: restoredShell,
      shellAssigned: false,
      profile: verified.profile,
      uid: verified.uid,
      verification: 'verified',
    };
  }

  function launchBrowser(url, options) {
    if (ctx.noBrowser) return null;
    const candidates = browserCandidates();
    if (candidates.length) {
      const executable = candidates[0];
      const isFirefox = executable.includes('firefox');
      const browserArgs = isFirefox
        ? [url]
        : options && options.shellMode
          ? ['--kiosk', url, '--no-first-run', '--disable-session-crashed-bubble']
          : ['--app=' + url, '--no-first-run'];
      return ctx.spawn(executable, browserArgs, { stdio: 'ignore' });
    }
    const opener = systemCommand('xdg-open');
    if (!opener) return null;
    const child = ctx.spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return child;
  }

  function elevationTarget(currentExecutable) { return currentExecutable; }

  async function launchElevated(executable, relaunchArgs, action) {
    if (ctx.simulate) {
      ctx.actionLog(action, 'info', 'Simulation: authorizing a temporary privileged Arcane worker.');
      const child = ctx.spawn(executable, relaunchArgs, { detached: true, stdio: 'ignore' });
      child.unref();
      return { launcher: 'simulated-polkit', launcherPid: child.pid || null, bootstrapFile: null };
    }
    throw ctx.arcaneError(
      'PRIVILEGE_PEER_VERIFICATION_UNAVAILABLE',
      'Arcane has disabled automatic administrator brokering on Linux because the worker peer cannot yet be verified by the kernel.',
      'Run the signed Arcane Core from an already-root administrator session, or wait for a release with SO_PEERCRED enforcement.'
    );
  }

  return Object.freeze({
    id: 'linux',
    supportsUserProvisioning: false,
    paths,
    commandExists,
    currentIdentity,
    protectedUsernames,
    osInfo,
    permissionStatus,
    isElevated,
    hideHostWindow,
    nodeExecutable,
    ollamaExecutable,
    browserExecutable,
    browserCandidates,
    rendererStatus,
    sessionControlExecutable,
    lockSpec,
    logoutSpec,
    provisionerCandidates,
    nodeArchiveName,
    installNodePackage,
    installOllama,
    installBrowser,
    installRenderer,
    addMachinePath,
    installPayload,
    writeLaunchers,
    applyInstallPermissions,
    applyStatePermissions,
    shellCommand,
    usernamePolicy,
    validateUsername,
    userExists,
    listArcaneUsers,
    prepareUserShellBackup,
    provisionUser,
    activateProvisionedUser,
    rollbackCreatedUser,
    resetUserPassword,
    restoreUserShell,
    launchBrowser,
    elevationTarget,
    launchElevated,
  });
}


const VERSION = "0.8.2";
const BUNDLE_MANIFEST = {"name":"Arcane OS Machine Bundle","version":"0.8.2","protocolVersion":"arcane/1","description":"Native WebView Arcane shell and machine provisioner for Windows and Linux.","build":{"webview2SdkVersion":"1.0.4078.44","webview2SdkSha256":"dc4d1d9168df26b830398303e50210b6e1729f6ce5a7ac69d2c766852f489962"},"apps":{"provisioner":{"displayName":"Arcane Provisioner","type":"provisioner","entry":"provisioner/index.html","capabilities":["system.read","identity.read","system.metrics.read","network.status.read","requirements.read","installation.read","users.manage","diagnostics.read","provisioning.manage"]},"shell":{"displayName":"Arcane Shell","type":"shell","entry":"shell/index.html","capabilities":["system.read","identity.read","system.metrics.read","network.status.read","diagnostics.read","applications.read","applications.launch","session.control","storage.read","storage.write","media.microphone"]}},"requirements":{"node":{"minimumVersion":"22.0.0","installMajor":24,"installPolicy":"optional; install separately from a trusted administrator-managed package channel"},"ollama":{"minimumVersion":"0.30.0","installPolicy":"optional; install separately from a trusted administrator-managed package channel"},"renderer":{"minimumVersion":null,"windows":"Microsoft Edge WebView2 Evergreen Runtime","linux":"WebKitGTK 6.0 / GTK 4 (WebKitGTK 2.40 or newer recommended)"},"session-control":{"minimumVersion":null,"installPolicy":"native Windows session control or supported Linux desktop/login manager"}}};
const PROTOCOL = 'arcane/1';
const argv = process.argv.slice(2);
const args = new Set(argv);
const argValue = (prefix) => {
  const value = argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
};
const appMode = argValue('--app=') || process.env.ARCANE_APP || 'provisioner';
const simulate = args.has('--simulate') || process.env.ARCANE_SIMULATE_PROVISIONING === '1';
const simulateStandard = args.has('--simulate-standard') || process.env.ARCANE_SIMULATE_STANDARD === '1';
const hostPlatform = process.platform;
const simulatedPlatform = simulate && !process.pkg ? argValue('--simulate-platform=') || process.env.ARCANE_SIMULATE_PLATFORM || '' : '';
const simulatedUserFailure = simulate ? argValue('--simulate-user-failure=') || '' : '';
const simulatedCapabilityOverride = simulate && !process.pkg
  ? String(argValue('--simulate-capabilities=') || '').split(',').map((value) => value.trim()).filter(Boolean)
  : [];
const simulatedExclusiveMutationDelayMs = simulate && !process.pkg
  ? Math.min(5000, Math.max(0, Number(argValue('--simulate-exclusive-mutation-delay-ms=') || 0) || 0))
  : 0;
const sessionCommandSelfTest = simulate && !process.pkg ? argValue('--self-test-session-command=') || '' : '';
const platform = ['win32', 'linux'].includes(simulatedPlatform) ? simulatedPlatform : hostPlatform;
const productionPackaged = Boolean(process.pkg) && !simulate;
const noBrowser = true;
const hideConsole = true;
const bundleRootOverride = productionPackaged ? '' : argValue('--bundle-root=') || process.env.ARCANE_BUNDLE_ROOT || '';
const allowSourceInstall = !productionPackaged && (args.has('--allow-source-install') || process.env.ARCANE_ALLOW_SOURCE_INSTALL === '1');
const selfTestOutput = argValue('--self-test-output=') || '';
const privilegedWorker = args.has('--privileged-worker');
const ipcEndpoint = argValue('--ipc=') || '';
const ipcToken = argValue('--token=') || '';
const ipcBrokerPid = Number(argValue('--broker-pid=') || 0);
const ipcBrokerSession = argValue('--broker-session=') || '';
const ipcBrokerPublicKey = argValue('--broker-public-key=') || '';
const simulateBrokerFirstClient = simulate && !process.pkg && args.has('--simulate-broker-first-client');
const allowUnsignedLocalRelease = !simulate && args.has('--allow-unsigned-local-release');
const elevationProtectedUsername = argValue('--protected-user=') || process.env.ARCANE_PROTECTED_USERNAME || null;
let simulatedInstallationManifest = null;
let simulatedArcaneUsersState = { schemaVersion: 1, users: {} };
let simulatedAppStorage = Object.create(null);
const actions = new Map();
const recentErrors = [];
const bridgeToken = '';
const nativeContext = {
  platform,
  simulate,
  simulatedPlatform,
  simulatedUserFailure,
  simulatedUserFailureTriggered: false,
  noBrowser,
  hideConsole,
  processPkg: Boolean(process.pkg),
  production:productionPackaged,
  os,
  fs,
  fsp,
  path,
  crypto,
  bundleVersion: VERSION,
  bundleManifest: BUNDLE_MANIFEST,
  spawn,
  spawnSync,
};
const native = platform === 'win32'
  ? createWindowsNativeAdapter(nativeContext)
  : platform === 'linux'
    ? createLinuxNativeAdapter(nativeContext)
    : null;
if (!native) {
  console.error(`Arcane Core does not yet support ${platform}.`);
  process.exit(4);
}
const PATHS = native.paths;
const windowsSystemRoot=productionPackaged ? 'C:\\Windows' : process.env.SystemRoot || 'C:\\Windows';
const windowsSystem32=path.join(windowsSystemRoot,'System32');
const windowsPowerShell=path.join(windowsSystem32,'WindowsPowerShell','v1.0','powershell.exe');
const trustedWindowsPath=[
  windowsSystem32,
  path.join(windowsSystemRoot,'System'),
  path.join(windowsSystemRoot),
  path.dirname(windowsPowerShell),
].join(';');
const trustedLinuxPath='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const safeSubprocessEnvironment=platform==='win32'
  ? {
      SystemRoot:windowsSystemRoot,
      windir:windowsSystemRoot,
      ProgramFiles:productionPackaged ? 'C:\\Program Files' : process.env.ProgramFiles || 'C:\\Program Files',
      'ProgramFiles(x86)':productionPackaged ? 'C:\\Program Files (x86)' : process.env['ProgramFiles(x86)'] || process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      ProgramData:productionPackaged ? 'C:\\ProgramData' : process.env.ProgramData || 'C:\\ProgramData',
      LOCALAPPDATA:process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),
      USERPROFILE:process.env.USERPROFILE || os.homedir(),
      USERNAME:process.env.USERNAME || '',
      USERDOMAIN:process.env.USERDOMAIN || '',
      COMPUTERNAME:process.env.COMPUTERNAME || os.hostname(),
      PATH:trustedWindowsPath,
      Path:trustedWindowsPath,
      PATHEXT:'.COM;.EXE;.BAT;.CMD',
      ComSpec:path.join(windowsSystem32,'cmd.exe'),
      PSModulePath:path.join(path.dirname(windowsPowerShell),'Modules'),
    }
  : {
      PATH:trustedLinuxPath,
      HOME:process.env.HOME || os.homedir(),
      USER:process.env.USER || '',
      LOGNAME:process.env.LOGNAME || process.env.USER || '',
      LANG:process.env.LANG || 'C.UTF-8',
      DISPLAY:process.env.DISPLAY || '',
      WAYLAND_DISPLAY:process.env.WAYLAND_DISPLAY || '',
      XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR || '',
      DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS || '',
    };
const safeSubprocessCwd=platform==='win32' ? windowsSystem32:'/';
const APP_REGISTRY = BUNDLE_MANIFEST.apps && typeof BUNDLE_MANIFEST.apps === 'object'
  ? BUNDLE_MANIFEST.apps
  : {};
const APP_DESCRIPTOR = APP_REGISTRY[appMode] && typeof APP_REGISTRY[appMode] === 'object'
  ? APP_REGISTRY[appMode]
  : { displayName: appMode, type: 'app', entry: null, capabilities: [] };
const APP_CAPABILITIES = new Set(
  simulatedCapabilityOverride.length
    ? simulatedCapabilityOverride
    : Array.isArray(APP_DESCRIPTOR.capabilities)
    ? APP_DESCRIPTOR.capabilities.map((value) => String(value || '').trim()).filter(Boolean)
    : []
);
const APPLICATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const APPLICATION_ID_MAX_LENGTH = 64;
const APPLICATION_CATALOG_MAX_RECORDS = 128;
const RESERVED_APPLICATION_IDS = new Set(['provisioner','shell']);

function stamp() { return new Date().toISOString(); }
function log(message, details) {
  details === undefined
    ? console.error(`[${stamp()}] ${message}`)
    : console.error(`[${stamp()}] ${message}`, details);
}
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function arcaneError(code, userMessage, resolution, statusCode, details) {
  const error = new Error(userMessage || code || 'Arcane operation failed.');
  error.code = code || 'ARCANE_ERROR';
  error.userMessage = userMessage || error.message;
  error.resolution = resolution || null;
  error.statusCode = statusCode || 500;
  if (details && typeof details === 'object') Object.assign(error, details);
  return error;
}
function decodeXml(value) {
  return String(value || '')
    .replace(/_x000D__x000A_/gi, '\n')
    .replace(/_x000D_/gi, '\r')
    .replace(/_x000A_/gi, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
function cleanPowerShellError(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const xmlLines = [...raw.matchAll(/<S\s+S="Error">([\s\S]*?)<\/S>/gi)]
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean);
  const source = xmlLines.length ? xmlLines.join('\n') : decodeXml(raw.replace(/^#< CLIXML\s*/i, ''));
  const lines = source.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('Preparing modules for first use.'));
  const meaningful = lines.filter((line) =>
    !/^At line:\d+/i.test(line) &&
    !/^\+\s/.test(line) &&
    !/^~+$/i.test(line) &&
    !/^\+ CategoryInfo/i.test(line) &&
    !/^\+ FullyQualifiedErrorId/i.test(line)
  );
  return [...new Set(meaningful.length ? meaningful : lines)].join(' ');
}
function normalizeError(error) {
  const technicalMessage = error && error.message ? error.message : String(error);
  let userMessage = error && error.userMessage ? error.userMessage : technicalMessage;
  let resolution = error && error.resolution ? error.resolution : null;
  const code = error && error.code ? error.code : 'ERROR';
  if (code === 'COMMAND_FAILED' && !error.userMessage) {
    userMessage = 'A required operating-system command did not complete successfully.';
    resolution = 'Open full diagnostics to see the command output, then correct the reported system issue and try again.';
  } else if ((code === 'EACCES' || code === 'EPERM') && !error.userMessage) {
    userMessage = 'Arcane was not permitted to make this machine change.';
    resolution = 'Approve administrator access and try the action again.';
  }
  return {
    code,
    message: userMessage,
    userMessage,
    resolution,
    technicalMessage,
    status: error && error.statusCode ? error.statusCode : 500,
    command: error && error.command ? error.command : null,
    args: error && error.args ? error.args : null,
    exitCode: error && error.exitCode !== undefined ? error.exitCode : null,
    stdout: error && error.stdout ? error.stdout : null,
    stderr: error && error.stderr ? error.stderr : null,
    readableStderr: error && error.stderr ? cleanPowerShellError(error.stderr) : null,
    field: error && error.field ? error.field : null,
    input: error && error.input !== undefined ? error.input : null,
    reason: error && error.reason ? error.reason : null,
    policy: error && error.policy ? error.policy : null,
    username: error && error.username ? error.username : null,
    method: error && error.method ? error.method : null,
    application: error && error.application ? error.application : null,
    requiredCapability: error && error.requiredCapability ? error.requiredCapability : null,
    activeOperation: error && error.activeOperation ? error.activeOperation : null,
    retryable: Boolean(error && error.retryable),
  };
}
function recordError(scope, error, details) {
  const normalized = normalizeError(error);
  const entry = {
    id: crypto.randomUUID(),
    time: stamp(),
    scope,
    ...normalized,
    details: details || null,
  };
  recentErrors.unshift(entry);
  if (recentErrors.length > 60) recentErrors.pop();
  log(`ERROR [${scope}] ${normalized.technicalMessage}`, details);
  return entry;
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}
function sendText(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}
function sendBinary(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=86400, immutable',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}
function loopback(req) {
  const remote = req.socket.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}
function trusted(req) {
  if (!loopback(req)) return false;
  const token = String(req.headers['x-arcane-bridge'] || '');
  return token && crypto.timingSafeEqual(
    Buffer.from(token.padEnd(43, '\0').slice(0, 43)),
    Buffer.from(bridgeToken.padEnd(43, '\0').slice(0, 43))
  );
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(arcaneError('REQUEST_TOO_LARGE', 'The Arcane request was too large.', 'Reduce the submitted data and try again.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (_) { reject(arcaneError('INVALID_JSON', 'Arcane received an invalid request.', 'Reload the page and try again.', 400)); }
    });
    req.on('error', reject);
  });
}
function parseVersion(value) {
  const match = String(value || '').match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)] : null;
}
function compareVersions(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av && !bv) return 0;
  if (!av) return -1;
  if (!bv) return 1;
  for (let index = 0; index < 3; index += 1) {
    if (av[index] > bv[index]) return 1;
    if (av[index] < bv[index]) return -1;
  }
  return 0;
}
function cleanVersion(value) {
  const version = parseVersion(value);
  return version ? version.join('.') : null;
}
function psQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
function commandExists(command) { return native.commandExists(command); }
function currentIdentity() { return native.currentIdentity(); }
function osInfo() { return native.osInfo(simulatedPlatform); }
function protectedProvisioningUsernames() { return native.protectedUsernames(elevationProtectedUsername); }
function protectedProvisioningUsername() { return protectedProvisioningUsernames()[0] || currentIdentity().username; }
function permissionStatus(refresh) {
  if (simulate && simulateStandard && !privilegedWorker) {
    return { elevated: false, level: 'standard', canElevate: true, mechanism: platform === 'win32' ? 'uac-simulation' : 'polkit-simulation', detectedBy: 'simulation', probes: [] };
  }
  if (simulate && privilegedWorker) {
    return { elevated: true, level: platform === 'win32' ? 'administrator' : 'root', canElevate: true, mechanism: 'privileged-worker-simulation', detectedBy: 'simulation', probes: [] };
  }
  if (native.permissionStatus) return native.permissionStatus({ refresh: Boolean(refresh) });
  const elevated = native.isElevated(Boolean(refresh));
  return { elevated, level: elevated ? 'administrator' : 'standard', canElevate: true, mechanism: null, detectedBy: 'native-adapter', probes: [] };
}
function isElevated(refresh) { return permissionStatus(refresh).elevated; }
function bundleRoot() {
  const executableDir = path.dirname(process.execPath);
  const candidates = [
    bundleRootOverride,
    process.pkg && executableDir,
    process.pkg && path.resolve(executableDir, '..'),
    path.resolve(__dirname, '..'),
    __dirname,
    process.cwd(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'arcane-bundle.json'))) return candidate;
    if (fs.existsSync(path.join(candidate, 'runtime', 'arcane-shell.cjs'))) return candidate;
  }
  return path.resolve(__dirname, '..');
}
function installManifestPath() { return path.join(PATHS.installRoot, 'arcane-install.json'); }
function arcaneUsersStatePath() { return path.join(PATHS.stateRoot, 'users.json'); }
function arcaneUsersStateBackupPath() { return `${arcaneUsersStatePath()}.previous`; }
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}
function normalizeIntegrityPath(input) {
  const value = String(input || '');
  if (!value || value.includes('\\') || value.includes(':') || value.includes('\0') || path.posix.isAbsolute(value)) {
    throw new Error(`Invalid installed integrity path: ${JSON.stringify(value)}.`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Installed integrity path is not normalized: ${value}.`);
  }
  return value;
}
function integrityFilePath(root, relativePath) {
  const normalized = normalizeIntegrityPath(relativePath);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...normalized.split('/'));
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (target !== resolvedRoot && !target.startsWith(prefix)) throw new Error(`Installed integrity path escapes its root: ${normalized}.`);
  return target;
}
function fileSha256Sync(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function collectInstalledFiles(root) {
  const files = [];
  const visit = (directory, relativeDirectory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!relativeDirectory && relativePath === 'arcane-install.json') continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Installed payload contains a symbolic link: ${relativePath}.`);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile()) files.push(normalizeIntegrityPath(relativePath));
      else throw new Error(`Installed payload contains an unsupported filesystem entry: ${relativePath}.`);
    }
  };
  visit(root, '');
  return files.sort();
}
function createInstalledIntegrity(root) {
  const files = collectInstalledFiles(root).map((relativePath) => {
    const file = integrityFilePath(root, relativePath);
    const stat = fs.statSync(file);
    return { path: relativePath, size: stat.size, sha256: fileSha256Sync(file) };
  });
  return { schemaVersion: 2, hashAlgorithm: 'sha256', scope: 'installed-tree', files };
}
function verifyIntegrityEntries(root, entries, exactInventory) {
  const expected = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const relativePath = normalizeIntegrityPath(entry && (entry.installPath || entry.path));
    if (expected.has(relativePath)) throw new Error(`Installed integrity contains a duplicate path: ${relativePath}.`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Installed integrity has an invalid size for ${relativePath}.`);
    if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) throw new Error(`Installed integrity has an invalid SHA-256 for ${relativePath}.`);
    expected.set(relativePath, entry);
  }
  if (!expected.size) throw new Error('Installed integrity contains no files.');
  if (exactInventory) {
    const actualPaths = collectInstalledFiles(root);
    if (actualPaths.length !== expected.size || actualPaths.some((relativePath) => !expected.has(relativePath))) {
      throw new Error('Installed file inventory does not match its integrity metadata.');
    }
  }
  for (const [relativePath, entry] of expected) {
    const file = integrityFilePath(root, relativePath);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${relativePath} is not a regular installed file.`);
    if (stat.size !== entry.size) throw new Error(`${relativePath} does not match its installed size.`);
    if (fileSha256Sync(file).toLowerCase() !== String(entry.sha256).toLowerCase()) {
      throw new Error(`${relativePath} does not match its installed SHA-256.`);
    }
  }
  return { ok: true, checkedFiles: expected.size, reason: null };
}
function verifyInstalledIntegrity(manifest) {
  if (simulate) return { ok: true, checkedFiles: 0, reason: null, simulated: true };
  return verifyInstalledIntegrityAt(PATHS.installRoot, manifest);
}
function verifyInstalledIntegrityAt(root, manifest) {
  try {
    const integrity = manifest && manifest.integrity;
    if (!integrity || integrity.schemaVersion !== 2 || integrity.hashAlgorithm !== 'sha256') {
      throw new Error('Installed integrity metadata is missing or obsolete.');
    }
    if (!fs.existsSync(root)) throw new Error('The Arcane installation directory is missing.');
    return verifyIntegrityEntries(root, integrity.files, true);
  } catch (error) {
    return { ok: false, checkedFiles: 0, reason: error.message };
  }
}
async function recoverInterruptedInstallation(action) {
  if (simulate) return { recovered: false, simulated: true };
  const root = PATHS.installRoot;
  const backup = `${root}.backup`;
  if (!fs.existsSync(backup)) return { recovered: false };

  const backupManifest = readJsonFile(path.join(backup, 'arcane-install.json'));
  const backupVerification = verifyInstalledIntegrityAt(backup, backupManifest);
  if (!fs.existsSync(root)) {
    if (!backupVerification.ok) {
      throw arcaneError(
        'INSTALL_BACKUP_INVALID',
        'Arcane found an interrupted installation backup, but it did not pass integrity verification.',
        'Preserve the backup for administrator review and repair Arcane from a complete verified release.',
        409,
        { backup, verification: backupVerification }
      );
    }
    await fsp.rename(backup, root);
    actionLog(action, 'warn', 'Arcane restored the last verified installation after an interrupted activation.', { backupVerification });
    return { recovered: true, source: backup };
  }

  const rootManifest = readJsonFile(path.join(root, 'arcane-install.json'));
  const rootVerification = verifyInstalledIntegrityAt(root, rootManifest);
  const rootIsLegacy = Boolean(rootManifest && rootManifest.version && compareVersions(VERSION, String(rootManifest.version)) > 0 && !rootManifest.integrity);
  const backupIsLegacy = Boolean(backupManifest && backupManifest.version && compareVersions(VERSION, String(backupManifest.version)) > 0 && !backupManifest.integrity);
  if (!rootVerification.ok && !backupVerification.ok && rootIsLegacy && backupIsLegacy) {
    const legacyVersion = String(backupManifest.version).replace(/[^0-9A-Za-z._-]/g, '_');
    const archive = `${backup}.legacy-${legacyVersion}-${Date.now()}`;
    await fsp.rename(backup, archive);
    actionLog(action, 'warn', 'Arcane preserved a pre-integrity legacy installation backup before upgrading.', {
      archive,
      activeVersion: rootManifest.version,
      backupVersion: backupManifest.version,
    });
    return { recovered: false, legacyBackupArchived: archive };
  }
  if (rootVerification.ok) {
    if (backupVerification.ok) await fsp.rm(backup, { recursive: true, force: true });
    else {
      const quarantine = `${backup}.invalid-${Date.now()}`;
      await fsp.rename(backup, quarantine);
      actionLog(action, 'warn', 'Arcane preserved an invalid stale installation backup for administrator review.', { quarantine, backupVerification });
    }
    return { recovered: false, activeVerified: true };
  }
  if (!backupVerification.ok) {
    throw arcaneError(
      'INSTALL_RECOVERY_FAILED',
      'Neither the active Arcane installation nor its interrupted-update backup passed integrity verification.',
      'Preserve both directories and repair Arcane from a complete verified release.',
      409,
      { rootVerification, backupVerification }
    );
  }

  const quarantine = `${root}.invalid-${Date.now()}`;
  await fsp.rename(root, quarantine);
  try { await fsp.rename(backup, root); }
  catch (error) {
    await fsp.rename(quarantine, root).catch(() => {});
    throw error;
  }
  actionLog(action, 'warn', 'Arcane replaced a damaged active installation with its last verified backup.', { quarantine, rootVerification, backupVerification });
  return { recovered: true, source: backup, quarantine };
}
async function snapshotActiveInstallationForRollback(action) {
  if (simulate || !fs.existsSync(PATHS.installRoot)) return null;
  const manifestPath = path.join(PATHS.installRoot, 'arcane-install.json');
  const existing = readJsonFile(manifestPath) || {};
  const currentVerification = verifyInstalledIntegrityAt(PATHS.installRoot, existing);
  if (currentVerification.ok) return existing;
  const snapshot = {
    ...existing,
    name: existing.name || 'Arcane OS legacy installation',
    version: existing.version || 'legacy-unknown',
    rollbackSnapshotAt: stamp(),
    integrity: createInstalledIntegrity(PATHS.installRoot),
  };
  await durableWriteFile(manifestPath, JSON.stringify(snapshot, null, 2), 0o600);
  const verification = verifyInstalledIntegrityAt(PATHS.installRoot, snapshot);
  if (!verification.ok) {
    throw arcaneError('ROLLBACK_SNAPSHOT_FAILED', 'Arcane could not create a verified rollback snapshot of the active installation.', 'The active installation was not moved. Repair its files or permissions, then retry.', 409, { verification });
  }
  actionLog(action, 'info', 'Arcane created a verified rollback snapshot before replacing the legacy installation.', { version: snapshot.version, verification });
  return snapshot;
}
function validateArcaneUsersState(state, file) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== 1 || !state.users || typeof state.users !== 'object' || Array.isArray(state.users)) {
    throw new Error(`Arcane user recovery state is invalid: ${file}.`);
  }
  return { schemaVersion: 1, users: state.users };
}
function readValidatedArcaneUsersStateFile(file) {
  return validateArcaneUsersState(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}
function readArcaneUsersState() {
  if (simulate) return simulatedArcaneUsersState;
  const target = arcaneUsersStatePath();
  const backup = arcaneUsersStateBackupPath();
  if (!fs.existsSync(target) && !fs.existsSync(backup)) return { schemaVersion: 1, users: {} };
  let primaryError = null;
  if (fs.existsSync(target)) {
    try { return readValidatedArcaneUsersStateFile(target); }
    catch (error) { primaryError = error; }
  }
  if (fs.existsSync(backup)) {
    try {
      const recovered = readValidatedArcaneUsersStateFile(backup);
      log('Recovered Arcane user shell state from the last-known-good copy.', { primaryError: primaryError && primaryError.message });
      return recovered;
    } catch (backupError) {
      throw arcaneError(
        'ARCANE_STATE_CORRUPT',
        'Arcane cannot safely read its user shell recovery records.',
        'Do not assign or remove user shells. Restore users.json from a known-good backup or repair it as an administrator.',
        409,
        { stateFile: target, backupFile: backup, primaryError: primaryError && primaryError.message, backupError: backupError.message }
      );
    }
  }
  throw arcaneError(
    'ARCANE_STATE_CORRUPT',
    'Arcane cannot safely read its user shell recovery records.',
    'Do not assign or remove user shells. Restore users.json from a known-good backup or repair it as an administrator.',
    409,
    { stateFile: target, primaryError: primaryError && primaryError.message }
  );
}
async function durableWriteFile(file, contents, mode) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = await fsp.open(temporary, 'wx', mode || 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, file);
    try {
      const directory = await fsp.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (_) { /* Directory fsync is not available on every Windows filesystem. */ }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
async function writeArcaneUsersState(state) {
  if (simulate) { simulatedArcaneUsersState = state; return; }
  await ensureDir(PATHS.stateRoot);
  const target = arcaneUsersStatePath();
  const backup = arcaneUsersStateBackupPath();
  if (fs.existsSync(target)) {
    try {
      readValidatedArcaneUsersStateFile(target);
      await durableWriteFile(backup, await fsp.readFile(target, 'utf8'), 0o600);
    } catch (error) {
      if (error && error.code !== 'ARCANE_STATE_CORRUPT') log('Preserving the existing last-known-good Arcane user state copy.', { reason: error.message });
    }
  }
  await durableWriteFile(target, JSON.stringify(validateArcaneUsersState(state, target), null, 2), 0o600);
}
async function updateArcaneUserRecord(username, patch) {
  const state = readArcaneUsersState();
  const key = String(username || '').trim().toLowerCase();
  const existing = state.users[key] && typeof state.users[key] === 'object' ? state.users[key] : {};
  state.users[key] = {
    ...existing,
    username: String(username || existing.username || '').trim(),
    ...patch,
    updatedAt: stamp(),
  };
  await writeArcaneUsersState(state);
  return state.users[key];
}

const APP_STORAGE_VALUE_MAX_BYTES = 128 * 1024;
const APP_STORAGE_TOTAL_MAX_BYTES = 1024 * 1024;
let appStorageMutationQueue = Promise.resolve();
function withAppStorageMutation(work) {
  const result = appStorageMutationQueue.then(work, work);
  appStorageMutationQueue = result.catch(() => {});
  return result;
}
function validateStorageKey(input) {
  const key = String(input || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw arcaneError(
      'INVALID_STORAGE_KEY',
      'Arcane app storage keys must be 1–128 letters, numbers, periods, underscores, colons, or hyphens.',
      'Use a stable namespaced key such as editor.document.current.',
      400,
      { field: 'key', input: key }
    );
  }
  return key;
}
function appStorageFile() {
  const base = platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'Arcane OS', 'apps', appMode, 'storage.json');
}
function readAppStorage() {
  if (simulate) return { ...simulatedAppStorage };
  const state = readJsonFile(appStorageFile());
  if (!state || state.schemaVersion !== 1 || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) {
    return Object.create(null);
  }
  return { ...state.entries };
}
function storagePayload(entries) {
  return JSON.stringify({ schemaVersion: 1, entries });
}
async function writeAppStorage(entries) {
  const payload = storagePayload(entries);
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > APP_STORAGE_TOTAL_MAX_BYTES) {
    throw arcaneError(
      'APP_STORAGE_QUOTA_EXCEEDED',
      `This Arcane app has reached its ${APP_STORAGE_TOTAL_MAX_BYTES / 1024} KiB storage quota.`,
      'Delete an older app setting or document, then try again.',
      413,
      { maximumBytes: APP_STORAGE_TOTAL_MAX_BYTES, actualBytes: bytes }
    );
  }
  if (simulate) {
    simulatedAppStorage = { ...entries };
    return bytes;
  }
  const target = appStorageFile();
  await ensureDir(path.dirname(target));
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
  try {
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return bytes;
}
function normalizeStorageValue(value) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch (error) {
    throw arcaneError('INVALID_STORAGE_VALUE', 'Arcane app storage accepts JSON-compatible values only.', 'Remove circular references or unsupported values and try again.', 400, { cause: error.message });
  }
  if (encoded === undefined) {
    throw arcaneError('INVALID_STORAGE_VALUE', 'Arcane app storage cannot save an undefined value.', 'Use null, a string, a number, a Boolean, an array, or an object.', 400);
  }
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > APP_STORAGE_VALUE_MAX_BYTES) {
    throw arcaneError(
      'APP_STORAGE_VALUE_TOO_LARGE',
      `One Arcane app storage value cannot exceed ${APP_STORAGE_VALUE_MAX_BYTES / 1024} KiB.`,
      'Split the data into smaller named records.',
      413,
      { maximumBytes: APP_STORAGE_VALUE_MAX_BYTES, actualBytes: bytes }
    );
  }
  return { value: JSON.parse(encoded), bytes };
}
function listAppStorage() {
  const entries = readAppStorage();
  return {
    keys: Object.keys(entries).sort(),
    usedBytes: Buffer.byteLength(storagePayload(entries), 'utf8'),
    maximumBytes: APP_STORAGE_TOTAL_MAX_BYTES,
  };
}
function getAppStorage(keyInput) {
  const key = validateStorageKey(keyInput);
  const entries = readAppStorage();
  const found = Object.prototype.hasOwnProperty.call(entries, key);
  return { key, found, value: found ? entries[key] : null };
}
async function setAppStorage(keyInput, inputValue) {
  const key = validateStorageKey(keyInput);
  const normalized = normalizeStorageValue(inputValue);
  return withAppStorageMutation(async () => {
    const entries = readAppStorage();
    entries[key] = normalized.value;
    const totalBytes = await writeAppStorage(entries);
    return { key, value: normalized.value, bytes: normalized.bytes, totalBytes, maximumBytes: APP_STORAGE_TOTAL_MAX_BYTES };
  });
}
async function deleteAppStorage(keyInput) {
  const key = validateStorageKey(keyInput);
  return withAppStorageMutation(async () => {
    const entries = readAppStorage();
    const deleted = Object.prototype.hasOwnProperty.call(entries, key);
    if (deleted) delete entries[key];
    const totalBytes = deleted ? await writeAppStorage(entries) : Buffer.byteLength(storagePayload(entries), 'utf8');
    return { key, deleted, totalBytes, maximumBytes: APP_STORAGE_TOTAL_MAX_BYTES };
  });
}
async function listArcaneUsers() {
  const state = readArcaneUsersState();
  const records = Object.values(state.users || {});
  const nativeUsers = await native.listArcaneUsers(records.map((item) => item.username));
  return nativeUsers.map((user) => {
    const record = state.users[String(user.username || '').toLowerCase()] || null;
    return {
      ...user,
      managedByArcane: Boolean(record),
      createdByArcane: record ? Boolean(record.createdByArcane) : null,
      passwordStatus: record && record.passwordStatus ? record.passwordStatus : 'unknown',
      provisionedAt: record && record.provisionedAt ? record.provisionedAt : null,
      passwordChangedAt: record && record.passwordChangedAt ? record.passwordChangedAt : null,
      previousShell: record && record.previousShellPresent ? record.previousShell || null : null,
      previousShellPresent: record ? Boolean(record.previousShellPresent) : false,
      canRestoreShell: Boolean(record && record.previousShellCaptured && user.shellAssigned),
      shellMutationPhase: record && record.shellMutationPhase ? record.shellMutationPhase : null,
      shellRecoveryPrepared: Boolean(record && record.previousShellCaptured),
      accountMutationPhase: record && record.accountMutationPhase ? record.accountMutationPhase : null,
      activationRequired: Boolean(record && record.accountMutationPhase === 'activation-pending'),
    };
  });
}
function installationState() {
  const manifest = simulate
    ? simulatedInstallationManifest
    : readJsonFile(installManifestPath())
      || readJsonFile(path.join(PATHS.stateRoot, 'install.json'));
  const installedVersion = manifest && manifest.version ? String(manifest.version) : null;
  const comparison = installedVersion ? compareVersions(VERSION, installedVersion) : 1;
  const payload = native.installPayload(bundleRoot());
  const payloadStatus = {
    mode: payload.mode,
    releaseReady: Boolean(payload.releaseReady),
    installable: Boolean(payload.releaseReady || allowSourceInstall || simulate),
    description: payload.description || null,
    missingRelease: payload.missingRelease || [],
  };
  const installedPayloadMode = manifest && manifest.payloadMode ? String(manifest.payloadMode) : null;
  const installedIntegrity = installedVersion
    ? verifyInstalledIntegrity(manifest)
    : { ok: false, checkedFiles: 0, reason: 'Arcane is not installed.' };
  const payloadRepairRequired = Boolean(
    installedVersion
    && comparison === 0
    && payload.releaseReady
    && (installedPayloadMode !== payload.mode || !installedIntegrity.ok)
  );
  return {
    present: Boolean(installedVersion),
    installedVersion,
    packageVersion: VERSION,
    blocked: Boolean(installedVersion && comparison < 0),
    action: !installedVersion ? 'install' : comparison > 0 ? 'update' : comparison === 0 ? 'repair' : 'blocked',
    installRoot: PATHS.installRoot,
    stateRoot: PATHS.stateRoot,
    manifest,
    installedPayloadMode,
    installedIntegrity,
    payloadRepairRequired,
    payload: payloadStatus,
  };
}
function assertChangesAllowed() {
  const state = installationState();
  if (state.blocked) {
    throw arcaneError(
      'DOWNGRADE_BLOCKED',
      `Arcane OS ${state.installedVersion} is newer than this ${VERSION} provisioner package.`,
      'Use a provisioner package at the same or a newer version. This older package will not modify the machine.',
      409
    );
  }
  if (!isElevated()) {
    throw arcaneError('ADMIN_REQUIRED', 'Administrator access is required for this machine change.', 'Approve the operating-system authorization prompt and try again.', 403);
  }
}
function createAction(type, requestId) {
  const action = {
    id: crypto.randomUUID(),
    requestId: requestId || null,
    type,
    status: 'running',
    createdAt: stamp(),
    startedAt: stamp(),
    completedAt: null,
    progress: 0,
    currentStep: null,
    logs: [],
    credentials: [],
    error: null,
  };
  actions.set(action.id, action);
  emitEvent('operation.started', { requestId: action.requestId, operationId: action.id, operationType: type, time: action.startedAt });
  return action;
}
function actionLog(action, level, message, details) {
  if (!action || !Array.isArray(action.logs)) return;
  const entry = { time: stamp(), level, message, details: details || null };
  action.logs.push(entry);
  if (action.logs.length > 500) action.logs.shift();
  emitEvent('operation.log', { requestId: action.requestId, operationId: action.id, operationType: action.type, ...entry });
}
function actionStep(action, progress, message) {
  action.progress = Math.max(0, Math.min(100, Number(progress || 0)));
  action.currentStep = message;
  actionLog(action, 'step', message);
  emitEvent('operation.progress', { requestId: action.requestId, operationId: action.id, operationType: action.type, progress: action.progress, message });
}
function actionFail(action, error) {
  action.status = error && error.code === 'DOWNGRADE_BLOCKED' ? 'blocked' : 'failed';
  action.completedAt = stamp();
  action.error = normalizeError(error);
  const diagnostic = recordError(action.type, error, { actionId: action.id });
  action.error.diagnosticId = diagnostic.id;
  actionLog(action, 'error', action.error.message, { code: action.error.code, resolution: action.error.resolution, diagnosticId: diagnostic.id });
}
function runAction(action, work) {
  action.status = 'running';
  action.startedAt = stamp();
  Promise.resolve()
    .then(() => work(action))
    .then((result) => {
      if (action.status === 'failed' || action.status === 'blocked') return;
      action.status = 'completed';
      action.progress = 100;
      action.completedAt = stamp();
      action.result = result || null;
      actionLog(action, 'info', 'Operation completed successfully.');
    })
    .catch((error) => actionFail(action, error));
  return action;
}
function run(command, commandArgs, options) {
  const opts = options || {};
  const argsList = commandArgs || [];
  const diagnosticArgs = opts.redactArgs ? ['[redacted]'] : argsList;
  const commandDisplay = opts.displayCommand || `$ ${command} ${diagnosticArgs.join(' ')}`;
  return new Promise((resolve, reject) => {
    if (opts.action && !opts.suppressCommandLog) actionLog(opts.action, 'command', commandDisplay);
    if (simulate && !opts.runInSimulation) {
      const result = { code: 0, stdout: 'Simulated command.', stderr: '', command, args: diagnosticArgs };
      if (opts.action) actionLog(opts.action, 'info', 'Simulation: command was not executed.', { command, args: diagnosticArgs });
      resolve(result);
      return;
    }
    const child = spawn(command, argsList, {
      cwd: opts.cwd || safeSubprocessCwd,
      env: opts.env || safeSubprocessEnvironment,
      windowsHide: opts.windowsHide !== false,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (opts.action && !opts.suppressRawStdout) actionLog(opts.action, 'stdout', text.trimEnd());
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (opts.action && !opts.suppressRawStderr) actionLog(opts.action, 'stderr', text.trimEnd());
    });
    child.once('error', (error) => {
      error.command = command;
      error.args = diagnosticArgs;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    if (opts.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else child.stdin.end();
    child.once('close', (code) => {
      if (opts.action && opts.suppressRawStderr && stderr) {
        actionLog(opts.action, 'stderr', cleanPowerShellError(stderr) || 'The command returned diagnostic output.');
      }
      if (code !== 0 && !opts.allowFailure) {
        const error = new Error(`${command} exited with code ${code}.`);
        error.code = 'COMMAND_FAILED';
        error.exitCode = code;
        error.command = command;
        error.args = diagnosticArgs;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ code, stdout, stderr, command, args: diagnosticArgs });
    });
  });
}
function powershell(script, options) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run(platform==='win32' ? windowsPowerShell:'powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded,
  ], {
    ...(options || {}),
    suppressRawStderr: true,
  });
}
async function ensureDir(directory) {
  if (simulate) return;
  await fsp.mkdir(directory, { recursive: true });
}
async function writeFile(file, contents, mode) {
  if (simulate) return;
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, contents, { mode: mode || 0o644 });
}
async function copyTree(source, destination) {
  if (simulate) return;
  await fsp.cp(source, destination, { recursive: true, force: true });
}
function tempPath(name) {
  const directory = path.join(os.tmpdir(), 'arcane-provisioner');
  if (!simulate) fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${Date.now()}-${process.pid}-${name}`);
}
function download(url, destination, action, redirects) {
  return new Promise((resolve, reject) => {
    const count = redirects || 0;
    if (count > 8) {
      reject(arcaneError('TOO_MANY_REDIRECTS', 'A required download redirected too many times.', 'Check the network or proxy configuration and try again.'));
      return;
    }
    actionLog(action, 'info', `Downloading ${url}`);
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, {
      headers: { 'User-Agent': `Arcane-Provisioner/${VERSION}`, Accept: '*/*' },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const next = new URL(response.headers.location, url).toString();
        response.resume();
        download(next, destination, action, count + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(arcaneError('DOWNLOAD_FAILED', `A required download failed with HTTP ${response.statusCode}.`, 'Check the internet connection or proxy and try again.', response.statusCode));
        return;
      }
      ensureDir(path.dirname(destination)).then(() => {
        const output = fs.createWriteStream(destination);
        let received = 0;
        const total = Number(response.headers['content-length'] || 0);
        response.on('data', (chunk) => {
          received += chunk.length;
          if (total && received % (10 * 1024 * 1024) < chunk.length) {
            actionLog(action, 'info', `Downloaded ${Math.round((received / total) * 100)}% (${Math.round(received / 1024 / 1024)} MB).`);
          }
        });
        response.pipe(output);
        output.on('finish', () => output.close(() => resolve(destination)));
        output.on('error', reject);
      }).catch(reject);
    });
    request.on('error', reject);
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': `Arcane-Provisioner/${VERSION}`, Accept: 'application/json' },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const next = new URL(response.headers.location, url).toString();
        response.resume();
        getJson(next).then(resolve, reject);
        return;
      }
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(arcaneError('HTTP_FAILED', `The Arcane update service returned HTTP ${response.statusCode}.`, 'Check the internet connection and try again.'));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(file);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}
function versionFromCommand(executable, commandArgs) {
  if (!executable) return null;
  const result = spawnSync(executable, commandArgs || ['--version'], {
    cwd:safeSubprocessCwd,
    env:safeSubprocessEnvironment,
    encoding:'utf8',
    windowsHide:true,
    timeout:10000,
  });
  return cleanVersion(`${result.stdout || ''} ${result.stderr || ''}`);
}

Object.assign(nativeContext, {
  arcaneError,
  cleanPowerShellError,
  run,
  powershell,
  ensureDir,
  writeFile,
  copyTree,
  tempPath,
  download,
  getJson,
  sha256,
  psQuote,
  actionLog,
});

if (selfTestOutput) {
  const payload = native.installPayload(bundleRoot());
  const result = {
    ok: true,
    app: 'arcane-provisioner',
    version: VERSION,
    platform: osInfo().platform,
    nativeAdapter: native.id,
    packaged: Boolean(process.pkg),
    payloadMode: payload.mode,
  };
  try {
    fs.mkdirSync(path.dirname(selfTestOutput), { recursive: true });
    fs.writeFileSync(selfTestOutput, JSON.stringify(result, null, 2), 'utf8');
    console.error(JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    console.error(error && error.stack || error);
    process.exit(9);
  }
}


const REQUIREMENT_DEFINITIONS = Object.freeze([
  { id: 'node', name: 'Node.js', minimumVersion: BUNDLE_MANIFEST.requirements.node.minimumVersion, required: false, installable: false, description: 'Optional Arcane development host; packaged applications do not require it.' },
  { id: 'ollama', name: 'Ollama', minimumVersion: BUNDLE_MANIFEST.requirements.ollama.minimumVersion, required: false, installable: false, description: 'Optional local model runtime installed separately by the machine administrator.' },
  { id: 'renderer', name: 'Native web renderer', minimumVersion: null, required: true, installable: false, description: 'WebView2 on Windows or WebKitGTK on Linux; install it from the operating-system/vendor channel before launching Arcane.' },
  { id: 'session-control', name: 'Session control', minimumVersion: null, required: true, installable: false, description: 'Native logout and lock capability.' },
]);
function checkRequirement(definition) {
  let executable = null;
  let version = null;
  if (definition.id === 'node') {
    executable = native.nodeExecutable();
    version = versionFromCommand(executable, ['--version']);
  } else if (definition.id === 'ollama') {
    executable = native.ollamaExecutable();
    version = versionFromCommand(executable, ['--version']);
  } else if (definition.id === 'renderer') {
    const renderer = native.rendererStatus ? native.rendererStatus() : { executable: native.browserExecutable(), version: null };
    executable = renderer && renderer.executable || null;
    version = renderer && renderer.version || null;
  }
  else if (definition.id === 'session-control') executable = native.sessionControlExecutable();

  let status = 'ready';
  let message = '';
  if (!executable) {
    status = !definition.required ? 'optional-missing' : definition.installable ? 'missing' : 'blocked';
    message = !definition.required
      ? 'Optional component not installed; core Arcane shell and provisioning remain available.'
      : definition.installable
      ? 'Not installed. Arcane can attempt an automatic installation.'
      : 'This native capability was not found and cannot be installed safely by Arcane.';
  } else if (definition.minimumVersion && (!version || compareVersions(version, definition.minimumVersion) < 0)) {
    status = 'update-required';
    message = `Installed version ${version || 'unknown'} is below minimum ${definition.minimumVersion}.`;
  } else {
    message = version ? `Installed ${version} at ${executable}.` : `Available at ${executable}.`;
  }
  return { ...definition, status, version, executable, message, platform: osInfo().platform, adapter: native.id };
}
function checkRequirements(ids) {
  const selected = ids && ids.length
    ? REQUIREMENT_DEFINITIONS.filter((definition) => ids.includes(definition.id))
    : REQUIREMENT_DEFINITIONS;
  return selected.map(checkRequirement);
}
async function latestNodeRelease() {
  const index = await getJson('https://nodejs.org/dist/index.json');
  const major = Number(BUNDLE_MANIFEST.requirements.node.installMajor || 24);
  const candidates = index.filter((item) => Number(String(item.version).replace(/^v/, '').split('.')[0]) === major && item.lts);
  if (!candidates.length) throw arcaneError('NODE_RELEASE_NOT_FOUND', `No supported Node.js ${major}.x LTS release was found.`, 'Try again later or install the required Node.js LTS version manually.');
  return candidates[0];
}
async function installNode(action) {
  if (simulate) {
    actionLog(action, 'info', 'Simulation: would download, verify, and install the current supported Node.js LTS release.');
    return;
  }
  const release = await latestNodeRelease();
  const filename = native.nodeArchiveName(release.version);
  const base = `https://nodejs.org/dist/${release.version}`;
  const packageFile = tempPath(filename);
  const sumsFile = tempPath('SHASUMS256.txt');
  await download(`${base}/${filename}`, packageFile, action);
  await download(`${base}/SHASUMS256.txt`, sumsFile, action);
  const sums = await fsp.readFile(sumsFile, 'utf8');
  const line = sums.split(/\r?\n/).find((item) => item.trim().endsWith(filename));
  if (!line) throw arcaneError('CHECKSUM_NOT_FOUND', `Node.js checksum for ${filename} was not found.`, 'Do not continue with this download. Try again later.');
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = await sha256(packageFile);
  if (expected !== actual) throw arcaneError('CHECKSUM_MISMATCH', 'The downloaded Node.js package did not match its official checksum.', 'The package was not installed. Check the network and try again.');
  actionLog(action, 'info', `Verified Node.js ${release.version} SHA-256.`);
  await native.installNodePackage(packageFile, release, action);
}
async function latestOllamaRelease() {
  const release = await getJson('https://api.github.com/repos/ollama/ollama/releases/latest');
  return { version: String(release.tag_name || '').replace(/^v/, ''), assets: release.assets || [] };
}
Object.assign(nativeContext, { latestOllamaRelease });
async function installRequirement(id, action) {
  const definition = REQUIREMENT_DEFINITIONS.find((item) => item.id === id);
  if (!definition) throw arcaneError('UNKNOWN_REQUIREMENT', `Arcane does not recognize requirement “${id}”.`, 'Reload the provisioner and try again.', 400);
  const requirement = checkRequirement(definition);
  if (requirement.status === 'ready') {
    actionLog(action, 'info', `${requirement.name} already meets Arcane requirements.`);
    return requirement;
  }
  if (!requirement.installable) throw arcaneError('REQUIREMENT_NOT_INSTALLABLE', `${requirement.name} is unavailable.`, requirement.message);
  actionStep(action, action.progress, `Installing ${requirement.name}…`);
  if (id === 'node') await installNode(action);
  else if (id === 'ollama') await native.installOllama(action);
  else if (id === 'renderer') {
    if (native.installRenderer) await native.installRenderer(action);
    else await native.installBrowser(action);
  }
  const verified = checkRequirement(definition);
  if (!simulate && verified.status !== 'ready') {
    throw arcaneError('REQUIREMENT_VERIFY_FAILED', `${verified.name} was installed or updated, but Arcane still cannot use it.`, verified.message);
  }
  actionLog(action, 'info', `${requirement.name} is ready.`, verified);
  return verified;
}
async function ensureRequirements(action, ids) {
  const selected = ids && ids.length
    ? ids
    : REQUIREMENT_DEFINITIONS.filter((item) => item.required).map((item) => item.id);
  for (let index = 0; index < selected.length; index += 1) {
    action.progress = Math.round(5 + (index / selected.length) * 55);
    await installRequirement(selected[index], action);
  }
  const final = checkRequirements(selected);
  const failure = final.find((item) => item.required && item.status !== 'ready');
  if (!simulate && failure) throw arcaneError('REQUIREMENT_NOT_READY', `${failure.name} is not ready.`, failure.message);
  return final;
}
async function installArcaneGlobally(action) {
  await recoverInterruptedInstallation(action);
  const root = bundleRoot();
  const payload = native.installPayload(root);
  if (!payload.files || !payload.files.length) {
    throw arcaneError('ARCANE_PAYLOAD_MISSING', 'The Arcane runtime files are missing from this bundle.', `Use a complete Arcane package. Bundle root: ${root}`);
  }
  if (!payload.releaseReady && !allowSourceInstall && !simulate) {
    throw arcaneError(
      'RELEASE_PAYLOAD_REQUIRED',
      'Arcane is running from source, so there are no standalone executables to install yet.',
      `Run the platform release build first. Missing release files: ${(payload.missingRelease || []).join(', ') || 'unknown'}. The provisioner will not install raw JavaScript as the production shell.`,
      409,
      { payloadMode: payload.mode, missingRelease: payload.missingRelease || [] }
    );
  }
  actionLog(action, 'info', `Installing Arcane ${VERSION} globally from ${root}.`, { payloadMode: payload.mode });
  const stage = `${PATHS.installRoot}.stage-${process.pid}-${Date.now()}`;
  if (!simulate) {
    await fsp.rm(stage, { recursive: true, force: true });
    await fsp.mkdir(path.join(stage, 'bin'), { recursive: true });
    await fsp.mkdir(path.join(stage, 'assets'), { recursive: true });
  }
  if (!simulate) {
    for (const file of payload.files) {
      const destination = path.join(stage, 'bin', file.destinationName);
      await fsp.copyFile(file.source, destination);
      if (file.executable) await fsp.chmod(destination, 0o755);
    }
    for (const directory of payload.directories || []) {
      await copyTree(directory.source, path.join(stage, directory.destinationName));
    }
    const bundleManifestSource = payload.bundleManifestSource || path.join(root, 'arcane-bundle.json');
    if (fs.existsSync(bundleManifestSource)) await fsp.copyFile(bundleManifestSource, path.join(stage, 'arcane-bundle.json'));
    for (const asset of payload.assetFiles || []) {
      await fsp.copyFile(asset.source, path.join(stage, 'assets', asset.destinationName));
    }
    if ((!payload.assetFiles || !payload.assetFiles.length) && fs.existsSync(path.join(root, 'assets'))) {
      await copyTree(path.join(root, 'assets'), path.join(stage, 'assets'));
    }
    if (payload.integrity && payload.integrity.sourceManifest && fs.existsSync(payload.integrity.sourceManifest)) {
      await fsp.copyFile(payload.integrity.sourceManifest, path.join(stage, 'arcane-release.json'));
    }
  }
  await native.writeLaunchers(stage, payload);
  if (!simulate && payload.integrity) {
    verifyIntegrityEntries(stage, payload.integrity.files, false);
  }
  const manifest = {
    name: 'Arcane OS',
    version: VERSION,
    installedAt: stamp(),
    installedBy: currentIdentity(),
    platform: osInfo(),
    nativeAdapter: native.id,
    payloadMode: payload.mode,
    sourceBundle: root,
    requirements: BUNDLE_MANIFEST.requirements,
    integrity: simulate ? { schemaVersion: 2, hashAlgorithm: 'sha256', scope: 'simulation', files: [] } : createInstalledIntegrity(stage),
  };
  await writeFile(path.join(stage, 'arcane-install.json'), JSON.stringify(manifest, null, 2));
  if (!simulate) {
    const backup = `${PATHS.installRoot}.backup`;
    if (fs.existsSync(backup)) {
      throw arcaneError('INSTALL_BACKUP_BUSY', 'Arcane preserved an unresolved installation backup and will not overwrite it.', 'Review the backup and active installation as an administrator before retrying.', 409, { backup });
    }
    if (fs.existsSync(PATHS.installRoot)) {
      await snapshotActiveInstallationForRollback(action);
      await fsp.rename(PATHS.installRoot, backup);
    }
    let activated = false;
    try {
      await fsp.rename(stage, PATHS.installRoot);
      activated = true;
      const installedVerification = verifyInstalledIntegrity(manifest);
      if (!installedVerification.ok) throw new Error(`Arcane rejected the activated installation: ${installedVerification.reason}`);
      await native.applyInstallPermissions(action);
      await ensureDir(PATHS.stateRoot);
      if (native.applyStatePermissions) await native.applyStatePermissions(action);
      try {
        await durableWriteFile(path.join(PATHS.stateRoot, 'install.json'), JSON.stringify(manifest, null, 2), 0o600);
        if (native.applyStatePermissions) await native.applyStatePermissions(action);
      } catch (stateError) {
        actionLog(action, 'warn', 'Arcane was installed, but the secondary installation-state copy could not be written.', { message: stateError.message });
      }
      if (fs.existsSync(backup)) {
        try {
          const replacedManifest = readJsonFile(path.join(backup, 'arcane-install.json'));
          const replacedVerification = verifyInstalledIntegrityAt(backup, replacedManifest);
          if (replacedVerification.ok) {
            await fsp.rm(backup, { recursive: true, force: true });
          } else {
            const legacyVersion = String(replacedManifest && replacedManifest.version || 'unknown').replace(/[^0-9A-Za-z._-]/g, '_');
            const archive = `${backup}.legacy-${legacyVersion}-${Date.now()}`;
            await fsp.rename(backup, archive);
            actionLog(action, 'warn', 'Arcane preserved the replaced pre-integrity installation as a legacy archive.', { archive, replacedVerification });
          }
        } catch (cleanupError) {
          actionLog(action, 'warn', 'The new Arcane installation is verified, but the replaced installation could not be cleaned up or archived.', { message: cleanupError.message, backup });
        }
      }
    } catch (error) {
      if (activated && fs.existsSync(PATHS.installRoot)) await fsp.rm(PATHS.installRoot, { recursive: true, force: true });
      if (fs.existsSync(backup)) await fsp.rename(backup, PATHS.installRoot);
      throw error;
    }
  }
  if (simulate) simulatedInstallationManifest = { ...manifest, simulated: true };
  actionLog(action, 'info', `Arcane ${VERSION} installed at ${PATHS.installRoot}.`, { payloadMode: payload.mode });
  return manifest;
}
async function ensureArcaneInstallation(action) {
  const initial = installationState();
  if (initial.blocked) {
    throw arcaneError('DOWNGRADE_BLOCKED', `Arcane ${initial.installedVersion} is newer than this ${VERSION} package.`, 'Use an equal or newer provisioner package. Downgrades are blocked.', 409);
  }
  actionStep(action, 5, 'Checking Arcane machine requirements…');
  await ensureRequirements(action);
  const state = installationState();
  let manifest = state.manifest || null;
  if (state.action === 'install') {
    actionStep(action, 62, `Installing Arcane OS ${VERSION}…`);
    manifest = await installArcaneGlobally(action);
  } else if (state.action === 'update') {
    actionStep(action, 62, `Updating Arcane OS from ${state.installedVersion} to ${VERSION}…`);
    manifest = await installArcaneGlobally(action);
  } else if (state.payloadRepairRequired) {
    actionStep(action, 62, `Repairing the Arcane ${VERSION} installation from the verified release…`);
    actionLog(action, 'info', 'The installed Arcane version is current, but its payload layout or integrity check requires repair.', {
      installedPayloadMode: state.installedPayloadMode,
      packagePayloadMode: state.payload && state.payload.mode,
      installedIntegrity: state.installedIntegrity,
    });
    manifest = await installArcaneGlobally(action);
  } else if (state.installedVersion && state.installedIntegrity && !state.installedIntegrity.ok) {
    throw arcaneError(
      'INSTALL_INTEGRITY_FAILED',
      'The installed Arcane OS files did not pass their integrity check.',
      'Run a complete verified Arcane release package as administrator to repair this installation.',
      409,
      { installedIntegrity: state.installedIntegrity, payload: state.payload }
    );
  } else {
    actionStep(action, 72, `Arcane OS ${state.installedVersion || VERSION} is already installed.`);
    actionLog(action, 'info', `Arcane OS ${state.installedVersion || VERSION} is current; no replacement was required.`);
  }
  return { manifest, installation: installationState(), requirements: checkRequirements() };
}
function validateProvisioningUsername(username) {
  const value = native.validateUsername(username);
  const protectedMatch = protectedProvisioningUsernames().find((item) => value.toLowerCase() === item.toLowerCase());
  if (protectedMatch) {
    const error = arcaneError(
      'CURRENT_USER_PROTECTED',
      `The provisioning account “${protectedMatch}” is protected and cannot be converted into an Arcane user by this process.`,
      'Enter a different account name. The current administrator account and its shell will remain untouched.',
      409
    );
    error.field = 'username';
    error.input = value;
    throw error;
  }
  return value;
}
function validateUsernames(usernames) {
  const results = [];
  const errors = [];
  for (const input of Array.isArray(usernames) ? usernames : []) {
    try {
      const username = validateProvisioningUsername(input);
      results.push({ input, username, valid: true, exists: native.userExists(username) });
    } catch (error) {
      errors.push({ input, valid: false, ...normalizeError(error) });
    }
  }
  return {
    valid: errors.length === 0 && results.length > 0,
    users: results,
    errors,
    policy: native.usernamePolicy(),
  };
}
function temporaryPassword() { return `A!${crypto.randomBytes(12).toString('base64url')}9z`; }
async function provisionUsers(usernames, action) {
  if (native.supportsUserProvisioning === false && !simulate) {
    throw arcaneError(
      'USER_PROVISIONING_UNAVAILABLE',
      'Arcane user-shell provisioning is not available on this platform build.',
      'Use the supported Windows provisioner, or install a display-manager-safe Arcane desktop session before enabling Linux account integration.',
      409
    );
  }
  const uniqueByKey = new Map();
  for (const input of usernames) {
    const username = validateProvisioningUsername(input);
    const key = native.id === 'windows' ? username.toLowerCase() : username;
    if (!uniqueByKey.has(key)) uniqueByKey.set(key, username);
  }
  const unique = [...uniqueByKey.values()];
  const results = [];
  const changed = [];
  if (native.applyStatePermissions) await native.applyStatePermissions(action);
  const existingUsers = new Map((await listArcaneUsers()).map((user) => [String(user.username || '').toLowerCase(), user]));
  try {
    for (let index = 0; index < unique.length; index += 1) {
      const username = unique[index];
      const userKey = String(username).toLowerCase();
      actionStep(action, 75 + Math.round((index / Math.max(1, unique.length)) * 20), `Provisioning user ${username}…`);
      let priorRecord = readArcaneUsersState().users[userKey] || null;
      if (priorRecord && priorRecord.accountMutationPhase === 'cleanup-required') {
        throw arcaneError(
          'PARTIAL_ACCOUNT_RECOVERY_REQUIRED',
          `Arcane found a disabled, partially created account for “${username}” and will not guess its password or ownership.`,
          'Remove the recorded partial account as an administrator, or use the account recovery workflow before trying again.',
          409,
          { username }
        );
      }
      const incompleteNewAccountPhases = new Set(['prepared', 'activation-pending']);
      if (priorRecord && priorRecord.accountExistedBefore === false && incompleteNewAccountPhases.has(priorRecord.accountMutationPhase)) {
        if (native.userExists(username)) {
          if (!priorRecord.sid) {
            await updateArcaneUserRecord(username, {
              createdByArcane: false,
              passwordStatus: 'unavailable-disabled',
              accountMutationPhase: 'cleanup-required',
              accountMutationCompletedAt: stamp(),
              shellMutationPhase: 'cleanup-required',
              shellMutationCompletedAt: stamp(),
            });
            throw arcaneError(
              'PARTIAL_ACCOUNT_RECOVERY_REQUIRED',
              `Arcane found “${username}” after an interrupted account creation, but no trusted security identifier was durably recorded.`,
              'The account was staged disabled. Verify and remove it as an administrator before trying again; Arcane will not delete an account using its name alone.',
              409,
              { username }
            );
          }
          if (!native.rollbackCreatedUser) throw new Error('The native adapter cannot recover an interrupted staged Arcane account.');
          const recovered = await native.rollbackCreatedUser(username, {
            username,
            created: true,
            sid: priorRecord.sid,
            profile: priorRecord.profile || null,
            shell: priorRecord.shell || native.shellCommand(),
          }, action);
          if (!recovered.accountRemoved) {
            await updateArcaneUserRecord(username, {
              createdByArcane: true,
              passwordStatus: 'unavailable-disabled',
              accountMutationPhase: 'cleanup-required',
              accountMutationCompletedAt: stamp(),
              shellMutationPhase: 'cleanup-required',
              shellMutationCompletedAt: stamp(),
            });
            throw arcaneError(
              'PARTIAL_ACCOUNT_RECOVERY_REQUIRED',
              `Arcane disabled but could not remove the interrupted staged account “${username}”.`,
              'Review the cleanup diagnostics and remove the staged account as an administrator before trying again.',
              409,
              { username, recovery: recovered }
            );
          }
        }
        await updateArcaneUserRecord(username, {
          createdByArcane: false,
          passwordStatus: 'not-issued',
          accountMutationPhase: 'rolled-back',
          accountMutationCompletedAt: stamp(),
          shellMutationPhase: 'rolled-back',
          shellMutationCompletedAt: stamp(),
        });
        existingUsers.delete(userKey);
        priorRecord = readArcaneUsersState().users[userKey] || null;
        actionLog(action, 'warn', `Arcane recovered an interrupted disabled account transaction for ${username} before retrying.`);
      }
      const existingArcaneUser = existingUsers.get(userKey);
      if (existingArcaneUser && existingArcaneUser.shellAssigned) {
        const payload = { ...existingArcaneUser, created: false, alreadyAssigned: true, passwordStatus: existingArcaneUser.passwordStatus || 'existing-password-unchanged' };
        results.push(payload);
        actionLog(action, 'info', `${username} already uses Arcane as its verified login shell; no account or password change was made.`, payload);
        continue;
      }
      const backup = await native.prepareUserShellBackup(username, action);
      if (backup.previousShellPresent && backup.previousShell === native.shellCommand()) {
        const payload = { username, created: false, alreadyAssigned: true, shell: native.shellCommand(), passwordStatus: priorRecord && priorRecord.passwordStatus || 'existing-password-unchanged' };
        results.push(payload);
        existingUsers.set(username.toLowerCase(), { ...payload, shellAssigned: true });
        actionLog(action, 'info', `${username} already uses the exact installed Arcane shell; its existing recovery baseline was preserved.`, payload);
        continue;
      }
      await updateArcaneUserRecord(username, {
        createdByArcane: priorRecord ? Boolean(priorRecord.createdByArcane) : false,
        previousShell: backup.previousShell ?? null,
        previousShellPresent: Boolean(backup.previousShellPresent),
        previousShellCaptured: true,
        profile: backup.profile || priorRecord && priorRecord.profile || null,
        sid: backup.sid || priorRecord && priorRecord.sid || null,
        uid: backup.uid !== undefined && backup.uid !== null ? backup.uid : priorRecord && priorRecord.uid !== undefined ? priorRecord.uid : null,
        shellMutationPhase: 'prepared',
        shellMutationOperationId: action.id,
        shellMutationPreparedAt: stamp(),
        shellMutationCompletedAt: null,
        shellRestoredAt: null,
        accountExistedBefore: Boolean(backup.accountExisted),
        accountMutationPhase: 'prepared',
        accountMutationOperationId: action.id,
      });
      if (native.applyStatePermissions) await native.applyStatePermissions(action);
      actionLog(action, 'info', `Arcane durably saved the previous login shell for ${username} before making a shell change.`, {
        username,
        previousShellPresent: Boolean(backup.previousShellPresent),
        verification: backup.verification || null,
      });

      const password = temporaryPassword();
      let result;
      try {
        result = await native.provisionUser(username, password, action, backup);
      } catch (provisionError) {
        const recovery = provisionError && provisionError.accountRollback;
        if (recovery && recovery.createdByThisAttempt) {
          await updateArcaneUserRecord(username, {
            createdByArcane: !recovery.accountRemoved,
            passwordStatus: recovery.accountRemoved ? 'not-issued' : 'unavailable-disabled',
            accountMutationPhase: recovery.accountRemoved ? 'rolled-back' : 'cleanup-required',
            accountMutationCompletedAt: stamp(),
            accountRollback: recovery,
            shellMutationPhase: recovery.accountRemoved ? 'rolled-back' : 'cleanup-required',
            shellMutationCompletedAt: stamp(),
          }).catch((stateError) => {
            actionLog(action, 'error', `Arcane could not record account rollback state for ${username}.`, normalizeError(stateError));
          });
        }
        throw provisionError;
      }
      changed.push({ username, result, backup, password });
      const passwordStatus = result.created ? 'temporary-issued-disabled' : 'existing-password-unchanged';
      await updateArcaneUserRecord(username, {
        createdByArcane: Boolean(result.created || (priorRecord && priorRecord.createdByArcane)),
        provisionedAt: stamp(),
        passwordStatus,
        passwordChangedAt: result.created ? stamp() : null,
        shell: result.shell || native.shellCommand(),
        profile: result.profile || null,
        sid: result.sid || null,
        uid: result.uid !== undefined ? result.uid : null,
        previousShell: backup.previousShell ?? null,
        previousShellPresent: Boolean(backup.previousShellPresent),
        previousShellCaptured: true,
        shellMutationPhase: 'assigned',
        shellMutationCompletedAt: stamp(),
        shellRestoredAt: null,
        accountExistedBefore: Boolean(backup.accountExisted),
        accountMutationPhase: result.created ? 'activation-pending' : 'existing-account',
        accountMutationCompletedAt: result.created ? null : stamp(),
      });
      if (simulate && ['after-state', 'crash-activation-pending'].includes(simulatedUserFailure) && !nativeContext.simulatedUserFailureTriggered) {
        nativeContext.simulatedUserFailureTriggered = true;
        const injected = arcaneError('SIMULATED_USER_TRANSACTION_FAILURE', 'Simulated failure after the durable user state write.', 'The transaction must recover the staged account.', 500);
        injected.simulatedCrash = simulatedUserFailure === 'crash-activation-pending';
        throw injected;
      }
      if (result.created) {
        action.credentials.push({
          username,
          temporaryPassword: password,
          mustChangeAtNextSignIn: true,
          reason: 'new-account',
          activationRequired: true,
        });
      }
      const payload = { ...result, passwordStatus, activationRequired: Boolean(result.created) };
      results.push(payload);
      existingUsers.set(username.toLowerCase(), { ...payload, shellAssigned: true });
      actionLog(action, 'info', result.created
        ? `${username} was created, assigned Arcane as its login shell, and given a temporary password.`
        : `${username} already existed. Arcane assigned its login shell and left the existing password unchanged.`, payload);
    }
  } catch (error) {
    if (simulate && error && error.simulatedCrash) throw error;
    const rollback = [];
    for (const item of [...changed].reverse()) {
      try {
        if (item.result.created) {
          if (!native.rollbackCreatedUser) throw new Error('The native adapter cannot roll back a staged Arcane account.');
          const removed = await native.rollbackCreatedUser(item.username, item.result, action);
          rollback.push({ username: item.username, accountRemoved: Boolean(removed.accountRemoved), accountDisabled: Boolean(removed.accountDisabled) });
          await updateArcaneUserRecord(item.username, {
            createdByArcane: !removed.accountRemoved,
            passwordStatus: removed.accountRemoved ? 'not-issued' : 'unavailable-disabled',
            accountMutationPhase: removed.accountRemoved ? 'rolled-back' : 'cleanup-required',
            accountMutationCompletedAt: stamp(),
            shellMutationPhase: removed.accountRemoved ? 'rolled-back' : 'cleanup-required',
            shellMutationCompletedAt: stamp(),
          });
          actionLog(action, 'warn', removed.accountRemoved
            ? `Arcane removed the newly created ${item.username} account after provisioning could not complete.`
            : `Arcane disabled the partially created ${item.username} account; administrator cleanup is required.`);
        } else {
          const restored = await native.restoreUserShell(
            item.username,
            item.backup.previousShell ?? null,
            Boolean(item.backup.previousShellPresent),
            action
          );
          rollback.push({ username: item.username, restored: true, shell: restored.shell || null });
          await updateArcaneUserRecord(item.username, {
            shell: restored.shell || null,
            shellRestoredAt: stamp(),
            shellMutationPhase: 'rolled-back',
            shellMutationCompletedAt: stamp(),
            accountMutationPhase: 'existing-account',
            accountMutationCompletedAt: stamp(),
          });
          actionLog(action, 'warn', `Arcane restored the previous login shell for ${item.username} after provisioning could not complete.`);
        }
      } catch (rollbackError) {
        rollback.push({ username: item.username, restored: false, error: normalizeError(rollbackError) });
        actionLog(action, 'error', `Arcane could not automatically restore the previous login shell for ${item.username}.`, normalizeError(rollbackError));
      }
    }
    const rolledBackNames = new Set(changed.filter((item) => item.result.created).map((item) => item.username.toLowerCase()));
    action.credentials = action.credentials.filter((item) => !rolledBackNames.has(String(item.username || '').toLowerCase()));
    error.rollback = rollback;
    throw error;
  }
  return results;
}
async function activateStagedArcaneUser(username, action) {
  const normalized = validateProvisioningUsername(username);
  if (native.applyStatePermissions) await native.applyStatePermissions(action);
  const record = readArcaneUsersState().users[String(normalized).toLowerCase()] || null;
  if (!record || record.accountExistedBefore !== false || record.accountMutationPhase !== 'activation-pending' || !record.sid) {
    throw arcaneError(
      'STAGED_ACCOUNT_NOT_FOUND',
      `Arcane has no disabled staged account ready to activate for “${normalized}”.`,
      'Add the Arcane user first. Activation is allowed only after its temporary password has been returned.',
      409,
      { username: normalized }
    );
  }
  if (!native.activateProvisionedUser) throw new Error('The native adapter cannot activate a staged Arcane account.');
  actionStep(action, 40, `Verifying and activating ${normalized}…`);
  const activated = await native.activateProvisionedUser(normalized, {
    username: normalized,
    created: true,
    sid: record.sid,
    profile: record.profile || null,
    shell: record.shell || native.shellCommand(),
  }, action);
  if (simulate && simulatedUserFailure === 'crash-after-enable' && !nativeContext.simulatedUserFailureTriggered) {
    nativeContext.simulatedUserFailureTriggered = true;
    const injected = arcaneError('SIMULATED_USER_TRANSACTION_FAILURE', 'Simulated process loss after enabling the staged account.', 'The caller already received the temporary password; retry activation to reconcile the journal.', 500);
    injected.simulatedCrash = true;
    throw injected;
  }
  await updateArcaneUserRecord(normalized, {
    passwordStatus: 'temporary-issued',
    accountMutationPhase: 'active',
    accountMutationCompletedAt: stamp(),
  });
  actionLog(action, 'info', `${normalized} was enabled only after its temporary password had been delivered.`, activated);
  return { ...activated, activationRequired: false, passwordStatus: 'temporary-issued' };
}
async function resetArcaneUserPassword(username, action) {
  const normalized = validateProvisioningUsername(username);
  const record = readArcaneUsersState().users[String(normalized).toLowerCase()] || null;
  if (!record || !native.userExists(normalized)) {
    throw arcaneError('USER_NOT_FOUND', `The account “${normalized}” does not exist on this machine or is not registered as an Arcane user.`, 'Add the Arcane user first, then set its temporary password.', 404, { username: normalized });
  }
  if (record.accountMutationPhase === 'activation-pending') {
    throw arcaneError('STAGED_ACCOUNT_NOT_ACTIVE', `“${normalized}” is still a disabled staged account.`, 'Use the temporary credential panel to activate it, or re-add the username to recreate a lost credential safely.', 409, { username: normalized });
  }
  if (!record.previousShellCaptured || record.shellMutationPhase !== 'assigned') {
    throw arcaneError('NOT_ARCANE_USER', `“${normalized}” is not recorded with an active Arcane shell assignment.`, 'Add the account as an Arcane user before preparing a password reset.', 409, { username: normalized });
  }
  actionStep(action, 25, `Preparing a temporary password for ${normalized}…`);
  const password = temporaryPassword();
  action.credentials.push({
    username: normalized,
    temporaryPassword: password,
    mustChangeAtNextSignIn: true,
    reason: 'password-reset',
    applyPasswordRequired: true,
  });
  actionLog(action, 'info', `A temporary password was prepared for ${normalized}; no operating-system password was changed. Save it before applying it.`);
  return { username: normalized, passwordReset: false, applyPasswordRequired: true, passwordStatus: record.passwordStatus || 'unknown' };
}
async function applyArcaneUserPassword(username, passwordInput, action) {
  const normalized = validateProvisioningUsername(username);
  const password = String(passwordInput || '');
  if (!/^A![A-Za-z0-9_-]{16}9z$/.test(password)) {
    throw arcaneError('INVALID_TEMPORARY_PASSWORD', 'Arcane rejected an invalid temporary-password handoff.', 'Generate a new temporary password in this provisioner session and apply that exact value.', 400, { username: normalized });
  }
  if (native.applyStatePermissions) await native.applyStatePermissions(action);
  const users = await listArcaneUsers();
  const target = users.find((item) => String(item.username || '').toLowerCase() === normalized.toLowerCase());
  if (!target) {
    throw arcaneError('USER_NOT_FOUND', `The account “${normalized}” does not exist on this machine or is not registered as an Arcane user.`, 'Add the Arcane user first, then set its temporary password.', 404, { username: normalized });
  }
  if (!target.shellAssigned || target.activationRequired) {
    throw arcaneError('NOT_ARCANE_USER', `“${normalized}” is not an active verified Arcane user.`, 'Activate or add the account as an Arcane user before applying its temporary password.', 409, { username: normalized });
  }
  actionStep(action, 25, `Applying the saved temporary password for ${normalized}…`);
  const result = await native.resetUserPassword(normalized, password, action);
  if (simulate && simulatedUserFailure === 'crash-after-password-apply' && !nativeContext.simulatedUserFailureTriggered) {
    nativeContext.simulatedUserFailureTriggered = true;
    const injected = arcaneError(
      'SIMULATED_USER_TRANSACTION_FAILURE',
      'Simulated process loss after Windows accepted the saved temporary password.',
      'The operator already saved this credential; retry the same password application to reconcile Arcane state.',
      500
    );
    injected.simulatedCrash = true;
    throw injected;
  }
  await updateArcaneUserRecord(normalized, {
    passwordStatus: 'temporary-issued',
    passwordChangedAt: stamp(),
  });
  actionLog(action, 'info', `The saved temporary password was applied for ${normalized}. It must be changed at the next sign-in.`, result);
  return { ...result, applyPasswordRequired: false, passwordStatus: 'temporary-issued' };
}
async function restoreArcaneUserShell(username, action) {
  const normalized = validateProvisioningUsername(username);
  if (native.applyStatePermissions) await native.applyStatePermissions(action);
  const state = readArcaneUsersState();
  const record = state.users[String(normalized).toLowerCase()] || null;
  if (!record || !record.previousShellCaptured) {
    throw arcaneError(
      'SHELL_BACKUP_NOT_FOUND',
      `Arcane does not have a previous shell backup for “${normalized}”.`,
      'Only restore accounts that were provisioned after shell backup support was enabled.',
      409,
      { username: normalized }
    );
  }
  if (record.accountMutationPhase === 'activation-pending') {
    throw arcaneError('STAGED_ACCOUNT_NOT_ACTIVE', `“${normalized}” is still a disabled staged account.`, 'Activate it from the temporary credential panel, or re-add the username to recreate a lost credential safely.', 409, { username: normalized });
  }
  const users = await listArcaneUsers();
  const target = users.find((item) => String(item.username || '').toLowerCase() === normalized.toLowerCase());
  const preparedRecovery = record.shellMutationPhase === 'prepared';
  if (!target && !preparedRecovery) {
    throw arcaneError('USER_NOT_FOUND', `The account “${normalized}” no longer exists.`, 'Remove the stale Arcane user record manually after confirming the account was intentionally deleted.', 404, { username: normalized });
  }
  if (target && !target.shellAssigned && !preparedRecovery) {
    throw arcaneError('SHELL_CHANGED_EXTERNALLY', `Arcane is no longer the verified login shell for “${normalized}”.`, 'No change was made. Review the account’s current shell before making any manual adjustment.', 409, { username: normalized, shell: target.shell || null });
  }
  if (preparedRecovery && (!target || !target.shellAssigned)) {
    actionLog(action, 'warn', `Arcane is entering prepared-transaction recovery for ${normalized}; the native adapter will verify the exact current shell before restoring it.`);
  }
  actionStep(action, 25, `Restoring the previous login shell for ${normalized}…`);
  const result = await native.restoreUserShell(
    normalized,
    record.previousShell ?? null,
    Boolean(record.previousShellPresent),
    action
  );
  await updateArcaneUserRecord(normalized, {
    shellRestoredAt: stamp(),
    shell: result.shell || null,
    shellMutationPhase: 'restored',
    shellMutationCompletedAt: stamp(),
  });
  actionLog(action, 'info', `The previous login shell for ${normalized} was restored.`, result);
  return result;
}
function provisioningPlan(usernames) {
  const validation = validateUsernames(usernames || []);
  if (!validation.valid && validation.errors.length) {
    const first = validation.errors[0];
    throw arcaneError(first.code, first.message, first.resolution, first.status, first);
  }
  const install = installationState();
  return {
    ok: true,
    version: VERSION,
    installation: install,
    requirements: checkRequirements(),
    users: validation.users.map((user) => ({
      username: user.username,
      exists: user.exists,
      action: user.exists ? 'assign Arcane shell' : 'create standard user and assign Arcane shell',
    })),
    usernamePolicy: validation.policy,
    elevated: isElevated(),
    simulation: simulate,
    blocked: install.blocked,
    steps: [
      install.action === 'install' ? 'Install Arcane globally' : install.action === 'update' ? 'Update global Arcane installation' : 'Verify or repair Arcane installation',
      'Install or update machine requirements',
      'Create missing standard users',
      'Assign Arcane as each selected user shell',
      'Verify installation and permissions',
    ],
  };
}

// ---------------------------------------------------------------------------
// Arcane framed RPC transport
// ---------------------------------------------------------------------------
let protocolSink = process.stdout;
let writeChain = Promise.resolve();
let protocolFrameWriter = null;

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

function writeFrame(stream, message) {
  if (!stream || stream.destroyed || !stream.writable) return Promise.reject(new Error('Arcane IPC stream is not writable.'));
  const frame = encodeFrame(message);
  writeChain = writeChain.then(() => new Promise((resolve, reject) => {
    stream.write(frame, (error) => error ? reject(error) : resolve());
  })).catch((error) => {
    console.error('Arcane IPC write failed:', error && error.stack || error);
  });
  return writeChain;
}

function emitFrame(message) {
  return protocolFrameWriter ? protocolFrameWriter(message) : writeFrame(protocolSink, message);
}

function emitEvent(event, data) {
  return emitFrame({
    protocol: PROTOCOL,
    type: 'event',
    event,
    data: data || {},
    time: stamp(),
  });
}

class FrameDecoder {
  constructor(onMessage, onError) {
    this.buffer = Buffer.alloc(0);
    this.expected = null;
    this.onMessage = onMessage;
    this.onError = onError || function defaultError(error) { console.error(error); };
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    try {
      while (true) {
        if (this.expected === null) {
          const marker = this.buffer.indexOf('\r\n\r\n');
          if (marker < 0) {
            if (this.buffer.length > 64 * 1024) throw arcaneError('IPC_HEADER_TOO_LARGE', 'Arcane received an invalid IPC frame.', 'Restart the Arcane application.');
            return;
          }
          const header = this.buffer.subarray(0, marker).toString('ascii');
          const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i);
          if (!match) throw arcaneError('IPC_LENGTH_MISSING', 'Arcane received an IPC frame without a content length.', 'Restart the Arcane application.');
          this.expected = Number(match[1]);
          if (!Number.isFinite(this.expected) || this.expected < 0 || this.expected > 16 * 1024 * 1024) {
            throw arcaneError('IPC_MESSAGE_TOO_LARGE', 'Arcane rejected an oversized IPC message.', 'Reduce the request size and try again.');
          }
          this.buffer = this.buffer.subarray(marker + 4);
        }
        if (this.buffer.length < this.expected) return;
        const body = this.buffer.subarray(0, this.expected).toString('utf8');
        this.buffer = this.buffer.subarray(this.expected);
        this.expected = null;
        const parsed = JSON.parse(body);
        this.onMessage(parsed);
      }
    } catch (error) {
      this.buffer = Buffer.alloc(0);
      this.expected = null;
      this.onError(error);
    }
  }
}

function publicAction(action) {
  return {
    id: action.id,
    type: action.type,
    status: action.status,
    startedAt: action.startedAt,
    completedAt: action.completedAt,
    progress: action.progress,
    currentStep: action.currentStep,
    credentials: action.credentials,
    error: action.error,
  };
}

function completeAction(action, result) {
  action.status = 'completed';
  action.progress = 100;
  action.completedAt = stamp();
  action.result = result === undefined ? null : result;
  actionLog(action, 'info', 'Operation completed successfully.');
  emitEvent('operation.completed', {
    requestId: action.requestId,
    operationId: action.id,
    operationType: action.type,
    result: action.result,
    credentials: action.credentials,
    time: action.completedAt,
  });
}

function failAction(action, error) {
  actionFail(action, error);
  emitEvent('operation.failed', {
    requestId: action.requestId,
    operationId: action.id,
    operationType: action.type,
    error: action.error,
    time: action.completedAt,
  });
}

async function withAction(type, requestId, work) {
  const action = createAction(type, requestId);
  try {
    const result = await work(action);
    completeAction(action, result);
    return {
      result,
      operation: publicAction(action),
      credentials: action.credentials,
    };
  } catch (error) {
    failAction(action, error);
    throw error;
  }
}

function rendererStatus() {
  if (native.rendererStatus) return native.rendererStatus();
  const executable = native.browserExecutable ? native.browserExecutable() : null;
  return { id: native.id === 'windows' ? 'webview2' : 'webkitgtk', available: Boolean(executable), executable, version: null };
}

let activeExclusiveMutation = null;
function acquireExclusiveMutation(method, requestId) {
  if (activeExclusiveMutation) {
    const activeOperation = {
      method: activeExclusiveMutation.method,
      requestId: activeExclusiveMutation.requestId,
      startedAt: activeExclusiveMutation.startedAt,
    };
    throw arcaneError(
      'OPERATION_BUSY',
      `Arcane is already completing ${activeOperation.method}.`,
      'Wait for the active machine operation to finish, then try again.',
      409,
      { activeOperation, retryable: true }
    );
  }
  const token = Symbol('exclusive-mutation');
  activeExclusiveMutation = {
    token,
    method: String(method || 'machine mutation'),
    requestId: requestId || null,
    startedAt: stamp(),
  };
  return () => {
    if (activeExclusiveMutation && activeExclusiveMutation.token === token) activeExclusiveMutation = null;
  };
}

const METHOD_POLICIES = Object.freeze({
  'system.ping': Object.freeze({}),
  'version.current': Object.freeze({}),
  'app.current': Object.freeze({}),
  'capabilities.list': Object.freeze({}),
  'platform.status': Object.freeze({ capability:'system.read' }),
  'permissions.status': Object.freeze({ capability:'system.read' }),
  'machine.status': Object.freeze({ capability:'provisioning.manage', appTypes:['provisioner'] }),
  'user.current': Object.freeze({ capability:'identity.read' }),
  'system.metrics': Object.freeze({ capability:'system.metrics.read' }),
  'network.status': Object.freeze({ capability:'network.status.read' }),
  'storage.list': Object.freeze({ capability:'storage.read' }),
  'storage.get': Object.freeze({ capability:'storage.read' }),
  'storage.set': Object.freeze({ capability:'storage.write' }),
  'storage.delete': Object.freeze({ capability:'storage.write' }),
  'installation.status': Object.freeze({ capability:'installation.read' }),
  'requirements.list': Object.freeze({ capability:'requirements.read' }),
  'users.validate': Object.freeze({ capability:'users.manage', appTypes:['provisioner'] }),
  'users.list': Object.freeze({ capability:'users.manage', appTypes:['provisioner'] }),
  'diagnostics.recent': Object.freeze({ capability:'diagnostics.read' }),
  'diagnostics.get': Object.freeze({ capability:'diagnostics.read' }),
  'apps.list': Object.freeze({ capability:'applications.read', appTypes:['shell'] }),
  'apps.launch': Object.freeze({ capability:'applications.launch', appTypes:['shell'] }),
  'provisioning.plan': Object.freeze({ capability:'provisioning.manage', appTypes:['provisioner'] }),
  'system.lock': Object.freeze({ capability:'session.control', appTypes:['shell'], exclusiveMutation:true }),
  'session.logout': Object.freeze({ capability:'session.control', appTypes:['shell'], exclusiveMutation:true }),
  'requirements.ensure': Object.freeze({ capability:'provisioning.manage', appTypes:['provisioner'], privileged:true, exclusiveMutation:true }),
  'installation.ensure': Object.freeze({ capability:'provisioning.manage', appTypes:['provisioner'], privileged:true, exclusiveMutation:true }),
  'users.add': Object.freeze({ capability:'users.manage', appTypes:['provisioner'], privileged:true, exclusiveMutation:true }),
  'users.activate': Object.freeze({ capability:'users.manage', appTypes:['provisioner'], privileged:true, exclusiveMutation:true }),
  'users.resetPassword': Object.freeze({ capability:'users.manage', appTypes:['provisioner'], exclusiveMutation:true }),
  'users.applyPassword': Object.freeze({ capability:'users.manage', appTypes:['provisioner'], privileged:true, exclusiveMutation:true }),
  'users.restoreShell': Object.freeze({ capability:'users.manage', appTypes:['provisioner'], privileged:true, exclusiveMutation:true }),
});

function publicAppDescriptor() {
  return {
    id:appMode,
    displayName:String(APP_DESCRIPTOR.displayName || appMode),
    type:String(APP_DESCRIPTOR.type || 'app'),
    entry:APP_DESCRIPTOR.entry ? String(APP_DESCRIPTOR.entry):null,
    version:VERSION,
    securityMode:releaseSecurityMode(),
  };
}

function releaseSecurityMode() {
  if(allowUnsignedLocalRelease)return 'unsigned-local-test';
  if(typeof native.releaseSecurityMode==='function'){
    try{
      if(native.releaseSecurityMode()==='publisher-verified')return 'publisher-verified';
    }catch(error){
      log('Arcane could not verify the installed release security mode.',{ code:error&&error.code||null,message:error&&error.message||String(error) });
    }
  }
  return 'unverified';
}

function allowedMethods() {
  const appType=String(APP_DESCRIPTOR.type || 'app');
  return Object.entries(METHOD_POLICIES)
    .filter(([,policy]) =>
      (!policy.capability || APP_CAPABILITIES.has(policy.capability))
      &&(!policy.appTypes || policy.appTypes.includes(appType))
    )
    .map(([method]) => method)
    .sort();
}

function capabilityStatus() {
  return {
    app:publicAppDescriptor(),
    grants:[...APP_CAPABILITIES].sort(),
    methods:allowedMethods(),
  };
}

function assertMethodAllowed(method) {
  const policy=METHOD_POLICIES[method];
  const appType=String(APP_DESCRIPTOR.type || 'app');
  if(
    !policy
    ||(policy.capability&&!APP_CAPABILITIES.has(policy.capability))
    ||(policy.appTypes&&!policy.appTypes.includes(appType))
  ){
    throw arcaneError(
      'METHOD_NOT_ALLOWED',
      `Arcane does not allow “${method}” for ${APP_DESCRIPTOR.displayName || appMode}.`,
      'Use an Arcane application that has been explicitly granted this capability.',
      403,
      { method,application:appMode,requiredCapability:policy&&policy.capability||null }
    );
  }
  return policy;
}

function applicationRequestParameters(request, expectedKeys) {
  const parameters=request.parameters;
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters)){
    throw arcaneError(
      'INVALID_APPLICATION_REQUEST',
      'Arcane rejected an invalid application request.',
      'Retry from the Arcane shell. Application requests must use the documented fields only.',
      400
    );
  }
  const keys=Object.keys(parameters).sort();
  const expected=[...expectedKeys].sort();
  if(keys.length!==expected.length||keys.some((key,index)=>key!==expected[index])){
    throw arcaneError(
      'INVALID_APPLICATION_REQUEST',
      'Arcane rejected unsupported application request fields.',
      'Launch an installed application by its Arcane application ID only.',
      400,
      { allowedFields:expected }
    );
  }
  return parameters;
}

function isCanonicalApplicationId(input) {
  return typeof input==='string'
    &&input.length>=1
    &&input.length<=APPLICATION_ID_MAX_LENGTH
    &&APPLICATION_ID_PATTERN.test(input)
    &&!RESERVED_APPLICATION_IDS.has(input);
}

function canonicalApplicationId(input) {
  if(!isCanonicalApplicationId(input)){
    throw arcaneError(
      'INVALID_APPLICATION_ID',
      'Arcane rejected an invalid application ID.',
      'Choose an application from the verified Arcane shell catalog.',
      400
    );
  }
  return input;
}

function publicApplicationText(input, field, maximumLength, required) {
  if(input===null||input===undefined||input===''){
    if(!required)return null;
    throw arcaneError('APPLICATION_CATALOG_INVALID','Arcane rejected an incomplete installed-app catalog.','Repair or reinstall Arcane OS.',500,{ field });
  }
  if(
    typeof input!=='string'
    ||input.trim()!==input
    ||input.length>maximumLength
    ||/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(input)
  ){
    throw arcaneError('APPLICATION_CATALOG_INVALID','Arcane rejected invalid installed-app metadata.','Repair or reinstall Arcane OS.',500,{ field });
  }
  return input;
}

function publicApplicationIcon(input, id) {
  if(input===null||input===undefined||input==='')return null;
  const icon=publicApplicationText(input,'iconUrl',320,false);
  if(
    !icon.startsWith('/')
    ||icon.startsWith('//')
    ||icon.includes('\\')
    ||icon.includes('%')
    ||icon.includes('?')
    ||icon.includes('#')
    ||icon.split('/').some((segment)=>segment==='.'||segment==='..')
  ){
    throw arcaneError('APPLICATION_CATALOG_INVALID','Arcane rejected an unsafe installed-app icon URL.','Repair or reinstall Arcane OS.',500,{ applicationId:id });
  }
  return icon;
}

function publicApplicationRecord(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)){
    throw arcaneError('APPLICATION_CATALOG_INVALID','Arcane rejected an invalid installed-app record.','Repair or reinstall Arcane OS.',500);
  }
  if(!isCanonicalApplicationId(input.id)){
    throw arcaneError('APPLICATION_CATALOG_INVALID','Arcane rejected an invalid installed application ID.','Repair or reinstall Arcane OS.',500);
  }
  const id=input.id;
  const order=input.order;
  if(!Number.isSafeInteger(order)||order<0||order>100000){
    throw arcaneError('APPLICATION_CATALOG_INVALID','Arcane rejected invalid installed-app ordering metadata.','Repair or reinstall Arcane OS.',500,{ applicationId:id,field:'order' });
  }
  return Object.freeze({
    id,
    displayName:publicApplicationText(input.displayName,'displayName',80,true),
    description:publicApplicationText(input.description,'description',240,false),
    iconUrl:publicApplicationIcon(input.iconUrl,id),
    version:publicApplicationText(input.version,'version',64,false),
    order,
    verified:true,
  });
}

function assertApplicationAdapter(method) {
  if(hostPlatform!=='win32'||platform!=='win32'){
    throw arcaneError(
      'APPLICATIONS_UNAVAILABLE',
      'Installed Arcane applications are not available on this operating system.',
      'Use a supported Windows Arcane installation.',
      501
    );
  }
  if(typeof native[method]!=='function'){
    throw arcaneError(
      'APPLICATION_ADAPTER_UNAVAILABLE',
      'Arcane cannot verify the installed application catalog.',
      'Repair or reinstall the complete Arcane OS release.',
      503
    );
  }
}

async function listInstalledApplications(request) {
  applicationRequestParameters(request,[]);
  assertApplicationAdapter('listInstalledApplications');
  let result;
  try{
    result=await native.listInstalledApplications();
  }catch(error){
    log('Installed application catalog adapter failed.',{ code:error&&error.code||null,message:error&&error.message||String(error) });
    throw arcaneError('APPLICATION_CATALOG_UNAVAILABLE','Arcane could not read the verified installed application catalog.','Repair or reinstall the complete Arcane OS release.',503);
  }
  if(
    !result
    ||typeof result!=='object'
    ||result.verified!==true
    ||!Array.isArray(result.applications)
    ||result.applications.length>APPLICATION_CATALOG_MAX_RECORDS
  ){
    throw arcaneError('APPLICATION_CATALOG_UNVERIFIED','Arcane could not verify the installed application catalog.','Repair or reinstall the complete Arcane OS release.',503);
  }
  const applications=result.applications.map(publicApplicationRecord);
  const seen=new Set();
  for(const application of applications){
    if(seen.has(application.id)){
      throw arcaneError('APPLICATION_CATALOG_INVALID','Arcane rejected a duplicate installed application ID.','Repair or reinstall Arcane OS.',500,{ applicationId:application.id });
    }
    seen.add(application.id);
  }
  applications.sort((left,right)=>left.order-right.order||left.displayName.localeCompare(right.displayName,'en')||left.id.localeCompare(right.id,'en'));
  return Object.freeze({
    verified:true,
    securityMode:releaseSecurityMode(),
    applications:Object.freeze(applications),
  });
}

async function launchInstalledApplication(request) {
  const parameters=applicationRequestParameters(request,['id']);
  const id=canonicalApplicationId(parameters.id);
  assertApplicationAdapter('launchInstalledApplication');
  let result;
  try{
    result=await native.launchInstalledApplication(id);
  }catch(error){
    log('Installed application launch adapter failed.',{ applicationId:id,code:error&&error.code||null,message:error&&error.message||String(error) });
    throw arcaneError('APPLICATION_LAUNCH_FAILED',`Arcane could not launch ${id}.`,'Retry from the verified Arcane shell catalog. If the problem continues, repair Arcane OS.',502,{ applicationId:id });
  }
  if(!result||typeof result!=='object'||result.accepted!==true){
    throw arcaneError(
      'APPLICATION_LAUNCH_REJECTED',
      `Arcane could not launch ${id}.`,
      'Retry from the verified Arcane shell catalog. If the problem continues, repair Arcane OS.',
      502,
      { applicationId:id }
    );
  }
  return Object.freeze({ id,accepted:true });
}

function publicOperatingSystemInfo() {
  const { hostname: _hostname, ...operatingSystem } = osInfo();
  return operatingSystem;
}

function platformStatus() {
  const permissions = permissionStatus(true);
  const renderer = rendererStatus();
  return {
    ...publicOperatingSystemInfo(),
    version: VERSION,
    protocol: PROTOCOL,
    application: appMode,
    renderer,
    permissions,
    capabilities: capabilityStatus(),
  };
}

function systemMetrics() {
  const totalMemory=os.totalmem();
  const freeMemory=os.freemem();
  return {
    architecture:process.arch,
    logicalProcessors:os.cpus().length,
    loadAverage:os.loadavg().map((value)=>Number(value.toFixed(3))),
    memory:{ totalBytes:totalMemory,freeBytes:freeMemory,usedBytes:Math.max(0,totalMemory-freeMemory) },
    uptimeSeconds:Math.floor(os.uptime()),
  };
}

function networkStatus() {
  const interfaces=os.networkInterfaces();
  const activeNames=Object.entries(interfaces)
    .filter(([,addresses])=>Array.isArray(addresses)&&addresses.some((address)=>address&&!address.internal))
    .map(([name])=>name);
  return { online:activeNames.length>0,interfaceCount:activeNames.length };
}

function machineStatus() {
  return {
    version: VERSION,
    protocol: PROTOCOL,
    application: appMode,
    os: osInfo(),
    nativeAdapter: native.id,
    identity: currentIdentity(),
    protectedUsername: protectedProvisioningUsername(),
    protectedUsernames: protectedProvisioningUsernames(),
    usernamePolicy: native.usernamePolicy(),
    installation: installationState(),
    requirements: checkRequirements(),
    permissions: permissionStatus(true),
    renderer: rendererStatus(),
    paths: PATHS,
    simulation: simulate,
    bundleRoot: bundleRoot(),
  };
}

async function launchSessionCommand(spec, label, options) {
  if (!spec) throw arcaneError('SESSION_COMMAND_UNAVAILABLE', `Arcane cannot ${label} this session on the detected operating system.`, 'Install or enable a supported desktop session controller.');
  const forceDispatch = Boolean(options && options.forceDispatch);
  if (simulate && !forceDispatch) return { requested: true, accepted: true, simulated: true, command: spec[0], args: spec[1] };
  let child;
  try {
    child = spawn(spec[0], spec[1] || [], {
      cwd: safeSubprocessCwd,
      env: safeSubprocessEnvironment,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (error) {
    throw arcaneError(
      'SESSION_COMMAND_DISPATCH_FAILED',
      `Arcane could not ${label} this session.`,
      'Verify that the operating-system session controller is installed and permitted, then try again.',
      503,
      { reason: error && (error.code || error.message) || 'spawn-failed' }
    );
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      callback(value);
    };
    const onSpawn = () => finish(resolve);
    const onError = (error) => finish(reject, arcaneError(
      'SESSION_COMMAND_DISPATCH_FAILED',
      `Arcane could not ${label} this session.`,
      'Verify that the operating-system session controller is installed and permitted, then try again.',
      503,
      { reason: error && (error.code || error.message) || 'spawn-failed' }
    ));
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish(reject, arcaneError(
        'SESSION_COMMAND_DISPATCH_TIMEOUT',
        `Arcane could not confirm that the request to ${label} this session was accepted.`,
        'Verify that the operating-system session controller is responsive, then try again.',
        504,
        { reason: 'spawn-timeout' }
      ));
    }, 10000);
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  child.unref();
  return { requested: true, accepted: true, simulated: false, command: spec[0], pid: child.pid || null };
}

async function dispatchMethod(request, options) {
  const method = String(request.method || '');
  const parameters = request.parameters && typeof request.parameters === 'object' ? request.parameters : {};
  const requestId = request.id;

  switch (method) {
    case 'system.ping': return { ok: true, pid: process.pid, version: VERSION, app: appMode, elevated: isElevated(), worker: privilegedWorker };
    case 'version.current': return VERSION;
    case 'app.current': return publicAppDescriptor();
    case 'capabilities.list': return capabilityStatus();
    case 'platform.status': return platformStatus();
    case 'permissions.status': return permissionStatus(true);
    case 'machine.status': return machineStatus();
    case 'user.current': return currentIdentity();
    case 'system.metrics': return systemMetrics();
    case 'network.status': return networkStatus();
    case 'storage.list': return listAppStorage();
    case 'storage.get': return getAppStorage(parameters.key);
    case 'storage.set': return setAppStorage(parameters.key, parameters.value);
    case 'storage.delete': return deleteAppStorage(parameters.key);
    case 'installation.status': return installationState();
    case 'requirements.list': return checkRequirements();
    case 'users.validate': return validateUsernames(parameters.usernames || []);
    case 'users.list': return {
      users: await listArcaneUsers(),
      policy: native.usernamePolicy(),
      protectedUsernames: protectedProvisioningUsernames(),
    };
    case 'diagnostics.recent': return recentErrors.slice(0, 60);
    case 'diagnostics.get': {
      const item = recentErrors.find((entry) => entry.id === parameters.diagnosticId);
      if (!item) throw arcaneError('DIAGNOSTIC_NOT_FOUND', 'That Arcane diagnostic record is no longer available.', 'Reproduce the failure and copy the new diagnostics.', 404);
      return item;
    }
    case 'apps.list': return listInstalledApplications(request);
    case 'apps.launch': return launchInstalledApplication(request);
    case 'provisioning.plan': return provisioningPlan(parameters.usernames || []);
    case 'system.lock': return launchSessionCommand(native.lockSpec(), 'lock');
    case 'session.logout': return launchSessionCommand(native.logoutSpec(), 'log out of');
    case 'requirements.ensure': {
      assertChangesAllowed();
      const wrapped = await withAction('requirements.ensure', requestId, async (action) => ({ requirements: await ensureRequirements(action, parameters.requirementIds || null) }));
      return { ...wrapped.result, operation: wrapped.operation, credentials: wrapped.credentials };
    }
    case 'installation.ensure': {
      assertChangesAllowed();
      const wrapped = await withAction('installation.ensure', requestId, async (action) => ensureArcaneInstallation(action));
      return { ...wrapped.result, operation: wrapped.operation, credentials: wrapped.credentials };
    }
    case 'users.add': {
      assertChangesAllowed();
      const validation = validateUsernames(parameters.usernames || []);
      if (!validation.valid) {
        const first = validation.errors[0] || { code: 'USERNAME_REQUIRED', message: 'Enter at least one Arcane username.', resolution: 'Use the Add Arcane user field.' };
        throw arcaneError(first.code, first.message, first.resolution, first.status || 400, first);
      }
      const wrapped = await withAction('users.add', requestId, async (action) => {
        actionStep(action, 2, 'Ensuring Arcane OS and its requirements are ready…');
        await ensureArcaneInstallation(action);
        actionStep(action, 72, 'Creating and configuring Arcane users…');
        const users = await provisionUsers(validation.users.map((item) => item.username), action);
        actionStep(action, 98, 'Verifying Arcane user shell assignments…');
        return { users, machineUsers: await listArcaneUsers(), installation: installationState() };
      });
      return { ...wrapped.result, operation: wrapped.operation, credentials: wrapped.credentials };
    }
    case 'users.activate': {
      assertChangesAllowed();
      const wrapped = await withAction('users.activate', requestId, async (action) => ({ user: await activateStagedArcaneUser(parameters.username, action) }));
      return { ...wrapped.result, operation: wrapped.operation, credentials: wrapped.credentials };
    }
    case 'users.resetPassword': {
      const wrapped = await withAction('users.resetPassword', requestId, async (action) => ({ user: await resetArcaneUserPassword(parameters.username, action) }));
      return { ...wrapped.result, operation: wrapped.operation, credentials: wrapped.credentials };
    }
    case 'users.applyPassword': {
      assertChangesAllowed();
      const wrapped = await withAction('users.applyPassword', requestId, async (action) => ({ user: await applyArcaneUserPassword(parameters.username, parameters.temporaryPassword, action) }));
      return { ...wrapped.result, operation: wrapped.operation, credentials: wrapped.credentials };
    }
    case 'users.restoreShell': {
      assertChangesAllowed();
      const wrapped = await withAction('users.restoreShell', requestId, async (action) => ({ user: await restoreArcaneUserShell(parameters.username, action) }));
      return { ...wrapped.result, operation: wrapped.operation, credentials: wrapped.credentials };
    }
    default:
      throw arcaneError('METHOD_NOT_ALLOWED', `Arcane does not expose the method “${method}”.`, 'Update the frontend or native host so that both use the same Arcane API version.', 404, { method });
  }
}

function normalizeResponseError(method, requestId, error) {
  const diagnostic = recordError(method || 'rpc', error, { requestId });
  const normalized = normalizeError(error);
  return { ...normalized, diagnosticId: diagnostic.id };
}

async function handleRequest(request, options) {
  if (!request || request.protocol !== PROTOCOL || request.type !== 'request' || !request.id) {
    throw arcaneError('INVALID_RPC_REQUEST', 'Arcane received an invalid native request.', 'Restart the Arcane application.', 400);
  }
  let releaseExclusiveMutation = null;
  try {
    const policy=assertMethodAllowed(String(request.method || ''));
    if (policy.exclusiveMutation) {
      releaseExclusiveMutation = acquireExclusiveMutation(request.method, request.id);
      if (simulatedExclusiveMutationDelayMs) await delay(simulatedExclusiveMutationDelayMs);
    }
    if (policy.privileged && !isElevated()) {
      if (options && options.worker) {
        throw arcaneError('ELEVATION_NOT_GRANTED', 'The privileged Arcane worker did not receive administrator access.', 'Approve the operating-system authorization prompt and try again.', 403);
      }
      await proxyThroughPrivilegedWorker(request);
      return;
    }
    const result = await dispatchMethod(request, options || {});
    await emitFrame({ protocol: PROTOCOL, type: 'response', id: request.id, ok: true, result, time: stamp() });
  } catch (error) {
    const failure = normalizeResponseError(request.method, request.id, error);
    await emitFrame({ protocol: PROTOCOL, type: 'response', id: request.id, ok: false, error: failure, time: stamp() });
  } finally {
    if (releaseExclusiveMutation) releaseExclusiveMutation();
  }
}

function workerEndpoint() {
  const nonce = crypto.randomBytes(20).toString('hex');
  if (platform === 'win32') return `\\\\.\\pipe\\arcane-privileged-${process.pid}-${nonce}`;
  const runtime = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(runtime, `arcane-privileged-${typeof process.getuid === 'function' ? process.getuid() : 'user'}-${nonce}.sock`);
}

function windowsPipeGuardName(endpoint) {
  const prefix = '\\\\.\\pipe\\';
  const value = String(endpoint || '');
  if (!value.startsWith(prefix)) throw new Error('Arcane generated an invalid Windows privilege pipe endpoint.');
  const name = value.slice(prefix.length);
  if (!/^arcane-privileged-[A-Za-z0-9-]{16,180}$/.test(name)) {
    throw new Error('Arcane generated an invalid Windows privilege pipe name.');
  }
  return name;
}

function windowsPipeGuardExecutable() {
  const root = path.resolve(bundleRoot());
  const candidates = [
    path.resolve(path.dirname(process.execPath), 'ArcanePipeGuard.exe'),
    path.resolve(root, 'ArcanePipeGuard.exe'),
    path.resolve(root, 'bin', 'ArcanePipeGuard.exe'),
  ];
  for (const executable of [...new Set(candidates.map((candidate) => candidate.toLowerCase()))]) {
    const original = candidates.find((candidate) => candidate.toLowerCase() === executable);
    if (original && fs.existsSync(original) && fs.statSync(original).isFile()) return original;
  }
  throw arcaneError(
    'PRIVILEGE_PIPE_GUARD_UNAVAILABLE',
    'Arcane cannot safely request administrator access because its Windows pipe guard is missing.',
    'Repair or reinstall Arcane OS from a verified release, then try again.',
    503
  );
}

function verifyUnsignedLocalPipeGuardBinding(guardExecutable) {
  const coreExecutable = path.resolve(process.execPath);
  if (path.dirname(guardExecutable).toLowerCase() !== path.dirname(coreExecutable).toLowerCase()) {
    throw new Error('Unsigned local Arcane Core and ArcanePipeGuard must be sibling files.');
  }
  const manifestPath = path.join(bundleRoot(), 'arcane-release.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 2 || manifest.hashAlgorithm !== 'sha256' || manifest.platform !== 'windows' || manifest.version !== VERSION || !Array.isArray(manifest.files)) {
    throw new Error('Unsigned local Arcane release manifest is invalid.');
  }
  const entries = new Map(manifest.files.map((entry) => [entry && entry.path, entry]));
  for (const [releasePath, file] of [['ArcaneCore.exe', coreExecutable], ['ArcanePipeGuard.exe', guardExecutable]]) {
    const entry = entries.get(releasePath);
    if (!entry || !Number.isSafeInteger(entry.size) || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) {
      throw new Error(`Unsigned local Arcane release does not bind ${releasePath}.`);
    }
    const stat = fs.statSync(file);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (stat.size !== entry.size || hash.toLowerCase() !== String(entry.sha256).toLowerCase()) {
      throw new Error(`Unsigned local ${releasePath} does not match the release manifest.`);
    }
  }
}

function monitorPipeGuardSignals(child) {
  let buffer = '';
  const seen = [];
  const waiters = new Set();
  let terminalError = null;

  const settleWaiters = () => {
    for (const waiter of [...waiters]) {
      const index = seen.findIndex((line) => line.startsWith(waiter.prefix));
      if (index >= 0) {
        const [line] = seen.splice(index, 1);
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else if (terminalError) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(terminalError);
      }
    }
  };
  const acceptLine = (raw) => {
    const line = String(raw || '').trim();
    if (!line) return;
    if (line.startsWith('ARCANE_PIPE_GUARD_ERROR ')) {
      terminalError = new Error(line.slice('ARCANE_PIPE_GUARD_ERROR '.length));
    } else {
      seen.push(line);
    }
    settleWaiters();
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      acceptLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
    if (buffer.length > 8192) {
      terminalError = new Error('ArcanePipeGuard emitted an oversized diagnostic line.');
      settleWaiters();
    }
  });
  child.once('error', (error) => {
    terminalError = error;
    settleWaiters();
  });
  child.once('exit', (code, signal) => {
    if (buffer) acceptLine(buffer);
    if (!terminalError && (code !== 0 || waiters.size)) {
      terminalError = new Error(`ArcanePipeGuard exited before peer authentication (code ${code}, signal ${signal || 'none'}).`);
    }
    settleWaiters();
  });

  return {
    waitFor(prefix, milliseconds) {
      if (terminalError) return Promise.reject(terminalError);
      const existing = seen.findIndex((line) => line.startsWith(prefix));
      if (existing >= 0) return Promise.resolve(seen.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { prefix, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`ArcanePipeGuard did not emit ${prefix.trim()} in time.`));
        }, milliseconds);
        waiters.add(waiter);
      });
    },
  };
}

function secretEquals(left, right) {
  const expected = Buffer.from(String(right || ''), 'utf8');
  const candidate = Buffer.from(String(left || ''), 'utf8');
  return candidate.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(candidate, expected);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestSha256(request) {
  return crypto.createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}

function privilegeBindingDocument(fields) {
  return {
    protocol: PROTOCOL,
    type: 'arcane-privilege-binding-v1',
    brokerSession: String(fields.brokerSession || ''),
    brokerPid: Number(fields.brokerPid),
    workerPid: Number(fields.workerPid),
    workerNonce: String(fields.workerNonce || ''),
    app: String(fields.app || ''),
    platform: String(fields.platform || ''),
    version: String(fields.version || ''),
    requestId: String(fields.requestId || ''),
    requestMethod: String(fields.requestMethod || ''),
    requestSha256: String(fields.requestSha256 || ''),
    brokerExchangePublicKey: String(fields.brokerExchangePublicKey || ''),
    workerExchangePublicKey: String(fields.workerExchangePublicKey || ''),
  };
}

function exportX25519PublicKey(key) {
  return key.export({ format: 'der', type: 'spki' }).toString('base64url');
}

function importX25519PublicKey(value) {
  const key = crypto.createPublicKey({ key: Buffer.from(String(value || ''), 'base64url'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'x25519') throw new Error('Unexpected privilege-channel key type.');
  return key;
}

function createPrivilegeChannel(privateKey, peerPublicKeyText, context) {
  const shared = crypto.diffieHellman({ privateKey, publicKey: importX25519PublicKey(peerPublicKeyText) });
  const salt = crypto.createHash('sha256').update(canonicalJson(context), 'utf8').digest();
  const derive = (direction) => Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(`arcane-privilege-channel-v1:${direction}`, 'utf8'), 32));
  return {
    brokerToWorkerKey: derive('broker-to-worker'),
    workerToBrokerKey: derive('worker-to-broker'),
    context,
    brokerSendSequence: 0,
    brokerReceiveSequence: 0,
    workerSendSequence: 0,
    workerReceiveSequence: 0,
  };
}

function privilegeFrameIv(direction, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid privilege-channel sequence.');
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(direction === 'broker-to-worker' ? 0x41524231 : 0x41525731, 0);
  iv.writeBigUInt64BE(BigInt(sequence), 4);
  return iv;
}

function privilegeFrameAad(direction, sequence, context) {
  return Buffer.from(canonicalJson({ protocol: PROTOCOL, type: 'secure', direction, sequence, ...context }), 'utf8');
}

function encryptPrivilegeFrame(key, direction, sequence, context, message) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, privilegeFrameIv(direction, sequence), { authTagLength: 16 });
  cipher.setAAD(privilegeFrameAad(direction, sequence, context));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(message), 'utf8')), cipher.final()]);
  return {
    protocol: PROTOCOL,
    type: 'secure',
    direction,
    sequence,
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

function decryptPrivilegeFrame(key, expectedDirection, expectedSequence, context, envelope) {
  if (!envelope || envelope.protocol !== PROTOCOL || envelope.type !== 'secure' || envelope.direction !== expectedDirection || envelope.sequence !== expectedSequence) {
    throw new Error('Arcane privilege-channel frame order or direction is invalid.');
  }
  const authTagText = String(envelope.authTag || '');
  if (!/^[A-Za-z0-9_-]{22}$/.test(authTagText)) {
    throw new Error('Arcane privilege-channel frame must contain an exact 16-byte authentication tag.');
  }
  const authTag = Buffer.from(authTagText, 'base64url');
  if (authTag.length !== 16 || authTag.toString('base64url') !== authTagText) {
    throw new Error('Arcane privilege-channel frame must contain an exact 16-byte authentication tag.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, privilegeFrameIv(expectedDirection, expectedSequence), { authTagLength: 16 });
  decipher.setAAD(privilegeFrameAad(expectedDirection, expectedSequence, context));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext || ''), 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

function launchSimulatedTokenDisclosureClient(endpoint, token, brokerSession) {
  if (!simulateBrokerFirstClient) return Promise.resolve(null);
  const attackerScript = path.join(bundleRoot(), 'tools', 'privilege-broker-attacker.cjs');
  if (!fs.existsSync(attackerScript)) {
    return Promise.reject(new Error('Privilege broker adversarial test helper is missing.'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      attackerScript,
      `--ipc=${endpoint}`,
      `--token=${token}`,
      `--broker-session=${brokerSession}`,
      `--broker-pid=${process.pid}`,
      `--protocol=${PROTOCOL}`,
      `--app=${appMode}`,
      `--platform=${platform}`,
      `--version=${VERSION}`,
    ], {
      cwd: safeSubprocessCwd,
      env: safeSubprocessEnvironment,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('The simulated disclosed-token broker client did not connect in time.'));
    }, 10000);
    child.once('message', (message) => {
      if (!message || message.connected !== true || Number(message.pid) !== child.pid) return;
      clearTimeout(timer);
      resolve(child.pid);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`The simulated disclosed-token broker client exited with code ${code}.`));
      }
    });
  });
}

function workerLaunchSpec(endpoint, token, brokerSession, brokerPublicKey) {
  const workerArgs = [
    '--privileged-worker',
    `--ipc=${endpoint}`,
    `--token=${token}`,
    `--broker-pid=${process.pid}`,
    `--broker-session=${brokerSession}`,
    `--broker-public-key=${brokerPublicKey}`,
    `--app=${appMode}`,
    `--bundle-root=${bundleRoot()}`,
    `--protected-user=${protectedProvisioningUsername()}`,
  ];
  if (allowSourceInstall) workerArgs.push('--allow-source-install');
  if (simulate) workerArgs.push('--simulate');
  if (simulatedPlatform) workerArgs.push(`--simulate-platform=${simulatedPlatform}`);
  if (process.pkg) return { executable: native.elevationTarget(process.execPath), args: workerArgs };
  return { executable: process.execPath, args: [path.resolve(__filename), ...workerArgs] };
}

let privilegeQueue = Promise.resolve();
function proxyThroughPrivilegedWorker(request) {
  const execute = () => runPrivilegedProxy(request);
  const result = privilegeQueue.then(execute, execute);
  privilegeQueue = result.catch(() => {});
  return result;
}

async function runPrivilegedProxy(request) {
  if (!simulate && platform === 'linux') {
    throw arcaneError(
      'PRIVILEGE_PEER_VERIFICATION_UNAVAILABLE',
      'Arcane has disabled automatic administrator brokering on Linux because the worker peer cannot yet be verified by the kernel.',
      'Run the signed Arcane Core from an already-root administrator session, or wait for a release with SO_PEERCRED enforcement.',
      503
    );
  }
  const kernelGuarded = !simulate && platform === 'win32';
  const endpoint = workerEndpoint();
  const token = crypto.randomBytes(32).toString('base64url');
  const brokerSession = crypto.randomBytes(24).toString('base64url');
  const brokerKeys = crypto.generateKeyPairSync('ed25519');
  const brokerPublicKey = brokerKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const brokerExchangeKeys = crypto.generateKeyPairSync('x25519');
  const brokerExchangePublicKey = exportX25519PublicKey(brokerExchangeKeys.publicKey);
  const originalRequestSha256 = requestSha256(request);
  const launchAction = createAction('permissions.authorize', request.id);
  actionStep(launchAction, 1, 'Requesting administrator authorization…');

  let server = null;
  let guardProcess = null;
  let guardSignals = null;
  let guardTransport = null;
  let workerSocket = null;
  let expectedWorkerPid = null;
  let settled = false;
  const clientSockets = new Set();
  let resolveAuthorized;
  let rejectAuthorized;
  let resolveWorker;
  let rejectWorker;
  let resolveLaunch;
  let rejectLaunch;
  const workerAuthorized = new Promise((resolve, reject) => {
    resolveAuthorized = resolve;
    rejectAuthorized = reject;
  });
  const workerDone = new Promise((resolve, reject) => {
    resolveWorker = resolve;
    rejectWorker = reject;
  });
  const workerLaunched = new Promise((resolve, reject) => {
    resolveLaunch = resolve;
    rejectLaunch = reject;
  });
  // Attach handlers immediately so a very fast worker failure cannot become an
  // unhandled rejection while the UAC/polkit launch call is still returning.
  workerAuthorized.catch(() => {});
  workerDone.catch(() => {});
  workerLaunched.catch(() => {});

  const cleanup = async () => {
    for (const client of clientSockets) if (!client.destroyed) client.destroy();
    clientSockets.clear();
    if (server) {
      await new Promise((resolve) => {
        try { server.close(() => resolve()); }
        catch (_) { resolve(); }
      });
    }
    if (guardTransport && !guardTransport.destroyed) guardTransport.destroy();
    if (guardProcess) {
      try { guardProcess.stdin.end(); } catch (_) {}
      if (guardProcess.exitCode === null && guardProcess.signalCode === null) {
        try { guardProcess.kill(); } catch (_) {}
      }
    }
    if (platform !== 'win32') await fsp.rm(endpoint, { force: true }).catch(() => {});
  };

  try {
    if (platform !== 'win32') await fsp.rm(endpoint, { force: true }).catch(() => {});
    const acceptIncoming = (incoming, kernelVerifiedPid) => {
        if (clientSockets.size >= 32) { incoming.destroy(); return; }
        clientSockets.add(incoming);
        let authenticatedClient = false;
        let privilegeChannel = null;
        let frameChain = Promise.resolve();
        if (typeof incoming.setTimeout === 'function') {
          incoming.setTimeout(15000, () => {
            if (incoming !== workerSocket) incoming.destroy();
          });
        }

        const rejectClient = (reason, frame) => {
          actionLog(launchAction, 'warn', 'Rejected an unauthorized privilege broker client.', {
            reason,
            claimedPid: Number(frame && frame.pid) || null,
            expectedPid: expectedWorkerPid,
          });
          incoming.destroy();
        };

        const handleClientFrame = async (frame) => {
          if (!authenticatedClient) {
            if (!frame || frame.type !== 'hello') {
              rejectClient('hello-required', frame);
              return;
            }
            const launchIdentity = await workerLaunched;
            const claimedPid = Number(frame.pid);
            const identityMatches = frame.protocol === PROTOCOL
              && secretEquals(frame.token, token)
              && secretEquals(frame.brokerSession, brokerSession)
              && Number(frame.brokerPid) === process.pid
              && (!kernelGuarded || kernelVerifiedPid === launchIdentity.pid)
              && Number.isSafeInteger(claimedPid)
              && claimedPid > 0
              && claimedPid === launchIdentity.pid
              && frame.app === appMode
              && frame.platform === platform
              && frame.version === VERSION;
            if (!identityMatches || frame.elevated !== true || !/^[A-Za-z0-9_-]{32,}$/.test(String(frame.workerNonce || '')) || !frame.workerExchangePublicKey) {
              rejectClient(identityMatches ? 'worker-not-elevated' : 'worker-identity-mismatch', frame);
              return;
            }
            if (workerSocket && workerSocket !== incoming) {
              rejectClient('worker-already-connected', frame);
              return;
            }
            authenticatedClient = true;
            workerSocket = incoming;
            if (typeof incoming.setTimeout === 'function') incoming.setTimeout(0);
            resolveAuthorized();
            if (kernelGuarded) {
              actionLog(launchAction, 'info', 'Windows verified the privileged worker through its kernel-reported named-pipe client PID.', {
                verifiedPid: kernelVerifiedPid,
              });
            }
            actionStep(launchAction, 25, 'Administrator authorization approved. Continuing the original operation...');
            const channelContext = {
              brokerSession,
              brokerPid: process.pid,
              workerPid: expectedWorkerPid,
              app: appMode,
              platform,
              version: VERSION,
              brokerExchangePublicKey,
              workerExchangePublicKey: frame.workerExchangePublicKey,
            };
            try {
              privilegeChannel = createPrivilegeChannel(brokerExchangeKeys.privateKey, frame.workerExchangePublicKey, channelContext);
            } catch (_) {
              rejectClient('worker-key-invalid', frame);
              return;
            }
            const binding = privilegeBindingDocument({
              brokerSession,
              brokerPid: process.pid,
              workerPid: expectedWorkerPid,
              workerNonce: frame.workerNonce,
              app: appMode,
              platform,
              version: VERSION,
              requestId: request.id,
              requestMethod: request.method,
              requestSha256: originalRequestSha256,
              brokerExchangePublicKey,
              workerExchangePublicKey: frame.workerExchangePublicKey,
            });
            const brokerSignature = crypto.sign(null, Buffer.from(canonicalJson(binding), 'utf8'), brokerKeys.privateKey).toString('base64url');
            await writeFrame(incoming, {
              protocol: PROTOCOL,
              type: 'broker-hello',
              token,
              brokerSession,
              brokerPid: process.pid,
              workerPid: expectedWorkerPid,
              app: appMode,
              platform,
              version: VERSION,
              workerNonce: frame.workerNonce,
              requestId: request.id,
              requestMethod: request.method,
              requestSha256: originalRequestSha256,
              brokerExchangePublicKey,
              workerExchangePublicKey: frame.workerExchangePublicKey,
              brokerSignature,
            });
            await writeFrame(incoming, encryptPrivilegeFrame(
              privilegeChannel.brokerToWorkerKey,
              'broker-to-worker',
              privilegeChannel.brokerSendSequence++,
              privilegeChannel.context,
              request
            ));
            return;
          }

          if (incoming !== workerSocket) {
            rejectClient('unbound-worker-socket', frame);
            return;
          }
          let message;
          try {
            message = decryptPrivilegeFrame(
              privilegeChannel.workerToBrokerKey,
              'worker-to-broker',
              privilegeChannel.brokerReceiveSequence++,
              privilegeChannel.context,
              frame
            );
          } catch (error) {
            rejectClient('secure-worker-frame-invalid', frame);
            throw error;
          }
          if (message && message.protocol === PROTOCOL && (message.type === 'event' || message.type === 'response')) {
            await emitFrame(message);
            if (message.type === 'response' && message.id === request.id) {
              settled = true;
              completeAction(launchAction, { elevatedWorkerPid: expectedWorkerPid });
              resolveWorker();
            }
            return;
          }
          rejectClient('invalid-worker-frame', message);
        };
        const decoder = new FrameDecoder((frame) => {
          frameChain = frameChain.then(() => handleClientFrame(frame)).catch((error) => {
            if (incoming === workerSocket) {
              rejectAuthorized(error);
              rejectWorker(error);
            } else {
              rejectClient('client-frame-error', frame);
            }
          });
        }, (error) => {
          if (incoming === workerSocket) {
            rejectAuthorized(error);
            rejectWorker(error);
          } else {
            rejectClient('client-decode-error', null);
          }
        });
        incoming.on('data', (chunk) => decoder.push(chunk));
        incoming.on('error', (error) => {
          if (incoming === workerSocket) {
            rejectAuthorized(error);
            rejectWorker(error);
          }
        });
        incoming.on('close', () => {
          clientSockets.delete(incoming);
          if (incoming === workerSocket && !settled) {
            const error = arcaneError('PRIVILEGED_WORKER_DISCONNECTED', 'The privileged Arcane worker closed before the operation finished.', 'Try the operation again and approve the authorization prompt.');
            rejectAuthorized(error);
            rejectWorker(error);
          }
        });
    };

    if (kernelGuarded) {
      const pipeName = windowsPipeGuardName(endpoint);
      const guardExecutable = windowsPipeGuardExecutable();
      if (typeof native.verifyPrivilegePipeGuardTrust !== 'function') {
        throw new Error('The Windows native adapter cannot verify ArcanePipeGuard trust.');
      }
      const guardTrust = await native.verifyPrivilegePipeGuardTrust(
        guardExecutable,
        path.resolve(process.execPath),
        { allowUnsignedLocalRelease },
        launchAction
      );
      if (guardTrust && guardTrust.unsignedLocal === true) verifyUnsignedLocalPipeGuardBinding(guardExecutable);
      guardProcess = spawn(guardExecutable, [`--pipe-name=${pipeName}`], {
        cwd: path.dirname(guardExecutable),
        env: safeSubprocessEnvironment,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      guardSignals = monitorPipeGuardSignals(guardProcess);
      const ready = await guardSignals.waitFor('ARCANE_PIPE_GUARD_READY ', 15000);
      if (ready !== `ARCANE_PIPE_GUARD_READY ${pipeName}`) {
        throw new Error('ArcanePipeGuard reported a different named-pipe endpoint.');
      }
    } else {
      await new Promise((resolve, reject) => {
        server = net.createServer((incoming) => acceptIncoming(incoming, null));
        server.once('error', reject);
        server.listen(endpoint, () => {
          server.removeListener('error', reject);
          server.on('error', (error) => {
            rejectAuthorized(error);
            rejectWorker(error);
          });
          if (platform !== 'win32') {
            try { fs.chmodSync(endpoint, 0o600); } catch (_) {}
          }
          resolve();
        });
      });
    }

    await launchSimulatedTokenDisclosureClient(endpoint, token, brokerSession);

    const launch = workerLaunchSpec(endpoint, token, brokerSession, brokerPublicKey);
    try {
      const launchResult = await native.launchElevated(launch.executable, launch.args, launchAction);
      const launchedPid = Number(launchResult && launchResult.launcherPid);
      if (!Number.isSafeInteger(launchedPid) || launchedPid <= 0) {
        throw arcaneError(
          'PRIVILEGED_WORKER_ID_UNAVAILABLE',
          'Arcane could not obtain the operating-system process identity of its privileged worker.',
          'Restart Arcane and try the operation again. No privileged request was sent.',
          500
        );
      }
      expectedWorkerPid = launchedPid;
      resolveLaunch({ pid: launchedPid });
    } catch (error) {
      rejectLaunch(error);
      throw error;
    }

    if (kernelGuarded) {
      const boundSignal = guardSignals.waitFor('ARCANE_PIPE_GUARD_BOUND ', 120000);
      await new Promise((resolve, reject) => {
        guardProcess.stdin.write(`ARCANE_EXPECTED_PID ${expectedWorkerPid}\n`, 'ascii', (error) => error ? reject(error) : resolve());
      });
      const bound = await boundSignal;
      const kernelPid = Number(bound.slice('ARCANE_PIPE_GUARD_BOUND '.length));
      if (!Number.isSafeInteger(kernelPid) || kernelPid !== expectedWorkerPid) {
        throw new Error('ArcanePipeGuard authenticated a different Windows process than the UAC launch returned.');
      }
      guardTransport = Duplex.from({ readable: guardProcess.stdout, writable: guardProcess.stdin });
      acceptIncoming(guardTransport, kernelPid);
    }

    const waitWithTimeout = async (promise, milliseconds, createError) => {
      let timer = null;
      try {
        await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(createError()), milliseconds);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    await waitWithTimeout(workerAuthorized, 120000, () => arcaneError(
      'ELEVATION_TIMEOUT',
      'Arcane timed out while waiting for administrator authorization.',
      'Try again and watch for the operating-system authorization prompt.'
    ));
    await waitWithTimeout(workerDone, 45 * 60 * 1000, () => arcaneError(
      'PRIVILEGED_OPERATION_TIMEOUT',
      'The privileged Arcane operation did not finish within 45 minutes.',
      'Open diagnostics to see the last completed step, then try again.'
    ));
  } catch (error) {
    if (!settled) {
      failAction(launchAction, error);
      const failure = normalizeResponseError(request.method, request.id, error);
      await emitFrame({ protocol: PROTOCOL, type: 'response', id: request.id, ok: false, error: failure, time: stamp() });
    }
  } finally {
    await cleanup();
  }
}

async function startPrivilegedWorker() {
  if (!ipcEndpoint || !ipcToken || !ipcBrokerSession || !ipcBrokerPublicKey || !Number.isSafeInteger(ipcBrokerPid) || ipcBrokerPid <= 0 || ipcBrokerPid === process.pid) {
    console.error('Arcane privileged worker is missing a valid IPC endpoint, token, broker session, broker public key, or broker process identity.');
    process.exit(6);
  }
  let brokerVerificationKey;
  try {
    brokerVerificationKey = crypto.createPublicKey({ key: Buffer.from(ipcBrokerPublicKey, 'base64url'), format: 'der', type: 'spki' });
    if (brokerVerificationKey.asymmetricKeyType !== 'ed25519') throw new Error('unexpected broker key type');
  } catch (_) {
    console.error('Arcane privileged worker rejected an invalid broker public key.');
    process.exit(6);
  }
  try {
    process.kill(ipcBrokerPid, 0);
  } catch (_) {
    console.error('Arcane privileged worker could not verify that its broker process is still running.');
    process.exit(6);
  }
  if (!isElevated()) {
    console.error('Arcane privileged worker did not receive elevated permissions.');
  }
  const socket = net.createConnection(ipcEndpoint);
  protocolSink = socket;
  let brokerAuthenticated = false;
  const workerNonce = crypto.randomBytes(32).toString('base64url');
  const workerExchangeKeys = crypto.generateKeyPairSync('x25519');
  const workerExchangePublicKey = exportX25519PublicKey(workerExchangeKeys.publicKey);
  let privilegeChannel = null;
  let authorizedRequestSha256 = null;
  let authorizedRequestId = null;
  let authorizedRequestMethod = null;
  let brokerFrameChain = Promise.resolve();
  const handleBrokerFrame = async (frame) => {
    if (!brokerAuthenticated) {
      const validBroker = frame
        && frame.protocol === PROTOCOL
        && frame.type === 'broker-hello'
        && secretEquals(frame.token, ipcToken)
        && secretEquals(frame.brokerSession, ipcBrokerSession)
        && Number(frame.brokerPid) === ipcBrokerPid
        && Number(frame.workerPid) === process.pid
        && frame.app === appMode
        && frame.platform === platform
        && frame.version === VERSION;
      const binding = validBroker && privilegeBindingDocument({
        brokerSession: ipcBrokerSession,
        brokerPid: ipcBrokerPid,
        workerPid: process.pid,
        workerNonce,
        app: appMode,
        platform,
        version: VERSION,
        requestId: frame.requestId,
        requestMethod: frame.requestMethod,
        requestSha256: frame.requestSha256,
        brokerExchangePublicKey: frame.brokerExchangePublicKey,
        workerExchangePublicKey,
      });
      let signatureValid = false;
      if (binding && /^[a-f0-9]{64}$/i.test(String(frame.requestSha256 || ''))) {
        try {
          signatureValid = crypto.verify(
            null,
            Buffer.from(canonicalJson(binding), 'utf8'),
            brokerVerificationKey,
            Buffer.from(String(frame.brokerSignature || ''), 'base64url')
          );
        } catch (_) { signatureValid = false; }
      }
      if (!validBroker || frame.workerNonce !== workerNonce || frame.workerExchangePublicKey !== workerExchangePublicKey || !signatureValid) throw new Error('Arcane privileged worker rejected an invalid or unsigned broker identity.');
      const channelContext = {
        brokerSession: ipcBrokerSession,
        brokerPid: ipcBrokerPid,
        workerPid: process.pid,
        app: appMode,
        platform,
        version: VERSION,
        brokerExchangePublicKey: frame.brokerExchangePublicKey,
        workerExchangePublicKey,
      };
      try {
        privilegeChannel = createPrivilegeChannel(workerExchangeKeys.privateKey, frame.brokerExchangePublicKey, channelContext);
      } catch (_) {
        throw new Error('Arcane privileged worker rejected an invalid broker exchange key.');
      }
      authorizedRequestSha256 = frame.requestSha256;
      authorizedRequestId = frame.requestId;
      authorizedRequestMethod = frame.requestMethod;
      brokerAuthenticated = true;
      protocolFrameWriter = (message) => writeFrame(socket, encryptPrivilegeFrame(
        privilegeChannel.workerToBrokerKey,
        'worker-to-broker',
        privilegeChannel.workerSendSequence++,
        privilegeChannel.context,
        message
      ));
      return;
    }
    const requestFrame = decryptPrivilegeFrame(
      privilegeChannel.brokerToWorkerKey,
      'broker-to-worker',
      privilegeChannel.workerReceiveSequence++,
      privilegeChannel.context,
      frame
    );
    if (!requestFrame || requestFrame.protocol !== PROTOCOL || requestFrame.type !== 'request') {
      throw new Error('Arcane privileged worker received a request before broker authentication completed.');
    }
    if (requestFrame.id !== authorizedRequestId || requestFrame.method !== authorizedRequestMethod || requestSha256(requestFrame) !== authorizedRequestSha256) {
      throw new Error('Arcane privileged worker rejected a request that was not bound to the broker signature.');
    }
    await handleRequest(requestFrame, { worker: true });
    setTimeout(() => {
      try { socket.end(); } catch (_) {}
      process.exit(0);
    }, 100).unref();
  };
  const decoder = new FrameDecoder((frame) => {
    brokerFrameChain = brokerFrameChain.then(() => handleBrokerFrame(frame)).catch((error) => {
      console.error(error && error.stack || error);
      process.exit(7);
    });
  }, (error) => {
    console.error(error && error.stack || error);
    process.exit(7);
  });
  socket.on('connect', () => {
    writeFrame(socket, {
      protocol: PROTOCOL,
      type: 'hello',
      token: ipcToken,
      brokerSession: ipcBrokerSession,
      brokerPid: ipcBrokerPid,
      elevated: isElevated(true),
      pid: process.pid,
      app: appMode,
      platform,
      version: VERSION,
      workerNonce,
      workerExchangePublicKey,
    });
  });
  socket.on('data', (chunk) => decoder.push(chunk));
  socket.on('error', (error) => {
    console.error('Arcane privileged IPC connection failed:', error && error.stack || error);
    process.exit(8);
  });
}

function startStandardCore() {
  protocolSink = process.stdout;
  const decoder = new FrameDecoder((frame) => {
    Promise.resolve(handleRequest(frame, { worker: false })).catch(async (error) => {
      const requestId = frame && frame.id || crypto.randomUUID();
      const failure = normalizeResponseError(frame && frame.method || 'rpc', requestId, error);
      await emitFrame({ protocol: PROTOCOL, type: 'response', id: requestId, ok: false, error: failure, time: stamp() });
    });
  }, async (error) => {
    const failure = normalizeResponseError('ipc.decode', null, error);
    await emitEvent('core.error', failure);
  });
  process.stdin.on('data', (chunk) => decoder.push(chunk));
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
  emitEvent('core.ready', { pid: process.pid, version: VERSION, app: appMode, platform: publicOperatingSystemInfo(), elevated: isElevated(), simulation: simulate });
}

async function startSessionCommandSelfTest() {
  if (!['accepted', 'error'].includes(sessionCommandSelfTest)) {
    console.error('Arcane session-command self-test mode must be accepted or error.');
    process.exit(10);
  }
  const spec = sessionCommandSelfTest === 'accepted'
    ? [process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000)']]
    : [path.join(os.tmpdir(), `arcane-missing-session-command-${process.pid}-${crypto.randomBytes(8).toString('hex')}`), []];
  try {
    const result = await launchSessionCommand(spec, 'run the session-command self-test for', { forceDispatch: true });
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: normalizeError(error) })}\n`);
  }
  process.exit(0);
}

if (sessionCommandSelfTest) startSessionCommandSelfTest();
else if (privilegedWorker) startPrivilegedWorker();
else startStandardCore();
