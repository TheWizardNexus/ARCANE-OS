import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import BrowserTestSuite from '../arcane/modules/BrowserTestSuite.js';

test('browser test suite runs trusted callbacks sequentially and normalizes results and events',async()=>{
    const order=[];
    const events=[];
    let clock=0;
    const suite=new BrowserTestSuite({
        now:()=>clock++,
        timeoutMs:100,
        tests:[
            {
                id:'pass',
                name:'Passing check',
                run:async({assert,context,signal})=>{
                    order.push('pass:start');
                    assert(context.marker==='synthetic','The injected context should be available.');
                    assert(signal.aborted===false,'The check signal should begin active.');
                    await Promise.resolve();
                    assert(2+2===4,'Arithmetic should remain stable.');
                    order.push('pass:end');
                    return {status:'pass',message:'Synthetic assertion passed.'};
                },
            },
            {
                id:'fail',
                name:'Returned failure',
                run:()=>{order.push('fail');return false;},
            },
            {
                id:'skip',
                name:'Skipped check',
                run:({skip})=>{order.push('skip');skip('Capability is intentionally absent.');},
            },
            {
                id:'error',
                name:'Thrown failure',
                run:()=>{order.push('error');throw new Error('Synthetic failure.');},
            },
        ],
    });
    for(const type of [
        'browser-test-suite-start',
        'browser-test-start',
        'browser-test-result',
        'browser-test-suite-complete',
    ]) suite.addEventListener(type,event=>events.push([type,event.detail]));

    const summary=await suite.run({context:{marker:'synthetic'}});

    assert.deepEqual(order,['pass:start','pass:end','fail','skip','error']);
    assert.equal(summary.status,'fail');
    assert.deepEqual(summary.totals,{total:4,pass:1,fail:2,skip:1});
    assert.deepEqual(summary.results.map(result=>result.status),['pass','fail','skip','fail']);
    assert.equal(summary.results[1].code,'BROWSER_TEST_ASSERTION');
    assert.equal(summary.results[2].code,'BROWSER_TEST_SKIP');
    assert.equal(summary.results[3].errorName,'Error');
    assert(summary.results.every(result=>result.durationMs===1));
    assert.equal(summary.durationMs,9);
    assert.equal(suite.running,false);
    assert(Object.isFrozen(summary));
    assert(Object.isFrozen(summary.results));
    assert(Object.isFrozen(summary.results[0]));
    assert.equal(events.filter(([type])=>type==='browser-test-start').length,4);
    assert.equal(events.filter(([type])=>type==='browser-test-result').length,4);
    assert(Object.isFrozen(events[0][1]));
    assert.equal(events.at(-1)[0],'browser-test-suite-complete');
});

test('browser test suite times out one check, aborts its signal, and continues in order',async()=>{
    let timedSignal;
    let secondRan=false;
    const suite=new BrowserTestSuite({
        timeoutMs:20,
        tests:[
            {
                id:'timeout',
                name:'Timeout check',
                timeoutMs:10,
                run:({signal})=>{
                    timedSignal=signal;
                    return new Promise(()=>{});
                },
            },
            {
                id:'after',
                name:'Check after timeout',
                run:()=>{secondRan=true;},
            },
        ],
    });

    const summary=await suite.run();

    assert.equal(summary.status,'fail');
    assert.equal(summary.results[0].code,'BROWSER_TEST_TIMEOUT');
    assert.equal(summary.results[0].status,'fail');
    assert.equal(timedSignal.aborted,true);
    assert.equal(secondRan,true);
    assert.equal(summary.results[1].status,'pass');
});

test('browser test suite returns an aborted summary and does not invoke unfinished checks',async()=>{
    const controller=new AbortController();
    const invoked=[];
    const suite=new BrowserTestSuite({
        tests:[
            {
                id:'abort-current',
                name:'Abort current check',
                run:async()=>{
                    invoked.push('abort-current');
                    controller.abort();
                    await Promise.resolve();
                },
            },
            {
                id:'never-run',
                name:'Never invoked',
                run:()=>invoked.push('never-run'),
            },
        ],
    });

    const summary=await suite.run({signal:controller.signal});

    assert.equal(summary.status,'aborted');
    assert.deepEqual(invoked,['abort-current']);
    assert.deepEqual(summary.results.map(result=>result.status),['skip','skip']);
    assert(summary.results.every(result=>result.code==='BROWSER_TEST_ABORTED'));
});

test('browser test suite rejects concurrent runs without corrupting the active run',async()=>{
    let release;
    const waiting=new Promise(resolve=>{release=resolve;});
    const suite=new BrowserTestSuite({
        tests:[{id:'wait',name:'Wait for release',run:()=>waiting}],
    });

    const active=suite.run();
    assert.equal(suite.running,true);
    await assert.rejects(suite.run(),error=>error?.code==='BROWSER_TEST_BUSY');
    release();
    const summary=await active;
    assert.equal(summary.status,'pass');
    assert.equal(suite.running,false);
});

test('browser test suite validates descriptors, ids, limits, signals, clocks, and callback results',async()=>{
    assert.throws(
        ()=>new BrowserTestSuite({tests:[{id:'source',name:'Source string',run:'alert(1)'}]}),
        error=>error?.code==='BROWSER_TEST_INVALID_DESCRIPTOR',
    );
    assert.throws(
        ()=>new BrowserTestSuite({tests:[{id:'unknown',name:'Unknown',run(){},source:'text'}]}),
        error=>error?.code==='BROWSER_TEST_INVALID_DESCRIPTOR',
    );
    assert.throws(
        ()=>new BrowserTestSuite({tests:[
            {id:'Alpha',name:'One',run(){}},
            {id:'alpha',name:'Two',run(){}},
        ]}),
        error=>error?.code==='BROWSER_TEST_CASE_COLLISION',
    );
    assert.throws(
        ()=>new BrowserTestSuite({maxTests:1,tests:[
            {id:'one',name:'One',run(){}},
            {id:'two',name:'Two',run(){}},
        ]}),
        error=>error?.code==='BROWSER_TEST_LIMIT',
    );
    assert.throws(
        ()=>new BrowserTestSuite({timeoutMs:20,tests:[
            {id:'slow',name:'Slow',timeoutMs:21,run(){}},
        ]}),
        error=>error?.code==='BROWSER_TEST_INVALID_LIMIT',
    );

    const invalidResults=new BrowserTestSuite({tests:[
        {id:'string',name:'String result',run:()=> 'pass'},
        {id:'unknown',name:'Unknown field',run:()=>({status:'pass',details:{}})},
        {id:'bad-status',name:'Bad status',run:()=>({status:'maybe'})},
        {id:'noisy-error',name:'Noisy error',run:()=>{throw new Error(`${'x'.repeat(1500)}\ncontrol`);}},
    ]});
    const summary=await invalidResults.run();
    assert.deepEqual(summary.results.map(result=>result.code),[
        'BROWSER_TEST_INVALID_RESULT',
        'BROWSER_TEST_INVALID_RESULT',
        'BROWSER_TEST_INVALID_RESULT',
        'BROWSER_TEST_ERROR',
    ]);
    assert.equal(summary.results[3].message.length,1000);
    assert.doesNotMatch(summary.results[3].message,/\n/);

    const invalidClock=new BrowserTestSuite({
        now:()=>Number.NaN,
        tests:[],
    });
    await assert.rejects(invalidClock.run(),error=>error?.code==='BROWSER_TEST_INVALID_CLOCK');

    const valid=new BrowserTestSuite();
    await assert.rejects(valid.run({signal:{aborted:false}}),error=>error?.code==='BROWSER_TEST_INVALID_OPTIONS');
});

test('browser test suite exposes immutable metadata without callback references',()=>{
    const run=()=>{};
    const suite=new BrowserTestSuite({tests:[
        {id:'metadata',name:'Metadata check',timeoutMs:25,run},
    ],timeoutMs:50});
    const listed=suite.list();

    assert.deepEqual(listed,[{id:'metadata',name:'Metadata check',timeoutMs:25}]);
    assert.equal('run' in listed[0],false);
    assert(Object.isFrozen(listed));
    assert(Object.isFrozen(listed[0]));
});

test('shared browser test suite source remains domain-neutral and never evaluates source text',async()=>{
    const source=await readFile(new URL('../arcane/modules/BrowserTestSuite.js',import.meta.url),'utf8');
    assert.doesNotMatch(source,/BOSS|Arcane Docs|GitHub Pages|OpenAI|repository/i);
    assert.doesNotMatch(source,/\beval\s*\(|new\s+Function\s*\(/);
});
