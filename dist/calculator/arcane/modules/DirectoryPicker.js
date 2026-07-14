const TITLE_MAX_LENGTH=160;
const PATH_MAX_LENGTH=4096;
const CONTROL_CHARACTERS=/[\u0000-\u001f\u007f]/;

function isPlainRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function coded(error,code){
    error.code=code;
    return error;
}

function optionalText(value,label,maximum){
    if(value===undefined||value===null||value==='') return null;
    if(typeof value!=='string') throw new TypeError(`${label} must be a string when provided.`);
    const normalized=value.trim();
    if(!normalized) return null;
    if(normalized.length>maximum) throw new RangeError(`${label} exceeds ${maximum} characters.`);
    if(CONTROL_CHARACTERS.test(normalized)) throw new TypeError(`${label} cannot contain control characters.`);
    return normalized;
}

function normalizeDirectoryPickerOptions(input={}){
    if(!isPlainRecord(input)) throw new TypeError('Directory picker options must be a plain object.');
    const allowed=new Set(['initialPath','title']);
    const unsupported=Object.keys(input).find(key=>!allowed.has(key));
    if(unsupported) throw new TypeError(`Unsupported directory picker option: ${unsupported}`);

    const title=optionalText(input.title,'title',TITLE_MAX_LENGTH);
    const initialPath=optionalText(input.initialPath,'initialPath',PATH_MAX_LENGTH);
    return Object.freeze({
        ...(title?{title}:{}),
        ...(initialPath?{initialPath}:{}),
    });
}

function normalizeDirectorySelection(input){
    const keys=isPlainRecord(input)?Object.keys(input):[];
    if(
        !isPlainRecord(input)
        ||keys.length!==2
        ||!keys.includes('cancelled')
        ||!keys.includes('path')
        ||typeof input.cancelled!=='boolean'
    ){
        throw coded(
            new TypeError('The directory picker provider returned an invalid result.'),
            'DIRECTORY_PICKER_INVALID_RESULT',
        );
    }
    if(input.cancelled){
        if(input.path!==null){
            throw coded(
                new TypeError('A canceled directory selection must return a null path.'),
                'DIRECTORY_PICKER_INVALID_RESULT',
            );
        }
        return Object.freeze({cancelled:true,path:null});
    }
    let path;
    try{
        path=optionalText(input.path,'The selected directory path',PATH_MAX_LENGTH);
    }catch(error){
        throw coded(error,'DIRECTORY_PICKER_INVALID_RESULT');
    }
    if(!path){
        throw coded(
            new TypeError('The directory picker provider did not return a selected path.'),
            'DIRECTORY_PICKER_INVALID_RESULT',
        );
    }
    return Object.freeze({cancelled:false,path});
}

/**
 * Opens a provider-owned operating-system directory selector.
 *
 * This wrapper does not enumerate directories, persist a selected path, or use
 * a browser file picker. The injected provider must expose
 * `selectDirectory(options)` and return `{cancelled, path}`.
 */
export default class DirectoryPicker{
    constructor(provider=globalThis.Arcane?.filesystem){
        this.provider=provider||null;
    }

    get available(){
        return typeof this.provider?.selectDirectory==='function';
    }

    async select(options={}){
        if(!this.available){
            throw coded(
                new Error('The Arcane directory selector is unavailable. Open this application through an installed Arcane OS build.'),
                'DIRECTORY_PICKER_UNAVAILABLE',
            );
        }
        const normalized=normalizeDirectoryPickerOptions(options);
        return normalizeDirectorySelection(
            await this.provider.selectDirectory({...normalized}),
        );
    }
}

export {normalizeDirectoryPickerOptions,normalizeDirectorySelection};
