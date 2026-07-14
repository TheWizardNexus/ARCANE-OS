import CommunicationMessage from '../entities/CommunicationMessage.js';
import CommunicationThread from '../entities/CommunicationThread.js';
import CommunicationProviderRegistry from './CommunicationProviderRegistry.js';

export default class CommunicationHub extends EventTarget{
    constructor({providers=[],enabledProviderIds=[]}={}){super();this.registry=providers instanceof CommunicationProviderRegistry?providers:new CommunicationProviderRegistry(providers);this.enabled=new Set(enabledProviderIds);this.threads=[];}
    setEnabled(ids=[]){this.enabled=new Set(Array.from(ids,String));return this;}
    enabledProviders(){return this.registry.list().filter(provider=>this.enabled.has(provider.id));}
    async refresh(){
        const results=await Promise.allSettled(this.enabledProviders().map(async provider=>(await provider.listThreads()).map(value=>value instanceof CommunicationThread?value:new CommunicationThread({...value,providerId:provider.id}))));
        const errors=[];const threads=[];for(const result of results){if(result.status==='fulfilled') threads.push(...result.value);else errors.push(result.reason);}
        this.threads=threads.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));this.dispatchEvent(new CustomEvent('communications-refresh',{detail:{threads:[...this.threads],errors}}));return {threads:[...this.threads],errors};
    }
    async messages(thread){const record=thread instanceof CommunicationThread?thread:new CommunicationThread(thread);const values=await this.registry.get(record.providerId).getMessages(record.id);return values.map(value=>value instanceof CommunicationMessage?value:new CommunicationMessage({...value,threadId:record.id,providerId:record.providerId,channel:record.channel})).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));}
    async send({providerId,threadId,channel,body,subject='',recipients=[]}={}){if(!String(body||'').trim()) throw new TypeError('A message body is required.');return this.registry.get(providerId).send({threadId,channel,body:String(body),subject:String(subject),recipients:Array.from(recipients||[])});}
}
