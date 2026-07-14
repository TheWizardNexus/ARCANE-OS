import CommunicationMessage from '../entities/CommunicationMessage.js';
import CommunicationThread from '../entities/CommunicationThread.js';

function cleanEndpoint(value){const url=new URL(String(value||'http://127.0.0.1:8020'));if(!['http:','https:'].includes(url.protocol)) throw new TypeError('Bridge URL must use HTTP or HTTPS.');return url.href.replace(/\/$/,'');}

export default class ArcaneCommunicationBridge{
    constructor({id,label,channels,endpoint='http://127.0.0.1:8020',fetchImpl=globalThis.fetch}={}){
        this.id=String(id||'arcane-bridge');this.label=String(label||'Arcane communications bridge');this.channels=Array.from(channels||['other']);this.endpoint=cleanEndpoint(endpoint);this.fetchImpl=fetchImpl;
    }
    async request(path,options={}){
        if(typeof this.fetchImpl!=='function') throw new Error('Network access is unavailable.');
        const response=await this.fetchImpl(`${this.endpoint}${path}`,{...options,headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
        const text=await response.text();let body={};if(text){try{body=JSON.parse(text);}catch{throw new Error('The communications bridge returned invalid JSON.');}}
        if(!response.ok) throw new Error(body.error||`Communications bridge request failed (${response.status}).`);
        return body;
    }
    async listThreads(){const body=await this.request(`/v1/providers/${encodeURIComponent(this.id)}/threads`);return Array.from(body.threads||[],value=>new CommunicationThread({...value,providerId:this.id}));}
    async getMessages(threadId){const body=await this.request(`/v1/providers/${encodeURIComponent(this.id)}/threads/${encodeURIComponent(threadId)}/messages`);return Array.from(body.messages||[],value=>new CommunicationMessage({...value,threadId,providerId:this.id}));}
    async send(input={}){const body=await this.request(`/v1/providers/${encodeURIComponent(this.id)}/messages`,{method:'POST',body:JSON.stringify(input)});return new CommunicationMessage({...body.message,providerId:this.id,threadId:body.message?.threadId||input.threadId,direction:'outbound'});}
    async connect(){return this.request(`/v1/providers/${encodeURIComponent(this.id)}/connect`,{method:'POST'});}
    async disconnect(){return this.request(`/v1/providers/${encodeURIComponent(this.id)}/disconnect`,{method:'POST'});}
}
