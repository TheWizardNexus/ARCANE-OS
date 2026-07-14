import fs from 'node:fs/promises';
import path from 'node:path';

const APP_ORIGIN = 'https://arcane.local';
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.mjs']);
const SKIPPED_SCHEMES = new Set(['about:', 'blob:', 'data:', 'javascript:', 'mailto:', 'tel:']);
const RUNTIME_ENDPOINTS = new Set(['rpc']);
const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHARED_PAYLOAD_ROOTS = Object.freeze(['arcane', 'arcane-runtime', 'node_modules']);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packageLinkError(message) {
  return new Error(`Invalid Arcane app package dependency: ${message}`);
}

function normalizeAppIds(appId, bundledAppIds) {
  if (typeof appId !== 'string' || appId.length > 64 || !APP_ID_PATTERN.test(appId)) {
    throw packageLinkError('appId is invalid.');
  }
  if (!Array.isArray(bundledAppIds) || bundledAppIds.length > 64) {
    throw packageLinkError('bundledAppIds must be a bounded array.');
  }
  const normalized = bundledAppIds.map((dependencyId, index) => {
    if (typeof dependencyId !== 'string' || dependencyId.length > 64 || !APP_ID_PATTERN.test(dependencyId)) {
      throw packageLinkError(`bundledAppIds[${index}] is invalid.`);
    }
    if (dependencyId === appId) throw packageLinkError('bundledAppIds must not contain appId.');
    return dependencyId;
  });
  if (new Set(normalized).size !== normalized.length) throw packageLinkError('bundledAppIds contains duplicates.');
  return Object.freeze([appId, ...normalized.sort(compareText)]);
}

async function enumerateFiles(root) {
  const files = [];
  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw packageLinkError(`payload contains symbolic link “${relative}”.`);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(relative);
      else throw packageLinkError(`payload contains unsupported filesystem entry “${relative}”.`);
    }
  }
  await visit(root);
  return files;
}

function addMatchValues(output, source, pattern, valueIndex = 2) {
  for (const match of source.matchAll(pattern)) output.push(match[valueIndex]);
}

function extractJavaScriptReferences(source, { serviceWorker = false } = {}) {
  const references = [];
  addMatchValues(references, source, /^[\t ]*(?:import|export)\b[^\r\n;]*?\bfrom\s*(['"])([^'"\r\n]+)\1/gm);
  addMatchValues(references, source, /^[\t ]*}\s*from\s*(['"])([^'"\r\n]+)\1/gm);
  addMatchValues(references, source, /^[\t ]*import[\t ]*(['"])([^'"\r\n]+)\1/gm);
  addMatchValues(references, source, /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g);
  addMatchValues(references, source, /\bnew\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g);
  addMatchValues(references, source, /\b(?:fetch|importScripts)\s*\(\s*(['"])([^'"]+)\1/g);
  addMatchValues(references, source, /\bnavigator\.serviceWorker\.register\s*\(\s*(['"])([^'"]+)\1/g);
  addMatchValues(references, source, /\b(?:document\.)?location(?:\.href)?\s*=\s*(['"])([^'"]+)\1/g);

  if (serviceWorker) {
    const cacheList = /\bconst\s+urlsToCache\s*=\s*\[([\s\S]*?)\]\s*;/m.exec(source);
    if (!cacheList) throw packageLinkError('service worker does not declare a static urlsToCache allowlist.');
    addMatchValues(references, cacheList[1], /(['"])([^'"]+)\1/g);
  }
  return references;
}

function extractCssReferences(source) {
  const references = [];
  addMatchValues(references, source, /\burl\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi);
  addMatchValues(references, source, /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/gi);
  return references;
}

function extractHtmlReferences(source, documentUrl) {
  const references = [];
  const baseValue = /<base\b[^>]*\bhref\s*=\s*(['"])([^'"]+)\1[^>]*>/i.exec(source)?.[2];
  const baseUrl = baseValue
    ? new URL(baseValue, documentUrl)
    : /<head\b/i.test(source)
      ? new URL(documentUrl)
      : new URL('/', documentUrl);

  for (const tag of source.matchAll(/<[a-z][^>]*>/gi)) {
    addMatchValues(references, tag[0], /\s(?:action|data|href|poster|src)\s*=\s*(['"])([^'"]*)\1/gi);
    for (const match of tag[0].matchAll(/\ssrcset\s*=\s*(['"])([^'"]*)\1/gi)) {
      for (const candidate of match[2].split(',')) {
        const value = candidate.trim().split(/\s+/, 1)[0];
        if (value) references.push(value);
      }
    }
    const style = /\sstyle\s*=\s*(['"])([^'"]*)\1/i.exec(tag[0]);
    if (style) references.push(...extractCssReferences(style[2]));
  }
  for (const style of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    references.push(...extractCssReferences(style[1]));
  }
  for (const script of source.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    references.push(...extractJavaScriptReferences(script[1]));
  }
  return { baseUrl, references };
}

function normalizeDynamicReference(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === '#' || trimmed.startsWith('#')) return '';
  const interpolation = trimmed.indexOf('${');
  return interpolation >= 0 ? trimmed.slice(0, interpolation) : trimmed;
}

function localPayloadPath(reference, baseUrl, appId, allowedAppIds) {
  const normalized = normalizeDynamicReference(reference);
  if (!normalized) return null;
  let resolved;
  try {
    resolved = new URL(normalized, baseUrl);
  } catch {
    throw packageLinkError(`“${reference}” is not a valid URL.`);
  }
  if (SKIPPED_SCHEMES.has(resolved.protocol)) return null;
  if (resolved.origin !== APP_ORIGIN) return null;

  let pathname;
  try {
    pathname = decodeURIComponent(resolved.pathname);
  } catch {
    throw packageLinkError(`“${reference}” contains invalid URL encoding.`);
  }
  if (pathname.includes('\0') || pathname.includes('\\')) throw packageLinkError(`“${reference}” has an unsafe local path.`);
  const relative = pathname.replace(/^\/+/, '');
  if (RUNTIME_ENDPOINTS.has(relative)) return null;
  for (const allowedAppId of allowedAppIds) {
    if (pathname.startsWith(`/apps/${allowedAppId}/`)) {
      throw packageLinkError(`legacy route “${reference}” was not relocated to /${allowedAppId}/.`);
    }
  }
  const firstSegment = relative.split('/', 1)[0];
  const allowedRoots = new Set([...allowedAppIds, ...SHARED_PAYLOAD_ROOTS]);
  if (relative && !allowedRoots.has(firstSegment)) {
    throw packageLinkError(`“${reference}” resolves outside the isolated ${appId} payload.`);
  }
  return relative;
}

async function assertLocalReference({ appRoot, appId, allowedAppIds, baseUrl, reference, sourceFile, dependencies }) {
  const relative = localPayloadPath(reference, baseUrl, appId, allowedAppIds);
  if (relative === null) return;
  const candidate = path.join(appRoot, ...relative.split('/').filter(Boolean));
  let stat;
  try {
    stat = await fs.stat(candidate);
  } catch {
    throw packageLinkError(`${sourceFile} references missing local URL “${reference}” (/${relative}).`);
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw packageLinkError(`${sourceFile} references unsupported local URL “${reference}”.`);
  }
  dependencies.add(`${sourceFile}\0/${relative}`);
}

async function verifyDocumentManifest({ absolute, relative, appRoot, appId, dependencies }) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(absolute, 'utf8'));
  } catch (error) {
    throw packageLinkError(`${relative} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value?.records)) return;
  if (value.export_policy !== 'empty-unpublished' || value.record_count !== 0 || value.records.length !== 0) {
    throw packageLinkError(`${relative} contains document records without explicit publication authorization.`);
  }
  const manifestDirectory = path.posix.dirname(relative);
  const markdown = (await enumerateFiles(path.join(appRoot, ...manifestDirectory.split('/'))))
    .filter((entry) => path.posix.extname(entry).toLowerCase() === '.md');
  if (markdown.length !== 0) throw packageLinkError(`${relative} unpublished catalog contains staged Markdown documents.`);
}

async function verifyWebManifest({ absolute, relative, appRoot, appId, allowedAppIds, dependencies }) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(absolute, 'utf8'));
  } catch (error) {
    throw packageLinkError(`${relative} is not valid JSON: ${error.message}`);
  }
  const references = [value.start_url, value.scope];
  for (const field of ['icons', 'screenshots', 'shortcuts']) {
    if (!Array.isArray(value[field])) continue;
    for (const entry of value[field]) if (entry && typeof entry.src === 'string') references.push(entry.src);
  }
  const baseUrl = new URL(`/${relative}`, `${APP_ORIGIN}/`);
  for (const reference of references.filter((entry) => typeof entry === 'string')) {
    await assertLocalReference({ appRoot, appId, allowedAppIds, baseUrl, reference, sourceFile: relative, dependencies });
  }
}

export async function verifyPackagedAppLinks({ packageRoot, appId, bundledAppIds = [] }) {
  const allowedAppIds = normalizeAppIds(appId, bundledAppIds);
  const absolutePackageRoot = path.resolve(packageRoot);
  const appRoot = path.join(absolutePackageRoot, 'app');
  const files = await enumerateFiles(appRoot);
  const allowedRoots = new Set([...allowedAppIds, ...SHARED_PAYLOAD_ROOTS]);
  for (const relative of files) {
    const root = relative.split('/', 1)[0];
    if (!allowedRoots.has(root)) throw packageLinkError(`payload contains undeclared root “${root}”.`);
  }
  const fileSet = new Set(files);
  if (!fileSet.has(`${appId}/index.html`)) throw packageLinkError(`${appId}/index.html is missing.`);
  const dependencies = new Set();

  for (const relative of files) {
    const absolute = path.join(appRoot, ...relative.split('/'));
    const extension = path.posix.extname(relative).toLowerCase();
    if (path.posix.basename(relative).toLowerCase() === 'manifest.json') {
      await verifyWebManifest({ absolute, relative, appRoot, appId, allowedAppIds, dependencies });
    } else if (extension === '.json') {
      await verifyDocumentManifest({ absolute, relative, appRoot, appId, dependencies });
    }
    if (!TEXT_EXTENSIONS.has(extension)) continue;

    const source = await fs.readFile(absolute, 'utf8');
    if ((extension === '.js' || extension === '.mjs') && /\beval\s*\(/.test(source)) {
      throw packageLinkError(`${relative} uses eval, which is blocked by the generated CSP.`);
    }
    const documentUrl = new URL(`/${relative}`, `${APP_ORIGIN}/`);
    let baseUrl = documentUrl;
    let references = [];
    if (extension === '.html') {
      const html = extractHtmlReferences(source, documentUrl);
      baseUrl = html.baseUrl;
      references = html.references;
    } else if (extension === '.css') {
      references = extractCssReferences(source);
    } else {
      references = extractJavaScriptReferences(source, {
        serviceWorker: allowedAppIds.some((allowedAppId) => relative === `${allowedAppId}/service-worker.js`),
      });
    }
    for (const reference of references) {
      await assertLocalReference({ appRoot, appId, allowedAppIds, baseUrl, reference, sourceFile: relative, dependencies });
    }
  }

  return Object.freeze([...dependencies].sort(compareText));
}
