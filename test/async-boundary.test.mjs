import assert from 'node:assert/strict';
import test from 'node:test';

import runAsyncBoundary,{
    AsyncBoundaryAbortError,
    AsyncBoundaryTimeoutError,
    asyncBoundaryDefaults,
    runAsyncBoundary as namedRunAsyncBoundary,
} from '../arcane/modules/AsyncBoundary.js';

function neverSettles(){
    return new Promise(()=>{});
}

function delay(milliseconds,value){
    return new Promise(resolve=>setTimeout(resolve,milliseconds,value));
}

test('runAsyncBoundary resolves promise and function results',async()=>{
    assert.equal(runAsyncBoundary,namedRunAsyncBoundary);
    assert.equal(await runAsyncBoundary(Promise.resolve('promise'),{timeoutMs:50}),'promise');

    let operationSignal;
    const result=await runAsyncBoundary(signal=>{
        operationSignal=signal;
        return 'function';
    },{timeoutMs:50});

    assert.equal(result,'function');
    assert.equal(operationSignal.aborted,false);
});

test('runAsyncBoundary preserves synchronous and asynchronous operation errors',async()=>{
    const thrown=new Error('synthetic throw');
    const rejected=new Error('synthetic rejection');

    await assert.rejects(
        runAsyncBoundary(()=>{throw thrown},{timeoutMs:50}),
        error=>error===thrown
    );
    await assert.rejects(
        runAsyncBoundary(Promise.reject(rejected),{timeoutMs:50}),
        error=>error===rejected
    );
});

test('runAsyncBoundary times out a never-settling operation and aborts its cooperative signal',async()=>{
    let operationSignal;
    const boundary=runAsyncBoundary(signal=>{
        operationSignal=signal;
        return neverSettles();
    },{timeoutMs:15});

    await assert.rejects(boundary,error=>{
        assert(error instanceof AsyncBoundaryTimeoutError);
        assert.equal(error.name,'AsyncBoundaryTimeoutError');
        assert.equal(error.code,'ASYNC_BOUNDARY_TIMEOUT');
        assert.equal(error.timeoutMs,15);
        assert.equal(operationSignal.aborted,true);
        assert.equal(operationSignal.reason,error);
        return true;
    });

    await assert.rejects(
        runAsyncBoundary(neverSettles(),{timeoutMs:10}),
        error=>error.code==='ASYNC_BOUNDARY_TIMEOUT'
    );
});

test('runAsyncBoundary bounds a response body that stalls after headers resolve',async()=>{
    let operationSignal;
    const boundary=runAsyncBoundary(async signal=>{
        operationSignal=signal;
        const response=await Promise.resolve({
            ok:true,
            json:neverSettles,
        });
        return response.json();
    },{timeoutMs:15});

    await assert.rejects(boundary,error=>error.code==='ASYNC_BOUNDARY_TIMEOUT');
    assert.equal(operationSignal.aborted,true);
});

test('an external abort rejects deterministically and carries the original reason as its cause',async()=>{
    const external=new AbortController();
    const reason=new Error('synthetic caller cancellation');
    let operationSignal;
    const boundary=runAsyncBoundary(signal=>{
        operationSignal=signal;
        return neverSettles();
    },{signal:external.signal,timeoutMs:100});

    await Promise.resolve();
    assert.equal(operationSignal.aborted,false);
    external.abort(reason);

    await assert.rejects(boundary,error=>{
        assert(error instanceof AsyncBoundaryAbortError);
        assert.equal(error.name,'AbortError');
        assert.equal(error.code,'ASYNC_BOUNDARY_ABORTED');
        assert.equal(error.cause,reason);
        assert.equal(operationSignal.aborted,true);
        assert.equal(operationSignal.reason,error);
        return true;
    });
});

test('a pre-aborted external signal does not invoke a function operation',async()=>{
    const external=new AbortController();
    external.abort('already cancelled');
    let invoked=false;

    await assert.rejects(
        runAsyncBoundary(()=>{
            invoked=true;
        },{signal:external.signal,timeoutMs:50}),
        error=>error.code==='ASYNC_BOUNDARY_ABORTED'&&error.cause==='already cancelled'
    );
    assert.equal(invoked,false);
});

test('a settled result is not changed by a later timeout or external abort',async()=>{
    const external=new AbortController();
    const result=await runAsyncBoundary(()=>delay(2,'complete'),{
        signal:external.signal,
        timeoutMs:30,
    });

    external.abort(new Error('late abort'));
    await delay(35);
    assert.equal(result,'complete');
});

test('runAsyncBoundary validates its operation and all public options',async()=>{
    assert.equal(asyncBoundaryDefaults.timeoutMs,10000);
    assert.equal(asyncBoundaryDefaults.maxTimeoutMs,300000);

    const invalidCases=[
        [42,{},'ASYNC_BOUNDARY_INVALID_OPERATION'],
        [{}, {},'ASYNC_BOUNDARY_INVALID_OPERATION'],
        [neverSettles,null,'ASYNC_BOUNDARY_INVALID_OPTIONS'],
        [neverSettles,[],'ASYNC_BOUNDARY_INVALID_OPTIONS'],
        [neverSettles,{timeoutMs:0},'ASYNC_BOUNDARY_INVALID_OPTIONS'],
        [neverSettles,{timeoutMs:1.5},'ASYNC_BOUNDARY_INVALID_OPTIONS'],
        [neverSettles,{timeoutMs:300001},'ASYNC_BOUNDARY_INVALID_OPTIONS'],
        [neverSettles,{signal:{}},'ASYNC_BOUNDARY_INVALID_OPTIONS'],
        [neverSettles,{unknown:true},'ASYNC_BOUNDARY_INVALID_OPTIONS'],
    ];

    for(const [operation,options,code] of invalidCases){
        await assert.rejects(runAsyncBoundary(operation,options),error=>error.code===code);
    }
});
