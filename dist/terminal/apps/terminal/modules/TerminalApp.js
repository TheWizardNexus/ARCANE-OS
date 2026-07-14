import TerminalClient from '../../../arcane/modules/TerminalClient.js';
import PreferenceStore from '../../../arcane/modules/PreferenceStore.js';
import createArcaneTerminalCommands from './ArcaneTerminalCommands.js';

const themes={
    matrix:{bg:'#07110f',fg:'#d7f6df',muted:'#6f9b82',accent:'#63f2a2',danger:'#ff6b7a'},
    midnight:{bg:'#070b18',fg:'#dfe7ff',muted:'#7f8daf',accent:'#7aa2ff',danger:'#ff718b'},
    ember:{bg:'#160b08',fg:'#ffe7d6',muted:'#b38771',accent:'#ff9f5a',danger:'#ff5f68'},
    paper:{bg:'#f4f0e7',fg:'#23211d',muted:'#746f64',accent:'#116b50',danger:'#a1333a'}
};
const schema=[
    {key:'theme',type:'select',label:'Color theme',description:'Apply a complete terminal palette.',defaultValue:'matrix',options:Object.keys(themes).map(value=>({label:value[0].toUpperCase()+value.slice(1),value}))},
    {key:'shell',type:'select',label:'Startup shell',description:'Choose the shell used for new sessions.',defaultValue:'auto',options:[{label:'System default',value:'auto'},{label:'PowerShell',value:'powershell'},{label:'Command Prompt',value:'cmd'},{label:'Bash',value:'bash'},{label:'POSIX shell',value:'sh'}]},
    {key:'workingDirectory',type:'text',label:'Startup directory',description:'Set this to an Arcane OS checkout root to run registered build tools from any launch location.',defaultValue:''},
    {key:'fontSize',type:'number',label:'Font size',description:'Terminal text size in pixels.',defaultValue:14,minimum:10,maximum:26,step:1},
    {key:'lineHeight',type:'number',label:'Line height',description:'Vertical spacing between terminal lines.',defaultValue:1.55,minimum:1.1,maximum:2.2,step:.05},
    {key:'opacity',type:'number',label:'Surface opacity',description:'Terminal background opacity.',defaultValue:1,minimum:.65,maximum:1,step:.05},
    {key:'prompt',type:'text',label:'Prompt label',description:'Label shown before commands.',defaultValue:'arcane ❯'},
    {key:'welcome',type:'boolean',label:'Welcome guide',description:'Show command hints when a session starts.',defaultValue:true}
];

const workspace=document.querySelector('#terminalWorkspace');
const preferences=document.querySelector('#preferencesForm');
const settingsPanel=document.querySelector('#settingsPanel');
const store=new PreferenceStore({namespace:'terminal',schema});
const client=new TerminalClient();
let values=store.defaults();
const commands=createArcaneTerminalCommands({onClear:()=>workspace.clear(),onTheme:changeTheme});

await Promise.all([ready(workspace,'terminal-workspace-ready'),ready(preferences,'preferences-form-ready')]);
values=await store.load();
workspace.configure({prompt:values.prompt,completions:[...commands.completions(''),'arcane status','arcane apps','arcane models','arcane metrics','arcane network','arcane user','arcane diagnostics','arcane capabilities','arcane ping','app list','app package','native-app list','native-app build','tool app-package','tool native-app-build'],theme:themeValues(values)});
preferences.configure({title:'Appearance & behavior',description:'Settings are stored per Arcane user and apply immediately.',schema:store.schema,values});
bind();
await identifyPlatform();
await newSession();

function bind(){
    workspace.addEventListener('terminal-submit',submit);
    workspace.addEventListener('terminal-session-new',()=>newSession());
    workspace.addEventListener('terminal-session-close',event=>closeSession(event.detail.sessionId));
    workspace.addEventListener('terminal-interrupt',event=>client.signal(event.detail.sessionId,'interrupt').catch(showError));
    workspace.addEventListener('terminal-settings',()=>settingsPanel.hidden=false);
    document.querySelector('#closeSettings').onclick=()=>settingsPanel.hidden=true;
    preferences.addEventListener('preferences-submit',async event=>{preferences.setBusy(true);try{values=await store.setAll(event.detail.values);applySettings();preferences.setStatus('Saved.');}catch(error){preferences.setStatus(error.message);}finally{preferences.setBusy(false);}});
    preferences.addEventListener('preferences-change',event=>{values={...values,[event.detail.key]:event.detail.value};applySettings();});
    preferences.addEventListener('preferences-reset',async()=>{values=await store.reset();preferences.setValues(values);applySettings();preferences.setStatus('Defaults restored.');});
    client.addEventListener('terminal-output',event=>workspace.append(event.detail.data,'output',event.detail.sessionId));
    client.addEventListener('terminal-exit',event=>{workspace.setState('exited',event.detail.session.id);workspace.append(`\n[process exited ${event.detail.exitCode??''}]\n`,'system',event.detail.session.id);});
    client.addEventListener('terminal-error',event=>workspace.append(`${event.detail.message||'Terminal error'}\n`,'error',event.detail.sessionId));
    globalThis.addEventListener('beforeunload',()=>{for(const id of client.sessions.keys())client.close(id).catch(()=>{});});
}

async function newSession(){
    if(!client.available){const id=`local-${Date.now()}`;workspace.addSession({id,title:'Arcane commands',shell:'local',state:'error'});workspace.append('Native terminal access is unavailable in this browser preview. Open Arcane Terminal from the installed Arcane OS shell to run operating-system commands. Arcane commands remain discoverable with help.\n\n','system',id);if(values.welcome)workspace.append(welcome(),'system',id);return;}
    try{const session=await client.start({shell:values.shell,cwd:values.workingDirectory,columns:120,rows:32});workspace.addSession(session);if(values.welcome)workspace.append(welcome(),'system',session.id);}
    catch(error){showError(error);}
}

async function closeSession(id){
    try{if(client.sessions.has(id))await client.close(id);}catch(error){showError(error);}workspace.removeSession(id);if(!workspace.shadowRoot.querySelector('[role="tab"]'))await newSession();
}

async function submit(event){
    const {sessionId,line}=event.detail;
    try{
        const result=await commands.execute(line,{sessionId,executeShell:command=>client.write(sessionId,`${command}\n`)});
        if(result.handled){if(typeof result.value==='string'&&result.value)workspace.append(result.value,'system',sessionId);return;}
        if(!client.sessions.has(sessionId)){workspace.append('This preview cannot execute native shell commands. Use help for available Arcane commands.\n','error',sessionId);return;}
        await client.write(sessionId,`${line}\n`);
    }catch(error){workspace.append(`${error.code?`${error.code}: `:''}${error.message}\n${error.resolution?`${error.resolution}\n`:''}`,'error',sessionId);}
}

function applySettings(){workspace.configure({prompt:values.prompt,completions:[...commands.completions(''),'arcane status','arcane apps','arcane models'],theme:themeValues(values)});document.documentElement.style.colorScheme=values.theme==='paper'?'light':'dark';}
function themeValues(settings){return {...themes[settings.theme],fontSize:`${settings.fontSize}px`,lineHeight:settings.lineHeight,opacity:settings.opacity};}
function changeTheme(name){if(!themes[name])return `Unknown theme. Choose: ${Object.keys(themes).join(', ')}\n`;values={...values,theme:name};preferences.setValues(values);applySettings();store.set('theme',name).catch(()=>{});return `Theme changed to ${name}.\n`;}
function welcome(){return 'Arcane Terminal ready.\n  help                          built-in command guide\n  tools                         registered system tools\n  app package terminal          build the Terminal distribution package\n  native-app build terminal     build its portable native host target\n  arcane status                  platform and application status\n  arcane capabilities            granted native methods\n  theme midnight                 switch appearance\n  All other input runs in the native shell.\n\n';}
function showError(error){workspace.append(`${error.message||error}\n`,'error');}
async function identifyPlatform(){try{const status=await globalThis.Arcane?.platform?.status?.();document.querySelector('#platformLabel').textContent=status?.platform||status?.os?.name||'Arcane native';}catch{document.querySelector('#platformLabel').textContent='Browser preview';}}
function ready(element,eventName){if(element.ready)return Promise.resolve();return new Promise(resolve=>element.addEventListener(eventName,resolve,{once:true}));}
