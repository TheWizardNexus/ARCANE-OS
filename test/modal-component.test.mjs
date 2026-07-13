import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const modalURL=new URL('../arcane/components/modal.html',import.meta.url);

test('shared modal uses native dialog while preserving its public contract',async()=>{
    const source=await readFile(modalURL,'utf8');
    const script=source.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];

    assert.ok(script,'modal module script is missing');
    assert.doesNotThrow(()=>new (Object.getPrototypeOf(async function(){}).constructor)(script));
    assert.match(source,/<dialog\b[^>]*part="surface"/);
    assert.match(source,/dialog\.showModal\(\)/);
    assert.doesNotMatch(source,/modal-overlay/);

    for(const marker of [
        'host.populate=populate',
        'host.open=open',
        'host.close=close',
        'host.runTasks=runTasks',
        "new CustomEvent('modal-ready')",
        "new CustomEvent('modal-opened')",
        "new CustomEvent('modal-closed')",
        'window.modalStack'
    ]){
        assert.ok(source.includes(marker),`modal is missing ${marker}`);
    }

    for(const part of ['header','body','footer','close']){
        assert.match(source,new RegExp(`part="${part}"`));
    }
});

test('Redress modal styling no longer reaches into the shared modal structure',async()=>{
    const source=await readFile(new URL('../apps/redress/redress-modal.css',import.meta.url),'utf8');
    assert.doesNotMatch(source,/modal-overlay|\.modal(?:\s|\{|>)/);
    assert.match(source,/--modal-width/);
    assert.match(source,/\.redress-modal-content/);
});
