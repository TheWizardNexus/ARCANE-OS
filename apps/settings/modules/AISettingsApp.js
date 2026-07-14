import ollama from '../../../arcane/modules/Ollama.js';
import {ollamaRuntimeSchema,ollamaServiceSchema} from '../../../arcane/modules/OllamaSettings.js';

const runtimeForm=document.querySelector('#aiRuntimeForm');
const serviceForm=document.querySelector('#aiServiceForm');
const defaultModel=document.querySelector('#defaultModel');
const modelList=document.querySelector('#modelList');
const pullForm=document.querySelector('#pullModelForm');
const brainForm=document.querySelector('#createBrainForm');
const refreshButton=document.querySelector('#refreshModels');
const status=document.querySelector('#aiStatus');
const progress=document.querySelector('#aiProgress');
const providerForm=document.querySelector('#providerForm');
const openAIControls=document.querySelector('#openAIControls');
const ollamaRuntimeControls=document.querySelector('#ollamaRuntimeControls');
const openAITokenState=document.querySelector('#openAITokenState');
const openAIModels=document.querySelector('#openAIModels');
const loadOpenAIModels=document.querySelector('#loadOpenAIModels');
const removeOpenAIToken=document.querySelector('#removeOpenAIToken');
let runtimeSettings=null;
let providerSettings={provider:'ollama',openAIModel:'',openAIConfigured:false};
let operationActive=false;

function ready(element){
    if(element.ready)return Promise.resolve();
    return new Promise(resolve=>element.addEventListener('preferences-form-ready',resolve,{once:true}));
}

function message(value){status.textContent=String(value||'');}
function showProgress(value){
    if(value===null){progress.hidden=true;progress.removeAttribute('value');return;}
    progress.hidden=false;
    if(Number.isFinite(Number(value)))progress.value=Math.max(0,Math.min(100,Number(value)));else progress.removeAttribute('value');
}
function setBusy(value){
    operationActive=Boolean(value);
    refreshButton.disabled=operationActive;
    for(const control of [...pullForm.elements,...brainForm.elements])control.disabled=operationActive;
    for(const control of providerForm.elements)control.disabled=operationActive;
}
function errorMessage(error){return error?.resolution?`${error.message} ${error.resolution}`:error?.message||'The local AI operation did not complete.';}
function modelName(model){return String(model?.name||model?.model||'').trim();}
function formatBytes(value){
    const bytes=Number(value);if(!Number.isFinite(bytes)||bytes<1)return '';
    const units=['B','KB','MB','GB','TB'];let amount=bytes,index=0;
    while(amount>=1024&&index<units.length-1){amount/=1024;index+=1;}
    return `${amount.toFixed(index>2?1:0)} ${units[index]}`;
}

function populateDefault(models,selected){
    const names=models.map(modelName).filter(Boolean).sort((a,b)=>a.localeCompare(b));
    if(selected&&!names.includes(selected))names.unshift(selected);
    const fragment=document.createDocumentFragment();
    for(const name of names){const option=document.createElement('option');option.value=name;option.textContent=name;fragment.append(option);}
    if(!names.length){const option=document.createElement('option');option.textContent='No installed models';option.value='';fragment.append(option);}
    defaultModel.replaceChildren(fragment);defaultModel.value=selected||names[0]||'';
}

function actionButton(label,handler,kind='tertiary'){
    const button=document.createElement('button');button.type='button';button.className=`arcane-button arcane-button--${kind}`;button.textContent=label;
    button.addEventListener('click',()=>run(handler));return button;
}

function renderModels(models,running){
    const runningNames=new Set(running.map(modelName));
    if(!models.length){const empty=document.createElement('p');empty.className='arcane-help';empty.textContent='No Ollama models are installed yet.';modelList.replaceChildren(empty);return;}
    const fragment=document.createDocumentFragment();
    for(const model of models.sort((a,b)=>modelName(a).localeCompare(modelName(b)))){
        const name=modelName(model);if(!name)continue;
        const row=document.createElement('div'),copy=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('span'),actions=document.createElement('div');
        row.className='model-row';copy.className='model-row__copy';actions.className='model-row__actions';title.textContent=name;
        const parts=[model?.details?.parameter_size,model?.details?.quantization_level,formatBytes(model?.size)].filter(Boolean);if(runningNames.has(name))parts.unshift('Loaded');
        detail.className='arcane-help';detail.textContent=parts.join(' Â· ')||'Installed';copy.append(title,detail);
        actions.append(actionButton('Load',async()=>{message(`Loading ${name}â€¦`);showProgress(null);await ollama.generate({model:name,prompt:'',keep_alive:-1});message(`${name} is loaded.`);await loadModels();}));
        if(runningNames.has(name))actions.append(actionButton('Unload',async()=>{message(`Unloading ${name}â€¦`);await ollama.unload(name);message(`${name} was unloaded.`);await loadModels();}));
        actions.append(actionButton('Delete',async()=>{if(!confirm(`Delete ${name} from the global Ollama model store?`))return;message(`Deleting ${name}â€¦`);await ollama.delete(name);message(`${name} was deleted.`);await loadModels();},'danger'));
        row.append(copy,actions);fragment.append(row);
    }
    modelList.replaceChildren(fragment);
}

async function loadModels(){
    const [available,loaded]=await Promise.all([ollama.models(),ollama.running()]);
    const models=Array.isArray(available?.models)?available.models:[];
    const running=Array.isArray(loaded?.models)?loaded.models:[];
    populateDefault(models,runtimeSettings?.defaultModel);renderModels(models,running);
}

async function initialize(){
    if(!globalThis.Arcane){message('AI controls are available when Settings is opened through Arcane OS.');return;}
    await Promise.all([ready(runtimeForm),ready(serviceForm)]);
    const [settings,service,provider]=await Promise.all([ollama.settings(),ollama.serviceSettings(),globalThis.Arcane.ai.providerSettings()]);
    runtimeSettings=settings;
    applyProviderSettings(provider);
    runtimeForm.configure({title:'Default brain at boot',description:'Control whether Arcane preloads your default model and how much model context it uses.',schema:ollamaRuntimeSchema,values:settings});
    serviceForm.configure({title:'ArcaneOllama service',description:'Global service limits apply to every Arcane app using local AI.',schema:ollamaServiceSchema,values:service});
    if(service?.supported===false)serviceForm.setStatus(service.reason||'Service settings must be managed by an administrator on this platform.');
    await loadModels();message('Local AI settings are ready.');
}

function applyProviderSettings(settings){
    providerSettings={...providerSettings,...settings};
    providerForm.elements.provider.value=providerSettings.provider;
    providerForm.elements.openAIModel.value=providerSettings.openAIModel||'';
    providerForm.elements.token.value='';
    openAIControls.hidden=providerSettings.provider!=='openai';
    ollamaRuntimeControls.dataset.active=String(providerSettings.provider==='ollama');
    openAITokenState.textContent=providerSettings.openAIConfigured?'A protected token is saved for this Arcane user.':'No OpenAI token is saved.';
}

async function refreshOpenAIModels(){
    const result=await globalThis.Arcane.ai.providerModels();
    const fragment=document.createDocumentFragment();
    for(const id of Array.isArray(result?.models)?result.models:[]){const option=document.createElement('option');option.value=id;fragment.append(option);}
    openAIModels.replaceChildren(fragment);message(`${openAIModels.children.length} OpenAI models are available to this account.`);
}

async function run(callback){
    if(operationActive)return;
    setBusy(true);
    try{await callback();}catch(error){message(errorMessage(error));showProgress(0);}finally{setBusy(false);}
}

runtimeForm.addEventListener('preferences-submit',event=>run(async()=>{
    if(!defaultModel.value)throw new Error('Install a model before choosing the default brain.');
    runtimeForm.setBusy(true);runtimeForm.setStatus('Saving and loading the default brainâ€¦');showProgress(null);
    try{
        runtimeSettings=await ollama.saveSettings({...runtimeSettings,...event.detail.values,defaultModel:defaultModel.value});
        runtimeForm.setValues(runtimeSettings);runtimeForm.setStatus('Default brain settings saved.');message(`${runtimeSettings.defaultModel} is the default Arcane brain.`);
    }finally{runtimeForm.setBusy(false);}
}));
runtimeForm.addEventListener('preferences-reset',()=>{runtimeForm.setValues({bootLoad:true,bootKeepAlive:'-1',contextLength:0});runtimeForm.setStatus('Defaults selected. Save changes to apply them.');});

serviceForm.addEventListener('preferences-submit',event=>run(async()=>{
    serviceForm.setBusy(true);serviceForm.setStatus('Applying settings and restarting ArcaneOllamaâ€¦');showProgress(null);
    try{const saved=await ollama.saveServiceSettings(event.detail.values);serviceForm.setValues(saved);serviceForm.setStatus('ArcaneOllama restarted with these settings.');message('Global Ollama service settings were applied.');await loadModels();}
    finally{serviceForm.setBusy(false);}
}));
serviceForm.addEventListener('preferences-reset',()=>{serviceForm.setValues({contextLength:0,keepAlive:'5m',maxLoadedModels:0,numParallel:1,maxQueue:512,flashAttention:false,kvCacheType:'f16',noCloud:true});serviceForm.setStatus('Safe defaults selected. Save changes to restart the service.');});

pullForm.addEventListener('submit',event=>{event.preventDefault();run(async()=>{
    const name=String(new FormData(pullForm).get('model')||'').trim();message(`Downloading ${name}â€¦`);showProgress(null);
    await ollama.pull(name,{},chunk=>{const complete=Number(chunk?.completed),total=Number(chunk?.total);if(total>0&&complete>=0)showProgress(complete/total*100);message(String(chunk?.status||`Downloading ${name}â€¦`));});
    showProgress(100);message(`${name} is installed in the global Ollama model store.`);pullForm.reset();await loadModels();
});});

brainForm.addEventListener('submit',event=>{event.preventDefault();run(async()=>{
    const values=new FormData(brainForm);const definition={name:String(values.get('name')||''),baseModel:String(values.get('baseModel')||''),contextLength:Number(values.get('contextLength')||0),makeDefault:values.get('makeDefault')==='on'};
    message(`Creating an Arcane brain from ${definition.baseModel}â€¦`);showProgress(null);
    const result=await ollama.createBrain(definition);showProgress(100);message(`${result.model||'Your Arcane brain'} is ready.`);brainForm.reset();
    if(result.settings)runtimeSettings=result.settings;await loadModels();
});});

refreshButton.addEventListener('click',()=>run(async()=>{message('Refreshing local modelsâ€¦');await loadModels();message('Model list refreshed.');}));

providerForm.elements.provider.addEventListener('change',()=>{openAIControls.hidden=providerForm.elements.provider.value!=='openai';});
providerForm.addEventListener('submit',event=>{event.preventDefault();run(async()=>{
    const values=new FormData(providerForm);message('Saving the Arcane brain providerâ€¦');showProgress(null);
    providerSettings=await globalThis.Arcane.ai.saveProviderSettings({provider:String(values.get('provider')||'ollama'),openAIModel:String(values.get('openAIModel')||'').trim(),token:String(values.get('token')||'').trim()});
    applyProviderSettings(providerSettings);message(`${providerSettings.provider==='openai'?'OpenAI':'Ollama'} is now the Arcane brain provider.`);
});});
loadOpenAIModels.addEventListener('click',()=>run(async()=>{
    const token=String(providerForm.elements.token.value||'').trim();
    if(token){providerSettings=await globalThis.Arcane.ai.saveProviderSettings({provider:providerSettings.provider,openAIModel:providerSettings.openAIModel,token});applyProviderSettings(providerSettings);}
    message('Loading models available to this OpenAI accountâ€¦');showProgress(null);await refreshOpenAIModels();
}));
removeOpenAIToken.addEventListener('click',()=>run(async()=>{
    if(!confirm('Remove the saved OpenAI token from this user account?'))return;
    providerSettings=await globalThis.Arcane.ai.saveProviderSettings({provider:'ollama',openAIModel:providerForm.elements.openAIModel.value,removeToken:true});applyProviderSettings(providerSettings);message('The OpenAI token was removed. Ollama is now the Arcane brain provider.');
}));

if(globalThis.Arcane?.events){
    globalThis.Arcane.events.on('operation.progress',event=>{if(!operationActive)return;showProgress(event?.progress);if(event?.message)message(event.message);});
    globalThis.Arcane.events.on('operation.failed',event=>{if(operationActive&&event?.error?.message)message(event.error.message);});
}

initialize().catch(error=>message(errorMessage(error)));
