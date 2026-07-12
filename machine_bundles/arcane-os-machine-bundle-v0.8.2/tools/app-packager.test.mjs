import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildTargetApp,
  normalizeRelativePath,
  validateAppRegistry,
} from './app-packager-lib.mjs';
import { verifyPackagedAppLinks } from './app-package-links.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.resolve(here, '..');
const componentScriptSuffix = "}).call((()=>{const registry=globalThis[Symbol.for('arcane.html-import.hosts')];const token=document.currentScript&&document.currentScript.dataset.arcaneHostToken;const host=registry instanceof Map&&token?registry.get(token):null;if(!host)throw new Error('HTML import host binding is unavailable.');return host;})())";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256Source(source) {
  return `'sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

async function assertSecurityMetadata(target, appId, microphone) {
  const appRoot = path.join(target, 'app', appId);
  const entries = await fs.readdir(appRoot, { withFileTypes: true });
  const documents = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.html'));
  assert(documents.length > 0, `${appId} must contain secured HTML documents`);
  const manifest = JSON.parse(await fs.readFile(path.join(target, 'arcane-app-package.json'), 'utf8'));
  assert.deepEqual(
    manifest.app.security.navigationEntries,
    documents.map((entry) => `/${appId}/${entry.name}`).sort(),
    `${appId} top-level navigation allowlist must contain only full secured documents`,
  );
  for (const document of documents) {
    const html = await fs.readFile(path.join(appRoot, document.name), 'utf8');
    const policies = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/gi)];
    const permissions = [...html.matchAll(/<meta\s+http-equiv="Permissions-Policy"\s+content="([^"]+)"/gi)];
    assert.equal(policies.length, 1, `${appId}/${document.name} must contain one generated CSP`);
    assert.equal(permissions.length, 1, `${appId}/${document.name} must contain one generated Permissions-Policy`);
    const policy = policies[0][1];
    assert.equal(policy, manifest.app.security.contentSecurityPolicy);
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /frame-src 'none'/);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /script-src-attr 'none'/);
    assert.match(policy, /connect-src 'self' http:\/\/127\.0\.0\.1:11431 http:\/\/127\.0\.0\.1:8011 https:\/\/api\.openai\.com/);
    assert.match(policy, /media-src 'self' blob: https:\/\/cdn\.openai\.com/);
    const scriptPolicy = /(?:^|; )script-src ([^;]+)/.exec(policy)?.[1] || '';
    assert(!scriptPolicy.includes("'unsafe-inline'"), `${appId} script policy allows arbitrary inline code`);
    assert(!scriptPolicy.includes("'unsafe-eval'"), `${appId} script policy allows eval`);
    assert(!/https?:/.test(scriptPolicy), `${appId} script policy allows remote code`);
    assert.match(html, /<base\b[^>]*href="\/"/i);
    assert(html.indexOf('http-equiv="Content-Security-Policy"') < html.indexOf('<base href="/">'), `${appId}/${document.name} base precedes its CSP`);
    for (const script of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      assert(scriptPolicy.includes(sha256Source(script[1])), `${appId}/${document.name} has an unhashed inline script`);
    }
    assert.equal(permissions[0][1].includes('microphone=(self)'), microphone);
    assert.equal(permissions[0][1].includes('microphone=()'), !microphone);
  }

  const component = await fs.readFile(path.join(target, 'app/arcane/components/chat.html'), 'utf8');
  const componentSource = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/i.exec(component)?.[1];
  assert(componentSource, 'shared chat component must contain its behavior script');
  const wrapperHash = sha256Source(`(async function(){${componentSource}${componentScriptSuffix}`);
  assert(manifest.app.security.contentSecurityPolicy.includes(wrapperHash), `${appId} CSP omits approved component wrapper`);
}

test('relative path validation rejects traversal and platform-specific escapes', () => {
  assert.equal(normalizeRelativePath('apps/precrisis', 'fixture'), 'apps/precrisis');
  for (const candidate of ['../secret', 'apps/../secret', '/absolute', 'C:/Windows', 'apps\\boss', 'apps//boss', 'apps/con']) {
    assert.throws(() => normalizeRelativePath(candidate, 'fixture'), /Invalid Arcane app package configuration/);
  }
});

test('registry rejects privileged types, capabilities, and overlapping allowlists', async () => {
  const valid = JSON.parse(await fs.readFile(path.join(bundleRoot, 'arcane-apps.json'), 'utf8'));

  const privileged = clone(valid);
  privileged.apps.boss.type = 'provisioner';
  assert.throws(() => validateAppRegistry(privileged), /privileged host types cannot be wrapped/);

  const nonCanonicalId = clone(valid);
  nonCanonicalId.apps['bad--id'] = nonCanonicalId.apps.boss;
  delete nonCanonicalId.apps.boss;
  assert.throws(() => validateAppRegistry(nonCanonicalId), /app id .* is invalid or reserved/);

  const capability = clone(valid);
  capability.apps.boss.capabilities.push('users.manage');
  assert.throws(() => validateAppRegistry(capability), /approved non-privileged app capability/);

  const overlap = clone(valid);
  overlap.apps.boss.include.push('components/nav.html');
  assert.throws(() => validateAppRegistry(overlap), /overlaps/);

  const remoteCodeWildcard = clone(valid);
  remoteCodeWildcard.apps.boss.security.connectOrigins.push('https://*.example.com');
  assert.throws(() => validateAppRegistry(remoteCodeWildcard), /exact origin/);

  const publication = clone(valid);
  publication.apps.boss.documentCatalog.policy = 'public-only';
  assert.throws(() => validateAppRegistry(publication), /without separate publication authorization/);

  const corpus = clone(valid);
  corpus.apps.boss.include.push('documents');
  assert.throws(() => validateAppRegistry(corpus), /must not copy the unpublished document catalog destination/);
});

test('presentation metadata is strict plain text with an included safe icon', async () => {
  const valid = JSON.parse(await fs.readFile(path.join(bundleRoot, 'arcane-apps.json'), 'utf8'));
  const normalized = validateAppRegistry(valid);
  assert.equal(normalized.apps.boss.description, valid.apps.boss.description);
  assert.equal(normalized.apps.boss.icon, 'img/boss-libraries-logo-stacked.png');
  assert.equal(normalized.apps.boss.order, 10);

  const unknown = clone(valid);
  unknown.apps.boss.launchArguments = ['--unsafe'];
  assert.throws(() => validateAppRegistry(unknown), /unknown field/);

  const markup = clone(valid);
  markup.apps.boss.description = '<strong>trusted</strong>';
  assert.throws(() => validateAppRegistry(markup), /plain text without markup/);

  const control = clone(valid);
  control.apps.boss.description = 'trusted\u0007label';
  assert.throws(() => validateAppRegistry(control), /control or formatting characters/);

  const traversal = clone(valid);
  traversal.apps.boss.icon = '../private.png';
  assert.throws(() => validateAppRegistry(traversal), /must not traverse/);

  const omitted = clone(valid);
  omitted.apps.boss.icon = 'unpublished/icon.png';
  assert.throws(() => validateAppRegistry(omitted), /not covered by the app include allowlist/);

  const executable = clone(valid);
  executable.apps.boss.icon = 'chat.html';
  assert.throws(() => validateAppRegistry(executable), /safe raster image or icon file/);

  const duplicateOrder = clone(valid);
  duplicateOrder.apps.precrisis.order = duplicateOrder.apps.boss.order;
  assert.throws(() => validateAppRegistry(duplicateOrder), /order must be unique/);
});

test('BOSS build is isolated, runtime-enabled, hashed, and deterministic', async () => {
  const first = await buildTargetApp({ bundleRoot, appId: 'boss' });
  const firstManifestText = await fs.readFile(path.join(first.target, 'arcane-app-package.json'), 'utf8');
  const firstManifest = JSON.parse(firstManifestText);
  const paths = firstManifest.files.map((file) => file.path);

  assert.equal(firstManifest.app.id, 'boss');
  assert.equal(firstManifest.app.type, 'app');
  assert.equal(firstManifest.app.description, 'A private workspace for grounded business research, document libraries, and assisted analysis.');
  assert.equal(firstManifest.app.icon, 'img/boss-libraries-logo-stacked.png');
  assert.equal(firstManifest.app.order, 10);
  assert.deepEqual(paths, [...paths].sort());
  assert(paths.includes('app/arcane-runtime/arcane-api.js'));
  assert(paths.includes('app/boss/boss-library.js'));
  assert(paths.includes('app/boss/chat.html'));
  assert(paths.includes('app/boss/index.html'));
  assert(paths.includes('app/boss/library.html'));
  assert(paths.includes('app/boss/img/boss-libraries-logo-horizontal.png'));
  assert(paths.includes('app/boss/img/boss-libraries-logo-stacked.png'));
  assert(paths.includes('app/boss/documents/document-manifest.json'));
  assert(paths.includes('runtime/arcane-core.cjs'));
  assert(!paths.some((file) => file.includes('business docs')));
  assert(!paths.some((file) => file.startsWith('app/boss/documents/') && file.endsWith('.md')));
  assert(!paths.some((file) => file.includes('precrisis')));

  const entry = await fs.readFile(path.join(first.target, 'app/boss/chat.html'), 'utf8');
  assert.match(entry, /data-arcane-runtime="arcane\/1"/);
  assert.equal((entry.match(/data-arcane-runtime=/g) || []).length, 1);
  assert(!entry.includes('/apps/boss/'));
  await assertSecurityMetadata(first.target, 'boss', false);

  const catalog = JSON.parse(await fs.readFile(path.join(first.target, 'app/boss/documents/document-manifest.json'), 'utf8'));
  assert.deepEqual(catalog, {
    schema_version: 1,
    export_policy: 'empty-unpublished',
    manifest_version: 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e3b9597a7f3306746f41c9e',
    record_count: 0,
    records: [],
  });

  const dependencies = await verifyPackagedAppLinks({ packageRoot: first.target, appId: 'boss' });
  assert.equal(firstManifest.app.security.verifiedDependencies, dependencies.length);
  assert(dependencies.some((dependency) => dependency.endsWith('\0/boss/boss-library.js')));
  assert(dependencies.some((dependency) => dependency.endsWith('\0/boss/documents/document-manifest.json')));

  const targetBundle = JSON.parse(await fs.readFile(path.join(first.target, 'arcane-bundle.json'), 'utf8'));
  assert.deepEqual(Object.keys(targetBundle.apps), ['boss']);
  assert.equal(targetBundle.apps.boss.entry, 'boss/index.html');

  let previousManifestText = firstManifestText;
  let matchedStableInput = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = await buildTargetApp({ bundleRoot, appId: 'boss' });
    const nextManifestText = await fs.readFile(path.join(next.target, 'arcane-app-package.json'), 'utf8');
    if (nextManifestText === previousManifestText) {
      matchedStableInput = true;
      break;
    }
    previousManifestText = nextManifestText;
  }
  assert(matchedStableInput, 'two consecutive builds from stable source input must be byte-for-byte deterministic');
});

test('PreCrisis package contains every offline dependency without unrelated reference material', async () => {
  const result = await buildTargetApp({ bundleRoot, appId: 'precrisis' });
  const manifest = JSON.parse(await fs.readFile(path.join(result.target, 'arcane-app-package.json'), 'utf8'));
  const paths = manifest.files.map((file) => file.path);
  assert(!paths.some((file) => file.includes('deepwiki_ollama_blog.html')));
  assert(!paths.some((file) => file.includes('/boss/')));

  const serviceWorkerPath = path.join(result.target, 'app/precrisis/service-worker.js');
  const serviceWorker = await fs.readFile(serviceWorkerPath, 'utf8');
  const cacheBlock = /const urlsToCache = \[([\s\S]*?)\];/.exec(serviceWorker);
  assert(cacheBlock, 'PreCrisis service worker must declare its offline allowlist');
  const dependencies = await verifyPackagedAppLinks({ packageRoot: result.target, appId: 'precrisis' });
  assert(dependencies.length > 0);
  assert.equal(manifest.app.security.verifiedDependencies, dependencies.length);
  await assertSecurityMetadata(result.target, 'precrisis', true);

  const entry = await fs.readFile(path.join(result.target, 'app/precrisis/index.html'), 'utf8');
  assert(!entry.includes('/apps/precrisis/'));
  const clinical = await fs.readFile(path.join(result.target, 'app/precrisis/dashboard-clinical.html'), 'utf8');
  assert(!clinical.includes('gstatic.com'));
  assert(!clinical.includes('google.charts'));
});

test('link and unpublished-catalog verification fail closed on package drift', async () => {
  const precrisis = await buildTargetApp({ bundleRoot, appId: 'precrisis' });
  const entryPath = path.join(precrisis.target, 'app/precrisis/index.html');
  const entry = await fs.readFile(entryPath, 'utf8');
  try {
    await fs.writeFile(entryPath, entry.replace('</head>', '<script src="/precrisis/missing.js"></script>\n</head>'));
    await assert.rejects(
      () => verifyPackagedAppLinks({ packageRoot: precrisis.target, appId: 'precrisis' }),
      /missing local URL “\/precrisis\/missing\.js”/,
    );
  } finally {
    await fs.writeFile(entryPath, entry);
  }

  const boss = await buildTargetApp({ bundleRoot, appId: 'boss' });
  const catalogPath = path.join(boss.target, 'app/boss/documents/document-manifest.json');
  const catalog = await fs.readFile(catalogPath, 'utf8');
  try {
    const value = JSON.parse(catalog);
    value.record_count = 1;
    value.records.push({ access: 'restricted', sensitive: true, document_path: './private.md' });
    await fs.writeFile(catalogPath, `${JSON.stringify(value, null, 2)}\n`);
    await assert.rejects(
      () => verifyPackagedAppLinks({ packageRoot: boss.target, appId: 'boss' }),
      /without explicit publication authorization/,
    );
  } finally {
    await fs.writeFile(catalogPath, catalog);
  }
});

test('HTML component execution uses a deterministic CSP wrapper and cleans up host tokens', async () => {
  const source = await fs.readFile(path.resolve(bundleRoot, '../..', 'arcane/modules/HTMLImport.js'), 'utf8');
  assert(!/\beval\s*\(/.test(source));
  assert.match(source, /document\.createElement\('script'\)/);
  assert(source.includes('executable.dataset.arcaneHostToken=hostToken;'));
  assert(source.includes(`executable.textContent=\`(async function(){\${source}${componentScriptSuffix}\`;`));
  assert(!source.includes('get(${JSON.stringify(hostToken)})'));
  assert(componentScriptSuffix.includes("if(!host)throw new Error('HTML import host binding is unavailable.')"));
  assert(source.includes('htmlImportHostRegistry.set(hostToken,this);'));
  assert(source.includes('htmlImportHostRegistry.delete(hostToken);'));
  assert(source.includes('delete executable.dataset.arcaneHostToken;'));
  assert(
    source.indexOf('htmlImportHostRegistry.set(hostToken,this);')
      < source.indexOf('document.head.appendChild(executable);'),
    'host token must be registered before component execution',
  );
  assert(
    source.indexOf('document.head.appendChild(executable);')
      < source.indexOf('htmlImportHostRegistry.delete(hostToken);'),
    'host token must be removed after component execution starts',
  );
});

test('Windows target generator embeds the validated navigation allowlist', async () => {
  const source = await fs.readFile(path.join(bundleRoot, 'tools/build-windows-target-app.ps1'), 'utf8');
  assert.match(source, /\$AppId\.Length -gt 64/);
  assert.match(source, /\[a-z0-9\]\*\(\?:-\[a-z0-9\]\+\)\*/);
  assert.match(source, /app\.security\.navigationEntries/);
  assert.match(source, /Unsafe target navigation entry/);
  assert.match(source, /navigation allowlist omits its launch entry/);
  assert.match(source, /internal static readonly string\[\] AllowedNavigationPaths = new string\[\]/);
  assert.match(source, /\$allowedNavigationSource/);
});

test('unknown app names fail closed', async () => {
  await assert.rejects(
    () => buildTargetApp({ bundleRoot, appId: 'not-registered' }),
    /unknown app/,
  );
});
