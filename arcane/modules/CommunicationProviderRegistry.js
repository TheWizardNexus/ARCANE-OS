const PROVIDER_ID=/^[a-z0-9][a-z0-9._-]{1,63}$/;

export default class CommunicationProviderRegistry{
    constructor(providers=[]){this.providers=new Map();for(const provider of providers) this.register(provider);}
    register(provider){
        const id=String(provider?.id||'').trim().toLowerCase();
        if(!PROVIDER_ID.test(id)) throw new TypeError('Communication provider id is invalid.');
        for(const method of ['listThreads','getMessages','send']) if(typeof provider[method]!=='function') throw new TypeError(`Provider ${id} must implement ${method}().`);
        if(this.providers.has(id)) throw new RangeError(`Communication provider already registered: ${id}`);
        this.providers.set(id,{...provider,id,label:String(provider.label||id),channels:Object.freeze(Array.from(provider.channels||['other']))});
        return this.get(id);
    }
    get(id){const provider=this.providers.get(String(id||'').toLowerCase());if(!provider) throw new RangeError(`Unknown communication provider: ${id}`);return provider;}
    has(id){return this.providers.has(String(id||'').toLowerCase());}
    list(){return Array.from(this.providers.values());}
}
