import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildTargetApp,
  normalizeNavigationEntry,
  normalizeRelativePath,
  resolveBundledAppIds,
  validateAppRegistry,
} from './app-packager-lib.mjs';
import { verifyPackagedAppLinks } from './app-package-links.mjs';
import { replaceTemplateTokenExactlyOnce } from './exact-template-replacement.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundleRoot = path.resolve(here, '..');
const componentScriptPrefix = "(()=>{const registry=globalThis[Symbol.for('arcane.html-import.hosts')];const token=document.currentScript&&document.currentScript.dataset.arcaneHostToken;const binding=registry instanceof Map&&token?registry.get(token):null;if(!binding?.host)throw new Error('HTML import host binding is unavailable.');binding.promise=(async function(){";
const componentScriptSuffix = '}).call(binding.host);})()';

test('template replacement preserves JavaScript replacement metacharacters byte-for-byte', () => {
  const injected = ['$&', '$`', "$'", '$1', String.raw`C:\\Arcane\\$&\\$1`].join('|');
  assert.equal(
    replaceTemplateTokenExactlyOnce('before __ARCANE_TEST_TOKEN__ after', '__ARCANE_TEST_TOKEN__', injected),
    `before ${injected} after`,
  );
  assert.throws(
    () => replaceTemplateTokenExactlyOnce('missing', '__ARCANE_TEST_TOKEN__', injected),
    /exactly once/,
  );
  assert.throws(
    () => replaceTemplateTokenExactlyOnce('__ARCANE_TEST_TOKEN____ARCANE_TEST_TOKEN__', '__ARCANE_TEST_TOKEN__', injected),
    /exactly once/,
  );
});

test('Core build requires one exact CSP placeholder replacement', async () => {
  const builder = await fs.readFile(path.join(bundleRoot, 'tools', 'build-core.mjs'), 'utf8');
  assert.match(builder, /replaceTemplateTokenExactlyOnce\(html, '__ARCANE_SCRIPT_HASHES__', cspScripts\)/);
  assert.doesNotMatch(builder, /html[.]replace\('__ARCANE_SCRIPT_HASHES__'/);
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256Source(source) {
  return `'sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

async function assertSecurityMetadata(target, appId, microphone, frameSources = "'none'", mail = false) {
  const appRoot = path.join(target, 'app', appId);
  const documents = [];
  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        const html = await fs.readFile(absolute, 'utf8');
        if (/<head\b/i.test(html)) documents.push(relative);
      }
    }
  }
  await visit(appRoot);
  documents.sort();
  assert(documents.length > 0, `${appId} must contain secured HTML documents`);
  const manifest = JSON.parse(await fs.readFile(path.join(target, 'arcane-app-package.json'), 'utf8'));
  assert.deepEqual(
    manifest.app.security.navigationEntries,
    documents.map((entry) => `/${appId}/${entry}`),
    `${appId} navigation allowlist must contain every full secured document`,
  );
  for (const document of documents) {
    const html = await fs.readFile(path.join(appRoot, ...document.split('/')), 'utf8');
    const policies = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/gi)];
    const permissions = [...html.matchAll(/<meta\s+http-equiv="Permissions-Policy"\s+content="([^"]+)"/gi)];
    assert.equal(policies.length, 1, `${appId}/${document} must contain one generated CSP`);
    assert.equal(permissions.length, 1, `${appId}/${document} must contain one generated Permissions-Policy`);
    const policy = policies[0][1];
    assert.equal(policy, manifest.app.security.contentSecurityPolicy);
    assert.match(policy, /default-src 'none'/);
    assert(policy.includes(`frame-src ${frameSources}`), `${appId}/${document} has an unexpected frame policy`);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /script-src-attr 'none'/);
    assert.match(policy, mail
      ? /connect-src 'self' http:\/\/127\.0\.0\.1:11434 http:\/\/127\.0\.0\.1:8011 http:\/\/127\.0\.0\.1:8025 https:\/\/api\.openai\.com/
      : /connect-src 'self' http:\/\/127\.0\.0\.1:11434 http:\/\/127\.0\.0\.1:8011 https:\/\/api\.openai\.com/);
    assert.match(policy, /media-src 'self' blob: https:\/\/cdn\.openai\.com/);
    const scriptPolicy = /(?:^|; )script-src ([^;]+)/.exec(policy)?.[1] || '';
    assert(!scriptPolicy.includes("'unsafe-inline'"), `${appId} script policy allows arbitrary inline code`);
    assert(!scriptPolicy.includes("'unsafe-eval'"), `${appId} script policy allows eval`);
    assert(!/https?:/.test(scriptPolicy), `${appId} script policy allows remote code`);
    assert.match(html, /<base\b[^>]*href="\/"/i);
    assert(html.indexOf('http-equiv="Content-Security-Policy"') < html.indexOf('<base href="/">'), `${appId}/${document} base precedes its CSP`);
    for (const script of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      assert(scriptPolicy.includes(sha256Source(script[1])), `${appId}/${document} has an unhashed inline script`);
    }
    assert.equal(permissions[0][1].includes('microphone=(self)'), microphone);
    assert.equal(permissions[0][1].includes('microphone=()'), !microphone);
  }

  const component = await fs.readFile(path.join(target, 'app/arcane/components/chat.html'), 'utf8');
  const componentSource = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/i.exec(component)?.[1];
  assert(componentSource, 'shared chat component must contain its behavior script');
  const wrapperHash = sha256Source(`${componentScriptPrefix}${componentSource}${componentScriptSuffix}`);
  assert(manifest.app.security.contentSecurityPolicy.includes(wrapperHash), `${appId} CSP omits approved component wrapper`);
}

test('relative path validation rejects traversal and platform-specific escapes', () => {
  assert.equal(normalizeRelativePath('apps/precrisis', 'fixture'), 'apps/precrisis');
  for (const candidate of ['../secret', 'apps/../secret', '/absolute', 'C:/Windows', 'apps\\boss', 'apps//boss', 'apps/con']) {
    assert.throws(() => normalizeRelativePath(candidate, 'fixture'), /Invalid Arcane app package configuration/);
  }
});

test('nested application navigation paths are canonical, URL-safe, and traversal-resistant', async () => {
  const valid = JSON.parse(await fs.readFile(path.join(bundleRoot, 'arcane-apps.json'), 'utf8'));
  valid.apps.boss.entry = 'components/nav.html';
  const nested = validateAppRegistry(valid);
  assert.equal(nested.apps.boss.entry, 'components/nav.html');
  assert.equal(
    normalizeNavigationEntry('/boss/components/nav.html', 'boss'),
    '/boss/components/nav.html',
  );
  for (const unsafe of [
    '/boss/../escape.html',
    '/boss/pages/./escape.html',
    '/boss/pages//escape.html',
    '/boss/pages\\escape.html',
    '/boss/%2e%2e/escape.html',
    '/boss/pages/escape.html?mode=unsafe',
    '/other/pages/escape.html',
    '/boss/pages/not-html.txt',
    `/boss/${'a'.repeat(507)}.html`,
  ]) {
    assert.throws(
      () => normalizeNavigationEntry(unsafe, 'boss'),
      /Invalid Arcane app package configuration/,
      unsafe,
    );
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

  const windowsReservedId = clone(valid);
  windowsReservedId.apps.con = windowsReservedId.apps.boss;
  delete windowsReservedId.apps.boss;
  assert.throws(() => validateAppRegistry(windowsReservedId), /app id .* is invalid or reserved/);

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

test('bundled application graphs are explicit, acyclic, and capability-contained', async () => {
  const valid = JSON.parse(await fs.readFile(path.join(bundleRoot, 'arcane-apps.json'), 'utf8'));
  const normalized = validateAppRegistry(valid);
  assert.deepEqual(normalized.apps['warrior-spirit'].bundledApps, ['precrisis']);
  assert.deepEqual(resolveBundledAppIds(normalized, 'warrior-spirit'), ['precrisis']);
  assert(normalized.apps['warrior-spirit'].capabilities.includes('web.embed'));
  assert.deepEqual(normalized.apps['warrior-spirit'].security.frameOrigins, []);

  const transitive = clone(valid);
  transitive.apps['nested-helper'] = {
    ...clone(transitive.apps.calculator),
    displayName: 'Nested helper',
    description: 'Synthetic package-graph fixture.',
    order: 9999,
    capabilities: [],
    security: { connectOrigins: [], mediaOrigins: [] },
  };
  transitive.apps.precrisis.bundledApps = ['nested-helper'];
  assert.deepEqual(
    resolveBundledAppIds(validateAppRegistry(transitive), 'warrior-spirit'),
    ['nested-helper', 'precrisis'],
  );

  const duplicate = clone(valid);
  duplicate.apps['warrior-spirit'].bundledApps.push('precrisis');
  assert.throws(() => validateAppRegistry(duplicate), /duplicate application ids/);

  const self = clone(valid);
  self.apps['warrior-spirit'].bundledApps = ['warrior-spirit'];
  assert.throws(() => validateAppRegistry(self), /must not include its own application id/);

  const unknown = clone(valid);
  unknown.apps['warrior-spirit'].bundledApps = ['missing-app'];
  assert.throws(() => validateAppRegistry(unknown), /references unknown application/);

  const cycle = clone(valid);
  cycle.apps.precrisis.bundledApps = ['warrior-spirit'];
  assert.throws(() => validateAppRegistry(cycle), /bundledApps contains a cycle/);

  const capabilityGap = clone(valid);
  capabilityGap.apps['warrior-spirit'].capabilities = capabilityGap.apps['warrior-spirit'].capabilities
    .filter((capability) => capability !== 'ai.models.read');
  assert.throws(() => validateAppRegistry(capabilityGap), /capabilities for bundled application.*ai\.models\.read/);

  const originGap = clone(valid);
  originGap.apps['warrior-spirit'].security.connectOrigins = originGap.apps['warrior-spirit'].security.connectOrigins
    .filter((origin) => origin !== 'https://api.openai.com');
  assert.throws(() => validateAppRegistry(originGap), /connectOrigins for bundled application.*api\.openai\.com/);

  const mediaOriginGap = clone(valid);
  mediaOriginGap.apps['warrior-spirit'].security.mediaOrigins = [];
  assert.throws(() => validateAppRegistry(mediaOriginGap), /mediaOrigins for bundled application.*cdn\.openai\.com/);

  const frameOriginGap = clone(valid);
  frameOriginGap.apps.precrisis.capabilities.push('web.embed');
  frameOriginGap.apps.precrisis.security.frameOrigins = ['https://example.com'];
  assert.throws(() => validateAppRegistry(frameOriginGap), /frameOrigins for bundled application.*example\.com/);

  const catalog = clone(valid);
  catalog.apps['warrior-spirit'].bundledApps = ['boss'];
  assert.throws(() => validateAppRegistry(catalog), /cannot include.*because it generates a document catalog/);

  const frameWithoutCapability = clone(valid);
  frameWithoutCapability.apps.boss.security.frameOrigins = ['https://example.com'];
  assert.throws(() => validateAppRegistry(frameWithoutCapability), /frameOrigins requires the web\.embed capability/);
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
  const targetCore = await fs.readFile(path.join(first.target, 'runtime', 'arcane-core.cjs'), 'utf8');
  assert.match(targetCore, /const CORE_PLATFORM_ADAPTER_FACTORIES = Object\.freeze\(/);
  assert.match(targetCore, /win32: createWindowsNativeAdapter/);
  assert.match(targetCore, /linux: createLinuxNativeAdapter/);
  assert.match(targetCore, /const native = createCoreNativeAdapter\(platform, nativeContext\)/);
  assert.doesNotMatch(targetCore, /__ARCANE_NATIVE_ADAPTERS__/);
  assert.match(targetCore, /const METHOD_POLICIES = Object\.freeze\(\{/);
  assert.match(targetCore, /'platform\.status': Object\.freeze\(\{ capability:"system\.read" \}\)/);
  assert.match(targetCore, /'users\.add': Object\.freeze\(\{ capability:"users\.manage", appTypes:Object\.freeze\(\["provisioner"\]\), privileged:true, exclusiveMutation:true \}\)/);
  assert.doesNotMatch(targetCore, /__ARCANE_METHOD_POLICIES__/);

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
  await assertSecurityMetadata(result.target, 'precrisis', true, "'none'", true);

  const entry = await fs.readFile(path.join(result.target, 'app/precrisis/index.html'), 'utf8');
  assert(!entry.includes('/apps/precrisis/'));
  const clinical = await fs.readFile(path.join(result.target, 'app/precrisis/dashboard-clinical.html'), 'utf8');
  assert(!clinical.includes('gstatic.com'));
  assert(!clinical.includes('google.charts'));
});

test('Warrior Spirit package bundles the registered PreCrisis snapshot with self-only framing', async () => {
  const registry = validateAppRegistry(JSON.parse(await fs.readFile(path.join(bundleRoot, 'arcane-apps.json'), 'utf8')));
  const bundledAppIds = resolveBundledAppIds(registry, 'warrior-spirit');
  const result = await buildTargetApp({ bundleRoot, appId: 'warrior-spirit' });
  const manifestPath = path.join(result.target, 'arcane-app-package.json');
  const firstManifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(firstManifestText);
  const paths = manifest.files.map((file) => file.path);

  for (const required of [
    'app/precrisis/admin.html',
    'app/precrisis/chat.html',
    'app/precrisis/dashboard.html',
    'app/precrisis/data.html',
    'app/precrisis/entities/Journal.js',
    'app/precrisis/journal.html',
    'app/precrisis/modules/PostSaveAssessmentUI.js',
    'app/warrior-spirit/companion.html',
    'app/warrior-spirit/modules/PreCrisisFrame.js',
  ]) assert(paths.includes(required), `Warrior Spirit package is missing ${required}`);
  assert(!paths.some((file) => file.includes('deepwiki_ollama_blog.html')));
  assert(!paths.some((file) => file.startsWith('app/boss/')));
  assert(manifest.app.security.contentSecurityPolicy.includes("frame-src 'self'"));
  assert(!manifest.app.security.contentSecurityPolicy.includes("frame-src 'none'"));

  const companion = await fs.readFile(path.join(result.target, 'app/warrior-spirit/companion.html'), 'utf8');
  assert.match(companion, /data-precrisis-page="chat\.html"/);
  assert(!companion.includes('/apps/warrior-spirit/'));
  const bundledChat = await fs.readFile(path.join(result.target, 'app/precrisis/chat.html'), 'utf8');
  assert(!bundledChat.includes('/apps/precrisis/'));
  assert(bundledChat.includes(`http-equiv="Content-Security-Policy" content="${manifest.app.security.contentSecurityPolicy}"`));
  const bundledServiceWorker = await fs.readFile(path.join(result.target, 'app/precrisis/service-worker.js'), 'utf8');
  assert(!bundledServiceWorker.includes('/apps/precrisis/'));

  const dependencies = await verifyPackagedAppLinks({ packageRoot: result.target, appId: 'warrior-spirit', bundledAppIds });
  assert.equal(manifest.app.security.verifiedDependencies, dependencies.length);
  await assert.rejects(
    () => verifyPackagedAppLinks({ packageRoot: result.target, appId: 'warrior-spirit' }),
    /payload contains undeclared root.*precrisis/,
  );
  await assertSecurityMetadata(result.target, 'warrior-spirit', true, "'self'", true);

  const targetBundle = JSON.parse(await fs.readFile(path.join(result.target, 'arcane-bundle.json'), 'utf8'));
  assert.deepEqual(Object.keys(targetBundle.apps), ['warrior-spirit']);

  await buildTargetApp({ bundleRoot, appId: 'warrior-spirit' });
  assert.equal(await fs.readFile(manifestPath, 'utf8'), firstManifestText);
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
  assert(source.includes('binding.promise=(async function(){${source}}).call(binding.host);'));
  assert(!source.includes('get(${JSON.stringify(hostToken)})'));
  assert(source.includes("if(!binding?.host)throw new Error('HTML import host binding is unavailable.')"));
  assert(source.includes('const binding={host:this,promise:null};'));
  assert(source.includes('htmlImportHostRegistry.set(hostToken,binding);'));
  assert(source.includes('await binding.promise;'));
  assert(source.includes('htmlImportHostRegistry.delete(hostToken);'));
  assert(source.includes('delete executable.dataset.arcaneHostToken;'));
  assert(
    source.indexOf('htmlImportHostRegistry.set(hostToken,binding);')
      < source.indexOf('document.head.appendChild(executable);'),
    'host token must be registered before component execution',
  );
  assert(
    source.indexOf('document.head.appendChild(executable);')
      < source.indexOf('htmlImportHostRegistry.delete(hostToken);'),
    'host token must be removed after component execution starts',
  );
});

test('Microsoft NT target generator embeds the validated navigation allowlist', async () => {
  const source = await fs.readFile(path.join(bundleRoot, 'tools/build-windows-target-app.ps1'), 'utf8');
  assert.match(source, /\$AppId\.Length -gt 64/);
  assert.match(source, /\[a-z0-9\]\*\(\?:-\[a-z0-9\]\+\)\*/);
  assert.match(source, /app\.security\.navigationEntries/);
  assert.match(source, /navigationRelative\.Split\(\[char\]'\/'\)/);
  assert.match(source, /navigationSegments\.Count -lt 2/);
  assert.match(source, /\^\[A-Za-z0-9\._~-\]\+\$/);
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
