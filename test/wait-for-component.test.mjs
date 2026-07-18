import assert from 'node:assert/strict';
import test from 'node:test';

import waitForComponent from '../arcane/modules/WaitForComponent.js';

class ComponentHost extends EventTarget{
    ready=false;
}

test('waitForComponent resolves both persistent and event readiness orders',async()=>{
    const alreadyReady=new ComponentHost();
    alreadyReady.ready=true;
    alreadyReady.render=()=>{};
    assert.equal(
        await waitForComponent(alreadyReady,{methods:['render'],property:'ready',event:'ready'}),
        alreadyReady
    );

    const laterReady=new ComponentHost();
    const waiting=waitForComponent(laterReady,{
        methods:['render'],
        property:'ready',
        event:'ready',
        timeoutMs:100
    });
    laterReady.render=()=>{};
    laterReady.ready=true;
    laterReady.dispatchEvent(new Event('ready'));
    assert.equal(await waiting,laterReady);
});

test('waitForComponent rejects a declared load error without waiting for timeout',async()=>{
    const component=new ComponentHost();
    const waiting=waitForComponent(component,{
        event:'ready',
        errorEvent:'load-error',
        property:'ready',
        timeoutMs:100
    });
    const failure=new Event('load-error');
    failure.detail={code:'SYNTHETIC_LOAD_FAILED',message:'Synthetic component failed.'};
    component.dispatchEvent(failure);
    await assert.rejects(
        waiting,
        error=>error.code==='SYNTHETIC_LOAD_FAILED'&&error.message==='Synthetic component failed.'
    );
});

test('waitForComponent rejects a bounded readiness wait and validates the bound',async()=>{
    const component=new ComponentHost();
    await assert.rejects(
        waitForComponent(component,{event:'ready',property:'ready',timeoutMs:10}),
        error=>error.code==='COMPONENT_READY_TIMEOUT'
    );
    await assert.rejects(
        waitForComponent(component,{event:'ready',property:'ready',timeoutMs:60001}),
        /between 0 and 60000/
    );
});
