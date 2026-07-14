import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const componentURL=new URL('../arcane/components/file-manager.html',import.meta.url);

async function source(){
    return readFile(componentURL,'utf8');
}

test('file manager inline module compiles',async()=>{
    const html=await source();
    const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;

    assert.ok(script,'file manager is missing its inline module');
    assert.doesNotThrow(()=>new AsyncFunction(script));
});

test('file manager exposes the provider tree and selection contracts',async()=>{
    const html=await source();

    for(const marker of [
        'host.loadAll=loadAll',
        'host.setProvider=setProvider',
        'host.select=select',
        'host.clearSelection=clearSelection',
        "'selectedPath'",
        "layout==='tree'",
        "activeTreeProvider().list('')",
        "activeTreeProvider().list(entry.path)"
    ]){
        assert.ok(html.includes(marker),`Missing provider-tree marker: ${marker}`);
    }

    assert.match(html,/role','treeitem/);
    assert.match(html,/aria-selected/);
    assert.match(html,/aria-expanded/);
    assert.match(html,/tabIndex=-1/);
    assert.match(html,/case 'ArrowDown'/);
    assert.match(html,/case 'ArrowUp'/);
    assert.match(html,/case 'ArrowRight'/);
    assert.match(html,/case 'ArrowLeft'/);
    assert.match(html,/case 'Home'/);
    assert.match(html,/case 'End'/);
});

test('file manager emits domain-neutral events and keeps legacy entrypoints',async()=>{
    const html=await source();

    assert.match(html,/file-manager-select/);
    assert.match(html,/file-manager-open/);
    assert.match(html,/file-manager-action/);
    assert.match(html,/file-manager-ready/);
    assert.match(html,/dataset\.openMode/);
    assert.match(html,/dataset\.hiddenPrefixes/);
    assert.match(html,/function clearSelection\(options=\{\}\)/);
    assert.match(html,/return \[\];\s*\}\s*function isVisibleEntry/);
    assert.doesNotMatch(html,/boss-library/i);
    assert.equal(
        (html.match(/modal\.html\?v=13/g)||[]).length,
        3,
        'all internal modal imports should use the current component version'
    );
});
