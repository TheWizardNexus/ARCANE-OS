import Theme from '../../../arcane/entities/Theme.js';
import {applyAppearancePreferences,createAppearancePreferenceStore} from '../../../arcane/modules/AppearancePreferences.js';
import ThemeManager from '../../../arcane/modules/ThemeManager.js';

const store=createAppearancePreferenceStore();
const themeManager=new ThemeManager({appearanceStore:store});
const form=document.querySelector('#preferencesForm');
const themeEditor=document.querySelector('#themeEditor');
const facts=document.querySelector('#deviceFacts');
const connectionState=document.querySelector('#connectionState');

async function initializeForm(){
    const state=await themeManager.load();
    form.configure({title:'Appearance and accessibility',description:'Use the quick theme buttons anywhere, or fine-tune the shared system appearance here.',schema:store.schema,values:state.appearance});
    configureThemeEditor(state);
}

function configureThemeEditor(state=themeManager.current()){
    const fallback=new Theme({name:'My Arcane skin',scheme:state.appearance?.['appearance.colorScheme']==='dark'?'dark':'light'});
    if(themeEditor.ready) themeEditor.configure({theme:state.theme||fallback});
}

form.addEventListener('preferences-form-ready',()=>initializeForm().catch(showError),{once:true});
form.addEventListener('preferences-change',event=>{Theme.clear();applyAppearancePreferences(event.detail.values);});
form.addEventListener('preferences-submit',async event=>{
    form.setBusy(true);form.setStatus('Saving…');
    try{
        await store.setAll(event.detail.values);
        await themeManager.load();
        await themeManager.setScheme(event.detail.values['appearance.colorScheme']);
        form.setStatus('Settings saved.');
    }catch(error){showError(error);}finally{form.setBusy(false);}
});
form.addEventListener('preferences-reset',async()=>{
    form.setBusy(true);
    try{
        const values=await store.reset();
        await themeManager.resetCustom();
        form.setValues(values);applyAppearancePreferences(values);configureThemeEditor();form.setStatus('Defaults restored.');
    }catch(error){showError(error);}finally{form.setBusy(false);}
});

themeEditor.addEventListener('theme-editor-ready',()=>configureThemeEditor(),{once:true});
themeEditor.addEventListener('theme-preview',event=>themeManager.preview(event.detail.theme));
themeEditor.addEventListener('theme-save',async event=>{
    themeEditor.setBusy(true);themeEditor.setStatus('Saving skin…');
    try{
        const state=await themeManager.saveCustom(event.detail.theme);
        form.setValues(state.appearance);themeEditor.setStatus(`Using “${state.theme.name}”.`);
    }catch(error){themeEditor.setStatus(error?.message||'Unable to save this skin.');}
    finally{themeEditor.setBusy(false);}
});
themeEditor.addEventListener('theme-reset',async()=>{
    themeEditor.setBusy(true);
    try{
        const state=await themeManager.resetCustom();
        form.setValues(state.appearance);configureThemeEditor(state);themeEditor.setStatus('Custom skin removed.');
    }catch(error){themeEditor.setStatus(error?.message||'Unable to remove this skin.');}
    finally{themeEditor.setBusy(false);}
});
globalThis.addEventListener('arcane-theme-change',async()=>{
    const state=await themeManager.load();
    form.setValues?.(state.appearance);
});

function showError(error){form.setStatus?.(error?.message||'Unable to save settings.');}

async function loadDevice(){
    const arcane=globalThis.Arcane;
    if(!arcane){
        connectionState.textContent='Browser preview';connectionState.dataset.status='warning';
        renderFacts({Runtime:'Web preview',Storage:'Browser-local fallback'});return;
    }
    try{
        const [platform,user,network,version]=await Promise.all([arcane.platform.status(),arcane.user.current(),arcane.network.status(),arcane.version.current()]);
        connectionState.textContent='Connected';connectionState.dataset.status='success';
        renderFacts({User:user?.username||user?.displayName||'Current user',Platform:platform?.platform||platform?.name||'Arcane host',Version:version?.version||version||'Unknown',Network:network?.online===false?'Offline':'Online'});
    }catch(error){connectionState.textContent='Needs attention';connectionState.dataset.status='error';renderFacts({Status:error.message});}
}

function renderFacts(values){
    const fragment=document.createDocumentFragment();
    for(const [label,value] of Object.entries(values)){
        const group=document.createElement('div'),term=document.createElement('dt'),description=document.createElement('dd');
        term.textContent=label;description.textContent=String(value??'');group.append(term,description);fragment.append(group);
    }
    facts.replaceChildren(fragment);
}

if(form.ready) initializeForm().catch(showError);
if(themeEditor.ready) configureThemeEditor();
loadDevice();
