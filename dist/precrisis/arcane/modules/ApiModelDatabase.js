import ApiModelRecord from '../entities/ApiModelRecord.js';

function event(type,detail){return new CustomEvent(type,{detail});}
function endpoint(value){const url=new URL(String(value||''));if(!['http:','https:'].includes(url.protocol))throw new TypeError('API model endpoints must use HTTP or HTTPS.');return url.href;}
function appendParameters(url,parameters={}){for(const [key,value] of Object.entries(parameters||{})){if(value===undefined||value===null||value==='')continue;url.searchParams.set(key,Array.isArray(value)?value.join(','):String(value));}return url;}
function publicEndpoint(url){const safe=new URL(url);for(const key of [...safe.searchParams.keys()])if(/(?:auth|key|password|secret|token)/i.test(key))safe.searchParams.set(key,'[redacted]');return safe.href;}

export default class ApiModelDatabase extends EventTarget{
    constructor({endpoint:source,parser=value=>value,fetchImpl=globalThis.fetch,cache=null,request={}}={}){super();this.endpoint=endpoint(source);if(typeof parser!=='function')throw new TypeError('API model parser must be a function.');if(typeof fetchImpl!=='function')throw new TypeError('API model fetch implementation must be a function.');this.parser=parser;this.fetchImpl=fetchImpl;this.cache=cache;this.request={...request};this.latest=null;}
    setEndpoint(value){this.endpoint=endpoint(value);return this.endpoint;}
    async fetch(parameters={},context={}){
        const url=appendParameters(new URL(this.endpoint),parameters);const visibleEndpoint=publicEndpoint(url);const requestId=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this.dispatchEvent(event('api-model-request',{requestId,endpoint:visibleEndpoint}));
        try{
            const response=await this.fetchImpl(url,{method:'GET',...this.request,headers:{Accept:'application/json',...(this.request.headers||{})}});const raw=await response.json();
            if(!response.ok)throw new Error(raw?.reason||raw?.error||`API request failed (${response.status}).`);
            const value=await this.parser(raw,{context,endpoint:url.href,response:{status:response.status,headers:response.headers}});const record=new ApiModelRecord({endpoint:visibleEndpoint,value,metadata:{requestId,status:response.status}});this.latest=record;
            if(this.cache?.set)await this.cache.set(visibleEndpoint,record.toJSON());
            this.dispatchEvent(event('api-model-success',{requestId,record}));return record;
        }catch(error){this.dispatchEvent(event('api-model-error',{requestId,endpoint:visibleEndpoint,error}));throw error;}
    }
    async cached(parameters={}){const url=appendParameters(new URL(this.endpoint),parameters);if(!this.cache?.get)return null;const value=await this.cache.get(publicEndpoint(url));return value?new ApiModelRecord(value):null;}
}

export {appendParameters,publicEndpoint};
