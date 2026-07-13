const TOOL_PATTERN=/^[a-z][a-z0-9-]{0,63}$/;

function quoteArgument(value){
    const text=String(value??'');
    if(!text||/[\s"';&|<>$`]/.test(text)) return `"${text.replace(/"/g,'\\"')}"`;
    return text;
}

export default class SystemToolRegistry{
    constructor(definitions=[]){this.tools=new Map();for(const definition of definitions)this.register(definition);}
    register(definition={}){
        const id=String(definition.id||'').trim().toLowerCase();
        if(!TOOL_PATTERN.test(id)||this.tools.has(id))throw new TypeError(`Duplicate or invalid system tool: ${id}`);
        if(typeof definition.command!=='function'&&typeof definition.command!=='string')throw new TypeError(`System tool ${id} requires a command builder.`);
        const record=Object.freeze({id,label:String(definition.label||id),description:String(definition.description||''),usage:String(definition.usage||id),command:definition.command});
        this.tools.set(id,record);return record;
    }
    list(){return [...this.tools.values()].sort((left,right)=>left.id.localeCompare(right.id));}
    get(id){return this.tools.get(String(id||'').toLowerCase())||null;}
    build(id,args=[]){
        const tool=this.get(id);if(!tool)throw new RangeError(`Unknown system tool: ${id}`);
        const command=typeof tool.command==='function'?tool.command(Array.from(args)):tool.command;
        if(typeof command!=='string'||!command.trim())throw new TypeError(`System tool ${id} produced an empty command.`);
        return command.trim();
    }
}

export {quoteArgument};
