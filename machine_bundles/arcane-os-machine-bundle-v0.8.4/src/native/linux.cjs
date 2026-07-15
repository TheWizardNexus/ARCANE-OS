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
      const result = ctx.spawnSync(nvidiaSmi, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 });
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
    const systemctl = systemCommand('systemctl');
    if (!systemctl || !executable) {
      return { name: null, present: false, state: systemctl ? 'missing' : 'unavailable', startType: null, commandMatches: false, ready: false };
    }
    for (const name of ['arcane-ollama.service', 'ollama.service']) {
      const result = ctx.spawnSync(systemctl, [
        'show', name, '--no-pager',
        '--property=LoadState', '--property=ActiveState', '--property=UnitFileState', '--property=ExecStart',
      ], { encoding: 'utf8', timeout: 10000 });
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
      return { username, created: !exists, uid: 1000, profile: `/home/${username}`, shell, previousShell, previousShellPresent: true, shellBindingVersion: 1, assignmentMode: 'linux-login-shell' };
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
      shellBindingVersion: 1,
      assignmentMode: 'linux-login-shell',
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

  function appearanceStatus() {
    return { supported:false,platform:'linux',scheme:'system',effectiveScheme:'system',captionColor:null,textColor:null };
  }

  async function applyAppearance() { return appearanceStatus(); }

  function openExternalUri(uri) {
    if (ctx.simulate) return { opened: true, uri };
    const opener = systemCommand('xdg-open');
    if (!opener) throw ctx.arcaneError('EXTERNAL_OPEN_UNSUPPORTED','Arcane cannot find an operating-system URI handler.','Install xdg-utils and try again.',501);
    const child = ctx.spawn(opener, [uri], { detached: true, stdio: 'ignore' });
    child.unref();
    return { opened: true, uri };
  }

  async function selectDirectory() {
    throw ctx.arcaneError(
      'FILESYSTEM_DIRECTORY_SELECTION_UNSUPPORTED',
      'Arcane folder selection is not available on this Linux host.',
      'Enter a verified absolute directory path, or use an Arcane host with native folder selection.',
      501
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
    supportsUserProvisioning: false,
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
