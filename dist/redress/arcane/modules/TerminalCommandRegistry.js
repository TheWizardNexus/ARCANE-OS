const COMMAND_PATTERN=/^(?:[a-z][a-z0-9:_-]{0,63}|\?)$/;

export function splitCommandLine(input=''){
    const source=String(input||'').trim();
    const values=[];
    let token='';
    let quote='';
    let escaped=false;
    for(const character of source){
        if(escaped){token+=character;escaped=false;continue;}
        if(character==='\\'&&quote!=='\''){escaped=true;continue;}
        if(quote){if(character===quote) quote='';else token+=character;continue;}
        if(character==='"'||character==='\''){quote=character;continue;}
        if(/\s/.test(character)){if(token){values.push(token);token='';}continue;}
        token+=character;
    }
    if(escaped) token+='\\';
    if(token) values.push(token);
    return values;
}

export default class TerminalCommandRegistry{
    constructor(commands=[]){
        this.commands=new Map();
        for(const command of commands) this.register(command);
    }

    register({name,aliases=[],description='',usage='',run}={}){
        const normalized=String(name||'').trim().toLowerCase();
        if(!COMMAND_PATTERN.test(normalized)) throw new TypeError('Terminal command names must use lowercase command syntax.');
        if(typeof run!=='function') throw new TypeError(`Terminal command ${normalized} requires a run function.`);
        const record=Object.freeze({name:normalized,aliases:Object.freeze(aliases.map(alias=>String(alias).toLowerCase())),description:String(description),usage:String(usage||normalized),run});
        for(const key of [record.name,...record.aliases]){
            if(!COMMAND_PATTERN.test(key)||this.commands.has(key)) throw new TypeError(`Duplicate or invalid terminal command: ${key}`);
            this.commands.set(key,record);
        }
        return record;
    }

    resolve(name){ return this.commands.get(String(name||'').toLowerCase())||null; }
    definitions(){ return [...new Set(this.commands.values())].sort((left,right)=>left.name.localeCompare(right.name)); }
    completions(prefix=''){ const value=String(prefix).toLowerCase();return this.definitions().map(item=>item.name).filter(name=>name.startsWith(value)); }

    async execute(line,context={}){
        const [name,...args]=splitCommandLine(line);
        const command=this.resolve(name);
        if(!command) return {handled:false};
        return {handled:true,value:await command.run({args,line:String(line),command,context})};
    }
}
