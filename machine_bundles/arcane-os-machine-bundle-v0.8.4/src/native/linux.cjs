function createLinuxNativeAdapter(ctx) {
  'use strict';

  const simulatedAccounts = ctx.simulatedAccounts
    && ['has', 'add', 'delete'].every((name) => typeof ctx.simulatedAccounts[name] === 'function')
    ? ctx.simulatedAccounts
    : new Set();
  const simulatedShellAssignments = ctx.simulatedShellAssignments
    && ['has', 'get', 'set', 'delete', 'values'].every((name) => typeof ctx.simulatedShellAssignments[name] === 'function')
    ? ctx.simulatedShellAssignments
    : new Map();
  const simulatedDisabledAccounts = new Set();

  const paths = Object.freeze({
    installRoot: !ctx.production&&process.env.ARCANE_INSTALL_ROOT || '/opt/arcane-os',
    stateRoot: !ctx.production&&process.env.ARCANE_STATE_ROOT || '/var/lib/arcane-os/state',
    nodeRoot: '/usr/local/lib/nodejs',
    ollamaRoot: '/usr',
    modelsRoot: '/var/lib/arcane-os/ollama-models',
  });
  const stagedInstallIntegrityByRoot = new Map();
  const preparedInstallStages = new Map();
  const linuxInstalledExecutablePaths = new Set([
    'bin/ArcaneCore',
    'bin/ArcaneProvisioner',
    'bin/ArcaneShell',
    'bin/arcane-provisioner',
    'bin/arcane-session',
    'bin/arcane-shell',
  ]);
  const maxInstalledEntries = 10000;
  const maxReleaseManifestBytes = 4 * 1024 * 1024;
  const maxReleasePayloadBytes = 16 * 1024 ** 3;
  const maxReleasePathDepth = 64;
  const enforcePosixMetadata = String(ctx.hostPlatform || process.platform) === 'linux';
  const systemCommandDirectories = Object.freeze([
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
  ]);

  function hasExactUnsignedLocalHostClaim() {
    return ctx.allowUnsignedLocalRelease === true
      && ctx.releaseSecurityModeClaim === 'unsigned-local-test'
      && !ctx.releaseContentBindingClaim
      && !ctx.releaseSignerThumbprintClaim
      && !ctx.releaseVerifiedAtClaim
      && !ctx.releaseRevocationStatusClaim
      && !ctx.releaseTrustSourceClaim
      && ctx.releaseTimestampVerifiedClaim !== true;
  }

  function linuxLauncherFiles(payload) {
    const executable = payload && payload.mode === 'linux-webkitgtk';
    const unsignedArgument = payload && payload.securityMode === 'unsigned-local-test' && hasExactUnsignedLocalHostClaim()
      ? ' --allow-unsigned-local-release'
      : '';
    const graphicalShell = executable
      ? `exec "$(dirname "$0")/ArcaneShell"${unsignedArgument} "$@"`
      : `exec node "$(dirname "$0")/arcane-shell.cjs"${unsignedArgument} "$@"`;
    const shellLauncher = `#!/bin/sh
if [ -n "\${DISPLAY:-}" ] || [ -n "\${WAYLAND_DISPLAY:-}" ]; then
  ${graphicalShell}
fi
if [ -x /bin/bash ]; then
  exec /bin/bash "$@"
fi
exec /bin/sh "$@"
`;
    return Object.freeze({
      'bin/arcane-shell': shellLauncher,
      'bin/arcane-provisioner': executable
        ? `#!/bin/sh\nexec "$(dirname "$0")/ArcaneProvisioner"${unsignedArgument} "$@"\n`
        : `#!/bin/sh\nexec node "$(dirname "$0")/arcane-provisioner.cjs"${unsignedArgument} "$@"\n`,
      'bin/arcane-session': '#!/bin/sh\nexec "$(dirname "$0")/arcane-shell" --shell "$@"\n',
    });
  }

  function launcherIntegrityEntries(payload) {
    return Object.entries(linuxLauncherFiles(payload)).map(([installPath, contents]) => ({
      installPath,
      path: installPath,
      size: Buffer.byteLength(contents, 'utf8'),
      sha256: ctx.crypto.createHash('sha256').update(contents, 'utf8').digest('hex'),
    }));
  }

  function systemCommandCandidates(command) {
    const value = String(command || '');
    if (!value || value.includes('\0')) return [];
    if (ctx.path.isAbsolute(value)) {
      const resolved = ctx.path.resolve(value);
      return samePath(resolved, value) ? [resolved] : [];
    }
    if (value !== ctx.path.basename(value) || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) return [];
    return systemCommandDirectories.map((directory) => ctx.path.join(directory, value));
  }

  function systemCommand(command) {
    for (const candidate of systemCommandCandidates(command)) {
      if (ctx.fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  function protectedDirectoryChain(directory) {
    const resolved = ctx.path.resolve(String(directory || ''));
    if (!ctx.path.isAbsolute(String(directory || '')) || !samePath(resolved, directory)) return null;
    const entries = [];
    let current = resolved;
    for (let depth = 0; depth < 64; depth += 1) {
      let stat = null;
      try { stat = ctx.fs.lstatSync(current); } catch (_) { return null; }
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return null;
      entries.push({ path: current, dev: stat.dev, ino: stat.ino });
      const parent = ctx.path.dirname(current);
      if (samePath(parent, current)) return entries;
      current = parent;
    }
    return null;
  }

  function protectedDirectoryChainUnchanged(entries) {
    if (!Array.isArray(entries) || !entries.length) return false;
    return entries.every((expected) => {
      let stat = null;
      try { stat = ctx.fs.lstatSync(expected.path); } catch (_) { return false; }
      return stat && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0
        && (stat.mode & 0o022) === 0 && stat.dev === expected.dev && stat.ino === expected.ino;
    });
  }

  function protectedExecutableSelection(command) {
    let found = false;
    const rejected = [];
    const inspectedCanonicalPaths = new Set();
    for (const candidate of systemCommandCandidates(command)) {
      if (!ctx.fs.existsSync(candidate)) continue;
      found = true;
      const candidateChain = protectedDirectoryChain(ctx.path.dirname(candidate));
      if (!candidateChain) {
        rejected.push(candidate);
        continue;
      }
      let canonical = null;
      try { canonical = ctx.fs.realpathSync(candidate); } catch (_) {}
      if (!canonical || !ctx.path.isAbsolute(canonical) || !samePath(ctx.path.resolve(canonical), canonical)) {
        rejected.push(candidate);
        continue;
      }
      if (inspectedCanonicalPaths.has(canonical)) continue;
      inspectedCanonicalPaths.add(canonical);
      const canonicalChain = protectedDirectoryChain(ctx.path.dirname(canonical));
      let stat = null;
      try { stat = ctx.fs.lstatSync(canonical); } catch (_) {}
      const protectedExecutable = stat && stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0
        && (stat.mode & 0o022) === 0 && (stat.mode & 0o111) !== 0;
      if (!canonicalChain || !protectedExecutable
        || !protectedDirectoryChainUnchanged(candidateChain)
        || !protectedDirectoryChainUnchanged(canonicalChain)) {
        rejected.push(canonical);
        continue;
      }
      return { command: canonical, found: true, rejected };
    }
    return { command: null, found, rejected };
  }

  function usesProtectedExecutableResolution() {
    return !ctx.simulate && typeof process.getuid === 'function' && process.getuid() === 0;
  }

  function executableCommand(command) {
    return usesProtectedExecutableResolution()
      ? protectedExecutableSelection(command).command
      : systemCommand(command);
  }

  function requiredProtectedExecutable(command, label, missingCode, missingMessage, missingResolution) {
    if (ctx.simulate) return command;
    const selection = protectedExecutableSelection(command);
    if (selection.command) return selection.command;
    if (!selection.found) {
      throw ctx.arcaneError(missingCode, missingMessage, missingResolution, 409);
    }
    const rejected = [...new Set(selection.rejected)].slice(0, 8);
    throw ctx.arcaneError(
      'LINUX_PROTECTED_FILE_UNSAFE',
      `Arcane refused to use an unprotected ${label}.`,
      `Install or restore a root-owned executable in a protected system directory that is not writable by group or other users, then retry.`,
      409,
      { path: rejected[0] || null, rejectedPaths: rejected }
    );
  }

  function commandExists(command) {
    return Boolean(executableCommand(command));
  }

  function candidateExecutable(candidates) {
    for (const value of candidates.filter(Boolean)) {
      const resolved = executableCommand(value);
      if (resolved) return resolved;
    }
    return null;
  }

  function usernameFromUid(uid) {
    if (uid === undefined || uid === null || uid === '') return null;
    const id = executableCommand('id');
    if (!id) return null;
    const result = ctx.boundedSpawnSync(id, ['-nu', String(uid)], { timeout: 10000 });
    return result.status === 0 ? String(result.stdout || '').trim() || null : null;
  }

  function currentIdentity() {
    const simulatedUsername = ctx.simulate && !ctx.processPkg
      ? String(process.env.ARCANE_SIMULATED_USERNAME || '').trim()
      : '';
    let username = simulatedUsername || process.env.USER || 'unknown';
    if (!simulatedUsername) {
      try { username = ctx.os.userInfo().username || username; } catch (_) {}
    }
    return {
      username,
      accountName: username,
      displayName: simulatedUsername || process.env.ARCANE_DISPLAY_NAME || username,
      computerName: ctx.os.hostname(),
      domain: null,
      source: 'linux',
    };
  }

  function protectedUsernames(elevationProtectedUsername) {
    const values = [
      elevationProtectedUsername,
      process.env.ARCANE_PROTECTED_USERNAME,
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
      sessionType: isWindowsSubsystemForLinux() ? 'wslg' : (process.env.XDG_SESSION_TYPE || null),
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
    if (ctx.simulate) return '/usr/bin/ollama';
    return candidateExecutable(['/usr/local/bin/ollama', '/usr/bin/ollama']);
  }
  function ollamaModelsRoot() { return paths.modelsRoot; }
  const aiHome=process.env.HOME||(typeof ctx.os.homedir==='function'?ctx.os.homedir():'/tmp');
  const aiCredentialRoot=ctx.path.join(process.env.XDG_CONFIG_HOME||ctx.path.join(aiHome,'.config'),'arcane-os','credentials');
  let simulatedOpenAIToken='';
  function aiCredentialFile(provider){if(provider!=='openai')throw new Error('Unsupported AI credential provider.');return ctx.path.join(aiCredentialRoot,'openai.token');}
  function hasAIProviderCredential(provider){return ctx.simulate?Boolean(simulatedOpenAIToken):ctx.fs.existsSync(aiCredentialFile(provider));}
  async function writeAIProviderCredential(provider,token){if(ctx.simulate){simulatedOpenAIToken=String(token);return true;}ctx.fs.mkdirSync(aiCredentialRoot,{recursive:true,mode:0o700});ctx.fs.writeFileSync(aiCredentialFile(provider),String(token),{encoding:'utf8',mode:0o600});return true;}
  async function readAIProviderCredential(provider){if(ctx.simulate)return simulatedOpenAIToken;const target=aiCredentialFile(provider);return ctx.fs.existsSync(target)?String(ctx.fs.readFileSync(target,'utf8')).trim():'';}
  async function deleteAIProviderCredential(provider){if(ctx.simulate){simulatedOpenAIToken='';return true;}const target=aiCredentialFile(provider);if(ctx.fs.existsSync(target))ctx.fs.unlinkSync(target);return true;}
  function ollamaServiceSettings() { return { supported:false,reason:'Arcane Linux service configuration requires an administrator-managed systemd override.',contextLength:0,keepAlive:'5m',maxLoadedModels:0,numParallel:1,maxQueue:512,flashAttention:false,kvCacheType:'f16',noCloud:true }; }
  async function configureOllamaServiceSettings() { throw ctx.arcaneError('OLLAMA_SERVICE_SETTINGS_MANUAL','Arcane cannot safely rewrite the Linux Ollama systemd service automatically.','Apply the documented environment settings through an administrator-managed systemd override, then restart Ollama.',501); }
  function gpuInfo() {
    if (ctx.simulate) return { devices: [{ name: 'Simulated GPU', memoryBytes: 16 * 1024 ** 3 }], totalMemoryBytes: 16 * 1024 ** 3, memoryReliable: true, source: 'simulation' };
    const nvidiaSmi = candidateExecutable(['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi']);
    if (nvidiaSmi) {
      const result = ctx.boundedSpawnSync(nvidiaSmi, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000 });
      if (result.status === 0) {
        const devices = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
          const separator = line.lastIndexOf(',');
          const mebibytes = Number(separator >= 0 ? line.slice(separator + 1).trim() : NaN);
          return { name: (separator >= 0 ? line.slice(0, separator) : line).trim().slice(0, 256), memoryBytes: Number.isFinite(mebibytes) && mebibytes > 0 ? Math.round(mebibytes * 1024 ** 2) : null };
        });
        const totalMemoryBytes = devices.reduce((sum, device) => sum + (device.memoryBytes || 0), 0);
        if (devices.length && devices.every((device) => Number.isSafeInteger(device.memoryBytes))) return { devices, totalMemoryBytes, memoryReliable: true, source: 'nvidia-smi' };
      }
    }
    const devices = [];
    try {
      for (const entry of ctx.fs.readdirSync('/sys/class/drm')) {
        if (!/^card\d+$/.test(entry)) continue;
        const memoryFile = `/sys/class/drm/${entry}/device/mem_info_vram_total`;
        if (!ctx.fs.existsSync(memoryFile)) continue;
        const memoryBytes = Number(String(ctx.fs.readFileSync(memoryFile, 'utf8')).trim());
        if (Number.isSafeInteger(memoryBytes) && memoryBytes > 0) devices.push({ name: entry, memoryBytes });
      }
    } catch (_) {}
    const totalMemoryBytes = devices.reduce((sum, device) => sum + device.memoryBytes, 0);
    return { devices, totalMemoryBytes: devices.length ? totalMemoryBytes : null, memoryReliable: Boolean(devices.length), source: devices.length ? 'linux-drm' : 'unavailable' };
  }

  function ollamaServiceStatus(executable) {
    if (ctx.simulate) {
      return { name: 'ollama.service', present: true, state: 'running', startType: 'enabled', commandMatches: Boolean(executable), ready: Boolean(executable) };
    }
    const systemctl = executableCommand('systemctl');
    if (!systemctl || !executable) {
      return { name: null, present: false, state: systemctl ? 'missing' : 'unavailable', startType: null, commandMatches: false, ready: false };
    }
    for (const name of ['arcane-ollama.service', 'ollama.service']) {
      const result = ctx.boundedSpawnSync(systemctl, [
        'show', name, '--no-pager',
        '--property=LoadState', '--property=ActiveState', '--property=UnitFileState', '--property=ExecStart',
      ], { timeout: 10000 });
      const output = `${result && result.stdout || ''}\n${result && result.stderr || ''}`;
      const loadState = /^LoadState=(.+)$/mi.exec(output)?.[1]?.trim() || 'not-found';
      if (!result || result.status !== 0 || loadState !== 'loaded') continue;
      const state = /^ActiveState=(.+)$/mi.exec(output)?.[1]?.trim() || 'unknown';
      const startType = /^UnitFileState=(.+)$/mi.exec(output)?.[1]?.trim() || 'unknown';
      const command = /^ExecStart=(.+)$/mi.exec(output)?.[1]?.trim() || '';
      const commandMatches = command.includes(executable) && /(?:^|\s)serve(?:\s|;|$)/i.test(command);
      return {
        name, present: true, state, startType, command, commandMatches,
        ready: state === 'active' && startType === 'enabled' && commandMatches,
      };
    }
    return { name: null, present: false, state: 'missing', startType: null, commandMatches: false, ready: false };
  }

  function ollamaStatus() {
    const executable = ollamaExecutable();
    return {
      machine: { present: Boolean(executable), executable, service: ollamaServiceStatus(executable) },
      user: { present: false, executable: null },
    };
  }

  function ollamaGlobalInstallAvailability() {
    return {
      available: false,
      status: 'manual-only',
      requiresElevation: true,
      provider: null,
      reason: 'Install and enable a machine-wide Ollama systemd service from a trusted distribution or official package.',
    };
  }

  function browserCandidates() {
    return ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser', 'firefox']
      .map(executableCommand)
      .filter(Boolean);
  }

  function browserExecutable() {
    return browserCandidates()[0] || null;
  }

  function rendererStatus() {
    if (ctx.simulate) return { id: 'webkitgtk', available: true, executable: 'webkitgtk-6.0', version: 'simulated', adapter: 'linux-webkitgtk' };
    const pkgConfig = executableCommand('pkg-config');
    if (!pkgConfig) return { id: 'webkitgtk', available: false, executable: null, version: null, adapter: 'linux-webkitgtk' };
    const result = ctx.boundedSpawnSync(pkgConfig, ['--modversion', 'webkitgtk-6.0'], { timeout: 10000 });
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
    return candidate ? executableCommand(candidate[0]) : null;
  }

  function logoutSpec() {
    if (ctx.simulate) return ['loginctl', ['terminate-user', currentIdentity().username]];
    const candidate = logoutCandidates().find(([command]) => commandExists(command));
    return candidate ? [executableCommand(candidate[0]), candidate[1]] : null;
  }

  function lockSpec() {
    if (ctx.simulate) return ['loginctl', ['lock-session']];
    const candidate = [
      ['loginctl', ['lock-session']],
      ['gnome-screensaver-command', ['-l']],
      ['xdg-screensaver', ['lock']],
    ].find(([command]) => commandExists(command));
    return candidate ? [executableCommand(candidate[0]), candidate[1]] : null;
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
    const tar = requiredProtectedExecutable(
      'tar',
      'Linux tar archive tool',
      'LINUX_ARCHIVE_TOOL_REQUIRED',
      'Arcane could not find the Linux tar archive tool.',
      'Install the distribution tar package, then retry.'
    );
    await ctx.run(tar, ['-xJf', packageFile, '-C', paths.nodeRoot], { action });
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
      const executable = executableCommand(name);
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

  function canonicalFilesystemIdentity(stat) {
    if (!stat || typeof stat.dev !== 'bigint' || stat.dev < 0n
      || typeof stat.ino !== 'bigint' || stat.ino <= 0n) return null;
    return Object.freeze({ device: stat.dev.toString(10), inode: stat.ino.toString(10) });
  }

  function sameCanonicalFilesystemIdentity(left, right) {
    return Boolean(left && right && left.device === right.device && left.inode === right.inode);
  }

  function sameFilesystemIdentity(left, right) {
    return sameCanonicalFilesystemIdentity(canonicalFilesystemIdentity(left), canonicalFilesystemIdentity(right));
  }

  function statIntegerEquals(value, expected) {
    if (!Number.isSafeInteger(expected) || expected < 0) return false;
    if (typeof value === 'bigint') return value === BigInt(expected);
    return Number.isSafeInteger(value) && value === expected;
  }

  function statIntegerToSafeNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) return null;
    if (typeof value === 'bigint') {
      if (value < 0n || value > BigInt(maximum)) return null;
      return Number(value);
    }
    return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
  }

  function sameReleaseFileState(left, right) {
    return sameFilesystemIdentity(left, right)
      && typeof left.size === 'bigint' && left.size === right.size
      && typeof left.mtimeNs === 'bigint' && left.mtimeNs === right.mtimeNs
      && typeof left.ctimeNs === 'bigint' && left.ctimeNs === right.ctimeNs;
  }

  function linuxReleaseOpenFlags(directory) {
    const constants = ctx.fs.constants || {};
    if (!Number.isInteger(constants.O_NOFOLLOW)
      || (directory && !Number.isInteger(constants.O_DIRECTORY))) {
      throw new Error('Arcane requires O_NOFOLLOW and O_DIRECTORY for Linux release verification.');
    }
    return constants.O_RDONLY | constants.O_NOFOLLOW
      | (directory ? constants.O_DIRECTORY : (constants.O_NONBLOCK || 0));
  }

  function releaseDescriptorPath(fd, childName = '') {
    const base = `/proc/self/fd/${fd}`;
    return childName ? `${base}/${childName}` : base;
  }

  function assertLinuxReleaseDirectory(entryPath, descriptorStat, rootDevice) {
    const pathStat = ctx.fs.lstatSync(entryPath, { bigint: true });
    const descriptorIdentity = canonicalFilesystemIdentity(descriptorStat);
    if (!descriptorStat.isDirectory() || !pathStat.isDirectory() || pathStat.isSymbolicLink()
      || !descriptorIdentity || descriptorIdentity.device !== rootDevice || !sameFilesystemIdentity(descriptorStat, pathStat)) {
      throw new Error(`A Linux release directory changed during verification: ${entryPath}.`);
    }
  }

  function recheckLinuxReleaseDirectoryChain(session, chain, relativePath) {
    for (const entry of chain) {
      const descriptorStat = ctx.fs.fstatSync(entry.fd, { bigint: true });
      if (!sameFilesystemIdentity(descriptorStat, entry.stat)) {
        throw new Error(`A Linux release directory changed while reading ${relativePath}.`);
      }
      assertLinuxReleaseDirectory(entry.path, descriptorStat, session.rootIdentity.device);
    }
  }

  function closeLinuxReleaseDirectoryChain(chain) {
    for (let index = chain.length - 1; index > 0; index -= 1) {
      try { ctx.fs.closeSync(chain[index].fd); } catch (_) {}
    }
  }

  function openLinuxReleaseDirectoryChain(session, relativeDirectory, relativePath) {
    const parts = relativeDirectory ? installedRelativePath(relativeDirectory).split('/') : [];
    if (parts.length > maxReleasePathDepth) throw new Error(`The Linux release path is too deep: ${relativePath}.`);
    const chain = [{ fd: session.rootFd, path: session.root, stat: session.rootStat }];
    let currentPath = session.root;
    try {
      recheckLinuxReleaseDirectoryChain(session, chain, relativePath);
      for (const part of parts) {
        const parent = chain[chain.length - 1];
        const fd = ctx.fs.openSync(releaseDescriptorPath(parent.fd, part), linuxReleaseOpenFlags(true));
        currentPath = ctx.path.join(currentPath, part);
        const stat = ctx.fs.fstatSync(fd, { bigint: true });
        chain.push({ fd, path: currentPath, stat });
        recheckLinuxReleaseDirectoryChain(session, chain, relativePath);
      }
      return chain;
    } catch (error) {
      closeLinuxReleaseDirectoryChain(chain);
      throw error;
    }
  }

  function readLinuxReleaseFile(session, relativePath, { maxBytes, expectedSize = null, collect = false } = {}) {
    const safePath = installedRelativePath(relativePath);
    const parts = safePath.split('/');
    const directory = parts.slice(0, -1).join('/');
    const chain = openLinuxReleaseDirectoryChain(session, directory, safePath);
    let fd = null;
    try {
      const leaf = parts[parts.length - 1];
      fd = ctx.fs.openSync(releaseDescriptorPath(chain[chain.length - 1].fd, leaf), linuxReleaseOpenFlags(false));
      const before = ctx.fs.fstatSync(fd, { bigint: true });
      const pathStat = ctx.fs.lstatSync(ctx.path.join(session.root, ...parts), { bigint: true });
      const beforeIdentity = canonicalFilesystemIdentity(before);
      const beforeSize = statIntegerToSafeNumber(before.size, maxBytes);
      if (!before.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()
        || !beforeIdentity || beforeIdentity.device !== session.rootIdentity.device || !sameFilesystemIdentity(before, pathStat)) {
        throw new Error(`The Linux release file changed before it could be read: ${safePath}.`);
      }
      if (beforeSize === null || (expectedSize !== null && beforeSize !== expectedSize)) {
        throw new Error(`${safePath} does not match the release manifest size.`);
      }
      recheckLinuxReleaseDirectoryChain(session, chain, safePath);
      const hash = ctx.crypto.createHash('sha256');
      const chunks = [];
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      while (true) {
        const readLength = Math.min(buffer.length, maxBytes - total + 1);
        if (readLength <= 0) throw new Error(`The Linux release file exceeds its verification limit: ${safePath}.`);
        const bytesRead = ctx.fs.readSync(fd, buffer, 0, readLength, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes || (expectedSize !== null && total > expectedSize)) {
          throw new Error(`The Linux release file exceeds its verification limit: ${safePath}.`);
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (collect) chunks.push(Buffer.from(chunk));
      }
      const after = ctx.fs.fstatSync(fd, { bigint: true });
      const finalPathStat = ctx.fs.lstatSync(ctx.path.join(session.root, ...parts), { bigint: true });
      if (total !== beforeSize || !sameReleaseFileState(before, after)
        || !sameReleaseFileState(before, finalPathStat)) {
        throw new Error(`The Linux release file changed while it was being read: ${safePath}.`);
      }
      recheckLinuxReleaseDirectoryChain(session, chain, safePath);
      return {
        bytes: collect ? Buffer.concat(chunks, total) : null,
        size: total,
        sha256: hash.digest('hex'),
      };
    } finally {
      if (fd !== null) try { ctx.fs.closeSync(fd); } catch (_) {}
      closeLinuxReleaseDirectoryChain(chain);
    }
  }

  function collectLinuxReleaseFiles(session) {
    const actualPaths = [];
    let entryCount = 0;
    let totalBytes = 0;
    const visit = (chain, relativeDirectory) => {
      recheckLinuxReleaseDirectoryChain(session, chain, relativeDirectory || '(release root)');
      const directoryBefore = ctx.fs.fstatSync(chain[chain.length - 1].fd, { bigint: true });
      const directory = ctx.fs.opendirSync(releaseDescriptorPath(chain[chain.length - 1].fd), { bufferSize: 32 });
      try {
        let entry = null;
        while ((entry = directory.readSync()) !== null) {
          if (!relativeDirectory && (entry.name === 'arcane-release.json' || entry.name === '.gitkeep')) continue;
          if (!entry.name || entry.name === '.' || entry.name === '..' || entry.name.includes('/') || entry.name.includes('\0')) {
            throw new Error('The Linux release contains an unsafe directory entry.');
          }
          entryCount += 1;
          if (entryCount > maxInstalledEntries) throw new Error('The Linux release contains too many entries.');
          const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
          installedRelativePath(relativePath);
          let childFd = null;
          try {
            childFd = ctx.fs.openSync(releaseDescriptorPath(chain[chain.length - 1].fd, entry.name), linuxReleaseOpenFlags(true));
          } catch (_) {}
          if (childFd !== null) {
            const childPath = ctx.path.join(session.root, ...relativePath.split('/'));
            const childStat = ctx.fs.fstatSync(childFd, { bigint: true });
            const childChain = [...chain, { fd: childFd, path: childPath, stat: childStat }];
            try {
              if (!relativeDirectory && entry.name !== 'app') throw new Error(`The release contains an unexpected directory: ${entry.name}.`);
              if (childChain.length > maxReleasePathDepth + 1) throw new Error(`The Linux release path is too deep: ${relativePath}.`);
              recheckLinuxReleaseDirectoryChain(session, childChain, relativePath);
              visit(childChain, relativePath);
            } finally {
              try { ctx.fs.closeSync(childFd); } catch (_) {}
            }
            continue;
          }
          let fileFd = null;
          try {
            fileFd = ctx.fs.openSync(releaseDescriptorPath(chain[chain.length - 1].fd, entry.name), linuxReleaseOpenFlags(false));
            const fileStat = ctx.fs.fstatSync(fileFd, { bigint: true });
            const filePath = ctx.path.join(session.root, ...relativePath.split('/'));
            const pathStat = ctx.fs.lstatSync(filePath, { bigint: true });
            const fileIdentity = canonicalFilesystemIdentity(fileStat);
            const fileSize = statIntegerToSafeNumber(fileStat.size, maxReleasePayloadBytes);
            if (!fileStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink()
              || !fileIdentity || fileIdentity.device !== session.rootIdentity.device || !sameFilesystemIdentity(fileStat, pathStat)
              || fileSize === null) {
              throw new Error(`The release contains an unsupported entry: ${relativePath}.`);
            }
            totalBytes += fileSize;
            if (!Number.isSafeInteger(totalBytes) || totalBytes > maxReleasePayloadBytes) {
              throw new Error('The Linux release payload exceeds its verification limit.');
            }
            actualPaths.push(relativePath);
          } finally {
            if (fileFd !== null) try { ctx.fs.closeSync(fileFd); } catch (_) {}
          }
        }
      } finally {
        try { directory.closeSync(); } catch (_) {}
      }
      const directoryAfter = ctx.fs.fstatSync(chain[chain.length - 1].fd, { bigint: true });
      if (!sameReleaseFileState(directoryBefore, directoryAfter)) {
        throw new Error(`A Linux release directory changed while its inventory was being read: ${relativeDirectory || '(release root)'}.`);
      }
      recheckLinuxReleaseDirectoryChain(session, chain, relativeDirectory || '(release root)');
    };
    visit([{ fd: session.rootFd, path: session.root, stat: session.rootStat }], '');
    return actualPaths.sort();
  }

  function verifyLinuxReleaseWithDescriptors(dist, requiredReleaseFiles) {
    const root = ctx.path.resolve(String(dist || ''));
    if (!ctx.path.isAbsolute(String(dist || '')) || !samePath(root, dist)) {
      throw new Error('Arcane rejected a non-canonical Linux release root.');
    }
    let rootFd = null;
    try {
      rootFd = ctx.fs.openSync(root, linuxReleaseOpenFlags(true));
      const rootStat = ctx.fs.fstatSync(rootFd, { bigint: true });
      const rootIdentity = canonicalFilesystemIdentity(rootStat);
      if (!rootIdentity) throw new Error('Arcane could not obtain a precise Linux release-root filesystem identity.');
      assertLinuxReleaseDirectory(root, rootStat, rootIdentity.device);
      if (!samePath(ctx.fs.realpathSync(root), root)) throw new Error('Arcane rejected a symlinked Linux release root.');
      const session = { root, rootFd, rootStat, rootIdentity };
      recheckLinuxReleaseDirectoryChain(session, [{ fd: rootFd, path: root, stat: rootStat }], '(release root)');
      const manifestRead = readLinuxReleaseFile(session, 'arcane-release.json', {
        maxBytes: maxReleaseManifestBytes,
        collect: true,
      });
      const releaseManifest = JSON.parse(manifestRead.bytes.toString('utf8'));
      if (releaseManifest.schemaVersion !== 2) throw new Error('The release manifest must use integrity schema 2.');
      if (releaseManifest.hashAlgorithm !== 'sha256') throw new Error('The release manifest must use SHA-256.');
      if (releaseManifest.version !== ctx.bundleVersion) throw new Error(`The verified release is ${releaseManifest.version || 'unknown'}, not ${ctx.bundleVersion}.`);
      if (releaseManifest.platform !== 'linux') throw new Error(`The release manifest targets ${releaseManifest.platform || 'an unknown platform'}, not Linux.`);
      const actualPaths = collectLinuxReleaseFiles(session);
      const entries = new Map();
      let declaredBytes = 0;
      for (const entry of Array.isArray(releaseManifest.files) ? releaseManifest.files : []) {
        const releasePath = entry && entry.path;
        const parts = typeof releasePath === 'string' ? releasePath.split('/') : [];
        if (!parts.length || parts.length > maxReleasePathDepth
          || parts.some((part) => !part || part === '.' || part === '..') || releasePath.includes('\\') || releasePath.includes(':')) {
          throw new Error(`The release manifest contains an unsafe path: ${String(releasePath)}.`);
        }
        if (entries.has(releasePath)) throw new Error(`The release manifest contains a duplicate path: ${releasePath}.`);
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`The release manifest contains an invalid size for ${releasePath}.`);
        declaredBytes += entry.size;
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxReleasePayloadBytes) throw new Error('The Linux release payload exceeds its verification limit.');
        if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) throw new Error(`The release manifest contains an invalid SHA-256 for ${releasePath}.`);
        entries.set(releasePath, entry);
      }
      if (entries.size > maxInstalledEntries || entries.size !== actualPaths.length
        || actualPaths.some((releasePath) => !entries.has(releasePath))) {
        throw new Error('The release manifest file inventory does not exactly match the dist payload.');
      }
      for (const name of requiredReleaseFiles) {
        if (!entries.has(name)) throw new Error(`The release manifest does not verify ${name}.`);
      }
      for (const releasePath of actualPaths) {
        const entry = entries.get(releasePath);
        const read = readLinuxReleaseFile(session, releasePath, { maxBytes: entry.size, expectedSize: entry.size });
        if (read.sha256.toLowerCase() !== String(entry.sha256).toLowerCase()) {
          throw new Error(`${releasePath} does not match the release manifest SHA-256.`);
        }
      }
      recheckLinuxReleaseDirectoryChain(session, [{ fd: rootFd, path: root, stat: rootStat }], '(release root)');
      return { releaseManifest, verifiedEntries: actualPaths.map((releasePath) => ({ ...entries.get(releasePath) })) };
    } finally {
      if (rootFd !== null) try { ctx.fs.closeSync(rootFd); } catch (_) {}
    }
  }

  function installPayload(root) {
    const dist = ctx.fs.existsSync(ctx.path.join(root, 'arcane-release.json')) && ctx.fs.existsSync(ctx.path.join(root, 'app'))
      ? root
      : ctx.fs.existsSync(ctx.path.join(root, 'dist', 'linux', 'arcane-release.json')) && ctx.fs.existsSync(ctx.path.join(root, 'dist', 'linux', 'app'))
      ? ctx.path.join(root, 'dist', 'linux')
      : ctx.path.join(root, 'dist');
    const requiredReleaseFiles = [
      'ArcaneShell',
      'ArcaneProvisioner',
      'ArcaneCore',
      'arcane-bundle.json',
      'app/arcane/css/theme.css',
      'app/arcane/entities/Preference.js',
      'app/arcane/entities/Theme.js',
      'app/arcane/modules/AppDataScope.js',
      'app/arcane/modules/AppearancePreferences.js',
      'app/arcane/modules/PreferenceStore.js',
      'app/arcane/modules/SystemAppearance.js',
      'app/arcane/modules/ThemeBootstrap.js',
      'app/arcane/modules/ThemeManager.js',
      'app/shared/arcane-api.js',
      'app/shared/SystemPlatformPresentation.js',
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
        if (enforcePosixMetadata) {
          const verified = verifyLinuxReleaseWithDescriptors(dist, requiredReleaseFiles);
          releaseManifest = verified.releaseManifest;
          verifiedEntries = verified.verifiedEntries;
        } else {
        const releaseRootStat = ctx.fs.lstatSync(dist);
        const releaseManifestStat = ctx.fs.lstatSync(releaseManifestPath);
        if (!releaseRootStat.isDirectory() || releaseRootStat.isSymbolicLink()) throw new Error('The Linux release root is not a regular directory.');
        if (!releaseManifestStat.isFile() || releaseManifestStat.isSymbolicLink()) throw new Error('The Linux release manifest is not a regular file.');
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
        }
      } catch (error) { releaseProblem = `The release manifest could not be read: ${error.message}`; }
    }
    if (!missingRelease.length && !releaseProblem) {
      const topLevelFiles = verifiedEntries.filter((entry) => !entry.path.includes('/') && entry.path !== 'arcane-bundle.json');
      const releaseIntegrityFiles = verifiedEntries.map((entry) => ({
        ...entry,
        installPath: entry.path === 'arcane-bundle.json' || entry.path.startsWith('app/') ? entry.path : `bin/${entry.path}`,
        source: ctx.path.join(dist, ...entry.path.split('/')),
      }));
      const payload = {
        mode: 'linux-webkitgtk',
        releaseReady: true,
        verified: true,
        securityMode: 'unsigned-local-test',
        releaseRoot: dist,
        releaseManifest,
        integrity: {
          schemaVersion: releaseManifest.schemaVersion,
          hashAlgorithm: releaseManifest.hashAlgorithm,
          sourceManifest: releaseManifestPath,
          files: [],
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
      payload.integrity.files = [...releaseIntegrityFiles, ...launcherIntegrityEntries(payload)];
      return payload;
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

  function installedRelativePath(value) {
    const relativePath = String(value || '');
    const parts = relativePath.split('/');
    if (!relativePath || relativePath.includes('\\') || relativePath.includes(':')
      || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Arcane rejected an unsafe installed path: ${relativePath || '(empty)'}.`);
    }
    return relativePath;
  }

  function permissionBits(stat) {
    const mode = stat && stat.mode;
    if (typeof mode === 'bigint') return Number(mode & 0o7777n);
    return Number.isSafeInteger(mode) ? mode & 0o7777 : -1;
  }

  function samePath(left, right) {
    const leftPath = ctx.path.resolve(String(left || ''));
    const rightPath = ctx.path.resolve(String(right || ''));
    return ctx.path.sep === '\\' ? leftPath.toLowerCase() === rightPath.toLowerCase() : leftPath === rightPath;
  }

  function escapeRegularExpression(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function exactOwnDataRecord(value, expectedKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== 'string')) return null;
    const actualKeys = ownKeys.slice().sort();
    const wantedKeys = expectedKeys.slice().sort();
    if (actualKeys.some((key, index) => key !== wantedKeys[index])) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      record[key] = descriptor.value;
    }
    return record;
  }

  function expectedInstallStagePath(value) {
    if (typeof value !== 'string' || !ctx.path.isAbsolute(value)) return null;
    const stageRoot = ctx.path.resolve(value);
    if (!samePath(stageRoot, value)) return null;
    const installRoot = ctx.path.resolve(paths.installRoot);
    const parent = ctx.path.dirname(installRoot);
    const expectedName = new RegExp(`^${escapeRegularExpression(ctx.path.basename(installRoot))}\\.stage-${process.pid}-[a-f0-9]{48}$`);
    if (!samePath(ctx.path.dirname(stageRoot), parent) || samePath(stageRoot, installRoot)
      || !expectedName.test(ctx.path.basename(stageRoot))) return null;
    return { stageRoot, installRoot, parent };
  }

  function validatedInstallStageOwnership(value) {
    const record = exactOwnDataRecord(value, ['schemaVersion', 'platform', 'stage', 'device', 'inode']);
    if (!record || record.schemaVersion !== 1 || record.platform !== 'linux'
      || typeof record.device !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(record.device)
      || typeof record.inode !== 'string' || !/^[1-9][0-9]*$/.test(record.inode)) return null;
    const stage = expectedInstallStagePath(record.stage);
    if (!stage) return null;
    return Object.freeze({ ...record, stage: stage.stageRoot });
  }

  function expectedInstallTopology(entries) {
    const files = new Map();
    const directories = new Set();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const relativePath = installedRelativePath(entry && (entry.installPath || entry.path));
      if (files.has(relativePath)) throw new Error(`Arcane rejected a duplicate installed path: ${relativePath}.`);
      const parts = relativePath.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        const directory = parts.slice(0, index).join('/');
        if (files.has(directory)) throw new Error(`Arcane rejected an installed file/directory collision: ${directory}.`);
        directories.add(directory);
      }
      if (directories.has(relativePath)) throw new Error(`Arcane rejected an installed file/directory collision: ${relativePath}.`);
      files.set(relativePath, entry);
    }
    if (!files.size) throw new Error('Arcane rejected an empty installed integrity inventory.');
    if (files.size + directories.size > maxInstalledEntries) throw new Error('Arcane rejected an oversized installed file inventory.');
    return { files, directories };
  }

  function inspectInstallStageLocation(stage, expectedMode) {
    const expected = expectedInstallStagePath(stage);
    if (!expected) {
      throw new Error('Arcane rejected a non-canonical Linux installation stage path.');
    }
    const { stageRoot, parent } = expected;
    const parentStat = ctx.fs.lstatSync(parent, { bigint: true });
    const parentIdentity = canonicalFilesystemIdentity(parentStat);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || !parentIdentity || !statIntegerEquals(parentStat.uid, 0)
      || (enforcePosixMetadata && !statIntegerEquals(parentStat.gid, 0)) || (permissionBits(parentStat) & 0o022) !== 0) {
      throw new Error('Arcane rejected an unprotected Linux installation parent.');
    }
    if (!samePath(ctx.fs.realpathSync(parent), parent)) throw new Error('Arcane rejected a non-canonical Linux installation parent.');
    const stageStat = ctx.fs.lstatSync(stageRoot, { bigint: true });
    const stageIdentity = canonicalFilesystemIdentity(stageStat);
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory() || !stageIdentity || !statIntegerEquals(stageStat.uid, 0)
      || (enforcePosixMetadata && !statIntegerEquals(stageStat.gid, 0)) || stageIdentity.device !== parentIdentity.device) {
      throw new Error('Arcane rejected an unprotected Linux installation stage.');
    }
    if (!samePath(ctx.fs.realpathSync(stageRoot), stageRoot)) throw new Error('Arcane rejected a non-canonical Linux installation stage.');
    if (expectedMode !== null && enforcePosixMetadata && permissionBits(stageStat) !== expectedMode) {
      throw new Error(`Arcane rejected a Linux installation stage without mode ${expectedMode.toString(8)}.`);
    }
    return { stageRoot, parent, stat: stageStat, identity: stageIdentity };
  }

  async function prepareInstallStage(stage) {
    const initial = inspectInstallStageLocation(stage, null);
    await ctx.fsp.chmod(initial.stageRoot, 0o700);
    const prepared = inspectInstallStageLocation(initial.stageRoot, 0o700);
    preparedInstallStages.set(prepared.stageRoot, prepared.identity);
    while (preparedInstallStages.size > 4) preparedInstallStages.delete(preparedInstallStages.keys().next().value);
    return { prepared: true, path: prepared.stageRoot };
  }

  function preparedInstallStage(stage, expectedMode) {
    const inspected = inspectInstallStageLocation(stage, expectedMode);
    const prepared = preparedInstallStages.get(inspected.stageRoot);
    if (!sameCanonicalFilesystemIdentity(prepared, inspected.identity)) {
      throw new Error('Arcane rejected a Linux installation stage whose filesystem identity changed.');
    }
    return { ...inspected, identity: inspected.identity };
  }

  function captureInstallStageOwnership(stage) {
    const inspected = preparedInstallStage(stage, 0o700);
    return Object.freeze({
      schemaVersion: 1,
      platform: 'linux',
      stage: inspected.stageRoot,
      device: inspected.identity.device,
      inode: inspected.identity.inode,
    });
  }

  function installStageOwnershipStatus(ownership, target) {
    const record = validatedInstallStageOwnership(ownership);
    if (!record) return { state: 'uncertain', reason: 'invalid-ownership-record' };
    const targetPath = ctx.path.resolve(String(target || ''));
    const installRoot = ctx.path.resolve(paths.installRoot);
    const failedName = new RegExp(`^${escapeRegularExpression(ctx.path.basename(installRoot))}\\.failed-[0-9]+$`);
    const failedPath = samePath(ctx.path.dirname(targetPath), ctx.path.dirname(installRoot))
      && failedName.test(ctx.path.basename(targetPath));
    if (!samePath(targetPath, record.stage) && !samePath(targetPath, installRoot) && !failedPath) {
      return { state: 'uncertain', reason: 'candidate-outside-owned-install-paths' };
    }
    let stat = null;
    try { stat = ctx.fs.lstatSync(targetPath, { bigint: true }); }
    catch (error) {
      if (error && error.code === 'ENOENT') return { state: 'missing', reason: 'not-found' };
      return { state: 'uncertain', reason: error && (error.code || error.message) || 'identity-read-failed' };
    }
    const identity = canonicalFilesystemIdentity(stat);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !identity
      || identity.device !== record.device || identity.inode !== record.inode) {
      return { state: 'foreign', reason: 'identity-mismatch' };
    }
    return { state: 'owned', path: targetPath, originalStage: record.stage, device: identity.device, inode: identity.inode };
  }

  async function cleanupInstallStage(ownership, target) {
    const targetPath = ctx.path.resolve(String(target || ''));
    const status = installStageOwnershipStatus(ownership, targetPath);
    if (status.state !== 'owned') {
      throw new Error('Arcane refused to clean a Linux installation tree without its captured filesystem identity.');
    }
    await ctx.fsp.rm(targetPath, { recursive: true, force: false });
    preparedInstallStages.delete(status.originalStage);
    stagedInstallIntegrityByRoot.delete(status.originalStage);
    return { removed: true, path: targetPath };
  }

  function captureSourceDirectoryChain(releaseRoot, relativePath) {
    const canonicalRoot = ctx.path.resolve(String(releaseRoot || ''));
    if (!ctx.path.isAbsolute(String(releaseRoot || '')) || !samePath(canonicalRoot, releaseRoot)) {
      throw new Error('Arcane rejected a non-canonical Linux release root.');
    }
    if (!samePath(ctx.fs.realpathSync(canonicalRoot), canonicalRoot)) throw new Error('Arcane rejected a symlinked Linux release root.');
    const rootStat = ctx.fs.lstatSync(canonicalRoot, { bigint: true });
    const rootIdentity = canonicalFilesystemIdentity(rootStat);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !rootIdentity) throw new Error('Arcane rejected an unsafe Linux release root.');
    const parts = installedRelativePath(relativePath).split('/');
    const chain = [{ path: canonicalRoot, ...rootIdentity }];
    let current = canonicalRoot;
    for (const part of parts.slice(0, -1)) {
      current = ctx.path.join(current, part);
      const stat = ctx.fs.lstatSync(current, { bigint: true });
      const identity = canonicalFilesystemIdentity(stat);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !identity || identity.device !== rootIdentity.device) {
        throw new Error(`Arcane rejected an unsafe Linux release directory for ${relativePath}.`);
      }
      chain.push({ path: current, ...identity });
    }
    const source = ctx.path.resolve(canonicalRoot, ...parts);
    const rootPrefix = `${canonicalRoot}${ctx.path.sep}`;
    if (!source.startsWith(rootPrefix)) throw new Error(`Arcane rejected a Linux release path outside its root: ${relativePath}.`);
    return { source, rootIdentity, chain };
  }

  function recheckSourceDirectoryChain(captured, relativePath) {
    for (const expected of captured.chain) {
      const stat = ctx.fs.lstatSync(expected.path, { bigint: true });
      const identity = canonicalFilesystemIdentity(stat);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !identity
        || identity.device !== expected.device || identity.inode !== expected.inode) {
        throw new Error(`Arcane rejected a Linux release directory that changed while copying ${relativePath}.`);
      }
    }
  }

  function assertPrivateStageDirectory(entryPath, stat, device) {
    const identity = canonicalFilesystemIdentity(stat);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !identity
      || !statIntegerEquals(stat.uid, 0) || !statIntegerEquals(stat.gid, 0)
      || identity.device !== device || permissionBits(stat) !== 0o700) {
      throw new Error(`Arcane rejected an unprotected private installation directory: ${entryPath}.`);
    }
  }

  async function ensurePrivateStageDirectory(stageInfo, relativeDirectory) {
    let current = stageInfo.stageRoot;
    for (const part of relativeDirectory ? relativeDirectory.split('/') : []) {
      current = ctx.path.join(current, part);
      try {
        await ctx.fsp.mkdir(current, { recursive: false, mode: 0o700 });
        await ctx.fsp.chmod(current, 0o700);
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
      }
      assertPrivateStageDirectory(current, ctx.fs.lstatSync(current, { bigint: true }), stageInfo.identity.device);
    }
    return current;
  }

  function freshFileFlags(readOnly) {
    const constants = ctx.fs.constants || {};
    if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error('Arcane requires O_NOFOLLOW for Linux installation staging.');
    if (readOnly) return constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0);
    return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  }

  async function writeAll(handle, buffer, length) {
    let offset = 0;
    while (offset < length) {
      const result = await handle.write(buffer, offset, length - offset, null);
      if (!result || result.bytesWritten <= 0) throw new Error('Arcane could not complete a protected installation write.');
      offset += result.bytesWritten;
    }
  }

  async function verifyFreshStageFile(handle, relativePath, expectedMode, expectedSize) {
    await handle.chown(0, 0);
    await handle.chmod(expectedMode);
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1
      || permissionBits(stat) !== expectedMode || stat.size !== expectedSize) {
      throw new Error(`Arcane rejected a non-canonical staged file: ${relativePath}.`);
    }
  }

  async function copyReleaseFileToStage(stageInfo, payload, relativePath, entry) {
    const sourcePath = installedRelativePath(entry.path);
    const captured = captureSourceDirectoryChain(payload.releaseRoot, sourcePath);
    if (entry.source && !samePath(entry.source, captured.source)) throw new Error(`Arcane rejected an inconsistent Linux release source for ${relativePath}.`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) {
      throw new Error(`Arcane rejected invalid integrity metadata for ${relativePath}.`);
    }
    const destination = ctx.path.join(stageInfo.stageRoot, ...relativePath.split('/'));
    await ensurePrivateStageDirectory(stageInfo, relativePath.split('/').slice(0, -1).join('/'));
    let sourceHandle = null;
    let destinationHandle = null;
    try {
      sourceHandle = await ctx.fsp.open(captured.source, freshFileFlags(true));
      const sourceStat = await sourceHandle.stat({ bigint: true });
      const sourceIdentity = canonicalFilesystemIdentity(sourceStat);
      if (!sourceStat.isFile() || !sourceIdentity || sourceIdentity.device !== captured.rootIdentity.device
        || !statIntegerEquals(sourceStat.size, entry.size)) {
        throw new Error(`Arcane rejected an unsafe or changed Linux release file: ${sourcePath}.`);
      }
      destinationHandle = await ctx.fsp.open(destination, freshFileFlags(false), 0o600);
      const hash = ctx.crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let copied = 0;
      while (true) {
        const result = await sourceHandle.read(buffer, 0, buffer.length, null);
        if (!result || result.bytesRead === 0) break;
        copied += result.bytesRead;
        if (copied > entry.size) throw new Error(`Arcane rejected a Linux release file that grew while copying: ${sourcePath}.`);
        hash.update(buffer.subarray(0, result.bytesRead));
        await writeAll(destinationHandle, buffer, result.bytesRead);
      }
      if (copied !== entry.size || hash.digest('hex').toLowerCase() !== String(entry.sha256).toLowerCase()) {
        throw new Error(`Arcane rejected modified Linux release content: ${sourcePath}.`);
      }
      const expectedMode = linuxInstalledExecutablePaths.has(relativePath) ? 0o755 : 0o644;
      await verifyFreshStageFile(destinationHandle, relativePath, expectedMode, copied);
    } finally {
      if (destinationHandle) await destinationHandle.close().catch(() => {});
      if (sourceHandle) await sourceHandle.close().catch(() => {});
    }
    recheckSourceDirectoryChain(captured, sourcePath);
  }

  async function writeGeneratedStageFile(stageInfo, relativePath, contents, entry) {
    const buffer = Buffer.from(contents, 'utf8');
    if (!entry || entry.size !== buffer.length
      || ctx.crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase() !== String(entry.sha256 || '').toLowerCase()) {
      throw new Error(`Arcane rejected inconsistent generated launcher integrity for ${relativePath}.`);
    }
    if (!enforcePosixMetadata) {
      await ctx.writeFile(ctx.path.join(stageInfo.stageRoot, ...relativePath.split('/')), contents, 0o755);
      return;
    }
    await ensurePrivateStageDirectory(stageInfo, relativePath.split('/').slice(0, -1).join('/'));
    const destination = ctx.path.join(stageInfo.stageRoot, ...relativePath.split('/'));
    let handle = null;
    try {
      handle = await ctx.fsp.open(destination, freshFileFlags(false), 0o600);
      await writeAll(handle, buffer, buffer.length);
      await verifyFreshStageFile(handle, relativePath, 0o755, buffer.length);
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function materializeInstallStage(stage, payload) {
    const stageInfo = preparedInstallStage(stage, 0o700);
    const topology = expectedInstallTopology(payload && payload.integrity && payload.integrity.files);
    for (const [relativePath, entry] of [...topology.files].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
      if (!entry.source) {
        if (!linuxInstalledExecutablePaths.has(relativePath) || !relativePath.startsWith('bin/arcane-')) {
          throw new Error(`Arcane rejected an installation entry without a verified release source: ${relativePath}.`);
        }
        continue;
      }
      await copyReleaseFileToStage(stageInfo, payload, relativePath, entry);
    }
    return { materialized: true, files: topology.files.size };
  }

  async function writeLaunchers(stage, payload) {
    const stageRoot = ctx.path.resolve(stage);
    if (ctx.simulate) {
      for (const [installPath, contents] of Object.entries(linuxLauncherFiles(payload))) {
        await ctx.writeFile(ctx.path.join(stageRoot, ...installPath.split('/')), contents, 0o755);
      }
      return;
    }
    const stageInfo = preparedInstallStage(stageRoot, 0o700);
    const integrityEntries = payload && payload.integrity && Array.isArray(payload.integrity.files)
      ? payload.integrity.files
      : launcherIntegrityEntries(payload);
    const expected = expectedInstallTopology(integrityEntries).files;
    try {
      for (const [installPath, contents] of Object.entries(linuxLauncherFiles(payload))) {
        await writeGeneratedStageFile(stageInfo, installPath, contents, expected.get(installPath));
      }
      stagedInstallIntegrityByRoot.set(stageRoot, integrityEntries.map((entry) => ({ ...entry })));
      while (stagedInstallIntegrityByRoot.size > 4) stagedInstallIntegrityByRoot.delete(stagedInstallIntegrityByRoot.keys().next().value);
    } catch (error) {
      stagedInstallIntegrityByRoot.delete(stageRoot);
      throw error;
    }
  }

  function inspectExactStageTree(stage, entries, rootMode, directoryMode) {
    const stageInfo = preparedInstallStage(stage, rootMode);
    const topology = expectedInstallTopology(entries);
    const actualFiles = new Set();
    const actualDirectories = new Map();
    let count = 0;
    const visit = (directory, relativeDirectory) => {
      for (const entry of ctx.fs.readdirSync(directory, { withFileTypes: true })) {
        count += 1;
        if (count > maxInstalledEntries) throw new Error('Arcane rejected an oversized installed file inventory.');
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const target = ctx.path.resolve(directory, entry.name);
        const stagePrefix = `${stageInfo.stageRoot}${ctx.path.sep}`;
        if (!target.startsWith(stagePrefix)) throw new Error(`Arcane rejected a staged path outside its root: ${relativePath}.`);
        const stat = ctx.fs.lstatSync(target, { bigint: true });
        const identity = canonicalFilesystemIdentity(stat);
        if (stat.isSymbolicLink() || !identity || identity.device !== stageInfo.identity.device
          || !statIntegerEquals(stat.uid, 0) || !statIntegerEquals(stat.gid, 0)) {
          throw new Error(`Arcane rejected an unprotected staged entry: ${relativePath}.`);
        }
        if (stat.isDirectory()) {
          if (permissionBits(stat) !== directoryMode) throw new Error(`Arcane rejected a staged directory with non-canonical permissions: ${relativePath}.`);
          actualDirectories.set(relativePath, { path: target, stat });
          visit(target, relativePath);
        } else if (stat.isFile()) {
          const expectedMode = linuxInstalledExecutablePaths.has(relativePath) ? 0o755 : 0o644;
          if (!statIntegerEquals(stat.nlink, 1) || permissionBits(stat) !== expectedMode) {
            throw new Error(`Arcane rejected a staged file with non-canonical metadata: ${relativePath}.`);
          }
          actualFiles.add(relativePath);
        } else {
          throw new Error(`Arcane rejected an unsupported staged entry: ${relativePath}.`);
        }
      }
    };
    visit(stageInfo.stageRoot, '');
    if (actualFiles.size !== topology.files.size || [...actualFiles].some((value) => !topology.files.has(value))) {
      throw new Error('Arcane rejected a staged file inventory that does not exactly match its integrity metadata.');
    }
    if (actualDirectories.size !== topology.directories.size || [...actualDirectories.keys()].some((value) => !topology.directories.has(value))) {
      throw new Error('Arcane rejected a staged directory inventory that does not exactly match its integrity metadata.');
    }
    return { stageInfo, topology, directories: actualDirectories };
  }

  async function canonicalizeStageDirectory(entryPath, expectedStat, mode) {
    const constants = ctx.fs.constants || {};
    if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
      throw new Error('Arcane requires O_NOFOLLOW and O_DIRECTORY for Linux installation staging.');
    }
    let handle = null;
    try {
      handle = await ctx.fsp.open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      const before = await handle.stat({ bigint: true });
      if (!before.isDirectory() || !sameFilesystemIdentity(before, expectedStat)) {
        throw new Error(`Arcane rejected a staged directory whose identity changed: ${entryPath}.`);
      }
      await handle.chown(0, 0);
      await handle.chmod(mode);
      const after = await handle.stat({ bigint: true });
      if (!statIntegerEquals(after.uid, 0) || !statIntegerEquals(after.gid, 0)
        || permissionBits(after) !== mode || !sameFilesystemIdentity(after, before)) {
        throw new Error(`Arcane could not canonicalize a staged directory: ${entryPath}.`);
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async function finalizeInstallStage(stage, payload) {
    const stageRoot = ctx.path.resolve(stage);
    try {
      const inspected = inspectExactStageTree(stageRoot, payload.integrity.files, 0o700, 0o700);
      const directories = [...inspected.directories.values()].sort((left, right) => right.path.length - left.path.length);
      for (const directory of directories) await canonicalizeStageDirectory(directory.path, directory.stat, 0o755);
      await canonicalizeStageDirectory(inspected.stageInfo.stageRoot, inspected.stageInfo.stat, 0o755);
      inspectExactStageTree(stageRoot, payload.integrity.files, 0o755, 0o755);
      return { finalized: true, files: inspected.topology.files.size, directories: inspected.topology.directories.size };
    } catch (error) {
      stagedInstallIntegrityByRoot.delete(stageRoot);
      throw error;
    }
  }

  function assertProtectedLinuxEntry(entryPath, stat, expectedType, expectedMode, expectedDevice) {
    const identity = canonicalFilesystemIdentity(stat);
    const isExpectedType = expectedType === 'directory' ? stat && stat.isDirectory() : stat && stat.isFile();
    const rootOwned = stat && statIntegerEquals(stat.uid, 0) && (!enforcePosixMetadata || statIntegerEquals(stat.gid, 0));
    const exactMode = stat && (enforcePosixMetadata
      ? permissionBits(stat) === expectedMode
      : (permissionBits(stat) & 0o022) === 0 && (expectedMode !== 0o755 || (permissionBits(stat) & 0o111) !== 0));
    const exactDevice = identity && (expectedDevice === undefined || identity.device === expectedDevice);
    const singleLink = expectedType === 'directory' || stat && statIntegerEquals(stat.nlink, 1);
    if (!stat || !identity || stat.isSymbolicLink() || !isExpectedType || !rootOwned || !exactMode || !exactDevice || !singleLink) {
      throw new Error(`Arcane rejected an unprotected installed ${expectedType}: ${entryPath}.`);
    }
  }

  function collectProtectedInstalledFiles(root) {
    const resolvedRoot = ctx.path.resolve(root);
    const rootStat = ctx.fs.lstatSync(resolvedRoot, { bigint: true });
    assertProtectedLinuxEntry(resolvedRoot, rootStat, 'directory', 0o755);
    const rootIdentity = canonicalFilesystemIdentity(rootStat);
    const files = [];
    const directories = [];
    let count = 0;
    const visit = (directory, relativeDirectory) => {
      const entries = ctx.fs.readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        count += 1;
        if (count > maxInstalledEntries) throw new Error('Arcane rejected an oversized installed file inventory.');
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const target = ctx.path.join(directory, entry.name);
        const stat = ctx.fs.lstatSync(target, { bigint: true });
        if (entry.isDirectory()) {
          assertProtectedLinuxEntry(target, stat, 'directory', 0o755, rootIdentity.device);
          directories.push(installedRelativePath(relativePath));
          visit(target, relativePath);
        } else if (entry.isFile()) {
          const expectedMode = linuxInstalledExecutablePaths.has(relativePath) ? 0o755 : 0o644;
          assertProtectedLinuxEntry(target, stat, 'file', expectedMode, rootIdentity.device);
          if (relativePath !== 'arcane-install.json') files.push(installedRelativePath(relativePath));
        } else {
          throw new Error(`Arcane rejected an unsupported installed entry: ${relativePath}.`);
        }
      }
    };
    visit(resolvedRoot, '');
    return { files: files.sort(), directories: directories.sort() };
  }

  function verifyProtectedInstalledInventory(root, entries) {
    const expected = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const relativePath = installedRelativePath(entry && (entry.installPath || entry.path));
      if (expected.has(relativePath)) throw new Error(`Arcane rejected a duplicate installed path: ${relativePath}.`);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) {
        throw new Error(`Arcane rejected invalid integrity metadata for ${relativePath}.`);
      }
      expected.set(relativePath, entry);
    }
    const topology = expectedInstallTopology([...expected.values()]);
    const actual = collectProtectedInstalledFiles(root);
    if (actual.files.length !== expected.size || actual.files.some((relativePath) => !expected.has(relativePath))) {
      throw new Error('Arcane rejected an installed file inventory that does not exactly match its integrity metadata.');
    }
    if (actual.directories.length !== topology.directories.size || actual.directories.some((relativePath) => !topology.directories.has(relativePath))) {
      throw new Error('Arcane rejected an installed directory inventory that does not exactly match its integrity metadata.');
    }
    for (const [relativePath, entry] of expected) {
      const target = ctx.path.resolve(root, ...relativePath.split('/'));
      const rootPrefix = `${ctx.path.resolve(root)}${ctx.path.sep}`;
      if (!target.startsWith(rootPrefix)) throw new Error(`Arcane rejected an installed path outside its root: ${relativePath}.`);
      const contents = ctx.fs.readFileSync(target);
      if (contents.length !== entry.size
        || ctx.crypto.createHash('sha256').update(contents).digest('hex').toLowerCase() !== String(entry.sha256).toLowerCase()) {
        throw new Error(`Arcane rejected modified installed content: ${relativePath}.`);
      }
    }
    return { checkedFiles: expected.size };
  }

  function readInstalledManifest(root) {
    const manifestPath = ctx.path.join(root, 'arcane-install.json');
    const rootStat = ctx.fs.lstatSync(ctx.path.resolve(root), { bigint: true });
    assertProtectedLinuxEntry(ctx.path.resolve(root), rootStat, 'directory', 0o755);
    const rootIdentity = canonicalFilesystemIdentity(rootStat);
    const stat = ctx.fs.lstatSync(manifestPath, { bigint: true });
    assertProtectedLinuxEntry(manifestPath, stat, 'file', 0o644, rootIdentity.device);
    if (statIntegerToSafeNumber(stat.size, 16 * 1024 * 1024) === null) throw new Error('Arcane rejected an oversized installed manifest.');
    const manifest = JSON.parse(ctx.fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Arcane rejected a malformed installed manifest.');
    return manifest;
  }

  function verifyUnsignedInstalledRelease(root) {
    if (!hasExactUnsignedLocalHostClaim()) {
      throw new Error('The Linux release requires explicit --allow-unsigned-local-release consent.');
    }
    const manifest = readInstalledManifest(root);
    if (manifest.version !== ctx.bundleVersion || manifest.nativeAdapter !== 'linux'
      || manifest.payloadMode !== 'linux-webkitgtk' || manifest.securityMode !== 'unsigned-local-test'
      || Object.prototype.hasOwnProperty.call(manifest, 'publisherAttestation')) {
      throw new Error('Arcane rejected inconsistent Linux unsigned-local installation metadata.');
    }
    const integrity = manifest.integrity;
    if (!integrity || integrity.schemaVersion !== 2 || integrity.hashAlgorithm !== 'sha256'
      || integrity.scope !== 'installed-tree') {
      throw new Error('Arcane rejected missing or obsolete Linux installed integrity metadata.');
    }
    verifyProtectedInstalledInventory(root, integrity.files);
    return manifest;
  }

  function verifyStagedInstallation(root, includeManifest) {
    const stageRoot = ctx.path.resolve(root);
    if (includeManifest) {
      try {
        verifyUnsignedInstalledRelease(stageRoot);
        return { verified: true, securityMode: 'unsigned-local-test' };
      } finally {
        stagedInstallIntegrityByRoot.delete(stageRoot);
      }
    }
    if (!hasExactUnsignedLocalHostClaim()) {
      throw new Error('The Linux release requires explicit --allow-unsigned-local-release consent before installation.');
    }
    const stagedInstallIntegrity = stagedInstallIntegrityByRoot.get(stageRoot);
    if (!stagedInstallIntegrity) throw new Error('Arcane cannot bind this Linux stage to a verified release inventory.');
    try {
      const result = verifyProtectedInstalledInventory(stageRoot, stagedInstallIntegrity);
      return { verified: true, securityMode: 'unsigned-local-test', ...result };
    } catch (error) {
      stagedInstallIntegrityByRoot.delete(stageRoot);
      throw error;
    }
  }

  function createPublisherAttestation(root) {
    try {
      verifyStagedInstallation(root, false);
      if (ctx.fs.existsSync(paths.installRoot)) {
        try { verifyUnsignedInstalledRelease(paths.installRoot); }
        catch (_) {
          throw new Error('Arcane refused to replace an installation that is not the same explicitly allowed unsigned-local security mode.');
        }
      }
      return null;
    } finally {
      stagedInstallIntegrityByRoot.delete(ctx.path.resolve(root));
    }
  }

  function activeUnsignedHostReleaseVerified() {
    if (!hasExactUnsignedLocalHostClaim()) return false;
    if (ctx.simulate && !ctx.processPkg) return true;
    const executable = String(process.execPath || '');
    if (!ctx.path.isAbsolute(executable)) return false;
    const executableDirectory = ctx.path.dirname(executable);
    const releaseManifest = ctx.path.join(executableDirectory, 'arcane-release.json');
    if (ctx.fs.existsSync(releaseManifest)) {
      try {
        const payload = installPayload(executableDirectory);
        return payload.releaseReady === true && payload.verified === true && payload.securityMode === 'unsigned-local-test';
      } catch (_) {
        return false;
      }
    }
    const installedRoot = ctx.path.dirname(executableDirectory);
    try {
      verifyUnsignedInstalledRelease(installedRoot);
      return true;
    } catch (_) {
      return false;
    }
  }

  function hostReleaseSecurityMode() {
    return activeUnsignedHostReleaseVerified() ? 'unsigned-local-test' : 'unverified';
  }

  function hostReleaseSecurityEvidence() {
    return {
      securityMode: hostReleaseSecurityMode(),
      publisherTrustSource: null,
      revocationStatus: null,
    };
  }

  async function listInstalledApplications() {
    const securityMode = ctx.simulate ? hostReleaseSecurityMode() : releaseSecurityMode();
    if (securityMode !== 'unsigned-local-test') {
      throw ctx.arcaneError(
        'APPLICATION_CATALOG_UNVERIFIED',
        'Arcane could not verify the installed Linux application catalog.',
        'Repair or reinstall Arcane OS from the explicitly authorized Linux release, then retry.',
        409
      );
    }
    return {
      verified: true,
      securityMode,
      publisherTrustSource: null,
      revocationStatus: null,
      applications: [],
    };
  }

  function releaseSecurityMode() {
    verifyUnsignedInstalledRelease(paths.installRoot);
    return 'unsigned-local-test';
  }

  function linuxSessionEntry() {
    return `[Desktop Entry]
Type=Application
Name=Arcane OS
Comment=Start Arcane Shell as the authenticated Linux desktop session
Exec=${ctx.path.join(paths.installRoot, 'bin', 'arcane-session')}
TryExec=${ctx.path.join(paths.installRoot, 'bin', 'arcane-session')}
DesktopNames=Arcane;
`;
  }

  function readSystemdDefaultTarget(systemctl) {
    const result = ctx.boundedSpawnSync(systemctl, ['get-default'], { timeout: 10000 });
    const target = String(result && result.stdout || '').trim();
    if (!result || result.status !== 0 || !/^[A-Za-z0-9_.@-]+\.target$/.test(target)) {
      throw ctx.arcaneError(
        'LINUX_SYSTEMD_DEFAULT_TARGET_UNAVAILABLE',
        'Arcane could not verify the Linux systemd default target.',
        'Confirm that systemd is the active service manager, then run systemctl get-default as an administrator.',
        409,
        { status: result && Number.isInteger(result.status) ? result.status : null }
      );
    }
    return target;
  }

  function isWindowsSubsystemForLinux() {
    return ['/proc/sys/kernel/osrelease', '/proc/version'].some((marker) => {
      try { return /(?:microsoft|wsl)/i.test(ctx.fs.readFileSync(marker, 'utf8')); }
      catch (_) { return false; }
    });
  }

  function systemdUnitProperty(systemctl, unit, property) {
    const result = ctx.boundedSpawnSync(systemctl, ['show', `--property=${property}`, '--value', unit], { timeout: 10000 });
    return {
      status: result && Number.isInteger(result.status) ? result.status : null,
      value: String(result && result.stdout || '').trim(),
    };
  }

  function assertInstalledLinuxSession() {
    const expected = [
      { path: ctx.path.join(paths.installRoot, 'bin', 'arcane-session'), contents: null, executable: true },
      { path: '/usr/share/xsessions/arcane-os.desktop', contents: linuxSessionEntry(), executable: false },
    ];
    for (const item of expected) {
      let stat = null;
      try { stat = ctx.fs.lstatSync(item.path); } catch (_) {}
      const contentsMatch = item.contents === null || (stat && ctx.fs.readFileSync(item.path, 'utf8') === item.contents);
      const rootOwned = stat && (typeof stat.uid !== 'number' || stat.uid === 0);
      const protectedMode = stat && (stat.mode & 0o022) === 0;
      const executable = stat && (!item.executable || (stat.mode & 0o111) !== 0);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || !contentsMatch || !rootOwned || !protectedMode || !executable) {
        throw ctx.arcaneError(
          'LINUX_DESKTOP_SESSION_UNVERIFIED',
          'Arcane refused to change the Linux boot target because its display-manager session is not securely installed.',
          'Repair the verified Arcane installation and its /usr/share/xsessions/arcane-os.desktop entry, then retry.',
          409,
          { path: item.path }
        );
      }
    }
  }

  async function configureGraphicalTarget(action, policy) {
    const target = 'graphical.target';
    if (!policy || policy.defaultTarget !== target || policy.sessionType !== 'x11') {
      throw ctx.arcaneError(
        'LINUX_GRAPHICAL_POLICY_INVALID',
        'The Arcane release does not contain the expected Linux graphical-session policy.',
        'Use a complete publisher-verified Arcane release and retry.',
        409
      );
    }
    if (ctx.simulate) {
      ctx.actionLog(action, 'info', `Simulation: would set the Linux systemd default target to ${target}.`);
      return { policyVersion: 1, target, previousTarget: null, changed: false, applicable: true, sessionType: 'x11', verification: 'simulated' };
    }
    if (!isElevated()) {
      throw ctx.arcaneError(
        'ROOT_REQUIRED',
        'Arcane must be running in a separately authorized root session to configure the Linux boot target.',
        'Restart the verified Arcane Provisioner from an administrator-authorized root session.',
        403
      );
    }
    if (isWindowsSubsystemForLinux()) {
      ctx.actionLog(action, 'info', 'WSLg launches graphical applications without a Linux display manager; Arcane left the WSL boot target unchanged.');
      return {
        policyVersion: 1,
        target: null,
        previousTarget: null,
        changed: false,
        applicable: false,
        reason: 'wsl',
        sessionType: 'manual-wslg',
        verification: 'not-applicable',
      };
    }
    let initProcess = null;
    try { initProcess = String(ctx.fs.readFileSync('/proc/1/comm', 'utf8')).trim(); } catch (_) {}
    if (initProcess !== 'systemd') {
      throw ctx.arcaneError(
        'SYSTEMD_NOT_ACTIVE',
        'Arcane found that systemd is not the active Linux service manager.',
        'Boot this Linux installation with systemd as PID 1 before enabling Arcane as a graphical session.',
        409,
        { initProcess }
      );
    }
    const systemctl = requiredProtectedExecutable(
      'systemctl',
      'Linux systemctl executable',
      'SYSTEMD_REQUIRED',
      'Arcane could not find systemctl on this Linux machine.',
      'Install and enable systemd before installing Arcane as the graphical operating environment.'
    );
    const targetLoadState = systemdUnitProperty(systemctl, target, 'LoadState');
    if (targetLoadState.status !== 0 || targetLoadState.value !== 'loaded') {
      throw ctx.arcaneError(
        'LINUX_GRAPHICAL_TARGET_UNAVAILABLE',
        'This systemd installation does not provide a loaded graphical.target.',
        'Install the distribution\u2019s graphical-session packages, then retry.',
        409,
        { loadState: targetLoadState.value, status: targetLoadState.status }
      );
    }
    const displayManagerLoadState = systemdUnitProperty(systemctl, 'display-manager.service', 'LoadState');
    const displayManagerEnabled = ctx.boundedSpawnSync(systemctl, ['is-enabled', 'display-manager.service'], { timeout: 10000 });
    const displayManagerEnablement = String(displayManagerEnabled && displayManagerEnabled.stdout || '').trim();
    if (
      displayManagerLoadState.status !== 0
      || displayManagerLoadState.value !== 'loaded'
      || !displayManagerEnabled
      || displayManagerEnabled.status !== 0
      || !/^(?:enabled|static|alias|indirect|generated)$/.test(displayManagerEnablement)
    ) {
      throw ctx.arcaneError(
        'LINUX_DISPLAY_MANAGER_REQUIRED',
        'Arcane could not verify an installed and enabled Linux display manager.',
        'Install and enable the distribution\u2019s display manager before selecting Arcane OS as a login session.',
        409,
        { loadState: displayManagerLoadState.value, enablement: displayManagerEnablement }
      );
    }
    assertInstalledLinuxSession();
    const previousTarget = readSystemdDefaultTarget(systemctl);
    try {
      await ctx.run(systemctl, ['set-default', target], { action });
      const verifiedTarget = readSystemdDefaultTarget(systemctl);
      if (verifiedTarget !== target) {
        throw ctx.arcaneError(
          'LINUX_GRAPHICAL_TARGET_VERIFY_FAILED',
          `Linux reported ${verifiedTarget} after Arcane requested ${target}.`,
          `Restore the previous target with systemctl set-default ${previousTarget}, then inspect the systemd configuration.`,
          409,
          { previousTarget, target, verifiedTarget }
        );
      }
      ctx.actionLog(action, 'info', `Linux systemd will use ${target} as its default boot target.`, {
        previousTarget,
        changed: previousTarget !== target,
      });
      return {
        policyVersion: 1,
        target,
        previousTarget,
        changed: previousTarget !== target,
        applicable: true,
        sessionType: 'x11',
        mechanism: systemctl,
        verification: 'verified',
      };
    } catch (error) {
      let restored = false;
      try {
        await ctx.run(systemctl, ['set-default', previousTarget], { action });
        restored = readSystemdDefaultTarget(systemctl) === previousTarget;
      } catch (_) {}
      if (error && error.code === 'LINUX_GRAPHICAL_TARGET_VERIFY_FAILED') {
        error.restoredPreviousTarget = restored;
        throw error;
      }
      throw ctx.arcaneError(
        'LINUX_GRAPHICAL_TARGET_SET_FAILED',
        'Linux did not accept Arcane\u2019s requested graphical systemd target.',
        `The prior ${previousTarget} target ${restored ? 'was restored' : 'could not be verified as restored'}. Review systemd as an administrator before retrying.`,
        409,
        { previousTarget, target, restoredPreviousTarget: restored, causeCode: error && error.code || null }
      );
    }
  }

  async function rollbackGraphicalTarget(configuration, action) {
    if (!configuration || !configuration.changed) return { restored: false, reason: 'unchanged' };
    const previousTarget = String(configuration.previousTarget || '');
    if (!/^[A-Za-z0-9_.@-]+\.target$/.test(previousTarget)) {
      throw ctx.arcaneError('LINUX_GRAPHICAL_ROLLBACK_INVALID', 'Arcane cannot validate the recorded prior Linux boot target.', 'Restore the prior systemd target manually as an administrator.', 409);
    }
    if (!isElevated()) {
      throw ctx.arcaneError('LINUX_GRAPHICAL_ROLLBACK_UNAVAILABLE', 'Arcane cannot restore the prior Linux boot target from this process.', `Run systemctl set-default ${previousTarget} from a root session.`, 409);
    }
    const systemctl = requiredProtectedExecutable(
      'systemctl',
      'Linux systemctl executable',
      'LINUX_GRAPHICAL_ROLLBACK_UNAVAILABLE',
      'Arcane cannot find systemctl to restore the prior Linux boot target.',
      `Install systemd or run systemctl set-default ${previousTarget} manually from a verified root session.`
    );
    await ctx.run(systemctl, ['set-default', previousTarget], { action });
    const restored = readSystemdDefaultTarget(systemctl) === previousTarget;
    if (!restored) throw ctx.arcaneError('LINUX_GRAPHICAL_ROLLBACK_FAILED', 'Linux did not restore the prior systemd target.', `Run systemctl set-default ${previousTarget} from a root session.`, 409);
    return { restored: true, target: previousTarget };
  }

  function preservePlatformConfiguration(configuration) {
    const linux = configuration && configuration.linux;
    if (!linux || linux.policyVersion !== 1 || typeof linux.applicable !== 'boolean') return null;
    if (linux.applicable) {
      if (
        linux.target !== 'graphical.target'
        || linux.sessionType !== 'x11'
        || !/^[A-Za-z0-9_.@-]+\.target$/.test(String(linux.previousTarget || ''))
        || typeof linux.changed !== 'boolean'
        || linux.verification !== 'verified'
      ) return null;
    } else if (linux.reason !== 'wsl' || linux.sessionType !== 'manual-wslg' || linux.verification !== 'not-applicable') {
      return null;
    }
    return { linux: { ...linux } };
  }

  async function applyInstallPermissions(action) {
    let sessionEntryCreated = false;
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
      const desktopDatabaseUpdater = executableCommand('update-desktop-database');
      if (desktopDatabaseUpdater) await ctx.run(desktopDatabaseUpdater, ['/usr/share/applications'], { action, allowFailure: true });
      if (!isWindowsSubsystemForLinux()) {
        const sessionEntryPath = '/usr/share/xsessions/arcane-os.desktop';
        const expectedSessionEntry = linuxSessionEntry();
        await ctx.ensureDir('/usr/share/xsessions');
        if (ctx.fs.existsSync(sessionEntryPath)) {
          if (ctx.fs.readFileSync(sessionEntryPath, 'utf8') !== expectedSessionEntry) {
            throw ctx.arcaneError(
              'LINUX_SESSION_ENTRY_CONFLICT',
              'Arcane found a different Linux display-manager session registered under its name.',
              'Review /usr/share/xsessions/arcane-os.desktop as an administrator before retrying.',
              409
            );
          }
        } else {
          await ctx.writeFile(sessionEntryPath, expectedSessionEntry, 0o644);
          sessionEntryCreated = true;
        }
        assertInstalledLinuxSession();
      }
    }
    return { sessionEntryCreated };
  }

  async function rollbackInstallIntegration(integration) {
    if (!integration || !integration.sessionEntryCreated || ctx.simulate) return;
    const sessionEntryPath = '/usr/share/xsessions/arcane-os.desktop';
    try {
      if (ctx.fs.readFileSync(sessionEntryPath, 'utf8') === linuxSessionEntry()) await ctx.fsp.rm(sessionEntryPath, { force: true });
    } catch (_) {}
  }

  function assertProtectedStateEntry(file, expectedType) {
    let stat = null;
    try { stat = ctx.fs.lstatSync(file); } catch (_) {}
    const expected = expectedType === 'directory'
      ? stat && stat.isDirectory()
      : stat && stat.isFile() && stat.nlink === 1;
    if (!stat || !expected || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      const directory = expectedType === 'directory';
      throw ctx.arcaneError(
        directory ? 'LINUX_STATE_ROOT_UNSAFE' : 'LINUX_STATE_FILE_UNSAFE',
        `Arcane refused to use an unprotected Linux provisioning-state ${expectedType}.`,
        directory
          ? `Restore ${file} as a root-owned directory that is not writable by group or other users, then retry.`
          : `Restore ${file} as one root-owned regular file, then retry.`,
        409,
        { path: file }
      );
    }
    return stat;
  }

  async function chmodProtectedStateEntry(file, expectedType, expectedStat, mode) {
    const constants = ctx.fs.constants || {};
    if (!Number.isInteger(constants.O_RDONLY) || !Number.isInteger(constants.O_NOFOLLOW)
      || (expectedType === 'directory' && !Number.isInteger(constants.O_DIRECTORY))) {
      throw ctx.arcaneError(
        'LINUX_STATE_PERMISSION_GUARD_UNAVAILABLE',
        'Arcane cannot safely change Linux provisioning-state permissions on this host.',
        'Use a Linux filesystem and Node.js runtime that support O_NOFOLLOW and O_DIRECTORY, then retry.',
        409,
        { path: file }
      );
    }
    const parentChain = protectedDirectoryChain(ctx.path.dirname(file));
    if (!parentChain) {
      throw ctx.arcaneError(
        'LINUX_STATE_PARENT_UNSAFE',
        'Arcane refused a Linux provisioning-state path with an unprotected parent directory.',
        `Restore the root-owned parent directories for ${file}, then retry.`,
        409,
        { path: file }
      );
    }
    let handle = null;
    try {
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW
        | (expectedType === 'directory' ? constants.O_DIRECTORY : (constants.O_NONBLOCK || 0))
        | (constants.O_CLOEXEC || 0);
      handle = await ctx.fsp.open(file, flags);
      const before = await handle.stat();
      const sameIdentity = before.dev === expectedStat.dev && before.ino === expectedStat.ino;
      const expected = expectedType === 'directory'
        ? before.isDirectory()
        : before.isFile() && before.nlink === 1;
      if (!sameIdentity || !expected || before.uid !== 0 || (before.mode & 0o022) !== 0
        || !protectedDirectoryChainUnchanged(parentChain)) {
        throw ctx.arcaneError(
          'LINUX_STATE_ENTRY_CHANGED',
          'The Linux provisioning-state path changed while Arcane was securing it.',
          `Review ${file} as an administrator, then retry. Arcane made no further state change.`,
          409,
          { path: file }
        );
      }
      await handle.chmod(mode);
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== 0
        || (after.mode & 0o7777) !== mode
        || (expectedType === 'directory' ? !after.isDirectory() : !after.isFile() || after.nlink !== 1)) {
        throw ctx.arcaneError(
          'LINUX_STATE_PERMISSION_VERIFY_FAILED',
          'Linux did not retain the protected Arcane provisioning-state permissions.',
          `Review ${file} as an administrator before retrying.`,
          409,
          { path: file, expectedMode: mode.toString(8) }
        );
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    if (!protectedDirectoryChainUnchanged(parentChain)) {
      throw ctx.arcaneError(
        'LINUX_STATE_PARENT_CHANGED',
        'A Linux provisioning-state parent directory changed while Arcane was securing state.',
        `Review the root-owned parent directories for ${file}, then retry.`,
        409,
        { path: file }
      );
    }
  }

  async function applyStatePermissions(action) {
    requireRootUserMutation();
    if (ctx.simulate) return;
    const stateParent = ctx.path.dirname(paths.stateRoot);
    const stateParentChain = protectedDirectoryChain(stateParent);
    if (!stateParentChain) {
      throw ctx.arcaneError(
        'LINUX_STATE_PARENT_UNSAFE',
        'Arcane refused to use an unprotected Linux provisioning-state parent directory.',
        `Restore ${stateParent} and its parent directories as root-owned directories that are not writable by group or other users, then retry.`,
        409,
        { path: stateParent }
      );
    }
    if (!ctx.fs.existsSync(paths.stateRoot)) {
      try { await ctx.fsp.mkdir(paths.stateRoot, { recursive: false, mode: 0o755 }); }
      catch (error) { if (!error || error.code !== 'EEXIST') throw error; }
    }
    if (!protectedDirectoryChainUnchanged(stateParentChain)) {
      throw ctx.arcaneError(
        'LINUX_STATE_PARENT_CHANGED',
        'The Linux provisioning-state parent directory changed while Arcane was preparing state.',
        `Review ${stateParent} as an administrator, then retry.`,
        409,
        { path: stateParent }
      );
    }
    const rootStat = assertProtectedStateEntry(paths.stateRoot, 'directory');
    await chmodProtectedStateEntry(paths.stateRoot, 'directory', rootStat, 0o755);
    for (const name of ['users.json', 'users.json.previous', 'install.json']) {
      const file = ctx.path.join(paths.stateRoot, name);
      if (!ctx.fs.existsSync(file)) continue;
      const stat = assertProtectedStateEntry(file, 'file');
      await chmodProtectedStateEntry(file, 'file', stat, 0o600);
    }
  }

  function shellCommand() {
    const logicalPath = ctx.simulate && ctx.hostPlatform !== 'linux' && ctx.path.posix
      ? ctx.path.posix
      : ctx.path;
    return logicalPath.join(paths.installRoot.replaceAll('\\', '/'), 'bin', 'arcane-shell');
  }

  function requireRootUserMutation() {
    if (ctx.simulate) return;
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      throw ctx.arcaneError(
        'ROOT_REQUIRED',
        'Arcane must be running in a separately authorized root session to change Linux accounts.',
        'Restart the verified Arcane Provisioner from an administrator-authorized root session.',
        403
      );
    }
  }

  function assertProtectedRegularFile(file, label) {
    let stat = null;
    try { stat = ctx.fs.lstatSync(file); } catch (_) {}
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
      throw ctx.arcaneError(
        'LINUX_PROTECTED_FILE_UNSAFE',
        `Arcane refused to use an unprotected ${label}.`,
        `Restore ${file} as one root-owned regular file that is not writable by group or other users, then retry.`,
        409,
        { path: file }
      );
    }
    return stat;
  }

  function requiredAccountCommand(name) {
    return requiredProtectedExecutable(
      name,
      `Linux ${name} account tool`,
      'LINUX_ACCOUNT_TOOL_REQUIRED',
      `Arcane could not find the Linux ${name} account tool.`,
      'Install the distribution account-management utilities, then retry.'
    );
  }

  function readProtectedTextFile(file, label, maximumBytes) {
    const stat = assertProtectedRegularFile(file, label);
    if (stat.size > maximumBytes) {
      throw ctx.arcaneError('LINUX_PROTECTED_FILE_TOO_LARGE', `Arcane refused an oversized ${label}.`, `Review ${file} as an administrator, then retry.`, 409, { path: file });
    }
    return ctx.fs.readFileSync(file, 'utf8');
  }

  function localPasswdRecords() {
    if (ctx.simulate) return [];
    const records = [];
    const passwd = readProtectedTextFile('/etc/passwd', 'Linux account database', 4 * 1024 * 1024);
    for (const line of passwd.split(/\r?\n/)) {
      if (!line) continue;
      const fields = line.split(':');
      if (fields.length < 7) continue;
      const uid = Number(fields[2]);
      if (!Number.isSafeInteger(uid) || uid < 0) continue;
      records.push({ username: fields[0], uid, gid: Number(fields[3]), profile: fields[5] || null, shell: fields[6] || null });
    }
    return records;
  }

  function regularUidRange() {
    let minimum = 1000;
    let maximum = 60000;
    if (!ctx.simulate && ctx.fs.existsSync('/etc/login.defs')) {
      const contents = readProtectedTextFile('/etc/login.defs', 'Linux login policy', 1024 * 1024);
      const minimumMatch = /^\s*UID_MIN\s+(\d+)\s*(?:#.*)?$/m.exec(contents);
      const maximumMatch = /^\s*UID_MAX\s+(\d+)\s*(?:#.*)?$/m.exec(contents);
      if (minimumMatch) minimum = Number(minimumMatch[1]);
      if (maximumMatch) maximum = Number(maximumMatch[1]);
    }
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 1 || maximum < minimum) {
      throw ctx.arcaneError('LINUX_UID_POLICY_INVALID', 'Arcane could not validate the Linux regular-user UID range.', 'Repair /etc/login.defs before provisioning Arcane users.', 409);
    }
    return { minimum, maximum };
  }

  function administrativeGroups(username) {
    if (ctx.simulate) return [];
    const id = requiredProtectedExecutable(
      'id',
      'Linux identity tool',
      'LINUX_IDENTITY_TOOL_REQUIRED',
      'Arcane could not find the Linux identity tool.',
      'Install the distribution account-management utilities, then retry.'
    );
    const result = ctx.boundedSpawnSync(id, ['-nG', username], { timeout: 10000 });
    if (!result || result.status !== 0) throw ctx.arcaneError('LINUX_IDENTITY_UNAVAILABLE', `Arcane could not verify the Linux groups for “${username}”.`, 'Confirm that this is a local standard account, then retry.', 409);
    const privileged = new Set(['root', 'sudo', 'wheel', 'admin']);
    return String(result.stdout || '').trim().split(/\s+/).filter((group) => privileged.has(group));
  }

  function validateLocalHome(record) {
    const home = String(record && record.profile || '');
    if (!home || !ctx.path.posix.isAbsolute(home) || ctx.path.posix.normalize(home) !== home || home === '/' || home.includes('\0')) {
      throw ctx.arcaneError('LINUX_USER_HOME_UNSAFE', `Arcane refused the unsafe home directory recorded for “${record.username}”.`, 'Assign the account one absolute, normalized local home directory before retrying.', 409);
    }
    let stat = null;
    try { stat = ctx.fs.lstatSync(home); } catch (_) {}
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== record.uid) {
      throw ctx.arcaneError('LINUX_USER_HOME_UNSAFE', `Arcane could not verify the local home directory for “${record.username}”.`, 'Create a real directory owned by that exact account UID, then retry.', 409, { profile: home, uid: record.uid });
    }
  }

  function assertStandardLocalAccount(username, options) {
    const opts = options || {};
    const record = passwdRecord(username);
    if (!record) throw ctx.arcaneError('USER_NOT_FOUND', `The local Linux account “${username}” does not exist.`, 'Create the local account or let Arcane create it, then retry.', 404);
    if (Number.isSafeInteger(opts.expectedUid) && record.uid !== opts.expectedUid) {
      throw ctx.arcaneError('LINUX_ACCOUNT_IDENTITY_CHANGED', `Arcane refused to change “${username}” because its UID changed.`, 'Review the account manually. Arcane made no further account change.', 409, { expectedUid: opts.expectedUid, actualUid: record.uid });
    }
    const duplicates = localPasswdRecords().filter((item) => item.uid === record.uid);
    if (duplicates.length !== 1 || duplicates[0].username !== username) {
      throw ctx.arcaneError('LINUX_ACCOUNT_IDENTITY_AMBIGUOUS', `Arcane found an ambiguous UID for “${username}”.`, 'Give every local account a unique UID before retrying.', 409, { uid: record.uid });
    }
    const range = regularUidRange();
    if (record.uid < range.minimum || record.uid > range.maximum) {
      throw ctx.arcaneError('LINUX_STANDARD_USER_REQUIRED', `“${username}” is a Linux system or service identity, not a standard local user.`, `Choose a local account with a UID from ${range.minimum} through ${range.maximum}.`, 409, { uid: record.uid, uidRange: range });
    }
    const protectedMatch = protectedUsernames().find((item) => item.toLowerCase() === username.toLowerCase());
    if (protectedMatch && !opts.allowProtected) {
      throw ctx.arcaneError('CURRENT_USER_PROTECTED', `The provisioning account “${protectedMatch}” is protected.`, 'Choose a different standard local account.', 409);
    }
    const shell = String(record.shell || '');
    const disabledShell = shell === '/usr/sbin/nologin' || shell === '/sbin/nologin' || shell === '/bin/false';
    if (!ctx.path.posix.isAbsolute(shell) || shell.includes('\0') || (disabledShell && !opts.allowDisabledShell)) {
      throw ctx.arcaneError('LINUX_STANDARD_USER_REQUIRED', `“${username}” does not have a usable standard Linux login shell.`, 'Assign a normal local shell before retrying.', 409, { shell });
    }
    const adminGroups = administrativeGroups(username);
    if (adminGroups.length && !opts.allowPrivilegedGroups) {
      throw ctx.arcaneError('ADMIN_USER_PROTECTED', `Arcane will not replace the login shell of privileged Linux account “${username}”.`, 'Choose a standard account that is not in root, sudo, wheel, or admin.', 409, { groups: adminGroups });
    }
    validateLocalHome(record);
    return record;
  }

  function shadowRecord(username) {
    requireRootUserMutation();
    if (ctx.simulate) return null;
    const shadow = readProtectedTextFile('/etc/shadow', 'Linux password database', 4 * 1024 * 1024);
    const matches = shadow.split(/\r?\n/).filter((line) => line.split(':', 1)[0] === username);
    if (matches.length !== 1) throw ctx.arcaneError('LINUX_PASSWORD_STATE_UNAVAILABLE', `Arcane could not verify the password state for “${username}”.`, 'Repair the local account database before retrying.', 409);
    const fields = matches[0].split(':');
    return {
      password: fields[1] || '',
      lastChangedDay: fields[2] === '' ? null : Number(fields[2]),
      expiresDay: fields[7] === '' ? null : Number(fields[7]),
    };
  }

  function shadowState(username) {
    const record = shadowRecord(username);
    const today = Math.floor(Date.now() / 86400000);
    const locked = !record.password || /^[!*]/.test(record.password);
    const expired = Number.isSafeInteger(record.expiresDay) && record.expiresDay <= today;
    return { ...record, locked, expired, enabled: !locked && !expired };
  }

  function assertInstalledUserShell() {
    if (ctx.simulate) return shellCommand();
    const shell = shellCommand();
    const stat = assertProtectedRegularFile(shell, 'installed Arcane login-shell launcher');
    if ((stat.mode & 0o111) === 0) {
      throw ctx.arcaneError('ARCANE_SHELL_MISSING', 'The installed Arcane login-shell launcher is not executable.', 'Repair the verified Arcane installation, then retry.', 409);
    }
    verifyUnsignedInstalledRelease(paths.installRoot);
    return shell;
  }

  async function ensureShellRegistered(shell) {
    if (ctx.simulate) return { registered: true, changed: false };
    requireRootUserMutation();
    const shellsPath = '/etc/shells';
    const originalStat = assertProtectedRegularFile(shellsPath, 'Linux login-shell registry');
    if (originalStat.size > 1024 * 1024) throw ctx.arcaneError('LINUX_SHELL_REGISTRY_INVALID', 'Arcane refused an oversized Linux login-shell registry.', 'Review /etc/shells as an administrator, then retry.', 409);
    const original = ctx.fs.readFileSync(shellsPath, 'utf8');
    if (original.includes('\0')) throw ctx.arcaneError('LINUX_SHELL_REGISTRY_INVALID', 'Arcane found invalid data in the Linux login-shell registry.', 'Repair /etc/shells before retrying.', 409);
    if (original.split(/\r?\n/).includes(shell)) return { registered: true, changed: false };
    const prefix = original.length && !/\r?\n$/.test(original) ? '\n' : '';
    let handle = null;
    try {
      const flags = ctx.fs.constants.O_WRONLY
        | ctx.fs.constants.O_APPEND
        | ctx.fs.constants.O_NOFOLLOW
        | (ctx.fs.constants.O_CLOEXEC || 0);
      handle = await ctx.fsp.open(shellsPath, flags);
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.uid !== 0 || openedStat.nlink !== 1 || (openedStat.mode & 0o022) !== 0
        || openedStat.dev !== originalStat.dev || openedStat.ino !== originalStat.ino) {
        throw ctx.arcaneError('LINUX_SHELL_REGISTRY_CHANGED', 'The Linux login-shell registry changed during Arcane provisioning.', 'Review /etc/shells and retry. Arcane made no shell-registry change.', 409);
      }
      await handle.writeFile(`${prefix}${shell}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      const installed = readProtectedTextFile(shellsPath, 'Linux login-shell registry', 1024 * 1024);
      if (!installed.split(/\r?\n/).includes(shell)) throw new Error('Linux did not retain the Arcane shell registration.');
      return { registered: true, changed: true };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
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
    const reserved = ['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', '_apt', 'nobody'];
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
    return Boolean(passwdRecord(username));
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
    const matches = localPasswdRecords().filter((record) => record.username === username);
    if (matches.length > 1) throw ctx.arcaneError('LINUX_ACCOUNT_IDENTITY_AMBIGUOUS', `Arcane found duplicate local account records for “${username}”.`, 'Repair /etc/passwd before retrying.', 409);
    return matches[0] || null;
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
        enabled: !simulatedDisabledAccounts.has(username.toLowerCase()),
        profile: `/home/${username}`,
        verification: 'simulated',
        source: 'native-linux',
      }));
    }
    const users = [];
    for (const record of localPasswdRecords()) {
      const { username, uid, profile: home, shell } = record;
      const assigned = shell === expectedShell;
      if (!assigned && !recorded.has(username)) continue;
      let enabled = null;
      if (isElevated()) {
        try { enabled = shadowState(username).enabled; } catch (_) { enabled = null; }
      }
      users.push({
        username,
        uid,
        enabled,
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
    if (existing && !ctx.simulate) assertStandardLocalAccount(username);
    return {
      username,
      accountExisted: Boolean(existing),
      previousShell: existing && existing.shell || defaultLoginShell(),
      previousShellPresent: true,
      shellBindingVersion: 1,
      assignmentMode: 'linux-login-shell',
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
    if (!shellBackup || Boolean(shellBackup.accountExisted) !== exists || !shellBackup.previousShellPresent || shellBackup.previousShell !== previousShell
      || (exists && shellBackup.uid !== existing.uid) || (exists && shellBackup.profile !== existing.profile)) {
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
      if (!exists) simulatedDisabledAccounts.add(key);
      return { username, created: !exists, uid: 1000, profile: `/home/${username}`, shell, enabled: exists, activationPending: !exists, previousShell, previousShellPresent: true, shellBindingVersion: 1, assignmentMode: 'linux-login-shell' };
    }
    requireRootUserMutation();
    assertInstalledUserShell();
    await ensureShellRegistered(shell);
    let created = false;
    let createdUid = null;
    let shellChanged = false;
    try {
      let account = existing;
      if (exists) {
        account = assertStandardLocalAccount(username, { expectedUid: existing.uid });
        const status = shadowState(username);
        if (!status.enabled) {
          throw ctx.arcaneError('LINUX_ACTIVE_USER_REQUIRED', `“${username}” is locked or expired.`, 'Activate the existing standard account before assigning Arcane as its login shell.', 409);
        }
      } else {
        const nologin = ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false'].find((candidate) => ctx.fs.existsSync(candidate));
        if (!nologin) throw ctx.arcaneError('LINUX_NOLOGIN_REQUIRED', 'Arcane could not find a disabled login shell for staging a new account.', 'Install the distribution account-management utilities, then retry.', 409);
        await ctx.run(requiredAccountCommand('useradd'), ['-m', '-e', '1970-01-02', '-s', nologin, username], { action });
        created = true;
        const stagedRecord = passwdRecord(username);
        createdUid = stagedRecord && stagedRecord.uid;
        account = assertStandardLocalAccount(username, { allowDisabledShell: true });
        await ctx.run(requiredAccountCommand('chpasswd'), [], {
          action,
          input: `${username}:${password}\n`,
          displayCommand: '$ chpasswd [protected Arcane staged-account credential]',
          suppressRawStdout: true,
          suppressRawStderr: true,
        });
        await ctx.run(requiredAccountCommand('usermod'), ['-L', username], { action });
        await ctx.run(requiredAccountCommand('chage'), ['-d', '0', username], { action });
        const stagedState = shadowState(username);
        if (!stagedState.locked || !stagedState.expired || stagedState.lastChangedDay !== 0) {
          throw ctx.arcaneError('LINUX_STAGED_ACCOUNT_UNSAFE', `Linux did not retain the locked and expired state for “${username}”.`, 'Arcane will remove or disable this incomplete account. Review the diagnostics before retrying.', 409);
        }
      }
      await ctx.run(requiredAccountCommand('usermod'), ['-s', shell, username], { action });
      shellChanged = true;
      const verified = assertStandardLocalAccount(username, { expectedUid: account.uid });
      if (verified.shell !== shell) {
        throw ctx.arcaneError(
          'LINUX_SHELL_ASSIGNMENT_FAILED',
          `Linux did not retain the Arcane shell assignment for “${username}”.`,
          'Confirm the account is signed out and Arcane has root authorization, then retry.'
        );
      }
      if (created) {
        const stagedState = shadowState(username);
        if (!stagedState.locked || !stagedState.expired) throw ctx.arcaneError('LINUX_STAGED_ACCOUNT_UNSAFE', `The staged Linux account “${username}” became active before credential delivery.`, 'Arcane will disable or remove the incomplete account.', 409);
      }
      return {
        username,
        created,
        uid: verified.uid,
        profile: verified.profile,
        shell,
        enabled: !created,
        activationPending: created,
        previousShell,
        previousShellPresent: true,
        shellBindingVersion: 1,
        assignmentMode: 'linux-login-shell',
      };
    } catch (error) {
      if (created) {
        try {
          error.accountRollback = await rollbackCreatedUser(username, { username, created: true, uid: createdUid, shell }, action);
          error.accountRollback.createdByThisAttempt = true;
        } catch (rollbackError) {
          error.accountRollback = {
            createdByThisAttempt: true,
            uid: createdUid,
            accountDisabled: false,
            accountRemoved: false,
            cleanupErrors: [String(rollbackError && rollbackError.message || rollbackError)],
          };
        }
      } else if (shellChanged) {
        try {
          const current = passwdRecord(username);
          if (!current || current.uid !== existing.uid || current.shell !== shell) throw new Error('The account identity or assigned shell changed before rollback.');
          await ctx.run(requiredAccountCommand('usermod'), ['-s', previousShell, username], { action });
          const restored = passwdRecord(username);
          if (!restored || restored.uid !== existing.uid || restored.shell !== previousShell) throw new Error('Linux did not retain the previous shell during rollback.');
          error.shellRollback = { restored: true, uid: existing.uid, shell: previousShell };
        } catch (rollbackError) {
          error.shellRollback = { restored: false, uid: existing.uid, error: String(rollbackError && rollbackError.message || rollbackError) };
        }
      }
      for (const key of ['message', 'stdout', 'stderr']) {
        if (error && error[key]) error[key] = String(error[key]).split(password).join('[redacted]');
      }
      if (error && error.code === 'COMMAND_FAILED') error.code = 'LINUX_USER_PROVISION_FAILED';
      if (error && !error.userMessage) error.userMessage = `Linux could not finish adding the Arcane user “${username}”.`;
      if (error && !error.resolution) error.resolution = error.accountRollback && error.accountRollback.accountRemoved
        ? 'Arcane removed the incomplete staged account. Correct the reported issue and retry.'
        : 'Review the protected transaction diagnostics and recover any recorded partial account before retrying.';
      throw error;
    }
  }

  async function activateProvisionedUser(username, staged, action) {
    if (!staged || !staged.created || !Number.isSafeInteger(staged.uid)) {
      throw ctx.arcaneError('INVALID_STAGED_ACCOUNT', 'Arcane cannot activate an account without its staged creation record.', 'Retry the complete Add Arcane user operation.', 409);
    }
    if (ctx.simulate) {
      const key = username.toLowerCase();
      if (!simulatedAccounts.has(key) || !simulatedShellAssignments.has(key)) throw ctx.arcaneError('USER_NOT_FOUND', `The staged Linux account “${username}” is missing.`, 'Retry the complete Add Arcane user operation.', 404);
      simulatedDisabledAccounts.delete(key);
      return { username, uid: staged.uid, enabled: true, activated: true };
    }
    requireRootUserMutation();
    const shell = assertInstalledUserShell();
    const account = assertStandardLocalAccount(username, { expectedUid: staged.uid });
    if (account.shell !== shell) {
      throw ctx.arcaneError('SHELL_CHANGED_EXTERNALLY', `Arcane refused to activate “${username}” because its login shell changed.`, 'Restore the exact installed Arcane shell assignment or remove the staged account manually.', 409);
    }
    const before = shadowState(username);
    if (before.enabled) return { username, uid: account.uid, enabled: true, activated: true, reconciled: true };
    if (!before.locked) {
      throw ctx.arcaneError('LINUX_STAGED_ACCOUNT_UNSAFE', `Arcane refused to activate “${username}” because its staged password is no longer locked.`, 'Review the staged account manually. Arcane made no activation change.', 409);
    }
    try {
      await ctx.run(requiredAccountCommand('chage'), ['-d', '0', username], { action });
      await ctx.run(requiredAccountCommand('usermod'), ['-e', '', username], { action });
      const stillLocked = shadowState(username);
      if (!stillLocked.locked || stillLocked.expired || stillLocked.lastChangedDay !== 0) {
        throw ctx.arcaneError('LINUX_ACTIVATION_PRECONDITION_FAILED', `Linux did not retain the protected pre-activation state for “${username}”.`, 'Arcane will re-lock and expire the account before returning.', 409);
      }
      await ctx.run(requiredAccountCommand('usermod'), ['-U', username], { action });
      const verifiedAccount = assertStandardLocalAccount(username, { expectedUid: staged.uid });
      const verifiedState = shadowState(username);
      if (verifiedAccount.shell !== shell || !verifiedState.enabled || verifiedState.lastChangedDay !== 0) {
        throw ctx.arcaneError('LINUX_ACCOUNT_ACTIVATION_FAILED', `Linux did not retain the active Arcane account state for “${username}”.`, 'Arcane will re-lock and expire the account before returning.', 409);
      }
      return { username, uid: verifiedAccount.uid, profile: verifiedAccount.profile, shell, enabled: true, activated: true };
    } catch (error) {
      try {
        const current = passwdRecord(username);
        if (!current || current.uid !== staged.uid) throw new Error('The staged UID changed before fail-closed recovery.');
        await ctx.run(requiredAccountCommand('usermod'), ['-L', username], { action });
        await ctx.run(requiredAccountCommand('usermod'), ['-e', '1970-01-02', username], { action });
        const recovered = shadowState(username);
        error.activationRollback = { locked: recovered.locked, expired: recovered.expired, uid: current.uid };
      } catch (rollbackError) {
        error.activationRollback = { locked: false, expired: false, uid: staged.uid, error: String(rollbackError && rollbackError.message || rollbackError) };
      }
      throw error;
    }
  }

  async function rollbackCreatedUser(username, staged, action) {
    if (!staged || !staged.created || !Number.isSafeInteger(staged.uid)) {
      throw ctx.arcaneError('INVALID_STAGED_ACCOUNT', 'Arcane refused to remove an account without its staged creation record.', 'Recover the account manually as an administrator.', 409);
    }
    if (ctx.simulate) {
      const key = username.toLowerCase();
      simulatedShellAssignments.delete(key);
      simulatedDisabledAccounts.delete(key);
      simulatedAccounts.delete(key);
      return { username, uid: staged.uid, accountDisabled: true, accountRemoved: true, cleanupErrors: [] };
    }
    requireRootUserMutation();
    const cleanupErrors = [];
    const initial = passwdRecord(username);
    if (!initial) return { username, uid: staged.uid, accountDisabled: true, accountRemoved: true, cleanupErrors };
    if (initial.uid !== staged.uid) {
      throw ctx.arcaneError('LINUX_ACCOUNT_IDENTITY_CHANGED', `Arcane refused to remove “${username}” because its UID changed.`, 'Review the account manually. Arcane made no deletion.', 409, { expectedUid: staged.uid, actualUid: initial.uid });
    }
    let accountDisabled = false;
    try {
      await ctx.run(requiredAccountCommand('usermod'), ['-L', username], { action });
      await ctx.run(requiredAccountCommand('usermod'), ['-e', '1970-01-02', username], { action });
      const locked = shadowState(username);
      const checked = passwdRecord(username);
      accountDisabled = Boolean(checked && checked.uid === staged.uid && locked.locked && locked.expired);
      if (!accountDisabled) throw new Error('Linux did not retain the locked and expired rollback state.');
    } catch (error) {
      cleanupErrors.push(`disable: ${String(error && error.message || error)}`);
    }
    if (!accountDisabled) return { username, uid: staged.uid, accountDisabled: false, accountRemoved: false, cleanupErrors };
    try {
      const checked = passwdRecord(username);
      if (!checked || checked.uid !== staged.uid) throw new Error('The staged UID changed immediately before account removal.');
      await ctx.run(requiredAccountCommand('userdel'), ['-r', username], { action });
    } catch (error) {
      cleanupErrors.push(`remove: ${String(error && error.message || error)}`);
    }
    const remaining = passwdRecord(username);
    const accountRemoved = !remaining;
    if (remaining && remaining.uid !== staged.uid) cleanupErrors.push('identity: the username now belongs to a different UID and was not removed');
    return { username, uid: staged.uid, accountDisabled, accountRemoved, cleanupErrors };
  }

  async function resetUserPassword(username, password, action) {
    if (ctx.simulate) return { username, passwordReset: true, mustChangeAtNextSignIn: true };
    requireRootUserMutation();
    if (!userExists(username)) {
      throw ctx.arcaneError('USER_NOT_FOUND', `The Linux account “${username}” does not exist.`, 'Add the Arcane user first, then set its temporary password.', 404);
    }
    const shell = assertInstalledUserShell();
    const account = assertStandardLocalAccount(username);
    if (account.shell !== shell || !shadowState(username).enabled) {
      throw ctx.arcaneError('NOT_ARCANE_USER', `“${username}” is not an active verified Arcane user.`, 'Activate or add the account as an Arcane user before resetting its password.', 409);
    }
    try {
      await ctx.run(requiredAccountCommand('chpasswd'), [], {
        action,
        input: `${username}:${password}\n`,
        displayCommand: '$ chpasswd [protected Arcane password reset]',
        suppressRawStdout: true,
        suppressRawStderr: true,
      });
      await ctx.run(requiredAccountCommand('chage'), ['-d', '0', username], { action });
      const verified = assertStandardLocalAccount(username, { expectedUid: account.uid });
      const passwordState = shadowState(username);
      if (verified.shell !== shell || !passwordState.enabled || passwordState.lastChangedDay !== 0) throw new Error('Linux did not retain the active temporary-password state.');
      return { username, uid: verified.uid, passwordReset: true, mustChangeAtNextSignIn: true };
    } catch (error) {
      for (const key of ['message', 'stdout', 'stderr']) {
        if (error && error[key]) error[key] = String(error[key]).split(password).join('[redacted]');
      }
      error.code = error.code === 'COMMAND_FAILED' ? 'LINUX_PASSWORD_RESET_FAILED' : error.code;
      error.userMessage = `Linux could not set a temporary password for “${username}”.`;
      error.resolution = 'Confirm the account exists and that Arcane has root authorization, then try again.';
      error.username = username;
      throw error;
    }
  }

  async function restoreUserShell(username, recoveryInput, previousShellPresentOrAction, maybeAction) {
    const structuredRecovery = Boolean(recoveryInput && typeof recoveryInput === 'object');
    const previousShell = structuredRecovery ? recoveryInput.previousShell ?? null : recoveryInput;
    const previousShellPresent = structuredRecovery ? Boolean(recoveryInput.previousShellPresent) : Boolean(previousShellPresentOrAction);
    const action = structuredRecovery ? previousShellPresentOrAction : maybeAction;
    const restoredShell = previousShellPresent && previousShell ? previousShell : defaultLoginShell();
    if (ctx.simulate) {
      simulatedShellAssignments.delete(username.toLowerCase());
      return { username, restored: true, shell: restoredShell, shellAssigned: false, verification: 'simulated' };
    }
    requireRootUserMutation();
    if (!Number.isSafeInteger(recoveryInput && recoveryInput.uid)) {
      throw ctx.arcaneError('LINUX_RECOVERY_IDENTITY_MISSING', `Arcane does not have an exact UID recovery record for “${username}”.`, 'Review this legacy account manually. Arcane made no shell change.', 409);
    }
    const expectedUid = recoveryInput.uid;
    const current = assertStandardLocalAccount(username, { expectedUid, allowProtected: true, allowPrivilegedGroups: true });
    const assignedShell = shellCommand();
    const prepared = structuredRecovery && recoveryInput.shellMutationPhase === 'prepared';
    if (prepared && current.shell === restoredShell) {
      return { username, restored: true, alreadyRestored: true, shell: restoredShell, shellAssigned: false, profile: current.profile, uid: current.uid, verification: 'verified' };
    }
    if (current.shell !== assignedShell) {
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
    await ctx.run(requiredAccountCommand('usermod'), ['-s', restoredShell, username], { action });
    const verified = assertStandardLocalAccount(username, { expectedUid, allowProtected: true, allowPrivilegedGroups: true });
    if (verified.shell !== restoredShell) {
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
    const opener = executableCommand('xdg-open');
    if (!opener) return null;
    const child = ctx.spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return child;
  }

  function elevationTarget(currentExecutable) { return currentExecutable; }

  function appearanceStatus() {
    return { supported:false,platform:'linux',scheme:'system',effectiveScheme:'system',captionColor:null,textColor:null };
  }

  async function applyAppearance() { return appearanceStatus(); }

  function openExternalUri(uri) {
    if (ctx.simulate) throw ctx.arcaneError('EXTERNAL_OPEN_SIMULATED','Arcane simulation cannot hand a link to the operating system.','Test external link handling from a real Arcane host.',501);
    const opener = executableCommand('xdg-open');
    if (!opener) throw ctx.arcaneError('EXTERNAL_OPEN_UNSUPPORTED','Arcane cannot find an operating-system URI handler.','Install xdg-utils and try again.',501);
    const child = ctx.spawn(opener, [uri], { detached: true, stdio: 'ignore' });
    child.unref();
    return { opened: true, uri };
  }

  async function selectDirectory(input) {
    const options = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const title = typeof options.title === 'string' && options.title.trim()
      ? options.title.trim()
      : 'Choose a folder';
    const initialPath = typeof options.initialPath === 'string' && options.initialPath
      ? options.initialPath
      : ctx.os.homedir();
    if (ctx.simulate) {
      return initialPath ? { cancelled: false, path: initialPath } : { cancelled: true, path: null };
    }
    const desktop = String(process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase();
    const zenity = {
      command: 'zenity',
      arguments: ['--file-selection', '--directory', `--title=${title}`, `--filename=${initialPath}/`],
    };
    const kdialog = {
      command: 'kdialog',
      arguments: ['--title', title, '--getexistingdirectory', initialPath],
    };
    const candidates = desktop.includes('kde') ? [kdialog, zenity] : [zenity, kdialog];
    let picker = null;
    for (const candidate of candidates) {
      const executable = executableCommand(candidate.command);
      if (executable) {
        picker = { executable, arguments: candidate.arguments };
        break;
      }
    }
    if (!picker) {
      throw ctx.arcaneError(
        'FILESYSTEM_DIRECTORY_SELECTION_UNSUPPORTED',
        'Arcane cannot find a supported Linux folder picker.',
        'Install Zenity or KDialog through the Linux distribution, then try again.',
        501
      );
    }
    const result = ctx.spawnSync(picker.executable, picker.arguments, { encoding: 'utf8', windowsHide: true });
    const selected = String(result && result.stdout || '').replace(/[\r\n]+$/, '');
    if (result && result.status === 0 && selected) {
      return { cancelled: false, path: selected };
    }
    if (result && result.status === 1 && !selected) {
      return { cancelled: true, path: null };
    }
    throw ctx.arcaneError(
      'FILESYSTEM_DIRECTORY_SELECTION_FAILED',
      'The Linux folder picker did not return a valid selection.',
      'Close the picker, reopen it, and choose an existing local directory.',
      500,
      {
        picker: ctx.path.basename(picker.executable),
        status: result && Number.isInteger(result.status) ? result.status : null,
      }
    );
  }

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
    supportsUserProvisioning: true,
    paths,
    commandExists,
    currentIdentity,
    protectedUsernames,
    osInfo,
    permissionStatus,
    appearanceStatus,
    applyAppearance,
    openExternalUri,
    selectDirectory,
    isElevated,
    hideHostWindow,
    nodeExecutable,
    ollamaExecutable,
    ollamaStatus,
    ollamaModelsRoot,
    hasAIProviderCredential,
    writeAIProviderCredential,
    readAIProviderCredential,
    deleteAIProviderCredential,
    ollamaServiceSettings,
    configureOllamaServiceSettings,
    gpuInfo,
    ollamaGlobalInstallAvailability,
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
    prepareInstallStage,
    captureInstallStageOwnership,
    installStageOwnershipStatus,
    cleanupInstallStage,
    materializeInstallStage,
    writeLaunchers,
    finalizeInstallStage,
    verifyStagedInstallation,
    createPublisherAttestation,
    hostReleaseSecurityMode,
    hostReleaseSecurityEvidence,
    listInstalledApplications,
    releaseSecurityMode,
    configureGraphicalTarget,
    rollbackGraphicalTarget,
    preservePlatformConfiguration,
    applyInstallPermissions,
    rollbackInstallIntegration,
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
