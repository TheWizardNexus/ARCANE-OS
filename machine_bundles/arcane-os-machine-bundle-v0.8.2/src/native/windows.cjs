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
  $assigned=[bool]($shellValue -and (($shellValue -eq $expected) -or (($shellValue -match 'ArcaneShell\\.exe') -and ($shellValue -match '--shell'))))
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
  if($previousShellPresent -ne $expectedPreviousPresent -or ($previousShellPresent -and $previousShell -ne $expectedPrevious)){
    throw "The login shell for '$name' changed after Arcane saved its recovery record. No shell change was made."
  }
  try {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name Shell -PropertyType String -Value $shell -Force | Out-Null
    $assigned=(Get-ItemProperty -LiteralPath $key -Name Shell -ErrorAction Stop).Shell
    if($assigned -ne $shell){ throw "Windows did not retain the Arcane shell assignment for '$name'." }
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
  if($currentShell -ne $expectedShell){throw "Arcane refused to activate '$name' because its staged shell no longer matches Arcane."}
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
  if($current -ne $expected){
    throw "Arcane refused to overwrite the current shell for '$name' because it no longer matches the installed Arcane shell."
  }
  if($previousPresent){
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name Shell -PropertyType String -Value $previous -Force | Out-Null
    $verified=(Get-ItemProperty -LiteralPath $key -Name Shell -ErrorAction Stop).Shell
    if($verified -ne $previous){ throw "Windows did not retain the restored shell for '$name'." }
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
