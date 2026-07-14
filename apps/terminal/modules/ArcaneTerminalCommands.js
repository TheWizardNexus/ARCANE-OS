import TerminalCommandRegistry from '../../../arcane/modules/TerminalCommandRegistry.js';
import createArcaneSystemTools from './ArcaneSystemTools.js';

function json(value){ return `${JSON.stringify(value,null,2)}\n`; }
function table(rows=[]){
    if(!rows.length)return 'No results.\n';
    const keys=[...new Set(rows.flatMap(Object.keys))];
    const widths=keys.map(key=>Math.min(42,Math.max(key.length,...rows.map(row=>String(row[key]??'').length))));
    const line=values=>values.map((value,index)=>String(value??'').slice(0,widths[index]).padEnd(widths[index])).join('  ').trimEnd();
    return `${line(keys)}\n${line(widths.map(width=>'─'.repeat(width)))}\n${rows.map(row=>line(keys.map(key=>row[key]))).join('\n')}\n`;
}

export default function createArcaneTerminalCommands({arcane=globalThis.Arcane,onClear=()=>{},onTheme=()=>{}}={}){
    const registry=new TerminalCommandRegistry();
    const tools=createArcaneSystemTools();
    registry.register({name:'help',aliases:['?'],description:'Show terminal and Arcane commands.',run:()=>{
        const rows=registry.definitions().map(item=>({command:item.usage,description:item.description}));
        return `Arcane Terminal commands\n\n${table(rows)}\nEverything else runs in your native shell. Try: arcane status\n`;
    }});
    registry.register({name:'clear',aliases:['cls'],description:'Clear the active terminal output.',run:()=>onClear()});
    registry.register({name:'theme',description:'Switch theme: matrix, midnight, ember, paper.',usage:'theme <name>',run:({args})=>onTheme(args[0]||'')});
    registry.register({name:'tools',description:'List registered Arcane system tools.',run:()=>table(tools.list().map(tool=>({tool:tool.id,usage:tool.usage,description:tool.description})))});
    registry.register({name:'tool',description:'Run a registered Arcane system tool in this shell.',usage:'tool <name> [arguments]',run:async({args,context})=>{
        if(!args[0])return 'Usage: tool <name> [arguments]. Run tools to list registered tools.\n';
        const command=tools.build(args[0],args.slice(1));if(typeof context.executeShell==='function')await context.executeShell(command);return `→ ${command}\n`;
    }});
    registry.register({name:'app',description:'Shortcut for Arcane application packaging tools.',usage:'app <list|inspect|package|check|release> [app]',run:async({args,context})=>{
        const action=args[0]||'list';const tool={list:'apps',inspect:'app-inspect',package:'app-package',build:'app-package',check:'app-check',release:'app-release'}[action];
        if(!tool)return 'Usage: app <list|inspect|package|check|release> [app]\n';const command=tools.build(tool,args.slice(1));if(typeof context.executeShell==='function')await context.executeShell(command);return `→ ${command}\n`;
    }});
    registry.register({name:'native-app',description:'Build Arcane application targets for native hosting.',usage:'native-app <list|build> [app] [portable|nt]',run:async({args,context})=>{
        const action=args[0]||'list';const tool=action==='list'?'native-apps':action==='build'?'native-app-build':null;
        if(!tool)return 'Usage: native-app <list|build> [app] [portable|nt]\n';const command=tools.build(tool,args.slice(1));if(typeof context.executeShell==='function')await context.executeShell(command);return `→ ${command}\n`;
    }});
    registry.register({name:'arcane',description:'Call Arcane OS APIs from the terminal.',usage:'arcane <status|apps|open|models|metrics|network|user|diagnostics|capabilities|ping>',run:async({args})=>{
        if(!arcane) return 'Arcane APIs are unavailable outside an installed Arcane application.\n';
        const [operation,...rest]=args;
        switch(operation){
            case 'status': return json({app:await arcane.app.current(),platform:await arcane.platform.status(),permissions:await arcane.permissions.status()});
            case 'apps': return table((await arcane.applications.list()).applications||[]);
            case 'open': if(!rest[0])return 'Usage: arcane open <app-id>\n';return json(await arcane.applications.launch(rest[0]));
            case 'models': return table((await arcane.ollama.models()).models||[]);
            case 'metrics': return json(await arcane.system.metrics());
            case 'network': return json(await arcane.network.status());
            case 'user': return json(await arcane.user.current());
            case 'diagnostics': return table(await arcane.diagnostics.recentErrors());
            case 'capabilities': return json(await arcane.capabilities.list());
            case 'ping': return json(await arcane.system.ping());
            default:return 'Usage: arcane <status|apps|open|models|metrics|network|user|diagnostics|capabilities|ping>\n';
        }
    }});
    return registry;
}
