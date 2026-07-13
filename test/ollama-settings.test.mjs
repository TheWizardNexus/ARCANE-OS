import assert from 'node:assert/strict';
import test from 'node:test';
import {arcaneBrainModelName,ollamaRuntimeSchema,ollamaServiceSchema} from '../arcane/modules/OllamaSettings.js';

test('Ollama settings expose bounded reusable preference schemas',()=>{
    assert.deepEqual(ollamaRuntimeSchema.map(item=>item.key),['bootLoad','bootKeepAlive','contextLength']);
    assert.equal(ollamaRuntimeSchema.find(item=>item.key==='contextLength').value(999999),262144);
    assert.deepEqual(ollamaServiceSchema.map(item=>item.key),['contextLength','keepAlive','maxLoadedModels','numParallel','maxQueue','flashAttention','kvCacheType','noCloud']);
    assert.equal(ollamaServiceSchema.find(item=>item.key==='kvCacheType').value('unsafe'),'f16');
});

test('custom Arcane brain names are deterministic Ollama model names',()=>{
    assert.equal(arcaneBrainModelName('My Research Brain'),'arcane-my-research-brain:latest');
    assert.equal(arcaneBrainModelName(' Legal / Local '),'arcane-legal-local:latest');
    assert.throws(()=>arcaneBrainModelName('***'),/Enter a name/);
});
