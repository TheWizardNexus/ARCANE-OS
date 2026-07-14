/**
 * First-class browser module for Arcane's capability-gated Ollama service.
 * Apps should import this module instead of connecting to localhost:11434.
 */
function api(){
    const client=globalThis.Arcane?.ollama
    if(!client){
        const error=new Error('The Arcane Ollama API is unavailable. Open this app through Arcane OS.')
        error.code='ARCANE_OLLAMA_UNAVAILABLE'
        throw error
    }
    return client
}

export class Ollama{
    version(){ return api().version() }
    models(){ return api().models() }
    list(){ return api().models() }
    running(){ return api().running() }
    show(model,options){ return api().show(model,options) }
    generate(request,options){ return api().generate(request,options) }
    chat(request,options){ return api().chat(request,options) }
    embed(request){ return api().embed(request) }
    pull(model,options,streamOptions){ return api().pull(model,options,streamOptions) }
    push(model,options,streamOptions){ return api().push(model,options,streamOptions) }
    create(request,options){ return api().create(request,options) }
    copy(source,destination){ return api().copy(source,destination) }
    delete(model){ return api().delete(model) }
    selection(){ return api().selection() }
    select(preference){ return api().select(preference) }
    settings(){ return api().settings() }
    saveSettings(settings){ return api().saveSettings(settings) }
    createBrain(definition){ return api().createBrain(definition) }
    serviceSettings(){ return api().serviceSettings() }
    saveServiceSettings(settings){ return api().saveServiceSettings(settings) }

    async generateText(request,options){
        const response=await this.generate(request,options)
        return String(response?.response||'')
    }

    async chatText(request,options){
        const response=await this.chat(request,options)
        return String(response?.message?.content||'')
    }

    unload(model){
        return this.generate({ model,prompt:'',keep_alive:0 })
    }
}

export const ollama=Object.freeze(new Ollama())
export default ollama

if(!Object.prototype.hasOwnProperty.call(globalThis,'arcaneOllama')){
    Object.defineProperty(globalThis,'arcaneOllama',{ value:ollama,enumerable:true,configurable:false,writable:false })
}
globalThis.dispatchEvent?.(new CustomEvent('arcane-ollama-ready',{ detail:{ ollama } }))
