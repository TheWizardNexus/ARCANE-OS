import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;

async function component(name){
    return readFile(new URL(`../arcane/components/${name}.html`,import.meta.url),'utf8');
}

function moduleScript(source){
    return source.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1]||'';
}

test('assistant panel exposes the shared drawer contract',async()=>{
    const source=await component('assistant-panel');
    const script=moduleScript(source);

    assert.ok(script);
    assert.doesNotThrow(()=>new AsyncFunction(script));
    assert.match(source,/host\.open=open/);
    assert.match(source,/host\.close=close/);
    assert.match(source,/host\.toggle=toggle/);
    assert.match(source,/host\.scrollToEnd=scrollToEnd/);
    assert.match(source,/assistant-opened/);
    assert.match(source,/assistant-closed/);
    assert.match(source,/assistant-send/);
    assert.match(source,/assistant-clear/);
    assert.match(source,/assistant-ready/);
    assert.match(source,/event\.key==='Escape'/);
    assert.match(source,/host\.layout!=='overlay'\|\|modalOpen\|\|!focusInside/);
    assert.match(source,/control\.disabled=true/);
    assert.match(source,/returnFocus/);

    for(const slot of ['identity','title','subtitle','messages','composer','actions','footer']){
        assert.match(source,new RegExp(`slot name="${slot}"`));
    }

    for(const state of ['empty','pending','streaming','error']){
        assert.match(source,new RegExp(`data-state-view="${state}"`));
    }

    for(const action of ['toggle','close','clear']){
        assert.match(source,new RegExp(`data-assistant-${action}`));
    }
});

test('app bar exposes domain-neutral brand, route, status, and trailing surfaces',async()=>{
    const source=await component('app-bar');
    const script=moduleScript(source);

    assert.ok(script);
    assert.doesNotThrow(()=>new AsyncFunction(script));
    assert.match(source,/host\.setNavigation=setNavigation/);
    assert.match(source,/host\.setActiveRoute=setActiveRoute/);
    assert.match(source,/host\.setStatus=setStatus/);
    assert.match(source,/--app-bar-active-text/);
    assert.match(source,/--app-bar-active-text:var\(--text-color,#fff\)/);
    assert.match(source,/@media\(forced-colors:active\)/);
    assert.match(source,/color:HighlightText/);
    assert.match(source,/app-bar-ready/);
    assert.match(source,/aria-current','page'/);
    assert.match(source,/@media\(max-width:48rem\)/);

    for(const slot of ['brand-mark','product-name','navigation','status','trailing']){
        assert.match(source,new RegExp(`slot name="${slot}"`));
    }
});

test('shared shell components contain no Redress-specific behavior or external dependencies',async()=>{
    const source=`${await component('assistant-panel')}\n${await component('app-bar')}`;

    assert.doesNotMatch(source,/Redress|legal|case|filing|evidence/i);
    assert.doesNotMatch(source,/(?:href|src)=["']https?:\/\//);
    assert.doesNotMatch(source,/<script[^>]+src=/);
});
