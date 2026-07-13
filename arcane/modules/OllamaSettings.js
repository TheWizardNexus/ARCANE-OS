import {preferenceSchema} from '../entities/Preference.js';

export const ollamaRuntimeSchema=preferenceSchema([
    {key:'bootLoad',type:'boolean',label:'Load default model at boot',description:'Preload the default model after ArcaneOllama and Arcane Core are ready.',defaultValue:true},
    {key:'bootKeepAlive',type:'select',label:'Boot model memory',description:'How long the boot-loaded model remains in memory.',defaultValue:'-1',options:[{label:'Keep loaded',value:'-1'},{label:'5 minutes',value:'5m'},{label:'30 minutes',value:'30m'},{label:'1 hour',value:'1h'},{label:'24 hours',value:'24h'}]},
    {key:'contextLength',type:'number',label:'Model context length',description:'Use 0 for automatic, or choose 1,024–262,144 tokens. Larger contexts require more memory.',defaultValue:0,minimum:0,maximum:262144,step:1024},
]);

export const ollamaServiceSchema=preferenceSchema([
    {key:'contextLength',type:'number',label:'Server context length',description:'Global OLLAMA_CONTEXT_LENGTH. Use 0 for Ollama automatic sizing.',defaultValue:0,minimum:0,maximum:262144,step:1024},
    {key:'keepAlive',type:'text',label:'Server keep alive',description:'Global duration such as 5m or 1h; -1 keeps models loaded.',defaultValue:'5m'},
    {key:'maxLoadedModels',type:'number',label:'Maximum loaded models',description:'Use 0 for Ollama automatic sizing.',defaultValue:0,minimum:0,maximum:16,step:1},
    {key:'numParallel',type:'number',label:'Parallel requests per model',description:'Higher values multiply context memory requirements.',defaultValue:1,minimum:1,maximum:16,step:1},
    {key:'maxQueue',type:'number',label:'Maximum request queue',description:'Requests beyond this limit receive an overload response.',defaultValue:512,minimum:1,maximum:4096,step:1},
    {key:'flashAttention',type:'boolean',label:'Flash Attention',description:'Reduce context memory use on supported hardware.',defaultValue:false},
    {key:'kvCacheType',type:'select',label:'K/V cache precision',description:'Quantized caches save memory and may slightly affect quality.',defaultValue:'f16',options:[{label:'f16 — highest precision',value:'f16'},{label:'q8_0 — balanced',value:'q8_0'},{label:'q4_0 — lowest memory',value:'q4_0'}]},
    {key:'noCloud',type:'boolean',label:'Local-only mode',description:'Disable Ollama cloud models and cloud features.',defaultValue:true},
]);

export function arcaneBrainModelName(name=''){
    const slug=String(name).trim().toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64);
    if(!slug) throw new TypeError('Enter a name for this Arcane brain.');
    return `arcane-${slug}:latest`;
}
