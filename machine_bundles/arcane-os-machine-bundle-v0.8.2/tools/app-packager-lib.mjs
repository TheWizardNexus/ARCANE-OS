import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { verifyPackagedAppLinks } from './app-package-links.mjs';

export const SAFE_APP_CAPABILITIES = Object.freeze([
  'diagnostics.read',
  'identity.read',
  'installation.read',
  'media.microphone',
  'network.status.read',
  'requirements.read',
  'storage.read',
  'storage.write',
  'system.metrics.read',
  'system.read',
]);

const SAFE_CAPABILITY_SET = new Set(SAFE_APP_CAPABILITIES);
const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED_APP_IDS = new Set(['provisioner', 'shell']);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SAFE_ICON_EXTENSION = new Set(['.ico', '.jpeg', '.jpg', '.png', '.webp']);
const PRESENTATION_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
const PRESENTATION_MARKUP_PATTERN = /[<>]|&(?:#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/i;
const PACKAGE_ORIGIN = 'https://arcane.local';
const RUNTIME_SCRIPT_TAG = '    <script src="/arcane-runtime/arcane-api.js" data-arcane-runtime="arcane/1"></script>';
const COMPONENT_SCRIPT_PREFIX = '(async function(){';
const COMPONENT_SCRIPT_SUFFIX = "}).call((()=>{const registry=globalThis[Symbol.for('arcane.html-import.hosts')];const token=document.currentScript&&document.currentScript.dataset.arcaneHostToken;const host=registry instanceof Map&&token?registry.get(token):null;if(!host)throw new Error('HTML import host binding is unavailable.');return host;})())";
const PERMISSIONS_POLICY_DENY = Object.freeze([
  'accelerometer=()',
  'ambient-light-sensor=()',
  'autoplay=()',
  'bluetooth=()',
  'camera=()',
  'clipboard-read=()',
  'clipboard-write=(self)',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'gamepad=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'idle-detection=()',
  'magnetometer=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'serial=()',
  'speaker-selection=()',
  'usb=()',
  'web-share=()',
  'xr-spatial-tracking=()',
]);

function fail(message) {
  throw new Error(`Invalid Arcane app package configuration: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unknown field “${key}”.`);
  }
}

export function normalizeRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || !value) fail(`${label} must be a non-empty relative path.`);
  if (value.includes('\\') || value.includes('\0') || /[\x00-\x1f]/.test(value)) {
    fail(`${label} must use canonical forward-slash path syntax.`);
  }
  if (path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.startsWith('//')) {
    fail(`${label} must not be absolute.`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized !== value) {
    fail(`${label} must be canonical and must not traverse its root.`);
  }
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ') || segment.includes(':')) {
      fail(`${label} contains an unsafe path segment.`);
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) fail(`${label} contains the reserved name “${segment}”.`);
  }
  return normalized;
}

function normalizeWorkspaceRoot(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    fail('workspaceRoot must be a canonical relative ancestor path.');
  }
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    fail('workspaceRoot must be a canonical relative ancestor path.');
  }
  const segments = value.split('/');
  if (segments.length > 8 || segments.some((segment) => segment !== '..')) {
    fail('workspaceRoot may only identify a direct ancestor of the bundle.');
  }
  return value;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveInside(root, relative, label) {
  const normalized = normalizeRelativePath(relative, label);
  const candidate = path.resolve(root, ...normalized.split('/'));
  if (!isInside(root, candidate)) fail(`${label} escapes its allowed root.`);
  return candidate;
}

function validateIncludeList(include, label) {
  if (!Array.isArray(include) || include.length === 0) fail(`${label} must be a non-empty explicit allowlist.`);
  if (include.length > 256) fail(`${label} is unreasonably large.`);
  const normalized = include.map((value, index) => normalizeRelativePath(value, `${label}[${index}]`));
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) fail(`${label} contains duplicate entries.`);
  const sorted = [...normalized].sort(compareText);
  for (let index = 0; index < sorted.length; index += 1) {
    for (let other = index + 1; other < sorted.length; other += 1) {
      if (sorted[other].startsWith(`${sorted[index]}/`)) {
        fail(`${label} overlaps “${sorted[index]}” with “${sorted[other]}”.`);
      }
    }
  }
  return normalized;
}

function validateCapabilities(capabilities, label) {
  if (!Array.isArray(capabilities)) fail(`${label} must be an array.`);
  const normalized = capabilities.map((capability, index) => {
    if (typeof capability !== 'string' || !SAFE_CAPABILITY_SET.has(capability)) {
      fail(`${label}[${index}] is not an approved non-privileged app capability.`);
    }
    return capability;
  });
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicate capabilities.`);
  return [...normalized].sort();
}

function validatePresentationText(value, label, maximumLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    fail(`${label} must contain 1-${maximumLength} characters.`);
  }
  if (PRESENTATION_CONTROL_PATTERN.test(value)) fail(`${label} must not contain control or formatting characters.`);
  if (PRESENTATION_MARKUP_PATTERN.test(value)) fail(`${label} must be plain text without markup.`);
  return value.trim();
}

function validatePresentationIcon(value, include, label) {
  if (typeof value !== 'string' || value.length > 160) fail(`${label} must contain 1-160 characters.`);
  if (PRESENTATION_CONTROL_PATTERN.test(value)) fail(`${label} must not contain control or formatting characters.`);
  if (PRESENTATION_MARKUP_PATTERN.test(value)) fail(`${label} must not contain markup.`);
  const icon = normalizeRelativePath(value, label);
  if (!SAFE_ICON_EXTENSION.has(path.posix.extname(icon).toLowerCase())) {
    fail(`${label} must identify a safe raster image or icon file.`);
  }
  if (!include.some((allowed) => icon === allowed || icon.startsWith(`${allowed}/`))) {
    fail(`${label} is not covered by the app include allowlist.`);
  }
  return icon;
}

function validateOrigins(origins, label, { allowLoopbackHttp = false } = {}) {
  if (!Array.isArray(origins)) fail(`${label} must be an array of exact origins.`);
  if (origins.length > 16) fail(`${label} contains too many origins.`);
  const normalized = origins.map((origin, index) => {
    if (typeof origin !== 'string' || !origin || origin.includes('*')) fail(`${label}[${index}] must be an exact origin string.`);
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      fail(`${label}[${index}] is not a valid absolute origin.`);
    }
    if (
      parsed.origin !== origin
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) fail(`${label}[${index}] must contain only an exact scheme, host, and optional port.`);
    if (parsed.protocol === 'http:') {
      const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
      if (!allowLoopbackHttp || !loopback) fail(`${label}[${index}] may use HTTP only for a numeric loopback host.`);
    } else if (parsed.protocol !== 'https:') {
      fail(`${label}[${index}] must use HTTPS or an approved loopback HTTP origin.`);
    }
    return parsed.origin;
  });
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicate origins.`);
  return Object.freeze([...normalized].sort(compareText));
}

function validateAppSecurity(security, label) {
  if (!isPlainObject(security)) fail(`${label} must be an explicit security policy object.`);
  assertOnlyKeys(security, new Set(['connectOrigins', 'mediaOrigins']), label);
  return Object.freeze({
    connectOrigins: validateOrigins(security.connectOrigins, `${label}.connectOrigins`, { allowLoopbackHttp: true }),
    mediaOrigins: validateOrigins(security.mediaOrigins, `${label}.mediaOrigins`),
  });
}

function validateDocumentCatalog(value, label) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  assertOnlyKeys(value, new Set(['policy', 'manifest', 'destination']), label);
  if (value.policy !== 'empty-unpublished') fail(`${label}.policy must be “empty-unpublished” without separate publication authorization.`);
  const manifest = normalizeRelativePath(value.manifest, `${label}.manifest`);
  const destination = normalizeRelativePath(value.destination, `${label}.destination`);
  if (path.posix.extname(manifest).toLowerCase() !== '.json') fail(`${label}.manifest must be JSON.`);
  if (manifest.includes('/')) fail(`${label}.manifest must be a filename directly inside its generated destination.`);
  return Object.freeze({ policy: value.policy, manifest, destination });
}

export function validateAppRegistry(registry) {
  if (!isPlainObject(registry)) fail('the registry must be a JSON object.');
  assertOnlyKeys(registry, new Set(['schemaVersion', 'workspaceRoot', 'sharedPayload', 'apps']), 'registry');
  if (registry.schemaVersion !== 1) fail('schemaVersion must be 1.');
  const workspaceRoot = normalizeWorkspaceRoot(registry.workspaceRoot);

  if (!Array.isArray(registry.sharedPayload) || registry.sharedPayload.length === 0) {
    fail('sharedPayload must contain at least one allowlisted payload.');
  }
  const destinations = [];
  const sharedPayload = registry.sharedPayload.map((payload, index) => {
    const label = `sharedPayload[${index}]`;
    if (!isPlainObject(payload)) fail(`${label} must be an object.`);
    assertOnlyKeys(payload, new Set(['source', 'destination', 'include']), label);
    const source = normalizeRelativePath(payload.source, `${label}.source`);
    const destination = normalizeRelativePath(payload.destination, `${label}.destination`);
    const include = validateIncludeList(payload.include, `${label}.include`);
    destinations.push(destination);
    return Object.freeze({ source, destination, include });
  });
  for (let index = 0; index < destinations.length; index += 1) {
    for (let other = index + 1; other < destinations.length; other += 1) {
      if (
        destinations[index] === destinations[other]
        || destinations[index].startsWith(`${destinations[other]}/`)
        || destinations[other].startsWith(`${destinations[index]}/`)
      ) fail('sharedPayload destinations must not overlap.');
    }
  }

  if (!isPlainObject(registry.apps) || Object.keys(registry.apps).length === 0) fail('apps must be a non-empty object.');
  if (Object.keys(registry.apps).length > 64) fail('apps contains too many targets.');
  const apps = {};
  const presentationOrders = new Set();
  for (const [id, app] of Object.entries(registry.apps)) {
    if (id.length > 64 || !APP_ID_PATTERN.test(id) || RESERVED_APP_IDS.has(id)) fail(`app id “${id}” is invalid or reserved.`);
    const label = `apps.${id}`;
    if (!isPlainObject(app)) fail(`${label} must be an object.`);
    assertOnlyKeys(app, new Set(['displayName', 'description', 'icon', 'order', 'type', 'source', 'entry', 'capabilities', 'security', 'documentCatalog', 'include']), label);
    const displayName = validatePresentationText(app.displayName, `${label}.displayName`, 80);
    const description = validatePresentationText(app.description, `${label}.description`, 240);
    if (!Number.isSafeInteger(app.order) || app.order < 0 || app.order > 10_000) {
      fail(`${label}.order must be an integer from 0 through 10000.`);
    }
    if (presentationOrders.has(app.order)) fail(`${label}.order must be unique.`);
    presentationOrders.add(app.order);
    if (app.type !== 'app') fail(`${label}.type must be “app”; privileged host types cannot be wrapped.`);
    const source = normalizeRelativePath(app.source, `${label}.source`);
    const entry = normalizeRelativePath(app.entry, `${label}.entry`);
    if (path.posix.extname(entry).toLowerCase() !== '.html') fail(`${label}.entry must be an HTML file.`);
    const include = validateIncludeList(app.include, `${label}.include`);
    const icon = validatePresentationIcon(app.icon, include, `${label}.icon`);
    if (!include.some((allowed) => entry === allowed || entry.startsWith(`${allowed}/`))) {
      fail(`${label}.entry is not covered by its include allowlist.`);
    }
    const documentCatalog = validateDocumentCatalog(app.documentCatalog, `${label}.documentCatalog`);
    if (documentCatalog && include.some((allowed) => (
      allowed === documentCatalog.destination
      || allowed.startsWith(`${documentCatalog.destination}/`)
      || documentCatalog.destination.startsWith(`${allowed}/`)
    ))) fail(`${label}.include must not copy the unpublished document catalog destination.`);
    apps[id] = Object.freeze({
      id,
      displayName,
      description,
      icon,
      order: app.order,
      type: 'app',
      source,
      entry,
      capabilities: validateCapabilities(app.capabilities, `${label}.capabilities`),
      security: validateAppSecurity(app.security, `${label}.security`),
      documentCatalog,
      include,
    });
  }

  return Object.freeze({ schemaVersion: 1, workspaceRoot, sharedPayload: Object.freeze(sharedPayload), apps: Object.freeze(apps) });
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findRepositoryRoot(bundleRoot) {
  let candidate = path.resolve(bundleRoot);
  while (true) {
    if (await exists(path.join(candidate, '.git'))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) fail('the bundle is not inside a Git workspace.');
    candidate = parent;
  }
}

async function assertNoLinks(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === '' || !isInside(root, candidate)) {
    if (!isInside(root, candidate)) fail(`${label} escapes the Git workspace.`);
    return;
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) fail(`${label} crosses symbolic link “${path.relative(root, current)}”.`);
  }
}

async function assertSafeExistingPath(repositoryRoot, candidate, label) {
  if (!isInside(repositoryRoot, candidate)) fail(`${label} escapes the Git workspace.`);
  await assertNoLinks(repositoryRoot, candidate, label);
  const repositoryReal = await fs.realpath(repositoryRoot);
  const candidateReal = await fs.realpath(candidate);
  if (!isInside(repositoryReal, candidateReal)) fail(`${label} resolves outside the Git workspace.`);
  return candidate;
}

async function enumerateDirectory(root, relative, output) {
  const directory = relative ? path.join(root, ...relative.split('/')) : root;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail(`allowlisted payload contains symbolic link “${relative ? `${relative}/` : ''}${entry.name}”.`);
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await enumerateDirectory(root, childRelative, output);
    else if (entry.isFile()) output.push({ source: child, relative: childRelative });
    else fail(`allowlisted payload contains unsupported filesystem entry “${childRelative}”.`);
  }
}

async function enumerateAllowlist(repositoryRoot, sourceRoot, include, label) {
  await assertSafeExistingPath(repositoryRoot, sourceRoot, `${label}.source`);
  const files = [];
  for (const allowed of include) {
    const candidate = resolveInside(sourceRoot, allowed, `${label}.include`);
    await assertSafeExistingPath(repositoryRoot, candidate, `${label}.include “${allowed}”`);
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) fail(`${label}.include “${allowed}” is a symbolic link.`);
    if (stat.isDirectory()) await enumerateDirectory(sourceRoot, allowed, files);
    else if (stat.isFile()) files.push({ source: candidate, relative: allowed });
    else fail(`${label}.include “${allowed}” is not a regular file or directory.`);
  }
  files.sort((left, right) => compareText(left.relative, right.relative));
  return files;
}

function injectArcaneRuntime(html) {
  if (html.includes('data-arcane-runtime="arcane/1"')) return html;
  const match = /<\/head\s*>/i.exec(html);
  if (!match) return html;
  return `${html.slice(0, match.index)}${RUNTIME_SCRIPT_TAG}\n${html.slice(match.index)}`;
}

function relocateLegacyAppUrls(source, appId) {
  const escapedAppId = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacyAppRoot = new RegExp(`(?:(?:\\.\\.?/)+|/)apps/${escapedAppId}/`, 'g');
  return source.replace(legacyAppRoot, `/${appId}/`);
}

function transformAppPayload(data, relative, appId) {
  const extension = path.posix.extname(relative).toLowerCase();
  if (!['.css', '.html', '.js', '.mjs'].includes(extension)) return data;
  let source = data.toString('utf8');
  if (extension === '.html') {
    source = source.replace(/\r\n?/g, '\n');
    source = source.replace(/(<base\b[^>]*\bhref\s*=\s*['"])\.\.\/\.\.\/?(['"][^>]*>)/gi, '$1/$2');
  }
  source = relocateLegacyAppUrls(source, appId);
  if (extension === '.html') source = injectArcaneRuntime(source);
  return source;
}

function inlineScripts(html) {
  return [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map((match) => match[1]);
}

function scriptHash(source) {
  return `'sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

function componentScript(source) {
  return `${COMPONENT_SCRIPT_PREFIX}${source}${COMPONENT_SCRIPT_SUFFIX}`;
}

function rewriteComponentImports(html, relative) {
  const componentUrl = new URL(`/${relative}`, `${PACKAGE_ORIGIN}/`);
  return html.replace(
    /(<script\b(?![^>]*\bsrc\s*=)[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
    (match, opening, source, closing) => {
      const rewritten = source.replace(
        /(\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]+)(\2\s*\))/g,
        (importMatch, prefix, quote, specifier, suffix) => {
          const resolved = new URL(specifier, componentUrl);
          if (resolved.origin !== PACKAGE_ORIGIN) fail(`${relative} imports code outside the packaged app origin.`);
          return `${prefix}${quote}${resolved.pathname}${resolved.search}${resolved.hash}${suffix}`;
        },
      );
      return `${opening}${rewritten}${closing}`;
    },
  );
}

function buildPermissionsPolicy(app) {
  const microphone = app.capabilities.includes('media.microphone') ? 'microphone=(self)' : 'microphone=()';
  return [...PERMISSIONS_POLICY_DENY, microphone].sort(compareText).join(', ');
}

function buildContentSecurityPolicy(app, hashes) {
  const scriptSources = ["'self'", ...hashes].join(' ');
  const connectSources = ["'self'", ...app.security.connectOrigins].join(' ');
  const mediaSources = ["'self'", 'blob:', ...app.security.mediaOrigins].join(' ');
  return [
    "default-src 'none'",
    "base-uri 'self'",
    `script-src ${scriptSources}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources}`,
    `media-src ${mediaSources}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "child-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

function injectSecurityMetadata(html, contentSecurityPolicy, permissionsPolicy, relative) {
  if (/<meta\b[^>]*\bhttp-equiv\s*=\s*['"](?:Content-Security-Policy|Permissions-Policy)['"]/i.test(html)) {
    fail(`${relative} supplies security metadata; wrapper policies must be generated from arcane-apps.json.`);
  }
  const baseTags = [...html.matchAll(/<base\b[^>]*>/gi)];
  if (baseTags.length > 1) fail(`${relative} contains multiple base elements.`);
  if (baseTags.length === 1 && !/\bhref\s*=\s*['"]\/['"]/i.test(baseTags[0][0])) {
    fail(`${relative} does not use the canonical packaged base URL.`);
  }
  const canonicalBase = baseTags.length === 1 ? '  <base href="/">' : '';
  const withoutBase = baseTags.length === 1
    ? `${html.slice(0, baseTags[0].index)}${html.slice(baseTags[0].index + baseTags[0][0].length)}`
    : html;
  const head = /<head\b[^>]*>/i.exec(withoutBase);
  if (!head) return html;
  const metadata = [
    `  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">`,
    `  <meta http-equiv="Permissions-Policy" content="${permissionsPolicy}">`,
    canonicalBase,
  ].filter(Boolean).join('\n');
  const charset = /<meta\b[^>]*\bcharset\s*=\s*['"]?[^\s'">]+['"]?[^>]*>/i.exec(withoutBase.slice(head.index + head[0].length));
  const insertion = charset
    ? head.index + head[0].length + charset.index + charset[0].length
    : head.index + head[0].length;
  return `${withoutBase.slice(0, insertion)}\n${metadata}${withoutBase.slice(insertion)}`;
}

function assertHtmlSecurityCompatibility(html, relative) {
  for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
    if (/\son[a-z0-9_-]+\s*=/i.test(tag[0])) fail(`${relative} contains an inline event handler blocked by the generated CSP.`);
    if (/^<(?:embed|frame|iframe|object)\b/i.test(tag[0])) fail(`${relative} contains framed or embedded content blocked by the generated CSP.`);
    if (/^<script\b/i.test(tag[0])) {
      const source = /\ssrc\s*=\s*(['"])([^'"]+)\1/i.exec(tag[0])?.[2];
      if (source && (/^(?:https?:)?\/\//i.test(source) || source.includes('${'))) {
        fail(`${relative} contains a remote or dynamic script source; packaged app code must be local and deterministic.`);
      }
    }
  }
}

async function securePackagedHtml(stagingRoot, app) {
  const appRoot = path.join(stagingRoot, 'app');
  const files = [];
  await enumerateDirectory(appRoot, '', files);
  const htmlFiles = files.filter((file) => path.posix.extname(file.relative).toLowerCase() === '.html');
  const htmlByPath = new Map();
  const hashes = new Set();
  for (const file of htmlFiles) {
    let html = (await fs.readFile(file.source, 'utf8')).replace(/\r\n?/g, '\n');
    if (!/<head\b/i.test(html)) html = rewriteComponentImports(html, file.relative);
    assertHtmlSecurityCompatibility(html, file.relative);
    htmlByPath.set(file.relative, html);
    for (const script of inlineScripts(html)) {
      hashes.add(scriptHash(script));
      hashes.add(scriptHash(componentScript(script)));
    }
  }
  const sortedHashes = [...hashes].sort(compareText);
  const contentSecurityPolicy = buildContentSecurityPolicy(app, sortedHashes);
  const permissionsPolicy = buildPermissionsPolicy(app);
  let securedDocuments = 0;
  const navigationEntries = [];
  for (const file of htmlFiles) {
    const html = htmlByPath.get(file.relative);
    const secured = injectSecurityMetadata(html, contentSecurityPolicy, permissionsPolicy, file.relative);
    if (secured !== html) {
      securedDocuments += 1;
      if (file.relative.startsWith(`${app.id}/`)) navigationEntries.push(`/${file.relative}`);
    }
    await fs.writeFile(file.source, secured, 'utf8');
  }
  if (securedDocuments === 0) fail(`apps.${app.id} does not contain a complete HTML document with a head element.`);
  navigationEntries.sort(compareText);
  return Object.freeze({
    contentSecurityPolicy,
    permissionsPolicy,
    scriptHashes: Object.freeze(sortedHashes),
    securedDocuments,
    navigationEntries: Object.freeze(navigationEntries),
  });
}

async function compileTargetCore(bundleRoot, bundleManifest) {
  const [template, windowsNative, linuxNative] = await Promise.all([
    fs.readFile(path.join(bundleRoot, 'src/core/arcane-core.template.cjs'), 'utf8'),
    fs.readFile(path.join(bundleRoot, 'src/native/windows.cjs'), 'utf8'),
    fs.readFile(path.join(bundleRoot, 'src/native/linux.cjs'), 'utf8'),
  ]);
  let core = template.replace('__ARCANE_NATIVE_ADAPTERS__', `${windowsNative}\n\n${linuxNative}`);
  core = core.replace('__VERSION_JSON__', JSON.stringify(bundleManifest.version));
  core = core.replace('__BUNDLE_MANIFEST_JSON__', JSON.stringify(bundleManifest));
  for (const token of ['__ARCANE_NATIVE_ADAPTERS__', '__VERSION_JSON__', '__BUNDLE_MANIFEST_JSON__']) {
    if (core.includes(token)) fail(`core template replacement did not consume ${token}.`);
  }
  new vm.Script(core, { filename: 'arcane-app-core.generated.cjs' });
  return core;
}

async function writeFile(stagingRoot, relative, data, written, mode) {
  const normalized = normalizeRelativePath(relative, 'generated output path');
  if (written.has(normalized)) fail(`multiple payloads target “${normalized}”.`);
  written.add(normalized);
  const destination = resolveInside(stagingRoot, normalized, 'generated output path');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, data, mode ? { mode } : undefined);
}

async function copyPayloadFiles({ files, destinationRoot, stagingRoot, written, transformAppId = null }) {
  for (const file of files) {
    const relative = `${destinationRoot}/${file.relative}`;
    const data = await fs.readFile(file.source);
    const output = transformAppId ? transformAppPayload(data, file.relative, transformAppId) : data;
    await writeFile(stagingRoot, relative, output, written);
  }
}

async function generateUnpublishedDocumentCatalog({ app, stagingRoot, written }) {
  if (!app.documentCatalog) return null;
  const catalog = {
    schema_version: 1,
    export_policy: 'empty-unpublished',
    manifest_version: 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e3b9597a7f3306746f41c9e',
    record_count: 0,
    records: [],
  };
  await writeFile(
    stagingRoot,
    `app/${app.id}/${app.documentCatalog.destination}/${app.documentCatalog.manifest}`,
    `${JSON.stringify(catalog, null, 2)}\n`,
    written,
  );
  return Object.freeze({ policy: app.documentCatalog.policy, count: 0, destination: app.documentCatalog.destination });
}

async function hashPackageFiles(stagingRoot) {
  const files = [];
  async function visit(relative) {
    const directory = relative ? path.join(stagingRoot, ...relative.split('/')) : stagingRoot;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) fail(`generated package contains symbolic link “${entry.name}”.`);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && child !== 'arcane-app-package.json') {
        const data = await fs.readFile(path.join(stagingRoot, ...child.split('/')));
        files.push({ path: child, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
      }
    }
  }
  await visit('');
  files.sort((left, right) => compareText(left.path, right.path));
  return files;
}

async function replaceDirectoryAtomically(staging, target, outputRoot, appId) {
  if (!isInside(outputRoot, staging) || !isInside(outputRoot, target) || target === outputRoot) {
    fail('refusing to replace a directory outside dist/targets.');
  }
  const backup = path.join(outputRoot, `.${appId}.backup-${process.pid}`);
  if (!isInside(outputRoot, backup)) fail('invalid backup path.');
  await fs.rm(backup, { recursive: true, force: true });
  let movedExisting = false;
  try {
    if (await exists(target)) {
      await fs.rename(target, backup);
      movedExisting = true;
    }
    await fs.rename(staging, target);
    if (movedExisting) await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (!(await exists(target)) && movedExisting && await exists(backup)) await fs.rename(backup, target);
    throw error;
  }
}

export async function loadAppRegistry(bundleRoot) {
  const registryPath = path.join(bundleRoot, 'arcane-apps.json');
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  return validateAppRegistry(registry);
}

export async function listTargetApps(bundleRoot) {
  const registry = await loadAppRegistry(bundleRoot);
  return Object.values(registry.apps)
    .sort((left, right) => left.order - right.order || compareText(left.id, right.id))
    .map(({ id, displayName, description, icon, order, entry }) => ({ id, displayName, description, icon, order, entry }));
}

export async function buildTargetApp({ bundleRoot, appId, outputRoot: requestedOutputRoot }) {
  const absoluteBundleRoot = path.resolve(bundleRoot);
  const registry = await loadAppRegistry(absoluteBundleRoot);
  const app = registry.apps[appId];
  if (!app) fail(`unknown app “${appId}”; choose one of: ${Object.keys(registry.apps).sort().join(', ')}.`);

  const repositoryRoot = await findRepositoryRoot(absoluteBundleRoot);
  const configuredWorkspace = path.resolve(absoluteBundleRoot, ...registry.workspaceRoot.split('/'));
  if (path.normalize(configuredWorkspace) !== path.normalize(repositoryRoot)) {
    fail('workspaceRoot must identify the containing Git workspace exactly.');
  }
  await assertSafeExistingPath(repositoryRoot, absoluteBundleRoot, 'bundle root');

  const canonicalOutputRoot = path.join(absoluteBundleRoot, 'dist', 'targets');
  const outputRoot = requestedOutputRoot ? path.resolve(requestedOutputRoot) : canonicalOutputRoot;
  if (!isInside(canonicalOutputRoot, outputRoot)) fail('custom app output root must remain inside dist/targets.');
  const target = path.join(outputRoot, app.id);
  const staging = path.join(outputRoot, `.${app.id}.staging-${process.pid}`);
  if (!isInside(absoluteBundleRoot, outputRoot) || !isInside(outputRoot, target) || !isInside(outputRoot, staging)) {
    fail('computed output path escapes the bundle dist directory.');
  }
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: false });

  try {
    const baseBundle = JSON.parse(await fs.readFile(path.join(absoluteBundleRoot, 'arcane-bundle.json'), 'utf8'));
    const descriptor = {
      displayName: app.displayName,
      description: app.description,
      icon: app.icon,
      order: app.order,
      type: 'app',
      entry: `${app.id}/index.html`,
      capabilities: app.capabilities,
    };
    const targetBundle = { ...baseBundle, apps: { [app.id]: descriptor } };
    const written = new Set();

    const appSource = resolveInside(repositoryRoot, app.source, `apps.${app.id}.source`);
    const appFiles = await enumerateAllowlist(repositoryRoot, appSource, app.include, `apps.${app.id}`);
    if (!appFiles.some((file) => file.relative === app.entry)) fail(`apps.${app.id}.entry is not a regular allowlisted file.`);
    if (!appFiles.some((file) => file.relative === app.icon)) fail(`apps.${app.id}.icon is not a regular allowlisted file.`);
    await copyPayloadFiles({
      files: appFiles,
      destinationRoot: `app/${app.id}`,
      stagingRoot: staging,
      written,
      transformAppId: app.id,
    });
    const documentCatalog = await generateUnpublishedDocumentCatalog({ app, stagingRoot: staging, written });

    for (let index = 0; index < registry.sharedPayload.length; index += 1) {
      const payload = registry.sharedPayload[index];
      const source = resolveInside(repositoryRoot, payload.source, `sharedPayload[${index}].source`);
      const files = await enumerateAllowlist(repositoryRoot, source, payload.include, `sharedPayload[${index}]`);
      await copyPayloadFiles({ files, destinationRoot: `app/${payload.destination}`, stagingRoot: staging, written });
    }

    const apiSource = path.join(absoluteBundleRoot, 'src', 'frontend', 'shared', 'arcane-api.js');
    await assertSafeExistingPath(repositoryRoot, apiSource, 'Arcane frontend API');
    await writeFile(staging, 'app/arcane-runtime/arcane-api.js', await fs.readFile(apiSource), written);

    const canonicalEntry = path.join(staging, 'app', app.id, ...app.entry.split('/'));
    if (app.entry !== 'index.html') {
      await writeFile(staging, `app/${app.id}/index.html`, await fs.readFile(canonicalEntry), written);
    }
    const security = await securePackagedHtml(staging, app);
    const dependencies = await verifyPackagedAppLinks({ packageRoot: staging, appId: app.id });
    await writeFile(staging, 'arcane-bundle.json', `${JSON.stringify(targetBundle, null, 2)}\n`, written);
    await writeFile(staging, 'runtime/arcane-core.cjs', await compileTargetCore(absoluteBundleRoot, targetBundle), written, 0o755);

    const files = await hashPackageFiles(staging);
    const packageManifest = {
      schemaVersion: 1,
      protocolVersion: String(targetBundle.protocolVersion || 'arcane/1'),
      bundleVersion: String(targetBundle.version),
      app: {
        id: app.id,
        displayName: app.displayName,
        description: app.description,
        icon: app.icon,
        order: app.order,
        type: 'app',
        entry: descriptor.entry,
        launchEntry: `${app.id}/index.html`,
        capabilities: app.capabilities,
        security: {
          contentSecurityPolicy: security.contentSecurityPolicy,
          permissionsPolicy: security.permissionsPolicy,
          securedDocuments: security.securedDocuments,
          navigationEntries: security.navigationEntries,
          verifiedDependencies: dependencies.length,
        },
        documentCatalog,
      },
      files,
    };
    await writeFile(staging, 'arcane-app-package.json', `${JSON.stringify(packageManifest, null, 2)}\n`, written);

    await replaceDirectoryAtomically(staging, target, outputRoot, app.id);
    return Object.freeze({ app: app.id, target, manifest: packageManifest });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
