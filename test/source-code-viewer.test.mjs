import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const componentURL=new URL('../arcane/components/source-code-viewer.html',import.meta.url);
const exampleURL=new URL('../example/component_source_code_viewer/index.html',import.meta.url);
const readmeURL=new URL('../example/component_source_code_viewer/README.md',import.meta.url);

function moduleScript(source=''){
    const script=source.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script,'source-code viewer module script is missing');
    return script;
}

test('source-code viewer compiles and exposes a stable readiness contract',async()=>{
    const source=await readFile(componentURL,'utf8');
    const script=moduleScript(source);
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;

    assert.doesNotThrow(()=>new AsyncFunction(script));
    for(const marker of [
        'host.clear=clear',
        'host.configure=configure',
        'host.fail=fail',
        'host.focus=focusSource',
        'host.focusLine=focusLine',
        'host.load=load',
        'host.render=render',
        "lineCount:{get:()=>current.lineCount}",
        "sourcePath:{get:()=>current.sourcePath}",
        "state:{get:()=>state}",
        "value:{get:()=>current.text,set:value=>render(value)}"
    ])assert.ok(script.includes(marker),`Missing public contract marker: ${marker}`);

    const readyState=script.lastIndexOf('host.ready=true');
    const readyEvent=script.lastIndexOf("'source-code-viewer-ready'");
    assert(readyState>=0&&readyState<readyEvent,'ready state must precede the ready event');
});

test('source rendering uses text nodes and never parses source as markup',async()=>{
    const script=moduleScript(await readFile(componentURL,'utf8'));

    assert.match(script,/code\.textContent=line\|\|' '/);
    assert.match(script,/sourceLines\.replaceChildren\(fragment\)/);
    assert.doesNotMatch(script,/innerHTML\s*=/);
    assert.doesNotMatch(script,/insertAdjacentHTML/);
    assert.doesNotMatch(script,/\beval\s*\(/);
    assert.doesNotMatch(script,/new Function\s*\(/);
});

test('source viewer bounds input, restricts repository URLs, and supports safe line focus',async()=>{
    const source=await readFile(componentURL,'utf8');
    const script=moduleScript(source);

    assert.match(script,/const MAXIMUM_CHARACTERS=1048576/);
    assert.match(script,/const MAXIMUM_LINES=20000/);
    assert.match(script,/!\['http:','https:'\]\.includes\(url\.protocol\)/);
    assert.match(script,/url\.username\|\|url\.password/);
    assert.match(script,/item\.id=`L\$\{lineNumber\}`/);
    assert.match(script,/item\.tabIndex=-1/);
    assert.match(script,/target\.focus\(\{preventScroll:true\}\)/);
    assert.match(script,/target\.scrollIntoView\(\{block:'center',inline:'nearest'\}\)/);
});

test('source viewer exposes accessible states and Arcane theme layers',async()=>{
    const source=await readFile(componentURL,'utf8');
    const layout=source.indexOf('arcane/css/layout.css');
    const theme=source.indexOf('arcane/css/theme.css');
    const primitives=source.indexOf('arcane/css/primitives.css');

    assert(layout>=0&&layout<theme&&theme<primitives);
    assert.match(source,/role="status"/);
    assert.match(source,/aria-live="polite"/);
    assert.match(source,/aria-atomic="true"/);
    assert.match(source,/aria-busy/);
    assert.match(source,/@media \(forced-colors:active\)/);
    assert.match(source,/:focus-visible/);
    assert.match(source,/rel="noopener noreferrer"/);
    assert.match(source,/referrerpolicy="no-referrer"/);
});

test('synthetic example covers dual readiness, hostile-looking text, line focus, and state changes',async()=>{
    const [example,readme]=await Promise.all([
        readFile(exampleURL,'utf8'),
        readFile(readmeURL,'utf8')
    ]);

    assert.match(example,/ThemeBootstrap\.js/);
    assert.match(example,/HTMLImport\.js/);
    assert.match(example,/waitForComponent/);
    assert.match(example,/event:'source-code-viewer-ready'/);
    assert.match(example,/property:'ready'/);
    assert.match(example,/onerror=/);
    assert.match(example,/viewer\.focusLine\(4\)/);
    assert.match(example,/viewer\.fail\(/);
    assert.match(example,/viewer\.clear\(/);
    assert.match(readme,/textContent/);
    assert.match(readme,/forced-colors/i);
    assert.doesNotMatch(example,/api key|private key|password/i);
});
