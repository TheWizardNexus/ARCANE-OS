import {resolveApplicationLocalStorageKey} from './AppDataScope.js';

function adapter(){
    const native=globalThis.Arcane?.preferences;
    if(native?.get&&native?.set) return native;
    return {async get(key){const value=globalThis.localStorage?.getItem(resolveApplicationLocalStorageKey(key));return {found:value!=null,value:value==null?null:JSON.parse(value)}},async set(key,value){globalThis.localStorage?.setItem(resolveApplicationLocalStorageKey(key),JSON.stringify(value));return {key,value}}};
}

export default class CommunicationPreferences{
    constructor(namespace='communications'){this.key=`arcane.communications.${String(namespace)}`;this.adapter=adapter();}
    async load(defaults={}){const result=await this.adapter.get(this.key);return result?.found&&result.value&&typeof result.value==='object'?{...defaults,...result.value}:{...defaults};}
    async save(values={}){const safe=Object.fromEntries(Object.entries(values).map(([id,value])=>[id,{enabled:Boolean(value?.enabled),endpoint:String(value?.endpoint||''),accountLabel:String(value?.accountLabel||''),status:String(value?.status||'Disconnected')} ]));await this.adapter.set(this.key,safe);return safe;}
}
