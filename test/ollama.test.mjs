import assert from 'node:assert/strict'
import { describe,it } from 'node:test'

const calls=[]
globalThis.Arcane={
    ollama:new Proxy({}, {
        get(_target,method){
            return async (...args)=>{
                calls.push({ method:String(method),args })
                if(method==='chat')return { message:{ content:'chat text' } }
                if(method==='generate')return { response:'generated text' }
                return { method:String(method),args }
            }
        },
    }),
}

const { Ollama,ollama }=await import('../arcane/modules/Ollama.js')

describe('Arcane Ollama module',()=>{
    it('publishes one reusable client',()=>{
        assert(ollama instanceof Ollama)
        assert.equal(globalThis.arcaneOllama,ollama)
    })

    it('delegates model and inference operations to Arcane.ollama',async()=>{
        await ollama.pull('gemma4',{}, { onChunk(){} })
        await ollama.embed({ model:'embeddinggemma',input:'hello' })
        await ollama.selection()
        await ollama.select('120b')
        await ollama.settings()
        await ollama.saveSettings({ defaultModel:'arcane:latest' })
        await ollama.createBrain({ name:'Research',baseModel:'qwen3:20b' })
        await ollama.serviceSettings()
        await ollama.saveServiceSettings({ contextLength:32768 })
        assert.deepEqual(calls.slice(-9).map(call=>call.method),['pull','embed','selection','select','settings','saveSettings','createBrain','serviceSettings','saveServiceSettings'])
        assert.equal(calls.at(-9).args[0],'gemma4')
        assert.deepEqual(calls.at(-6),{ method:'select',args:['120b'] })
    })

    it('provides text and unload conveniences without bypassing Arcane',async()=>{
        assert.equal(await ollama.chatText({ model:'gemma4',messages:[] }),'chat text')
        assert.equal(await ollama.generateText({ model:'gemma4',prompt:'hello' }),'generated text')
        await ollama.unload('gemma4')
        assert.deepEqual(calls.at(-1),{ method:'generate',args:[{ model:'gemma4',prompt:'',keep_alive:0 },undefined] })
    })
})
