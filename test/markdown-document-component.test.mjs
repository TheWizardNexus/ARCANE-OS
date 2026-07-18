import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const componentURL=new URL(
    '../arcane/components/markdown-document.html',
    import.meta.url
);
const exampleURL=new URL(
    '../example/component_markdown_document/index.html',
    import.meta.url
);
const exampleReadmeURL=new URL(
    '../example/component_markdown_document/README.md',
    import.meta.url
);

async function componentSource(){
    return readFile(componentURL,'utf8');
}

function moduleScript(source=''){
    const script=source.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script,'markdown document module script is missing');
    return script;
}

function loadPolicy(script=''){
    const block=script.match(
        /\/\/ BEGIN MARKDOWN_DOCUMENT_POLICY([\s\S]*?)\/\/ END MARKDOWN_DOCUMENT_POLICY/
    )?.[1];
    assert.ok(block,'markdown document policy block is missing');

    const context={URL};
    vm.runInNewContext(
        `${block}
        globalThis.policy={
            allowedAttributes:markdownDocumentAllowedAttributes,
            assetURL:markdownDocumentAssetURL,
            elementAllowed:markdownDocumentElementAllowed,
            linkPolicy:markdownDocumentLinkPolicy,
            nextHeadingIdentifier:markdownDocumentNextHeadingIdentifier,
            sourceURL:markdownDocumentSourceURL
        };`,
        context
    );
    return context.policy;
}

test('markdown document component compiles and exposes its stable host contract',async()=>{
    const source=await componentSource();
    const script=moduleScript(source);
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;

    assert.doesNotThrow(()=>new AsyncFunction(script));
    for(const marker of [
        'host.clear=clear',
        'host.configure=configure',
        'host.fail=fail',
        'host.focus=focusDocument',
        'host.focusFragment=focusFragment',
        'host.load=load',
        'host.render=render',
        'sourceURL:{get:()=>currentSourceURL,set:setSourceURL}',
        'state:{get:()=>state}',
        'tableOfContents:{get:()=>tableOfContents.map',
        'value:{get:()=>currentMarkdown,set:value=>render(value)}'
    ]){
        assert.ok(script.includes(marker),`Missing public contract marker: ${marker}`);
    }
});

test('positive element and attribute policy rejects active and custom markup',async()=>{
    const policy=loadPolicy(moduleScript(await componentSource()));

    for(const tag of ['p','h1','a','img','table','code']){
        assert.equal(policy.elementAllowed(tag),true,`${tag} should be allowed`);
    }
    for(const tag of [
        'script','style','iframe','object','form','input','svg','math',
        'html-import','custom-widget'
    ]){
        assert.equal(policy.elementAllowed(tag),false,`${tag} should be rejected`);
    }

    assert.deepEqual(Array.from(policy.allowedAttributes('A')),['href','title']);
    assert.deepEqual(Array.from(policy.allowedAttributes('IMG')),['alt','src','title']);
    assert.deepEqual(Array.from(policy.allowedAttributes('SCRIPT')),[]);
});

test('link policy rejects unsafe protocols and resolves nested Markdown routes',async()=>{
    const policy=loadPolicy(moduleScript(await componentSource()));
    const origin='https://docs.example';
    const sourceURL='https://docs.example/ARCANE-OS/content/guides/setup/start.md';

    for(const href of [
        'javascript:alert(1)',
        'java\nscript:alert(1)',
        'vbscript:msgbox(1)',
        'data:text/html,unsafe',
        'blob:https://docs.example/id',
        'file:///tmp/private.md',
        'ftp://docs.example/file.md'
    ]){
        assert.equal(policy.linkPolicy(href,sourceURL,origin),null,href);
    }

    const nested=policy.linkPolicy(
        '../../reference/theme.md#dark-mode',
        sourceURL,
        origin
    );
    assert.equal(nested.kind,'markdown');
    assert.equal(
        nested.targetURL,
        'https://docs.example/ARCANE-OS/content/reference/theme.md#dark-mode'
    );
    assert.equal(nested.fragment,'dark-mode');

    const external=policy.linkPolicy(
        'https://github.com/example/project',
        sourceURL,
        origin
    );
    assert.equal(external.kind,'link');
    assert.equal(external.external,true);
});

test('asset policy allows only source-relative same-origin HTTP assets',async()=>{
    const policy=loadPolicy(moduleScript(await componentSource()));
    const origin='https://docs.example';
    const sourceURL='https://docs.example/ARCANE-OS/content/guides/start.md';

    assert.equal(
        policy.assetURL('../images/component.png',sourceURL,origin),
        'https://docs.example/ARCANE-OS/content/images/component.png'
    );
    for(const src of [
        'https://tracker.example/pixel.png',
        '//tracker.example/pixel.png',
        'data:image/png;base64,AAAA',
        'blob:https://docs.example/id',
        'file:///private.png',
        'https://user:secret@docs.example/private.png'
    ]){
        assert.equal(policy.assetURL(src,sourceURL,origin),'',src);
    }
});

test('heading identifiers are deterministic and duplicate safe',async()=>{
    const policy=loadPolicy(moduleScript(await componentSource()));
    const used=new Set();

    assert.equal(policy.nextHeadingIdentifier('Overview',used),'overview');
    assert.equal(policy.nextHeadingIdentifier('Overview',used),'overview-2');
    assert.equal(policy.nextHeadingIdentifier('Overview',used),'overview-3');
    assert.equal(policy.nextHeadingIdentifier('Résumé & setup',used),'resume-and-setup');
    assert.equal(policy.nextHeadingIdentifier('***',used),'section');
    assert.equal(policy.nextHeadingIdentifier('***',used),'section-2');
});

test('rendering applies MD.safeRendered before the detached positive sanitizer',async()=>{
    const source=await componentSource();
    const script=moduleScript(source);
    const sharedPass=script.indexOf('const safeRendered=new MD(markdown).safeRendered');
    const strictPass=script.indexOf('strictMarkdownFragment(safeRendered,sourceURL)');

    assert.ok(sharedPass>=0,'shared MD.safeRendered pass is missing');
    assert.ok(strictPass>sharedPass,'positive sanitizer must follow MD.safeRendered');
    assert.match(script,/template\.innerHTML=html/);
    assert.match(script,/if\(!markdownDocumentElementAllowed\(name\)\)\{[\s\S]*?element\.remove\(\)/);
    assert.match(script,/element\.removeAttribute\(attribute\.name\)/);
    assert.match(script,/image\.removeAttribute\('src'\)/);
    assert.match(script,/image\.loading='lazy'/);
    assert.doesNotMatch(script,/contentElement\.innerHTML\s*=/);
    assert.doesNotMatch(script,/\beval\s*\(/);
    assert.doesNotMatch(script,/new Function\s*\(/);
});

test('component exposes observable loading, empty, error, rendered, and navigation states',async()=>{
    const source=await componentSource();
    const script=moduleScript(source);

    for(const eventName of [
        'markdown-document-state',
        'markdown-document-loading',
        'markdown-document-empty',
        'markdown-document-error',
        'markdown-document-rendered',
        'markdown-document-ready',
        'markdown-document-navigate'
    ]){
        assert.ok(script.includes(`'${eventName}'`),`Missing event ${eventName}`);
    }

    assert.match(script,/cancelable:true/);
    assert.match(script,/detail\.kind==='fragment'\|\|detail\.kind==='markdown'/);
    assert.match(script,/detail\.kind==='markdown'&&options\.onNavigate/);
    assert.match(script,/const sequence=\+\+loadSequence/);
    assert.match(script,/if\(sequence!==loadSequence\)/);

    const readyState=script.lastIndexOf('host.ready=true');
    const readyEvent=script.lastIndexOf("'markdown-document-ready'");
    assert.ok(readyState>=0&&readyState<readyEvent,'ready state must precede ready event');
});

test('component uses native document semantics and keyboard-operable links',async()=>{
    const source=await componentSource();
    const script=moduleScript(source);

    assert.match(source,/<nav[\s\S]*aria-labelledby="tableOfContentsTitle"/);
    assert.match(source,/<ol id="tableOfContentsList"><\/ol>/);
    assert.match(source,/<article[\s\S]*id="content"[\s\S]*tabindex="-1"/);
    assert.match(source,/role="status"/);
    assert.match(source,/aria-live="polite"/);
    assert.match(source,/aria-atomic="true"/);
    assert.match(source,/:focus-visible/);
    assert.match(script,/heading\.tabIndex=-1/);
    assert.match(script,/target\.focus\(\{preventScroll:true\}\)/);
    assert.match(script,/target\.scrollIntoView\(\{block:'start'\}\)/);
    assert.match(script,/documentElement\.setAttribute\('aria-busy'/);
    assert.doesNotMatch(source,/role="button"/);
});

test('synthetic example documents dual readiness, routing, theme, and state usage',async()=>{
    const [example,readme]=await Promise.all(
        [readFile(exampleURL,'utf8'),readFile(exampleReadmeURL,'utf8')]
    );

    const layout=example.indexOf('arcane/css/layout.css');
    const theme=example.indexOf('arcane/css/theme.css');
    const primitives=example.indexOf('arcane/css/primitives.css');
    assert.ok(layout>=0&&layout<theme&&theme<primitives,'theme cascade order is incorrect');
    assert.match(example,/arcane\/modules\/ThemeBootstrap\.js/);
    assert.match(example,/arcane\/modules\/HTMLImport\.js/);
    assert.match(example,/waitForComponent/);
    assert.match(example,/event:'markdown-document-ready'/);
    assert.match(example,/property:'ready'/);
    assert.match(example,/onNavigate/);
    assert.match(example,/markdown-document-navigate/);
    assert.match(example,/\.load\(/);
    assert.match(example,/\.fail\(/);
    assert.match(example,/\.clear\(/);
    assert.match(readme,/MD\.safeRendered/);
    assert.match(readme,/same-origin/i);
    assert.match(readme,/markdown-document-rendered/);
    assert.match(readme,/markdown-document-navigate/);
    assert.doesNotMatch(example,/boss|private key|api key/i);
});
