import assert from 'node:assert/strict';
import { describe,it } from 'node:test';

import Errors,{
    fingerprintIncident,
    normalizeErrorEvent,
    normalizeRejectionEvent,
} from '../modules/Errors.js';

class MemoryStorage {
    constructor(){
        this.values=new Map();
    }

    getItem(key){
        return this.values.has(key) ? this.values.get(key):null;
    }

    setItem(key,value){
        this.values.set(key,String(value));
    }
}

class FakeWindow {
    constructor(storage=new MemoryStorage()){
        this.listeners=new Map();
        this.location={ href:'https://app.example.test/chat.html',pathname:'/chat.html' };
        this.registrations=[];
        this.sessionStorage=storage;
    }

    addEventListener(type,listener,options){
        const listeners=this.listeners.get(type)||[];
        listeners.push(listener);
        this.listeners.set(type,listeners);
        this.registrations.push({ options,type });
    }

    removeEventListener(type,listener){
        const listeners=this.listeners.get(type)||[];
        this.listeners.set(
            type,
            listeners.filter(candidate => candidate!==listener)
        );
    }

    emit(type,event={}){
        for(const listener of this.listeners.get(type)||[]){
            listener(event);
        }
    }

    listenerCount(type){
        return (this.listeners.get(type)||[]).length;
    }
}

function createScheduler(){
    let nextId=1;
    const tasks=new Map();
    const delays=[];

    return {
        cancel(id){
            tasks.delete(id);
        },
        get delays(){
            return [...delays];
        },
        get size(){
            return tasks.size;
        },
        runAll(){
            for(const [id,entry] of [...tasks]){
                if(!tasks.delete(id)){
                    continue;
                }
                entry.task();
            }
        },
        schedule(task,delay){
            const id=nextId++;
            delays.push(delay);
            tasks.set(id,{ delay,task });
            return id;
        },
    };
}

function errorEvent(message='Example failure',line=10){
    const error=new Error(message);
    error.stack=`Error: ${message}\n    at example (chat.js:${line}:20)`;

    return {
        colno:20,
        error,
        filename:'https://app.example.test/chat.js',
        lineno:line,
        message,
    };
}

function makeHarness(overrides={}){
    const scheduler=createScheduler();
    const storage=overrides.storage||new MemoryStorage();
    const target=overrides.target||new FakeWindow(storage);
    const sends=[];
    let timestamp=Date.parse('2026-07-12T05:00:00.000Z');

    const handler=new Errors({
        cancel:scheduler.cancel,
        delayMs:2_000,
        logger:{ warn() {} },
        maxReportsPerSession:10,
        maxReportsPerWindow:10,
        now:() => timestamp,
        rateWindowMs:60_000,
        schedule:scheduler.schedule,
        sendMail:async (...args) => {
            sends.push(args);
            return { sent:true };
        },
        singleton:false,
        storage,
        target,
        ...overrides.options,
    });

    return {
        advance(milliseconds){
            timestamp+=milliseconds;
        },
        handler,
        scheduler,
        sends,
        storage,
        target,
    };
}

describe('global Errors reporter',() => {
    it('installs one singleton listener pair and disposes it cleanly',() => {
        const target=new FakeWindow();
        const first=new Errors({
            logger:{ warn() {} },
            sendMail:async () => {},
            target,
        });
        const second=new Errors({
            logger:{ warn() {} },
            sendMail:async () => {},
            target,
        });

        assert.equal(second,first);
        assert.equal(target.errors,first);
        assert.equal(target.listenerCount('error'),1);
        assert.equal(target.listenerCount('unhandledrejection'),1);
        assert.deepEqual(
            target.registrations.map(({ options,type }) => [type,options]),
            [['error',true],['unhandledrejection',true]]
        );

        first.destroy();
        assert.equal(target.listenerCount('error'),0);
        assert.equal(target.listenerCount('unhandledrejection'),0);
        assert.equal(target.errors,undefined);
    });

    it('waits for a fixed observation window and sends 100 repeats only once',async () => {
        const harness=makeHarness();

        for(let occurrence=0;occurrence<100;occurrence++){
            harness.target.emit('error',errorEvent('Repeating failure'));
            harness.advance(5);
        }

        assert.equal(harness.sends.length,0);
        assert.equal(harness.scheduler.size,1,'repeats must not reset or multiply the timer');
        assert.deepEqual(harness.scheduler.delays,[2_000]);

        harness.scheduler.runAll();
        await harness.handler.whenIdle();

        assert.equal(harness.sends.length,1);
        const [,subject,payload,,messageType]=harness.sends[0];
        assert.match(subject,/LOOP DETECTED/);
        assert.equal(messageType,'error');
        assert.equal(payload.loop_detected,true);
        assert.equal(payload.occurrence_count,100);
        assert.equal(payload.matching_notifications_suppressed,true);
        assert.match(payload.loop_notice,/repeated 100 times/i);

        harness.target.emit('error',errorEvent('Repeating failure'));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();

        assert.equal(harness.sends.length,1,'later matching errors stay suppressed');
    });

    it('presents incidents only when developer mode is strictly true',async () => {
        const enabledPresentations=[];
        const enabled=makeHarness({
            options:{
                isDeveloperMode:() => true,
                presentDeveloperIncident:(...args) => {
                    enabledPresentations.push(args);
                },
            },
        });
        const disabledPresentations=[];
        const disabled=makeHarness({
            options:{
                isDeveloperMode:() => false,
                presentDeveloperIncident:(...args) => {
                    disabledPresentations.push(args);
                },
            },
        });
        const truthyPresentations=[];
        const truthy=makeHarness({
            options:{
                isDeveloperMode:() => 'true',
                presentDeveloperIncident:(...args) => {
                    truthyPresentations.push(args);
                },
            },
        });

        enabled.target.emit('error',errorEvent('Developer-visible failure'));
        disabled.target.emit('error',errorEvent('Developer-hidden failure'));
        truthy.target.emit('error',errorEvent('Truthy developer flag'));
        enabled.scheduler.runAll();
        disabled.scheduler.runAll();
        truthy.scheduler.runAll();
        await Promise.all([
            enabled.handler.whenIdle(),
            disabled.handler.whenIdle(),
            truthy.handler.whenIdle(),
        ]);
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(enabledPresentations.length,1);
        assert.equal(disabledPresentations.length,0);
        assert.equal(truthyPresentations.length,0,'truthy non-booleans must not enable developer UI');
        assert.equal(enabled.sends.length,1);
        assert.equal(disabled.sends.length,1);
        assert.equal(truthy.sends.length,1);
    });

    it('presents one developer incident for a repeatedly matching fingerprint',async () => {
        const presentations=[];
        const harness=makeHarness({
            options:{
                isDeveloperMode:() => true,
                presentDeveloperIncident:(...args) => {
                    presentations.push(args);
                },
            },
        });

        for(let occurrence=0;occurrence<50;occurrence++){
            harness.target.emit('error',errorEvent('Developer loop'));
        }

        harness.scheduler.runAll();
        await harness.handler.whenIdle();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(presentations.length,1);
        assert.equal(harness.sends.length,1);

        harness.target.emit('error',errorEvent('Developer loop'));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(presentations.length,1,'a reported fingerprint must not open another modal');
        assert.equal(harness.sends.length,1);
    });

    it('contains a synchronous developer presenter failure without blocking or multiplying mail',async () => {
        let presentationCalls=0;
        const harness=makeHarness({
            options:{
                isDeveloperMode:() => true,
                presentDeveloperIncident:() => {
                    presentationCalls++;
                    throw new Error('developer presenter failed synchronously');
                },
            },
        });

        harness.target.emit('error',errorEvent('Application failure before sync presenter'));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(presentationCalls,1);
        assert.equal(harness.sends.length,1);

        harness.target.emit('error',errorEvent('Application failure before sync presenter'));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();
        assert.equal(presentationCalls,1);
        assert.equal(harness.sends.length,1);
    });

    it('observes a rejected developer presenter without blocking or multiplying mail',async () => {
        let presentationCalls=0;
        const harness=makeHarness({
            options:{
                isDeveloperMode:() => true,
                presentDeveloperIncident:() => {
                    presentationCalls++;
                    return Promise.reject(new Error('developer presenter rejected'));
                },
            },
        });

        harness.target.emit('error',errorEvent('Application failure before rejected presenter'));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(presentationCalls,1);
        assert.equal(harness.sends.length,1);

        harness.target.emit('error',errorEvent('Application failure before rejected presenter'));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();
        assert.equal(presentationCalls,1);
        assert.equal(harness.sends.length,1);
    });

    it('does not await a hanging developer presenter before delivering mail',async () => {
        let presentationCalls=0;
        const harness=makeHarness({
            options:{
                isDeveloperMode:() => true,
                presentDeveloperIncident:() => {
                    presentationCalls++;
                    return new Promise(() => {});
                },
            },
        });

        harness.target.emit('error',errorEvent('Application failure before hanging presenter'));
        harness.scheduler.runAll();

        const becameIdle=await Promise.race([
            harness.handler.whenIdle().then(() => true),
            new Promise(resolve => setImmediate(() => resolve(false))),
        ]);

        assert.equal(becameIdle,true,'developer presentation must stay outside the mail queue');
        assert.equal(presentationCalls,1);
        assert.equal(harness.sends.length,1);

        harness.target.emit('error',errorEvent('Application failure before hanging presenter'));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();
        assert.equal(presentationCalls,1);
        assert.equal(harness.sends.length,1);
    });

    it('reports Error and non-Error promise rejections without conflating them',async () => {
        const harness=makeHarness();

        harness.target.emit('unhandledrejection',{
            reason:new TypeError('Promise failed'),
        });
        harness.scheduler.runAll();
        await harness.handler.whenIdle();

        harness.advance(2_100);
        harness.target.emit('unhandledrejection',{ reason:'plain rejection reason' });
        harness.scheduler.runAll();
        await harness.handler.whenIdle();

        assert.equal(harness.sends.length,2);
        assert.equal(harness.sends[0][2].name,'TypeError');
        assert.equal(harness.sends[0][2].message,'Promise failed');
        assert.equal(harness.sends[1][2].name,'UnhandledRejection');
        assert.equal(harness.sends[1][2].message,'plain rejection reason');
        assert.match(harness.sends[0][1],/UNHANDLED REJECTION/);
    });

    it('catches mail rejection without creating an unhandled retry',async () => {
        const scheduler=createScheduler();
        const target=new FakeWindow();
        let rejectDelivery;
        let markStarted;
        let sendCalls=0;
        const started=new Promise(resolve => { markStarted=resolve; });
        const pendingDelivery=new Promise((resolve,reject) => {
            rejectDelivery=reject;
        });
        const warnings=[];

        const handler=new Errors({
            cancel:scheduler.cancel,
            delayMs:2_000,
            logger:{ warn(...args){ warnings.push(args); } },
            schedule:scheduler.schedule,
            sendMail:async () => {
                sendCalls++;
                markStarted();
                return pendingDelivery;
            },
            singleton:false,
            storage:new MemoryStorage(),
            target,
        });

        target.emit('error',errorEvent('Original application error'));
        scheduler.runAll();
        await started;

        rejectDelivery(new Error('Mail request failed'));
        await handler.whenIdle();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(sendCalls,1);
        assert.equal(warnings.length,1);
        assert.match(warnings[0][0],/no retry/i);

        target.emit('error',errorEvent('Original application error'));
        scheduler.runAll();
        await handler.whenIdle();
        assert.equal(sendCalls,1,'a failed notification remains attempted and suppressed');
    });

    it('suppresses an error emitted synchronously by the mail adapter',async () => {
        const scheduler=createScheduler();
        const target=new FakeWindow();
        let sendCalls=0;
        const handler=new Errors({
            cancel:scheduler.cancel,
            delayMs:2_000,
            logger:{ warn() {} },
            schedule:scheduler.schedule,
            sendMail:async () => {
                sendCalls++;
                target.emit('error',errorEvent('Synchronous mail-adapter error'));
                return { sent:true };
            },
            singleton:false,
            storage:new MemoryStorage(),
            target,
        });

        target.emit('error',errorEvent('Original application error'));
        scheduler.runAll();
        await handler.whenIdle();
        scheduler.runAll();

        assert.equal(sendCalls,1);
        assert.equal(scheduler.size,0);
    });

    it('times out a hanging notification without disabling unrelated capture',async () => {
        const observationScheduler=createScheduler();
        const deliveryScheduler=createScheduler();
        const target=new FakeWindow();
        const warnings=[];
        const sends=[];
        let markStarted;
        const started=new Promise(resolve => { markStarted=resolve; });

        const handler=new Errors({
            cancel:observationScheduler.cancel,
            delayMs:2_000,
            deliveryCancel:deliveryScheduler.cancel,
            deliverySchedule:deliveryScheduler.schedule,
            deliveryTimeoutMs:50,
            logger:{ warn(...args){ warnings.push(args); } },
            maxReportsPerWindow:10,
            schedule:observationScheduler.schedule,
            sendMail:async (...args) => {
                sends.push(args);
                if(sends.length===1){
                    markStarted();
                    return new Promise(() => {});
                }
                return { sent:true };
            },
            singleton:false,
            storage:new MemoryStorage(),
            target,
        });

        target.emit('error',errorEvent('Hanging notification source'));
        observationScheduler.runAll();
        await started;

        target.emit('error',errorEvent('Unrelated application error',11));
        observationScheduler.runAll();
        assert.equal(sends.length,1,'second delivery waits behind the bounded first attempt');
        assert.equal(handler.reportTimestamps.length,2);
        assert.equal(deliveryScheduler.size,1);

        deliveryScheduler.runAll();
        await handler.whenIdle();

        assert.equal(sends.length,2);
        assert.equal(warnings.length,1);
        assert.match(warnings[0][1].message,/timed out/i);
    });

    it('persists attempted fingerprints across handler recreation',async () => {
        const storage=new MemoryStorage();
        const first=makeHarness({ storage });

        first.target.emit('error',errorEvent('Persistent duplicate'));
        first.scheduler.runAll();
        await first.handler.whenIdle();
        assert.equal(first.sends.length,1);
        first.handler.destroy();

        const second=makeHarness({ storage });
        second.target.emit('error',errorEvent('Persistent duplicate'));
        second.scheduler.runAll();
        await second.handler.whenIdle();

        assert.equal(second.sends.length,0);
        assert.equal(second.scheduler.size,0);
    });

    it('restores a pending looping incident after navigation before the delay',async () => {
        const storage=new MemoryStorage();
        const first=makeHarness({ storage });
        first.target.emit('error',errorEvent('Reloading loop'));
        first.target.emit('error',errorEvent('Reloading loop'));

        assert.equal(first.sends.length,0);
        assert.equal(first.scheduler.size,1);

        const second=makeHarness({ storage });
        assert.equal(second.scheduler.size,1,'the pending notification is restored');
        second.scheduler.runAll();
        await second.handler.whenIdle();

        assert.equal(second.sends.length,1);
        assert.equal(second.sends[0][2].loop_detected,true);
        assert.equal(second.sends[0][2].occurrence_count,2);
    });

    it('fails closed when the suppression ledger cannot be persisted',async () => {
        const storage={
            getItem(){
                return null;
            },
            setItem(){
                throw new Error('storage unavailable');
            },
        };

        for(let reload=0;reload<2;reload++){
            const harness=makeHarness({ storage });
            harness.target.emit('error',errorEvent('Reloading without storage'));
            harness.scheduler.runAll();
            await harness.handler.whenIdle();

            assert.equal(harness.sends.length,0);
            assert.equal(harness.scheduler.size,0);
            assert.equal(harness.handler.circuitOpen,true);
            assert.equal(harness.handler.storageHealthy,false);
        }
    });

    it('opens a session circuit breaker for a varying rapid error storm',async () => {
        const harness=makeHarness({
            options:{ maxReportsPerWindow:2 },
        });

        harness.target.emit('error',errorEvent('First unique failure',10));
        harness.target.emit('error',errorEvent('Second unique failure',11));
        harness.target.emit('error',errorEvent('Third unique failure',12));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();

        assert.equal(harness.sends.length,2);
        const [,subject,payload]=harness.sends[1];
        assert.match(subject,/ERROR STORM DETECTED/);
        assert.equal(payload.error_storm_detected,true);
        assert.match(payload.circuit_breaker_notice,/further error emails are suppressed/i);

        harness.advance(120_000);
        harness.target.emit('error',errorEvent('A later unique failure',13));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();
        assert.equal(harness.sends.length,2,'the session circuit stays open');

        const reloaded=makeHarness({ storage:harness.storage });
        reloaded.target.emit('error',errorEvent('Failure after reload',14));
        assert.equal(reloaded.scheduler.size,0,'the open circuit persists across reloads');
    });

    it('applies the lifetime session cap outside the rolling rate window',async () => {
        const harness=makeHarness({
            options:{
                maxReportsPerSession:2,
                maxReportsPerWindow:99,
                rateWindowMs:10,
            },
        });

        harness.target.emit('error',errorEvent('Session failure one',10));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();

        harness.advance(11);
        harness.target.emit('error',errorEvent('Session failure two',11));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();

        assert.equal(harness.sends.length,2);
        assert.equal(harness.sends[1][2].error_storm_detected,true);

        harness.advance(11);
        harness.target.emit('error',errorEvent('Session failure three',12));
        harness.scheduler.runAll();
        await harness.handler.whenIdle();
        assert.equal(harness.sends.length,2);
    });

    it('normalizes resource failures and creates stable fingerprints',async () => {
        const target=new FakeWindow();
        const resourceIncident=normalizeErrorEvent({
            target:{ src:'https://app.example.test/missing.js' },
        },target);
        const rejectionIncident=normalizeRejectionEvent({ reason:42 },target);

        assert.deepEqual(resourceIncident,{
            type:'error',
            message:'Resource failed to load',
            name:'ResourceLoadError',
            stack:null,
            filename:'https://app.example.test/missing.js',
            lineno:null,
            colno:null,
        });
        assert.equal(rejectionIncident.message,'42');
        assert.equal(
            fingerprintIncident({
                ...resourceIncident,
                message:'Retry 123 failed at 2026',
                stack:'at retry (worker.js:123:4)',
            }),
            fingerprintIncident({
                ...resourceIncident,
                message:'Retry 456 failed at 2027',
                stack:'at retry (worker.js:123:4)',
            })
        );
        assert.equal(
            fingerprintIncident({
                ...resourceIncident,
                lineno:25,
                message:'Customer Alpha failed',
                stack:'Error: Customer Alpha failed\n    at submit (worker.js:25:8)',
            }),
            fingerprintIncident({
                ...resourceIncident,
                lineno:25,
                message:'Customer Beta failed',
                stack:'Error: Customer Beta failed\n    at submit (worker.js:25:8)',
            }),
            'changing alphabetic values at one callsite must remain one fingerprint'
        );
        assert.notEqual(
            fingerprintIncident({
                ...resourceIncident,
                message:'Failed to fetch',
                stack:'TypeError: Failed to fetch\n    at loadProfile (profile.js:10:4)',
            }),
            fingerprintIncident({
                ...resourceIncident,
                message:'Failed to fetch',
                stack:'TypeError: Failed to fetch\n    at loadDashboard (dashboard.js:10:4)',
            }),
            'matching rejection messages from different callsites must stay distinct'
        );
        assert.notEqual(
            fingerprintIncident(normalizeRejectionEvent({ reason:'Phase Alpha' },target)),
            fingerprintIncident(normalizeRejectionEvent({ reason:'Phase Beta' },target)),
            'distinct source-less rejection reasons must stay distinct'
        );
        assert.notEqual(
            fingerprintIncident({
                ...resourceIncident,
                message:'Failed to fetch',
                name:'TypeError',
                stack:'TypeError: Failed to fetch\n    at load (profile.js:10:4)',
            }),
            fingerprintIncident({
                ...resourceIncident,
                message:'Failed to fetch',
                name:'TypeError',
                stack:'TypeError: Failed to fetch\n    at load (profile.js:11:4)',
            }),
            'different stack lines in one function must stay distinct'
        );
        assert.notEqual(
            fingerprintIncident({
                ...resourceIncident,
                message:'Failed to fetch',
                name:'TypeError',
                stack:'load@profile.js:10:4',
            }),
            fingerprintIncident({
                ...resourceIncident,
                message:'Failed to fetch',
                name:'TypeError',
                stack:'load@profile.js:11:4',
            }),
            'a Firefox-style first stack frame must not be discarded'
        );

        const harness=makeHarness();
        harness.target.emit('error',{
            target:{ src:'https://app.example.test/missing.css' },
        });
        harness.scheduler.runAll();
        await harness.handler.whenIdle();
        assert.equal(harness.sends[0][2].name,'ResourceLoadError');
    });
});
