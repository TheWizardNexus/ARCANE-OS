import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=relative=>readFile(path.join(root,...relative.split('/')),'utf8');

const [
    index,
    css,
    app,
    packageConfig,
    publication,
    provisionGuide,
    developerGuide,
    prompt,
    scopedCache,
    appBarSource,
    themeSource
]=await Promise.all([
    read('apps/docs/index.html'),
    read('apps/docs/docs.css'),
    read('apps/docs/modules/DocsApp.js'),
    read('apps/docs/arcane-package.json').then(JSON.parse),
    read('apps/docs/public-content.json').then(JSON.parse),
    read('apps/docs/guides/provision-user.md'),
    read('apps/docs/guides/developer-setup.md'),
    read('apps/docs/prompts/system.md'),
    read('arcane/modules/ScopedOPFSCache.js'),
    read('arcane/components/app-bar.html'),
    read('arcane/css/theme.css')
]);

function relativeLuminance([red,green,blue]){
    const channels=[red,green,blue].map(value=>{
        const channel=value/255;
        return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;
    });
    return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];
}

function contrastRatio(left,right){
    const values=[relativeLuminance(left),relativeLuminance(right)].sort((a,b)=>b-a);
    return (values[0]+.05)/(values[1]+.05);
}

test('Arcane Docs loads the shared theme, saved appearance, primitives, then app CSS',()=>{
    const theme=index.indexOf('arcane/css/theme.css');
    const primitives=index.indexOf('arcane/css/primitives.css');
    const appCSS=index.indexOf('apps/docs/docs.css');
    assert(theme>=0&&primitives>theme&&appCSS>primitives);
    assert.match(index,/arcane\/modules\/ThemeBootstrap\.js/);
    assert.match(index,/arcane\/modules\/HTMLImport\.js/);
    assert.match(app,/import runAsyncBoundary from '\.\.\/\.\.\/\.\.\/arcane\/modules\/AsyncBoundary\.js'/);
    assert.match(index,/<meta name="arcane-app-id" content="docs">/);
    assert.doesNotMatch(index,/<base\s+href="\/"/i);
    assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b/i);
});

test('Docs app-bar active routes and brand retain AA contrast in light and dark themes',()=>{
    assert.match(appBarSource,/--app-bar-active-text:var\(--text-color,#fff\)/);
    assert.match(appBarSource,/@media\(forced-colors:active\)/);
    assert.match(appBarSource,/color:HighlightText/);
    assert.match(themeSource,/--text-color:rgb\(23, 34, 56\)[\s\S]*?--secondary-color:rgb\(229, 233, 243\)/);
    assert.match(themeSource,/--text-color:rgb\(237, 241, 250\)[\s\S]*?--secondary-color:rgb\(26, 33, 52\)/);
    assert(contrastRatio([23,34,56],[229,233,243])>=4.5);
    assert(contrastRatio([237,241,250],[26,33,52])>=4.5);
});

test('Arcane Docs exposes the five semantic product views and onboarding journeys',()=>{
    for(const view of ['home','docs','components','tests','assistant']){
        assert.match(index,new RegExp(`data-view="${view}"`));
    }
    assert.match(index,/<main\b[^>]*id="mainContent"/i);
    assert.match(index,/href="\.\/apps\/docs\/index\.html#\/docs\/provision-user"/);
    assert.match(index,/href="\.\/apps\/docs\/index\.html#\/docs\/developer-setup"/);
    assert.match(index,/id="documentSearchForm"[^>]*role="search"/);
    assert.match(index,/id="testResults"[^>]*aria-live="polite"/);
    assert.match(index,/<a class="skip-link" href="\.\/apps\/docs\/index\.html#mainContent">/);
    assert.match(index,/Content-Security-Policy/);
    assert.match(index,/script-src 'self' 'unsafe-inline'/);
    assert.match(index,/property="og:image" content="https:\/\/thewizardnexus\.github\.io\/ARCANE-OS\/arcane\/img\/arcane-os-everywhere\.png"/);
    assert.match(index,/name="twitter:card" content="summary_large_image"/);
});

test('the public content policy is a positive, unique, existing source inventory',async()=>{
    assert.equal(publication.schemaVersion,1);
    assert.equal(publication.audience,'public');
    assert(publication.documents.length>=12);
    const ids=new Set();
    const sources=new Set();
    for(const document of publication.documents){
        assert.match(document.id,/^[a-z0-9][a-z0-9-]*$/);
        assert(!ids.has(document.id.toLowerCase()),`duplicate document id: ${document.id}`);
        assert(!sources.has(document.source.toLowerCase()),`duplicate source: ${document.source}`);
        ids.add(document.id.toLowerCase());
        sources.add(document.source.toLowerCase());
        assert(!path.posix.isAbsolute(document.source));
        assert(!document.source.split('/').includes('..'));
        await access(path.join(root,...document.source.split('/')));
    }
    assert(ids.has('provision-user'));
    assert(ids.has('developer-setup'));
});

test('screenshot publication is explicit and matches every gallery image',async()=>{
    assert.equal(publication.screenshots.length,6);
    for(const screenshot of publication.screenshots){
        assert.match(screenshot.source,/^example\/_example_assets\/[A-Za-z0-9._-]+\.png$/);
        assert.match(screenshot.output,/^[A-Za-z0-9._-]+\.png$/);
        await access(path.join(root,...screenshot.source.split('/')));
        assert.match(app,new RegExp(screenshot.output.replaceAll('.','\\.')));
    }
});

test('provisioning preserves credential delivery, activation, and recovery boundaries',()=>{
    assert.match(provisionGuide,/trusted native \*\*Arcane Provisioner\*\*/);
    assert.match(provisionGuide,/disabled standard account/i);
    assert.match(provisionGuide,/activation-pending/);
    assert.match(provisionGuide,/Save the temporary password/i);
    assert.match(provisionGuide,/Activate this account/);
    assert.match(provisionGuide,/separate privileged request/i);
    assert.match(provisionGuide,/Restore previous shell/);
    assert.match(provisionGuide,/disables real account.*Linux/is);
    assert.match(provisionGuide,/cannot create accounts and never asks for a username or password/i);
});

test('developer setup uses locked dependencies and the supported package gates',()=>{
    assert.match(developerGuide,/\.\\setup-developer\.bat/);
    assert.match(developerGuide,/npm ci/);
    assert.match(developerGuide,/npm run hooks:install/);
    assert.match(developerGuide,/npm run app:package -- docs/);
    assert.match(developerGuide,/npm run app:check -- docs/);
    assert.match(developerGuide,/npm run release:check/);
    assert.match(developerGuide,/does not turn a local build into a release candidate/i);
    assert.match(developerGuide,/docs\/app-building\.md/);
});

test('assistant is profile-bound, context-bounded, consent-aware, and fail-closed on Pages',()=>{
    assert.match(app,/ConfiguredAIChatSession/);
    assert.match(app,/catalog\.buildContext/);
    assert.match(app,/bodySearch:true/);
    assert.match(app,/scanLimit:Math\.min\(catalog\.size,100\)/);
    assert.match(app,/expectedProvider:profileProviderId\(aiProfile\)/);
    assert.match(app,/typeof aiProfile\?\.local==='boolean'/);
    assert.match(app,/aiProfile\.local===false&&!elements\.remoteConsent\.checked/);
    assert.match(app,/typeof globalThis\.Arcane\?\.ai\?\.chat==='function'/);
    assert.match(app,/chatSession===null/);
    assert.doesNotMatch(app,/modules\/DBOPFS\.js/);
    assert.doesNotMatch(app,/apiKey|localStorage/i);
    assert.match(prompt,/untrusted reference content/i);
    assert.match(prompt,/Do not claim to execute commands/i);
    assert.match(app,/methods:\['open','setState','scrollToEnd'\]/);
    assert.match(app,/parsed\.view==='assistant'\)elements\.assistant\.open\?\.\(\{focus:false\}\)/);
    assert.match(css,/\.assistant-panel::part\(close-button\)\{[\s\S]*?display:none/);
    assert.match(app,/runAsyncBoundary\([\s\S]*?profile\.call\(globalThis\.Arcane\.ai\)[\s\S]*?timeoutMs:AI_PROFILE_TIMEOUT_MS/);
});

test('startup network and host profile waits are finite and abort-aware',()=>{
    assert.match(app,/const CATALOG_FETCH_TIMEOUT_MS=10000/);
    assert.match(app,/const AI_PROFILE_TIMEOUT_MS=3000/);
    assert.match(app,/const SYSTEM_PROMPT_TIMEOUT_MS=5000/);
    assert.match(app,/runAsyncBoundary\(async signal=>\{[\s\S]*?fetch\(CATALOG_URL,[\s\S]*?return response\.json\(\)/);
    assert.match(app,/runAsyncBoundary\(async signal=>\{[\s\S]*?fetch\('\.\/apps\/docs\/prompts\/system\.md',[\s\S]*?return response\.text\(\)/);
    assert.match(app,/headers:\{Accept:'application\/json'\},[\s\S]*?signal/);
    assert.match(app,/ASYNC_BOUNDARY_TIMEOUT/);
    assert.match(app,/public document catalog request timed out/);
});

test('hash routing preserves skip-link focus and cross-document fragments',()=>{
    assert.match(app,/location\.hash==='\#mainContent'/);
    assert.match(app,/elements\.mainContent\.focus\(\{preventScroll:true\}\)/);
    assert.match(app,/target\.hash=''/);
    assert.match(app,/event\.detail\.fragment/);
    assert.match(app,/elements\.documentViewer\.focusFragment\?\.\(parsed\.fragment\)/);
    assert.match(app,/Promise\.allSettled\(components\.map\(wait\)\)/);
    assert.match(app,/errorEvent:'html-import-error'/);
    assert.match(app,/timeoutMs:COMPONENT_READY_TIMEOUT_MS/);
    assert.match(app,/const DOCUMENT_ID_PATTERN=\/\^\[a-z0-9\]\[a-z0-9-\]\*\$\//);
    assert.match(app,/invalidDocument=true/);
    assert.match(app,/No public document matches this address/);
    assert.match(app,/selectedDocumentId='';[\s\S]*?renderCatalog\(elements\.documentSearchInput\.value\)/);
    assert.match(app,/try\{return catalog\.get\(id\)\|\|null\}catch\{return null\}/);
});

test('non-catalog Markdown links have an explicit repository fallback',()=>{
    assert.match(index,/View repository/);
    assert.match(app,/const REPOSITORY_FILE_URL='https:\/\/github\.com\/TheWizardNexus\/ARCANE-OS\/blob\/main\/'/);
    assert.match(app,/repositorySourceURL\(target,event\.detail\.fragment\)/);
    assert.match(app,/globalThis\.open\(repositoryURL,'_blank','noopener,noreferrer'\)/);
    assert.match(app,/This source is outside the public catalog/);
    assert.match(index,/id="catalogStatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(publication.documents.find(item=>item.id==='overview').source,/^README\.md$/);
    assert(!publication.documents.some(item=>item.source==='AGENTS.md'));
});

test('route anchors remain inside the deployed app under a Pages project path',()=>{
    const deployedEntry=new URL('apps/docs/index.html','https://example.test/ARCANE-OS/');
    const baseURL=new URL('../../',deployedEntry);
    const hrefs=Array.from(index.matchAll(/(?:href|data-brand-href)="([^"]+)"/g),match=>match[1])
        .filter(href=>href.includes('#/'));
    assert(hrefs.length>=6);
    for(const href of hrefs){
        const resolved=new URL(href,baseURL);
        assert.equal(resolved.pathname,'/ARCANE-OS/apps/docs/index.html',href);
    }
    assert.match(app,/const APP_ENTRY_URL='\.\/apps\/docs\/index\.html'/);
    assert.match(app,/link\.href=`\$\{APP_ENTRY_URL\}#\/docs\//);
});

test('catalog persistence is automatic but scoped to exact keys in one docs namespace',()=>{
    assert.match(app,/arcane-docs-public-catalog-v1/);
    assert.match(app,/scheduleCatalogCache/);
    assert.match(app,/catalog\.hydrate\(record\.id\)/);
    assert.match(scopedCache,/exact-key get, set, and delete/);
    assert.doesNotMatch(scopedCache,/clearAllStorage|restoreFromPNG|downloadCompressedPNG/);
    assert.doesNotMatch(scopedCache,/async\s+(?:list|clear)\s*\(/);
});

test('Docs package declares the adapter boundary and only the shared browser runtime',()=>{
    assert.equal(packageConfig.id,'docs');
    assert.equal(packageConfig.strategy,'adapter');
    assert.equal(packageConfig.adapter,'scripts/build_public_release.mjs');
    assert.deepEqual(packageConfig.shared,['browser-runtime']);
    assert(packageConfig.include.includes('public-content.json'));
    assert(packageConfig.exclude.includes('scripts'));
});
