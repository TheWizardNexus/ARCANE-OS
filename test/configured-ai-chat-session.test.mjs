import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ConfiguredAIChatSession from '../arcane/modules/ConfiguredAIChatSession.js';

test('configured chat uses injected prompt policy and keeps bounded complete turns',async()=>{
    const requests=[];
    const session=new ConfiguredAIChatSession({
        systemPrompt:'Use the supplied context.',
        contextBuilder:async({input,history})=>{
            assert(Object.isFrozen(history));
            return `Context selected for: ${input}`;
        },
        request:{model:'configured-model'},
        maxMessages:5,
        chat:async request=>{
            requests.push(request);
            const input=request.messages.at(-1).content;
            return {
                provider:' configured-provider ',
                model:' configured-model ',
                message:{role:'assistant',content:`Reply to ${input}`},
                done:true,
                doneReason:' stop ',
                promptEvalCount:request.messages.length,
                evalCount:4,
            };
        },
    });

    await session.send('one');
    await session.send('two');
    const response=await session.send('three');

    assert.equal(requests.at(-1).model,'configured-model');
    assert.deepEqual(requests.at(-1).messages.map(item=>item.role),[
        'system','user','assistant','user','user',
    ]);
    assert.equal(requests.at(-1).messages[0].content,'Use the supplied context.');
    assert.match(requests.at(-1).messages.at(-2).content,/Untrusted context/);
    assert.match(requests.at(-1).messages.at(-2).content,/Context selected for: three/);
    assert.deepEqual(response,{
        provider:'configured-provider',
        model:'configured-model',
        message:{role:'assistant',content:'Reply to three'},
        done:true,
        doneReason:'stop',
        promptEvalCount:5,
        evalCount:4,
    });
    assert.deepEqual(session.history().map(item=>item.role),[
        'system','user','assistant','user','assistant',
    ]);
    assert.equal(session.history()[1].content,'two');
    assert(Object.isFrozen(session.history()));
    assert(Object.isFrozen(session.history()[0]));
    assert.deepEqual(session.clear(),[
        {role:'system',content:'Use the supplied context.'},
    ]);
});

test('configured chat validates its boundary and commits no partial failed turn',async()=>{
    const upstream=new Error('provider unavailable');
    const session=new ConfiguredAIChatSession({
        systemPrompt:'Keep replies concise.',
        chat:async()=>{throw upstream;},
    });

    await assert.rejects(session.send('   '),TypeError);
    await assert.rejects(session.send('valid question'),error=>error===upstream);
    assert.deepEqual(session.history(),[
        {role:'system',content:'Keep replies concise.'},
    ]);
    assert.throws(
        ()=>new ConfiguredAIChatSession({request:{tools:[]},chat:async()=>({})}),
        /managed by the chat session/,
    );

    const malformed=new ConfiguredAIChatSession({
        chat:async()=>({provider:'synthetic',message:{role:'user',content:'wrong role'}}),
    });
    await assert.rejects(
        malformed.send('hello'),
        error=>error?.code==='AI_CHAT_INVALID_RESPONSE',
    );
    assert.deepEqual(malformed.history(),[]);
});

test('configured chat resolves the Arcane profile-aware provider by default',async()=>{
    const original=Object.getOwnPropertyDescriptor(globalThis,'Arcane');
    let received;
    Object.defineProperty(globalThis,'Arcane',{
        configurable:true,
        value:{ai:{chat:async request=>{
            received=request;
            return {
                provider:'profile-provider',
                model:'profile-model',
                message:{role:'assistant',content:'Profile reply'},
            };
        }}},
    });
    try{
        const session=new ConfiguredAIChatSession();
        const response=await session.send('Use my configured provider.');
        assert.equal(received.messages[0].role,'user');
        assert.equal(response.provider,'profile-provider');
        assert.equal(response.done,true);
        assert.equal(response.promptEvalCount,null);
    }finally{
        if(original) Object.defineProperty(globalThis,'Arcane',original);
        else delete globalThis.Arcane;
    }
});

test('shared configured chat source remains domain-neutral',async()=>{
    const source=await readFile(
        new URL('../arcane/modules/ConfiguredAIChatSession.js',import.meta.url),
        'utf8',
    );
    assert.doesNotMatch(source,/Developer|repository|codebase|OpenAI|Ollama/i);
    assert.doesNotMatch(source,/streamMessage|tool_calls|toolCalls/);
});
