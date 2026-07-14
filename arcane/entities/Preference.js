const KEY_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TYPES=new Set(['boolean','number','select','text']);

function copy(value){
    return value===undefined?undefined:JSON.parse(JSON.stringify(value));
}

export default class Preference{
    constructor(definition={}){
        const key=String(definition.key||'').trim();
        const type=String(definition.type||'text').trim().toLowerCase();
        if(!KEY_PATTERN.test(key)) throw new TypeError('Preference keys must be stable namespaced identifiers.');
        if(!TYPES.has(type)) throw new TypeError(`Unsupported preference type: ${type}`);

        this.key=key;
        this.type=type;
        this.label=String(definition.label||key);
        this.description=String(definition.description||'');
        this.defaultValue=this.normalize(definition.defaultValue);
        this.options=type==='select'?this.normalizeOptions(definition.options):[];
        this.minimum=Number.isFinite(Number(definition.minimum))?Number(definition.minimum):undefined;
        this.maximum=Number.isFinite(Number(definition.maximum))?Number(definition.maximum):undefined;
        this.step=Number.isFinite(Number(definition.step))?Number(definition.step):undefined;

        if(type==='select'&&!this.options.some(option=>Object.is(option.value,this.defaultValue))){
            throw new TypeError(`Preference ${key} has a default value outside its options.`);
        }
        Object.freeze(this.options);
        Object.freeze(this);
    }

    normalizeOptions(options=[]){
        if(!Array.isArray(options)||!options.length) throw new TypeError('Select preferences require options.');
        return options.map(option=>{
            const normalized=typeof option==='object'&&option!==null
                ?{label:String(option.label??option.value),value:this.normalize(option.value)}
                :{label:String(option),value:this.normalize(option)};
            return Object.freeze(normalized);
        });
    }

    normalize(value){
        if(value===undefined){
            if(this?.type==='boolean') return false;
            if(this?.type==='number') return 0;
            return '';
        }
        switch(this?.type){
            case 'boolean': return value===true||value==='true'||value===1;
            case 'number': {
                const number=Number(value);
                if(!Number.isFinite(number)) throw new TypeError('Numeric preferences require finite values.');
                return number;
            }
            default: return String(value);
        }
    }

    value(input){
        const normalized=this.normalize(input);
        if(this.type==='select'&&!this.options.some(option=>Object.is(option.value,normalized))){
            return copy(this.defaultValue);
        }
        if(this.type==='number'){
            return Math.min(this.maximum??Infinity,Math.max(this.minimum??-Infinity,normalized));
        }
        return normalized;
    }

    toJSON(){
        return {
            key:this.key,type:this.type,label:this.label,description:this.description,
            defaultValue:copy(this.defaultValue),options:this.options.map(copy),
            minimum:this.minimum,maximum:this.maximum,step:this.step
        };
    }
}

export function preferenceSchema(definitions=[]){
    const schema=definitions.map(definition=>definition instanceof Preference?definition:new Preference(definition));
    if(new Set(schema.map(item=>item.key)).size!==schema.length) throw new TypeError('Preference schema keys must be unique.');
    return Object.freeze(schema);
}
