import {
    APP_LOCAL_STORAGE_PREFIX,
    resolveBrowserApplicationId
} from './AppDataScope.js';

class DBLS {
    constructor({
        applicationId=null,
        documentObject=globalThis.document,
        storage=globalThis.localStorage
    }={}) {
        if(window.dbls){
            return window.dbls;
        }

        if(!storage
            ||typeof storage.getItem!=='function'
            ||typeof storage.setItem!=='function'){
            const error=new Error('Local storage is unavailable in this browser.');
            error.code='APP_DATA_STORAGE_UNAVAILABLE';
            throw error;
        }

        this.applicationId=resolveBrowserApplicationId({
            applicationId,
            documentObject
        });
        this.storage=storage;
        this.storagePrefix=`${APP_LOCAL_STORAGE_PREFIX}${this.applicationId}:`;
    }

    ready=false;

    storageKey(key='') {
        return `${this.storagePrefix}${String(key)}`;
    }

    logicalKeys() {
        const keys=[];
        for(let index=0;index<this.storage.length;index++){
            const key=this.storage.key(index);
            if(key?.startsWith(this.storagePrefix)){
                keys.push(key.slice(this.storagePrefix.length));
            }
        }
        return keys;
    }

    // Set an item
    set(key='', value) {
        if(typeof value !== 'string' && typeof value !== 'number'){
            value=JSON.stringify(value);
        }
        this.storage.setItem(this.storageKey(key), value);
    }

    // Add new functionality: Set multiple items
    setMany(items) {
        const keys = Object.keys(items);
        for (let i = 0; i < keys.length; i++) {
            this.set(keys[i],items[keys[i]]);
        }
    }

    // Get an item
    get(key) {
        const item = this.storage.getItem(this.storageKey(key));
        try{
            return JSON.parse(item);
        }catch(err){
            return item;
        }
    }

    // Add new functionality: Get many items
    getMany(keys=[]) {
        const items={};
        for (let i = 0; i < keys.length; i++) {
            const item=this.storage.getItem(this.storageKey(keys[i]));
            try{
                items[keys[i]]=JSON.parse(item);
            }catch(err){
                items[keys[i]]=item;
            }
        }

        return items;
    }

    // Add new functionality: Get many items whose keys include a subString
    filterKeyIncludes(subString='') {
        const items={};
        const keys=this.logicalKeys();
        
        for (let i = 0; i < keys.length; i++) {
            //console.log(keys[i],subString);
            if(!keys[i].includes(subString)){
                continue;
            }
            const item=this.storage.getItem(this.storageKey(keys[i]));
            try{
                items[keys[i]]=JSON.parse(item);
            }catch(err){
                items[keys[i]]=item;
            }
        }

        return items;
    }

    // Add new functionality: Get all items
    getAll() {
        const items = {};
        const keys=this.logicalKeys();
        for (let i = 0; i < keys.length; i++) {
            const key=keys[i];
            items[key] = this.storage.getItem(this.storageKey(key));
        }
        return items;
    }

    // Remove an item
    delete(key) {
        this.storage.removeItem(this.storageKey(key));
    }

    // Add new functionality: Remove multiple items
    deleteMany(keys) {
        for (let i = 0; i < keys.length; i++) {
            this.storage.removeItem(this.storageKey(keys[i]));
        }
    }

    // Clear all items
    clear() {
        const keys=this.logicalKeys();
        for(let index=0;index<keys.length;index++){
            this.storage.removeItem(this.storageKey(keys[index]));
        }
    }

    // Get all keys
    getAllKeys() {
        return this.logicalKeys();
    }

    // Check if a key exists
    hasKey(key) {
        return this.storage.getItem(this.storageKey(key)) !== null;
    }

    // Add new functionality: Get item count
    count() {
        return this.logicalKeys().length;
    }
}

if(typeof window.dbls?.get !== "function"){
    window.dbls=new DBLS();
    window.dbls.ready=true;

    const dblsReady=new CustomEvent(
        'dbls-ready', {
            detail: { dbls: window.dbls }
        }
    );

    window.dispatchEvent(dblsReady);
}

export default DBLS;
