import {
    buildAnalysisMessages,
    buildArgumentMessages,
    buildChatMessages,
    buildDraftMessages,
    buildResearchMessages
} from './LegalPrompts.js';

const BUILDERS={
    analysis:buildAnalysisMessages,
    argument:buildArgumentMessages,
    chat:buildChatMessages,
    draft:buildDraftMessages,
    research:buildResearchMessages
};

function responseText(response={}){
    return response?.choices?.[0]?.message?.content
        ||response?.message?.content
        ||response?.output_text
        ||'';
}

function waitForAI(ai=globalThis.ai){
    if(ai?.ready||ai?.configured){
        return Promise.resolve(ai);
    }

    if(globalThis.ai){
        return Promise.resolve(globalThis.ai);
    }

    return new Promise((resolve,reject)=>{
        const timer=setTimeout(
            ()=>reject(Object.assign(new Error('Arcane AI is not configured.'),{code:'AI_PROVIDER_NOT_CONFIGURED'})),
            5000
        );
        globalThis.window?.addEventListener(
            'ai-ready',
            event=>{
                clearTimeout(timer);
                resolve(event.detail?.db||globalThis.ai);
            },
            {once:true}
        );
    });
}

class LegalAssistant {
    constructor({ai=globalThis.ai,systemPrompt=''}={}){
        this.ai=ai;
        this.systemPrompt=systemPrompt;
    }

    async loadSystemPrompt(url='./apps/redress/prompts/system.md'){
        if(this.systemPrompt){
            return this.systemPrompt;
        }
        const response=await fetch(url,{cache:'no-store'});
        if(!response.ok){
            throw new Error(`Unable to load the Redress prompt (${response.status}).`);
        }
        this.systemPrompt=await response.text();
        return this.systemPrompt;
    }

    async generate(kind='analysis',options={}){
        const builder=BUILDERS[kind];
        if(!builder){
            throw new TypeError(`Unknown Redress AI task: ${kind}`);
        }
        if(!this.systemPrompt.trim()){
            const error=new Error('The canonical Redress legal prompt is unavailable.');
            error.code='REDRESS_PROMPT_UNAVAILABLE';
            throw error;
        }
        const ai=await waitForAI(this.ai||globalThis.ai);
        if(globalThis.user?.license_key){
            ai.license=globalThis.user.license_key;
        }
        if(!ai?.configured||ai.redressConfigured!==true){
            const error=new Error('Choose a local Ollama model or add an OpenAI API key before running AI work.');
            error.code='AI_PROVIDER_NOT_CONFIGURED';
            throw error;
        }
        const messages=builder({...options,systemPrompt:options.systemPrompt||this.systemPrompt});
        const response=await ai.fetch(messages,()=>{},false);
        const text=responseText(response);
        if(!text){
            throw new Error('The AI returned an empty response.');
        }
        return {text,messages,response};
    }
}

export {BUILDERS,LegalAssistant,responseText,waitForAI};
export default LegalAssistant;
