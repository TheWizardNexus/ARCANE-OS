import {
    canonicalApplicationId,
    openApplicationDataDirectory
} from './AppDataScope.js';

const DEFAULT_MAX_ENTRY_BYTES=4*1024*1024;
const MAX_NAMESPACE_LENGTH=96;
const MAX_KEY_LENGTH=240;

function safeSegment(value,label,maximum){
    if(typeof value!=='string'){
        throw new TypeError(`${label} must be a string.`);
    }
    const normalized=value.trim();
    if(!normalized||normalized.length>maximum){
        throw new RangeError(`${label} must contain between 1 and ${maximum} characters.`);
    }
    if(normalized==='.'||normalized==='..'||/[\\/\0]/u.test(normalized)){
        throw new TypeError(`${label} must be one filename-safe segment.`);
    }
    return normalized;
}

function positiveInteger(value,label,maximum){
    if(!Number.isSafeInteger(value)||value<1||value>maximum){
        throw new RangeError(`${label} must be an integer between 1 and ${maximum}.`);
    }
    return value;
}

function unavailable(){
    const error=new Error('Origin Private File System storage is unavailable in this browser.');
    error.code='OPFS_UNAVAILABLE';
    return error;
}

function entryTooLarge(maximum){
    const error=new RangeError(`The cache entry exceeds the ${maximum}-byte limit.`);
    error.code='OPFS_CACHE_ENTRY_TOO_LARGE';
    return error;
}

/**
 * A deliberately narrow JSON cache over one application-owned OPFS directory.
 *
 * It exposes only exact-key get, set, and delete operations. It never enumerates,
 * exports, restores, clears, or selects another namespace, so one consumer cannot
 * accidentally mutate unrelated origin storage.
 */
export default class ScopedOPFSCache{
    #applicationId;
    #arcane;
    #directoryPromise=null;
    #documentObject;
    #maxEntryBytes;
    #namespace;
    #storage;

    constructor({
        applicationId=null,
        namespace,
        maxEntryBytes=DEFAULT_MAX_ENTRY_BYTES,
        storage=globalThis.navigator?.storage,
        documentObject=globalThis.document,
        arcane=globalThis.Arcane
    }={}){
        this.#applicationId=applicationId==null||applicationId===''
            ?null
            :canonicalApplicationId(applicationId);
        this.#namespace=safeSegment(namespace,'namespace',MAX_NAMESPACE_LENGTH);
        this.#maxEntryBytes=positiveInteger(maxEntryBytes,'maxEntryBytes',64*1024*1024);
        if(!storage||typeof storage.getDirectory!=='function'){
            throw unavailable();
        }
        this.#storage=storage;
        this.#documentObject=documentObject;
        this.#arcane=arcane;
    }

    static supported(storage=globalThis.navigator?.storage){
        return Boolean(storage&&typeof storage.getDirectory==='function');
    }

    get namespace(){
        return this.#namespace;
    }

    get applicationId(){
        return this.#applicationId;
    }

    get maxEntryBytes(){
        return this.#maxEntryBytes;
    }

    async #directory(){
        if(!this.#directoryPromise){
            this.#directoryPromise=(async()=>{
                const scope=await openApplicationDataDirectory({
                    storage:this.#storage,
                    applicationId:this.#applicationId,
                    documentObject:this.#documentObject,
                    arcane:this.#arcane,
                    create:true
                });
                this.#applicationId=scope.applicationId;
                return scope.directory.getDirectoryHandle(
                    this.#namespace,
                    {create:true}
                );
            })().catch(error=>{
                this.#directoryPromise=null;
                throw error;
            });
        }
        return this.#directoryPromise;
    }

    async get(key){
        const normalized=safeSegment(key,'key',MAX_KEY_LENGTH);
        try{
            const directory=await this.#directory();
            const handle=await directory.getFileHandle(normalized);
            const file=await handle.getFile();
            if(file.size>this.#maxEntryBytes){
                await this.delete(normalized).catch(()=>{});
                return undefined;
            }
            const source=await file.text();
            if(new TextEncoder().encode(source).byteLength>this.#maxEntryBytes){
                await this.delete(normalized).catch(()=>{});
                return undefined;
            }
            try{
                return JSON.parse(source);
            }catch{
                await this.delete(normalized).catch(()=>{});
                return undefined;
            }
        }catch(error){
            if(error?.name==='NotFoundError'||error?.code==='ENOENT'){
                return undefined;
            }
            throw error;
        }
    }

    async set(key,value){
        const normalized=safeSegment(key,'key',MAX_KEY_LENGTH);
        const source=JSON.stringify(value);
        if(source===undefined){
            throw new TypeError('Cache values must be JSON serializable.');
        }
        if(new TextEncoder().encode(source).byteLength>this.#maxEntryBytes){
            throw entryTooLarge(this.#maxEntryBytes);
        }
        const directory=await this.#directory();
        const handle=await directory.getFileHandle(normalized,{create:true});
        const writable=await handle.createWritable();
        try{
            await writable.write(source);
            await writable.close();
        }catch(error){
            await writable.abort?.().catch(()=>{});
            throw error;
        }
        return value;
    }

    async delete(key){
        const normalized=safeSegment(key,'key',MAX_KEY_LENGTH);
        const directory=await this.#directory();
        try{
            await directory.removeEntry(normalized);
            return true;
        }catch(error){
            if(error?.name==='NotFoundError'||error?.code==='ENOENT'){
                return false;
            }
            throw error;
        }
    }
}
