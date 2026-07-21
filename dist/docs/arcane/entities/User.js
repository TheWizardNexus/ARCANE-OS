import Is from '../../node_modules/strong-type/index.js';
import DBLS from '../modules/DBLS.js';

/**
 * DBOPFS Module
 *
 * This import initializes the DBOPFS singleton.
 *
 * The module attaches itself to the global scope:
 *
 *     window.dbopfs
 *
 * Engineers can access persistence anywhere via:
 *
 *     dbopfs.get(...)
 *     dbopfs.set(...)
 *
 * The import must remain even if unused because it registers the singleton.
 */
import DBOPFS from '../modules/DBOPFS.js';

function createDefaultDashboard(){
    return { charts:{} };
}

function normalizeDashboard(dashboard={}){
    const source=dashboard&&typeof dashboard==='object'&&!Array.isArray(dashboard)
        &&dashboard.charts&&typeof dashboard.charts==='object'&&!Array.isArray(dashboard.charts)
        ? dashboard.charts
        : {};
    const charts={};

    for(const [key,value] of Object.entries(source)){
        if(typeof value==='boolean'){
            charts[key]=value;
        }
    }

    return { charts };
}

const is = new Is(false);

/**
 * Email validation pattern
 */
const EMAIL_REGEX =
/^[^\s@]+@[^\s@]+\.[^\s@]+$/;


/**
 * Canonical schema for a UserEntity record.
 *
 * @typedef {Object} UserEntityData
 * @property {string|number} username
 * @property {string} email
 * @property {string|number} phone
 * @property {string} license_key
 * @property {string} subscription_key
 * @property {string|number} contact_1
 * @property {string|number} contact_2
 * @property {string|number} contact_3
 * @property {string|number} contact_4
 * @property {string|number} contact_5
 * @property {string|number} contact_6
 * @property {string} AI_personality
 * @property {string} religion
 * @property {string} AI_voice
 * @property {boolean} initialSpeechMuted
 * @property {string|number} skin
 * @property {boolean} preferrsLocal
 * @property {boolean} developer
 * @property {array} preferredModels
 * @property {{charts:Object<string,boolean>}} dashboard
 */


class UserEntity {

    /** @type {string} */
    #tableName = 'users';

    /** @type {string} */
    fileName = 'users.json';

    /**
     * Controls automatic persistence
     *
     * @type {boolean}
     */
    persist = true;

    ready = false;

    #loadPromise = null;

    #schema = Object.freeze(
        [
            'username',
            'email',
            'phone',
            'language',
            'license_key',
            'subscription_key',

            'contact_1',
            'contact_2',
            'contact_3',
            'contact_4',
            'contact_5',
            'contact_6',

            'AI_personality',
            'religion',
            'AI_voice',
            'initialSpeechMuted',
            'skin',
            'developer',
            'prefersLocal',
            'preferredModels',
            'dashboard'
        ]
    );



    #username = '';
    #email = '';
    #phone = '';
    #license_key = '';
    #subscription_key = '';
    #language = '';

    #contact_1 = '';
    #contact_2 = '';
    #contact_3 = '';
    #contact_4 = '';
    #contact_5 = '';
    #contact_6 = '';

    #AI_personality = '';
    #religion = '';
    #AI_voice = '';
    #initialSpeechMuted = true;
    #skin = 'default';
    #developer = false;
    #prefersLocal = false;
    #preferredModels = [];
    #dashboard = createDefaultDashboard();
    

    /**
     * Create a new UserEntity
     *
     * @param {string} fileName
     */
    constructor(
        fileName = ''
    ){
        if(window.user){
            return window.user;
        }

        if(!is.string(fileName) || !fileName){
            fileName=this.fileName;
        }

        this.fileName = fileName;

        window.addEventListener(
            'dbopfs-ready',
            this.load.bind(this)
        );

        if(window.dbopfs?.ready){
            this.load();
        }

        return this;
    }


    /** @returns {string|number} */
    get username(){
        return this.#username;
    }

    /** @param {string|number} v */
    set username(v){
        if(!is.union(v,'string','number')){
            throw new Error('username must be string or number');
        }

        this.#username = v;

        this.#persist();
    }



    /** @returns {string} */
    get email(){
        return this.#email;
    }

    /** @param {string} v */
    set email(v){
        if(!is.string(v)){
            throw new Error('email must be string');
        }

        if(v.length>0 && !EMAIL_REGEX.test(v)){
            //throw new Error('email must be a valid email address');
        }

        this.#email = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get phone(){
        return this.#phone;
    }

    /** @param {string|number} v */
    set phone(v){
        if(!is.union(v,'string','number')){
            throw new Error('phone must be string or number');
        }

        this.#phone = v;

        this.#persist();
    }



    /** @returns {string} */
    get license_key(){
        return this.#license_key;
    }

    /** @param {string} v */
    set license_key(v){
        if(!is.string(v)){
            throw new Error('license_key must be string');
        }

        this.#license_key = v;

        this.#persist();
    }

    /** @returns {string} */
    get subscription_key(){
        return this.#subscription_key;
    }

    /** @param {string} v */
    set subscription_key(v){
        if(!is.string(v)){
            throw new Error('subscription_key must be string');
        }

        this.#subscription_key = v;

        this.#persist();
    }

     /** @returns {string} */
    get language(){
        return this.#language;
    }

    /** @param {string} v */
    set language(v){
        if(!is.string(v)){
            throw new Error('language must be string');
        }

        this.#language = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_1(){
        return this.#contact_1;
    }

    /** @param {string|number} v */
    set contact_1(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_1 must be string or number');
        }

        this.#contact_1 = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_2(){
        return this.#contact_2;
    }

    /** @param {string|number} v */
    set contact_2(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_2 must be string or number');
        }

        this.#contact_2 = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_3(){
        return this.#contact_3;
    }

    /** @param {string|number} v */
    set contact_3(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_3 must be string or number');
        }

        this.#contact_3 = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_4(){
        return this.#contact_4;
    }

    /** @param {string|number} v */
    set contact_4(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_4 must be string or number');
        }

        this.#contact_4 = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_5(){
        return this.#contact_5;
    }

    /** @param {string|number} v */
    set contact_5(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_5 must be string or number');
        }

        this.#contact_5 = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get contact_6(){
        return this.#contact_6;
    }

    /** @param {string|number} v */
    set contact_6(v){
        if(!is.union(v,'string','number')){
            throw new Error('contact_6 must be string or number');
        }

        this.#contact_6 = v;

        this.#persist();
    }



    /** @returns {string} */
    get AI_personality(){
        return this.#AI_personality;
    }

    /** @param {string} v */
    set AI_personality(v){
        if(!is.string(v)){
            throw new Error('AI_personality must be string');
        }

        if(v.length > 1000){
            throw new Error('AI_personality must be less than 1000 characters');
        }

        this.#AI_personality = v;

        this.#persist();
    }



    /** @returns {string} */
    get religion(){
        return this.#religion;
    }

    /** @param {string} v */
    set religion(v){
        if(!is.string(v)){
            throw new Error('religion must be string');
        }

        this.#religion = v;

        this.#persist();
    }



    /** @returns {string} */
    get AI_voice(){
        return this.#AI_voice;
    }

    /** @param {string} v */
    set AI_voice(v){
        if(!is.string(v)){
            throw new Error('AI_voice must be string');
        }

        this.#AI_voice = v;

        this.#persist();
    }



    /** @returns {boolean} */
    get initialSpeechMuted(){
        return this.#initialSpeechMuted;
    }

    /** @param {boolean} v */
    set initialSpeechMuted(v){
        if(!is.boolean(v)){
            throw new Error('initialSpeechMuted must be boolean');
        }

        this.#initialSpeechMuted = v;

        this.#persist();
    }



    /** @returns {string|number} */
    get skin(){
        return this.#skin;
    }

    /** @param {string|number} v */
    set skin(v){
        if(!is.union(v,'string','number')){
            throw new Error('skin must be string or number');
        }

        this.#skin = v;

        this.#persist();
    }


    /** @returns {boolean} */
    get developer(){
        return this.#developer;
    }

    /** @param {boolean} v */
    set developer(v){
        if(!is.boolean(v)){
            throw new Error('developer must be boolean');
        }

        this.#developer = v;

        this.#persist();
    }



    /** @returns {boolean} */
    get prefersLocal(){
        return this.#prefersLocal;
    }

    /** @param {boolean} v */
    set prefersLocal(v){
        if(!is.boolean(v)){
            throw new Error('prefersLocal must be boolean');
        }

        this.#prefersLocal = v;

        this.#persist();
    }

    /** @returns {array} */
    get preferredModels(){
        return this.#preferredModels;
    }

    /** @param {array} v */
    set preferredModels(v){
        if(!is.array(v)){
            throw new Error('preferredModels must be an array');
        }

        this.#preferredModels = v;

        this.#persist();
    }

    /** @returns {{charts:Object<string,boolean>}} */
    get dashboard(){
        return {
            charts:{...this.#dashboard.charts}
        };
    }

    /** @param {{charts:Object<string,boolean>}} v */
    set dashboard(v){
        if(!v||typeof v!=='object'||Array.isArray(v)){
            throw new Error('dashboard must be an object');
        }

        this.#dashboard=normalizeDashboard(v);

        this.#persist();
    }

    /**
     * Explicit schema representation
     *
     * @returns {UserEntityData}
     */
    get explicit(){
        const data={};

        for(let i=0;i<this.#schema.length;i++){
            const key=this.#schema[i];
            data[key]=this[key];
        }

        return data;
    }



    /**
     * Update entity fields from object or JSON
     *
     * @param {UserEntityData|string|Object} src
     */
    set explicit(src){
        if(!src){
            src=this.explicit;
        }

        if(!is.union(src,'object','string')){
            throw new Error('UserEntity.explicit setter expects object or JSON string');
        }

        if(is.string(src)){
            src = JSON.parse(src);
        }

        if(!is.object(src)){
            throw new Error('UserEntity.explicit parsed src must be object');
        }

        const persist=this.persist;
        this.persist=false;

        for(let i=0;i<this.#schema.length;i++){
            const key=this.#schema[i];

            if(is.undefined(src[key])){
                continue;
            }

            try {
                this[key] = src[key];
            } catch(e){
                console.warn(`UserEntity.explicit setter skipping invalid field ${key}: ${e.message}`);
            }
        }

        this.persist=persist;
        this.#persist();
    }

    /**
     * Load entity from OPFS
     *
     * Reads serialized entity data using DBOPFS
     * this is async so your code can be faster
     * only await if you need to ensure data is loaded before proceeding
     */
    async load(){
        if(this.ready){
            return this.explicit;
        }

        if(this.#loadPromise){
            return this.#loadPromise;
        }

        this.#loadPromise=this.#load();

        try{
            return await this.#loadPromise;
        }finally{
            this.#loadPromise=null;
        }
    }

    async #load(){
        const user=await dbopfs.get(
            this.#tableName,
            this.fileName
        );

        if(user){
            const persist=this.persist;
            this.persist=false;

            try{
                this.explicit=user;
            }finally{
                this.persist=persist;
            }
        }

        this.ready=true;

        window.dispatchEvent(
            new CustomEvent(
                'user-entity-loaded',
                {
                    detail:{
                        user:this
                    }
                }
            )
        );

        return this.explicit;
    }

    /**
     * Persist entity to OPFS
     *
     * Writes serialized entity data using DBOPFS
     * this is async so your code can run faster
     * only await if you need to ensure data is saved before proceeding
     */
    async save(){
        return dbopfs.set(
            this.#tableName,
            this.fileName,
            JSON.stringify(this.explicit)
        );
    }

    /**
     * Serialize entity to JSON
     *
     * @returns {string}
     */
    toJSON(){
        return JSON.stringify(
            this.explicit
        );
    }

    /**
     * Internal persistence trigger
     */
    #persist(){
        if(this.persist){
            return this.save();
        }

        return true;
    }
}

window.addEventListener(
    'dbopfs-ready',
    initSingletonUserEntity
);

if(window.dbopfs?.ready){
    initSingletonUserEntity();
}

function initSingletonUserEntity(){
    if(!window.user){
        window.user = new UserEntity();
    }
}


export default UserEntity;
