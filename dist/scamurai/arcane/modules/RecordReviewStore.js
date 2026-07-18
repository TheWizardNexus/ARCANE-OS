function normalizeRecordId(value=''){
    const id=String(value).trim();
    if(!id||id.length>160||/[\x00-\x1f]/.test(id)) throw new TypeError('A valid record id is required.');
    return id;
}

function normalizeReview(value={}){
    const source=value&&typeof value==='object'?value:{};
    const attributes={};
    if(source.attributes&&typeof source.attributes==='object'&&!Array.isArray(source.attributes)){
        for(const [key,value] of Object.entries(source.attributes).slice(0,40)){
            const normalizedKey=String(key).replace(/[^a-z0-9._-]/gi,'-').slice(0,80);
            if(!normalizedKey) continue;
            attributes[normalizedKey]=Array.isArray(value)
                ?value.slice(0,100).map(item=>String(item).slice(0,500))
                :String(value??'').slice(0,10000);
        }
    }
    return {
        status:String(source.status||'not-reviewed').trim().slice(0,80)||'not-reviewed',
        classification:String(source.classification||'unassigned').trim().slice(0,80)||'unassigned',
        attributes,
        notes:String(source.notes||'').slice(0,10000),
        updatedAt:source.updatedAt?String(source.updatedAt):null
    };
}

function localAdapter(namespace){
    const key=`arcane.record-review:${namespace}`;
    return {
        async get(){
            const raw=globalThis.localStorage?.getItem(key);
            if(!raw) return {};
            try{return JSON.parse(raw);}catch{return {};}
        },
        async set(value){
            globalThis.localStorage?.setItem(key,JSON.stringify(value));
            return value;
        }
    };
}

function nativeAdapter(namespace){
    const storage=globalThis.Arcane?.storage;
    if(!storage?.get||!storage?.set) return null;
    const key=`record-reviews.${namespace}`;
    return {
        async get(){
            const result=await storage.get(key);
            return result?.value??result??{};
        },
        async set(value){ await storage.set(key,value); return value; }
    };
}

class RecordReviewStore extends EventTarget{
    constructor({namespace='records',adapter=null}={}){
        super();
        this.namespace=String(namespace||'records').replace(/[^a-z0-9._-]/gi,'-').slice(0,120);
        this.adapter=adapter||nativeAdapter(this.namespace)||localAdapter(this.namespace);
        this.records={};
        this.loaded=false;
    }

    async load(){
        const stored=await this.adapter.get();
        this.records=stored&&typeof stored==='object'&&!Array.isArray(stored)?stored:{};
        this.loaded=true;
        return this.snapshot();
    }

    get(recordId){
        const id=normalizeRecordId(recordId);
        return normalizeReview(this.records[id]);
    }

    async set(recordId,value={}){
        const id=normalizeRecordId(recordId);
        const review=normalizeReview({...this.get(id),...value,updatedAt:new Date().toISOString()});
        this.records={...this.records,[id]:review};
        await this.adapter.set(this.records);
        this.dispatchEvent(new CustomEvent('record-review-change',{detail:{recordId:id,review:{...review}}}));
        return {...review};
    }

    snapshot(){
        return Object.fromEntries(Object.entries(this.records).map(([id,value])=>[id,normalizeReview(value)]));
    }
}

export {normalizeRecordId,normalizeReview};
export default RecordReviewStore;
