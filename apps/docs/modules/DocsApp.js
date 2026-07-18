import BrowserTestSuite from '../../../arcane/modules/BrowserTestSuite.js';
import ConfiguredAIChatSession from '../../../arcane/modules/ConfiguredAIChatSession.js';
import runAsyncBoundary from '../../../arcane/modules/AsyncBoundary.js';
import ScopedOPFSCache from '../../../arcane/modules/ScopedOPFSCache.js';
import StaticDocumentCatalog from '../../../arcane/modules/StaticDocumentCatalog.js';
import waitForComponent from '../../../arcane/modules/WaitForComponent.js';

const CATALOG_URL='./apps/docs/catalog/document-catalog.json';
const CATALOG_BASE_URL='./apps/docs/catalog/';
const APP_ENTRY_URL='./apps/docs/index.html';
const REPOSITORY_FILE_URL='https://github.com/TheWizardNexus/ARCANE-OS/blob/main/';
const CACHE_NAMESPACE='arcane-docs-public-catalog-v1';
const CATALOG_FETCH_TIMEOUT_MS=10000;
const COMPONENT_READY_TIMEOUT_MS=5000;
const DOCUMENT_ID_PATTERN=/^[a-z0-9][a-z0-9-]*$/;
const AI_PROFILE_TIMEOUT_MS=3000;
const SYSTEM_PROMPT_TIMEOUT_MS=5000;
const MAX_SEARCH_RESULTS=48;
const NAVIGATION=Object.freeze([
    Object.freeze({label:'Home',href:`${APP_ENTRY_URL}#/home`,route:'home'}),
    Object.freeze({label:'Docs',href:`${APP_ENTRY_URL}#/docs`,route:'docs'}),
    Object.freeze({label:'Components',href:`${APP_ENTRY_URL}#/components`,route:'components'}),
    Object.freeze({label:'Tests',href:`${APP_ENTRY_URL}#/tests`,route:'tests'}),
    Object.freeze({label:'Ask',href:`${APP_ENTRY_URL}#/assistant`,route:'assistant'})
]);
const SCREENSHOTS=Object.freeze([
    Object.freeze({file:'htmlimportExample.png',title:'HTML Import',description:'Imported component lifecycle and shadow boundary.'}),
    Object.freeze({file:'modalExample.png',title:'Modal',description:'Focused modal interaction and confirmation surface.'}),
    Object.freeze({file:'navExample.png',title:'Navigation',description:'Desktop navigation state.'}),
    Object.freeze({file:'navExampleMobile.png',title:'Navigation on mobile',description:'Responsive navigation state.'}),
    Object.freeze({file:'chatExample.png',title:'Chat',description:'Conversation component with visible roles.'}),
    Object.freeze({file:'dbopfsExample.png',title:'DBOPFS',description:'Earlier origin-private storage example.'})
]);

const elements={
    appBar:document.querySelector('#appBar'),
    assistant:document.querySelector('#docsAssistant'),
    assistantContext:document.querySelector('#assistantContext'),
    assistantMessages:document.querySelector('#assistantMessages'),
    assistantProvider:document.querySelector('#assistantProvider'),
    calculatorSpecimen:document.querySelector('#calculatorSpecimen'),
    catalogStatus:document.querySelector('#catalogStatus'),
    catalogSummary:document.querySelector('#catalogSummary'),
    documentResults:document.querySelector('#documentResults'),
    documentSearchForm:document.querySelector('#documentSearchForm'),
    documentSearchInput:document.querySelector('#documentSearchInput'),
    documentViewer:document.querySelector('#documentViewer'),
    homeSearchForm:document.querySelector('#homeSearchForm'),
    homeSearchInput:document.querySelector('#homeSearchInput'),
    markdownSpecimen:document.querySelector('#markdownSpecimen'),
    mainContent:document.querySelector('#mainContent'),
    progressSpecimen:document.querySelector('#progressSpecimen'),
    remoteConsent:document.querySelector('#remoteConsent'),
    remoteConsentLabel:document.querySelector('#remoteConsentLabel'),
    resultCount:document.querySelector('#resultCount'),
    runTests:document.querySelector('#runTests'),
    screenshotGallery:document.querySelector('#screenshotGallery'),
    summarySpecimen:document.querySelector('#summarySpecimen'),
    testResults:document.querySelector('#testResults'),
    testRunStatus:document.querySelector('#testRunStatus'),
    testSummary:document.querySelector('#testSummary'),
    views:Array.from(document.querySelectorAll('[data-view]'))
};

let aiProfile=null;
let browserTests=null;
let cache=null;
let cacheState='unavailable';
let catalog=null;
let chatSession=null;
let selectedDocumentId='';
let systemPrompt='';
let routeSequence=0;

bindEvents();
await initialize();

async function initialize(){
    renderScreenshots();
    const componentPromise=initializeComponents();
    const [catalogResult,promptResult,profileResult]=await Promise.allSettled([
        initializeCatalog(),
        loadSystemPrompt(),
        loadAIProfile()
    ]);
    await componentPromise;

    if(promptResult.status==='fulfilled')systemPrompt=promptResult.value;
    if(profileResult.status==='fulfilled')aiProfile=profileResult.value;

    if(catalogResult.status==='fulfilled'){
        catalog=catalogResult.value;
        renderCatalog('');
        renderCatalogSummary();
        elements.appBar.setStatus?.(`${catalog.size} verified public documents`,'success');
        browserTests=createBrowserTests();
        configureAssistant();
        route();
        scheduleCatalogCache();
    }else{
        const message=errorMessage(catalogResult.reason,'The public document catalog could not be loaded.');
        elements.catalogStatus.textContent=message;
        elements.documentViewer.fail?.(catalogResult.reason);
        elements.appBar.setStatus?.('Catalog unavailable','error');
        configureAssistant();
        renderCatalogSummary();
        route();
    }
}

function bindEvents(){
    window.addEventListener('hashchange',route);
    elements.documentSearchForm.addEventListener('submit',event=>event.preventDefault());
    elements.documentSearchInput.addEventListener('input',()=>renderCatalog(elements.documentSearchInput.value));
    elements.homeSearchForm.addEventListener('submit',event=>{
        event.preventDefault();
        const query=elements.homeSearchInput.value.trim();
        elements.documentSearchInput.value=query;
        location.hash='#/docs';
        renderCatalog(query);
        requestAnimationFrame(()=>elements.documentSearchInput.focus());
    });
    elements.documentViewer.addEventListener('markdown-document-navigate',navigateFromMarkdown);
    elements.runTests.addEventListener('click',runBrowserTests);
    elements.assistant.addEventListener('assistant-send',sendAssistantMessage);
    elements.assistant.addEventListener('assistant-clear',clearAssistant);
}

async function initializeComponents(){
    const wait=options=>waitForComponent(options.element,{
        ...options.contract,
        errorEvent:'html-import-error',
        timeoutMs:COMPONENT_READY_TIMEOUT_MS
    });
    const components=[
        {element:elements.appBar,label:'Primary navigation',contract:{methods:['setActiveRoute','setNavigation','setStatus'],property:'ready',event:'app-bar-ready'}},
        {element:elements.catalogSummary,label:'Catalog summary',contract:{methods:['configure','setItems'],event:'summary-strip-ready'}},
        {element:elements.documentViewer,label:'Document viewer',contract:{methods:['configure','load','render','fail','focusFragment'],property:'ready',event:'markdown-document-ready'}},
        {element:elements.calculatorSpecimen,label:'Calculator specimen',contract:{methods:['calculate'],property:'ready',event:'calculator-ready'}},
        {element:elements.summarySpecimen,label:'Summary specimen',contract:{methods:['configure','setItems'],event:'summary-strip-ready'}},
        {element:elements.progressSpecimen,label:'Progress specimen',contract:{methods:['configure','setTasks'],event:'task-progress-ready'}},
        {element:elements.markdownSpecimen,label:'Markdown specimen',contract:{methods:['configure','render'],property:'ready',event:'markdown-document-ready'}},
        {element:elements.testSummary,label:'Test summary',contract:{methods:['configure','setItems'],event:'summary-strip-ready'}},
        {element:elements.assistant,label:'Assistant',contract:{methods:['open','setState','scrollToEnd'],property:'ready',event:'assistant-ready'}}
    ];
    const results=await Promise.allSettled(components.map(wait));
    results.forEach((result,index)=>{
        if(result.status==='rejected')renderComponentFailure(components[index]);
    });

    elements.appBar.setNavigation?.(NAVIGATION);
    elements.catalogSummary.configure?.({ariaLabel:'Public documentation summary'});
    elements.documentViewer.configure?.({
        labels:{
            content:'Documentation',
            tableOfContents:'On this page',
            loading:'Loading and verifying this document…',
            empty:'Choose a document from the catalog.',
            error:'This document could not be displayed.'
        },
        showTableOfContents:true
    });
    elements.summarySpecimen.configure?.({ariaLabel:'Example build summary'});
    elements.summarySpecimen.setItems?.([
        {id:'shared',value:'Shared',label:'Mechanism',detail:'Reusable behavior stays under arcane/.',status:'success'},
        {id:'theme',value:'Inherited',label:'Theme',detail:'User appearance remains the base.',status:'success'},
        {id:'policy',value:'Injected',label:'Policy',detail:'The parent app owns business decisions.',status:'review'}
    ]);
    elements.progressSpecimen.configure?.({
        title:'Package verification',
        description:'A static specimen of a completed deterministic build.'
    });
    elements.progressSpecimen.setTasks?.([
        {id:'inventory',name:'Validate positive inventory',message:'Only declared files accepted.',status:'complete'},
        {id:'hashes',name:'Verify content hashes',message:'Catalog and sources match.',status:'complete'},
        {id:'publish',name:'Publish immutable artifact',message:'Ready for deployment.',status:'complete'}
    ]);
    elements.markdownSpecimen.configure?.({showTableOfContents:false});
    elements.markdownSpecimen.render?.([
        '# Safe Markdown',
        '',
        'This live component uses Arcane\'s bundled **Marked** parser and a positive sanitizer.',
        '',
        '- Deterministic heading identifiers',
        '- Source-relative links',
        '- Loading, empty, ready, and error states',
        '',
        '```js',
        'viewer.render(markdown, {sourceURL});',
        '```'
    ].join('\n'));
    elements.testSummary.configure?.({ariaLabel:'Browser test summary'});
    elements.testSummary.setItems?.([]);
    renderAssistantHistory();
}

function renderComponentFailure({element,label}){
    element.dataset.componentState='error';
    const status=document.createElement('p');
    status.setAttribute('part','error');
    status.setAttribute('role','status');
    status.textContent=`${label} could not be loaded. Other available parts of Arcane Docs remain usable.`;
    element.shadowRoot?.replaceChildren(status);
}

async function initializeCatalog(){
    try{
        cache=new ScopedOPFSCache({
            applicationId:'docs',
            namespace:CACHE_NAMESPACE,
            maxEntryBytes:2*1024*1024
        });
        cacheState='ready';
    }catch{
        cache=null;
        cacheState='unavailable';
    }

    let manifest;
    try{
        manifest=await runAsyncBoundary(async signal=>{
            const response=await fetch(CATALOG_URL,{
                cache:'no-store',
                headers:{Accept:'application/json'},
                signal
            });
            if(!response.ok)throw new Error(`Catalog request failed (${response.status}).`);
            return response.json();
        },{timeoutMs:CATALOG_FETCH_TIMEOUT_MS});
    }catch(error){
        if(error?.code==='ASYNC_BOUNDARY_TIMEOUT')throw new Error('The public document catalog request timed out.');
        throw error;
    }
    return new StaticDocumentCatalog(manifest,{
        baseURL:new URL(CATALOG_BASE_URL,document.baseURI).href,
        cache,
        maxResults:MAX_SEARCH_RESULTS,
        maxContextDocuments:6,
        maxContextCharacters:24000,
        maxDocumentContextCharacters:6000,
        onCacheError:()=>{
            cacheState='degraded';
            renderCatalogSummary();
        }
    });
}

function renderCatalog(query=''){
    if(!catalog)return;
    const normalized=String(query||'').trim();
    const records=catalog.search(normalized,{limit:MAX_SEARCH_RESULTS});
    const fragment=document.createDocumentFragment();

    for(const record of records){
        const link=document.createElement('a');
        const title=document.createElement('span');
        const summary=document.createElement('span');
        const metadata=document.createElement('span');
        const kind=document.createElement('span');
        const tags=document.createElement('span');
        link.className='document-result';
        link.href=`${APP_ENTRY_URL}#/docs/${encodeURIComponent(record.id)}`;
        link.dataset.documentId=record.id;
        if(record.id===selectedDocumentId)link.setAttribute('aria-current','page');
        title.className='document-result__title';
        title.textContent=record.title;
        summary.className='document-result__summary';
        summary.textContent=record.summary||'Public Arcane documentation.';
        metadata.className='document-result__meta';
        kind.textContent=record.kind;
        tags.textContent=record.tags.slice(0,3).join(' · ');
        metadata.append(kind);
        if(tags.textContent)metadata.append(tags);
        link.append(title,summary,metadata);
        fragment.append(link);
    }

    if(!records.length){
        const empty=document.createElement('p');
        empty.className='arcane-state arcane-state--empty';
        empty.textContent='No public documents match this search.';
        fragment.append(empty);
    }
    elements.documentResults.replaceChildren(fragment);
    elements.resultCount.textContent=String(records.length);
    elements.resultCount.setAttribute('aria-label',`${records.length} document${records.length===1?'':'s'}`);
    elements.catalogStatus.textContent=normalized
        ?`${records.length} result${records.length===1?'':'s'} for “${normalized}”. Search stays in this browser.`
        :`${records.length} public documents. Select one to verify and render it.`;
}

function renderCatalogSummary(){
    if(typeof elements.catalogSummary?.setItems!=='function')return;
    const storage={
        ready:{value:'Scoped OPFS',detail:'Verified public documents are cached in an Arcane Docs-only directory.',status:'success'},
        caching:{value:'Caching',detail:'The reviewed public corpus is being stored for faster local retrieval.',status:'warning'},
        complete:{value:'Cached',detail:'The reviewed public corpus is available to local retrieval.',status:'success'},
        degraded:{value:'Network fallback',detail:'A cache operation failed; verified network hydration remains available.',status:'warning'},
        unavailable:{value:'Memory only',detail:'OPFS is unavailable; search still works from the published manifest.',status:'warning'}
    }[cacheState]||{value:'Memory only',detail:'No persistent cache is active.',status:'warning'};
    const aiReady=assistantReady();
    elements.catalogSummary.setItems([
        {id:'documents',value:String(catalog?.size||0),label:'Public documents',detail:'Positive allowlist; exact byte size and SHA-256 verified.',status:catalog?'success':'warning'},
        {id:'components',value:'4',label:'Live specimens',detail:'Loaded from the shared Arcane runtime.',status:'success'},
        {id:'storage',value:storage.value,label:'Catalog cache',detail:storage.detail,status:storage.status},
        {id:'assistant',value:aiReady?'Available':'Local search',label:'Assistant mode',detail:aiReady?'Uses the current Arcane AI profile with bounded public excerpts.':'No complete Arcane AI bridge is exposed to this page.',status:aiReady?'success':'review'}
    ]);
}

async function route(){
    const sequence=++routeSequence;
    if(location.hash==='#mainContent'){
        requestAnimationFrame(()=>elements.mainContent.focus({preventScroll:true}));
        return;
    }
    const parsed=parseRoute(location.hash);
    elements.views.forEach(view=>{view.hidden=view.dataset.view!==parsed.view});
    elements.appBar?.setActiveRoute?.(parsed.view);
    document.title=`${viewTitle(parsed.view)} · Arcane OS Docs`;
    if(parsed.view==='docs'){
        const id=parsed.documentId||selectedDocumentId||'provision-user';
        if(catalogRecord(id)){
            await openDocument(id);
            if(sequence!==routeSequence)return;
            if(parsed.fragment&&elements.documentViewer.focusFragment?.(parsed.fragment))return;
        }else if(catalog&&(parsed.invalidDocument||parsed.documentId)){
            selectedDocumentId='';
            elements.documentViewer.clear?.();
            renderCatalog(elements.documentSearchInput.value);
            elements.catalogStatus.textContent='No public document matches this address. Choose a document from the catalog.';
        }
    }
    if(parsed.view==='assistant')elements.assistant.open?.({focus:false});
    document.querySelector(`[data-view="${parsed.view}"] h1`)?.setAttribute('tabindex','-1');
    requestAnimationFrame(()=>document.querySelector(`[data-view="${parsed.view}"] h1`)?.focus({preventScroll:true}));
}

function parseRoute(hash=''){
    const source=String(hash||'').replace(/^#\/?/,'');
    const [viewPart='',...rest]=source.split('/');
    const view=['home','docs','components','tests','assistant'].includes(viewPart)?viewPart:'home';
    let documentId='';
    let fragment='';
    let invalidDocument=false;
    if(view==='docs'&&rest[0]){
        try{
            documentId=decodeURIComponent(rest[0]);
            if(!DOCUMENT_ID_PATTERN.test(documentId)){
                documentId='';
                invalidDocument=true;
            }
        }catch{
            invalidDocument=true;
        }
        if(rest[1]){
            try{fragment=decodeURIComponent(rest[1])}catch{fragment=''}
        }
    }
    return {view,documentId,fragment,invalidDocument};
}

function viewTitle(view){
    return {home:'Home',docs:'Documentation',components:'Components',tests:'Browser tests',assistant:'Assistant'}[view]||'Home';
}

async function openDocument(id){
    if(!catalogRecord(id))return;
    selectedDocumentId=id;
    renderCatalog(elements.documentSearchInput.value);
    elements.documentResults.querySelector(`[data-document-id="${CSS.escape(id)}"]`)?.setAttribute('aria-current','page');
    if(typeof elements.documentViewer.load!=='function'){
        elements.catalogStatus.textContent='The document viewer component is unavailable. The searchable catalog remains available.';
        return;
    }
    await elements.documentViewer.load(async()=>{
        const hydrated=await catalog.hydrate(id);
        return {markdown:hydrated.text,sourceURL:hydrated.url};
    });
}

function catalogRecord(id){
    if(!catalog||typeof id!=='string'||!DOCUMENT_ID_PATTERN.test(id))return null;
    try{return catalog.get(id)||null}catch{return null}
}

function navigateFromMarkdown(event){
    if(event.detail?.kind!=='markdown'||!catalog)return;
    let target;
    try{
        target=new URL(String(event.detail.targetURL||''));
        target.hash='';
    }catch{
        return;
    }
    const record=catalog.list().find(item=>new URL(item.path,new URL(CATALOG_BASE_URL,document.baseURI)).href===target.href);
    if(record){
        event.preventDefault();
        const fragment=String(event.detail.fragment||'');
        location.hash=`#/docs/${encodeURIComponent(record.id)}${fragment?`/${encodeURIComponent(fragment)}`:''}`;
        return;
    }
    const repositoryURL=repositorySourceURL(target,event.detail.fragment);
    if(repositoryURL){
        event.preventDefault();
        const opened=globalThis.open(repositoryURL,'_blank','noopener,noreferrer');
        elements.catalogStatus.textContent=opened
            ?'Opened this non-catalog source in the Arcane OS repository.'
            :'This source is outside the public catalog. Use “View repository” to open it.';
    }
}

function repositorySourceURL(target,fragment=''){
    const documentsBase=new URL('documents/',new URL(CATALOG_BASE_URL,document.baseURI));
    if(target.origin!==documentsBase.origin||!target.pathname.startsWith(documentsBase.pathname))return '';
    let relativePath;
    try{relativePath=decodeURIComponent(target.pathname.slice(documentsBase.pathname.length))}catch{return ''}
    const segments=relativePath.split('/');
    if(!segments.length||segments.some(segment=>!segment||segment==='.'||segment==='..'||/[\\\0]/u.test(segment)))return '';
    if(!/\.(?:md|markdown)$/i.test(segments.at(-1)))return '';
    const repositoryURL=new URL(segments.map(encodeURIComponent).join('/'),REPOSITORY_FILE_URL);
    if(fragment)repositoryURL.hash=String(fragment).slice(0,256);
    return repositoryURL.href;
}

function renderScreenshots(){
    const fragment=document.createDocumentFragment();
    for(const item of SCREENSHOTS){
        const figure=document.createElement('figure');
        const image=document.createElement('img');
        const caption=document.createElement('figcaption');
        const title=document.createElement('strong');
        const description=document.createElement('span');
        figure.className='screenshot-card arcane-card';
        image.src=`./apps/docs/screenshots/${item.file}`;
        image.alt=`Arcane ${item.title} component example`;
        image.loading='lazy';
        image.decoding='async';
        title.textContent=item.title;
        description.textContent=item.description;
        caption.append(title,description);
        figure.append(image,caption);
        fragment.append(figure);
    }
    elements.screenshotGallery.replaceChildren(fragment);
}

function scheduleCatalogCache(){
    if(!catalog||!cache)return;
    const start=()=>prewarmCatalog().catch(()=>{});
    if(typeof requestIdleCallback==='function')requestIdleCallback(start,{timeout:2500});
    else setTimeout(start,250);
}

async function prewarmCatalog(){
    cacheState='caching';
    renderCatalogSummary();
    let failures=0;
    for(const record of catalog.list()){
        try{
            await catalog.hydrate(record.id);
        }catch{
            failures++;
        }
    }
    cacheState=failures?'degraded':'complete';
    renderCatalogSummary();
}

function createBrowserTests(){
    return new BrowserTestSuite({
        timeoutMs:10000,
        tests:[
            {
                id:'catalog-integrity',
                name:'Catalog documents verify before rendering',
                async run({assert}){
                    assert(catalog.size>=12,'The public catalog should contain the initial documentation set.');
                    const hydrated=await catalog.hydrate('provision-user',{bypassCache:true});
                    assert(hydrated.text.includes('Activate this account'),'The provisioning guide did not contain its separate activation step.');
                    return {status:'pass',message:`Verified ${hydrated.record.title} from ${hydrated.source}.`};
                }
            },
            {
                id:'project-paths',
                name:'Project-site paths remain under the deployed base',
                run({assert,skip}){
                    if(typeof elements.markdownSpecimen.render!=='function')skip('The Markdown specimen component is unavailable.');
                    const base=new URL(document.baseURI);
                    const catalogURL=new URL(CATALOG_URL,document.baseURI);
                    assert(catalogURL.origin===base.origin,'The catalog resolved to a different origin.');
                    assert(catalogURL.pathname.startsWith(base.pathname),'The catalog escaped the GitHub Pages project path.');
                    return {status:'pass',message:`Resolved under ${base.pathname}`};
                }
            },
            {
                id:'markdown-safety',
                name:'Markdown rendering removes executable markup',
                run({assert}){
                    elements.markdownSpecimen.render('# Safety\n\n<img src="x" onerror="globalThis.__arcaneUnsafe=true"><script>globalThis.__arcaneUnsafe=true</script>');
                    assert(!elements.markdownSpecimen.shadowRoot.querySelector('script'),'A script element remained after rendering.');
                    assert(!elements.markdownSpecimen.shadowRoot.querySelector('[onerror]'),'An event-handler attribute remained after rendering.');
                    assert(globalThis.__arcaneUnsafe!==true,'Untrusted Markdown executed code.');
                    elements.markdownSpecimen.render('# Safe Markdown\n\nExecutable markup was removed by the allowlist.');
                    return {status:'pass',message:'Executable elements and event attributes were absent.'};
                }
            },
            {
                id:'component-readiness',
                name:'Shared component readiness contracts are complete',
                run({assert}){
                    const components=[elements.appBar,elements.documentViewer,elements.calculatorSpecimen,elements.summarySpecimen,elements.progressSpecimen,elements.markdownSpecimen];
                    assert(components.every(component=>component.ready===true),'At least one shared component was not ready.');
                    return {status:'pass',message:`${components.length} shared components reported persistent readiness.`};
                }
            },
            {
                id:'scoped-storage',
                name:'Catalog cache is exact-key and docs-scoped',
                async run({assert,skip}){
                    if(!cache)skip('OPFS is unavailable in this browser.');
                    assert(cache.applicationId==='docs','The cache selected an unexpected application scope.');
                    assert(cache.namespace===CACHE_NAMESPACE,'The cache selected an unexpected OPFS namespace.');
                    await cache.set('browser-test-record',{schemaVersion:1,value:'ok'});
                    assert((await cache.get('browser-test-record'))?.value==='ok','The exact-key cache round trip failed.');
                    await cache.delete('browser-test-record');
                    return {status:'pass',message:`Used only apps/docs/${CACHE_NAMESPACE}.`};
                }
            },
            {
                id:'ai-boundary',
                name:'AI remains unavailable without a complete Arcane profile',
                run({assert}){
                    if(assistantReady()){
                        assert(profileProviderId(aiProfile),'The available assistant must bind a named provider.');
                        assert(typeof aiProfile.local==='boolean','The available assistant must disclose provider locality.');
                        return {status:'pass',message:'A complete host-configured provider boundary is available.'};
                    }
                    assert(chatSession===null,'A chat session existed without a complete host-configured provider.');
                    return {status:'pass',message:'No provider request can run in ordinary GitHub Pages mode.'};
                }
            }
        ]
    });
}

async function runBrowserTests(){
    if(!browserTests||browserTests.running)return;
    elements.runTests.disabled=true;
    elements.testRunStatus.textContent='Running';
    elements.testRunStatus.dataset.status='warning';
    elements.testResults.replaceChildren(stateItem('Running trusted browser checks…'));
    try{
        const summary=await browserTests.run();
        renderTestSummary(summary);
        renderTestResults(summary);
    }catch(error){
        elements.testRunStatus.textContent='Unable to run';
        elements.testRunStatus.dataset.status='error';
        elements.testResults.replaceChildren(stateItem(errorMessage(error,'The browser checks could not start.'),'error'));
    }finally{
        elements.runTests.disabled=false;
    }
}

function renderTestSummary(summary){
    elements.testSummary.setItems?.([
        {id:'passed',value:String(summary.totals.pass),label:'Passed',detail:'Trusted checks completed successfully.',status:'success'},
        {id:'failed',value:String(summary.totals.fail),label:'Failed',detail:'Review each failed boundary below.',status:summary.totals.fail?'error':'success'},
        {id:'skipped',value:String(summary.totals.skip),label:'Skipped',detail:'Unavailable browser capabilities are reported, not hidden.',status:summary.totals.skip?'warning':'success'},
        {id:'duration',value:`${Math.round(summary.durationMs)} ms`,label:'Duration',detail:'Sequential bounded execution.',status:'review'}
    ]);
    elements.testRunStatus.textContent=summary.status==='pass'?'Passed':summary.status==='fail'?'Failed':summary.status==='aborted'?'Aborted':'Skipped';
    elements.testRunStatus.dataset.status=summary.status==='pass'?'success':summary.status==='fail'?'error':'warning';
}

function renderTestResults(summary){
    const fragment=document.createDocumentFragment();
    for(const result of summary.results){
        const item=document.createElement('li');
        const mark=document.createElement('span');
        const copy=document.createElement('span');
        const name=document.createElement('strong');
        const message=document.createElement('span');
        const duration=document.createElement('span');
        item.className='test-result';
        item.dataset.status=result.status;
        mark.className='test-result__mark';
        mark.textContent={pass:'✓',fail:'×',skip:'–'}[result.status]||'·';
        mark.setAttribute('aria-hidden','true');
        copy.className='test-result__copy';
        name.textContent=result.name;
        message.textContent=`${result.status.toUpperCase()}: ${result.message}`;
        copy.append(name,message);
        duration.className='test-result__duration';
        duration.textContent=`${Math.round(result.durationMs)} ms`;
        item.append(mark,copy,duration);
        fragment.append(item);
    }
    elements.testResults.replaceChildren(fragment);
}

function stateItem(message,status='empty'){
    const item=document.createElement('li');
    item.className=`arcane-state arcane-state--${status}`;
    item.textContent=message;
    return item;
}

async function loadSystemPrompt(){
    return runAsyncBoundary(async signal=>{
        const response=await fetch('./apps/docs/prompts/system.md',{
            cache:'no-store',
            signal
        });
        if(!response.ok)throw new Error(`Assistant instructions could not be loaded (${response.status}).`);
        return response.text();
    },{timeoutMs:SYSTEM_PROMPT_TIMEOUT_MS});
}

async function loadAIProfile(){
    const profile=globalThis.Arcane?.ai?.profile;
    if(typeof profile!=='function')return null;
    try{
        return await runAsyncBoundary(
            ()=>profile.call(globalThis.Arcane.ai),
            {timeoutMs:AI_PROFILE_TIMEOUT_MS}
        );
    }catch{
        return null;
    }
}

function configureAssistant(){
    const provider=profileProviderLabel(aiProfile);
    const model=profileModelLabel(aiProfile);
    if(typeof elements.assistant.setState!=='function'){
        chatSession=null;
        elements.assistantProvider.textContent='The assistant component is unavailable. Documentation search remains local and available.';
        elements.remoteConsentLabel.hidden=true;
        renderCatalogSummary();
        return;
    }
    if(!assistantReady()){
        chatSession=null;
        elements.assistantProvider.textContent='No complete host-configured Arcane AI bridge is available. GitHub Pages stays in local-search mode.';
        elements.remoteConsentLabel.hidden=true;
        elements.assistant.setState('error','AI is unavailable here. Use documentation search, or open this app in a compatible Arcane host with a configured provider.');
        renderCatalogSummary();
        return;
    }
    const label=[provider,model,aiProfile.local?'local':'cloud'].filter(Boolean).join(' · ');
    elements.assistantProvider.textContent=`Configured provider: ${label}.`;
    elements.remoteConsentLabel.hidden=aiProfile.local===true;
    elements.remoteConsent.checked=false;
    chatSession=new ConfiguredAIChatSession({
        systemPrompt,
        request:{expectedProvider:profileProviderId(aiProfile)},
        contextBuilder:async({input})=>{
            const context=await catalog.buildContext(input,{
                bodySearch:true,
                limit:6,
                maxCharacters:24000,
                maxDocumentCharacters:6000,
                scanLimit:Math.min(catalog.size,100)
            });
            elements.assistantContext.textContent=context.documents.length
                ?`Attached ${context.documents.length} verified public excerpt${context.documents.length===1?'':'s'}${context.truncated?' (bounded)':''}.`
                :'No matching document excerpt was attached.';
            return context.text;
        }
    });
    elements.assistant.setState('empty','Ask about the published Arcane OS documentation.');
    renderCatalogSummary();
}

function assistantReady(){
    return Boolean(
        catalog
        &&systemPrompt
        &&profileProviderId(aiProfile)
        &&aiProfile?.configured===true
        &&typeof aiProfile?.local==='boolean'
        &&typeof globalThis.Arcane?.ai?.chat==='function'
    );
}

async function sendAssistantMessage(event){
    const message=String(event.detail?.message||'').trim();
    if(!message)return;
    if(!assistantReady()||!chatSession){
        event.preventDefault();
        elements.assistant.setState('error','No complete configured Arcane AI provider is available. Nothing was sent.');
        return;
    }
    if(aiProfile.local===false&&!elements.remoteConsent.checked){
        event.preventDefault();
        elements.assistant.setState('error','Review the cloud-provider disclosure and confirm it before sending public excerpts.');
        elements.remoteConsent.focus();
        return;
    }
    elements.assistant.setState('pending','Retrieving verified public excerpts and contacting the configured Arcane AI…');
    try{
        await chatSession.send(message);
        renderAssistantHistory();
        elements.assistant.setState('ready');
    }catch(error){
        if(error?.code==='AI_PROVIDER_CHANGED'){
            aiProfile=await loadAIProfile();
            configureAssistant();
            elements.assistant.setState('error','The configured provider changed. Review the updated disclosure and retry.');
            return;
        }
        elements.assistant.setState('error',errorMessage(error,'The configured Arcane AI could not answer.'));
    }
}

function clearAssistant(event){
    try{
        chatSession?.clear();
        elements.assistantMessages.replaceChildren();
        elements.assistantContext.textContent='Catalog context has not been requested.';
        elements.assistant.setState(chatSession?'empty':'error',chatSession?'Ask about the published Arcane OS documentation.':'AI is unavailable here.');
    }catch(error){
        event.preventDefault();
        elements.assistant.setState('error',errorMessage(error,'Wait for the current request to finish.'));
    }
}

function renderAssistantHistory(){
    const history=chatSession?.history?.()||[];
    const visible=history.filter(item=>['user','assistant'].includes(item.role));
    const fragment=document.createDocumentFragment();
    for(const message of visible){
        const item=document.createElement('li');
        const role=document.createElement('span');
        const content=document.createElement('p');
        item.className='chat-message';
        item.dataset.role=message.role;
        role.className='chat-message__role';
        role.textContent=message.role==='assistant'?'Arcane Docs':'You';
        content.className='chat-message__content';
        content.textContent=message.content;
        item.append(role,content);
        fragment.append(item);
    }
    elements.assistantMessages.replaceChildren(fragment);
    elements.assistant?.scrollToEnd?.({behavior:'auto'});
}

function profileProviderId(profile){
    const provider=firstDefined(profile?.provider?.id,typeof profile?.provider==='string'?profile.provider:null,profile?.defaultProvider);
    return typeof provider==='string'?provider.trim().toLowerCase().slice(0,128):'';
}

function profileProviderLabel(profile){
    const provider=firstDefined(profile?.provider?.name,profile?.provider?.id,typeof profile?.provider==='string'?profile.provider:null,profile?.defaultProvider);
    return typeof provider==='string'?provider.trim().slice(0,128):'';
}

function profileModelLabel(profile){
    const model=firstDefined(profile?.model?.name,profile?.model?.id,profile?.model,profile?.defaultModel);
    return typeof model==='string'?model.trim().slice(0,256):'';
}

function firstDefined(...values){
    return values.find(value=>value!==undefined&&value!==null&&value!=='');
}

function errorMessage(error,fallback){
    return String(error?.message||fallback).replace(/[\u0000-\u001f\u007f]+/g,' ').slice(0,1000);
}
