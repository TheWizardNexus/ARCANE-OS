import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=relative=>readFile(path.join(root,...relative.split('/')),'utf8');
const expectedScreenshots=Object.freeze([
    Object.freeze({
        source:'example/_example_assets/htmlimportExample.png',
        output:'htmlimportExample.png'
    }),
    Object.freeze({
        source:'example/_example_assets/modalExample.png',
        output:'modalExample.png'
    }),
    Object.freeze({
        source:'example/_example_assets/navExample.png',
        output:'navExample.png'
    }),
    Object.freeze({
        source:'example/_example_assets/navExampleMobile.png',
        output:'navExampleMobile.png'
    }),
    Object.freeze({
        source:'example/_example_assets/chatExample.png',
        output:'chatExample.png'
    }),
    Object.freeze({
        source:'example/_example_assets/dbopfsExample.png',
        output:'dbopfsExample.png'
    }),
    Object.freeze({
        source:'apps/docs/guides/images/windows-add-arcane-user.jpg',
        output:'windows-add-arcane-user.jpg'
    }),
    Object.freeze({
        source:'apps/docs/guides/images/windows-account-awaiting-activation.jpg',
        output:'windows-account-awaiting-activation.jpg'
    }),
    Object.freeze({
        source:'apps/docs/guides/images/windows-account-activated.jpg',
        output:'windows-account-activated.jpg'
    }),
    Object.freeze({
        source:'apps/docs/guides/images/windows-arcane-shell.jpg',
        output:'windows-arcane-shell.jpg'
    }),
    Object.freeze({
        source:'apps/docs/guides/images/linux-add-arcane-user.png',
        output:'linux-add-arcane-user.png'
    }),
    Object.freeze({
        source:'apps/docs/guides/images/linux-account-awaiting-activation.png',
        output:'linux-account-awaiting-activation.png'
    }),
    Object.freeze({
        source:'apps/docs/guides/images/linux-account-activated.png',
        output:'linux-account-activated.png'
    }),
    Object.freeze({
        source:'apps/docs/guides/images/linux-arcane-shell.png',
        output:'linux-arcane-shell.png'
    })
]);
const galleryScreenshotOutputs=new Set(
    expectedScreenshots
        .filter(item=>item.source.startsWith('example/_example_assets/'))
        .map(item=>item.output)
);

const [
    index,
    css,
    app,
    packageConfig,
    publication,
    provisionGuide,
    windowsProvisionGuide,
    linuxProvisionGuide,
    developerGuide,
    linuxGuide,
    prompt,
    scopedCache,
    appBarSource,
    sourceViewerSource,
    themeSource
]=await Promise.all([
    read('apps/docs/index.html'),
    read('apps/docs/docs.css'),
    read('apps/docs/modules/DocsApp.js'),
    read('apps/docs/arcane-package.json').then(JSON.parse),
    read('apps/docs/public-content.json').then(JSON.parse),
    read('apps/docs/guides/provision-user.md'),
    read('apps/docs/guides/provision-user-windows.md'),
    read('apps/docs/guides/provision-user-linux.md'),
    read('apps/docs/guides/developer-setup.md'),
    read('apps/docs/guides/linux-host.md'),
    read('apps/docs/prompts/system.md'),
    read('arcane/modules/ScopedOPFSCache.js'),
    read('arcane/components/app-bar.html'),
    read('arcane/components/source-code-viewer.html'),
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
    assert.match(index,/apps\/docs\/docs\.css\?v=0\.3\.0/);
    assert.match(index,/apps\/docs\/modules\/DocsApp\.js\?v=0\.3\.0/);
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

test('Arcane Docs exposes the six semantic product views and onboarding journeys',()=>{
    for(const view of ['home','docs','sources','components','tests','assistant']){
        assert.match(index,new RegExp(`data-view="${view}"`));
    }
    assert.match(index,/<main\b[^>]*id="mainContent"/i);
    assert.match(index,/href="\.\/apps\/docs\/index\.html#\/docs\/provision-user"/);
    assert.match(index,/href="\.\/apps\/docs\/index\.html#\/docs\/provision-user-windows"/);
    assert.match(index,/href="\.\/apps\/docs\/index\.html#\/docs\/provision-user-linux"/);
    assert.match(index,/href="\.\/apps\/docs\/index\.html#\/docs\/developer-setup"/);
    assert.match(index,/Open Microsoft NT walkthrough/);
    assert.match(index,/Open Linux walkthrough/);
    assert.match(app,/parsed\.documentId\|\|selectedDocumentId\|\|'provision-user'/);
    assert.match(app,/catalog\.hydrate\('provision-user-windows'/);
    assert.match(app,/catalog\.hydrate\('provision-user-linux'/);
    assert.match(app,/Verified all \$\{hydrated\.length\} public documents from the generated catalog/);
    assert.match(index,/href="\.\/apps\/docs\/index\.html#\/docs\/linux-host"/);
    assert.match(index,/id="documentSearchForm"[^>]*role="search"/);
    assert.match(index,/id="testResults"[^>]*aria-live="polite"/);
    assert.match(index,/<a class="skip-link" href="\.\/apps\/docs\/index\.html#mainContent">/);
    assert.match(index,/Content-Security-Policy/);
    assert.match(index,/script-src 'self' 'unsafe-inline'/);
    assert.match(index,/property="og:image" content="https:\/\/thewizardnexus\.github\.io\/ARCANE-OS\/arcane\/img\/arcane-os-everywhere\.png"/);
    assert.match(index,/name="twitter:card" content="summary_large_image"/);
});

test('the public content policy is a positive, unique, existing source inventory',async()=>{
    assert.equal(publication.schemaVersion,2);
    assert.equal(publication.audience,'public');
    assert(publication.documents.length>=15);
    assert(publication.sources.length>=30);
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
    assert(ids.has('provision-user-windows'));
    assert(ids.has('provision-user-linux'));
    assert(ids.has('developer-setup'));
    assert(ids.has('linux-host'));

    for(const source of publication.sources){
        assert.match(source.id,/^[a-z0-9][a-z0-9-]*$/);
        assert(!ids.has(source.id.toLowerCase()),`duplicate source id: ${source.id}`);
        assert(!sources.has(source.source.toLowerCase()),`duplicate source path: ${source.source}`);
        ids.add(source.id.toLowerCase());
        sources.add(source.source.toLowerCase());
        assert(!path.posix.isAbsolute(source.source));
        assert(!source.source.split('/').includes('..'));
        await access(path.join(root,...source.source.split('/')));
    }

    const staticCatalogSource=publication.sources.find(
        source=>source.id==='source-static-document-catalog'
    );
    assert(staticCatalogSource);
    assert.equal(
        staticCatalogSource.source,
        'arcane/modules/StaticDocumentCatalog.js'
    );
});

test('screenshot publication explicitly covers gallery and first-user walkthrough images',async()=>{
    assert.deepEqual(publication.screenshots,expectedScreenshots);
    for(const screenshot of publication.screenshots){
        await access(path.join(root,...screenshot.source.split('/')));
        const outputPattern=new RegExp(screenshot.output.replaceAll('.','\\.'));
        if(galleryScreenshotOutputs.has(screenshot.output)){
            assert.match(screenshot.source,/^example\/_example_assets\/[A-Za-z0-9._-]+\.png$/);
            assert.match(screenshot.output,/^[A-Za-z0-9._-]+\.png$/);
            assert.match(app,outputPattern);
            continue;
        }
        assert.match(screenshot.source,/^apps\/docs\/guides\/images\/[A-Za-z0-9._-]+\.(?:jpg|png)$/);
        assert.match(screenshot.output,/^[A-Za-z0-9._-]+\.(?:jpg|png)$/);
        assert.match(
            screenshot.output.startsWith('windows-')
                ?windowsProvisionGuide
                :linuxProvisionGuide,
            outputPattern
        );
    }
});

test('reviewed source has a searchable route and an inert shared viewer',()=>{
    assert.match(index,/href="\.\/apps\/docs\/index\.html#\/sources"/);
    assert.match(index,/id="sourceSearchForm"[^>]*role="search"/);
    assert.match(index,/id="sourceSearchInput"[^>]*type="search"/);
    assert.match(index,/id="sourceResultCount"[^>]*aria-label="0 source files"/);
    assert.match(
        index,
        /id="sourceCatalogStatus"[^>]*role="status"[^>]*aria-live="polite"/
    );
    assert.equal(
        (index.match(/href="\.\/arcane\/components\/source-code-viewer\.html\?v=1"/g)||[]).length,
        2
    );
    assert.match(index,/id="sourceViewer"/);
    assert.match(index,/id="sourceSpecimen"/);
    assert.match(
        app,
        /methods:\['configure','load','render','fail','focusLine'\][\s\S]*?event:'source-code-viewer-ready'/
    );
    assert.match(
        app,
        /methods:\['configure','render','focusLine'\][\s\S]*?event:'source-code-viewer-ready'/
    );
    assert.match(app,/kinds:\[SOURCE_KIND\]/);
    assert.match(app,/renderSourceCatalog\(elements\.sourceSearchInput\.value\)/);
    assert.match(app,/elements\.sourceResultCount\.textContent=String\(records\.length\)/);
    assert.match(
        app,
        /reviewed source files\. Select one to verify and render as inert text/
    );
    assert.match(app,/if\(parsed\.view==='sources'\)/);
    assert.match(app,/await openSource\(id\)/);
    assert.match(app,/if\(parsed\.line&&elements\.sourceViewer\.focusLine\?\.\(parsed\.line\)\)return/);
    assert.match(
        app,
        /link\.href=`\$\{APP_ENTRY_URL\}#\/\$\{route\}\/\$\{encodeURIComponent\(record\.id\)\}`/
    );
    assert.match(
        app,
        /repositoryURL:repositoryFileURL\(record\.sourcePath\|\|record\.path\)/
    );
    assert.match(app,/sourcePath:record\.sourcePath\|\|record\.path/);
    assert.match(app,/text:hydrated\.text/);
    assert.match(
        app,
        /const REPOSITORY_FILE_URL='https:\/\/github\.com\/TheWizardNexus\/ARCANE-OS\/blob\/main\/'/
    );
    assert.match(sourceViewerSource,/code\.textContent=line\|\|' '/);
    assert.match(sourceViewerSource,/host\.ready=true/);
    assert.match(sourceViewerSource,/source-code-viewer-ready/);
    assert.match(
        sourceViewerSource,
        /target="_blank"[\s\S]*?rel="noopener noreferrer"[\s\S]*?referrerpolicy="no-referrer"/
    );
    assert.doesNotMatch(sourceViewerSource,/\.innerHTML\s*=|\beval\s*\(|new Function\b/);
});

test('first-user chooser and platform walkthroughs preserve provisioning boundaries',()=>{
    assert.match(provisionGuide,/provision-user-windows\.md/);
    assert.match(provisionGuide,/provision-user-linux\.md/);
    assert.match(provisionGuide,/cannot create accounts and never asks for a username or password/i);
    assert.match(windowsProvisionGuide,/trusted native \*\*Arcane Provisioner\*\*/);
    assert.match(windowsProvisionGuide,/disabled standard local account/i);
    assert.match(windowsProvisionGuide,/Save the temporary password/i);
    assert.match(windowsProvisionGuide,/Activate this account/);
    assert.match(windowsProvisionGuide,/separate privileged request/i);
    assert.match(windowsProvisionGuide,/Microsoft NT sign-in screen/i);
    assert.match(windowsProvisionGuide,/There is no Arcane username or password form/i);
    assert.match(linuxProvisionGuide,/build:distribution:linux:unsigned-local-test/);
    assert.match(linuxProvisionGuide,/verify:distribution:linux:unsigned-local-test/);
    assert.match(linuxProvisionGuide,/separately authorized root session/i);
    assert.match(linuxProvisionGuide,/locked and expired/i);
    assert.match(linuxProvisionGuide,/Activate this account/);
    assert.match(linuxProvisionGuide,/display manager/i);
    assert.match(linuxProvisionGuide,/console or SSH login/i);
    assert.match(linuxProvisionGuide,/Existing accounts, password reset, and shell recovery/i);
    assert.match(linuxProvisionGuide,/preserves its current password and group memberships/i);
    assert.match(linuxProvisionGuide,/Restore previous POSIX login shell/);
    assert.match(linuxProvisionGuide,/WSLg is a manual desktop launch/);
    assert.match(linuxProvisionGuide,/\.\/start-shell\.sh/);
    assert.match(linuxProvisionGuide,/does not claim real clean-host/i);
});

test('developer setup uses locked dependencies and the supported package gates',()=>{
    assert.match(developerGuide,/\.\\setup-developer\.bat/);
    assert.match(developerGuide,/start-provisioner\.bat/);
    assert.match(developerGuide,/dist\\nt\\bin\\ArcaneProvisioner\.exe/);
    assert.match(developerGuide,/npm run verify:package-locks/);
    assert.match(developerGuide,/npm ci/);
    assert.match(developerGuide,/npm run hooks:install/);
    assert.match(developerGuide,/npm run app:package -- docs/);
    assert.match(developerGuide,/npm run app:check -- docs/);
    assert.match(developerGuide,/npm run release:check/);
    assert.match(developerGuide,/does not turn a local build into a release candidate/i);
    assert.match(developerGuide,/docs\/app-building\.md/);
    assert.match(developerGuide,/libgtk-4-dev libwebkitgtk-6\.0-dev/);
    assert.match(developerGuide,/\.\/build-linux\.sh/);
    assert.match(developerGuide,/npm run build:distribution:linux:unsigned-local-test/);
    assert.match(developerGuide,/npm run verify:distribution:linux:unsigned-local-test/);
    assert.match(developerGuide,/\.\/start-shell\.sh/);
    assert.match(developerGuide,/No host logout or login is required/i);
});

test('Linux host guide states the runnable path and the unsupported release boundary',()=>{
    assert.match(linuxGuide,/experimental developer host/i);
    assert.match(linuxGuide,/Node\.js 22 or newer/);
    assert.match(linuxGuide,/npm run verify:package-locks/);
    assert.match(linuxGuide,/\.\/build-linux\.sh/);
    assert.match(linuxGuide,/\.\/start-shell\.sh/);
    assert.match(linuxGuide,/\/opt\/arcane-os\/bin\/arcane-shell --shell/);
    assert.match(linuxGuide,/do not need to log out of Linux and sign back in/i);
    assert.match(linuxGuide,/direct launch demonstrates the native Shell experience/i);
    assert.match(linuxGuide,/XDG_CONFIG_HOME/);
    assert.match(linuxGuide,/does not yet repair permissions on a pre-existing token file/i);
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
    assert.doesNotMatch(app,/\btools\s*:/);
    assert.match(index,/reviewed documentation and source are attached/i);
    assert.match(prompt,/untrusted reference content/i);
    assert.match(prompt,/documentation and source excerpts/i);
    assert.match(prompt,/original source paths and line ranges/i);
    assert.match(prompt,/Do not claim to execute commands/i);
    assert.match(
        app,
        /Ask about the published Arcane OS documentation or reviewed source/
    );
    assert.match(app,/const path=item\.sourcePath\|\|item\.path\|\|item\.id/);
    assert.match(app,/item\.lineStart&&item\.lineEnd/);
    assert.match(app,/citations\.join\('; '\)/);
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
    assert.match(app,/fetchImpl:catalogFetchForVersion\(manifest\.version\)/);
    assert.match(app,/target\.searchParams\.set\('catalog',cacheKey\)/);
    assert.match(app,/fetch\(target\.href,\{\.\.\.request,cache:'no-store'\}\)/);
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
    assert.match(
        app,
        /\['home','docs','sources','components','tests','assistant'\]\.includes\(viewPart\)/
    );
    assert.match(app,/if\(view==='sources'&&rest\[0\]\)/);
    assert.match(app,/const match=\/\^L\?\(\[1-9\]\[0-9\]\{0,5\}\)\$\/i\.exec\(lineText\)/);
    assert.match(app,/invalidSource=true/);
    assert.match(app,/No public document matches this address/);
    assert.match(app,/No reviewed source file matches this address/);
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
    const catalogPath=app.match(/const CATALOG_URL='([^']+)'/)?.[1];
    const hrefs=Array.from(index.matchAll(/(?:href|data-brand-href)="([^"]+)"/g),match=>match[1])
        .filter(href=>href.includes('#/'));
    assert(hrefs.length>=6);
    for(const href of hrefs){
        const resolved=new URL(href,baseURL);
        assert.equal(resolved.pathname,'/ARCANE-OS/apps/docs/index.html',href);
    }
    assert(catalogPath);
    assert.equal(
        new URL(catalogPath,baseURL).pathname,
        '/ARCANE-OS/apps/docs/catalog/document-catalog.json'
    );
    assert.equal(new URL(catalogPath,baseURL).search,'?v=0.3.0');
    assert.match(app,/const APP_ENTRY_URL='\.\/apps\/docs\/index\.html'/);
    assert.match(app,/recordLink\(record,\{[\s\S]*?route:'docs'/);
    assert.match(
        app,
        /link\.href=`\$\{APP_ENTRY_URL\}#\/\$\{route\}\/\$\{encodeURIComponent\(record\.id\)\}`/
    );
});

test('catalog failure keeps Docs and Source useful while a Pages artifact is repaired',()=>{
    assert.match(index,/id="catalogFailureHelp"[^>]*hidden/);
    assert.match(index,/id="sourceFailureHelp"[^>]*hidden/);
    assert.match(index,/The verified catalog is missing from this deployment/);
    assert.match(index,/apps\/docs\/guides\/linux-host\.md/);
    assert.match(app,/setCatalogFailureState\(true,message\)/);
    assert.match(app,/viewer\.hidden=failed/);
    assert.match(app,/help\.hidden=!failed/);
    assert.match(app,/elements\.documentSearchInput\.disabled=failed/);
    assert.match(app,/elements\.homeSearchInput\.disabled=failed/);
    assert.match(app,/elements\.homeSearchSubmit\.disabled=failed/);
    assert.match(app,/elements\.sourceSearchInput\.disabled=failed/);
    assert.match(app,/elements\.runTests\.disabled=failed/);
    assert.match(app,/Browser checks require the verified generated catalog/);
    assert.match(css,/\.document-panel\[data-state="error"\]/);
});

test('browser checks hydrate every published document and reviewed source file',()=>{
    assert.match(app,/const requiredIds=new Set\(\['provision-user','provision-user-windows','provision-user-linux'\]\)/);
    assert.match(app,/\.\.\.records[\s\S]*?\.filter\(record=>!requiredIds\.has\(record\.id\)\)[\s\S]*?\.map\(record=>catalog\.hydrate\(record\.id,\{bypassCache:true,signal\}\)\)/);
    assert.match(app,/hydrated\.length===records\.length/);
    assert.equal((app.match(/async run\(\{assert,signal\}\)/g)||[]).length,2);
    assert.match(app,/At least one public document hydrated as empty text/);
    assert.match(app,/At least one reviewed source file hydrated as empty text/);
    assert.match(app,/Promise\.all\(records\.map\(record=>catalog\.hydrate\(record\.id,\{bypassCache:true,signal\}\)\)\)/);
    assert.match(app,/timeoutMs:20000/);
});

test('catalog persistence is automatic but scoped to exact keys in one docs namespace',()=>{
    assert.match(app,/arcane-docs-public-corpus-v2/);
    assert.match(app,/scheduleCatalogCache/);
    assert.match(app,/catalog\.hydrate\(record\.id\)/);
    assert.doesNotMatch(app,/modules\/DBOPFS\.js|localStorage/i);
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
