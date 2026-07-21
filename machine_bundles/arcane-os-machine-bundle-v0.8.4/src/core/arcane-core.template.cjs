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

__ARCANE_NATIVE_ADAPTERS__

const VERSION = __VERSION_JSON__;
const BUNDLE_MANIFEST = __BUNDLE_MANIFEST_JSON__;
const PROTOCOL = 'arcane/1';
const argv = process.argv.slice(2);
const args = new Set(argv);
const argValue = (prefix) => {
  const value = argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
};
const appMode = argValue('--app=') || process.env.ARCANE_APP || 'provisioner';
// Simulation is an unpackaged test harness only. Native Arcane executables always
// operate against the real host and cannot be switched into simulation by an
// argument or inherited environment variable.
const simulate = !process.pkg && (args.has('--simulate') || process.env.ARCANE_SIMULATE_PROVISIONING === '1');
const simulateStandard = args.has('--simulate-standard') || process.env.ARCANE_SIMULATE_STANDARD === '1';
const hostPlatform = process.platform;
const simulationPlatformArguments = !process.pkg
  ? argv.filter((item) => item.startsWith('--simulate-platform='))
    .map((item) => item.slice('--simulate-platform='.length))
  : [];
const simulationPlatformEnvironment = !process.pkg ? String(process.env.ARCANE_SIMULATE_PLATFORM || '') : '';
if (!process.pkg && !simulate && (simulationPlatformArguments.length || simulationPlatformEnvironment)) {
  console.error('Arcane Core accepts a simulated platform only when simulation is enabled.');
  process.exit(4);
}
if (simulationPlatformArguments.length > 1) {
  console.error('Arcane Core accepts exactly one simulated platform argument.');
  process.exit(4);
}
const simulationPlatformArgument = simulationPlatformArguments[0] || '';
if (simulationPlatformArgument && simulationPlatformEnvironment
  && simulationPlatformArgument !== simulationPlatformEnvironment) {
  console.error('Arcane Core rejected conflicting simulated platform settings.');
  process.exit(4);
}
const simulatedPlatform = simulate ? simulationPlatformArgument || simulationPlatformEnvironment : '';
if (simulatedPlatform && !listSupportedCorePlatforms().includes(simulatedPlatform)) {
  console.error(`Arcane Core does not yet support ${simulatedPlatform}.`);
  process.exit(4);
}
const simulatedUserFailure = simulate ? argValue('--simulate-user-failure=') || '' : '';
const simulatedExistingUsers = simulate && !process.pkg
  ? argv.filter((item) => item.startsWith('--simulate-existing-user='))
    .map((item) => item.slice('--simulate-existing-user='.length).trim())
    .filter(Boolean)
  : [];
const simulatedLegacyArcaneUsers = simulate && !process.pkg
  ? argv.filter((item) => item.startsWith('--simulate-legacy-arcane-user='))
    .map((item) => item.slice('--simulate-legacy-arcane-user='.length).trim())
    .filter(Boolean)
  : [];
const simulatedLegacyDriftUsers = simulate && !process.pkg
  ? argv.filter((item) => item.startsWith('--simulate-legacy-drift-user='))
    .map((item) => item.slice('--simulate-legacy-drift-user='.length).trim())
    .filter(Boolean)
  : [];
const simulatedUnsignedArcaneUsers = simulate && !process.pkg
  ? argv.filter((item) => item.startsWith('--simulate-unsigned-arcane-user='))
    .map((item) => item.slice('--simulate-unsigned-arcane-user='.length).trim())
    .filter(Boolean)
  : [];
const simulatedCapabilityOverride = simulate && !process.pkg
  ? String(argValue('--simulate-capabilities=') || '').split(',').map((value) => value.trim()).filter(Boolean)
  : [];
const simulatedExclusiveMutationDelayMs = simulate && !process.pkg
  ? Math.min(5000, Math.max(0, Number(argValue('--simulate-exclusive-mutation-delay-ms=') || 0) || 0))
  : 0;
const sessionCommandSelfTest = simulate && !process.pkg ? argValue('--self-test-session-command=') || '' : '';
const platform = simulatedPlatform || hostPlatform;
const productionPackaged = Boolean(process.pkg);
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
const workerReleaseClaimArguments = argv.filter((item) => item.startsWith('--release-claims='));
const simulateBrokerFirstClient = simulate && !process.pkg && args.has('--simulate-broker-first-client');
const allowUnsignedLocalRelease = args.has('--allow-unsigned-local-release');
const elevationProtectedUsername = argValue('--protected-user=') || process.env.ARCANE_PROTECTED_USERNAME || null;
const WORKER_RELEASE_CLAIM_KEYS = Object.freeze([
  'contentBinding', 'revocationStatus', 'securityMode', 'signerThumbprint',
  'timestampVerified', 'trustSource', 'verifiedAt',
]);
function releaseClaimsDocument(claims) {
  return {
    securityMode: String(claims && claims.mode || ''),
    contentBinding: String(claims && claims.contentBinding || ''),
    signerThumbprint: String(claims && claims.signerThumbprint || ''),
    verifiedAt: String(claims && claims.verifiedAt || ''),
    revocationStatus: String(claims && claims.revocationStatus || ''),
    trustSource: String(claims && claims.trustSource || ''),
    timestampVerified: Boolean(claims && claims.timestampVerified),
  };
}
function parseWorkerReleaseClaims() {
  if (!privilegedWorker) {
    if (workerReleaseClaimArguments.length) throw new Error('Arcane accepts release-claim arguments only for a privileged worker.');
    return null;
  }
  if (workerReleaseClaimArguments.length !== 1) {
    throw new Error('Arcane privileged worker requires exactly one release-claim argument.');
  }
  const encoded = workerReleaseClaimArguments[0].slice('--release-claims='.length);
  if (!/^[A-Za-z0-9_-]{16,8192}$/.test(encoded)) throw new Error('Arcane privileged worker received malformed release claims.');
  let bytes;
  let parsed;
  try {
    bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length > 6144 || bytes.toString('base64url') !== encoded) throw new Error('non-canonical encoding');
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    throw new Error('Arcane privileged worker could not decode its release claims.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype
    || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify([...WORKER_RELEASE_CLAIM_KEYS].sort())
    || typeof parsed.securityMode !== 'string' || typeof parsed.contentBinding !== 'string'
    || typeof parsed.signerThumbprint !== 'string' || typeof parsed.verifiedAt !== 'string'
    || typeof parsed.revocationStatus !== 'string' || typeof parsed.trustSource !== 'string'
    || typeof parsed.timestampVerified !== 'boolean') {
    throw new Error('Arcane privileged worker rejected an invalid release-claim document.');
  }
  return parsed;
}
function validatedHostReleaseClaims() {
  const workerClaims = parseWorkerReleaseClaims();
  const source = workerClaims || {
    securityMode: process.env.ARCANE_RELEASE_SECURITY_MODE || '',
    contentBinding: process.env.ARCANE_RELEASE_CONTENT_BINDING || '',
    signerThumbprint: process.env.ARCANE_RELEASE_SIGNER_THUMBPRINT || '',
    verifiedAt: process.env.ARCANE_RELEASE_VERIFIED_AT || '',
    revocationStatus: process.env.ARCANE_RELEASE_REVOCATION_STATUS || '',
    trustSource: process.env.ARCANE_RELEASE_TRUST_SOURCE || '',
    timestampVerified: process.env.ARCANE_RELEASE_TIMESTAMP_VERIFIED || '',
  };
  const mode = String(source.securityMode || '');
  const contentBinding = String(source.contentBinding || '');
  const signerThumbprint = String(source.signerThumbprint || '').toUpperCase();
  const verifiedAt = String(source.verifiedAt || '');
  const revocationStatus = String(source.revocationStatus || '');
  const trustSource = String(source.trustSource || '');
  const timestampClaim = source.timestampVerified;
  const timestampVerified = workerClaims ? timestampClaim === true : String(timestampClaim || '') === '1';
  const hasPublisherEvidence = Boolean(contentBinding || signerThumbprint || verifiedAt || revocationStatus || trustSource || timestampVerified);
  if (mode === 'publisher-verified') {
    if (platform !== 'win32') throw new Error('Arcane Core does not accept publisher-verified claims from a host without a native platform verifier.');
    const bindingValid = /^ARCANE-(?:MACHINE|TARGET)-BINDING\|1\|[^|\r\n]{1,128}\|[a-f0-9]{64}$/.test(contentBinding);
    const time = new Date(verifiedAt);
    if (!bindingValid || !/^[A-F0-9]{40,128}$/.test(signerThumbprint)
      || !verifiedAt.endsWith('Z') || !Number.isFinite(time.getTime()) || time.getTime() > Date.now() + 300000
      || !['online-good', 'cache-good', 'attested-degraded'].includes(revocationStatus)
      || !['administrator-policy', 'administrator-policy-rotation', 'installed-continuity', 'uac-approved-tofu', 'fresh-unpinned'].includes(trustSource)
      || !timestampVerified) {
      throw new Error('Arcane Core rejected incomplete or malformed publisher verification claims from its native host.');
    }
    return Object.freeze({ mode, contentBinding, signerThumbprint, verifiedAt, revocationStatus, trustSource, timestampVerified: true });
  }
  if (mode === 'unsigned-local-test') {
    if (!allowUnsignedLocalRelease || hasPublisherEvidence) throw new Error('Arcane Core rejected inconsistent unsigned local-test host claims.');
    return Object.freeze({ mode, contentBinding: '', signerThumbprint: '', verifiedAt: '', revocationStatus: '', trustSource: '', timestampVerified: false });
  }
  if (hasPublisherEvidence || (productionPackaged && platform === 'win32')) {
    throw new Error('Arcane Core requires a complete release-security claim from its native Microsoft NT host.');
  }
  return Object.freeze({ mode: '', contentBinding: '', signerThumbprint: '', verifiedAt: '', revocationStatus: '', trustSource: '', timestampVerified: false });
}
const hostReleaseClaims = validatedHostReleaseClaims();
const hostReleaseClaimsDocument = Object.freeze(releaseClaimsDocument(hostReleaseClaims));
const hostReleaseClaimsEncoded = Buffer.from(canonicalJson(hostReleaseClaimsDocument), 'utf8').toString('base64url');
const hostReleaseClaimsSha256 = crypto.createHash('sha256').update(canonicalJson(hostReleaseClaimsDocument), 'utf8').digest('hex');
let simulatedInstallationManifest = null;
let simulatedArcaneUsersState = { schemaVersion: 1, users: {} };
let simulatedAppStorage = Object.create(null);
let simulatedArcaneModelSettings = { schemaVersion: 1, preference: 'auto', activeVariant: null };
let simulatedPreferences = Object.create(null);
const actions = new Map();
const recentErrors = [];
const bridgeToken = '';
const nativeContext = {
  platform,
  hostPlatform,
  appMode,
  simulate,
  simulatedPlatform,
  simulatedUserFailure,
  simulatedUserFailureTriggered: false,
  noBrowser,
  hideConsole,
  processPkg: Boolean(process.pkg),
  production:productionPackaged,
  allowUnsignedLocalRelease,
  releaseSecurityModeClaim:hostReleaseClaims.mode,
  releaseContentBindingClaim:hostReleaseClaims.contentBinding,
  releaseSignerThumbprintClaim:hostReleaseClaims.signerThumbprint,
  releaseVerifiedAtClaim:hostReleaseClaims.verifiedAt,
  releaseRevocationStatusClaim:hostReleaseClaims.revocationStatus,
  releaseTrustSourceClaim:hostReleaseClaims.trustSource,
  releaseTimestampVerifiedClaim:hostReleaseClaims.timestampVerified,
  os,
  fs,
  fsp,
  path,
  crypto,
  bundleVersion: VERSION,
  bundleManifest: BUNDLE_MANIFEST,
  spawn,
  spawnSync,
  compareVersions,
  parseCanonicalReleaseVersion,
};
const simulatedWindowsSeedUsers = [...new Set([...simulatedExistingUsers, ...simulatedLegacyArcaneUsers, ...simulatedLegacyDriftUsers, ...simulatedUnsignedArcaneUsers])];
if (platform === 'win32' && simulatedWindowsSeedUsers.length) {
  nativeContext.simulatedAccounts = new Set(simulatedWindowsSeedUsers.map((username) => username.toLowerCase()));
  nativeContext.simulatedUsers = new Map(simulatedWindowsSeedUsers.map((username) => [username.toLowerCase(), {
    username,
    enabled: true,
    policyShell: null,
    policyShellPresent: false,
    legacyShell: 'explorer.exe',
    legacyShellPresent: true,
  }]));
}
if (platform === 'linux' && simulatedExistingUsers.length) {
  nativeContext.simulatedAccounts = new Set(simulatedExistingUsers);
  nativeContext.simulatedShellAssignments = new Map();
}
const native = createCoreNativeAdapter(platform, nativeContext);
if (!native) {
  console.error(`Arcane Core does not yet support ${platform}.`);
  process.exit(4);
}
if (platform === 'win32' && (simulatedLegacyArcaneUsers.length || simulatedLegacyDriftUsers.length)) {
  for (const username of [...simulatedLegacyArcaneUsers, ...simulatedLegacyDriftUsers]) {
    const key = username.toLowerCase();
    const binding = nativeContext.simulatedUsers.get(key);
    binding.legacyShell = simulatedLegacyDriftUsers.includes(username) ? 'third-party-shell.exe' : native.shellCommand();
    binding.legacyShellPresent = true;
    simulatedArcaneUsersState.users[key] = {
      username,
      createdByArcane: false,
      previousShell: 'explorer.exe',
      previousShellPresent: true,
      previousShellCaptured: true,
      shell: native.shellCommand(),
      shellBindingVersion: 1,
      assignmentMode: 'windows-legacy',
      shellMutationPhase: 'assigned',
      accountExistedBefore: true,
      accountMutationPhase: 'existing-account',
    };
  }
}
if (platform === 'win32' && simulatedUnsignedArcaneUsers.length) {
  const signedShell = native.shellCommand();
  const unsignedShell = signedShell + ' --allow-unsigned-local-release';
  for (const username of simulatedUnsignedArcaneUsers) {
    const key = username.toLowerCase();
    const binding = nativeContext.simulatedUsers.get(key);
    binding.policyShell = unsignedShell;
    binding.policyShellPresent = true;
    binding.legacyShell = unsignedShell;
    binding.legacyShellPresent = true;
    simulatedArcaneUsersState.users[key] = {
      username,
      createdByArcane: false,
      previousShell: 'explorer.exe',
      previousShellPresent: true,
      previousPolicyShell: 'explorer.exe',
      previousPolicyShellPresent: true,
      previousLegacyShell: 'explorer.exe',
      previousLegacyShellPresent: true,
      previousShellCaptured: true,
      shell: unsignedShell,
      securityMode: 'unsigned-local-test',
      shellBindingVersion: 2,
      assignmentMode: 'windows-dual',
      shellMutationPhase: 'assigned',
      accountExistedBefore: true,
      accountMutationPhase: 'existing-account',
    };
  }
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
const APPLICATION_CATALOG_MAX_RECORDS = 64;
const RESERVED_APPLICATION_IDS = new Set(['provisioner','shell']);
const WINDOWS_RESERVED_APPLICATION_IDS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

if (appMode.length > APPLICATION_ID_MAX_LENGTH
  || !APPLICATION_ID_PATTERN.test(appMode)
  || WINDOWS_RESERVED_APPLICATION_IDS.test(appMode)) {
  console.error('Arcane Core rejected an invalid application identity before resolving app-owned data.');
  process.exit(4);
}

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
    diagnosticDetails: error && error.diagnosticDetails && typeof error.diagnosticDetails === 'object'
      ? error.diagnosticDetails
      : null,
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
function parseCanonicalReleaseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)[.](0|[1-9]\d*)[.](0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
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

function publicCurrentIdentity() {
  const identity=currentIdentity();
  return {
    identityKind:'host-account',
    username:String(identity.username || ''),
    accountName:String(identity.accountName || identity.username || ''),
    displayName:String(identity.displayName || identity.username || ''),
    source:String(identity.source || ''),
  };
}
function osInfo() { return native.osInfo(simulate); }
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
    if (integrity.scope !== 'installed-tree') throw new Error('Installed integrity scope must be installed-tree.');
    if (!fs.existsSync(root)) throw new Error('The Arcane installation directory is missing.');
    return verifyIntegrityEntries(root, integrity.files, true);
  } catch (error) {
    return { ok: false, checkedFiles: 0, reason: error.message };
  }
}
function verifyInstalledVersionIdentity(manifest, integrityResult) {
  const manifestVersion = manifest && typeof manifest.version === 'string' ? manifest.version : '';
  if (!manifestVersion) return { ok:false,version:null,reason:'Installed Arcane version metadata is missing.' };
  if (!parseCanonicalReleaseVersion(manifestVersion)) {
    return { ok:false,version:manifestVersion,reason:'Installed Arcane version metadata is not a canonical release version.' };
  }
  if (simulate) return { ok:true,version:manifestVersion,reason:null,simulated:true };
  if (!integrityResult || !integrityResult.ok) {
    try {
      if (manifest.integrity !== undefined || manifest.publisherAttestation !== undefined || manifest.securityMode !== undefined
        || compareVersions(VERSION, manifestVersion) <= 0) {
        throw new Error('Only an older pre-integrity Arcane installation can use the legacy migration path.');
      }
      if (manifest.name !== 'Arcane OS' || manifest.nativeAdapter !== native.id
        || manifest.payloadMode !== `${native.id}-executable` || !manifest.platform
        || manifest.platform.platform !== native.id) {
        throw new Error('The pre-integrity installation does not match the canonical Arcane product identity.');
      }
      const bundlePath = path.join(PATHS.installRoot, 'arcane-bundle.json');
      const releasePath = path.join(PATHS.installRoot, 'arcane-release.json');
      const bundlePresent = fs.existsSync(bundlePath);
      const releasePresent = fs.existsSync(releasePath);
      if (bundlePresent !== releasePresent) throw new Error('Legacy Arcane bundle and release identities are incomplete.');
      if (bundlePresent) {
        const bundle = readJsonFile(bundlePath);
        const release = readJsonFile(releasePath);
        if (!bundle || !release || bundle.version !== manifestVersion || release.version !== manifestVersion) {
          throw new Error('Legacy Arcane manifest, bundle, and release versions do not match.');
        }
      }
      return { ok:true,version:manifestVersion,reason:null,legacy:true };
    } catch (error) {
      return { ok:false,version:manifestVersion,reason:error.message };
    }
  }
  try {
    const paths = new Set((manifest.integrity.files || []).map((entry) => normalizeIntegrityPath(entry && entry.path)));
    if (!paths.has('arcane-bundle.json') || !paths.has('arcane-release.json')) {
      throw new Error('Installed integrity does not bind the Arcane bundle and release identities.');
    }
    const bundle = readJsonFile(path.join(PATHS.installRoot, 'arcane-bundle.json'));
    const release = readJsonFile(path.join(PATHS.installRoot, 'arcane-release.json'));
    if (!bundle || !release || typeof bundle.version !== 'string' || typeof release.version !== 'string'
      || bundle.version !== manifestVersion || release.version !== manifestVersion) {
      throw new Error('Installed Arcane manifest, bundle, and release versions do not match.');
    }
    parseVersion(bundle.version);
    return { ok:true,version:manifestVersion,reason:null };
  } catch (error) {
    return { ok:false,version:manifestVersion,reason:error.message };
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
    } catch (_) { /* Directory fsync is not available on every Microsoft NT filesystem. */ }
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
function preferencesFile() {
  const base = platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'Arcane OS', 'apps', appMode, 'preferences.json');
}
function readPreferences() {
  if (simulate) return { ...simulatedPreferences };
  const state = readJsonFile(preferencesFile());
  if (!state || state.schemaVersion !== 1 || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) {
    return Object.create(null);
  }
  return { ...state.entries };
}
async function writePreferences(entries) {
  const payload = storagePayload(entries);
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > APP_STORAGE_TOTAL_MAX_BYTES) {
    throw arcaneError('PREFERENCES_QUOTA_EXCEEDED', 'Arcane preferences have reached their storage limit.', 'Remove an unused preference and try again.', 413, { maximumBytes: APP_STORAGE_TOTAL_MAX_BYTES, actualBytes: bytes });
  }
  if (simulate) { simulatedPreferences = { ...entries }; return bytes; }
  const target = preferencesFile();
  await ensureDir(path.dirname(target));
  await durableWriteFile(target, payload, 0o600);
  return bytes;
}
function listPreferences() {
  const entries = readPreferences();
  return { keys: Object.keys(entries).sort(), usedBytes: Buffer.byteLength(storagePayload(entries), 'utf8'), maximumBytes: APP_STORAGE_TOTAL_MAX_BYTES };
}
function getPreference(keyInput) {
  const key = validateStorageKey(keyInput);
  const entries = readPreferences();
  const found = Object.prototype.hasOwnProperty.call(entries, key);
  return { key, found, value: found ? entries[key] : null };
}
async function setPreference(keyInput, inputValue) {
  const key = validateStorageKey(keyInput);
  const normalized = normalizeStorageValue(inputValue);
  return withAppStorageMutation(async () => {
    const entries = readPreferences();
    entries[key] = normalized.value;
    const totalBytes = await writePreferences(entries);
    return { key, value: normalized.value, bytes: normalized.bytes, totalBytes, maximumBytes: APP_STORAGE_TOTAL_MAX_BYTES };
  });
}
async function deletePreference(keyInput) {
  const key = validateStorageKey(keyInput);
  return withAppStorageMutation(async () => {
    const entries = readPreferences();
    const deleted = Object.prototype.hasOwnProperty.call(entries, key);
    if (deleted) delete entries[key];
    const totalBytes = deleted ? await writePreferences(entries) : Buffer.byteLength(storagePayload(entries), 'utf8');
    return { key, deleted, totalBytes, maximumBytes: APP_STORAGE_TOTAL_MAX_BYTES };
  });
}
function shellRecoveryDescriptor(record, phaseOverride) {
  const source = record && typeof record === 'object' ? record : {};
  return {
    previousShell: source.previousShell ?? null,
    previousShellPresent: Boolean(source.previousShellPresent),
    previousPolicyShell: source.previousPolicyShell ?? null,
    previousPolicyShellPresent: Boolean(source.previousPolicyShellPresent),
    previousLegacyShell: source.previousLegacyShell ?? null,
    previousLegacyShellPresent: Boolean(source.previousLegacyShellPresent),
    shellBindingVersion: Number(source.shellBindingVersion) || 1,
    assignmentMode: source.assignmentMode || (native.id === 'windows' ? 'windows-legacy' : 'linux-login-shell'),
    shellMutationPhase: phaseOverride || source.shellMutationPhase || 'assigned',
    shell: typeof source.shell === 'string' && source.shell ? source.shell : null,
    sid: typeof source.sid === 'string' && source.sid ? source.sid : null,
    uid: Number.isSafeInteger(source.uid) && source.uid >= 0 ? source.uid : null,
    securityMode: ['publisher-verified','unsigned-local-test'].includes(source.securityMode) ? source.securityMode : null,
  };
}
function hasStableAccountIdentity(record) {
  if (!record || typeof record !== 'object') return false;
  if (native.id === 'windows') return typeof record.sid === 'string' && Boolean(record.sid);
  if (native.id === 'linux') return Number.isSafeInteger(record.uid) && record.uid >= 0;
  return false;
}
function isCompleteWindowsDualBackup(backup) {
  return Boolean(backup && Number(backup.shellBindingVersion) === 2 && backup.assignmentMode === 'windows-dual');
}
function backupAlreadyUsesArcane(backup) {
  const expected = native.shellCommand();
  if (native.id === 'windows') {
    return Boolean(
      isCompleteWindowsDualBackup(backup)
      && backup.previousPolicyShellPresent
      && backup.previousLegacyShellPresent
      && backup.previousPolicyShell === expected
      && backup.previousLegacyShell === expected
    );
  }
  return Boolean(backup && backup.previousShellPresent && backup.previousShell === expected);
}
function arcaneUserRestoreStatus(user, record) {
  const preparedExistingRecovery = Boolean(
    record
    && record.previousShellCaptured
    && record.accountExistedBefore === true
    && record.shellMutationPhase === 'prepared'
  );
  const incompleteNewAccount = Boolean(
    record
    && record.accountExistedBefore === false
    && ['prepared', 'activation-pending', 'cleanup-required'].includes(record.accountMutationPhase)
  );
  const restoreRequiresElevatedVerification = Boolean(
    record
    && record.previousShellCaptured
    && user.verification === 'recorded-only'
    && (preparedExistingRecovery || (
      record.shellMutationPhase === 'assigned'
      && ['active', 'existing-account'].includes(record.accountMutationPhase)
    ))
  );
  return {
    canRestoreShell: Boolean(record && record.previousShellCaptured && !incompleteNewAccount
      && (user.shellAssigned || preparedExistingRecovery || restoreRequiresElevatedVerification)),
    restoreRequiresElevatedVerification,
  };
}
async function listArcaneUsers() {
  const state = readArcaneUsersState();
  const records = Object.values(state.users || {});
  const nativeUsers = await native.listArcaneUsers(records.map((item) => item.username));
  return nativeUsers.map((user) => {
    const record = state.users[String(user.username || '').toLowerCase()] || null;
    const restoreStatus = arcaneUserRestoreStatus(user, record);
    return {
      ...user,
      managedByArcane: Boolean(record),
      createdByArcane: record ? Boolean(record.createdByArcane) : null,
      passwordStatus: record && record.passwordStatus ? record.passwordStatus : 'unknown',
      provisionedAt: record && record.provisionedAt ? record.provisionedAt : null,
      passwordChangedAt: record && record.passwordChangedAt ? record.passwordChangedAt : null,
      previousShell: record && record.previousShellPresent ? record.previousShell || null : null,
      previousShellPresent: record ? Boolean(record.previousShellPresent) : false,
      previousPolicyShell: record && record.previousPolicyShellPresent ? record.previousPolicyShell ?? null : null,
      previousPolicyShellPresent: record ? Boolean(record.previousPolicyShellPresent) : false,
      previousLegacyShell: record && record.previousLegacyShellPresent ? record.previousLegacyShell ?? null : null,
      previousLegacyShellPresent: record ? Boolean(record.previousLegacyShellPresent) : false,
      recordedShellBindingVersion: record ? Number(record.shellBindingVersion) || 1 : null,
      recordedAssignmentMode: record && record.assignmentMode ? record.assignmentMode : null,
      recordedSecurityMode: record && record.securityMode ? record.securityMode : null,
      canRestoreShell: restoreStatus.canRestoreShell,
      restoreRequiresElevatedVerification: restoreStatus.restoreRequiresElevatedVerification,
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
  const installedIdentity = installedVersion
    ? verifyInstalledVersionIdentity(manifest, installedIntegrity)
    : { ok:false,version:null,reason:'Arcane is not installed.' };
  const comparison = installedVersion && installedIdentity.ok ? compareVersions(VERSION, installedIdentity.version) : 1;
  const installedReleaseEntry = manifest && manifest.integrity && Array.isArray(manifest.integrity.files)
    ? manifest.integrity.files.find((entry) => entry && entry.path === 'arcane-release.json')
    : null;
  const candidateReleaseEntry = payload && payload.integrity && Array.isArray(payload.integrity.files)
    ? payload.integrity.files.find((entry) => entry && entry.installPath === 'arcane-release.json')
    : null;
  const candidatePayloadDiffers = Boolean(
    comparison === 0
    && installedReleaseEntry && candidateReleaseEntry
    && installedReleaseEntry.sha256 !== candidateReleaseEntry.sha256
  );
  const identityRepairRequired = Boolean(installedVersion && !installedIdentity.ok);
  const downgradeBlocked = Boolean(installedVersion && installedIdentity.ok && comparison < 0);
  const payloadRepairRequired = Boolean(
    installedVersion
    && installedIdentity.ok
    && comparison === 0
    && payload.releaseReady
    && (installedPayloadMode !== payload.mode || !installedIntegrity.ok || candidatePayloadDiffers)
  );
  const repairRequired = Boolean(identityRepairRequired || payloadRepairRequired);
  const disposition = !installedVersion
    ? 'missing'
    : downgradeBlocked
      ? 'downgrade-blocked'
      : repairRequired
        ? 'repair-required'
        : comparison > 0
          ? 'update-available'
          : 'current';
  return {
    present: Boolean(installedVersion),
    installedVersion,
    packageVersion: VERSION,
    blocked: downgradeBlocked,
    blockedReason: downgradeBlocked ? 'downgrade' : null,
    repairRequired,
    repairReason: identityRepairRequired ? 'identity-invalid' : payloadRepairRequired ? 'payload-invalid' : null,
    disposition,
    action: !installedVersion ? 'install' : downgradeBlocked ? 'blocked' : repairRequired ? 'repair' : comparison > 0 ? 'update' : 'current',
    installRoot: PATHS.installRoot,
    stateRoot: PATHS.stateRoot,
    manifest,
    installedPayloadMode,
    installedIntegrity,
    installedIdentity,
    identityRepairRequired,
    payloadRepairRequired,
    candidatePayloadDiffers,
    payload: payloadStatus,
  };
}
function assertChangesAllowed(options) {
  const state = installationState();
  const allowIdentityRepair = Boolean(options && options.allowIdentityRepair);
  if (state.present && !state.installedIdentity.ok && !allowIdentityRepair) {
    throw arcaneError(
      'INSTALL_IDENTITY_INVALID',
      'Arcane cannot trust the installed release identity.',
      'Preserve the installation for administrator review, then repair it from a complete verified release before making changes.',
      409,
      { reason:state.installedIdentity.reason }
    );
  }
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
function boundedSpawnSync(command, commandArgs, options) {
  const opts = options || {};
  return spawnSync(command, commandArgs || [], {
    cwd: opts.cwd || safeSubprocessCwd,
    env: opts.env || safeSubprocessEnvironment,
    encoding: opts.encoding || 'utf8',
    windowsHide: opts.windowsHide !== false,
    shell: false,
    timeout: Math.min(30000, Math.max(1000, Number(opts.timeout || 10000))),
    maxBuffer: Math.min(4 * 1024 * 1024, Math.max(64 * 1024, Number(opts.maxBuffer || 1024 * 1024))),
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
const OLLAMA_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const OLLAMA_STREAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OLLAMA_OPERATION_DEFINITIONS = Object.freeze({
  version: Object.freeze({ method:'GET',path:'/api/version',capability:'read',timeoutMs:5000 }),
  models: Object.freeze({ method:'GET',path:'/api/tags',capability:'read',timeoutMs:10000 }),
  running: Object.freeze({ method:'GET',path:'/api/ps',capability:'read',timeoutMs:10000 }),
  show: Object.freeze({ method:'POST',path:'/api/show',capability:'read',fields:['model','verbose'],modelField:'model',timeoutMs:30000 }),
  generate: Object.freeze({ method:'POST',path:'/api/generate',capability:'inference',fields:['model','prompt','suffix','images','format','options','system','template','context','raw','keep_alive','think','logprobs','top_logprobs'],modelField:'model',streamable:true,timeoutMs:10*60*1000 }),
  chat: Object.freeze({ method:'POST',path:'/api/chat',capability:'inference',fields:['model','messages','tools','format','options','keep_alive','think','logprobs','top_logprobs'],modelField:'model',streamable:true,timeoutMs:10*60*1000 }),
  embed: Object.freeze({ method:'POST',path:'/api/embed',capability:'inference',fields:['model','input','truncate','dimensions','keep_alive','options'],modelField:'model',timeoutMs:10*60*1000 }),
  pull: Object.freeze({ method:'POST',path:'/api/pull',capability:'manage',fields:['model','insecure'],modelField:'model',streamable:true,timeoutMs:50*60*1000 }),
  push: Object.freeze({ method:'POST',path:'/api/push',capability:'manage',fields:['model','insecure'],modelField:'model',streamable:true,timeoutMs:50*60*1000 }),
  create: Object.freeze({ method:'POST',path:'/api/create',capability:'manage',fields:['model','from','files','adapters','template','license','system','parameters','messages','quantize'],modelField:'model',streamable:true,timeoutMs:50*60*1000 }),
  copy: Object.freeze({ method:'POST',path:'/api/copy',capability:'manage',fields:['source','destination'],modelFields:['source','destination'],timeoutMs:2*60*1000 }),
  delete: Object.freeze({ method:'DELETE',path:'/api/delete',capability:'manage',fields:['model'],modelField:'model',timeoutMs:2*60*1000 }),
});
function normalizedOllamaOperation(operation, parameters) {
  const definition=OLLAMA_OPERATION_DEFINITIONS[operation];
  if(!definition)throw arcaneError('INVALID_OLLAMA_OPERATION','Arcane rejected an unsupported Ollama operation.','Use a documented Arcane.ollama method.',400);
  const input=parameters===undefined||parameters===null?{}:parameters;
  if(typeof input!=='object'||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype){
    throw arcaneError('INVALID_OLLAMA_REQUEST','Arcane rejected an invalid Ollama request.','Pass a plain request object.',400);
  }
  const stream=Boolean(input.stream);
  const streamId=input.streamId===undefined?null:String(input.streamId);
  const allowed=new Set([...(definition.fields||[]),'stream','streamId']);
  if(Object.keys(input).some((key)=>!allowed.has(key))){
    throw arcaneError('INVALID_OLLAMA_REQUEST','Arcane rejected unsupported Ollama request fields.','Use only fields documented for this Arcane.ollama method.',400,{ operation,allowedFields:[...(definition.fields||[])] });
  }
  if(stream&&!definition.streamable)throw arcaneError('OLLAMA_STREAM_UNSUPPORTED','That Ollama operation does not stream.','Call the method without a chunk callback.',400,{ operation });
  if(stream&&(!streamId||!OLLAMA_STREAM_ID_PATTERN.test(streamId)))throw arcaneError('INVALID_OLLAMA_STREAM','Arcane rejected an invalid Ollama stream identifier.','Use the Arcane Ollama module to start streams.',400);
  const payload={};
  for(const field of definition.fields||[])if(input[field]!==undefined)payload[field]=input[field];
  const modelFields=definition.modelFields||[definition.modelField].filter(Boolean);
  for(const field of modelFields){
    if(!OLLAMA_MODEL_PATTERN.test(String(payload[field]||'')))throw arcaneError('INVALID_AI_MODEL','Choose a valid Ollama model name.','Use a model returned by Arcane.ollama.models().',400,{ field });
    payload[field]=String(payload[field]);
  }
  const forwardedPayload={ ...payload,...(definition.streamable?{ stream }: {}) };
  let encoded;
  try{encoded=Buffer.from(JSON.stringify(forwardedPayload));}
  catch(_){throw arcaneError('INVALID_OLLAMA_REQUEST','Arcane could not serialize the Ollama request.','Use JSON-compatible request values.',400);}
  if(encoded.length>8*1024*1024)throw arcaneError('OLLAMA_REQUEST_TOO_LARGE','The Ollama request exceeds 8 MiB.','Reduce the prompt, images, files, or model definition.',413);
  return { definition,payload:forwardedPayload,stream,streamId,encoded };
}
const simulatedOllamaModels=new Set();
function simulatedOllamaResponse(operation,payload){
  if(operation==='models')return { models:[...simulatedOllamaModels].map((name)=>({ name,model:name })) };
  if(operation==='running')return { models:[] };
  if(operation==='version')return { version:'simulated' };
  if(operation==='embed')return { model:payload.model,embeddings:[[0]],prompt_eval_count:1 };
  if(operation==='chat')return { model:payload.model,message:{ role:'assistant',content:'Simulated Arcane Ollama response.' },done:true };
  if(operation==='generate')return { model:payload.model,response:'Simulated Arcane Ollama response.',done:true };
  if(operation==='pull'&&payload.model)simulatedOllamaModels.add(payload.model.includes(':')?payload.model:`${payload.model}:latest`);
  if(operation==='create'&&payload.model)simulatedOllamaModels.add(payload.model.includes(':')?payload.model:`${payload.model}:latest`);
  if(operation==='copy'&&payload.destination)simulatedOllamaModels.add(payload.destination.includes(':')?payload.destination:`${payload.destination}:latest`);
  if(operation==='delete'&&payload.model)simulatedOllamaModels.delete(payload.model.includes(':')?payload.model:`${payload.model}:latest`);
  return { status:'success',model:payload.model||null };
}
function requestLocalOllama(operation,parameters,hooks) {
  const normalized=normalizedOllamaOperation(operation,parameters);
  const { definition,payload,stream,streamId,encoded }=normalized;
  if(simulate){
    const result=simulatedOllamaResponse(operation,payload);
    if(stream){
      emitEvent('ollama.chunk',{ streamId,operation,chunk:result });
      if(hooks&&typeof hooks.onChunk==='function')hooks.onChunk(result);
    }
    return Promise.resolve(result);
  }
  return new Promise((resolve,reject)=>{
    const fail=(message,details,status)=>reject(arcaneError('LOCAL_OLLAMA_REQUEST_FAILED',message,'Verify the model name and that the ArcaneOllama service is running, then retry.',status||503,{ retryable:(status||503)>=500,operation,...(details||{}) }));
    const options={ hostname:'127.0.0.1',port:11434,path:definition.path,method:definition.method,headers:{ Accept:stream?'application/x-ndjson':'application/json','User-Agent':`Arcane-Core/${VERSION}` },agent:false };
    if(definition.method!=='GET')Object.assign(options.headers,{ 'Content-Type':'application/json','Content-Length':encoded.length });
    const request=http.request(options,(response)=>{
      let body='';let received=0;let lastChunk=null;
      response.setEncoding('utf8');
      response.on('data',(chunk)=>{
        received+=Buffer.byteLength(chunk);
        if(received>12*1024*1024){response.destroy(new Error('ArcaneOllama response exceeded 12 MiB.'));return;}
        body+=chunk;
        if(stream&&response.statusCode>=200&&response.statusCode<300){
          const lines=body.split(/\r?\n/);body=lines.pop()||'';
          for(const line of lines){if(!line.trim())continue;try{lastChunk=JSON.parse(line);emitEvent('ollama.chunk',{ streamId,operation,chunk:lastChunk });if(hooks&&typeof hooks.onChunk==='function')hooks.onChunk(lastChunk);}catch(_){response.destroy(new Error('ArcaneOllama returned invalid streaming JSON.'));return;}}
        }
      });
      response.on('end',()=>{
        if(response.statusCode<200||response.statusCode>=300){let serviceMessage=null;try{serviceMessage=JSON.parse(body).error||null;}catch(_){}fail(serviceMessage?`ArcaneOllama: ${String(serviceMessage).slice(0,512)}`:`ArcaneOllama returned HTTP ${response.statusCode}.`,{ status:response.statusCode },response.statusCode);return;}
        if(stream&&body.trim()){try{lastChunk=JSON.parse(body);emitEvent('ollama.chunk',{ streamId,operation,chunk:lastChunk });if(hooks&&typeof hooks.onChunk==='function')hooks.onChunk(lastChunk);}catch(_){fail('ArcaneOllama returned invalid streaming JSON.');return;}}
        if(stream){resolve(lastChunk||{ status:'complete' });return;}
        if(!body.trim()){resolve({ status:'success' });return;}
        try{resolve(JSON.parse(body));}catch(_){fail('ArcaneOllama returned invalid JSON.');}
      });
    });
    request.setTimeout(definition.timeoutMs,()=>request.destroy(new Error('ArcaneOllama request timed out.')));
    request.on('error',(error)=>fail('Arcane could not complete the managed Ollama request.',{ reason:error&&error.message||String(error) }));
    if(definition.method!=='GET')request.end(encoded);else request.end();
  });
}
function getLocalOllamaJson(requestPath) {
  const operation=requestPath==='/api/tags'?'models':requestPath==='/api/ps'?'running':requestPath==='/api/version'?'version':null;
  return requestLocalOllama(operation,{});
}
async function listLocalModels() {
  const payload = await getLocalOllamaJson('/api/tags');
  const models = Array.isArray(payload && payload.models) ? payload.models : [];
  return {
    provider: 'arcane-ollama',
    models: models.slice(0, 512).map((model) => Object.freeze({
      name: String(model && (model.name || model.model) || '').slice(0, 256),
      modifiedAt: model && model.modified_at ? String(model.modified_at).slice(0, 64) : null,
      sizeBytes: Number.isSafeInteger(model && model.size) && model.size >= 0 ? model.size : null,
      digest: /^[a-f0-9]{64}$/i.test(String(model && model.digest || '')) ? String(model.digest).toLowerCase() : null,
      family: model && model.details && model.details.family ? String(model.details.family).slice(0, 128) : null,
      parameterSize: model && model.details && model.details.parameter_size ? String(model.details.parameter_size).slice(0, 64) : null,
      quantization: model && model.details && model.details.quantization_level ? String(model.details.quantization_level).slice(0, 64) : null,
    })).filter((model) => model.name),
  };
}
function canonicalOllamaModelName(input){
  const value=String(input||'').trim().toLowerCase();
  return value.includes(':')?value:`${value}:latest`;
}
function ollamaModelPresent(payload,name){
  const wanted=canonicalOllamaModelName(name);
  return (Array.isArray(payload&&payload.models)?payload.models:[]).some((model)=>canonicalOllamaModelName(model&&(model.name||model.model))===wanted);
}
const ARCANE_MODEL_VARIANTS=Object.freeze({
  '20b':Object.freeze({ name:'arcane:20b',file:'Arcane-20B.Modelfile' }),
  '120b':Object.freeze({ name:'arcane:120b',file:'Arcane-120B.Modelfile' }),
});
const ARCANE_MODEL_ALIAS='arcane:latest';
const ARCANE_120B_GPU_BYTES=80_000_000_000;
function readManagedArcaneModelDefinitions(){
  const root=bundleRoot();
  return Object.freeze(Object.fromEntries(Object.entries(ARCANE_MODEL_VARIANTS).map(([variant,descriptor])=>{
    const candidates=[
      path.join(root,'app','shared',descriptor.file),
      path.join(root,'dist','app','shared',descriptor.file),
      path.join(root,'app','arcane','models',descriptor.file),
    ];
    const modelFile=candidates.find((candidate)=>{
      try{const stat=fs.lstatSync(candidate);return stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=256*1024;}catch(_){return false;}
    });
    if(!modelFile)throw arcaneError('ARCANE_MODELFILE_MISSING',`The verified Arcane ${variant.toUpperCase()} model definition is missing.`,'Repair Arcane OS from a complete verified release, then retry.',500,{ variant });
    const source=fs.readFileSync(modelFile,'utf8');
    const match=source.match(/^FROM ([A-Za-z0-9][A-Za-z0-9._:/-]{0,255})\r?\n\r?\nSYSTEM """\r?\n([\s\S]+?)\r?\n"""\r?\n?$/);
    if(!match)throw arcaneError('ARCANE_MODELFILE_INVALID',`The verified Arcane ${variant.toUpperCase()} model definition is invalid.`,'Repair Arcane OS from a complete verified release, then retry.',500,{ variant });
    return [variant,Object.freeze({ variant,name:descriptor.name,from:match[1],system:match[2],source:modelFile })];
  })));
}
function managedOllamaModelsRoot(){
  return typeof native.ollamaModelsRoot==='function'?native.ollamaModelsRoot():null;
}
function arcaneModelSettingsFile(){
  const base=platform==='win32'
    ? process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local')
    : process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config');
  return path.join(base,'Arcane OS','settings.json');
}
function normalizedArcaneModelPreference(value){
  const preference=String(value||'auto').trim().toLowerCase();
  if(!['auto','20b','120b'].includes(preference))throw arcaneError('INVALID_ARCANE_MODEL_PREFERENCE','Choose Automatic, 20B, or 120B.','Select one of the Arcane model options shown in Settings.',400,{ field:'preference',input:value });
  return preference;
}
function normalizedArcaneAISettings(input,current){
  const source=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
  const prior=current&&typeof current==='object'?current:{};
  const preference=normalizedArcaneModelPreference(source.preference!==undefined?source.preference:prior.preference);
  const activeVariant=source.activeVariant!==undefined?source.activeVariant:prior.activeVariant||null;
  if(activeVariant!==null&&!['20b','120b'].includes(activeVariant))throw arcaneError('INVALID_ARCANE_MODEL_STATE','Arcane rejected an invalid active model state.','Retry the model selection from Settings.',400);
  const defaultModel=String(source.defaultModel!==undefined?source.defaultModel:prior.defaultModel||ARCANE_MODEL_ALIAS).trim();
  if(!OLLAMA_MODEL_PATTERN.test(defaultModel))throw arcaneError('INVALID_AI_MODEL','Choose a valid default Ollama model.','Select an installed model returned by Arcane.',400,{ field:'defaultModel' });
  const contextLength=Number(source.contextLength!==undefined?source.contextLength:prior.contextLength||0);
  if(!Number.isSafeInteger(contextLength)||(contextLength!==0&&(contextLength<1024||contextLength>262144)))throw arcaneError('INVALID_OLLAMA_CONTEXT','Context length must be Automatic or between 1,024 and 262,144 tokens.','Choose a bounded context length that fits the available GPU memory.',400);
  const bootKeepAlive=String(source.bootKeepAlive!==undefined?source.bootKeepAlive:prior.bootKeepAlive||'-1');
  if(!['5m','30m','1h','24h','-1'].includes(bootKeepAlive))throw arcaneError('INVALID_OLLAMA_KEEP_ALIVE','Choose a supported model keep-alive duration.','Use 5m, 30m, 1h, 24h, or keep loaded.',400);
  const provider=String(source.provider!==undefined?source.provider:prior.provider||'ollama').trim().toLowerCase();
  if(!['ollama','openai'].includes(provider))throw arcaneError('INVALID_AI_PROVIDER','Choose Ollama or OpenAI as the Arcane brain provider.','Select a provider shown in Arcane Settings.',400);
  const openAIModel=String(source.openAIModel!==undefined?source.openAIModel:prior.openAIModel||'').trim();
  if(openAIModel&&!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(openAIModel))throw arcaneError('INVALID_OPENAI_MODEL','Choose a valid OpenAI model identifier.','Select a model returned by your OpenAI account.',400);
  return { schemaVersion:3,preference,activeVariant,defaultModel,bootLoad:source.bootLoad!==undefined?Boolean(source.bootLoad):prior.bootLoad!==false,bootKeepAlive,contextLength,provider,openAIModel };
}
function ollamaKeepAliveValue(value){return String(value)==='-1'?-1:String(value);}
function readArcaneModelSettings(){
  if(simulate)return normalizedArcaneAISettings(simulatedArcaneModelSettings,{});
  const state=readJsonFile(arcaneModelSettingsFile());
  try{return normalizedArcaneAISettings(state||{},{});}catch(_){return normalizedArcaneAISettings({},{});}
}
async function writeArcaneModelSettings(patch){
  const current=readArcaneModelSettings();
  const state={ ...normalizedArcaneAISettings(patch,current),updatedAt:stamp() };
  if(simulate){simulatedArcaneModelSettings={ ...state };return state;}
  const target=arcaneModelSettingsFile();
  await ensureDir(path.dirname(target));
  const temporary=`${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(temporary,JSON.stringify(state),{ mode:0o600,flag:'wx' });
  try{await fsp.rename(temporary,target);}catch(error){await fsp.rm(temporary,{ force:true }).catch(()=>{});throw error;}
  return state;
}
function managedArcaneGpuInfo(){
  let hardware={ devices:[],totalMemoryBytes:null,memoryReliable:false,source:'unavailable' };
  try{if(typeof native.gpuInfo==='function')hardware=native.gpuInfo()||hardware;}catch(error){log('Arcane GPU inventory failed.',{ message:error&&error.message||String(error) });}
  const devices=(Array.isArray(hardware.devices)?hardware.devices:[]).slice(0,16).map((device)=>Object.freeze({ name:String(device&&device.name||'GPU').slice(0,256),memoryBytes:Number.isSafeInteger(device&&device.memoryBytes)&&device.memoryBytes>0?device.memoryBytes:null }));
  const largestMemoryBytes=devices.reduce((largest,device)=>Math.max(largest,device.memoryBytes||0),0)||null;
  return Object.freeze({ devices,totalMemoryBytes:Number.isSafeInteger(hardware.totalMemoryBytes)&&hardware.totalMemoryBytes>0?hardware.totalMemoryBytes:null,largestMemoryBytes,memoryReliable:Boolean(hardware.memoryReliable&&largestMemoryBytes),source:String(hardware.source||'unavailable').slice(0,64) });
}
function managedArcaneModelSelection(){
  const settings=readArcaneModelSettings();
  const gpu=managedArcaneGpuInfo();
  const recommendedVariant=gpu.memoryReliable&&gpu.largestMemoryBytes>=ARCANE_120B_GPU_BYTES?'120b':'20b';
  const effectiveVariant=settings.preference==='auto'?recommendedVariant:settings.preference;
  return Object.freeze({ preference:settings.preference,recommendedVariant,effectiveVariant,model:ARCANE_MODEL_VARIANTS[effectiveVariant].name,alias:ARCANE_MODEL_ALIAS,activeVariant:settings.activeVariant,defaultModel:settings.defaultModel,bootLoad:settings.bootLoad,bootKeepAlive:settings.bootKeepAlive,contextLength:settings.contextLength,provider:settings.provider,openAIModel:settings.openAIModel,openAIConfigured:typeof native.hasAIProviderCredential==='function'&&native.hasAIProviderCredential('openai'),gpu,minimum120bGpuBytes:ARCANE_120B_GPU_BYTES });
}
async function ensureManagedArcaneModelOnce(action,requestedSelection){
  const selection=requestedSelection||managedArcaneModelSelection();
  const definition=readManagedArcaneModelDefinitions()[selection.effectiveVariant];
  actionStep(action,74,`Checking the managed Arcane ${selection.effectiveVariant.toUpperCase()} Ollama modelâ€¦`);
  let models=await requestLocalOllama('models',{});
  let created=false;
  if(!ollamaModelPresent(models,definition.name)&&!ollamaModelPresent(models,definition.from)){
    let lastProgress=-1;
    let lastStatus='';
    actionStep(action,76,`Downloading ${definition.from} for Arcane ${selection.effectiveVariant.toUpperCase()}â€¦`);
    await requestLocalOllama('pull',{ model:definition.from,stream:true,streamId:`arcane-base-${action.id}` },{
      onChunk(chunk){
        const completed=Number(chunk&&chunk.completed);
        const total=Number(chunk&&chunk.total);
        const status=String(chunk&&chunk.status||'Downloading model data');
        const ratio=Number.isFinite(completed)&&Number.isFinite(total)&&total>0?Math.max(0,Math.min(1,completed/total)):null;
        const progress=ratio===null?lastProgress:Math.round(76+ratio*15);
        if(progress>=0&&progress!==lastProgress){lastProgress=progress;actionStep(action,progress,`${status} (${Math.round(ratio*100)}%)`);}
        else if(status&&status!==lastStatus){lastStatus=status;actionLog(action,'info',status);}
      },
    });
  }else if(!ollamaModelPresent(models,definition.name))actionLog(action,'info',`${definition.from} is already present; no base-model download is needed.`);
  models=await requestLocalOllama('models',{});
  if(!ollamaModelPresent(models,definition.name)){
    actionStep(action,92,`Creating ${definition.name} from the verified Arcane ${selection.effectiveVariant.toUpperCase()} Modelfileâ€¦`);
    let lastCreateStatus='';
    await requestLocalOllama('create',{ model:definition.name,from:definition.from,system:definition.system,stream:true,streamId:`arcane-create-${action.id}` },{
      onChunk(chunk){const status=String(chunk&&chunk.status||'Creating Arcane model');if(status!==lastCreateStatus){lastCreateStatus=status;actionLog(action,'info',status);}},
    });
    created=true;
    models=await requestLocalOllama('models',{});
  }
  if(!ollamaModelPresent(models,definition.name))throw arcaneError('ARCANE_MODEL_VERIFY_FAILED',`ArcaneOllama completed the model build, but ${definition.name} was not found.`,'Check the ArcaneOllama service logs and global model-store permissions, then retry.',500,{ modelsRoot:managedOllamaModelsRoot() });
  const settings=readArcaneModelSettings();
  if(settings.activeVariant!==selection.effectiveVariant||!ollamaModelPresent(models,ARCANE_MODEL_ALIAS)){
    actionStep(action,96,`Selecting Arcane ${selection.effectiveVariant.toUpperCase()} as ${ARCANE_MODEL_ALIAS}â€¦`);
    await requestLocalOllama('copy',{ source:definition.name,destination:ARCANE_MODEL_ALIAS });
    await writeArcaneModelSettings({ activeVariant:selection.effectiveVariant });
    models=await requestLocalOllama('models',{});
  }
  if(!ollamaModelPresent(models,ARCANE_MODEL_ALIAS))throw arcaneError('ARCANE_MODEL_ALIAS_FAILED',`ArcaneOllama did not expose ${ARCANE_MODEL_ALIAS} after selection.`,'Check the ArcaneOllama service logs, then retry the selection.',500);
  actionStep(action,98,`Arcane ${selection.effectiveVariant.toUpperCase()} is selected and ready.`);
  actionLog(action,'info',`${definition.name} is ready and selected as ${ARCANE_MODEL_ALIAS}.`,{ model:definition.name,alias:ARCANE_MODEL_ALIAS,preference:selection.preference,recommendedVariant:selection.recommendedVariant,modelsRoot:managedOllamaModelsRoot(),modelFile:definition.source });
  return Object.freeze({ model:definition.name,alias:ARCANE_MODEL_ALIAS,variant:selection.effectiveVariant,preference:selection.preference,recommendedVariant:selection.recommendedVariant,created,baseModel:definition.from,modelsRoot:managedOllamaModelsRoot(),gpu:selection.gpu });
}
let managedArcaneModelEnsurePromise=null;
function ensureManagedArcaneModel(action,selection){
  if(!managedArcaneModelEnsurePromise){
    managedArcaneModelEnsurePromise=ensureManagedArcaneModelOnce(action,selection).finally(()=>{managedArcaneModelEnsurePromise=null;});
  }else actionLog(action,'info','Another Arcane model check is already running in this Core process; waiting for it to finish.');
  return managedArcaneModelEnsurePromise;
}
async function setManagedArcaneModelPreference(action,preference){
  await writeArcaneModelSettings({ preference:normalizedArcaneModelPreference(preference) });
  const selection=managedArcaneModelSelection();
  return ensureManagedArcaneModel(action,selection);
}
async function setManagedArcaneAISettings(action,parameters){
  const next=normalizedArcaneAISettings(parameters,readArcaneModelSettings());
  const models=await requestLocalOllama('models',{});
  if(!ollamaModelPresent(models,next.defaultModel))throw arcaneError('DEFAULT_MODEL_NOT_INSTALLED',`The default model ${next.defaultModel} is not installed.`,'Pull it or create an Arcane brain from that base model first.',404,{ model:next.defaultModel });
  await writeArcaneModelSettings(next);
  if(next.bootLoad){
    actionStep(action,92,`Loading ${next.defaultModel} with the saved context settings…`);
    await requestLocalOllama('generate',{ model:next.defaultModel,prompt:'',keep_alive:ollamaKeepAliveValue(next.bootKeepAlive),...(next.contextLength?{options:{num_ctx:next.contextLength}}:{}) });
  }
  actionStep(action,98,'Arcane AI settings saved.');
  return managedArcaneModelSelection();
}
async function createManagedArcaneBrain(action,parameters){
  const baseModel=String(parameters&&parameters.baseModel||'').trim();
  if(!OLLAMA_MODEL_PATTERN.test(baseModel))throw arcaneError('INVALID_AI_MODEL','Enter a valid Ollama base-model name.','Use a name such as llama3.3:70b or gemma3:27b.',400,{ field:'baseModel' });
  const slug=String(parameters&&parameters.name||'my-brain').trim().toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64);
  if(!slug)throw arcaneError('INVALID_ARCANE_BRAIN_NAME','Enter a name for this Arcane brain.','Use letters, numbers, spaces, periods, underscores, or hyphens.',400);
  const model=`arcane-${slug}:latest`;
  let models=await requestLocalOllama('models',{});
  if(!ollamaModelPresent(models,baseModel)){
    actionStep(action,10,`Downloading ${baseModel}…`);
    await requestLocalOllama('pull',{ model:baseModel,stream:true,streamId:`arcane-brain-pull-${action.id}` },{onChunk(chunk){
      const completed=Number(chunk&&chunk.completed),total=Number(chunk&&chunk.total);
      if(Number.isFinite(completed)&&Number.isFinite(total)&&total>0)actionStep(action,Math.round(10+Math.min(1,completed/total)*70),`${String(chunk.status||'Downloading model')} (${Math.round(completed/total*100)}%)`);
    }});
  }
  const arcaneSystem=readManagedArcaneModelDefinitions()['20b'].system;
  const contextLength=Number(parameters&&parameters.contextLength||0);
  actionStep(action,84,`Creating ${model} from ${baseModel}…`);
  await requestLocalOllama('create',{ model,from:baseModel,system:arcaneSystem,...(contextLength?{parameters:{num_ctx:Math.max(1024,Math.min(262144,Math.round(contextLength)))}}:{}),stream:true,streamId:`arcane-brain-create-${action.id}` });
  models=await requestLocalOllama('models',{});
  if(!ollamaModelPresent(models,model))throw arcaneError('ARCANE_BRAIN_VERIFY_FAILED',`${model} was not found after creation.`,'Check the ArcaneOllama logs and retry.',500);
  if(parameters&&parameters.makeDefault)await writeArcaneModelSettings({ defaultModel:model });
  actionStep(action,98,`${model} is available.`);
  return Object.freeze({ model,baseModel,defaultModel:Boolean(parameters&&parameters.makeDefault) });
}
function normalizedOllamaServiceSettings(input){
  const value=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
  const integer=(key,fallback,min,max)=>{const number=Number(value[key]===undefined?fallback:value[key]);if(!Number.isSafeInteger(number)||number<min||number>max)throw arcaneError('INVALID_OLLAMA_SERVICE_SETTING',`${key} is outside Arcane's supported range.`,'Choose a value shown in Advanced settings.',400,{field:key});return number;};
  const keepAlive=String(value.keepAlive===undefined?'5m':value.keepAlive).trim();
  if(!/^(?:-1|0|[1-9]\d{0,3}(?:m|h))$/.test(keepAlive))throw arcaneError('INVALID_OLLAMA_SERVICE_SETTING','The service keep-alive value is invalid.','Use -1, 0, or a bounded duration such as 5m or 1h.',400,{field:'keepAlive'});
  const kvCacheType=String(value.kvCacheType||'f16');
  if(!['f16','q8_0','q4_0'].includes(kvCacheType))throw arcaneError('INVALID_OLLAMA_SERVICE_SETTING','Choose f16, q8_0, or q4_0 for the K/V cache.','Use one of the values shown in Advanced settings.',400,{field:'kvCacheType'});
  return Object.freeze({contextLength:integer('contextLength',0,0,262144),keepAlive,maxLoadedModels:integer('maxLoadedModels',0,0,16),numParallel:integer('numParallel',1,1,16),maxQueue:integer('maxQueue',512,1,4096),flashAttention:Boolean(value.flashAttention),kvCacheType,noCloud:value.noCloud!==false});
}
function managedOllamaServiceSettings(){return typeof native.ollamaServiceSettings==='function'?native.ollamaServiceSettings():{supported:false};}
async function setManagedOllamaServiceSettings(action,parameters){
  if(typeof native.configureOllamaServiceSettings!=='function')throw arcaneError('OLLAMA_SERVICE_SETTINGS_UNAVAILABLE','This platform does not expose managed Ollama service settings.','Configure the service through the operating-system administrator.',501);
  const settings=normalizedOllamaServiceSettings(parameters);
  actionStep(action,25,'Applying the verified ArcaneOllama service environment…');
  const result=await native.configureOllamaServiceSettings(settings,action);
  actionStep(action,90,'ArcaneOllama restarted with the advanced settings.');
  await delay(1200);
  await requestLocalOllama('version',{});
  actionStep(action,98,'ArcaneOllama is healthy.');
  return result;
}
async function loadManagedDefaultModel(action){
  const settings=readArcaneModelSettings();
  if(settings.provider!=='ollama'||!settings.bootLoad)return { loaded:false,model:settings.provider==='openai'?settings.openAIModel:settings.defaultModel,provider:settings.provider };
  actionStep(action,99,`Loading default model ${settings.defaultModel}…`);
  await requestLocalOllama('generate',{ model:settings.defaultModel,prompt:'',keep_alive:ollamaKeepAliveValue(settings.bootKeepAlive),...(settings.contextLength?{options:{num_ctx:settings.contextLength}}:{}) });
  return { loaded:true,model:settings.defaultModel,keepAlive:settings.bootKeepAlive,contextLength:settings.contextLength||null };
}
function startManagedArcaneModelBootEnsure(){
  if(simulate||privilegedWorker||!['provisioner','shell'].includes(appMode))return;
  withAction('ollama.model.ensure',null,async(action)=>{const model=await ensureManagedArcaneModel(action);const loaded=await loadManagedDefaultModel(action);return { model,loaded };})
    .catch((error)=>log('The asynchronous Arcane model boot check failed.',{ code:error&&error.code||null,message:error&&error.message||String(error) }));
}
async function openAICredential(){
  const token=typeof native.readAIProviderCredential==='function'?await native.readAIProviderCredential('openai'):'';
  if(!token)throw arcaneError('OPENAI_NOT_CONFIGURED','OpenAI authentication is not configured.','Open Arcane Settings, choose OpenAI, and save an API token.',409);
  return token;
}
async function requestOpenAI(method,resource,payload){
  const token=await openAICredential();
  const body=payload===undefined?null:Buffer.from(JSON.stringify(payload));
  if(body&&body.length>1024*1024)throw arcaneError('AI_CONTEXT_TOO_LARGE','The OpenAI request exceeds Arcane limits.','Send a shorter conversation history.',413);
  return new Promise((resolve,reject)=>{
    const request=https.request({ protocol:'https:',hostname:'api.openai.com',port:443,path:`/v1/${resource}`,method,headers:{ Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json',...(body?{'Content-Length':body.length}:{})},timeout:120000 },(response)=>{
      const chunks=[];let size=0;
      response.on('data',(chunk)=>{size+=chunk.length;if(size>8*1024*1024){request.destroy();reject(arcaneError('OPENAI_RESPONSE_TOO_LARGE','OpenAI returned more data than Arcane accepts.','Try a narrower request.',502));return;}chunks.push(chunk);});
      response.on('end',()=>{
        let result={};try{result=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch(_){reject(arcaneError('OPENAI_INVALID_RESPONSE','OpenAI returned an invalid response.','Retry the request or check OpenAI service status.',502));return;}
        if(response.statusCode<200||response.statusCode>=300){const providerMessage=String(result&&result.error&&result.error.message||'').slice(0,500);reject(arcaneError('OPENAI_REQUEST_FAILED',`OpenAI rejected the request${providerMessage?`: ${providerMessage}`:'.'}`,'Check the saved token, model access, billing, and OpenAI service status.',response.statusCode||502));return;}
        resolve(result);
      });
    });
    request.on('timeout',()=>request.destroy(new Error('timeout')));
    request.on('error',()=>reject(arcaneError('OPENAI_UNAVAILABLE','Arcane could not reach OpenAI.','Check the network connection and OpenAI service status, then retry.',503)));
    if(body)request.write(body);request.end();
  });
}
async function managedAIProviderSettings(){
  const settings=readArcaneModelSettings();
  return Object.freeze({ provider:settings.provider,openAIModel:settings.openAIModel,openAIConfigured:typeof native.hasAIProviderCredential==='function'&&native.hasAIProviderCredential('openai') });
}
function managedAIProfile(){
  const settings=readArcaneModelSettings();
  const provider=settings.provider==='openai'?'openai':'ollama';
  const model=provider==='openai'?settings.openAIModel:settings.defaultModel;
  const configured=provider==='openai'
    ? Boolean(model&&typeof native.hasAIProviderCredential==='function'&&native.hasAIProviderCredential('openai'))
    : Boolean(model);
  return Object.freeze({ provider,model,configured,local:provider==='ollama' });
}
async function setManagedAIProviderSettings(parameters){
  const source=parameters&&typeof parameters==='object'&&!Array.isArray(parameters)?parameters:{};
  if(Object.keys(source).some((key)=>!['provider','openAIModel','token','removeToken'].includes(key)))throw arcaneError('INVALID_AI_PROVIDER_SETTINGS','Arcane rejected unsupported provider settings.','Use only provider, model, and authentication controls.',400);
  const current=readArcaneModelSettings();
  const next=normalizedArcaneAISettings({ provider:source.provider,openAIModel:source.openAIModel },current);
  const token=source.token===undefined?'':String(source.token).trim();
  if(token&&(!token.startsWith('sk-')||token.length<20||token.length>512))throw arcaneError('INVALID_OPENAI_TOKEN','The OpenAI token format is invalid.','Paste a complete OpenAI API key.',400);
  if(source.removeToken===true&&typeof native.deleteAIProviderCredential==='function')await native.deleteAIProviderCredential('openai');
  if(token){if(typeof native.writeAIProviderCredential!=='function')throw arcaneError('CREDENTIAL_STORE_UNAVAILABLE','The protected credential store is unavailable.','Update Arcane OS or use Ollama.',501);await native.writeAIProviderCredential('openai',token);}
  const configured=typeof native.hasAIProviderCredential==='function'&&native.hasAIProviderCredential('openai');
  if(next.provider==='openai'&&!configured)throw arcaneError('OPENAI_NOT_CONFIGURED','OpenAI requires an authentication token.','Paste an OpenAI API key before selecting OpenAI.',409);
  if(next.provider==='openai'&&!next.openAIModel)throw arcaneError('OPENAI_MODEL_REQUIRED','Choose an OpenAI model.','Enter a model identifier available to your OpenAI account.',400);
  await writeArcaneModelSettings({ provider:next.provider,openAIModel:next.openAIModel });
  return managedAIProviderSettings();
}
async function listManagedOpenAIModels(){
  const response=await requestOpenAI('GET','models');
  const models=(Array.isArray(response&&response.data)?response.data:[]).map((model)=>String(model&&model.id||'')).filter((id)=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)).sort();
  return { provider:'openai',models };
}
function normalizedLocalChatRequest(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
    || Object.getPrototypeOf(parameters) !== Object.prototype) {
    throw arcaneError('INVALID_AI_REQUEST', 'Arcane rejected an invalid local AI request.', 'Provide a model and a bounded messages array.', 400);
  }
  const allowedKeys = new Set(['format', 'messages', 'model', 'options', 'tools', 'keep_alive', 'think', 'logprobs', 'top_logprobs']);
  if (Object.keys(parameters).some((key) => !allowedKeys.has(key))) {
    throw arcaneError('INVALID_AI_REQUEST', 'Arcane rejected unsupported local AI request fields.', 'Use only model, messages, and optional format.', 400);
  }
  const model = String(parameters.model || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)) {
    throw arcaneError('INVALID_AI_MODEL', 'Choose a valid installed local model.', 'Use a model name returned by Arcane.ai.models().', 400);
  }
  if (!Array.isArray(parameters.messages) || parameters.messages.length < 1 || parameters.messages.length > 128) {
    throw arcaneError('INVALID_AI_MESSAGES', 'Arcane requires between 1 and 128 chat messages.', 'Send a bounded conversation history.', 400);
  }
  let contentBytes = 0;
  const messages = parameters.messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.getPrototypeOf(message) !== Object.prototype
      || JSON.stringify(Object.keys(message).sort()) !== JSON.stringify(['content', 'role'])) {
      throw arcaneError('INVALID_AI_MESSAGES', 'Arcane rejected a malformed chat message.', 'Each message must contain only role and content.', 400);
    }
    const role = String(message.role || '');
    const content = typeof message.content === 'string' ? message.content : '';
    if (!['assistant', 'system', 'user'].includes(role) || !content || content.length > 131072) {
      throw arcaneError('INVALID_AI_MESSAGES', 'Arcane rejected a chat message role or content length.', 'Use system, user, or assistant roles with non-empty bounded text.', 400);
    }
    contentBytes += Buffer.byteLength(content);
    return { role, content };
  });
  if (contentBytes > 512 * 1024) {
    throw arcaneError('AI_CONTEXT_TOO_LARGE', 'The local AI conversation exceeds 512 KiB.', 'Send a shorter conversation history.', 413);
  }
  const format = parameters.format === undefined || parameters.format === null || parameters.format === ''
    ? null
    : String(parameters.format);
  if (format !== null && format !== 'json') {
    throw arcaneError('INVALID_AI_FORMAT', 'Arcane supports only text or JSON local AI responses.', 'Use no format value for text or use json.', 400);
  }
  return { model, messages, ...(format ? { format } : {}),...(parameters.options!==undefined?{ options:parameters.options }:{}),...(parameters.tools!==undefined?{ tools:parameters.tools }:{}),...(parameters.keep_alive!==undefined?{ keep_alive:parameters.keep_alive }:{}),...(parameters.think!==undefined?{ think:parameters.think }:{}),...(parameters.logprobs!==undefined?{ logprobs:parameters.logprobs }:{}),...(parameters.top_logprobs!==undefined?{ top_logprobs:parameters.top_logprobs }:{}) };
}
async function completeLocalChat(parameters) {
  const request = normalizedLocalChatRequest(parameters);
  const response = await requestLocalOllama('chat', request);
  const message = response && response.message && typeof response.message === 'object' ? response.message : {};
  return {
    provider: 'arcane-ollama',
    model: String(response && response.model || request.model).slice(0, 256),
    message: {
      role: message.role === 'assistant' ? 'assistant' : 'assistant',
      content: String(message.content || '').slice(0, 4 * 1024 * 1024),
      ...(typeof message.thinking==='string'?{ thinking:message.thinking.slice(0,4*1024*1024) }:{}),
      ...(Array.isArray(message.tool_calls)?{ toolCalls:message.tool_calls }:{}),
    },
    done: Boolean(response && response.done),
    doneReason: response && response.done_reason ? String(response.done_reason).slice(0, 128) : null,
    promptEvalCount: Number.isSafeInteger(response && response.prompt_eval_count) ? response.prompt_eval_count : null,
    evalCount: Number.isSafeInteger(response && response.eval_count) ? response.eval_count : null,
  };
}
async function completeConfiguredChat(parameters){
  const source=parameters&&typeof parameters==='object'&&!Array.isArray(parameters)?{ ...parameters }:parameters;
  const expectedProvider=source&&Object.prototype.hasOwnProperty.call(source,'expectedProvider')
    ? String(source.expectedProvider||'').trim().toLowerCase()
    : null;
  if(source&&typeof source==='object'&&!Array.isArray(source))delete source.expectedProvider;
  if(expectedProvider!==null&&!['ollama','openai'].includes(expectedProvider)){
    throw arcaneError('INVALID_AI_PROVIDER','Arcane rejected an invalid expected AI provider.','Refresh the Arcane AI profile and retry.',400);
  }
  const settings=readArcaneModelSettings();
  const provider=settings.provider==='openai'?'openai':'ollama';
  if(expectedProvider&&expectedProvider!==provider){
    throw arcaneError('AI_PROVIDER_CHANGED','The Arcane AI provider changed before this request could be sent.','Review the updated provider disclosure in Arcane Developer, then retry your question.',409,{ expectedProvider,provider });
  }
  if(settings.provider!=='openai'){
    const request=source&&typeof source==='object'&&!Array.isArray(source)?source:{};
    return completeLocalChat(request.model?request:{ ...request,model:settings.defaultModel });
  }
  const request=normalizedLocalChatRequest({ ...source,model:settings.openAIModel });
  const response=await requestOpenAI('POST','chat/completions',{ model:settings.openAIModel,messages:request.messages,...(request.format==='json'?{response_format:{type:'json_object'}}:{}) });
  const choice=Array.isArray(response&&response.choices)?response.choices[0]:null;
  return { provider:'openai',model:String(response&&response.model||settings.openAIModel).slice(0,128),message:{ role:'assistant',content:String(choice&&choice.message&&choice.message.content||'').slice(0,4*1024*1024) },done:true,doneReason:choice&&choice.finish_reason?String(choice.finish_reason).slice(0,128):null,promptEvalCount:Number.isSafeInteger(response&&response.usage&&response.usage.prompt_tokens)?response.usage.prompt_tokens:null,evalCount:Number.isSafeInteger(response&&response.usage&&response.usage.completion_tokens)?response.usage.completion_tokens:null };
}

const DEVELOPMENT_CONTEXT_CHARACTER_LIMIT=48*1024;
const DEVELOPMENT_CONTEXT_FILE_CHARACTER_LIMIT=6*1024;
const DEVELOPMENT_CONTEXT_FILE_COUNT_LIMIT=10;
const DEVELOPMENT_CONTEXT_FILE_BYTE_LIMIT=512*1024;
const DEVELOPMENT_REDACTION_MARKER='[REDACTED BY ARCANE]';
const DEVELOPMENT_TRUSTED_BASELINE='1a092ce6b65ff9f39fa715db1a7a5885ea81c559';
const DEVELOPMENT_EXCLUDED_SEGMENTS=new Set([
  '.git','.cache','.codex','.agents','node_modules','dist','runtime',
  'credentials','credential','secrets','secret','keys','key','certs','certificates',
]);
const DEVELOPMENT_BLOCKED_EXTENSIONS=new Set([
  '.cer','.crt','.der','.dll','.dylib','.exe','.gif','.ico','.jar','.jpeg','.jpg','.key',
  '.lib','.node','.p12','.pem','.pfx','.png','.pvk','.so','.snk','.wasm','.webp','.zip',
]);
const DEVELOPMENT_TEXT_EXTENSIONS=new Set([
  '.bat','.c','.cc','.cjs','.cmd','.cpp','.cs','.css','.csv','.h','.html','.ini','.java',
  '.js','.json','.jsonl','.jsx','.md','.mjs','.ps1','.py','.sh','.sql','.svg','.toml',
  '.ts','.tsx','.txt','.xml','.yaml','.yml',
]);
const DEVELOPMENT_TEXT_FILENAMES=new Set([
  '.gitattributes','.gitignore','agents.md','license','license.md','modelfile','readme','readme.md',
]);
const DEVELOPMENT_QUERY_STOP_WORDS=new Set([
  'about','after','also','and','are','can','code','developer','for','from','have','how','into',
  'our','that','the','this','use','what','when','where','which','with','work','would',
]);
const DEVELOPMENT_SETUP_TASK_IDS=Object.freeze([
  'root-dependencies','machine-dependencies','git-hooks','windows-signing',
]);

function developmentRequest(parameters,expectedKeys){
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters)||Object.getPrototypeOf(parameters)!==Object.prototype){
    throw arcaneError('DEVELOPMENT_REQUEST_INVALID','Arcane rejected an invalid development request.','Use the documented Arcane development API fields only.',400);
  }
  const keys=Object.keys(parameters).sort();
  const expected=[...expectedKeys].sort();
  if(keys.length!==expected.length||keys.some((key,index)=>key!==expected[index])){
    throw arcaneError('DEVELOPMENT_REQUEST_INVALID','Arcane rejected unsupported development request fields.','Use the documented Arcane development API fields only.',400,{ allowedFields:expected });
  }
  return parameters;
}

function developmentPathWithin(root,candidate){
  const relative=path.relative(root,candidate);
  return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));
}

function developmentRegularPath(file){
  try{
    const stat=fs.lstatSync(file);
    return stat.isFile()&&!stat.isSymbolicLink();
  }catch(_){return false;}
}

function validateDevelopmentWorkspace(input){
  const requested=typeof input==='string'?input.trim():'';
  if(!requested||requested.length>1024||requested.includes('\0')||!path.isAbsolute(requested)){
    throw arcaneError('DEVELOPMENT_ROOT_INVALID','Choose an explicit Arcane checkout directory.','Select the root of a local Arcane OS Git checkout.',400);
  }
  let root;
  try{
    const rootStat=fs.lstatSync(requested);
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('unsafe root');
    root=fs.realpathSync(requested);
  }catch(_){
    throw arcaneError('DEVELOPMENT_ROOT_INVALID','Arcane could not open that development workspace.','Choose an existing local Arcane OS checkout directory that is not a link.',400);
  }
  const markerPaths={
    git:path.join(root,'.git'),
    package:path.join(root,'package.json'),
    appBuilding:path.join(root,'docs','app-building.md'),
    theme:path.join(root,'arcane','css','theme.css'),
  };
  try{
    const gitStat=fs.lstatSync(markerPaths.git);
    if(gitStat.isSymbolicLink()||(!gitStat.isDirectory()&&!gitStat.isFile()))throw new Error('unsafe Git marker');
    for(const marker of [markerPaths.package,markerPaths.appBuilding,markerPaths.theme]){
      if(!developmentRegularPath(marker))throw new Error(`missing marker: ${marker}`);
    }
  }catch(_){
    throw arcaneError('DEVELOPMENT_ROOT_UNRECOGNIZED','That directory is not a canonical Arcane OS checkout.','Select the checkout root containing .git, package.json, docs/app-building.md, and arcane/css/theme.css.',400);
  }
  const packageManifest=readJsonFile(markerPaths.package);
  if(!packageManifest||packageManifest.name!=='arcane-os'){
    throw arcaneError('DEVELOPMENT_ROOT_UNRECOGNIZED','That directory is not an Arcane OS checkout.','Select the canonical Arcane OS checkout root.',400);
  }
  const scripts=packageManifest.scripts&&typeof packageManifest.scripts==='object'?packageManifest.scripts:{};
  const bundleScript=String(scripts['test:machine']||scripts['build:dev:windows']||scripts['check:windows']||'');
  const bundleMatch=bundleScript.match(/machine_bundles[\\/]arcane-os-machine-bundle-v([0-9]+\.[0-9]+\.[0-9]+)/);
  if(!bundleMatch)throw arcaneError('DEVELOPMENT_ROOT_UNRECOGNIZED','Arcane could not identify the checkout’s active machine bundle.','Restore the canonical root package scripts, then select the checkout again.',409);
  const checkoutBundleVersion=bundleMatch[1];
  const machineBundlesRoot=path.join(root,'machine_bundles');
  const bundleRoot=path.join(machineBundlesRoot,`arcane-os-machine-bundle-v${checkoutBundleVersion}`);
  const bundlePath=path.join(bundleRoot,'arcane-bundle.json');
  try{
    const machineBundlesStat=fs.lstatSync(machineBundlesRoot);
    const bundleRootStat=fs.lstatSync(bundleRoot);
    if(!machineBundlesStat.isDirectory()||machineBundlesStat.isSymbolicLink()||!bundleRootStat.isDirectory()||bundleRootStat.isSymbolicLink()||!developmentRegularPath(bundlePath))throw new Error('unsafe machine bundle');
    if(!developmentPathWithin(root,fs.realpathSync(bundleRoot)))throw new Error('machine bundle escaped checkout');
  }catch(_){
    throw arcaneError('DEVELOPMENT_ROOT_UNRECOGNIZED','The checkout’s active machine bundle is missing or unsafe.','Restore the machine bundle selected by the canonical root package scripts.',409);
  }
  const bundleManifest=readJsonFile(bundlePath);
  if(!bundleManifest||String(bundleManifest.version||'')!==checkoutBundleVersion){
    throw arcaneError('DEVELOPMENT_ROOT_UNRECOGNIZED','The checkout’s machine bundle manifest does not match its canonical path.','Restore the active machine bundle manifest, then select the checkout again.',409,{ checkoutBundleVersion });
  }
  const lineage=developmentRepositoryLineage(root);
  return {
    root,
    bundleRoot,
    checkoutBundleVersion,
    packageManifest,
    bundleManifest,
    lineage,
  };
}

function safeDevelopmentTrackedFile(workspace,relativeInput){
  const relative=String(relativeInput||'').replace(/\\/g,'/');
  if(!relative||relative.includes('\0')||path.posix.isAbsolute(relative))return null;
  const segments=relative.split('/');
  if(segments.some((segment)=>!segment||segment==='.'||segment==='..'))return null;
  const lowered=segments.map((segment)=>segment.toLowerCase());
  if(lowered.some((segment)=>DEVELOPMENT_EXCLUDED_SEGMENTS.has(segment)))return null;
  const filename=lowered[lowered.length-1];
  if(filename==='.env'||filename.startsWith('.env.')||/(?:^|[._-])(?:credential|credentials|secret|secrets)(?:[._-]|$)/.test(filename)||/(?:token|password|passwd|private-key|auth-key)/.test(filename))return null;
  const extension=path.extname(filename);
  if(DEVELOPMENT_BLOCKED_EXTENSIONS.has(extension))return null;
  if(!DEVELOPMENT_TEXT_EXTENSIONS.has(extension)&&!DEVELOPMENT_TEXT_FILENAMES.has(filename))return null;
  let cursor=workspace.root;
  try{
    for(let index=0;index<segments.length;index+=1){
      cursor=path.join(cursor,segments[index]);
      const stat=fs.lstatSync(cursor);
      if(stat.isSymbolicLink())return null;
      if(index<segments.length-1&&!stat.isDirectory())return null;
      if(index===segments.length-1&&(!stat.isFile()||stat.size>DEVELOPMENT_CONTEXT_FILE_BYTE_LIMIT))return null;
    }
    const canonical=fs.realpathSync(cursor);
    if(!developmentPathWithin(workspace.root,canonical))return null;
    return { path:relative,absolute:canonical,size:fs.statSync(canonical).size };
  }catch(_){return null;}
}

function fixedDevelopmentExecutable(candidates){
  for(const candidate of candidates.filter(Boolean)){
    if(!path.isAbsolute(candidate))continue;
    try{
      const canonical=fs.realpathSync(candidate);
      if(fs.statSync(canonical).isFile())return canonical;
    }catch(_){}
  }
  return null;
}

function developmentProbe(executable,commandArgs,options){
  const opts=options||{};
  if(!executable)return { ok:false,status:null,stdout:'',stderr:'',error:'Executable unavailable.' };
  const result=spawnSync(executable,commandArgs||[],{
    cwd:opts.cwd||safeSubprocessCwd,
    env:opts.env||safeSubprocessEnvironment,
    encoding:'utf8',
    windowsHide:true,
    shell:false,
    timeout:Math.min(10000,Math.max(1000,Number(opts.timeout||5000))),
    maxBuffer:Math.min(2*1024*1024,Math.max(16*1024,Number(opts.maxBuffer||256*1024))),
  });
  return {
    ok:!result.error&&result.status===0,
    status:Number.isInteger(result.status)?result.status:null,
    stdout:String(result.stdout||''),
    stderr:String(result.stderr||''),
    error:result.error?String(result.error.message||result.error):null,
  };
}

function developmentGitTool(){
  const programFiles=safeSubprocessEnvironment.ProgramFiles||'C:\\Program Files';
  const programFilesX86=safeSubprocessEnvironment['ProgramFiles(x86)']||'C:\\Program Files (x86)';
  const executable=fixedDevelopmentExecutable(platform==='win32'?[
    path.join(programFiles,'Git','cmd','git.exe'),
    path.join(programFiles,'Git','bin','git.exe'),
    path.join(programFilesX86,'Git','cmd','git.exe'),
    path.join(programFilesX86,'Git','bin','git.exe'),
  ]:[ '/usr/bin/git','/usr/local/bin/git' ]);
  const probe=developmentProbe(executable,['--version']);
  return { available:probe.ok,path:executable,version:probe.ok?probe.stdout.trim().slice(0,128):null };
}

function developmentGitArguments(root,args){
  return ['-c',`safe.directory=${root}`,'-C',root,...args];
}

function developmentRepositoryLineage(root){
  const gitTool=developmentGitTool();
  if(!gitTool.available){
    throw arcaneError('DEVELOPMENT_GIT_REQUIRED','Arcane needs Git to verify this checkout.','Install Git in a standard system location, then pair the checkout again.',409);
  }
  const topLevel=developmentProbe(gitTool.path,developmentGitArguments(root,['rev-parse','--show-toplevel']),{cwd:root,timeout:5000,maxBuffer:16*1024});
  let canonicalTopLevel=null;
  try{canonicalTopLevel=topLevel.ok?fs.realpathSync(topLevel.stdout.trim()):null;}catch(_){}
  if(!canonicalTopLevel||canonicalTopLevel.toLowerCase()!==root.toLowerCase()){
    throw arcaneError('DEVELOPMENT_ROOT_UNTRUSTED','Arcane could not bind the selected directory to its Git checkout root.','Select the canonical root of the company Arcane OS checkout.',409,{ stdout:`Requested root: ${root}; Git root: ${topLevel.stdout.trim().slice(0,1024)||'(unavailable)'}`,stderr:(topLevel.stderr||topLevel.error||'').trim().slice(0,1024)||null });
  }
  const ancestry=developmentProbe(gitTool.path,developmentGitArguments(root,['merge-base','--is-ancestor',DEVELOPMENT_TRUSTED_BASELINE,'HEAD']),{cwd:root,timeout:5000,maxBuffer:16*1024});
  if(!ancestry.ok){
    throw arcaneError('DEVELOPMENT_ROOT_UNTRUSTED','That checkout does not descend from Arcane\u2019s trusted company baseline.','Use a current company Arcane OS clone or rebase the branch onto the supported baseline before running setup.',409,{ trustedBaseline:DEVELOPMENT_TRUSTED_BASELINE });
  }
  return Object.freeze({ trusted:true,baseline:DEVELOPMENT_TRUSTED_BASELINE });
}

function developmentNodeTool(){
  const nativeCandidate=typeof native.nodeExecutable==='function'?native.nodeExecutable():null;
  const programFiles=safeSubprocessEnvironment.ProgramFiles||'C:\\Program Files';
  const candidates=platform==='win32'?[nativeCandidate,path.join(programFiles,'nodejs','node.exe')]:[
    '/usr/local/bin/node','/usr/bin/node',path.join(os.homedir(),'.local','bin','node'),
  ];
  const packagedCore=(()=>{try{return fs.realpathSync(process.execPath);}catch(_){return path.resolve(process.execPath);}})();
  let unsupported=null;
  for(const candidate of candidates.filter(Boolean)){
    const executable=fixedDevelopmentExecutable([candidate]);
    if(!executable||executable.toLowerCase()===packagedCore.toLowerCase())continue;
    const probe=developmentProbe(executable,['--version']);
    const match=probe.ok?probe.stdout.trim().match(/^v(\d+)(?:\.(\d+))?/):null;
    const major=match?Number(match[1]):null;
    const tool={ available:Boolean(probe.ok&&major>=22),path:executable,version:probe.ok?probe.stdout.trim().slice(0,64):null,major,supported:Boolean(probe.ok&&major>=22) };
    if(tool.available)return tool;
    if(probe.ok)unsupported=tool;
  }
  return unsupported||{ available:false,path:null,version:null,major:null,supported:false };
}

function developmentNpmTool(nodeTool){
  if(!nodeTool||!nodeTool.path)return { available:false,path:null,version:null };
  const nodeDirectory=path.dirname(nodeTool.path);
  const candidates=platform==='win32'?[
    path.join(nodeDirectory,'node_modules','npm','bin','npm-cli.js'),
  ]:[
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/share/nodejs/npm/bin/npm-cli.js',
    path.resolve(nodeDirectory,'..','lib','node_modules','npm','bin','npm-cli.js'),
  ];
  const cli=fixedDevelopmentExecutable(candidates);
  const probe=nodeTool.available&&cli?developmentProbe(nodeTool.path,[cli,'--version']):{ok:false,stdout:''};
  return { available:Boolean(nodeTool.available&&cli&&probe.ok),path:cli,version:probe.ok?probe.stdout.trim().slice(0,64):null };
}

function developmentCommandEnvironment(nodeTool,gitTool){
  const separator=platform==='win32'?';':':';
  const directories=[nodeTool&&nodeTool.path?path.dirname(nodeTool.path):'',gitTool&&gitTool.path?path.dirname(gitTool.path):''].filter(Boolean);
  const base=String(safeSubprocessEnvironment.PATH||safeSubprocessEnvironment.Path||'');
  const trustedPath=[...new Set([...directories,base].filter(Boolean))].join(separator);
  const env={ ...safeSubprocessEnvironment,PATH:trustedPath };
  if(platform==='win32'){
    env.Path=trustedPath;
    env.APPDATA=process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming');
    env.TEMP=process.env.TEMP||os.tmpdir();
    env.TMP=process.env.TMP||env.TEMP;
  }
  return env;
}

function developmentDependencyReady(root,relative){
  const segments=relative.split('/');
  let cursor=root;
  try{
    for(let index=0;index<segments.length;index+=1){
      cursor=path.join(cursor,segments[index]);
      const stat=fs.lstatSync(cursor);
      if(stat.isSymbolicLink())return false;
      if(index<segments.length-1&&!stat.isDirectory())return false;
      if(index===segments.length-1&&!stat.isFile())return false;
    }
    return developmentPathWithin(root,fs.realpathSync(cursor));
  }catch(_){return false;}
}

function developmentSigningReady(){
  if(platform!=='win32')return { available:false,ready:false,message:'Microsoft NT development signing is available only on Microsoft NT.' };
  const script=`$subject='CN=The Wizard Nexus Development'
$friendly='Arcane OS Local Development Code Signing'
$minimum=(Get-Date).AddDays(30)
$certificate=Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert -ErrorAction Stop | Where-Object { $_.Subject -ceq $subject -and $_.Issuer -ceq $subject -and $_.FriendlyName -ceq $friendly -and $_.HasPrivateKey -and $_.NotAfter -gt $minimum } | Sort-Object NotAfter -Descending | Select-Object -First 1
if(-not $certificate){exit 2}
$thumbprint=([string]$certificate.Thumbprint).Replace(' ','').ToUpperInvariant()
foreach($store in @('Root','TrustedPublisher')){if(-not (Get-ChildItem "Cert:\\CurrentUser\\$store" -ErrorAction Stop | Where-Object { ([string]$_.Thumbprint).Replace(' ','').ToUpperInvariant() -ceq $thumbprint } | Select-Object -First 1)){exit 3}}
'ready'`;
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  const probe=developmentProbe(windowsPowerShell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',encoded],{timeout:5000,maxBuffer:32*1024});
  return { available:true,ready:probe.ok,message:probe.ok?'Local development signing is ready.':'Local development signing is not initialized.' };
}

function developmentGitStatus(workspace,gitTool){
  if(!gitTool.available)return { available:false,path:gitTool.path,version:gitTool.version,branch:null,head:null,dirty:false,staged:0,modified:0,untracked:0 };
  const probe=developmentProbe(gitTool.path,developmentGitArguments(workspace.root,['status','--porcelain=v2','--branch','--untracked-files=normal']),{cwd:workspace.root,timeout:5000,maxBuffer:1024*1024});
  if(!probe.ok)return { available:false,path:gitTool.path,version:gitTool.version,branch:null,head:null,dirty:false,staged:0,modified:0,untracked:0,error:(probe.stderr||probe.error||'Git status failed.').trim().slice(0,512) };
  let branch=null;
  let head=null;
  let staged=0;
  let modified=0;
  let untracked=0;
  for(const line of probe.stdout.split(/\r?\n/)){
    if(line.startsWith('# branch.head '))branch=line.slice(14).trim()||null;
    else if(line.startsWith('# branch.oid '))head=line.slice(13).trim()||null;
    else if(line.startsWith('? '))untracked+=1;
    else if(line.startsWith('1 ')||line.startsWith('2 ')||line.startsWith('u ')){
      const state=line.slice(2,4);
      if(state[0]&&state[0]!=='.')staged+=1;
      if(state[1]&&state[1]!=='.')modified+=1;
    }
  }
  return { available:true,path:gitTool.path,version:gitTool.version,branch,head,dirty:staged+modified+untracked>0,staged,modified,untracked };
}

function inspectDevelopmentWorkspace(parameters){
  const request=developmentRequest(parameters,['root']);
  const workspace=validateDevelopmentWorkspace(request.root);
  const gitTool=developmentGitTool();
  const nodeTool=developmentNodeTool();
  const npmTool=developmentNpmTool(nodeTool);
  const commandEnvironment=developmentCommandEnvironment(nodeTool,gitTool);
  const hooksProbe=gitTool.available?developmentProbe(gitTool.path,developmentGitArguments(workspace.root,['config','--get','core.hooksPath']),{cwd:workspace.root,env:commandEnvironment,timeout:3000,maxBuffer:16*1024}):{ok:false,stdout:''};
  const signing=developmentSigningReady();
  const tasks=[
    {
      id:'node-runtime',
      label:'Node.js runtime',
      available:nodeTool.available||platform==='win32',
      installable:platform==='win32',
      ready:nodeTool.available,
      message:nodeTool.available
        ? `Node.js ${nodeTool.version||'22+'} is ready at ${nodeTool.path}.`
        : platform==='win32'
          ? 'Install the verified Node.js 22 or newer runtime through Arcane.'
          : 'Install Node.js 22 or newer in a standard system location.',
    },
    { id:'root-dependencies',label:'Root dependencies',available:nodeTool.available&&npmTool.available,ready:developmentDependencyReady(workspace.root,'node_modules/strong-type/package.json'),message:'Install the root lockfile with npm ci.' },
    { id:'machine-dependencies',label:'Machine bundle dependencies',available:nodeTool.available&&npmTool.available,ready:developmentDependencyReady(workspace.bundleRoot,'node_modules/@yao-pkg/pkg/package.json'),message:'Install the current machine bundle lockfile with npm ci.' },
    { id:'git-hooks',label:'Git hooks',available:nodeTool.available&&npmTool.available&&gitTool.available,ready:hooksProbe.ok&&hooksProbe.stdout.trim().replace(/\\/g,'/').replace(/^\.\//,'')==='.githooks',message:'Configure the checkout to use its versioned Git hooks.' },
    { id:'windows-signing',label:'Microsoft NT development signing',available:signing.available&&nodeTool.available&&npmTool.available,ready:signing.ready,message:signing.message },
  ];
  const applicableTasks=tasks.filter((task)=>task.id!=='windows-signing'||platform==='win32');
  return {
    root:workspace.root,
    runtimeVersion:VERSION,
    repository:{ name:workspace.packageManifest.name,version:String(workspace.packageManifest.version||''),bundleVersion:String(workspace.bundleManifest.version||''),trustedBaseline:workspace.lineage.baseline },
    git:developmentGitStatus(workspace,gitTool),
    tools:{ node:nodeTool,npm:npmTool,git:gitTool },
    signing,
    readiness:{ ready:applicableTasks.every((task)=>task.available&&task.ready),tasks },
  };
}

function developmentQueryTerms(query){
  const terms=String(query||'').toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,63}/g)||[];
  return [...new Set(terms.filter((term)=>term.length>=3&&!DEVELOPMENT_QUERY_STOP_WORDS.has(term)))].slice(0,6);
}

function developmentTrackedPaths(workspace,gitTool){
  if(!gitTool.available)throw arcaneError('DEVELOPMENT_GIT_REQUIRED','Arcane needs Git to read bounded development context.','Install Git in a standard system location, then inspect the workspace again.',409);
  const probe=developmentProbe(gitTool.path,developmentGitArguments(workspace.root,['ls-files','-z','--cached','--','.']),{cwd:workspace.root,timeout:7000,maxBuffer:2*1024*1024});
  if(!probe.ok)throw arcaneError('DEVELOPMENT_CONTEXT_FAILED','Arcane could not read the checkout index.','Verify that the selected Arcane checkout has a healthy Git index.',409,{ technicalMessage:(probe.stderr||probe.error||'git ls-files failed').trim().slice(0,1024) });
  return probe.stdout.split('\0').filter(Boolean);
}

function developmentFileExcerpt(text,matchLines){
  if(!matchLines.length)return text.slice(0,DEVELOPMENT_CONTEXT_FILE_CHARACTER_LIMIT);
  const lines=text.split(/\r?\n/);
  const selected=new Set();
  for(const lineNumber of matchLines.slice(0,8)){
    const center=Math.max(0,Number(lineNumber||1)-1);
    for(let index=Math.max(0,center-3);index<=Math.min(lines.length-1,center+4);index+=1)selected.add(index);
  }
  let output='';
  let previous=-2;
  for(const index of [...selected].sort((left,right)=>left-right)){
    if(index>previous+1)output+=`${output?'\n':''}[lines ${index+1}-${Math.min(lines.length,index+8)}]\n`;
    const next=`${index+1}: ${lines[index]}\n`;
    if(output.length+next.length>DEVELOPMENT_CONTEXT_FILE_CHARACTER_LIMIT)break;
    output+=next;
    previous=index;
  }
  return output.slice(0,DEVELOPMENT_CONTEXT_FILE_CHARACTER_LIMIT);
}

function redactDevelopmentSensitiveContent(input){
  let text=String(input||'');
  let redacted=false;
  function replace(pattern,replacement){
    text=text.replace(pattern,(...matches)=>{
      redacted=true;
      return typeof replacement==='function'?replacement(...matches):replacement;
    });
  }
  replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,DEVELOPMENT_REDACTION_MARKER);
  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|npm_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,DEVELOPMENT_REDACTION_MARKER);
  replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,(_match,scheme)=>`${scheme}${DEVELOPMENT_REDACTION_MARKER}@`);
  replace(/^(\s*(?:(?:const|let|var)\s+)?["']?(?:api[_-]?key|access[_-]?(?:key|token)|auth(?:entication|orization)?[_-]?token|bearer|client[_-]?secret|credential|password|passwd|private[_-]?key|secret|token)["']?\s*[:=]\s*)(.+)$/gim,(_match,prefix)=>`${prefix}${DEVELOPMENT_REDACTION_MARKER}`);
  replace(/(\b(?:password|pwd|access[_-]?token|api[_-]?key|client[_-]?secret)\s*=\s*)[^;\s"'`]+/gi,(_match,prefix)=>`${prefix}${DEVELOPMENT_REDACTION_MARKER}`);
  return { text,redacted };
}

function developmentContext(parameters){
  const request=developmentRequest(parameters,['query','root']);
  const query=typeof request.query==='string'?request.query.trim():'';
  if(!query||query.length>4096||query.includes('\0'))throw arcaneError('DEVELOPMENT_QUERY_INVALID','Enter a bounded codebase question.','Use between 1 and 4096 text characters.',400);
  const workspace=validateDevelopmentWorkspace(request.root);
  const gitTool=developmentGitTool();
  const tracked=developmentTrackedPaths(workspace,gitTool);
  const safeByPath=new Map();
  for(const relative of tracked){
    const safe=safeDevelopmentTrackedFile(workspace,relative);
    if(safe)safeByPath.set(safe.path,safe);
  }
  const terms=developmentQueryTerms(query);
  const scored=new Map();
  function candidate(relative,score,lineNumber){
    const safe=safeByPath.get(relative);
    if(!safe)return;
    const current=scored.get(relative)||{ safe,score:0,lines:[] };
    current.score+=score;
    if(Number.isSafeInteger(lineNumber)&&lineNumber>0&&!current.lines.includes(lineNumber))current.lines.push(lineNumber);
    scored.set(relative,current);
  }
  for(const relative of ['AGENTS.md','README.md','package.json','docs/app-building.md'])candidate(relative,1,null);
  for(const safe of safeByPath.values()){
    const lowered=safe.path.toLowerCase();
    for(const term of terms)if(lowered.includes(term))candidate(safe.path,8,null);
  }
  if(terms.length){
    const expressions=terms.flatMap((term)=>['-e',term]);
    const probe=developmentProbe(gitTool.path,developmentGitArguments(workspace.root,['grep','-I','-n','-i','-F','--max-count=120',...expressions,'--']),{cwd:workspace.root,timeout:7000,maxBuffer:1024*1024});
    if(probe.ok||probe.status===1){
    for(const line of probe.stdout.split(/\r?\n/)){
      const match=line.match(/^(.+?):(\d+):(.*)$/);
      if(match)candidate(match[1],12,Number(match[2]));
    }
    }
  }
  const ranked=[...scored.values()].sort((left,right)=>right.score-left.score||left.safe.path.localeCompare(right.safe.path)).slice(0,DEVELOPMENT_CONTEXT_FILE_COUNT_LIMIT);
  const files=[];
  let characters=0;
  for(const item of ranked){
    let buffer;
    try{buffer=fs.readFileSync(item.safe.absolute);}catch(_){continue;}
    if(buffer.includes(0))continue;
    const text=buffer.toString('utf8');
    const sanitized=redactDevelopmentSensitiveContent(text);
    let content=developmentFileExcerpt(sanitized.text,item.lines);
    const remaining=DEVELOPMENT_CONTEXT_CHARACTER_LIMIT-characters;
    if(remaining<=0)break;
    if(content.length>remaining)content=content.slice(0,remaining);
    files.push({
      path:item.safe.path,
      bytes:buffer.length,
      sha256:crypto.createHash('sha256').update(buffer).digest('hex'),
      truncated:content.length<sanitized.text.length,
      redacted:sanitized.redacted,
      content,
    });
    characters+=content.length;
  }
  return { root:workspace.root,query,files,totals:{ files:files.length,characters,limitCharacters:DEVELOPMENT_CONTEXT_CHARACTER_LIMIT } };
}

async function installDevelopmentNode(action,parameters){
  developmentRequest(parameters,[]);
  if(platform!=='win32'){
    throw arcaneError('DEVELOPMENT_NODE_INSTALL_UNAVAILABLE','Arcane Developer can install Node.js automatically only on Microsoft NT.','Install Node.js 22 or newer through your operating system’s trusted package channel.',409);
  }
  actionStep(action,5,'Installing the verified Node.js runtime…');
  await installNode(action);
  const nodeTool=developmentNodeTool();
  if(!simulate&&!nodeTool.available){
    throw arcaneError('DEVELOPMENT_NODE_INSTALL_FAILED','Arcane installed Node.js, but Arcane Developer could not use the external runtime.','Restart Arcane after confirming Node.js 22 or newer is installed in the standard system location.',409,{ node:nodeTool });
  }
  actionStep(action,100,simulate?'Node.js installation simulation complete.':'Node.js runtime ready.');
  return { installed:!simulate,simulated:simulate,node:nodeTool };
}

async function setupDevelopmentWorkspace(action,parameters){
  const request=developmentRequest(parameters,['root','taskId']);
  const taskId=String(request.taskId||'');
  if(!DEVELOPMENT_SETUP_TASK_IDS.includes(taskId)){
    throw arcaneError('DEVELOPMENT_SETUP_TASK_INVALID','Arcane rejected an unknown development setup task.','Choose one of the setup tasks reported by Arcane.development.inspect().',400,{ allowedTaskIds:DEVELOPMENT_SETUP_TASK_IDS });
  }
  if(taskId==='windows-signing'&&platform!=='win32'){
    throw arcaneError('DEVELOPMENT_SETUP_UNAVAILABLE','Microsoft NT development signing is available only on Microsoft NT.','Choose a setup task supported by this operating system.',409);
  }
  const workspace=validateDevelopmentWorkspace(request.root);
  const nodeTool=developmentNodeTool();
  const npmTool=developmentNpmTool(nodeTool);
  if(!nodeTool.available||!npmTool.available){
    throw arcaneError('DEVELOPMENT_NODE_REQUIRED','Arcane Developer requires an external Node.js 22 or newer installation with npm.','Install Node.js 22 or newer in the standard system location, then inspect the workspace again.',409,{ node:nodeTool,npm:npmTool });
  }
  const gitTool=developmentGitTool();
  if(taskId==='git-hooks'&&!gitTool.available){
    throw arcaneError('DEVELOPMENT_GIT_REQUIRED','Arcane needs Git to configure this checkout.','Install Git in a standard system location, then inspect the workspace again.',409);
  }
  const definitions={
    'root-dependencies':{ cwd:workspace.root,args:['ci','--no-audit','--no-fund'],label:'Installing root dependencies' },
    'machine-dependencies':{ cwd:workspace.bundleRoot,args:['ci','--no-audit','--no-fund'],label:'Installing machine bundle dependencies' },
    'git-hooks':{ cwd:workspace.root,args:['run','hooks:install'],label:'Configuring repository Git hooks' },
    'windows-signing':{ cwd:workspace.root,args:['run','signing:bootstrap:dev:windows'],label:'Initializing local Microsoft NT development signing' },
  };
  const definition=definitions[taskId];
  actionStep(action,10,`${definition.label}…`);
  const result=await run(nodeTool.path,[npmTool.path,...definition.args],{
    action,
    cwd:definition.cwd,
    env:developmentCommandEnvironment(nodeTool,gitTool),
    displayCommand:`$ npm ${definition.args.join(' ')}`,
  });
  actionStep(action,100,`${definition.label} complete.`);
  return { root:workspace.root,taskId,completed:true,exitCode:result.code };
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
  boundedSpawnSync,
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
  bundleRoot,
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
  { id: 'ollama', name: 'Ollama', minimumVersion: BUNDLE_MANIFEST.requirements.ollama.minimumVersion, required: platform === 'win32', requiredFor: ['arcane-user'], requiredScope: 'machine', installable: false, description: platform === 'win32' ? 'Machine-wide local model runtime and ArcaneOllama service required by provisioned Arcane users.' : 'Optional for base Arcane OS installation on Linux; a machine-wide Ollama service is required before using local AI.' },
  { id: 'renderer', name: 'Native web renderer', minimumVersion: null, required: true, installable: false, description: 'WebView2 on Microsoft NT or WebKitGTK on Linux; install it from the operating-system/vendor channel before launching Arcane.' },
  { id: 'session-control', name: 'Session control', minimumVersion: null, required: true, installable: false, description: 'Native logout and lock capability.' },
]);
function checkOllamaRequirement(definition) {
  const serviceLabel = platform === 'win32' ? 'ArcaneOllama service' : 'machine-wide Ollama service';
  let detected;
  if (typeof native.ollamaStatus === 'function') {
    detected = native.ollamaStatus();
  } else {
    const legacyExecutable = native.ollamaExecutable();
    detected = {
      machine: { present: Boolean(legacyExecutable), executable: legacyExecutable, service: null },
      user: { present: false, executable: null },
    };
  }
  const machine = detected && detected.machine || { present: false, executable: null, service: null };
  const user = detected && detected.user || { present: false, executable: null };
  const executable = machine.present && machine.executable ? machine.executable : null;
  const version = executable
    ? (simulate ? definition.minimumVersion : versionFromCommand(executable, ['--version']))
    : null;
  const service = machine.service || {
    name: platform === 'win32' ? 'ArcaneOllama' : null,
    present: false,
    state: executable ? 'unverified' : 'missing',
    startType: null,
    command: null,
    commandMatches: false,
    ready: false,
  };
  const availability = typeof native.ollamaGlobalInstallAvailability === 'function'
    ? native.ollamaGlobalInstallAvailability()
    : {
        available: false,
        status: 'manual-only',
        requiresElevation: true,
        provider: null,
        reason: 'Install Ollama globally from a trusted administrator-managed package channel.',
      };

  let status;
  let message;
  if (!executable) {
    status = user.present ? 'global-install-required' : 'missing';
    message = platform === 'win32' && user.present
      ? 'A user-scoped Ollama copy is present, but Arcane users require the machine-wide ArcaneOllama service. Exit the user-scoped Ollama tray application before installing globally.'
      : platform === 'win32'
      ? 'Ollama is not installed globally. Arcane users require the machine-wide ArcaneOllama service.'
      : 'Ollama is not installed globally.';
  } else if (!version || compareVersions(version, definition.minimumVersion) < 0) {
    status = 'update-required';
    message = `The global Ollama version ${version || 'unknown'} is below minimum ${definition.minimumVersion}.`;
  } else if (!service.ready) {
    status = 'repair-required';
    message = service.present
      ? `Global Ollama ${version} is installed, but the ${serviceLabel} is ${service.state || 'not ready'} or misconfigured.`
      : `Global Ollama ${version} is installed, but the ${serviceLabel} is missing.`;
    if (platform === 'win32' && user.present && service.state !== 'running') {
      message += ' Exit the user-scoped Ollama tray application so it releases the local Ollama port, then retry the global service repair.';
    }
  } else {
    status = 'ready';
    message = platform === 'win32'
      ? `Globally installed Ollama ${version}; ArcaneOllama is running and available to Arcane users.`
      : `Globally installed Ollama ${version}; the machine-wide Ollama service is running and available for local AI.`;
  }

  const ready = status === 'ready';
  const available = Boolean(availability && availability.available);
  const action = ready ? null
    : status === 'update-required' ? 'update'
    : status === 'repair-required' ? 'repair'
    : 'install';
  const globalInstall = {
    available,
    status: ready ? 'not-needed' : available ? 'available' : String(availability && availability.status || 'manual-only'),
    action: ready ? null : available ? action : null,
    requiresElevation: availability ? availability.requiresElevation !== false : true,
    provider: availability && availability.provider || null,
    reason: availability && availability.reason || null,
  };
  if (!ready) {
    message += available
      ? ` A verified global ${action} action is available in Arcane Provisioner.`
      : ` ${globalInstall.reason || 'A machine administrator must install or repair Ollama globally.'}`;
    if (!definition.required) {
      message += ' This does not block base Arcane OS installation on Linux; complete it before using local AI.';
    }
  }

  return {
    ...definition,
    installable: available,
    ready,
    blocking: Boolean(definition.required && !ready),
    status,
    version,
    executable,
    detection: {
      machine: { ...machine, present: Boolean(executable), executable, version, ready },
      user: { present: Boolean(user.present && user.executable), executable: user.present && user.executable || null },
    },
    globalInstall,
    message,
    platform: osInfo().platform,
    adapter: native.id,
  };
}
function checkRequirement(definition) {
  if (definition.id === 'ollama') return checkOllamaRequirement(definition);
  let executable = null;
  let version = null;
  if (definition.id === 'node') {
    executable = native.nodeExecutable();
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
  const ready = status === 'ready';
  return { ...definition, ready, blocking: Boolean(definition.required && !ready), status, version, executable, message, platform: osInfo().platform, adapter: native.id };
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
  let lease = null;
  let primaryError = null;
  let stage = null;
  let stageOwnership = null;
  try {
    if (native.acquireInstallLease) lease = await native.acquireInstallLease(action);
    const root = bundleRoot();
    const payload = native.installPayload(root);
    if (!simulate && payload.selfHosted) {
      throw arcaneError(
        'EXTERNAL_PROVISIONER_REQUIRED',
        'The installed Arcane Provisioner cannot replace the verified installation that is currently running it.',
        'Close installed Arcane processes, then run the new verified Arcane Provisioner from a release folder outside the Arcane installation directory.',
        409,
        { installRoot: PATHS.installRoot }
      );
    }
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
    if (!simulate && native.assertNoRunningInstalledApplications) native.assertNoRunningInstalledApplications();
    await recoverInterruptedInstallation(action);
    actionLog(action, 'info', `Installing Arcane ${VERSION} globally from ${root}.`, { payloadMode: payload.mode });
    stage = simulate ? null : `${PATHS.installRoot}.stage-${process.pid}-${crypto.randomBytes(24).toString('hex')}`;
    if (!simulate) {
      await fsp.mkdir(stage, { recursive: false, ...(platform === 'linux' ? { mode: 0o700 } : {}) });
      if (typeof native.prepareInstallStage === 'function') await native.prepareInstallStage(stage, action);
      if (typeof native.captureInstallStageOwnership === 'function') {
        stageOwnership = native.captureInstallStageOwnership(stage);
      } else if (platform === 'win32' || platform === 'linux') {
        throw new Error('The native adapter cannot bind an installation stage to its filesystem identity.');
      }
      if (payload.integrity && typeof native.materializeInstallStage === 'function') {
        await native.materializeInstallStage(stage, payload, action);
      } else {
        for (const file of payload.files) {
          const installPath = normalizeIntegrityPath(file.installPath || `bin/${file.destinationName}`);
          const sourceStat = fs.lstatSync(file.source);
          if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Arcane refused an unsafe release source for ${installPath}.`);
          const destination = integrityFilePath(stage, installPath);
          await ensureDir(path.dirname(destination));
          await fsp.copyFile(file.source, destination);
          if (file.executable) await fsp.chmod(destination, 0o755);
        }
        if (payload.mode !== 'windows-webview2') {
          for (const directory of payload.directories || []) await copyTree(directory.source, path.join(stage, directory.destinationName));
          const bundleManifestSource = payload.bundleManifestSource || path.join(root, 'arcane-bundle.json');
          if (fs.existsSync(bundleManifestSource)) await fsp.copyFile(bundleManifestSource, path.join(stage, 'arcane-bundle.json'));
        }
      }
      await native.writeLaunchers(stage, payload);
      if (payload.integrity && typeof native.finalizeInstallStage === 'function') {
        await native.finalizeInstallStage(stage, payload, action);
      }
      if (payload.integrity) {
        verifyIntegrityEntries(stage, payload.integrity.files, true);
        if (native.verifyStagedInstallation) native.verifyStagedInstallation(stage, false);
      }
    }
    let publisherAttestation = null;
    if (!simulate && payload.integrity) {
      if (typeof native.createPublisherAttestation !== 'function') throw new Error('The native adapter cannot bind publisher verification to the installation transaction.');
      publisherAttestation = native.createPublisherAttestation(stage);
    }
    const installationSecurityMode = activeReleaseSecurityMode();
    if (!simulate && !['publisher-verified','unsigned-local-test'].includes(installationSecurityMode)) {
      throw new Error('Arcane cannot persist an installation without a verified release-security mode.');
    }
    if (payload.securityMode && payload.securityMode !== installationSecurityMode) {
      throw new Error('The verified installation payload security mode does not match the active native host proof.');
    }
    let preservedPlatformConfiguration = null;
    if (!simulate && native.preservePlatformConfiguration && fs.existsSync(path.join(PATHS.installRoot, 'arcane-install.json'))) {
      try {
        const existingManifest = readJsonFile(path.join(PATHS.installRoot, 'arcane-install.json'));
        preservedPlatformConfiguration = native.preservePlatformConfiguration(existingManifest && existingManifest.platformConfiguration);
      } catch (_) {}
    }
    const manifest = {
      name: 'Arcane OS',
      version: VERSION,
      installedAt: stamp(),
      installedBy: currentIdentity(),
      platform: osInfo(),
      nativeAdapter: native.id,
      payloadMode: payload.mode,
      securityMode: installationSecurityMode,
      sourceBundle: root,
      requirements: BUNDLE_MANIFEST.requirements,
      ...(preservedPlatformConfiguration ? { platformConfiguration: preservedPlatformConfiguration } : {}),
      ...(publisherAttestation ? { publisherAttestation } : {}),
      integrity: simulate ? { schemaVersion: 2, hashAlgorithm: 'sha256', scope: 'simulation', files: [] } : createInstalledIntegrity(stage),
    };
    if (!simulate) {
      await writeFile(path.join(stage, 'arcane-install.json'), JSON.stringify(manifest, null, 2));
      if (native.verifyStagedInstallation) native.verifyStagedInstallation(stage, true);
      const backup = `${PATHS.installRoot}.backup`;
      if (fs.existsSync(backup)) {
        throw arcaneError('INSTALL_BACKUP_BUSY', 'Arcane preserved an unresolved installation backup and will not overwrite it.', 'Review the backup and active installation as an administrator before retrying.', 409, { backup });
      }
      if (native.assertNoRunningInstalledApplications) native.assertNoRunningInstalledApplications();
      let movedExisting = false;
      if (fs.existsSync(PATHS.installRoot)) {
        await snapshotActiveInstallationForRollback(action);
        try { await fsp.rename(PATHS.installRoot, backup); movedExisting = true; }
        catch (error) {
          if (['EBUSY', 'EPERM', 'EACCES'].includes(error && error.code)) {
            throw arcaneError('APPLICATIONS_BUSY', 'Arcane could not update files while an application is using them.', 'Close all Arcane applications, then retry.', 409, { retryable: true });
          }
          throw error;
        }
      }
      let activated = false;
      let installIntegration = null;
      let graphicalConfiguration = null;
      try {
        try {
          await fsp.rename(stage, PATHS.installRoot);
          activated = true;
          const activatedOwnership = stageOwnership && typeof native.installStageOwnershipStatus === 'function'
            ? native.installStageOwnershipStatus(stageOwnership, PATHS.installRoot)
            : null;
          if (stageOwnership && (!activatedOwnership || activatedOwnership.state !== 'owned')) {
            throw arcaneError(
              'INSTALL_STAGE_IDENTITY_LOST',
              'Arcane could not prove that the activated installation is the exact verified stage it created.',
              'Arcane will preserve the uncertain installation tree and restore the previous installation when possible.',
              409,
              { reason: activatedOwnership && activatedOwnership.reason || 'identity-unavailable' }
            );
          }
        }
        catch (error) {
          if (['EBUSY', 'EPERM', 'EACCES'].includes(error && error.code)) {
            throw arcaneError('APPLICATIONS_BUSY', 'Arcane could not activate the update while an application is using its files.', 'Close all Arcane applications, then retry.', 409, { retryable: true });
          }
          throw error;
        }
        const installedVerification = verifyInstalledIntegrity(manifest);
        if (!installedVerification.ok) throw new Error(`Arcane rejected the activated installation: ${installedVerification.reason}`);
        if (native.verifyStagedInstallation) native.verifyStagedInstallation(PATHS.installRoot, true);
        installIntegration = await native.applyInstallPermissions(action);
        await ensureDir(PATHS.stateRoot);
        if (native.applyStatePermissions) await native.applyStatePermissions(action);
        if (!movedExisting && native.configureGraphicalTarget) {
          const linuxPolicy = BUNDLE_MANIFEST.installation && BUNDLE_MANIFEST.installation.linux;
          graphicalConfiguration = await native.configureGraphicalTarget(action, linuxPolicy);
          manifest.platformConfiguration = { linux: graphicalConfiguration };
          await durableWriteFile(path.join(PATHS.installRoot, 'arcane-install.json'), JSON.stringify(manifest, null, 2), 0o644);
          const configuredVerification = verifyInstalledIntegrity(manifest);
          if (!configuredVerification.ok) throw new Error(`Arcane rejected the configured installation: ${configuredVerification.reason}`);
          if (native.verifyStagedInstallation) native.verifyStagedInstallation(PATHS.installRoot, true);
        }
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
            if (replacedVerification.ok) await fsp.rm(backup, { recursive: true, force: true });
            else {
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
        const failed = `${PATHS.installRoot}.failed-${Date.now()}`;
        try {
          if (graphicalConfiguration && native.rollbackGraphicalTarget) {
            await native.rollbackGraphicalTarget(graphicalConfiguration, action);
          }
          if (installIntegration && native.rollbackInstallIntegration) {
            await native.rollbackInstallIntegration(installIntegration, action);
          }
          let failedOwnershipVerified = false;
          if (activated && fs.existsSync(PATHS.installRoot)) {
            await fsp.rename(PATHS.installRoot, failed);
            const failedOwnership = stageOwnership && typeof native.installStageOwnershipStatus === 'function'
              ? native.installStageOwnershipStatus(stageOwnership, failed)
              : null;
            failedOwnershipVerified = Boolean(failedOwnership && failedOwnership.state === 'owned');
            if (stageOwnership && !failedOwnershipVerified) {
              actionLog(action, 'warn', 'Arcane preserved the failed activated tree because its original stage identity could not be proven.', {
                failed,
                reason: failedOwnership && failedOwnership.reason || 'identity-unavailable',
              });
            }
          }
          if (movedExisting && fs.existsSync(backup)) await fsp.rename(backup, PATHS.installRoot);
          if (failedOwnershipVerified && fs.existsSync(failed) && typeof native.cleanupInstallStage === 'function') {
            await native.cleanupInstallStage(stageOwnership, failed, action);
          }
        } catch (rollbackError) {
          throw arcaneError(
            'INSTALL_ROLLBACK_FAILED',
            'Arcane could not restore the previous installation after activation failed.',
            'Preserve the installation, backup, and failed directories for administrator recovery.',
            500,
            { originalCode: error && error.code || null, rollbackCode: rollbackError && rollbackError.code || null }
          );
        }
        throw error;
      }
    }
    if (simulate) simulatedInstallationManifest = { ...manifest, simulated: true };
    actionLog(action, 'info', `Arcane ${VERSION} installed at ${PATHS.installRoot}.`, { payloadMode: payload.mode });
    return manifest;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (primaryError && stage && stageOwnership && typeof native.cleanupInstallStage === 'function') {
      try { await native.cleanupInstallStage(stageOwnership, stage, action); }
      catch (cleanupError) {
        actionLog(action, 'warn', 'Arcane preserved its installation stage because cleanup could not be completed safely.', {
          stage,
          code: cleanupError && cleanupError.code || null,
        });
      }
    }
    if (lease && native.releaseInstallLease) {
      try { await native.releaseInstallLease(lease); }
      catch (leaseError) {
        if (primaryError) actionLog(action, 'error', 'Arcane could not release its installation lease after failure.', { code: leaseError.code || null });
        else throw leaseError;
      }
    }
  }
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
  } else if (state.repairRequired) {
    actionStep(action, 62, `Repairing the Arcane ${VERSION} installation from the verified release…`);
    actionLog(action, 'info', 'The installed Arcane version requires repair from the verified release.', {
      repairReason: state.repairReason,
      installedPayloadMode: state.installedPayloadMode,
      packagePayloadMode: state.payload && state.payload.mode,
      installedIntegrity: state.installedIntegrity,
      installedIdentity: state.installedIdentity,
    });
    manifest = await installArcaneGlobally(action);
  } else {
    actionStep(action, 72, `Arcane OS ${state.installedVersion || VERSION} is already installed.`);
    actionLog(action, 'info', `Arcane OS ${state.installedVersion || VERSION} is current; no replacement was required.`);
  }
  const modelRequirement = checkRequirements(['ollama']).find((requirement) => requirement.id === 'ollama') || null;
  let model;
  if (modelRequirement && modelRequirement.required === false) {
    actionLog(action, 'info', 'Deferred Arcane local-model setup so base Linux installation remains independent of Ollama.', {
      requirementStatus: modelRequirement.status,
      requiredBefore: 'local-ai',
    });
    model = Object.freeze({ status: 'deferred', reason: modelRequirement.status === 'ready' ? 'base-install-local-ai-decoupled' : 'ollama-not-ready', requiredBefore: 'local-ai', created: false });
  } else {
    model = await ensureManagedArcaneModel(action);
  }
  const installation = installationState();
  const requirements = checkRequirements();
  const failedRequirements = requirements.filter((requirement) => requirement.required !== false && requirement.status !== 'ready');
  const ready = Boolean(
    installation.present
    && !installation.blocked
    && !installation.repairRequired
    && installation.disposition === 'current'
    && installation.installedIntegrity && installation.installedIntegrity.ok
    && installation.installedIdentity && installation.installedIdentity.ok
    && failedRequirements.length === 0
  );
  if (!ready) {
    throw arcaneError(
      'INSTALL_POSTCONDITION_FAILED',
      'Arcane installed the release, but its final readiness verification did not pass.',
      'Review the reported installation identity, integrity, permissions, and machine requirements, then repair from a complete verified release.',
      500,
      { installation, failedRequirements }
    );
  }
  return { manifest, installation, requirements, model };
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
      'Use the supported Microsoft NT provisioner, or install a display-manager-safe Arcane desktop session before enabling Linux account integration.',
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
  const assignedShell = native.shellCommand();
  const assignedSecurityMode = simulate ? 'simulation' : installedReleaseSecurityMode();
  if (['windows','linux'].includes(native.id) && !simulate) {
    const unsignedCommand = native.id === 'windows' && assignedShell.endsWith(' --allow-unsigned-local-release');
    if (!['publisher-verified','unsigned-local-test'].includes(assignedSecurityMode)
      || (native.id === 'windows' && unsignedCommand !== (assignedSecurityMode === 'unsigned-local-test'))) {
      throw arcaneError(
        'RELEASE_SECURITY_UNVERIFIED',
        'Arcane refused to assign a login shell without a verified release security mode.',
        'Repair or reinstall Arcane OS, then retry the user assignment.',
        409
      );
    }
  }
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
          if (!hasStableAccountIdentity(priorRecord)) {
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
              `Arcane found “${username}” after an interrupted account creation, but no trusted operating-system identity was durably recorded.`,
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
            uid: priorRecord.uid,
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
      const legacyWindowsAssignment = Boolean(
        native.id === 'windows'
        && priorRecord
        && priorRecord.accountExistedBefore === true
        && priorRecord.previousShellCaptured
        && priorRecord.shellMutationPhase === 'assigned'
        && (Number(priorRecord.shellBindingVersion) !== 2 || priorRecord.assignmentMode !== 'windows-dual')
      );
      if (legacyWindowsAssignment) {
        if (!native.userExists(username)) {
          throw arcaneError(
            'USER_NOT_FOUND',
            `Arcane cannot migrate the legacy shell recovery record for “${username}” because the account no longer exists.`,
            'Confirm whether the account was intentionally removed, then review its protected Arcane recovery record as an administrator.',
            404,
            { username }
          );
        }
        const restoredLegacy = await native.restoreUserShell(
          username,
          shellRecoveryDescriptor(priorRecord, 'assigned'),
          action
        );
        await updateArcaneUserRecord(username, {
          shell: restoredLegacy.shell ?? null,
          shellRestoredAt: stamp(),
          shellMutationPhase: 'legacy-migrated',
          shellMutationCompletedAt: stamp(),
          accountMutationPhase: 'existing-account',
          accountMutationCompletedAt: stamp(),
        });
        const refreshed = (await listArcaneUsers()).find((user) => String(user.username || '').toLowerCase() === userKey);
        if (refreshed) existingUsers.set(userKey, refreshed);
        else existingUsers.delete(userKey);
        priorRecord = readArcaneUsersState().users[userKey] || null;
        actionLog(action, 'warn', `Arcane restored ${username} from its original legacy recovery record before capturing a new dual-binding baseline.`);
      }
      if (priorRecord
        && priorRecord.accountExistedBefore === true
        && priorRecord.previousShellCaptured
        && priorRecord.shellMutationPhase === 'prepared') {
        if (!native.userExists(username)) {
          throw arcaneError(
            'USER_NOT_FOUND',
            `Arcane cannot recover the interrupted shell transaction for “${username}” because the account no longer exists.`,
            'Confirm whether the account was intentionally removed, then review its protected Arcane recovery record as an administrator.',
            404,
            { username }
          );
        }
        const recoveredShell = await native.restoreUserShell(
          username,
          shellRecoveryDescriptor(priorRecord, 'prepared'),
          action
        );
        await updateArcaneUserRecord(username, {
          shell: recoveredShell.shell ?? null,
          shellRestoredAt: stamp(),
          shellMutationPhase: 'recovered',
          shellMutationCompletedAt: stamp(),
          accountMutationPhase: 'existing-account',
          accountMutationCompletedAt: stamp(),
        });
        const refreshed = (await listArcaneUsers()).find((user) => String(user.username || '').toLowerCase() === userKey);
        if (refreshed) existingUsers.set(userKey, refreshed);
        else existingUsers.delete(userKey);
        priorRecord = readArcaneUsersState().users[userKey] || null;
        actionLog(action, 'warn', `Arcane restored the original durable shell baseline for ${username} before starting a new provisioning transaction.`);
      }
      const recordedCommandMigration = Boolean(
        native.id === 'windows'
        && priorRecord
        && priorRecord.accountExistedBefore === true
        && priorRecord.previousShellCaptured
        && priorRecord.shellMutationPhase === 'assigned'
        && Number(priorRecord.shellBindingVersion) === 2
        && priorRecord.assignmentMode === 'windows-dual'
        && typeof priorRecord.shell === 'string'
        && priorRecord.shell
        && priorRecord.shell !== assignedShell
      );
      if (recordedCommandMigration) {
        const observed = existingUsers.get(userKey);
        const recordedShellStillAssigned = Boolean(
          observed
          && observed.policyShellPresent
          && observed.legacyShellPresent
          && observed.policyShell === priorRecord.shell
          && observed.legacyShell === priorRecord.shell
        );
        if (!recordedShellStillAssigned) {
          throw arcaneError(
            'SHELL_CHANGED_EXTERNALLY',
            'Arcane refused to migrate the recorded login-shell command because the current bindings no longer match it exactly.',
            'Review both protected per-user Microsoft NT shell bindings before retrying.',
            409,
            { username }
          );
        }
        const restoredRecorded = await native.restoreUserShell(
          username,
          shellRecoveryDescriptor(priorRecord, 'assigned'),
          action
        );
        await updateArcaneUserRecord(username, {
          shell: restoredRecorded.shell ?? null,
          shellRestoredAt: stamp(),
          shellMutationPhase: 'command-migrated',
          shellMutationCompletedAt: stamp(),
          accountMutationPhase: 'existing-account',
          accountMutationCompletedAt: stamp(),
        });
        const refreshed = (await listArcaneUsers()).find((user) => String(user.username || '').toLowerCase() === userKey);
        if (refreshed) existingUsers.set(userKey, refreshed);
        else existingUsers.delete(userKey);
        priorRecord = readArcaneUsersState().users[userKey] || null;
        actionLog(action, 'warn', 'Arcane restored the recorded login-shell baseline for ' + username + ' before normalizing its exact shell command.');
      }
      const existingArcaneUser = existingUsers.get(userKey);
      if (existingArcaneUser && existingArcaneUser.shellAssigned) {
        if (priorRecord && (priorRecord.shell !== assignedShell || priorRecord.securityMode !== assignedSecurityMode)) {
          await updateArcaneUserRecord(username, { shell: assignedShell, securityMode: assignedSecurityMode });
        }
        const payload = { ...existingArcaneUser, created: false, alreadyAssigned: true, passwordStatus: existingArcaneUser.passwordStatus || 'existing-password-unchanged' };
        results.push(payload);
        actionLog(action, 'info', `${username} already uses Arcane as its verified login shell; no account or password change was made.`, payload);
        continue;
      }
      const backup = await native.prepareUserShellBackup(username, action);
      if (native.id === 'windows' && !isCompleteWindowsDualBackup(backup)) {
        throw arcaneError(
          'WINDOWS_SHELL_BACKUP_INCOMPLETE',
          `Arcane could not capture both Microsoft NT shell bindings for “${username}”.`,
          'No shell change was made. Sign the account out, confirm its profile is available, and retry from an administrator session.',
          409,
          { username }
        );
      }
      if (backupAlreadyUsesArcane(backup)) {
        const payload = { username, created: false, alreadyAssigned: true, shell: native.shellCommand(), passwordStatus: priorRecord && priorRecord.passwordStatus || 'existing-password-unchanged' };
        results.push(payload);
        existingUsers.set(username.toLowerCase(), { ...payload, shellAssigned: true });
        actionLog(action, 'info', `${username} already uses the exact installed Arcane shell; its existing recovery baseline was preserved.`, payload);
        continue;
      }
      await updateArcaneUserRecord(username, {
        createdByArcane: priorRecord ? Boolean(priorRecord.createdByArcane) : false,
        shell: assignedShell,
        securityMode: assignedSecurityMode,
        previousShell: backup.previousShell ?? null,
        previousShellPresent: Boolean(backup.previousShellPresent),
        previousPolicyShell: backup.previousPolicyShell ?? null,
        previousPolicyShellPresent: Boolean(backup.previousPolicyShellPresent),
        previousLegacyShell: backup.previousLegacyShell ?? null,
        previousLegacyShellPresent: Boolean(backup.previousLegacyShellPresent),
        shellBindingVersion: Number(backup.shellBindingVersion) || 1,
        assignmentMode: backup.assignmentMode || (native.id === 'windows' ? 'windows-legacy' : 'linux-login-shell'),
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
        previousPolicyShellPresent: Boolean(backup.previousPolicyShellPresent),
        previousLegacyShellPresent: Boolean(backup.previousLegacyShellPresent),
        shellBindingVersion: Number(backup.shellBindingVersion) || 1,
        assignmentMode: backup.assignmentMode || null,
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
        shell: result.shell || assignedShell,
        securityMode: assignedSecurityMode,
        profile: result.profile || null,
        sid: result.sid || null,
        uid: result.uid !== undefined ? result.uid : null,
        previousShell: backup.previousShell ?? null,
        previousShellPresent: Boolean(backup.previousShellPresent),
        previousPolicyShell: backup.previousPolicyShell ?? null,
        previousPolicyShellPresent: Boolean(backup.previousPolicyShellPresent),
        previousLegacyShell: backup.previousLegacyShell ?? null,
        previousLegacyShellPresent: Boolean(backup.previousLegacyShellPresent),
        shellBindingVersion: Number(backup.shellBindingVersion) || 1,
        assignmentMode: backup.assignmentMode || (native.id === 'windows' ? 'windows-legacy' : 'linux-login-shell'),
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
            shellRecoveryDescriptor(item.backup, 'assigned'),
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
  if (!record || record.accountExistedBefore !== false || record.accountMutationPhase !== 'activation-pending' || !hasStableAccountIdentity(record)) {
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
    uid: record.uid,
    profile: record.profile || null,
    shell: record.shell || native.shellCommand(),
    previousShell: record.previousShell ?? null,
    previousShellPresent: Boolean(record.previousShellPresent),
    previousPolicyShell: record.previousPolicyShell ?? null,
    previousPolicyShellPresent: Boolean(record.previousPolicyShellPresent),
    previousLegacyShell: record.previousLegacyShell ?? null,
    previousLegacyShellPresent: Boolean(record.previousLegacyShellPresent),
    shellBindingVersion: Number(record.shellBindingVersion) || 1,
    assignmentMode: record.assignmentMode || (native.id === 'windows' ? 'windows-legacy' : 'linux-login-shell'),
    shellMutationPhase: record.shellMutationPhase || 'assigned',
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
      'Simulated process loss after the operating system accepted the saved temporary password.',
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
    shellRecoveryDescriptor(record, preparedRecovery ? 'prepared' : 'assigned'),
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
async function verifyArcaneUserShell(username, action) {
  const normalized = validateProvisioningUsername(username);
  const record = readArcaneUsersState().users[String(normalized).toLowerCase()] || null;
  if (!record || !record.previousShellCaptured) {
    throw arcaneError(
      'NOT_ARCANE_USER',
      `Arcane does not have a managed shell record for “${normalized}”.`,
      'Only verify accounts that were configured by this Arcane provisioner.',
      404,
      { username: normalized }
    );
  }
  actionStep(action, 35, `Loading and verifying the signed-out profile for ${normalized}…`);
  const users = await listArcaneUsers();
  const target = users.find((item) => String(item.username || '').toLowerCase() === normalized.toLowerCase());
  if (!target) {
    throw arcaneError('USER_NOT_FOUND', `The account “${normalized}” no longer exists.`, 'Refresh the Arcane user list after confirming the operating-system account was intentionally deleted.', 404, { username: normalized });
  }
  const verified = {
    ...target,
    administratorVerified: true,
    administratorVerifiedAt: stamp(),
  };
  const verifiedMessage = native.id === 'windows'
    ? `Both protected Microsoft NT shell bindings for ${normalized} match the exact Arcane command.`
    : `The protected Linux login-shell field for ${normalized} matches the exact installed Arcane launcher.`;
  const mismatchMessage = native.id === 'windows'
    ? `Administrator verification found that ${normalized} does not have both exact Arcane shell bindings.`
    : `Administrator verification found that ${normalized} does not have the exact installed Arcane login shell.`;
  actionLog(action, target.shellAssigned ? 'info' : 'warn', target.shellAssigned ? verifiedMessage : mismatchMessage, verified);
  return verified;
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

const METHOD_POLICIES = __ARCANE_METHOD_POLICIES__;
const METHOD_CONTRACTS = __ARCANE_METHOD_CONTRACTS__;

function contractFailure(code, message, status) {
  throw arcaneError(code,message,'Repair or reinstall Arcane OS and retry the operation.',status);
}

function isExactDataRecord(value, requiredKeys, optionalKeys) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return false;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Object.values(descriptors).some(function hasAccessor(descriptor){return !Object.hasOwn(descriptor,'value');}))return false;
  const keys=Object.keys(descriptors).sort();
  const required=[...requiredKeys].sort();
  const allowed=new Set([...requiredKeys,...optionalKeys]);
  return required.every(function hasRequiredKey(key){return Object.hasOwn(descriptors,key);})
    &&keys.every(function hasAllowedKey(key){return allowed.has(key);});
}

function isBoundedContractString(value, maximumLength, nullable) {
  if(nullable&&value===null)return true;
  return typeof value==='string'&&value.length>0&&value.length<=maximumLength&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value);
}

function isBoundedJsonValue(value, depth, maximumStringLength) {
  if(depth>4)return false;
  if(value===null||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(typeof value==='string')return value.length<=maximumStringLength&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value);
  if(Array.isArray(value))return value.length<=64&&value.every(function validArrayEntry(entry){return isBoundedJsonValue(entry,depth+1,maximumStringLength);});
  if(!isExactDataRecord(value,[],Object.keys(value)))return false;
  const keys=Object.keys(value);
  return keys.length<=32&&keys.every(function validRecordKey(key){
    return isBoundedContractString(key,64,false)&&isBoundedJsonValue(value[key],depth+1,maximumStringLength);
  });
}

function canonicalContractMailto(value, shape) {
  if(typeof value!=='string'||value.length===0||value.length>shape.maxUriLength||value!==value.trim()||!/^mailto:[!-~]+$/i.test(value))return null;
  if(value.includes('\\')||value.includes('#')||/%(?![0-9a-f]{2})/i.test(value)||/%(?:0[0-9a-f]|1[0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/i.test(value))return null;
  return `${shape.scheme}:${value.slice(value.indexOf(':')+1)}`;
}

function validateContractMailto(value, shape) {
  return canonicalContractMailto(value,shape)!==null;
}

function validateEmptyObjectV1(parameters) {
  return isExactDataRecord(parameters,[],[]) ? parameters : null;
}

function validateExternalOpenV1(parameters, shape) {
  return isExactDataRecord(parameters,['uri'],[])&&validateContractMailto(parameters.uri,shape) ? parameters : null;
}

function validateExternalOpenResultV1(result, shape) {
  return isExactDataRecord(result,['opened','uri'],[])&&result.opened===true&&validateContractMailto(result.uri,shape) ? result : null;
}

function validateNetworkStatusV1(result, shape) {
  return isExactDataRecord(result,['interfaceCount','online'],[])
    &&typeof result.online==='boolean'
    &&Number.isSafeInteger(result.interfaceCount)
    &&result.interfaceCount>=0
    &&result.interfaceCount<=shape.maxInterfaceCount
    &&result.online===(result.interfaceCount>0) ? result : null;
}

function validateSystemPingResultV1(result) {
  return isExactDataRecord(result,['ok'],[])&&result.ok===true ? result : null;
}

function validateVersionStringV1(result, shape) {
  return isBoundedContractString(result,shape.maxLength,false)&&result===VERSION ? result : null;
}

function validateUserIdentityV1(result, shape) {
  if(!isExactDataRecord(result,['accountName','displayName','identityKind','source','username'],[]))return null;
  if(!['host-account','local-session'].includes(result.identityKind)||!['windows','linux','android'].includes(result.source))return null;
  if(!isBoundedContractString(result.displayName,shape.maxDisplayNameLength,false))return null;
  if(result.identityKind==='host-account'){
    if(!['windows','linux'].includes(result.source))return null;
    if(!isBoundedContractString(result.username,shape.maxUsernameLength,false)||!isBoundedContractString(result.accountName,shape.maxAccountNameLength,false))return null;
  }else if(result.source!=='android'||result.username!==null||result.accountName!==null)return null;
  return result;
}

function validateApplicationDescriptorV1(app, shape) {
  if(!isExactDataRecord(app,['displayName','entry','id','publisherTrustSource','revocationStatus','securityMode','type','version'],[]))return null;
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(app.id)||!isBoundedContractString(app.id,shape.maxApplicationIdLength,false)||!isBoundedContractString(app.displayName,shape.maxDisplayNameLength,false)||!['app','shell','provisioner'].includes(app.type)||!isBoundedContractString(app.entry,shape.maxApplicationEntryLength,true)||!isBoundedContractString(app.version,shape.maxApplicationVersionLength,false))return null;
  if(app.entry!==null&&(app.entry.startsWith('/')||app.entry.includes('\\')||app.entry.split('/').some(function invalidEntrySegment(segment){return !segment||segment==='.'||segment==='..';})))return null;
  if(!['publisher-verified','unsigned-local-test','unverified'].includes(app.securityMode)||!isBoundedContractString(app.publisherTrustSource,256,true)||!isBoundedContractString(app.revocationStatus,256,true))return null;
  if(app.securityMode==='publisher-verified'&&(!['administrator-policy','administrator-policy-rotation','installed-continuity','uac-approved-tofu','fresh-unpinned'].includes(app.publisherTrustSource)||!['online-good','cache-good','attested-degraded'].includes(app.revocationStatus)))return null;
  if(app.securityMode!=='publisher-verified'&&(app.publisherTrustSource!==null||app.revocationStatus!==null))return null;
  return app.version===VERSION ? app : null;
}

function validateApplicationLaunchV1(parameters, shape) {
  return isExactDataRecord(parameters,['id'],[])
    &&parameters.id.length<=shape.maxApplicationIdLength
    &&isCanonicalApplicationId(parameters.id) ? parameters : null;
}

function validateApplicationLaunchResultV1(result, shape) {
  return isExactDataRecord(result,['accepted','id'],[])
    &&result.accepted===true
    &&result.id.length<=shape.maxApplicationIdLength
    &&isCanonicalApplicationId(result.id) ? result : null;
}

function isBoundedApplicationCatalogText(value, maximumLength, nullable, allowEmpty) {
  if(nullable&&value===null)return true;
  return typeof value==='string'
    &&value.length<=maximumLength
    &&(allowEmpty||value.length>0)
    &&value===value.trim()
    &&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value);
}

function isSafeApplicationCatalogIcon(value, applicationId, shape) {
  if(value===null)return true;
  if(!isBoundedApplicationCatalogText(value,shape.maxIconUrlLength,false,false)
    ||!value.startsWith('/')
    ||value.startsWith('//')
    ||value.includes('\\')
    ||value.includes('%')
    ||value.includes('?')
    ||value.includes('#'))return false;
  const segments=value.slice(1).split('/');
  if(segments.some(function unsafeIconSegment(segment){return !segment||segment==='.'||segment==='..';}))return false;
  return value.startsWith(`/apps/${applicationId}/`)||value.startsWith(`/arcane/${applicationId}/app/`);
}

function validateApplicationCatalogRecordV1(record, verified, shape) {
  if(!isExactDataRecord(record,['description','displayName','iconUrl','id','order','verified','version'],[]))return null;
  if(!isCanonicalApplicationId(record.id)||record.id.length>shape.maxApplicationIdLength)return null;
  if(!isBoundedApplicationCatalogText(record.displayName,shape.maxDisplayNameLength,false,false))return null;
  if(!isBoundedApplicationCatalogText(record.description,shape.maxDescriptionLength,true,true))return null;
  if(!isSafeApplicationCatalogIcon(record.iconUrl,record.id,shape))return null;
  if(!isBoundedApplicationCatalogText(record.version,shape.maxApplicationVersionLength,true,false))return null;
  if(!Number.isSafeInteger(record.order)||record.order<0||record.order>shape.maxOrder||record.verified!==verified)return null;
  return record;
}

function validateApplicationCatalogV1(result, shape) {
  if(!isExactDataRecord(result,['applications','publisherTrustSource','revocationStatus','securityMode','verified'],[])
    ||typeof result.verified!=='boolean'
    ||!Array.isArray(result.applications)
    ||result.applications.length>shape.maxApplications)return null;
  const noTrustEvidence=result.publisherTrustSource===null&&result.revocationStatus===null;
  if(result.securityMode==='publisher-verified'){
    if(!result.verified
      ||!isBoundedApplicationCatalogText(result.publisherTrustSource,shape.maxSecurityEvidenceLength,false,false)
      ||!isBoundedApplicationCatalogText(result.revocationStatus,shape.maxSecurityEvidenceLength,false,false)
      ||!['administrator-policy','administrator-policy-rotation','installed-continuity','uac-approved-tofu','fresh-unpinned'].includes(result.publisherTrustSource)
      ||!['online-good','cache-good','attested-degraded'].includes(result.revocationStatus))return null;
  }else if(result.securityMode==='unsigned-local-test'){
    if(!result.verified||!noTrustEvidence)return null;
  }else if(result.securityMode==='unverified'){
    if(result.verified||!noTrustEvidence)return null;
  }else return null;
  const seen=new Set();
  let previousOrder=-1;
  for(const record of result.applications){
    if(!validateApplicationCatalogRecordV1(record,result.verified,shape)
      ||seen.has(record.id)
      ||record.order<previousOrder)return null;
    seen.add(record.id);
    previousOrder=record.order;
  }
  return result;
}

function validateContractStringList(value, maximumItems, maximumStringLength) {
  if(!Array.isArray(value)||value.length>maximumItems)return false;
  if(value.some(function invalidListEntry(entry){return !isBoundedContractString(entry,maximumStringLength,false);}))return false;
  if(new Set(value).size!==value.length)return false;
  return [...value].sort().every(function sortedListEntry(entry,index){return entry===value[index];});
}

function validatePlatformStatusV1(result, shape) {
  const topKeys=['adapter','application','architecture','capabilities','desktop','displayName','execution','permissions','platform','protocol','rawPlatform','release','renderer','sessionType','simulated','version'];
  if(!isExactDataRecord(result,topKeys,[]))return null;
  const strings=['adapter','application','architecture','displayName','release','version'];
  if(strings.some(function invalidTopString(field){return !isBoundedContractString(result[field],shape.maxStatusStringLength,false);}))return null;
  if(!['windows','linux'].includes(result.platform)||!['win32','linux'].includes(result.rawPlatform)||result.protocol!==PROTOCOL||typeof result.simulated!=='boolean')return null;
  if(!isBoundedContractString(result.desktop,shape.maxStatusStringLength,true)||!isBoundedContractString(result.sessionType,shape.maxStatusStringLength,true))return null;
  const execution=result.execution;
  if(!isExactDataRecord(execution,['evidenceClass','effectivePlatform','hostPlatform','simulation'],[]))return null;
  if(!['win32','linux'].includes(execution.hostPlatform)||!['win32','linux'].includes(execution.effectivePlatform)||typeof execution.simulation!=='boolean')return null;
  const effectivePlatformName=execution.effectivePlatform==='win32'?'windows':'linux';
  if(result.platform!==effectivePlatformName||result.rawPlatform!==execution.effectivePlatform||execution.hostPlatform!==hostPlatform)return null;
  if(result.simulated!==execution.simulation||execution.evidenceClass!==(execution.simulation?'simulation':'real-host'))return null;
  const permissions=result.permissions;
  if(!isExactDataRecord(permissions,['canElevate','detectedBy','elevated','level','mechanism','probes'],[]))return null;
  if(typeof permissions.elevated!=='boolean'||typeof permissions.canElevate!=='boolean'||!isBoundedContractString(permissions.level,shape.maxStatusStringLength,false)||!isBoundedContractString(permissions.detectedBy,shape.maxStatusStringLength,false)||!isBoundedContractString(permissions.mechanism,shape.maxStatusStringLength,true))return null;
  if(!Array.isArray(permissions.probes)||permissions.probes.length>shape.maxProbeItems||permissions.probes.some(function invalidProbe(probe){return !isBoundedJsonValue(probe,0,shape.maxStatusStringLength);}))return null;
  const capabilities=result.capabilities;
  if(!isExactDataRecord(capabilities,['app','grants','methods'],[]))return null;
  const app=capabilities.app;
  if(!isExactDataRecord(app,['displayName','entry','id','publisherTrustSource','revocationStatus','securityMode','type','version'],[]))return null;
  if(!isBoundedContractString(app.id,shape.maxApplicationIdLength,false)||!isBoundedContractString(app.displayName,shape.maxStatusStringLength,false)||!['app','shell','provisioner'].includes(app.type)||!isBoundedContractString(app.entry,shape.maxApplicationEntryLength,true)||!isBoundedContractString(app.version,shape.maxApplicationVersionLength,false))return null;
  if(!['publisher-verified','unsigned-local-test','unverified'].includes(app.securityMode)||!isBoundedContractString(app.publisherTrustSource,shape.maxStatusStringLength,true)||!isBoundedContractString(app.revocationStatus,shape.maxStatusStringLength,true))return null;
  if(app.securityMode==='publisher-verified'&&(!['administrator-policy','administrator-policy-rotation','installed-continuity','uac-approved-tofu','fresh-unpinned'].includes(app.publisherTrustSource)||!['online-good','cache-good','attested-degraded'].includes(app.revocationStatus)))return null;
  if(app.securityMode!=='publisher-verified'&&(app.publisherTrustSource!==null||app.revocationStatus!==null))return null;
  if(result.application!==app.id||result.version!==VERSION||app.version!==VERSION||!validateContractStringList(capabilities.grants,shape.maxListItems,shape.maxStatusStringLength)||!validateContractStringList(capabilities.methods,shape.maxListItems,shape.maxStatusStringLength))return null;
  if(capabilities.methods.some(function methodWithoutPolicy(method){return !METHOD_POLICIES[method];}))return null;
  if(capabilities.methods.some(function methodWithoutGrant(method){const capability=METHOD_POLICIES[method].capability;return capability&&!capabilities.grants.includes(capability);}))return null;
  const renderer=result.renderer;
  if(!isExactDataRecord(renderer,['available','id','version'],['adapter','executable']))return null;
  if(typeof renderer.available!=='boolean'||!isBoundedContractString(renderer.id,shape.maxStatusStringLength,false)||!isBoundedContractString(renderer.version,shape.maxStatusStringLength,true))return null;
  if(Object.hasOwn(renderer,'adapter')&&!isBoundedContractString(renderer.adapter,shape.maxStatusStringLength,false))return null;
  if(Object.hasOwn(renderer,'executable')&&!isBoundedContractString(renderer.executable,shape.maxRendererExecutableLength,true))return null;
  return result;
}

function isTerminalContractText(value, maximumLength, allowEmpty) {
  return typeof value==='string'
    &&value.length<=maximumLength
    &&(allowEmpty||value.length>0)
    &&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value);
}

function isTerminalContractSessionId(value, shape) {
  return typeof value==='string'&&value.length<=shape.maxSessionIdLength&&TERMINAL_ID_PATTERN.test(value);
}

function hasTerminalContractDimensions(value, shape) {
  return Number.isSafeInteger(value.columns)
    &&value.columns>=shape.minColumns
    &&value.columns<=shape.maxColumns
    &&Number.isSafeInteger(value.rows)
    &&value.rows>=shape.minRows
    &&value.rows<=shape.maxRows;
}

function validateTerminalStartV1(parameters, shape) {
  return isExactDataRecord(parameters,['columns','cwd','rows','shell'],[])
    &&isTerminalContractText(parameters.shell,shape.maxShellLength,false)
    &&isTerminalContractText(parameters.cwd,shape.maxCwdLength,true)
    &&hasTerminalContractDimensions(parameters,shape) ? parameters : null;
}

function validateTerminalSessionIdV1(parameters, shape) {
  return isExactDataRecord(parameters,['sessionId'],[])
    &&isTerminalContractSessionId(parameters.sessionId,shape) ? parameters : null;
}

function validateTerminalWriteV1(parameters, shape) {
  return isExactDataRecord(parameters,['data','sessionId'],[])
    &&isTerminalContractSessionId(parameters.sessionId,shape)
    &&typeof parameters.data==='string'
    &&Buffer.byteLength(parameters.data,'utf8')>=1
    &&Buffer.byteLength(parameters.data,'utf8')<=shape.maxDataBytes ? parameters : null;
}

function validateTerminalResizeV1(parameters, shape) {
  return isExactDataRecord(parameters,['columns','rows','sessionId'],[])
    &&isTerminalContractSessionId(parameters.sessionId,shape)
    &&hasTerminalContractDimensions(parameters,shape) ? parameters : null;
}

function validateTerminalSignalV1(parameters, shape) {
  return isExactDataRecord(parameters,['sessionId','signal'],[])
    &&isTerminalContractSessionId(parameters.sessionId,shape)
    &&['interrupt','terminate'].includes(parameters.signal) ? parameters : null;
}

function validateTerminalSessionV1(result, shape) {
  const dimensions=METHOD_CONTRACTS['terminal.start'].input;
  return isExactDataRecord(result,['columns','createdAt','cwd','id','rows','shell','title'],[])
    &&isTerminalContractSessionId(result.id,{maxSessionIdLength:shape.maxSessionIdLength})
    &&isTerminalContractText(result.shell,shape.maxShellLength,false)
    &&isTerminalContractText(result.cwd,shape.maxCwdLength,false)
    &&isTerminalContractText(result.title,shape.maxTitleLength,false)
    &&isTerminalContractText(result.createdAt,shape.maxTimestampLength,false)
    &&hasTerminalContractDimensions(result,dimensions) ? result : null;
}

function validateTerminalListV1(result, shape) {
  if(!isExactDataRecord(result,['sessions'],[])||!Array.isArray(result.sessions)||result.sessions.length>shape.maxSessions)return null;
  const dimensions=METHOD_CONTRACTS['terminal.start'].input;
  for(const session of result.sessions){
    if(!isExactDataRecord(session,['columns','createdAt','cwd','id','rows','shell','state'],[])
      ||!isTerminalContractSessionId(session.id,{maxSessionIdLength:shape.maxSessionIdLength})
      ||!isTerminalContractText(session.shell,shape.maxShellLength,false)
      ||!isTerminalContractText(session.cwd,shape.maxCwdLength,false)
      ||!isTerminalContractText(session.createdAt,shape.maxTimestampLength,false)
      ||!['starting','running','exited','closed'].includes(session.state)
      ||!hasTerminalContractDimensions(session,dimensions))return null;
  }
  return result;
}

function validateTerminalWriteResultV1(result, shape) {
  return isExactDataRecord(result,['accepted','bytes','sessionId'],[])
    &&isTerminalContractSessionId(result.sessionId,shape)
    &&result.accepted===true
    &&Number.isSafeInteger(result.bytes)
    &&result.bytes>=1
    &&result.bytes<=shape.maxDataBytes ? result : null;
}

function validateTerminalResizeResultV1(result, shape) {
  return isExactDataRecord(result,['accepted','columns','emulated','rows','sessionId'],[])
    &&isTerminalContractSessionId(result.sessionId,shape)
    &&result.accepted===true
    &&result.emulated===true
    &&hasTerminalContractDimensions(result,shape) ? result : null;
}

function validateTerminalSignalResultV1(result, shape) {
  return isExactDataRecord(result,['accepted','sessionId','signal'],[])
    &&isTerminalContractSessionId(result.sessionId,shape)
    &&['interrupt','terminate'].includes(result.signal)
    &&typeof result.accepted==='boolean' ? result : null;
}

function validateTerminalCloseResultV1(result, shape) {
  return isExactDataRecord(result,['accepted','sessionId'],[])
    &&isTerminalContractSessionId(result.sessionId,shape)
    &&result.accepted===true ? result : null;
}

function isTerminalContractText(value, maximumLength, allowEmpty) {
  return typeof value==='string'
    &&value.length<=maximumLength
    &&(allowEmpty||value.length>0)
    &&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value);
}

function isTerminalContractSessionId(value, shape) {
  return typeof value==='string'&&value.length<=shape.maxSessionIdLength&&TERMINAL_ID_PATTERN.test(value);
}

function hasTerminalContractDimensions(value, shape) {
  return Number.isSafeInteger(value.columns)
    &&value.columns>=shape.minColumns
    &&value.columns<=shape.maxColumns
    &&Number.isSafeInteger(value.rows)
    &&value.rows>=shape.minRows
    &&value.rows<=shape.maxRows;
}

function validateTerminalStartV1(parameters, shape) {
  return isExactDataRecord(parameters,['columns','cwd','rows','shell'],[])
    &&isTerminalContractText(parameters.shell,shape.maxShellLength,false)
    &&isTerminalContractText(parameters.cwd,shape.maxCwdLength,true)
    &&hasTerminalContractDimensions(parameters,shape) ? parameters : null;
}

function validateTerminalSessionIdV1(parameters, shape) {
  return isExactDataRecord(parameters,['sessionId'],[])
    &&isTerminalContractSessionId(parameters.sessionId,shape) ? parameters : null;
}

function validateTerminalWriteV1(parameters, shape) {
  return isExactDataRecord(parameters,['data','sessionId'],[])
    &&isTerminalContractSessionId(parameters.sessionId,shape)
    &&typeof parameters.data==='string'
    &&Buffer.byteLength(parameters.data,'utf8')>=1
    &&Buffer.byteLength(parameters.data,'utf8')<=shape.maxDataBytes ? parameters : null;
}

function validateTerminalResizeV1(parameters, shape) {
  return isExactDataRecord(parameters,['columns','rows','sessionId'],[])
    &&isTerminalContractSessionId(parameters.sessionId,shape)
    &&hasTerminalContractDimensions(parameters,shape) ? parameters : null;
}

function validateTerminalSignalV1(parameters, shape) {
  return isExactDataRecord(parameters,['sessionId','signal'],[])
    &&isTerminalContractSessionId(parameters.sessionId,shape)
    &&['interrupt','terminate'].includes(parameters.signal) ? parameters : null;
}

function validateTerminalSessionV1(result, shape) {
  const dimensions=METHOD_CONTRACTS['terminal.start'].input;
  return isExactDataRecord(result,['columns','createdAt','cwd','id','rows','shell','title'],[])
    &&isTerminalContractSessionId(result.id,{maxSessionIdLength:shape.maxSessionIdLength})
    &&isTerminalContractText(result.shell,shape.maxShellLength,false)
    &&isTerminalContractText(result.cwd,shape.maxCwdLength,false)
    &&isTerminalContractText(result.title,shape.maxTitleLength,false)
    &&isTerminalContractText(result.createdAt,shape.maxTimestampLength,false)
    &&hasTerminalContractDimensions(result,dimensions) ? result : null;
}

function validateTerminalListV1(result, shape) {
  if(!isExactDataRecord(result,['sessions'],[])||!Array.isArray(result.sessions)||result.sessions.length>shape.maxSessions)return null;
  const dimensions=METHOD_CONTRACTS['terminal.start'].input;
  for(const session of result.sessions){
    if(!isExactDataRecord(session,['columns','createdAt','cwd','id','rows','shell','state'],[])
      ||!isTerminalContractSessionId(session.id,{maxSessionIdLength:shape.maxSessionIdLength})
      ||!isTerminalContractText(session.shell,shape.maxShellLength,false)
      ||!isTerminalContractText(session.cwd,shape.maxCwdLength,false)
      ||!isTerminalContractText(session.createdAt,shape.maxTimestampLength,false)
      ||!['starting','running','exited','closed'].includes(session.state)
      ||!hasTerminalContractDimensions(session,dimensions))return null;
  }
  return result;
}

function validateTerminalWriteResultV1(result, shape) {
  return isExactDataRecord(result,['accepted','bytes','sessionId'],[])
    &&isTerminalContractSessionId(result.sessionId,shape)
    &&result.accepted===true
    &&Number.isSafeInteger(result.bytes)
    &&result.bytes>=1
    &&result.bytes<=shape.maxDataBytes ? result : null;
}

function validateTerminalResizeResultV1(result, shape) {
  return isExactDataRecord(result,['accepted','columns','emulated','rows','sessionId'],[])
    &&isTerminalContractSessionId(result.sessionId,shape)
    &&result.accepted===true
    &&result.emulated===true
    &&hasTerminalContractDimensions(result,shape) ? result : null;
}

function validateTerminalSignalResultV1(result, shape) {
  return isExactDataRecord(result,['accepted','sessionId','signal'],[])
    &&isTerminalContractSessionId(result.sessionId,shape)
    &&['interrupt','terminate'].includes(result.signal)
    &&typeof result.accepted==='boolean' ? result : null;
}

function validateTerminalCloseResultV1(result, shape) {
  return isExactDataRecord(result,['accepted','sessionId'],[])
    &&isTerminalContractSessionId(result.sessionId,shape)
    &&result.accepted===true ? result : null;
}

function validateMethodContractInput(method, parameters) {
  const contract=METHOD_CONTRACTS[method];
  if(!contract)return parameters;
  let validated=null;
  if(contract.input.kind==='empty-object-v1')validated=validateEmptyObjectV1(parameters);
  else if(contract.input.kind==='application-launch-v1')validated=validateApplicationLaunchV1(parameters,contract.input);
  else if(contract.input.kind==='external-open-v1')validated=validateExternalOpenV1(parameters,contract.input);
  else if(contract.input.kind==='terminal-resize-v1')validated=validateTerminalResizeV1(parameters,contract.input);
  else if(contract.input.kind==='terminal-session-id-v1')validated=validateTerminalSessionIdV1(parameters,contract.input);
  else if(contract.input.kind==='terminal-signal-v1')validated=validateTerminalSignalV1(parameters,contract.input);
  else if(contract.input.kind==='terminal-start-v1')validated=validateTerminalStartV1(parameters,contract.input);
  else if(contract.input.kind==='terminal-write-v1')validated=validateTerminalWriteV1(parameters,contract.input);
  else if(contract.input.kind==='terminal-resize-v1')validated=validateTerminalResizeV1(parameters,contract.input);
  else if(contract.input.kind==='terminal-session-id-v1')validated=validateTerminalSessionIdV1(parameters,contract.input);
  else if(contract.input.kind==='terminal-signal-v1')validated=validateTerminalSignalV1(parameters,contract.input);
  else if(contract.input.kind==='terminal-start-v1')validated=validateTerminalStartV1(parameters,contract.input);
  else if(contract.input.kind==='terminal-write-v1')validated=validateTerminalWriteV1(parameters,contract.input);
  else contractFailure('METHOD_CONTRACT_INPUT_INVALID','Arcane rejected an unknown method input contract.',500);
  if(!validated)contractFailure('METHOD_CONTRACT_INPUT_INVALID','Arcane rejected a request that did not match the method contract.',400);
  return validated;
}

function validateMethodContractOutput(method, result) {
  const contract=METHOD_CONTRACTS[method];
  if(!contract)return result;
  let validated=null;
  if(contract.output.kind==='application-catalog-v1')validated=validateApplicationCatalogV1(result,contract.output);
  else if(contract.output.kind==='application-launch-result-v1')validated=validateApplicationLaunchResultV1(result,contract.output);
  else if(contract.output.kind==='external-open-result-v1')validated=validateExternalOpenResultV1(result,contract.output);
  else if(contract.output.kind==='application-descriptor-v1')validated=validateApplicationDescriptorV1(result,contract.output);
  else if(contract.output.kind==='network-status-v1')validated=validateNetworkStatusV1(result,contract.output);
  else if(contract.output.kind==='platform-status-v1')validated=validatePlatformStatusV1(result,contract.output);
  else if(contract.output.kind==='system-ping-result-v1')validated=validateSystemPingResultV1(result);
  else if(contract.output.kind==='terminal-close-result-v1')validated=validateTerminalCloseResultV1(result,contract.output);
  else if(contract.output.kind==='terminal-list-v1')validated=validateTerminalListV1(result,contract.output);
  else if(contract.output.kind==='terminal-resize-result-v1')validated=validateTerminalResizeResultV1(result,contract.output);
  else if(contract.output.kind==='terminal-session-v1')validated=validateTerminalSessionV1(result,contract.output);
  else if(contract.output.kind==='terminal-signal-result-v1')validated=validateTerminalSignalResultV1(result,contract.output);
  else if(contract.output.kind==='terminal-write-result-v1')validated=validateTerminalWriteResultV1(result,contract.output);
  else if(contract.output.kind==='terminal-close-result-v1')validated=validateTerminalCloseResultV1(result,contract.output);
  else if(contract.output.kind==='terminal-list-v1')validated=validateTerminalListV1(result,contract.output);
  else if(contract.output.kind==='terminal-resize-result-v1')validated=validateTerminalResizeResultV1(result,contract.output);
  else if(contract.output.kind==='terminal-session-v1')validated=validateTerminalSessionV1(result,contract.output);
  else if(contract.output.kind==='terminal-signal-result-v1')validated=validateTerminalSignalResultV1(result,contract.output);
  else if(contract.output.kind==='terminal-write-result-v1')validated=validateTerminalWriteResultV1(result,contract.output);
  else if(contract.output.kind==='user-identity-v1')validated=validateUserIdentityV1(result,contract.output);
  else if(contract.output.kind==='version-string-v1')validated=validateVersionStringV1(result,contract.output);
  else contractFailure('METHOD_CONTRACT_OUTPUT_INVALID','Arcane rejected an unknown method output contract.',500);
  if(!validated)contractFailure('METHOD_CONTRACT_OUTPUT_INVALID','Arcane rejected a host result that did not match the method contract.',500);
  return validated;
}

function publicAppDescriptor() {
  const security=activeReleaseSecurityEvidence();
  return {
    id:appMode,
    displayName:String(APP_DESCRIPTOR.displayName || appMode),
    type:String(APP_DESCRIPTOR.type || 'app'),
    entry:APP_DESCRIPTOR.entry ? String(APP_DESCRIPTOR.entry):null,
    version:VERSION,
    securityMode:security.securityMode,
    publisherTrustSource:security.publisherTrustSource,
    revocationStatus:security.revocationStatus,
  };
}

function activeReleaseSecurityEvidence() {
  if(typeof native.hostReleaseSecurityEvidence==='function'){
    const evidence=native.hostReleaseSecurityEvidence();
    if(evidence&&evidence.securityMode==='publisher-verified'
      &&['administrator-policy','administrator-policy-rotation','installed-continuity','uac-approved-tofu','fresh-unpinned'].includes(evidence.publisherTrustSource)
      &&['online-good','cache-good','attested-degraded'].includes(evidence.revocationStatus))return evidence;
    if(evidence&&evidence.securityMode==='unsigned-local-test'
      &&evidence.publisherTrustSource===null&&evidence.revocationStatus===null)return evidence;
  }
  return { securityMode:'unverified',publisherTrustSource:null,revocationStatus:null };
}

function activeReleaseSecurityMode() {
  return activeReleaseSecurityEvidence().securityMode;
}

let corroboratedInstalledReleaseSecurityMode=null;
function installedReleaseSecurityMode() {
  if(typeof native.releaseSecurityMode==='function'){
    try{
      const mode=native.releaseSecurityMode();
      if(mode==='publisher-verified'||mode==='unsigned-local-test'){
        corroboratedInstalledReleaseSecurityMode=mode;
        return mode;
      }
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
      &&(!policy.appIds || policy.appIds.includes(appMode))
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
    ||(policy.appIds&&!policy.appIds.includes(appMode))
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
    &&!RESERVED_APPLICATION_IDS.has(input)
    &&!WINDOWS_RESERVED_APPLICATION_IDS.test(input);
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
    ||!icon.startsWith(`/apps/${id}/`)
  ){
    throw arcaneError('APPLICATION_CATALOG_INVALID','Arcane rejected an unsafe installed-app icon URL.','Repair or reinstall Arcane OS.',500,{ applicationId:id });
  }
  return icon;
}

function publicApplicationRecord(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)){
    throw arcaneError('APPLICATION_CATALOG_INVALID','Arcane rejected an invalid installed-app record.','Repair or reinstall Arcane OS.',500);
  }
  const keys=Object.keys(input).sort();
  const expectedKeys=['description','displayName','iconUrl','id','order','version'];
  if(keys.length!==expectedKeys.length||keys.some((key,index)=>key!==expectedKeys[index])){
    throw arcaneError('APPLICATION_CATALOG_INVALID','Arcane rejected unexpected installed-app metadata.','Repair or reinstall Arcane OS.',500);
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
    ||Array.isArray(result)
    ||Object.keys(result).sort().join(',')!=='applications,publisherTrustSource,revocationStatus,securityMode,verified'
    ||result.verified!==true
    ||!['publisher-verified','unsigned-local-test'].includes(result.securityMode)
    ||(result.securityMode==='publisher-verified'&&!['administrator-policy','administrator-policy-rotation','installed-continuity','uac-approved-tofu','fresh-unpinned'].includes(result.publisherTrustSource))
    ||(result.securityMode==='publisher-verified'&&!['online-good','cache-good','attested-degraded'].includes(result.revocationStatus))
    ||(result.securityMode==='unsigned-local-test'&&(result.publisherTrustSource!==null||result.revocationStatus!==null))
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
  if(corroboratedInstalledReleaseSecurityMode&&result.securityMode!==corroboratedInstalledReleaseSecurityMode){
    throw arcaneError('APPLICATION_CATALOG_UNVERIFIED','Arcane could not corroborate the installed application security mode.','Repair or reinstall the complete Arcane OS release.',503);
  }
  corroboratedInstalledReleaseSecurityMode=result.securityMode;
  return Object.freeze({
    verified:true,
    securityMode:result.securityMode,
    publisherTrustSource:result.publisherTrustSource||null,
    revocationStatus:result.revocationStatus||null,
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
    if(error&&error.code==='APPLICATION_INSTALL_BUSY'){
      throw arcaneError('APPLICATION_INSTALL_BUSY','Arcane applications are temporarily unavailable while installation is active.','Wait for Arcane Provisioner to finish, then try again.',409,{ retryable:true });
    }
    if(error&&error.code==='APPLICATIONS_BUSY'){
      throw arcaneError('APPLICATIONS_BUSY','One or more Arcane applications are still running.','Close the Arcane applications, then try again.',409,{ retryable:true });
    }
    if(error&&error.code==='APPLICATION_NOT_FOUND'){
      throw arcaneError('APPLICATION_NOT_FOUND','That Arcane application is not installed.','Choose an application from the verified Arcane catalog.',404,{ applicationId:id });
    }
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

function platformExecutionContext() {
  return Object.freeze({
    hostPlatform,
    effectivePlatform: platform,
    simulation: simulate,
    evidenceClass: simulate ? 'simulation' : 'real-host',
  });
}

function platformStatus() {
  const permissions = permissionStatus(false);
  const renderer = rendererStatus();
  return {
    ...publicOperatingSystemInfo(),
    version: VERSION,
    protocol: PROTOCOL,
    application: appMode,
    renderer,
    permissions,
    capabilities: capabilityStatus(),
    execution: platformExecutionContext(),
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
  if(activeNames.length>64)throw arcaneError('NETWORK_STATUS_UNAVAILABLE','The operating system returned too many network interfaces.','Review the host network configuration and try again.',500);
  return { online:activeNames.length>0,interfaceCount:activeNames.length };
}

const FILESYSTEM_DIRECTORY_TITLE_LIMIT=200;
const FILESYSTEM_DIRECTORY_PATH_LIMIT=4096;

function filesystemDirectorySelectionRequest(parameters) {
  if(!parameters||typeof parameters!=='object'||Array.isArray(parameters)){
    throw arcaneError(
      'FILESYSTEM_DIRECTORY_SELECTION_INVALID',
      'Arcane rejected an invalid folder-selection request.',
      'Choose a folder again using the Arcane folder selector.',
      400
    );
  }
  const allowed=new Set(['initialPath','title']);
  const unknown=Object.keys(parameters).filter((key)=>!allowed.has(key));
  if(unknown.length){
    throw arcaneError(
      'FILESYSTEM_DIRECTORY_SELECTION_INVALID',
      'Arcane rejected unsupported folder-selection fields.',
      'Use only the documented folder-selector options.',
      400,
      { allowedFields:[...allowed].sort() }
    );
  }

  let title='Choose a folder';
  if(parameters.title!==undefined&&parameters.title!==null&&parameters.title!==''){
    if(typeof parameters.title!=='string'){
      throw arcaneError('FILESYSTEM_DIRECTORY_SELECTION_INVALID','The folder-selector title is invalid.','Choose the folder again.',400);
    }
    title=parameters.title.trim();
    if(!title||title.length>FILESYSTEM_DIRECTORY_TITLE_LIMIT||/[\u0000-\u001f\u007f]/.test(title)){
      throw arcaneError('FILESYSTEM_DIRECTORY_SELECTION_INVALID','The folder-selector title is invalid.','Use a short, plain-text folder-selector title.',400);
    }
  }

  let initialPath='';
  if(parameters.initialPath!==undefined&&parameters.initialPath!==null&&parameters.initialPath!==''){
    if(typeof parameters.initialPath!=='string'){
      throw arcaneError('FILESYSTEM_DIRECTORY_SELECTION_INVALID','The initial folder path is invalid.','Choose an existing absolute directory.',400);
    }
    const requested=parameters.initialPath.trim();
    if(!requested||requested.length>FILESYSTEM_DIRECTORY_PATH_LIMIT||/[\u0000-\u001f\u007f]/.test(requested)||!path.isAbsolute(requested)){
      throw arcaneError('FILESYSTEM_DIRECTORY_SELECTION_INVALID','The initial folder path is invalid.','Choose an existing absolute directory.',400);
    }
    try{
      initialPath=fs.realpathSync(requested);
      if(!fs.statSync(initialPath).isDirectory())throw new Error('Not a directory.');
    }catch(_){
      throw arcaneError('FILESYSTEM_DIRECTORY_SELECTION_INVALID','The initial folder path is unavailable.','Choose an existing absolute directory.',400);
    }
  }
  return Object.freeze({ title,initialPath });
}

async function selectFilesystemDirectory(parameters) {
  const options=filesystemDirectorySelectionRequest(parameters);
  if(typeof native.selectDirectory!=='function'){
    throw arcaneError(
      'FILESYSTEM_DIRECTORY_SELECTION_UNSUPPORTED',
      'Arcane folder selection is not available on this operating system.',
      'Enter a verified absolute directory path, or use an Arcane host with native folder selection.',
      501
    );
  }
  const result=await native.selectDirectory(options);
  const keys=result&&typeof result==='object'&&!Array.isArray(result)?Object.keys(result).sort():[];
  if(keys.length!==2||keys[0]!=='cancelled'||keys[1]!=='path'||typeof result.cancelled!=='boolean'){
    throw arcaneError(
      'FILESYSTEM_DIRECTORY_SELECTION_FAILED',
      'The operating system returned an invalid folder-selection result.',
      'Close Arcane, reopen the application, and choose the folder again.',
      500
    );
  }
  if(result.cancelled){
    if(result.path!==null){
      throw arcaneError('FILESYSTEM_DIRECTORY_SELECTION_FAILED','The operating system returned an invalid folder-selection result.','Choose the folder again.',500);
    }
    return Object.freeze({ cancelled:true,path:null });
  }
  const selected=typeof result.path==='string'?result.path:'';
  if(!selected||selected.length>FILESYSTEM_DIRECTORY_PATH_LIMIT||/[\u0000-\u001f\u007f]/.test(selected)||!path.isAbsolute(selected)){
    throw arcaneError('FILESYSTEM_DIRECTORY_SELECTION_FAILED','The operating system returned an invalid folder path.','Choose an existing local directory.',500);
  }
  let canonical;
  try{
    canonical=fs.realpathSync(selected);
    if(!fs.statSync(canonical).isDirectory())throw new Error('Not a directory.');
  }catch(_){
    throw arcaneError('FILESYSTEM_DIRECTORY_SELECTION_FAILED','The selected folder is no longer available.','Choose an existing local directory.',409);
  }
  return Object.freeze({ cancelled:false,path:canonical });
}

function externalUriRequest(parameters) {
  const allowed=new Set(['uri']);
  const keys=parameters&&typeof parameters==='object'&&!Array.isArray(parameters)?Object.keys(parameters):[];
  if(keys.some((key)=>!allowed.has(key))||typeof parameters.uri!=='string'){
    throw arcaneError('EXTERNAL_OPEN_INVALID','The external URI request is invalid.','Use a mailto URI.',400);
  }
  const value=parameters.uri;
  if(!value||value!==value.trim()||value.length>4096||/[\u0000-\u001f\u007f]/.test(value)){
    throw arcaneError('EXTERNAL_OPEN_INVALID','The external URI request is invalid.','Use a valid mailto URI.',400);
  }
  const uri=canonicalContractMailto(value,METHOD_CONTRACTS['external.open'].input);
  if(!uri){
    if(!/^mailto:/i.test(value))throw arcaneError('EXTERNAL_SCHEME_NOT_ALLOWED','That external URI scheme is not allowed.','Use a mailto URI.',403);
    throw arcaneError('EXTERNAL_OPEN_INVALID','The external URI is invalid.','Use a valid mailto URI.',400);
  }
  return uri;
}

async function openExternalUri(parameters) {
  const uri=externalUriRequest(parameters);
  if(typeof native.openExternalUri!=='function')throw arcaneError('EXTERNAL_OPEN_UNSUPPORTED','Arcane cannot open operating-system links on this host.','Use an Arcane host with native URI handling.',501);
  const result=await native.openExternalUri(uri);
  if(!result||result.opened!==true||result.uri!==uri)throw arcaneError('EXTERNAL_OPEN_FAILED','The operating system did not accept the link.','Verify a default mail application is configured and try again.',500);
  return Object.freeze({ opened:true,uri });
}

function machineStatus() {
  const installation = installationState();
  const releaseSecurity=activeReleaseSecurityEvidence();
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
    installation,
    requirements: checkRequirements(),
    permissions: permissionStatus(false),
    renderer: rendererStatus(),
    securityMode: releaseSecurity.securityMode,
    publisherTrustSource: releaseSecurity.publisherTrustSource,
    revocationStatus: releaseSecurity.revocationStatus,
    installedSecurityMode: installation.present ? installedReleaseSecurityMode() : 'not-installed',
    paths: PATHS,
    simulation: simulate,
    execution: platformExecutionContext(),
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

const terminalSessions = new Map();
const TERMINAL_SESSION_LIMIT = 8;
const TERMINAL_DATA_LIMIT = 64 * 1024;
const TERMINAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function terminalRequest(parameters, expectedKeys) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw arcaneError('TERMINAL_REQUEST_INVALID', 'Arcane rejected an invalid terminal request.', 'Retry the command with the documented terminal fields.', 400);
  }
  const keys = Object.keys(parameters).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw arcaneError('TERMINAL_REQUEST_INVALID', 'Arcane rejected unsupported terminal request fields.', 'Use the Arcane terminal API rather than passing process options directly.', 400, { allowedFields: expected });
  }
  return parameters;
}

function terminalSession(idInput) {
  const id = String(idInput || '').trim();
  if (!TERMINAL_ID_PATTERN.test(id)) throw arcaneError('TERMINAL_SESSION_INVALID', 'Arcane rejected an invalid terminal session identifier.', 'Open a new terminal session and try again.', 400);
  const session = terminalSessions.get(id);
  if (!session) throw arcaneError('TERMINAL_SESSION_NOT_FOUND', 'That terminal session is no longer running.', 'Open a new terminal tab and retry the command.', 404, { sessionId: id });
  return session;
}

function terminalDimensions(columnsInput, rowsInput) {
  const columns = Math.max(20, Math.min(500, Math.round(Number(columnsInput) || 120)));
  const rows = Math.max(5, Math.min(200, Math.round(Number(rowsInput) || 32)));
  return { columns, rows };
}

function terminalShellSpec(shellInput) {
  const shell = String(shellInput || 'auto').trim().toLowerCase();
  if (!['auto', 'powershell', 'cmd', 'bash', 'sh'].includes(shell)) {
    throw arcaneError('TERMINAL_SHELL_INVALID', `Arcane does not support the terminal shell “${shell}”.`, 'Choose auto, powershell, cmd, bash, or sh.', 400);
  }
  if (platform === 'win32') {
    if (shell === 'auto' || shell === 'powershell') return { shell: 'powershell', executable: windowsPowerShell, args: ['-NoLogo'] };
    if (shell === 'cmd') return { shell: 'cmd', executable: path.join(windowsSystem32, 'cmd.exe'), args: ['/Q', '/D'] };
    if (shell === 'bash') return { shell: 'bash', executable: 'bash.exe', args: [] };
    throw arcaneError('TERMINAL_SHELL_UNAVAILABLE', 'The POSIX sh shell is not available on this Microsoft NT host.', 'Choose PowerShell, Command Prompt, or an installed Bash shell.', 400);
  }
  if (shell === 'powershell') return { shell: 'powershell', executable: 'pwsh', args: ['-NoLogo'] };
  if (shell === 'cmd') throw arcaneError('TERMINAL_SHELL_UNAVAILABLE', 'Command Prompt is available only on Microsoft NT.', 'Choose Bash, sh, or the system default shell.', 400);
  if (shell === 'sh') return { shell: 'sh', executable: '/bin/sh', args: [] };
  return { shell: 'bash', executable: '/bin/bash', args: [] };
}

async function startTerminal(parameters) {
  terminalRequest(parameters, ['shell', 'cwd', 'columns', 'rows']);
  if (terminalSessions.size >= TERMINAL_SESSION_LIMIT) throw arcaneError('TERMINAL_SESSION_LIMIT', 'Arcane Terminal already has the maximum number of running sessions.', 'Close an existing terminal tab before opening another.', 409, { maximum: TERMINAL_SESSION_LIMIT });
  const spec = terminalShellSpec(parameters.shell);
  const requestedCwd = String(parameters.cwd || '').trim();
  let cwd = requestedCwd ? path.resolve(requestedCwd) : process.cwd();
  try {
    cwd = fs.realpathSync(cwd);
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch (_) {
    throw arcaneError('TERMINAL_CWD_INVALID', 'Arcane could not open that terminal working directory.', 'Choose an existing directory that the current user can access.', 400, { cwd });
  }
  const dimensions = terminalDimensions(parameters.columns, parameters.rows);
  const id = `term-${crypto.randomUUID()}`;
  const child = spawn(spec.executable, spec.args, {
    cwd,
    env: { ...safeSubprocessEnvironment, TERM: 'xterm-256color', COLORTERM: 'truecolor', ARCANE_TERMINAL: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const session = { id, shell: spec.shell, cwd, columns: dimensions.columns, rows: dimensions.rows, child, createdAt: stamp(), state: 'starting' };
  terminalSessions.set(id, session);
  const forward = (stream) => (chunk) => {
    const data = String(chunk || '').slice(0, 256 * 1024);
    if (data) emitEvent('terminal.output', { sessionId: id, stream, data });
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', forward('stdout'));
  child.stderr.on('data', forward('stderr'));
  child.on('exit', (exitCode, signal) => {
    session.state = 'exited';
    terminalSessions.delete(id);
    emitEvent('terminal.exit', { sessionId: id, exitCode, signal: signal || null });
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => {
      terminalSessions.delete(id);
      reject(arcaneError('TERMINAL_START_FAILED', 'Arcane could not start the selected terminal shell.', 'Verify that the shell is installed and available, then try again.', 500, { shell: spec.shell, technicalMessage: error.message }));
    });
  });
  session.state = 'running';
  return { id, shell: spec.shell, cwd, title: spec.shell === 'powershell' ? 'PowerShell' : spec.shell === 'cmd' ? 'Command Prompt' : spec.shell === 'bash' ? 'Bash' : 'Shell', columns: session.columns, rows: session.rows, createdAt: session.createdAt };
}

function listTerminals(parameters) {
  terminalRequest(parameters, []);
  return { sessions: [...terminalSessions.values()].map(({ id, shell, cwd, columns, rows, createdAt, state }) => ({ id, shell, cwd, columns, rows, createdAt, state })) };
}

function writeTerminal(parameters) {
  terminalRequest(parameters, ['sessionId', 'data']);
  const session = terminalSession(parameters.sessionId);
  const data = String(parameters.data ?? '');
  if (!data || Buffer.byteLength(data, 'utf8') > TERMINAL_DATA_LIMIT) throw arcaneError('TERMINAL_DATA_INVALID', 'Arcane rejected empty or oversized terminal input.', 'Send terminal input in chunks no larger than 64 KiB.', 400);
  if (!session.child.stdin.writable) throw arcaneError('TERMINAL_INPUT_CLOSED', 'That terminal session no longer accepts input.', 'Open a new terminal tab and retry the command.', 409);
  session.child.stdin.write(data, 'utf8');
  return { sessionId: session.id, accepted: true, bytes: Buffer.byteLength(data, 'utf8') };
}

function resizeTerminal(parameters) {
  terminalRequest(parameters, ['sessionId', 'columns', 'rows']);
  const session = terminalSession(parameters.sessionId);
  const dimensions = terminalDimensions(parameters.columns, parameters.rows);
  Object.assign(session, dimensions);
  return { sessionId: session.id, ...dimensions, accepted: true, emulated: true };
}

function signalTerminal(parameters) {
  terminalRequest(parameters, ['sessionId', 'signal']);
  const session = terminalSession(parameters.sessionId);
  const signal = String(parameters.signal || 'interrupt').toLowerCase();
  if (!['interrupt', 'terminate'].includes(signal)) throw arcaneError('TERMINAL_SIGNAL_INVALID', 'Arcane rejected an unsupported terminal signal.', 'Use interrupt or terminate.', 400);
  const accepted = session.child.kill(signal === 'interrupt' ? 'SIGINT' : 'SIGTERM');
  return { sessionId: session.id, signal, accepted };
}

function closeTerminal(parameters) {
  terminalRequest(parameters, ['sessionId']);
  const session = terminalSession(parameters.sessionId);
  session.state = 'closed';
  try { session.child.stdin.end(); } catch (_) {}
  const timer = setTimeout(() => { try { if (!session.child.killed) session.child.kill('SIGTERM'); } catch (_) {} }, 500);
  timer.unref();
  return { sessionId: session.id, accepted: true };
}

async function dispatchMethod(request, options) {
  const method = String(request.method || '');
  const parameters = request.parameters && typeof request.parameters === 'object' ? request.parameters : {};
  const requestId = request.id;

  switch (method) {
    case 'system.ping': return { ok: true };
    case 'version.current': return VERSION;
    case 'app.current': return publicAppDescriptor();
    case 'capabilities.list': return capabilityStatus();
    case 'ai.chat': return completeConfiguredChat(parameters);
    case 'ai.profile.current': return managedAIProfile();
    case 'ai.models': return listLocalModels();
    case 'ai.provider.settings.get': return managedAIProviderSettings();
    case 'ai.provider.settings.set': return setManagedAIProviderSettings(parameters);
    case 'ai.provider.models': return listManagedOpenAIModels();
    case 'ollama.version': return requestLocalOllama('version',parameters);
    case 'ollama.models': return requestLocalOllama('models',parameters);
    case 'ollama.running': return requestLocalOllama('running',parameters);
    case 'ollama.show': return requestLocalOllama('show',parameters);
    case 'ollama.generate': return requestLocalOllama('generate',parameters);
    case 'ollama.chat': return requestLocalOllama('chat',parameters);
    case 'ollama.embed': return requestLocalOllama('embed',parameters);
    case 'ollama.pull': return requestLocalOllama('pull',parameters);
    case 'ollama.push': return requestLocalOllama('push',parameters);
    case 'ollama.create': return requestLocalOllama('create',parameters);
    case 'ollama.copy': return requestLocalOllama('copy',parameters);
    case 'ollama.delete': return requestLocalOllama('delete',parameters);
    case 'ollama.selection.get': return managedArcaneModelSelection();
    case 'ollama.selection.set': {
      const wrapped=await withAction('ollama.model.select',requestId,(action)=>setManagedArcaneModelPreference(action,parameters.preference));
      return { ...wrapped.result,operation:wrapped.operation };
    }
    case 'ollama.settings.get': return managedArcaneModelSelection();
    case 'ollama.settings.set': {
      const wrapped=await withAction('ollama.settings.save',requestId,(action)=>setManagedArcaneAISettings(action,parameters));
      return { ...wrapped.result,operation:wrapped.operation };
    }
    case 'ollama.brain.create': {
      const wrapped=await withAction('ollama.brain.create',requestId,(action)=>createManagedArcaneBrain(action,parameters));
      return { ...wrapped.result,operation:wrapped.operation };
    }
    case 'ollama.service.settings.get': return managedOllamaServiceSettings();
    case 'ollama.service.settings.set': {
      const wrapped=await withAction('ollama.service.settings',requestId,(action)=>setManagedOllamaServiceSettings(action,parameters));
      return { ...wrapped.result,operation:wrapped.operation };
    }
    case 'platform.status': return platformStatus();
    case 'permissions.status': return permissionStatus(true);
    case 'machine.status': return machineStatus();
    case 'user.current': return publicCurrentIdentity();
    case 'system.metrics': return systemMetrics();
    case 'network.status': return networkStatus();
    case 'external.open': return openExternalUri(parameters);
    case 'filesystem.directory.select': return selectFilesystemDirectory(parameters);
    case 'storage.list': return listAppStorage();
    case 'storage.get': return getAppStorage(parameters.key);
    case 'storage.set': return setAppStorage(parameters.key, parameters.value);
    case 'storage.delete': return deleteAppStorage(parameters.key);
    case 'preferences.list': return listPreferences();
    case 'preferences.get': return getPreference(parameters.key);
    case 'preferences.set': return setPreference(parameters.key, parameters.value);
    case 'preferences.delete': return deletePreference(parameters.key);
    case 'appearance.current': return native.appearanceStatus();
    case 'appearance.apply': return native.applyAppearance(parameters);
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
    case 'development.inspect': return inspectDevelopmentWorkspace(parameters);
    case 'development.context': return developmentContext(parameters);
    case 'development.setup': {
      const wrapped=await withAction('development.setup',requestId,(action)=>setupDevelopmentWorkspace(action,parameters));
      return { ...wrapped.result,operation:wrapped.operation };
    }
    case 'development.node.install': {
      const wrapped=await withAction('development.node.install',requestId,(action)=>installDevelopmentNode(action,parameters));
      return { ...wrapped.result,operation:wrapped.operation };
    }
    case 'apps.list': return listInstalledApplications(request);
    case 'apps.launch': return launchInstalledApplication(request);
    case 'terminal.start': return startTerminal(parameters);
    case 'terminal.list': return listTerminals(parameters);
    case 'terminal.write': return writeTerminal(parameters);
    case 'terminal.resize': return resizeTerminal(parameters);
    case 'terminal.signal': return signalTerminal(parameters);
    case 'terminal.close': return closeTerminal(parameters);
    case 'provisioning.plan': return provisioningPlan(parameters.usernames || []);
    case 'system.lock': return launchSessionCommand(native.lockSpec(), 'lock');
    case 'session.logout': return launchSessionCommand(native.logoutSpec(), 'log out of');
    case 'requirements.ensure': {
      assertChangesAllowed();
      const wrapped = await withAction('requirements.ensure', requestId, async (action) => ({ requirements: await ensureRequirements(action, parameters.requirementIds || null) }));
      return { ...wrapped.result, operation: wrapped.operation, credentials: wrapped.credentials };
    }
    case 'installation.ensure': {
      assertChangesAllowed({ allowIdentityRepair: true });
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
    case 'users.verifyShell': {
      const wrapped = await withAction('users.verifyShell', requestId, async (action) => ({ user: await verifyArcaneUserShell(parameters.username, action) }));
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
    validateMethodContractInput(String(request.method || ''),request.parameters);
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
    const validatedResult=validateMethodContractOutput(String(request.method || ''),result);
    await emitFrame({ protocol: PROTOCOL, type: 'response', id: request.id, ok: true, result:validatedResult, time: stamp() });
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
  if (!value.startsWith(prefix)) throw new Error('Arcane generated an invalid Microsoft NT privilege pipe endpoint.');
  const name = value.slice(prefix.length);
  if (!/^arcane-privileged-[A-Za-z0-9-]{16,180}$/.test(name)) {
    throw new Error('Arcane generated an invalid Microsoft NT privilege pipe name.');
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
    'Arcane cannot safely request administrator access because its Microsoft NT pipe guard is missing.',
    'Repair or reinstall Arcane OS from a verified release, then try again.',
    503
  );
}

function verifyUnsignedLocalPipeGuardBinding(guardExecutable) {
  const root = path.resolve(bundleRoot());
  const coreExecutable = path.resolve(process.execPath);
  if (path.dirname(guardExecutable).toLowerCase() !== path.dirname(coreExecutable).toLowerCase()) {
    throw new Error('Unsigned local Arcane Core and ArcanePipeGuard must be sibling files.');
  }
  const manifestNames = ['arcane-machine-content.json', 'arcane-app-content.json']
    .filter((name) => fs.existsSync(path.join(root, name)));
  if (manifestNames.length !== 1) {
    throw new Error('Unsigned local Arcane content manifest is missing or ambiguous.');
  }
  const manifestName = manifestNames[0];
  const manifestPath = path.join(root, manifestName);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const machineIdentityValid = manifestName === 'arcane-machine-content.json'
    && manifest.release && manifest.release.name === BUNDLE_MANIFEST.name
    && manifest.release.version === VERSION && manifest.release.platform === 'windows'
    && manifest.release.architecture === process.arch;
  const appIdentityValid = manifestName === 'arcane-app-content.json'
    && manifest.app && manifest.app.id === appMode && manifest.app.version === VERSION;
  if (manifest.schemaVersion !== 1 || manifest.hashAlgorithm !== 'sha256'
    || (!machineIdentityValid && !appIdentityValid) || !Array.isArray(manifest.files)) {
    throw new Error('Unsigned local Arcane content manifest is invalid.');
  }
  const entries = new Map();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Unsigned local Arcane content manifest is invalid.');
    }
    const releasePath = normalizeIntegrityPath(entry.path);
    if (entries.has(releasePath)) throw new Error('Unsigned local Arcane content manifest contains duplicate paths.');
    entries.set(releasePath, entry);
  }
  for (const [displayName, file] of [['ArcaneCore.exe', coreExecutable], ['ArcanePipeGuard.exe', guardExecutable]]) {
    const releasePath = normalizeIntegrityPath(path.relative(root, file).split(path.sep).join('/'));
    const entry = entries.get(releasePath);
    if (!entry || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) {
      throw new Error(`Unsigned local Arcane release does not bind ${displayName}.`);
    }
    const stat = fs.statSync(file);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (!stat.isFile() || stat.size !== entry.size || hash.toLowerCase() !== String(entry.sha256).toLowerCase()) {
      throw new Error(`Unsigned local ${displayName} does not match the content manifest.`);
    }
  }
}

function monitorPipeGuardSignals(child) {
  let buffer = '';
  const seen = [];
  const waiters = new Set();
  let terminalError = null;
  let exitMetadata = null;

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
    exitMetadata = { code, signal };
  });
  child.once('close', (code, signal) => {
    if (buffer) acceptLine(buffer);
    if (!terminalError) {
      const finalCode = exitMetadata ? exitMetadata.code : code;
      const finalSignal = exitMetadata ? exitMetadata.signal : signal;
      terminalError = new Error(`ArcanePipeGuard closed before peer authentication (code ${finalCode}, signal ${finalSignal || 'none'}).`);
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
    releaseClaimsSha256: String(fields.releaseClaimsSha256 || ''),
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
    `--release-claims=${hostReleaseClaimsEncoded}`,
    `--app=${appMode}`,
    `--bundle-root=${bundleRoot()}`,
    `--protected-user=${protectedProvisioningUsername()}`,
  ];
  if (allowSourceInstall) workerArgs.push('--allow-source-install');
  if (allowUnsignedLocalRelease) workerArgs.push('--allow-unsigned-local-release');
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
              && frame.version === VERSION
              && frame.releaseClaimsSha256 === hostReleaseClaimsSha256;
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
              actionLog(launchAction, 'info', 'Microsoft NT verified the privileged worker through its kernel-reported named-pipe client PID.', {
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
              releaseClaimsSha256: hostReleaseClaimsSha256,
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
              releaseClaimsSha256: hostReleaseClaimsSha256,
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
              releaseClaimsSha256: hostReleaseClaimsSha256,
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
        throw new Error('The Microsoft NT native adapter cannot verify ArcanePipeGuard trust.');
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
        throw new Error('ArcanePipeGuard authenticated a different Microsoft NT process than the UAC launch returned.');
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
        && frame.version === VERSION
        && frame.releaseClaimsSha256 === hostReleaseClaimsSha256;
      const binding = validBroker && privilegeBindingDocument({
        brokerSession: ipcBrokerSession,
        brokerPid: ipcBrokerPid,
        workerPid: process.pid,
        workerNonce,
        app: appMode,
        platform,
        version: VERSION,
        releaseClaimsSha256: hostReleaseClaimsSha256,
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
        releaseClaimsSha256: hostReleaseClaimsSha256,
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
      releaseClaimsSha256: hostReleaseClaimsSha256,
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
  setTimeout(startManagedArcaneModelBootEnsure,750).unref();
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
