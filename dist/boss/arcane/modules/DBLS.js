class DBLS {
    constructor() {
        if(window.dbls){
            return window.dbls;
        }

        this.storage = window.localStorage;
    }

    ready=false;

    // Set an item
    set(key='', value) {
        if(typeof value !== 'string' && typeof value !== 'number'){
            value=JSON.stringify(value);
        }
        this.storage.setItem(key, value);
    }

    // Add new functionality: Set multiple items
    setMany(items) {
        const keys = Object.keys(items);
        for (let i = 0; i < keys.length; i++) {
            this.storage.setItem(keys[i], items[keys[i]]);
        }
    }

    // Get an item
    get(key) {
        const item = this.storage.getItem(key);
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
            const item=this.storage.getItem(keys[i]);
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
        const keys=Object.keys(this.storage);
        
        for (let i = 0; i < keys.length; i++) {
            //console.log(keys[i],subString);
            if(!keys[i].includes(subString)){
                continue;
            }
            const item=this.storage.getItem(keys[i]);
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
        for (let i = 0; i < this.storage.length; i++) {
            const key = this.storage.key(i);
            items[key] = this.storage.getItem(key);
        }
        return items;
    }

    // Remove an item
    delete(key) {
        this.storage.removeItem(key);
    }

    // Add new functionality: Remove multiple items
    deleteMany(keys) {
        for (let i = 0; i < keys.length; i++) {
            this.storage.removeItem(keys[i]);
        }
    }

    // Clear all items
    clear() {
        this.storage.clear();
    }

    // Get all keys
    getAllKeys() {
        return Object.keys(this.storage);
    }

    // Check if a key exists
    hasKey(key) {
        return this.storage.getItem(key) !== null;
    }

    // Add new functionality: Get item count
    count() {
        return this.storage.length;
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