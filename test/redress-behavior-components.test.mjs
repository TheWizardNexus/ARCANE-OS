import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const components={
    'file-drop.html':{
        apis:['configure','openPicker','setBusy','setError','setProgress'],
        events:['file-drop-selected','file-drop-progress','file-drop-error','file-drop-ready']
    },
    'task-progress.html':{
        apis:['configure','runTasks','setTasks','updateTask'],
        events:['task-progress-change','task-progress-complete','task-progress-error','task-progress-ready']
    },
    'summary-strip.html':{
        apis:['configure','setItems','updateItem'],
        events:['summary-strip-change','summary-strip-select','summary-strip-ready']
    },
    'file-inspector.html':{
        apis:['configure','setActions','setBusy','setError','setPreview','show'],
        events:['file-inspector-change','file-inspector-action','file-inspector-ready']
    },
    'output-panel.html':{
        apis:['configure','setActions','setBody','setCoverage','setError','setOutput','setPending','setStatus'],
        events:['output-panel-change','output-panel-action','output-panel-ready']
    }
};

async function component(name){
    return readFile(new URL(`../arcane/components/${name}`,import.meta.url),'utf8');
}

test('shared primitive stylesheet covers the audited neutral interface vocabulary',async()=>{
    const css=await readFile(new URL('../arcane/css/primitives.css',import.meta.url),'utf8');
    for(const marker of [
        '--arcane-space-1','--arcane-surface','--arcane-border','--arcane-shadow-medium',
        '.arcane-button--action','.arcane-button--secondary','.arcane-button--tertiary','.arcane-icon-button',
        '.arcane-close-button','.arcane-card__header','.arcane-card__body',
        '.arcane-card__footer','.arcane-view-heading','.arcane-section-heading',
        '.arcane-form-grid','.arcane-field','.arcane-help','.arcane-form-note',
        '.arcane-status-light','.arcane-pill','.arcane-badge','.arcane-count',
        '.arcane-state--loading','.arcane-state--error','.arcane-state--review'
    ]){
        assert.match(css,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`Missing ${marker}`);
    }
    assert.doesNotMatch(css,/https?:\/\//i);
    assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
});

test('behavior components use local primitives and expose stable APIs and events',async()=>{
    for(const [name,contract] of Object.entries(components)){
        const source=await component(name);
        assert.match(source,/href="\.\/arcane\/css\/primitives\.css\?v=1"/,`${name} omits primitives`);
        assert.doesNotMatch(source,/https?:\/\//i,`${name} contains a remote reference`);
        assert.doesNotMatch(source,/\.innerHTML\s*=/,`${name} uses an unsafe HTML sink`);
        assert.match(source,/host\.ready=true/);
        for(const api of contract.apis){
            assert.match(source,new RegExp(`host\\.${api}=${api}`),`${name} omits ${api}()`);
        }
        for(const event of contract.events){
            assert.match(source,new RegExp(`['"]${event}['"]`),`${name} omits ${event}`);
        }
    }
});

test('every behavior component inline module compiles',async()=>{
    for(const name of Object.keys(components)){
        const source=await component(name);
        const scripts=Array.from(
            source.matchAll(/<script\s+type="module">([\s\S]*?)<\/script>/gi),
            match=>match[1]
        );
        assert.equal(scripts.length,1,`${name} should have one inline module`);
        assert.doesNotThrow(()=>new Function(scripts[0]),`${name} inline module does not compile`);
    }
});

test('behavior components retain accessible state and action surfaces',async()=>{
    const fileDrop=await component('file-drop.html');
    const taskProgress=await component('task-progress.html');
    const summary=await component('summary-strip.html');
    const inspector=await component('file-inspector.html');
    const output=await component('output-panel.html');

    assert.match(fileDrop,/type="file"/);
    assert.match(fileDrop,/aria-live="polite"/);
    assert.match(fileDrop,/<progress\b/);
    assert.match(taskProgress,/aria-live="polite"/);
    assert.match(taskProgress,/aria-busy/);
    assert.match(summary,/aria-label="Summary"/);
    assert.match(inspector,/slot name="preview"/);
    assert.match(inspector,/slot name="actions"/);
    assert.match(output,/slot name="coverage"/);
    assert.match(output,/slot name="body"/);
    assert.match(output,/aria-live="polite"/);
});
