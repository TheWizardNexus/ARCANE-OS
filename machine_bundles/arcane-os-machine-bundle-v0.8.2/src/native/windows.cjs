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
  const simulatedAccounts = ctx.simulatedAccounts
    && ['has', 'add', 'delete'].every((name) => typeof ctx.simulatedAccounts[name] === 'function')
    ? ctx.simulatedAccounts
    : new Set();
  const simulatedUsers = ctx.simulatedUsers
    && ['has', 'get', 'set', 'delete', 'values'].every((name) => typeof ctx.simulatedUsers[name] === 'function')
    ? ctx.simulatedUsers
    : new Map();
  const WINDOWS_SHELL_BINDING_VERSION = 2;
  const WINDOWS_SHELL_ASSIGNMENT_MODE = 'windows-dual';

  function normalizeShellRecovery(value, previousShellPresent) {
    const source = value && typeof value === 'object'
      ? value
      : { previousShell: value, previousShellPresent: Boolean(previousShellPresent) };
    const dual = Number(source.shellBindingVersion) === WINDOWS_SHELL_BINDING_VERSION
      && source.assignmentMode === WINDOWS_SHELL_ASSIGNMENT_MODE;
    return {
      dual,
      shellBindingVersion: dual ? WINDOWS_SHELL_BINDING_VERSION : 1,
      assignmentMode: dual ? WINDOWS_SHELL_ASSIGNMENT_MODE : 'windows-legacy',
      shellMutationPhase: String(source.shellMutationPhase || 'assigned'),
      previousShell: source.previousShell ?? null,
      previousShellPresent: Boolean(source.previousShellPresent),
      previousPolicyShell: dual ? source.previousPolicyShell ?? null : null,
      previousPolicyShellPresent: dual ? Boolean(source.previousPolicyShellPresent) : false,
      previousLegacyShell: dual ? source.previousLegacyShell ?? null : source.previousShell ?? null,
      previousLegacyShellPresent: dual ? Boolean(source.previousLegacyShellPresent) : Boolean(source.previousShellPresent),
      assignedShell: typeof source.shell === 'string' && source.shell ? source.shell : null,
      securityMode: ['publisher-verified', 'unsigned-local-test'].includes(source.securityMode) ? source.securityMode : null,
    };
  }

  function simulatedShellValue(binding, name) {
    const presentName = `${name}Present`;
    return {
      present: Boolean(binding && binding[presentName]),
      value: binding && binding[presentName] ? binding[name] ?? '' : null,
    };
  }

  function sameShellValue(left, right) {
    return left.present === right.present && (!left.present || left.value === right.value);
  }

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

  const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  const SHA256_PATTERN = /^[a-f0-9]{64}$/;
  const SAFE_ICON_EXTENSION = new Set(['.ico', '.jpeg', '.jpg', '.png', '.webp']);
  const SAFE_APP_CAPABILITIES = new Set([
    'diagnostics.read', 'identity.read', 'installation.read', 'media.microphone',
    'network.status.read', 'requirements.read', 'storage.read', 'storage.write',
    'system.metrics.read', 'system.read',
  ]);
  const MACHINE_CONTENT_EXCLUSIONS = new Set([
    'arcane-install.json', 'arcane-machine-content.json', 'arcane-release.json',
    'bin/ArcaneProvisioner.exe', 'bin/ArcaneShell.exe',
  ]);
  const MACHINE_BIN_FILES = new Set([
    'ArcaneShell.exe', 'ArcaneProvisioner.exe', 'ArcaneCore.exe', 'ArcanePipeGuard.exe',
    'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll',
  ]);
  const INSTALL_LEASE_FILE = 'installation-operation.json';

  function failInstalledApps(code, message, resolution, details, statusCode) {
    if (typeof ctx.arcaneError === 'function') {
      throw ctx.arcaneError(code, message, resolution, statusCode || 409, details);
    }
    const error = new Error(message);
    error.code = code;
    error.resolution = resolution;
    error.details = details;
    throw error;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function assertExactKeys(value, expected, label) {
    if (!isPlainObject(value)) throw new Error(`${label} must be a plain object.`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
      throw new Error(`${label} fields do not exactly match its schema.`);
    }
  }

  function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function normalizeInstalledPath(input, label) {
    const value = String(input === undefined || input === null ? '' : input);
    if (!value || value.length > 512 || value.includes('\\') || value.includes('\0') || /[\x00-\x1f]/.test(value)) {
      throw new Error(`${label || 'path'} must use canonical forward-slash relative syntax.`);
    }
    if (value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.startsWith('//')) {
      throw new Error(`${label || 'path'} must be relative.`);
    }
    const segments = value.split('/');
    if (value === '.' || value === '..' || value.startsWith('../')) throw new Error(`${label || 'path'} traverses its root.`);
    for (const segment of segments) {
      if (!segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ') || segment.includes(':')) {
        throw new Error(`${label || 'path'} contains an unsafe segment.`);
      }
      if (WINDOWS_RESERVED_NAME.test(segment)) throw new Error(`${label || 'path'} contains a Windows reserved segment.`);
    }
    return value;
  }

  function resolveInstalledPath(root, relativePath, label) {
    const normalized = normalizeInstalledPath(relativePath, label);
    const resolvedRoot = ctx.path.resolve(root);
    const target = ctx.path.resolve(resolvedRoot, ...normalized.split('/'));
    const relative = ctx.path.relative(resolvedRoot, target);
    if (!relative || relative === '..' || relative.startsWith(`..${ctx.path.sep}`) || ctx.path.isAbsolute(relative)) {
      throw new Error(`${label || 'path'} escapes its root.`);
    }
    return target;
  }

  function canonicalJson(value, finalNewline) {
    return JSON.stringify(value, null, 2) + (finalNewline ? '\n' : '');
  }

  function readCanonicalJson(file, label, options) {
    const opts = options || {};
    const stat = ctx.fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file.`);
    const maximum = opts.maximumBytes || 4 * 1024 * 1024;
    if (stat.size < 2 || stat.size > maximum) throw new Error(`${label} has an invalid size.`);
    const text = ctx.fs.readFileSync(file, 'utf8');
    let value;
    try { value = JSON.parse(text); } catch (_) { throw new Error(`${label} is not valid JSON.`); }
    const withNewline = canonicalJson(value, true);
    const withoutNewline = canonicalJson(value, false);
    const canonical = opts.finalNewline === true
      ? text === withNewline
      : opts.finalNewline === false
        ? text === withoutNewline
        : text === withNewline || text === withoutNewline;
    if (!canonical) throw new Error(`${label} is not canonical JSON.`);
    return { value, text, data: Buffer.from(text, 'utf8'), sha256: ctx.crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
  }

  function fileSha256(file) {
    return ctx.crypto.createHash('sha256').update(ctx.fs.readFileSync(file)).digest('hex');
  }

  function bufferOccurrences(data, pattern) {
    let count = 0;
    let offset = 0;
    while ((offset = data.indexOf(pattern, offset)) !== -1) {
      count += 1;
      offset += pattern.length;
    }
    return count;
  }

  function verifyCompiledBinding(file, marker, label) {
    const data = ctx.fs.readFileSync(file);
    const count = bufferOccurrences(data, Buffer.from(marker, 'utf8'))
      + bufferOccurrences(data, Buffer.from(marker, 'utf16le'));
    if (count !== 1) throw new Error(`${label} must contain exactly one compiled content binding.`);
  }

  function powershellLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  function safeApplicationEnvironment() {
    const userProfile = env.USERPROFILE || ctx.path.join('C:\\Users', env.USERNAME || 'Default');
    const localAppData = env.LOCALAPPDATA || ctx.path.join(userProfile, 'AppData', 'Local');
    const trustedPath = [system32, systemRoot, ctx.path.dirname(powershellExe)].join(';');
    return {
      SystemRoot: systemRoot,
      windir: systemRoot,
      ProgramFiles: programFiles,
      'ProgramFiles(x86)': programFilesX86,
      'PROGRAMFILES(X86)': programFilesX86,
      ProgramData: programData,
      LOCALAPPDATA: localAppData,
      USERPROFILE: userProfile,
      USERNAME: env.USERNAME || '',
      USERDOMAIN: env.USERDOMAIN || '',
      COMPUTERNAME: env.COMPUTERNAME || ctx.os.hostname(),
      TEMP: ctx.path.join(localAppData, 'Temp'),
      TMP: ctx.path.join(localAppData, 'Temp'),
      PATH: trustedPath,
      Path: trustedPath,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      ComSpec: cmdExe,
      PSModulePath: ctx.path.join(ctx.path.dirname(powershellExe), 'Modules'),
    };
  }

  function assertNoReparseTree(root) {
    if (!ctx.production && typeof ctx.reparsePointProbe === 'function') {
      const entries = ctx.reparsePointProbe(root);
      if (Array.isArray(entries) && entries.length) throw new Error(`Installed tree contains a reparse point: ${entries[0]}.`);
      return;
    }
    const script = `$ErrorActionPreference='Stop'\n$root=${powershellLiteral(ctx.path.resolve(root))}\n$items=@(Get-Item -LiteralPath $root -Force -ErrorAction Stop)+@(Get-ChildItem -LiteralPath $root -Force -Recurse -ErrorAction Stop)\n$bad=@($items|Where-Object{($_.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0}|ForEach-Object{$_.FullName})\nConvertTo-Json -InputObject @($bad) -Compress`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = ctx.spawnSync(powershellExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      encoding: 'utf8', windowsHide: true, timeout: 30000, env: safeApplicationEnvironment(),
    });
    if (!result || result.status !== 0) throw new Error('Windows could not verify the installed tree for reparse points.');
    let entries;
    try { entries = JSON.parse(String(result.stdout || '[]').trim() || '[]'); } catch (_) { throw new Error('Windows returned an invalid reparse-point verification result.'); }
    if (!Array.isArray(entries)) entries = [entries];
    if (entries.length) throw new Error(`Installed tree contains a reparse point: ${entries[0]}.`);
  }

  function enumerateExactTree(root, exclusions) {
    const excluded = exclusions || new Set();
    const rootStat = ctx.fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Installed root is not a regular directory.');
    const files = [];
    const visit = (directory, relativeDirectory) => {
      const entries = ctx.fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
      for (const entry of entries) {
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        normalizeInstalledPath(relative, 'installed path');
        const absolute = ctx.path.join(directory, entry.name);
        const stat = ctx.fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw new Error(`Installed tree contains a reparse link: ${relative}.`);
        if (entry.isDirectory() && stat.isDirectory()) visit(absolute, relative);
        else if (entry.isFile() && stat.isFile()) {
          if (!excluded.has(relative)) files.push({ path: relative, size: stat.size, sha256: fileSha256(absolute) });
        } else throw new Error(`Installed tree contains an unsupported entry: ${relative}.`);
      }
    };
    visit(ctx.path.resolve(root), '');
    files.sort((left, right) => compareText(left.path, right.path));
    return files;
  }

  function validateFileInventory(files, label, exclusions) {
    if (!Array.isArray(files) || !files.length || files.length > 50000) throw new Error(`${label} must contain a bounded file inventory.`);
    const seen = new Set();
    const normalized = files.map((entry, index) => {
      assertExactKeys(entry, new Set(['path', 'size', 'sha256']), `${label}[${index}]`);
      const relative = normalizeInstalledPath(entry.path, `${label}[${index}].path`);
      if (exclusions && exclusions.has(relative)) throw new Error(`${label} includes an excluded path: ${relative}.`);
      if (seen.has(relative)) throw new Error(`${label} contains a duplicate path: ${relative}.`);
      seen.add(relative);
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`${label} contains an invalid size for ${relative}.`);
      if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) throw new Error(`${label} contains an invalid SHA-256 for ${relative}.`);
      return { path: relative, size: entry.size, sha256: entry.sha256 };
    });
    const sorted = [...normalized].sort((left, right) => compareText(left.path, right.path));
    if (normalized.some((entry, index) => entry.path !== sorted[index].path)) throw new Error(`${label} is not sorted canonically.`);
    return normalized;
  }

  function verifyExactInventory(root, expected, exclusions, label) {
    const actual = enumerateExactTree(root, exclusions);
    if (actual.length !== expected.length || actual.some((entry, index) => (
      entry.path !== expected[index].path || entry.size !== expected[index].size || entry.sha256 !== expected[index].sha256
    ))) throw new Error(`${label} does not exactly match its filesystem content.`);
    return actual;
  }

  function validateCanonicalAppId(value, label) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 64 || !APP_ID_PATTERN.test(value)
      || value === 'shell' || value === 'provisioner' || WINDOWS_RESERVED_NAME.test(value)) {
      throw new Error(`${label || 'application id'} is not canonical.`);
    }
    return value;
  }

  function validatePresentationText(value, label, maximum, required) {
    if ((value === null || value === undefined || value === '') && !required) return null;
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > maximum
      || /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)
      || /[<>]|&(?:#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/i.test(value)) {
      throw new Error(`${label} is unsafe.`);
    }
    return value;
  }

  function validateCapabilities(values, label) {
    if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
    const result = values.map((value) => {
      if (typeof value !== 'string' || !SAFE_APP_CAPABILITIES.has(value)) throw new Error(`${label} contains an unapproved capability.`);
      return value;
    });
    if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate capabilities.`);
    const sorted = [...result].sort(compareText);
    if (result.some((value, index) => value !== sorted[index])) throw new Error(`${label} is not sorted canonically.`);
    return result;
  }

  function arraysEqual(left, right) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => value === right[index]);
  }

  function assertRootLayout(root, installed) {
    const expected = ['app', 'apps', 'arcane-bundle.json', 'arcane-machine-content.json', 'arcane-release.json', 'bin'];
    if (installed) expected.push('arcane-install.json');
    expected.sort(compareText);
    const entries = ctx.fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
    const actual = entries.map((entry) => entry.name);
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new Error('Arcane release root contains missing or unexpected entries.');
    }
    for (const entry of entries) {
      const stat = ctx.fs.lstatSync(ctx.path.join(root, entry.name));
      if (stat.isSymbolicLink()) throw new Error(`Arcane release root contains a reparse link: ${entry.name}.`);
      const shouldBeDirectory = entry.name === 'app' || entry.name === 'apps' || entry.name === 'bin';
      if (shouldBeDirectory ? !(entry.isDirectory() && stat.isDirectory()) : !(entry.isFile() && stat.isFile())) {
        throw new Error(`Arcane release root contains an invalid entry: ${entry.name}.`);
      }
    }
    const binEntries = ctx.fs.readdirSync(ctx.path.join(root, 'bin'), { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
    const expectedBin = [...MACHINE_BIN_FILES].sort(compareText);
    if (binEntries.length !== expectedBin.length || binEntries.some((entry, index) => entry.name !== expectedBin[index] || !entry.isFile())) {
      throw new Error('Arcane bin directory contains missing or unexpected entries.');
    }
  }

  function verifyMachineRelease(root, options) {
    const opts = options || {};
    const installed = Boolean(opts.installed);
    const absoluteRoot = ctx.path.resolve(root);
    assertNoReparseTree(absoluteRoot);
    assertRootLayout(absoluteRoot, installed);

    const bundleRecord = readCanonicalJson(ctx.path.join(absoluteRoot, 'arcane-bundle.json'), 'arcane-bundle.json', { maximumBytes: 1024 * 1024 });
    const bundle = bundleRecord.value;
    if (!isPlainObject(bundle) || bundle.version !== ctx.bundleVersion || bundle.protocolVersion !== 'arcane/1') {
      throw new Error('Arcane bundle identity does not match this runtime.');
    }

    const releaseRecord = readCanonicalJson(ctx.path.join(absoluteRoot, 'arcane-release.json'), 'arcane-release.json', { maximumBytes: 8 * 1024 * 1024 });
    const release = releaseRecord.value;
    assertExactKeys(release, new Set(['schemaVersion', 'name', 'version', 'platform', 'architecture', 'hashAlgorithm', 'createdAt', 'files']), 'arcane-release.json');
    if (release.schemaVersion !== 2 || release.version !== ctx.bundleVersion || release.platform !== 'windows'
      || release.architecture !== 'x64' || release.hashAlgorithm !== 'sha256' || typeof release.name !== 'string'
      || typeof release.createdAt !== 'string') throw new Error('Arcane release manifest identity is invalid.');
    const releaseFiles = validateFileInventory(release.files, 'arcane-release.json.files');
    const releaseExclusions = new Set(['arcane-release.json']);
    if (installed) releaseExclusions.add('arcane-install.json');
    verifyExactInventory(absoluteRoot, releaseFiles, releaseExclusions, 'Arcane outer release manifest');

    const machineRecord = readCanonicalJson(ctx.path.join(absoluteRoot, 'arcane-machine-content.json'), 'arcane-machine-content.json', { maximumBytes: 8 * 1024 * 1024, finalNewline: true });
    const machine = machineRecord.value;
    assertExactKeys(machine, new Set(['schemaVersion', 'hashAlgorithm', 'release', 'files']), 'arcane-machine-content.json');
    assertExactKeys(machine.release, new Set(['name', 'version', 'platform', 'architecture']), 'arcane-machine-content.json.release');
    if (machine.schemaVersion !== 1 || machine.hashAlgorithm !== 'sha256' || machine.release.name !== bundle.name
      || machine.release.version !== ctx.bundleVersion || machine.release.platform !== 'windows' || machine.release.architecture !== 'x64') {
      throw new Error('Arcane machine content identity is invalid.');
    }
    const machineFiles = validateFileInventory(machine.files, 'arcane-machine-content.json.files', MACHINE_CONTENT_EXCLUSIONS);
    verifyExactInventory(absoluteRoot, machineFiles, MACHINE_CONTENT_EXCLUSIONS, 'Arcane machine content manifest');
    const releaseMachineEntry = releaseFiles.find((entry) => entry.path === 'arcane-machine-content.json');
    if (!releaseMachineEntry || releaseMachineEntry.size !== machineRecord.data.length || releaseMachineEntry.sha256 !== machineRecord.sha256) {
      throw new Error('Arcane outer release does not bind the machine content manifest.');
    }
    const machineBinding = `ARCANE-MACHINE-BINDING|1|${ctx.bundleVersion}|${machineRecord.sha256}`;
    verifyCompiledBinding(ctx.path.join(absoluteRoot, 'bin', 'ArcaneShell.exe'), machineBinding, 'ArcaneShell.exe');
    verifyCompiledBinding(ctx.path.join(absoluteRoot, 'bin', 'ArcaneProvisioner.exe'), machineBinding, 'ArcaneProvisioner.exe');
    for (const required of [
      'bin/ArcaneShell.exe', 'bin/ArcaneProvisioner.exe', 'bin/ArcaneCore.exe', 'bin/ArcanePipeGuard.exe',
      'bin/Microsoft.Web.WebView2.Core.dll', 'bin/Microsoft.Web.WebView2.WinForms.dll', 'bin/WebView2Loader.dll',
      'arcane-bundle.json', 'arcane-machine-content.json', 'apps/catalog.json',
      'app/shared/arcane-api.js', 'app/provisioner/index.html', 'app/shell/index.html',
    ]) if (!releaseFiles.some((entry) => entry.path === required)) throw new Error(`Arcane release omits required file ${required}.`);

    if (installed) {
      const installedRecord = readCanonicalJson(ctx.path.join(absoluteRoot, 'arcane-install.json'), 'arcane-install.json', { maximumBytes: 16 * 1024 * 1024 });
      const integrity = installedRecord.value && installedRecord.value.integrity;
      if (!isPlainObject(integrity) || integrity.schemaVersion !== 2 || integrity.hashAlgorithm !== 'sha256' || integrity.scope !== 'installed-tree') {
        throw new Error('Installed Arcane integrity metadata is invalid.');
      }
      const installedFiles = validateFileInventory(integrity.files, 'arcane-install.json.integrity.files', new Set(['arcane-install.json']));
      verifyExactInventory(absoluteRoot, installedFiles, new Set(['arcane-install.json']), 'Installed Arcane integrity manifest');
    }
    return { root: absoluteRoot, bundle, release, releaseFiles, machine, machineRecord };
  }

  function validateCatalog(root, machine) {
    const appsRoot = ctx.path.join(root, 'apps');
    const record = readCanonicalJson(ctx.path.join(appsRoot, 'catalog.json'), 'apps/catalog.json', { maximumBytes: 2 * 1024 * 1024, finalNewline: true });
    const catalog = record.value;
    assertExactKeys(catalog, new Set(['schemaVersion', 'protocolVersion', 'bundleVersion', 'apps']), 'apps/catalog.json');
    if (catalog.schemaVersion !== 1 || catalog.protocolVersion !== 'arcane/1' || catalog.bundleVersion !== ctx.bundleVersion
      || !Array.isArray(catalog.apps) || !catalog.apps.length || catalog.apps.length > 64) {
      throw new Error('Arcane application catalog identity is invalid.');
    }
    const machineEntry = machine.files.find((entry) => entry.path === 'apps/catalog.json');
    if (!machineEntry || machineEntry.size !== record.data.length || machineEntry.sha256 !== record.sha256) {
      throw new Error('Arcane machine content does not bind the application catalog.');
    }
    const ids = new Set();
    const orders = new Set();
    const apps = catalog.apps.map((entry, index) => {
      assertExactKeys(entry, new Set([
        'id', 'displayName', 'description', 'icon', 'order', 'version', 'capabilities',
        'contentManifestSha256', 'packageManifestSha256',
      ]), `apps/catalog.json.apps[${index}]`);
      const id = validateCanonicalAppId(entry.id, `apps/catalog.json.apps[${index}].id`);
      if (ids.has(id)) throw new Error(`Arcane application catalog repeats ${id}.`);
      ids.add(id);
      if (!Number.isSafeInteger(entry.order) || entry.order < 0 || entry.order > 10000 || orders.has(entry.order)) {
        throw new Error(`Arcane application catalog has invalid ordering for ${id}.`);
      }
      orders.add(entry.order);
      const icon = normalizeInstalledPath(entry.icon, `${id}.icon`);
      if (!icon.split('/').every((segment) => /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(segment))) {
        throw new Error(`Arcane application catalog icon path for ${id} is not URL-safe.`);
      }
      if (entry.version !== ctx.bundleVersion || !SHA256_PATTERN.test(entry.contentManifestSha256)
        || !SHA256_PATTERN.test(entry.packageManifestSha256)) throw new Error(`Arcane application catalog hashes or version are invalid for ${id}.`);
      return {
        ...entry,
        id,
        displayName: validatePresentationText(entry.displayName, `${id}.displayName`, 80, true),
        description: validatePresentationText(entry.description, `${id}.description`, 240, true),
        icon,
        capabilities: validateCapabilities(entry.capabilities, `${id}.capabilities`),
      };
    });
    const expectedTop = ['catalog.json', ...apps.map((app) => app.id)].sort(compareText);
    const actualTop = ctx.fs.readdirSync(appsRoot, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
    if (actualTop.length !== expectedTop.length || actualTop.some((entry, index) => entry.name !== expectedTop[index])) {
      throw new Error('Arcane applications directory contains missing or unexpected entries.');
    }
    for (const entry of actualTop) {
      const stat = ctx.fs.lstatSync(ctx.path.join(appsRoot, entry.name));
      if (stat.isSymbolicLink()) throw new Error(`Arcane applications directory contains a reparse link: ${entry.name}.`);
      if (entry.name === 'catalog.json' ? !(entry.isFile() && stat.isFile()) : !(entry.isDirectory() && stat.isDirectory())) {
        throw new Error(`Arcane applications directory contains an invalid entry: ${entry.name}.`);
      }
    }
    return { catalog, apps, record };
  }

  function validateSecurityDescriptor(security, id) {
    assertExactKeys(security, new Set(['contentSecurityPolicy', 'permissionsPolicy', 'securedDocuments', 'navigationEntries', 'verifiedDependencies']), `${id}.security`);
    if (typeof security.contentSecurityPolicy !== 'string' || !security.contentSecurityPolicy
      || typeof security.permissionsPolicy !== 'string' || !security.permissionsPolicy
      || !Number.isSafeInteger(security.securedDocuments) || security.securedDocuments < 1
      || !Number.isSafeInteger(security.verifiedDependencies) || security.verifiedDependencies < 1
      || !Array.isArray(security.navigationEntries) || !security.navigationEntries.length) {
      throw new Error(`${id} security descriptor is invalid.`);
    }
    const seen = new Set();
    for (const navigation of security.navigationEntries) {
      if (typeof navigation !== 'string' || !navigation.startsWith(`/${id}/`) || !navigation.endsWith('.html')
        || navigation.includes('\\') || navigation.includes('%') || navigation.includes('?') || navigation.includes('#') || seen.has(navigation)) {
        throw new Error(`${id} security navigation allowlist is invalid.`);
      }
      seen.add(navigation);
    }
  }

  function validateDocumentCatalog(value, id) {
    if (value === null) return;
    assertExactKeys(value, new Set(['policy', 'count', 'destination']), `${id}.documentCatalog`);
    if (value.policy !== 'empty-unpublished' || value.count !== 0 || normalizeInstalledPath(value.destination, `${id}.documentCatalog.destination`) !== value.destination) {
      throw new Error(`${id} document catalog policy is invalid.`);
    }
  }

  function verifyInstalledAppPackage(machineResult, catalogEntry) {
    const id = catalogEntry.id;
    const appRoot = resolveInstalledPath(ctx.path.join(machineResult.root, 'apps'), id, `${id} package root`);
    const launcherName = `ArcaneApp-${id}.exe`;
    const packageRecord = readCanonicalJson(ctx.path.join(appRoot, 'arcane-app-package.json'), `${id}/arcane-app-package.json`, { maximumBytes: 16 * 1024 * 1024, finalNewline: true });
    if (packageRecord.sha256 !== catalogEntry.packageManifestSha256) throw new Error(`${id} package manifest does not match the catalog hash.`);
    const packaged = packageRecord.value;
    assertExactKeys(packaged, new Set(['schemaVersion', 'protocolVersion', 'bundleVersion', 'app', 'files', 'platform', 'architecture', 'native']), `${id} package manifest`);
    if (packaged.schemaVersion !== 1 || packaged.protocolVersion !== 'arcane/1' || packaged.bundleVersion !== ctx.bundleVersion
      || packaged.platform !== 'windows' || packaged.architecture !== 'x64') throw new Error(`${id} package identity is invalid.`);
    assertExactKeys(packaged.app, new Set([
      'id', 'displayName', 'description', 'icon', 'order', 'type', 'entry', 'launchEntry',
      'capabilities', 'security', 'documentCatalog',
    ]), `${id} package app descriptor`);
    if (packaged.app.id !== id || packaged.app.type !== 'app' || packaged.app.entry !== `${id}/index.html`
      || packaged.app.launchEntry !== `${id}/index.html` || packaged.app.displayName !== catalogEntry.displayName
      || packaged.app.description !== catalogEntry.description || packaged.app.order !== catalogEntry.order
      || !arraysEqual(packaged.app.capabilities, catalogEntry.capabilities)) throw new Error(`${id} package app descriptor does not match the catalog.`);
    const icon = normalizeInstalledPath(packaged.app.icon, `${id} package icon`);
    if (!SAFE_ICON_EXTENSION.has(ctx.path.extname(icon).toLowerCase())) throw new Error(`${id} package icon type is unsafe.`);
    const expectedCatalogIcon = `${id}/app/${id}/${icon}`;
    if (catalogEntry.icon !== expectedCatalogIcon) throw new Error(`${id} catalog icon does not match its package descriptor.`);
    validateSecurityDescriptor(packaged.app.security, id);
    validateDocumentCatalog(packaged.app.documentCatalog, id);
    assertExactKeys(packaged.native, new Set(['launcher', 'core', 'pipeGuard', 'renderer', 'signatureStatus', 'signatureRequiredForDistribution']), `${id} native descriptor`);
    if (packaged.native.launcher !== launcherName || packaged.native.core !== 'ArcaneCore.exe'
      || packaged.native.pipeGuard !== 'ArcanePipeGuard.exe' || packaged.native.renderer !== 'WebView2'
      || !['Valid', 'NotSigned'].includes(packaged.native.signatureStatus) || packaged.native.signatureRequiredForDistribution !== true) {
      throw new Error(`${id} native descriptor is invalid.`);
    }

    const packageFiles = validateFileInventory(packaged.files, `${id} package files`, new Set(['arcane-app-package.json']));
    verifyExactInventory(appRoot, packageFiles, new Set(['arcane-app-package.json']), `${id} package manifest`);
    const executables = packageFiles.filter((entry) => /\.exe$/i.test(entry.path)).map((entry) => entry.path).sort(compareText);
    const expectedExecutables = ['ArcaneCore.exe', 'ArcanePipeGuard.exe', launcherName].sort(compareText);
    if (executables.length !== expectedExecutables.length || executables.some((name, index) => name !== expectedExecutables[index])) {
      throw new Error(`${id} package contains an unexpected executable.`);
    }

    const contentRecord = readCanonicalJson(ctx.path.join(appRoot, 'arcane-app-content.json'), `${id}/arcane-app-content.json`, { maximumBytes: 16 * 1024 * 1024, finalNewline: true });
    if (contentRecord.sha256 !== catalogEntry.contentManifestSha256) throw new Error(`${id} content manifest does not match the catalog hash.`);
    const content = contentRecord.value;
    assertExactKeys(content, new Set(['schemaVersion', 'hashAlgorithm', 'app', 'files']), `${id} content manifest`);
    assertExactKeys(content.app, new Set(['id', 'version']), `${id} content identity`);
    if (content.schemaVersion !== 1 || content.hashAlgorithm !== 'sha256' || content.app.id !== id || content.app.version !== ctx.bundleVersion) {
      throw new Error(`${id} content manifest identity is invalid.`);
    }
    const contentExclusions = new Set(['arcane-app-content.json', 'arcane-app-package.json', launcherName]);
    const contentFiles = validateFileInventory(content.files, `${id} content files`, contentExclusions);
    verifyExactInventory(appRoot, contentFiles, contentExclusions, `${id} content manifest`);
    if (!contentFiles.some((entry) => entry.path === `app/${id}/${icon}`)) throw new Error(`${id} content manifest omits its icon.`);
    verifyCompiledBinding(
      ctx.path.join(appRoot, launcherName),
      `ARCANE-TARGET-BINDING|1|${id}|${contentRecord.sha256}`,
      launcherName
    );

    const targetBundleRecord = readCanonicalJson(ctx.path.join(appRoot, 'arcane-bundle.json'), `${id}/arcane-bundle.json`, { maximumBytes: 1024 * 1024 });
    const targetDescriptor = targetBundleRecord.value && targetBundleRecord.value.apps && targetBundleRecord.value.apps[id];
    if (targetBundleRecord.value.version !== ctx.bundleVersion || targetBundleRecord.value.protocolVersion !== 'arcane/1'
      || !isPlainObject(targetDescriptor) || Object.keys(targetBundleRecord.value.apps).length !== 1
      || targetDescriptor.displayName !== catalogEntry.displayName || targetDescriptor.description !== catalogEntry.description
      || targetDescriptor.icon !== icon || targetDescriptor.order !== catalogEntry.order || targetDescriptor.type !== 'app'
      || targetDescriptor.entry !== `${id}/index.html` || !arraysEqual(targetDescriptor.capabilities, catalogEntry.capabilities)) {
      throw new Error(`${id} target bundle descriptor does not match the catalog.`);
    }
    return {
      id,
      appRoot,
      launcher: ctx.path.join(appRoot, launcherName),
      signatureStatus: packaged.native.signatureStatus,
      publicRecord: {
        id,
        displayName: catalogEntry.displayName,
        description: catalogEntry.description,
        iconUrl: `/apps/${id}/app/${id}/${icon}`,
        version: catalogEntry.version,
        order: catalogEntry.order,
      },
    };
  }

  function inspectAuthenticode(files) {
    if (!ctx.production && typeof ctx.authenticodeInspector === 'function') return ctx.authenticodeInspector([...files]);
    const fileList = files.map(powershellLiteral).join(',');
    const script = `$ErrorActionPreference='Stop'\n$records=@()\nforeach($file in @(${fileList})){\n  $signature=Get-AuthenticodeSignature -LiteralPath $file\n  $records += [pscustomobject]@{path=$file;status=[string]$signature.Status;thumbprint=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Thumbprint}else{$null};subject=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Subject}else{$null};timestamped=[bool]($null -ne $signature.TimeStamperCertificate)}\n}\nConvertTo-Json -InputObject @($records) -Compress`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = ctx.spawnSync(powershellExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: safeApplicationEnvironment(),
    });
    if (!result || result.status !== 0) throw new Error('Windows could not inspect Arcane Authenticode signatures.');
    let records;
    try { records = JSON.parse(String(result.stdout || '').trim()); } catch (_) { throw new Error('Windows returned invalid Arcane signature records.'); }
    return Array.isArray(records) ? records : [records];
  }

  function verifyAuthenticodeSet(files, packageClaims) {
    const unique = [...new Set(files.map((file) => ctx.path.resolve(file)))].sort(compareText);
    if (!unique.length) throw new Error('Arcane signature verification received no executables.');
    const records = inspectAuthenticode(unique);
    if (!Array.isArray(records) || records.length !== unique.length) throw new Error('Arcane signature verification returned an incomplete result.');
    const byPath = new Map(records.map((record) => [String(record && record.path || '').toLowerCase(), record]));
    const ordered = unique.map((file) => {
      const record = byPath.get(file.toLowerCase());
      if (!record || String(record.path || '').toLowerCase() !== file.toLowerCase()) throw new Error('Arcane signature verification omitted an executable.');
      return record;
    });
    const allSigned = ordered.every((record) => record.status === 'Valid');
    const allUnsigned = ordered.every((record) => record.status === 'NotSigned');
    if (!allSigned && !allUnsigned) throw new Error('Arcane executables have mixed or invalid signature states.');
    const claims = packageClaims || [];
    if (allSigned) {
      const thumbprints = ordered.map((record) => String(record.thumbprint || '').replace(/\s/g, '').toUpperCase());
      if (thumbprints.some((value) => !/^[A-F0-9]{40,128}$/.test(value)) || new Set(thumbprints).size !== 1) {
        throw new Error('Arcane executables do not share one valid publisher certificate.');
      }
      if (ordered.some((record) => record.timestamped !== true)) throw new Error('Arcane publisher signatures are not consistently timestamped.');
      if (claims.some((claim) => claim !== 'Valid')) throw new Error('An Arcane package signature claim does not match its signed files.');
      const claimedMode = String(ctx.releaseSecurityModeClaim || env.ARCANE_RELEASE_SECURITY_MODE || '');
      if (claimedMode && claimedMode !== 'publisher-verified') throw new Error('The host release-security claim does not match the signed Arcane release.');
      return { securityMode: 'publisher-verified', signerThumbprint: thumbprints[0] };
    }
    const claimedMode = String(ctx.releaseSecurityModeClaim || env.ARCANE_RELEASE_SECURITY_MODE || '');
    if (!ctx.allowUnsignedLocalRelease || claimedMode !== 'unsigned-local-test') {
      throw new Error('Unsigned Arcane executables require the explicit host-attested local-test mode.');
    }
    if (claims.some((claim) => claim !== 'NotSigned')) throw new Error('An Arcane package signature claim does not match its unsigned files.');
    return { securityMode: 'unsigned-local-test', signerThumbprint: null };
  }

  function verifyInstalledApplicationSet(root, options) {
    const opts = options || {};
    const machineResult = verifyMachineRelease(root, { installed: Boolean(opts.installed) });
    const catalogResult = validateCatalog(machineResult.root, machineResult.machine);
    const packages = catalogResult.apps.map((entry) => verifyInstalledAppPackage(machineResult, entry));
    const machineExecutables = [
      'bin/ArcaneShell.exe', 'bin/ArcaneProvisioner.exe', 'bin/ArcaneCore.exe', 'bin/ArcanePipeGuard.exe',
    ].map((relative) => resolveInstalledPath(machineResult.root, relative, 'Arcane executable'));
    const appExecutables = [];
    for (const item of packages) {
      appExecutables.push(item.launcher, ctx.path.join(item.appRoot, 'ArcaneCore.exe'), ctx.path.join(item.appRoot, 'ArcanePipeGuard.exe'));
    }
    const security = verifyAuthenticodeSet([...machineExecutables, ...appExecutables], packages.map((item) => item.signatureStatus));
    if (opts.targetId && !packages.some((item) => item.id === opts.targetId)) {
      failInstalledApps('APPLICATION_NOT_FOUND', 'That Arcane application is not installed.', 'Choose an application from the verified Arcane catalog.', { applicationId: opts.targetId }, 404);
    }
    return { ...machineResult, ...catalogResult, packages, ...security };
  }

  function releaseSecurityMode() {
    return verifyInstalledApplicationSet(paths.installRoot, { installed: true }).securityMode;
  }

  async function listInstalledApplications() {
    const verified = verifyInstalledApplicationSet(paths.installRoot, { installed: true });
    return {
      verified: true,
      securityMode: verified.securityMode,
      applications: verified.packages.map((item) => ({ ...item.publicRecord })),
    };
  }

  function installLeasePath() {
    return ctx.path.join(paths.stateRoot, INSTALL_LEASE_FILE);
  }

  function validateInstallLease(value) {
    assertExactKeys(value, new Set(['schemaVersion', 'pid', 'processStartTicks', 'nonce', 'createdAt']), INSTALL_LEASE_FILE);
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.processStartTicks !== 'string' || !/^\d{10,20}$/.test(value.processStartTicks)
      || typeof value.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(value.nonce)
      || typeof value.createdAt !== 'string') throw new Error('The Arcane installation lease is malformed.');
    const created = new Date(value.createdAt);
    if (!Number.isFinite(created.getTime()) || created.toISOString() !== value.createdAt) {
      throw new Error('The Arcane installation lease timestamp is malformed.');
    }
    return value;
  }

  function assertInstallLeaseProtected(target) {
    if (!ctx.production && typeof ctx.installLeaseProtectionProbe === 'function') {
      if (ctx.installLeaseProtectionProbe(target) !== true) throw new Error('The Arcane installation lease is not protected.');
      return;
    }
    if (!ctx.production) return;
    const script = `$ErrorActionPreference='Stop'\n$targets=@(${powershellLiteral(paths.stateRoot)},${powershellLiteral(target)})\n$allowed=@('S-1-5-18','S-1-5-32-544')\n$writeMask=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership\nforeach($target in $targets){\n  $item=Get-Item -LiteralPath $target -Force -ErrorAction Stop\n  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'Arcane state contains a reparse point.'}\n  $acl=Get-Acl -LiteralPath $target -ErrorAction Stop\n  $owner=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value\n  if($owner -notin $allowed -or -not $acl.AreAccessRulesProtected){throw 'Arcane state ownership or ACL protection is invalid.'}\n  foreach($rule in $acl.Access){\n    $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value\n    if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and (($rule.FileSystemRights -band $writeMask)-ne 0) -and $sid -notin $allowed){throw 'Arcane state grants write access to an untrusted identity.'}\n  }\n}\n[Console]::Out.Write('protected')`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = ctx.spawnSync(powershellExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, env: safeApplicationEnvironment(),
    });
    if (!result || result.status !== 0 || String(result.stdout || '').trim() !== 'protected') {
      throw new Error('Windows could not prove that the Arcane installation lease is protected.');
    }
  }

  function inspectProcessIdentity(pid) {
    if (!ctx.production && typeof ctx.processIdentityProbe === 'function') {
      const identity = ctx.processIdentityProbe(pid);
      if (identity && identity.state === 'alive' && typeof identity.startTicks === 'string' && /^\d{10,20}$/.test(identity.startTicks)) return identity;
      if (identity && (identity.state === 'not-found' || identity.state === 'unqueryable')) return { state: identity.state };
      return { state: 'unqueryable' };
    }
    if (!ctx.production && typeof ctx.processStartTicks === 'function') {
      const ticks = ctx.processStartTicks(pid);
      return typeof ticks === 'string' && /^\d{10,20}$/.test(ticks)
        ? { state: 'alive', startTicks: ticks }
        : ticks === null ? { state: 'not-found' } : { state: 'unqueryable' };
    }
    const script = `$ErrorActionPreference='Stop'\ntry{\n  $p=[Diagnostics.Process]::GetProcessById(${Number(pid)})\n  $ticks=$p.StartTime.ToUniversalTime().Ticks\n  [Console]::Out.Write((ConvertTo-Json -Compress @{state='alive';startTicks=[string]$ticks}))\n}catch [ArgumentException]{\n  [Console]::Out.Write('{\"state\":\"not-found\"}')\n}catch{\n  [Console]::Out.Write('{\"state\":\"unqueryable\"}')\n}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = ctx.spawnSync(powershellExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, env: safeApplicationEnvironment(),
    });
    if (!result || result.status !== 0) return { state: 'unqueryable' };
    let identity;
    try { identity = JSON.parse(String(result.stdout || '').trim()); } catch (_) { return { state: 'unqueryable' }; }
    if (identity && identity.state === 'alive' && typeof identity.startTicks === 'string' && /^\d{10,20}$/.test(identity.startTicks)) return identity;
    if (identity && identity.state === 'not-found') return { state: 'not-found' };
    return { state: 'unqueryable' };
  }

  function readInstallLeaseStatus() {
    const target = installLeasePath();
    if (!ctx.fs.existsSync(target)) return { state: 'absent', target };
    try {
      const stat = ctx.fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The Arcane installation lease is not a regular file.');
      assertInstallLeaseProtected(target);
      const lease = validateInstallLease(readCanonicalJson(target, INSTALL_LEASE_FILE, { maximumBytes: 16 * 1024, finalNewline: true }).value);
      const identity = inspectProcessIdentity(lease.pid);
      if (identity.state === 'not-found' || (identity.state === 'alive' && identity.startTicks !== lease.processStartTicks)) {
        return { state: 'stale', target, lease };
      }
      if (identity.state === 'alive') return { state: 'active', target, lease };
      return { state: 'unqueryable', target, lease };
    } catch (error) {
      return { state: 'invalid', target, error };
    }
  }

  function assertNoInstallLease() {
    const status = readInstallLeaseStatus();
    if (status.state !== 'absent' && status.state !== 'stale') {
      failInstalledApps(
        'APPLICATION_INSTALL_BUSY',
        'Arcane applications are temporarily unavailable while installation is active.',
        'Wait for Arcane Provisioner to finish, then try again.',
        { retryable: true },
        409
      );
    }
  }

  function processStartTicks(pid) {
    const identity = inspectProcessIdentity(pid);
    return identity.state === 'alive' ? identity.startTicks : null;
  }

  async function acquireInstallLease(action) {
    if (ctx.simulate) return { simulated: true, nonce: 'simulation' };
    await ctx.ensureDir(paths.stateRoot);
    await applyStatePermissions(action);
    const target = installLeasePath();
    if (ctx.fs.existsSync(target)) {
      const status = readInstallLeaseStatus();
      if (status.state !== 'stale') {
        failInstalledApps('INSTALL_BUSY', 'Another Arcane installation operation is already active.', 'Wait for it to finish, then try again.', { retryable: true }, 409);
      }
      await ctx.fsp.unlink(target).catch((error) => {
        if (error && error.code !== 'ENOENT') throw error;
      });
    }
    const startTicks = processStartTicks(process.pid);
    if (!startTicks) throw new Error('Arcane could not bind its installation lease to this process.');
    const lease = {
      schemaVersion: 1,
      pid: process.pid,
      processStartTicks: startTicks,
      nonce: ctx.crypto.randomBytes(24).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    try {
      await ctx.fsp.writeFile(target, canonicalJson(lease, true), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        failInstalledApps('INSTALL_BUSY', 'Another Arcane installation operation is already active.', 'Wait for it to finish, then try again.', { retryable: true }, 409);
      }
      throw error;
    }
    try {
      await applyStatePermissions(action);
    } catch (error) {
      await ctx.fsp.unlink(target).catch(() => {});
      throw error;
    }
    return lease;
  }

  async function releaseInstallLease(lease) {
    if (!lease || lease.simulated) return;
    const target = installLeasePath();
    let current;
    try { current = readCanonicalJson(target, INSTALL_LEASE_FILE, { maximumBytes: 16 * 1024, finalNewline: true }).value; }
    catch (error) { if (error && error.code === 'ENOENT') return; throw error; }
    if (!isPlainObject(current) || current.nonce !== lease.nonce || current.pid !== lease.pid || current.processStartTicks !== lease.processStartTicks) {
      throw new Error('Arcane refused to release an installation lease owned by another operation.');
    }
    await ctx.fsp.unlink(target);
  }

  function runningInstalledArcaneProcesses() {
    let records = null;
    if (!ctx.production && typeof ctx.runningInstalledProcesses === 'function') {
      records = JSON.parse(JSON.stringify(ctx.runningInstalledProcesses()));
    }
    if (!ctx.production && typeof ctx.runningApplicationIds === 'function') {
      records = ctx.runningApplicationIds().map((id, index) => ({
        processId: index + 1,
        relativePath: `apps/${validateCanonicalAppId(id, 'running application id')}/ArcaneApp-${id}.exe`,
      }));
    }
    if (records === null) {
      if (!ctx.fs.existsSync(paths.installRoot)) return [];
      const script = `$ErrorActionPreference='Stop'\n$root=([IO.Path]::GetFullPath(${powershellLiteral(paths.installRoot)})).TrimEnd('\\')+'\\'\n$records=@()\nforeach($process in (Get-CimInstance Win32_Process -ErrorAction Stop)){\n  $file=[string]$process.ExecutablePath\n  if(-not $file){continue}\n  $full=[IO.Path]::GetFullPath($file)\n  if(-not $full.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){continue}\n  $relative=$full.Substring($root.Length).Replace('\\','/')\n  $records += [pscustomobject]@{processId=[int]$process.ProcessId;relativePath=$relative}\n}\nConvertTo-Json -InputObject @($records|Sort-Object relativePath,processId -Unique) -Compress`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const result = ctx.spawnSync(powershellExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        encoding: 'utf8', windowsHide: true, timeout: 30000, env: safeApplicationEnvironment(),
      });
      if (!result || result.status !== 0) throw new Error('Windows could not determine whether installed Arcane processes are running.');
      try { records = JSON.parse(String(result.stdout || '[]').trim() || '[]'); } catch (_) { throw new Error('Windows returned an invalid running-process result.'); }
    }
    if (!Array.isArray(records)) records = [records];
    return records.map((record) => {
      assertExactKeys(record, new Set(['processId', 'relativePath']), 'running Arcane process');
      if (!Number.isSafeInteger(record.processId) || record.processId < 1) throw new Error('Windows returned an invalid Arcane process id.');
      return {
        processId: record.processId,
        relativePath: normalizeInstalledPath(record.relativePath, 'running Arcane process path'),
      };
    });
  }

  function assertNoRunningInstalledApplications() {
    const processes = runningInstalledArcaneProcesses();
    if (processes.length) {
      failInstalledApps(
        'APPLICATIONS_BUSY',
        'One or more installed Arcane processes are still running.',
        'Close the listed Arcane Shell, Provisioner, Core, or application processes, then retry the installation from the external Provisioner.',
        { processes, retryable: true },
        409
      );
    }
  }

  async function launchInstalledApplication(idInput) {
    const id = validateCanonicalAppId(idInput, 'application id');
    assertNoInstallLease();
    const verified = verifyInstalledApplicationSet(paths.installRoot, { installed: true, targetId: id });
    assertNoInstallLease();
    const target = verified.packages.find((item) => item.id === id);
    const launchArguments = verified.securityMode === 'unsigned-local-test'
      ? ['--allow-unsigned-local-release']
      : [];
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = ctx.spawn(target.launcher, launchArguments, {
          cwd: target.appRoot,
          env: safeApplicationEnvironment(),
          shell: false,
          windowsHide: false,
          stdio: 'ignore',
        });
      } catch (error) { reject(error); return; }
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        try { child.unref(); } catch (_) {}
        resolve({ id, accepted: true });
      });
    });
  }

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
    const sourceIsInstalled = ctx.path.resolve(root).toLowerCase() === ctx.path.resolve(paths.installRoot).toLowerCase();
    const candidates = [root, ctx.path.join(root, 'dist', 'windows'), ctx.path.join(root, 'dist')];
    const dist = candidates.find((candidate) => (
      ctx.fs.existsSync(ctx.path.join(candidate, 'arcane-release.json'))
      && ctx.fs.existsSync(ctx.path.join(candidate, 'arcane-machine-content.json'))
      && ctx.fs.existsSync(ctx.path.join(candidate, 'bin'))
      && ctx.fs.existsSync(ctx.path.join(candidate, 'app'))
      && ctx.fs.existsSync(ctx.path.join(candidate, 'apps'))
    ));
    const requiredReleaseFiles = [
      'bin/ArcaneShell.exe',
      'bin/ArcaneProvisioner.exe',
      'bin/ArcaneCore.exe',
      'bin/ArcanePipeGuard.exe',
      'bin/Microsoft.Web.WebView2.Core.dll',
      'bin/Microsoft.Web.WebView2.WinForms.dll',
      'bin/WebView2Loader.dll',
      'arcane-bundle.json',
      'arcane-machine-content.json',
      'arcane-release.json',
      'apps/catalog.json',
      'app/shared/arcane-api.js',
      'app/shared/arcane-sigil.svg',
      'app/shared/arcane-sigil-512.png',
      'app/shared/arcane-sigil.ico',
      'app/provisioner/index.html',
      'app/provisioner/manifest.webmanifest',
      'app/shell/index.html',
      'app/shell/manifest.webmanifest',
    ];
    const missingRelease = !dist
      ? [...requiredReleaseFiles, 'bin/', 'app/', 'apps/']
      : requiredReleaseFiles.filter((name) => !ctx.fs.existsSync(ctx.path.join(dist, ...name.split('/'))));
    let releaseProblem = null;
    let verified = null;
    if (!missingRelease.length) {
      try {
        verified = verifyInstalledApplicationSet(dist, { installed: false });
      } catch (error) { releaseProblem = `The release manifest could not be read: ${error.message}`; }
    }

    if (verified && !releaseProblem) {
      const releaseManifestPath = ctx.path.join(dist, 'arcane-release.json');
      const releaseStat = ctx.fs.lstatSync(releaseManifestPath);
      const integrityFiles = [
        ...verified.releaseFiles.map((entry) => ({ ...entry, installPath: entry.path })),
        { path: 'arcane-release.json', installPath: 'arcane-release.json', size: releaseStat.size, sha256: fileSha256(releaseManifestPath) },
      ].sort((left, right) => compareText(left.installPath, right.installPath));
      return {
        mode: 'windows-webview2',
        releaseReady: true,
        verified: true,
        securityMode: verified.securityMode,
        selfHosted: sourceIsInstalled || ctx.path.resolve(dist).toLowerCase() === ctx.path.resolve(paths.installRoot).toLowerCase(),
        releaseManifest: verified.release,
        integrity: {
          schemaVersion: 2,
          hashAlgorithm: 'sha256',
          sourceManifest: releaseManifestPath,
          files: integrityFiles,
        },
        description: 'Verified Windows WebView2 hosts, machine content, and installed application catalog are ready for installation.',
        files: integrityFiles.map((entry) => ({
          source: ctx.path.join(dist, ...entry.installPath.split('/')),
          installPath: entry.installPath,
        })),
        directories: [],
        missingRelease: [],
      };
    }
    const sourceCore = ctx.path.join(root, 'runtime', 'arcane-core.cjs');
    return {
      mode: 'source',
      selfHosted: sourceIsInstalled,
      releaseReady: false,
      verified: false,
      description: releaseProblem || 'The source Arcane Core is available, but a verified Windows WebView2 release has not been built.',
      files: ctx.fs.existsSync(sourceCore) ? [{ source: sourceCore, installPath: 'bin/arcane-core.cjs', destinationName: 'arcane-core.cjs' }] : [],
      directories: [],
      missingRelease: [...new Set(missingRelease)],
      releaseProblem,
    };
  }

  async function writeLaunchers(stage, payload) {
    if (payload && payload.mode === 'windows-webview2') return;
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

  function verifyStagedInstallation(root, installed) {
    const result = verifyInstalledApplicationSet(root, { installed: Boolean(installed) });
    return { verified: true, securityMode: result.securityMode, applications: result.packages.length };
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

  function shellCommandForSecurityMode(securityMode) {
    const executable = ctx.path.join(paths.installRoot, 'bin', 'ArcaneShell.exe');
    const unsignedArgument = securityMode === 'unsigned-local-test' ? ' --allow-unsigned-local-release' : '';
    if (ctx.fs.existsSync(executable) || ctx.simulate) return `"${executable}" --shell${unsignedArgument}`;
    const launcher = ctx.path.join(paths.installRoot, 'bin', 'arcane-shell.cmd');
    return `cmd.exe /d /c ""${launcher}" --shell${unsignedArgument}"`;
  }

  function attestedShellSecurityMode() {
    const claim = String(ctx.releaseSecurityModeClaim || env.ARCANE_RELEASE_SECURITY_MODE || '');
    return ctx.allowUnsignedLocalRelease && claim === 'unsigned-local-test'
      ? 'unsigned-local-test'
      : 'publisher-verified';
  }

  function shellCommand() {
    return shellCommandForSecurityMode(attestedShellSecurityMode());
  }

  function recoveryAssignedShell(recovery) {
    if (!recovery.assignedShell) return shellCommand();
    const signed = shellCommandForSecurityMode('publisher-verified');
    const unsigned = shellCommandForSecurityMode('unsigned-local-test');
    if (recovery.assignedShell !== signed && recovery.assignedShell !== unsigned) {
      throw ctx.arcaneError('INVALID_SHELL_BACKUP', 'Arcane refused an unrecognized recorded shell command.', 'Review the protected Arcane user recovery record as an administrator.', 409);
    }
    if (recovery.securityMode && recovery.assignedShell !== shellCommandForSecurityMode(recovery.securityMode)) {
      throw ctx.arcaneError('INVALID_SHELL_BACKUP', 'Arcane refused a recorded shell command whose security mode does not match.', 'Review the protected Arcane user recovery record as an administrator.', 409);
    }
    return recovery.assignedShell;
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
        const binding = simulatedUsers.get(key) || null;
        const exists = simulatedAccounts.has(key);
        const policy = simulatedShellValue(binding, 'policyShell');
        const legacy = simulatedShellValue(binding, 'legacyShell');
        const policyAssigned = policy.present && policy.value === expectedShell;
        const legacyAssigned = legacy.present && legacy.value === expectedShell;
        const assigned = policyAssigned && legacyAssigned;
        return {
          username,
          shell: legacy.present ? legacy.value : policy.present ? policy.value : null,
          policyShell: policy.present ? policy.value : null,
          policyShellPresent: policy.present,
          legacyShell: legacy.present ? legacy.value : null,
          legacyShellPresent: legacy.present,
          shellAssigned: assigned,
          shellBindingVersion: assigned ? WINDOWS_SHELL_BINDING_VERSION : null,
          assignmentMode: assigned ? WINDOWS_SHELL_ASSIGNMENT_MODE : policyAssigned || legacyAssigned ? 'windows-partial' : null,
          enabled: exists ? binding && binding.enabled !== false : null,
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
  $policyShell=$null
  $policyShellPresent=$false
  $legacyShell=$null
  $legacyShellPresent=$false
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
      $policyKey="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"
      $legacyKey="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
      $policyProperty=Get-ItemProperty -LiteralPath $policyKey -Name Shell -ErrorAction SilentlyContinue
      $legacyProperty=Get-ItemProperty -LiteralPath $legacyKey -Name Shell -ErrorAction SilentlyContinue
      if($null -ne $policyProperty){$policyShellPresent=$true;$policyShell=$policyProperty.Shell}
      if($null -ne $legacyProperty){$legacyShellPresent=$true;$legacyShell=$legacyProperty.Shell}
    }
  } finally {
    if($temporary){
      ${unloadTemporaryHiveScript('user-shell discovery')}
    }
  }
  $policyAssigned=[bool]($verified -and $policyShellPresent -and [String]::Equals([string]$policyShell,[string]$expected,[StringComparison]::Ordinal))
  $legacyAssigned=[bool]($verified -and $legacyShellPresent -and [String]::Equals([string]$legacyShell,[string]$expected,[StringComparison]::Ordinal))
  $assigned=[bool]($policyAssigned -and $legacyAssigned)
  $assignmentMode=if($assigned){'windows-dual'}elseif($policyAssigned -or $legacyAssigned){'windows-partial'}else{$null}
  if($assigned -or ($recorded -contains $user.Name)){
    $results += [pscustomobject]@{
      username=$user.Name
      sid=$sid
      enabled=[bool]$user.Enabled
      profile=$profilePath
      shell=if($legacyShellPresent){$legacyShell}elseif($policyShellPresent){$policyShell}else{$null}
      policyShell=$policyShell
      policyShellPresent=$policyShellPresent
      legacyShell=$legacyShell
      legacyShellPresent=$legacyShellPresent
      shellAssigned=$assigned
      shellBindingVersion=if($assigned){2}else{$null}
      assignmentMode=$assignmentMode
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
        policyShell: null,
        policyShellPresent: false,
        legacyShell: null,
        legacyShellPresent: false,
        shellAssigned: false,
        shellBindingVersion: null,
        assignmentMode: null,
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
      const binding = simulatedUsers.get(key) || null;
      const policy = simulatedShellValue(binding, 'policyShell');
      const legacy = simulatedShellValue(binding, 'legacyShell');
      return {
        username,
        accountExisted: simulatedAccounts.has(key),
        previousShell: legacy.present ? legacy.value : null,
        previousShellPresent: legacy.present,
        previousPolicyShell: policy.present ? policy.value : null,
        previousPolicyShellPresent: policy.present,
        previousLegacyShell: legacy.present ? legacy.value : null,
        previousLegacyShellPresent: legacy.present,
        shellBindingVersion: WINDOWS_SHELL_BINDING_VERSION,
        assignmentMode: WINDOWS_SHELL_ASSIGNMENT_MODE,
        verification: 'simulated',
      };
    }
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$name=${ctx.psQuote(username)}
$user=Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if(-not $user){
  [pscustomobject]@{username=$name;accountExisted=$false;previousShell=$null;previousShellPresent=$false;previousPolicyShell=$null;previousPolicyShellPresent=$false;previousLegacyShell=$null;previousLegacyShellPresent=$false;shellBindingVersion=2;assignmentMode='windows-dual';profile=$null;sid=$null;verification='verified'}|ConvertTo-Json -Compress
  exit 0
}
$adminGroupSid='S-1-5-32-544'
$adminMember=Get-LocalGroupMember -SID $adminGroupSid -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $user.SID }
if($adminMember){ throw "Arcane will not replace the login shell of administrator account '$name'." }
$sid=$user.SID.Value
$profile=(Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue).LocalPath
$previousPolicyShell=$null
$previousPolicyShellPresent=$false
$previousLegacyShell=$null
$previousLegacyShellPresent=$false
$loaded=Test-Path "Registry::HKEY_USERS\\$sid"
$temporary=$false
$hive=$sid
if(-not $loaded){
  if(-not $profile){throw "Windows could not locate the user profile for '$name' to back up both shell bindings."}
  $ntUser=Join-Path $profile 'NTUSER.DAT'
  if(-not (Test-Path -LiteralPath $ntUser)){throw "Windows could not locate NTUSER.DAT for '$name' to back up both shell bindings."}
  $hive='ARCANE_PREPARE_'+($sid -replace '-','_')
  & ${ctx.psQuote(regExe)} load "HKU\\$hive" $ntUser | Out-Null
  if($LASTEXITCODE -ne 0){ throw "Windows could not load the registry profile for '$name' to back up its shell." }
  $temporary=$true
}
try {
  $policyKey="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"
  $legacyKey="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
  $previousPolicy=Get-ItemProperty -LiteralPath $policyKey -Name Shell -ErrorAction SilentlyContinue
  $previousLegacy=Get-ItemProperty -LiteralPath $legacyKey -Name Shell -ErrorAction SilentlyContinue
  if($null -ne $previousPolicy){$previousPolicyShellPresent=$true;$previousPolicyShell=$previousPolicy.Shell}
  if($null -ne $previousLegacy){$previousLegacyShellPresent=$true;$previousLegacyShell=$previousLegacy.Shell}
} finally {
  if($temporary){
    ${unloadTemporaryHiveScript('shell backup preparation')}
  }
}
[pscustomobject]@{username=$name;accountExisted=$true;previousShell=$previousLegacyShell;previousShellPresent=$previousLegacyShellPresent;previousPolicyShell=$previousPolicyShell;previousPolicyShellPresent=$previousPolicyShellPresent;previousLegacyShell=$previousLegacyShell;previousLegacyShellPresent=$previousLegacyShellPresent;shellBindingVersion=2;assignmentMode='windows-dual';profile=$profile;sid=$sid;verification='verified'}|ConvertTo-Json -Compress`;
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
    const recovery = normalizeShellRecovery(shellBackup);
    if (!recovery.dual) {
      throw ctx.arcaneError(
        'INVALID_SHELL_BACKUP',
        'Arcane refused to change a Windows shell without a complete dual-binding recovery record.',
        'Refresh the account state and retry so Arcane can capture both Windows shell bindings.',
        409
      );
    }
    if (ctx.simulate) {
      const key = username.toLowerCase();
      const created = !simulatedAccounts.has(key);
      const existingBinding = simulatedUsers.get(key) || { username, enabled: true };
      const currentPolicy = simulatedShellValue(existingBinding, 'policyShell');
      const currentLegacy = simulatedShellValue(existingBinding, 'legacyShell');
      const expectedPolicy = { present: recovery.previousPolicyShellPresent, value: recovery.previousPolicyShell };
      const expectedLegacy = { present: recovery.previousLegacyShellPresent, value: recovery.previousLegacyShell };
      if (created !== !shellBackup.accountExisted || !sameShellValue(currentPolicy, expectedPolicy) || !sameShellValue(currentLegacy, expectedLegacy)) {
        throw ctx.arcaneError('SHELL_CHANGED_EXTERNALLY', `The Windows account or one of its shell bindings changed after Arcane saved its recovery record.`, 'No shell change was made. Refresh the account list and try again.', 409);
      }
      simulatedAccounts.add(key);
      try {
        existingBinding.policyShell = shell;
        existingBinding.policyShellPresent = true;
        if (ctx.simulatedUserFailure === 'crash-after-policy-shell-write' && !ctx.simulatedUserFailureTriggered) {
          ctx.simulatedUserFailureTriggered = true;
          simulatedUsers.set(key, existingBinding);
          const error = ctx.arcaneError('SIMULATED_USER_TRANSACTION_FAILURE', 'Simulated process loss after writing the Windows policy shell binding.', 'The next retry must recover the original durable dual-binding baseline.', 500);
          error.simulatedCrash = true;
          throw error;
        }
        if (ctx.simulatedShellWriteFailure === 'after-policy') throw new Error('Simulated failure after the policy shell write.');
        existingBinding.legacyShell = shell;
        existingBinding.legacyShellPresent = true;
        if (ctx.simulatedUserFailure === 'crash-after-legacy-shell-write' && !ctx.simulatedUserFailureTriggered) {
          ctx.simulatedUserFailureTriggered = true;
          simulatedUsers.set(key, existingBinding);
          const error = ctx.arcaneError('SIMULATED_USER_TRANSACTION_FAILURE', 'Simulated process loss after writing both Windows shell bindings.', 'The next retry must recover the original durable dual-binding baseline.', 500);
          error.simulatedCrash = true;
          throw error;
        }
        if (ctx.simulatedShellWriteFailure === 'after-legacy') throw new Error('Simulated failure after the legacy shell write.');
        existingBinding.username = username;
        existingBinding.enabled = !created;
        simulatedUsers.set(key, existingBinding);
      } catch (error) {
        if (error && error.simulatedCrash) throw error;
        existingBinding.policyShell = recovery.previousPolicyShell;
        existingBinding.policyShellPresent = recovery.previousPolicyShellPresent;
        existingBinding.legacyShell = recovery.previousLegacyShell;
        existingBinding.legacyShellPresent = recovery.previousLegacyShellPresent;
        simulatedUsers.set(key, existingBinding);
        if (created) {
          simulatedUsers.delete(key);
          simulatedAccounts.delete(key);
        }
        throw error;
      }
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
      return {
        username,
        created,
        sid: 'SIMULATED',
        profile: 'SIMULATED',
        shell,
        enabled: !created,
        activationPending: created,
        previousShell: recovery.previousLegacyShell,
        previousShellPresent: recovery.previousLegacyShellPresent,
        previousPolicyShell: recovery.previousPolicyShell,
        previousPolicyShellPresent: recovery.previousPolicyShellPresent,
        previousLegacyShell: recovery.previousLegacyShell,
        previousLegacyShellPresent: recovery.previousLegacyShellPresent,
        shellBindingVersion: WINDOWS_SHELL_BINDING_VERSION,
        assignmentMode: WINDOWS_SHELL_ASSIGNMENT_MODE,
      };
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
$expectedPolicyPresent=${recovery.previousPolicyShellPresent ? '$true' : '$false'}
$expectedPolicy=${ctx.psQuote(recovery.previousPolicyShell === null || recovery.previousPolicyShell === undefined ? '' : recovery.previousPolicyShell)}
$expectedLegacyPresent=${recovery.previousLegacyShellPresent ? '$true' : '$false'}
$expectedLegacy=${ctx.psQuote(recovery.previousLegacyShell === null || recovery.previousLegacyShell === undefined ? '' : recovery.previousLegacyShell)}
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
if(-not $loaded){
  $hive='ARCANE_'+($sid -replace '-','_')
  & ${ctx.psQuote(regExe)} load "HKU\\$hive" $ntUser | Out-Null
  if($LASTEXITCODE -ne 0){ throw "Windows could not load the registry profile for '$name'." }
}
try {
  function Get-ArcaneShellValue([string]$Path){
    $property=Get-ItemProperty -LiteralPath $Path -Name Shell -ErrorAction SilentlyContinue
    if($null -eq $property){return [pscustomobject]@{Present=$false;Value=$null}}
    return [pscustomobject]@{Present=$true;Value=$property.Shell}
  }
  function Test-ArcaneShellValue([string]$Path,[bool]$Present,[string]$Value){
    $actual=Get-ArcaneShellValue $Path
    return [bool]($actual.Present -eq $Present -and (-not $Present -or [String]::Equals([string]$actual.Value,[string]$Value,[StringComparison]::Ordinal)))
  }
  function Set-ArcaneShellValue([string]$Path,[bool]$Present,[string]$Value){
    if($Present){
      New-Item -Path $Path -Force | Out-Null
      New-ItemProperty -Path $Path -Name Shell -PropertyType String -Value $Value -Force | Out-Null
    } else {
      Remove-ItemProperty -LiteralPath $Path -Name Shell -ErrorAction SilentlyContinue
    }
  }
  $policyKey="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"
  $legacyKey="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
  $previousPolicy=Get-ArcaneShellValue $policyKey
  $previousLegacy=Get-ArcaneShellValue $legacyKey
  if(-not (Test-ArcaneShellValue $policyKey $expectedPolicyPresent $expectedPolicy) -or -not (Test-ArcaneShellValue $legacyKey $expectedLegacyPresent $expectedLegacy)){
    throw "A Windows shell binding for '$name' changed after Arcane saved its recovery record. No shell change was made."
  }
  $assignmentError=$null
  try {
    Set-ArcaneShellValue $policyKey $true $shell
    if(-not (Test-ArcaneShellValue $policyKey $true $shell)){throw "Windows did not retain the Arcane policy shell assignment for '$name'."}
    Set-ArcaneShellValue $legacyKey $true $shell
    if(-not (Test-ArcaneShellValue $legacyKey $true $shell)){throw "Windows did not retain the Arcane legacy shell assignment for '$name'."}
  } catch {
    $assignmentError=$_
    $rollbackErrors=@()
    try{Set-ArcaneShellValue $policyKey ([bool]$previousPolicy.Present) ([string]$previousPolicy.Value)}catch{$rollbackErrors+=('policy write: '+$_.Exception.Message)}
    try{Set-ArcaneShellValue $legacyKey ([bool]$previousLegacy.Present) ([string]$previousLegacy.Value)}catch{$rollbackErrors+=('legacy write: '+$_.Exception.Message)}
    if(-not (Test-ArcaneShellValue $policyKey ([bool]$previousPolicy.Present) ([string]$previousPolicy.Value))){$rollbackErrors+='policy verification failed'}
    if(-not (Test-ArcaneShellValue $legacyKey ([bool]$previousLegacy.Present) ([string]$previousLegacy.Value))){$rollbackErrors+='legacy verification failed'}
    if($rollbackErrors.Count){
      throw ("Arcane could not compensate both Windows shell bindings after assignment failed. Original error: "+$assignmentError.Exception.Message+" Rollback errors: "+($rollbackErrors -join '; '))
    }
    throw $assignmentError
  }
} finally {
  if(-not $loaded){
    ${unloadTemporaryHiveScript('shell assignment')}
  }
}
[pscustomobject]@{username=$name;created=$created;sid=$sid;profile=$profilePath;shell=$shell;enabled=[bool]$user.Enabled;activationPending=$created;previousShell=$previousLegacy.Value;previousShellPresent=[bool]$previousLegacy.Present;previousPolicyShell=$previousPolicy.Value;previousPolicyShellPresent=[bool]$previousPolicy.Present;previousLegacyShell=$previousLegacy.Value;previousLegacyShellPresent=[bool]$previousLegacy.Present;shellBindingVersion=2;assignmentMode='windows-dual'}|ConvertTo-Json -Compress
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
    const stagedRecovery = normalizeShellRecovery(staged);
    if (!staged || !staged.created || !staged.sid || !stagedRecovery.dual) {
      throw ctx.arcaneError('INVALID_STAGED_ACCOUNT', 'Arcane cannot activate an account without its staged creation record.', 'Retry the complete Add Arcane user operation.', 409);
    }
    if (ctx.simulate) {
      const key = username.toLowerCase();
      const assigned = simulatedUsers.get(key);
      if (!assigned || !simulatedAccounts.has(key)) throw new Error('The simulated staged account is missing.');
      const expectedShell = recoveryAssignedShell(stagedRecovery);
      const policy = simulatedShellValue(assigned, 'policyShell');
      const legacy = simulatedShellValue(assigned, 'legacyShell');
      if (!policy.present || policy.value !== expectedShell || !legacy.present || legacy.value !== expectedShell) {
        throw ctx.arcaneError('SHELL_CHANGED_EXTERNALLY', 'Arcane refused to activate the staged account because both Windows shell bindings were not exact.', 'Repair or retry the staged account transaction.', 409);
      }
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
    const expectedShell = recoveryAssignedShell(stagedRecovery);
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
  $policyKey="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"
  $legacyKey="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
  $policyProperty=Get-ItemProperty -LiteralPath $policyKey -Name Shell -ErrorAction SilentlyContinue
  $legacyProperty=Get-ItemProperty -LiteralPath $legacyKey -Name Shell -ErrorAction SilentlyContinue
  $policyMatches=[bool]($null -ne $policyProperty -and [String]::Equals([string]$policyProperty.Shell,[string]$expectedShell,[StringComparison]::Ordinal))
  $legacyMatches=[bool]($null -ne $legacyProperty -and [String]::Equals([string]$legacyProperty.Shell,[string]$expectedShell,[StringComparison]::Ordinal))
  if(-not ($policyMatches -and $legacyMatches)){throw "Arcane refused to activate '$name' because both staged Windows shell bindings no longer match Arcane exactly."}
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

  async function restoreUserShell(username, recoveryInput, previousShellPresentOrAction, maybeAction) {
    const structuredRecovery = Boolean(recoveryInput && typeof recoveryInput === 'object');
    const recovery = normalizeShellRecovery(recoveryInput, structuredRecovery ? undefined : previousShellPresentOrAction);
    const action = structuredRecovery ? previousShellPresentOrAction : maybeAction;
    const previousShell = recovery.previousShell;
    const previousShellPresent = recovery.previousShellPresent;
    if (ctx.simulate) {
      const key = username.toLowerCase();
      const binding = simulatedUsers.get(key) || { username, enabled: simulatedAccounts.has(key) };
      const expected = recoveryAssignedShell(recovery);
      if (recovery.dual) {
        const policy = simulatedShellValue(binding, 'policyShell');
        const legacy = simulatedShellValue(binding, 'legacyShell');
        const baselinePolicy = { present: recovery.previousPolicyShellPresent, value: recovery.previousPolicyShell };
        const baselineLegacy = { present: recovery.previousLegacyShellPresent, value: recovery.previousLegacyShell };
        const policyArcane = policy.present && policy.value === expected;
        const legacyArcane = legacy.present && legacy.value === expected;
        const prepared = recovery.shellMutationPhase === 'prepared';
        const policyAllowed = prepared ? policyArcane || sameShellValue(policy, baselinePolicy) : policyArcane;
        const legacyAllowed = prepared ? legacyArcane || sameShellValue(legacy, baselineLegacy) : legacyArcane;
        if (!policyAllowed || !legacyAllowed) {
          throw ctx.arcaneError('SHELL_CHANGED_EXTERNALLY', `Arcane refused to overwrite a Windows shell binding for “${username}” because it contains an unrecognized value.`, 'Review both per-user shell registry values manually. No change was made.', 409);
        }
        binding.policyShell = recovery.previousPolicyShell;
        binding.policyShellPresent = recovery.previousPolicyShellPresent;
        binding.legacyShell = recovery.previousLegacyShell;
        binding.legacyShellPresent = recovery.previousLegacyShellPresent;
        simulatedUsers.set(key, binding);
        return {
          username,
          restored: true,
          shell: recovery.previousLegacyShellPresent ? recovery.previousLegacyShell : null,
          policyShell: recovery.previousPolicyShellPresent ? recovery.previousPolicyShell : null,
          policyShellPresent: recovery.previousPolicyShellPresent,
          legacyShell: recovery.previousLegacyShellPresent ? recovery.previousLegacyShell : null,
          legacyShellPresent: recovery.previousLegacyShellPresent,
          shellAssigned: false,
          shellBindingVersion: WINDOWS_SHELL_BINDING_VERSION,
          assignmentMode: WINDOWS_SHELL_ASSIGNMENT_MODE,
          verification: 'simulated',
        };
      }
      const legacy = simulatedShellValue(binding, 'legacyShell');
      if (!legacy.present || legacy.value !== expected) {
        throw ctx.arcaneError('SHELL_CHANGED_EXTERNALLY', `Arcane refused to overwrite the current legacy shell for “${username}” because it no longer matches Arcane.`, 'Review the account manually. No change was made.', 409);
      }
      binding.legacyShell = previousShell;
      binding.legacyShellPresent = previousShellPresent;
      simulatedUsers.set(key, binding);
      return {
        username,
        restored: true,
        shell: previousShellPresent ? previousShell : null,
        shellAssigned: false,
        verification: 'simulated',
      };
    }
    const expectedShell = recoveryAssignedShell(recovery);
    if (recovery.dual) {
      const preparedRecovery = recovery.shellMutationPhase === 'prepared';
      const dualScript = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$name=${ctx.psQuote(username)}
$expected=${ctx.psQuote(expectedShell)}
$prepared=${preparedRecovery ? '$true' : '$false'}
$previousPolicy=${ctx.psQuote(recovery.previousPolicyShell === null || recovery.previousPolicyShell === undefined ? '' : recovery.previousPolicyShell)}
$previousPolicyPresent=${recovery.previousPolicyShellPresent ? '$true' : '$false'}
$previousLegacy=${ctx.psQuote(recovery.previousLegacyShell === null || recovery.previousLegacyShell === undefined ? '' : recovery.previousLegacyShell)}
$previousLegacyPresent=${recovery.previousLegacyShellPresent ? '$true' : '$false'}
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
  function Get-ArcaneShellValue([string]$Path){
    $property=Get-ItemProperty -LiteralPath $Path -Name Shell -ErrorAction SilentlyContinue
    if($null -eq $property){return [pscustomobject]@{Present=$false;Value=$null}}
    return [pscustomobject]@{Present=$true;Value=$property.Shell}
  }
  function Test-ArcaneShellValue([string]$Path,[bool]$Present,[string]$Value){
    $actual=Get-ArcaneShellValue $Path
    return [bool]($actual.Present -eq $Present -and (-not $Present -or [String]::Equals([string]$actual.Value,[string]$Value,[StringComparison]::Ordinal)))
  }
  function Test-ArcaneExpected([string]$Path){return (Test-ArcaneShellValue $Path $true $expected)}
  function Set-ArcaneShellValue([string]$Path,[bool]$Present,[string]$Value){
    if($Present){
      New-Item -Path $Path -Force | Out-Null
      New-ItemProperty -Path $Path -Name Shell -PropertyType String -Value $Value -Force | Out-Null
    } else {
      Remove-ItemProperty -LiteralPath $Path -Name Shell -ErrorAction SilentlyContinue
    }
  }
  $policyKey="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"
  $legacyKey="Registry::HKEY_USERS\\$hive\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"
  $currentPolicy=Get-ArcaneShellValue $policyKey
  $currentLegacy=Get-ArcaneShellValue $legacyKey
  if($prepared){
    $policyAllowed=[bool]((Test-ArcaneExpected $policyKey) -or (Test-ArcaneShellValue $policyKey $previousPolicyPresent $previousPolicy))
    $legacyAllowed=[bool]((Test-ArcaneExpected $legacyKey) -or (Test-ArcaneShellValue $legacyKey $previousLegacyPresent $previousLegacy))
  } else {
    $policyAllowed=[bool](Test-ArcaneExpected $policyKey)
    $legacyAllowed=[bool](Test-ArcaneExpected $legacyKey)
  }
  if(-not ($policyAllowed -and $legacyAllowed)){
    throw "Arcane refused to overwrite a Windows shell binding for '$name' because it contains a value outside the durable recovery record."
  }
  $restoreError=$null
  try {
    Set-ArcaneShellValue $policyKey $previousPolicyPresent $previousPolicy
    if(-not (Test-ArcaneShellValue $policyKey $previousPolicyPresent $previousPolicy)){throw "Windows did not retain the restored policy shell for '$name'."}
    Set-ArcaneShellValue $legacyKey $previousLegacyPresent $previousLegacy
    if(-not (Test-ArcaneShellValue $legacyKey $previousLegacyPresent $previousLegacy)){throw "Windows did not retain the restored legacy shell for '$name'."}
  } catch {
    $restoreError=$_
    $rollbackErrors=@()
    try{Set-ArcaneShellValue $policyKey ([bool]$currentPolicy.Present) ([string]$currentPolicy.Value)}catch{$rollbackErrors+=('policy write: '+$_.Exception.Message)}
    try{Set-ArcaneShellValue $legacyKey ([bool]$currentLegacy.Present) ([string]$currentLegacy.Value)}catch{$rollbackErrors+=('legacy write: '+$_.Exception.Message)}
    if(-not (Test-ArcaneShellValue $policyKey ([bool]$currentPolicy.Present) ([string]$currentPolicy.Value))){$rollbackErrors+='policy verification failed'}
    if(-not (Test-ArcaneShellValue $legacyKey ([bool]$currentLegacy.Present) ([string]$currentLegacy.Value))){$rollbackErrors+='legacy verification failed'}
    if($rollbackErrors.Count){throw ("Arcane could not compensate both Windows shell bindings after restoration failed. Original error: "+$restoreError.Exception.Message+" Rollback errors: "+($rollbackErrors -join '; '))}
    throw $restoreError
  }
} finally {
  if($temporary){${unloadTemporaryHiveScript('dual shell restoration')}}
}
$restoredShell=if($previousLegacyPresent){$previousLegacy}else{$null}
[pscustomobject]@{username=$name;restored=$true;shell=$restoredShell;policyShell=if($previousPolicyPresent){$previousPolicy}else{$null};policyShellPresent=$previousPolicyPresent;legacyShell=$restoredShell;legacyShellPresent=$previousLegacyPresent;shellAssigned=$false;shellBindingVersion=2;assignmentMode='windows-dual';profile=$profile;sid=$sid;verification='verified'}|ConvertTo-Json -Compress`;
      try {
        const result = await ctx.powershell(dualScript, {
          action,
          purpose: 'restore-arcane-user-shell',
          redactArgs: true,
          displayCommand: '$ powershell.exe [restore previous dual user shell bindings]',
        });
        return JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop());
      } catch (error) {
        const readable = ctx.cleanPowerShellError(error.stderr || error.stdout || '');
        error.code = error.code === 'COMMAND_FAILED' ? 'WINDOWS_SHELL_RESTORE_FAILED' : error.code;
        error.userMessage = `Windows could not restore the previous login shell bindings for “${username}”.`;
        error.resolution = readable
          ? `${readable} Confirm the account profile is not in use, then retry from an administrator session.`
          : 'Confirm the account exists, sign it out, approve administrator access, and try again.';
        error.username = username;
        throw error;
      }
    }
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
    verifyStagedInstallation,
    releaseSecurityMode,
    listInstalledApplications,
    launchInstalledApplication,
    acquireInstallLease,
    releaseInstallLease,
    assertNoRunningInstalledApplications,
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
