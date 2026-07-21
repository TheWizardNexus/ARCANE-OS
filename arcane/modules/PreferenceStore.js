import Preference,{preferenceSchema} from '../entities/Preference.js';
import {resolveApplicationLocalStorageKey} from './AppDataScope.js';

function localAdapter(prefix){
    const storage=globalThis.localStorage;
    const scopedPrefix=resolveApplicationLocalStorageKey(prefix);
    return {
        async get(key){
            const raw=storage?.getItem(`${scopedPrefix}:${key}`);
            return {found:raw!==null&&raw!==undefined,value:raw==null?null:JSON.parse(raw)};
        },
        async set(key,value){ storage?.setItem(`${scopedPrefix}:${key}`,JSON.stringify(value)); return {key,value}; },
        async delete(key){ storage?.removeItem(`${scopedPrefix}:${key}`); return {key,deleted:true}; }
    };
}

function nativeAdapter(){
    const preferences=globalThis.Arcane?.preferences;
    if(!preferences?.get||!preferences?.set||!preferences?.delete) return null;
    return preferences;
}

function isUnsupportedNativeAdapter(error){
    return error?.code==='ANDROID_CAPABILITY_UNSUPPORTED';
}

function preferenceAdapter(){
    const local=localAdapter('arcane.preferences');
    if(typeof globalThis.arcaneAndroid?.postMessage==='function') return local;
    const native=nativeAdapter();
    if(!native) return local;
    let active=native;
    async function call(method,args){
        try{
            return await active[method](...args);
        }catch(error){
            if(active!==native||!isUnsupportedNativeAdapter(error)) throw error;
            active=local;
            return active[method](...args);
        }
    }
    return {
        get:key=>call('get',[key]),
        set:(key,value)=>call('set',[key,value]),
        delete:key=>call('delete',[key])
    };
}

export default class PreferenceStore extends EventTarget{
    constructor({namespace='arcane',schema=[],adapter=null}={}){
        super();
        this.namespace=String(namespace||'arcane');
        this.schema=preferenceSchema(schema);
        this.adapter=adapter||preferenceAdapter();
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
