import assert from 'node:assert/strict';
import { afterEach,beforeEach,describe,it } from 'node:test';

const messages=[{ role:'user',content:'Hello' }];
let importCount=0;
let originalGlobals;

function snapshotGlobal(name){
    return Object.getOwnPropertyDescriptor(globalThis,name);
}

function restoreGlobal(name,descriptor){
    if(descriptor){
        Object.defineProperty(globalThis,name,descriptor);
    }else{
        delete globalThis[name];
    }
}

function createWindowStub(){
    return {
        addEventListener(){},
        dispatchEvent(){},
        dbopfs:{ get(){},ready:false },
        dbls:{ get(){},set(){},ready:false },
        user:{ preferredModels:[],ready:false },
    };
}

function jsonResponse(content='Hello back'){
    return new Response(
        JSON.stringify({
            id:'response-1',
            choices:[{ message:{ content } }],
        }),
        {
            status:200,
            headers:{ 'Content-Type':'application/json' },
        },
    );
}

async function loadAI(){
    const moduleUrl=new URL('../arcane/modules/AI.js',import.meta.url);
    moduleUrl.searchParams.set('test',`${process.pid}-${++importCount}`);
    return (await import(moduleUrl)).default;
}

function createOpenAI(AI){
    return new AI(
        'OPENAI',
        'OPENAI',
        'OPENAI',
        'OPENAI',
        'OPENAI',
        'OPENAI',
    );
}

function createOllamaAI(AI){
    return new AI(
        'OLLAMA',
        'LOCAL_SPEACH',
        'LOCAL_SPEACH',
        'PRECRISIS',
        'LOCAL_SPEACH',
        'LOCAL_SPEACH',
    );
}

beforeEach(() => {
    originalGlobals={
        arcane:snapshotGlobal('arcane'),
        fetch:snapshotGlobal('fetch'),
        navigator:snapshotGlobal('navigator'),
        window:snapshotGlobal('window'),
        trace:console.trace,
    };

    Object.defineProperty(
        globalThis,
        'navigator',
        {
            configurable:true,
            value:{ storage:{} },
            writable:true,
        },
    );
    globalThis.arcane={ config:{ openAI:{ apiKey:'' } } };
    globalThis.window=createWindowStub();
    console.trace=()=>{};
});

afterEach(() => {
    restoreGlobal('arcane',originalGlobals.arcane);
    restoreGlobal('fetch',originalGlobals.fetch);
    restoreGlobal('navigator',originalGlobals.navigator);
    restoreGlobal('window',originalGlobals.window);
    console.trace=originalGlobals.trace;
});

describe('AI provider configuration and failures', () => {
    it('initializes OpenAI defaults when a legacy profile has no model preferences', async () => {
        globalThis.window.user={ preferredModels:[],ready:true };

        await loadAI();
        const ai=globalThis.window.ai;
        ai.license='test-key';

        assert.equal(ai.llmService,'OPENAI');
        assert.equal(ai.sttService,'OPENAI');
        assert.equal(ai.ttsService,'OPENAI');
        assert.equal(ai.model,'gpt-4o');
        assert.equal(ai.modelSTT,'whisper-1');
        assert.equal(ai.modelTTS,'gpt-4o-mini-tts');
        assert.equal(ai.configured,true);
    });

    it('initializes OpenAI defaults when a legacy profile saved blank model preferences', async () => {
        globalThis.window.user={ preferredModels:['','','','','',''],ready:true };

        await loadAI();
        const ai=globalThis.window.ai;
        ai.license='test-key';

        assert.equal(ai.llmService,'OPENAI');
        assert.equal(ai.model,'gpt-4o');
        assert.equal(ai.configured,true);
    });

    it('rejects an unconfigured OpenAI request before calling fetch', async () => {
        let fetchCalls=0;
        globalThis.fetch=async () => {
            fetchCalls++;
            return jsonResponse();
        };

        const AI=await loadAI();
        const ai=createOpenAI(AI);

        assert.equal(ai.configured,false);
        await assert.rejects(
            ai.fetch(messages),
            error => error?.code==='AI_PROVIDER_NOT_CONFIGURED',
        );
        assert.equal(fetchCalls,0);
    });

    it('allows Ollama requests without an API key', async () => {
        let captured;
        globalThis.fetch=async (url,options) => {
            captured={ options,url };
            return jsonResponse();
        };

        const AI=await loadAI();
        const ai=createOllamaAI(AI);
        const result=await ai.fetch(messages);

        assert.equal(ai.configured,true);
        assert.equal(captured.url,'http://127.0.0.1:11434/v1/chat/completions');
        assert.equal('Authorization' in captured.options.headers,false);
        assert.equal(result.choices[0].message.content,'Hello back');
    });

    it('classifies network failures without exposing provider credentials', async () => {
        const upstreamError=new Error('socket unavailable');
        globalThis.fetch=async () => {
            throw upstreamError;
        };

        const AI=await loadAI();
        const ai=createOllamaAI(AI);

        await assert.rejects(
            ai.fetch(messages),
            error => error?.code==='AI_SERVICE_UNREACHABLE'
                && error.cause===upstreamError,
        );
    });

    it('classifies HTTP failures with their response status', async () => {
        globalThis.fetch=async () => new Response(
            JSON.stringify({ error:{ message:'invalid test credential' } }),
            {
                status:401,
                statusText:'Unauthorized',
                headers:{ 'Content-Type':'application/json' },
            },
        );

        const AI=await loadAI();
        const ai=createOpenAI(AI);
        ai.license='first-test-key';

        await assert.rejects(
            ai.fetch(messages),
            error => error?.code==='AI_REQUEST_FAILED'
                && error.status===401,
        );
    });

    it('uses the latest runtime license for each OpenAI request', async () => {
        const authorization=[];
        globalThis.fetch=async (_url,options) => {
            authorization.push(options.headers.Authorization);
            return jsonResponse();
        };

        const AI=await loadAI();
        const ai=createOpenAI(AI);

        ai.license='first-test-key';
        await ai.fetch(messages);
        ai.license='second-test-key';
        await ai.fetch(messages);

        assert.deepEqual(
            authorization,
            ['Bearer first-test-key','Bearer second-test-key'],
        );
    });

    it('awaits and propagates an asynchronous response callback failure', async () => {
        const callbackError=new Error('callback failed');
        globalThis.fetch=async () => jsonResponse();

        const AI=await loadAI();
        const ai=createOllamaAI(AI);

        await assert.rejects(
            ai.fetch(
                messages,
                async () => {
                    await Promise.resolve();
                    throw callbackError;
                },
            ),
            error => error===callbackError,
        );
    });
});
