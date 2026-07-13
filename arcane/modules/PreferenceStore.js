import Preference,{preferenceSchema} from '../entities/Preference.js';

function localAdapter(prefix){
    const storage=globalThis.localStorage;
    return {
        async get(key){
            const raw=storage?.getItem(`${prefix}:${key}`);
            return {found:raw!==null&&raw!==undefined,value:raw==null?null:JSON.parse(raw)};
        },
        async set(key,value){ storage?.setItem(`${prefix}:${key}`,JSON.stringify(value)); return {key,value}; },
        async delete(key){ storage?.removeItem(`${prefix}:${key}`); return {key,deleted:true}; }
    };
}

function nativeAdapter(){
    const preferences=globalThis.Arcane?.preferences;
    if(!preferences?.get||!preferences?.set||!preferences?.delete) return null;
    return preferences;
}

export default class PreferenceStore extends EventTarget{
    constructor({namespace='arcane',schema=[],adapter=null}={}){
        super();
        this.namespace=String(namespace||'arcane');
        this.schema=preferenceSchema(schema);
        this.adapter=adapter||nativeAdapter()||localAdapter('arcane.preferences');
        this.values=this.defaults();
    }

    defaults(){
        return Object.fromEntries(this.schema.map(item=>[item.key,item.defaultValue]));
    }

    storageKey(key){ return `${this.namespace}.${key}`; }

    definition(key){
        const definition=this.schema.find(item=>item.key===key);
        if(!definition) throw new RangeError(`Unknown preference: ${key}`);
        return definition;
    }

    async load(){
        const values=this.defaults();
        await Promise.all(this.schema.map(async definition=>{
            const result=await this.adapter.get(this.storageKey(definition.key));
            if(result?.found) values[definition.key]=definition.value(result.value);
        }));
        this.values=values;
        this.emit('load');
        return {...values};
    }

    async set(key,value){
        const definition=this.definition(key);
        const normalized=definition.value(value);
        await this.adapter.set(this.storageKey(key),normalized);
        this.values={...this.values,[key]:normalized};
        this.emit('change',{key,value:normalized});
        return normalized;
    }

    async setAll(values={}){
        for(const definition of this.schema){
            if(Object.prototype.hasOwnProperty.call(values,definition.key)) await this.set(definition.key,values[definition.key]);
        }
        return {...this.values};
    }

    async reset(){
        await Promise.all(this.schema.map(definition=>this.adapter.delete(this.storageKey(definition.key))));
        this.values=this.defaults();
        this.emit('reset');
        return {...this.values};
    }

    emit(type,detail={}){
        this.dispatchEvent(new CustomEvent(`preference-${type}`,{detail:{values:{...this.values},...detail}}));
    }
}

export {Preference,preferenceSchema};
