import ArcaneCommunicationBridge from './ArcaneCommunicationBridge.js';
import CommunicationHub from './CommunicationHub.js';
import CommunicationPreferences from './CommunicationPreferences.js';
import {loadAndApplyTheme} from './ThemeManager.js';

function defaults(services){return Object.fromEntries(services.map(item=>[item.id,{enabled:Boolean(item.defaultEnabled),endpoint:item.defaultEndpoint||'http://127.0.0.1:8020',accountLabel:'',status:item.defaultStatus||'Disconnected'}]));}
function ready(element,event){return element.ready?Promise.resolve(element):new Promise(resolve=>element.addEventListener(event,()=>resolve(element),{once:true}));}

export default class CommunicationAppController{
    constructor({appId,services,channels,labels={}}){this.appId=appId;this.services=services;this.channels=channels;this.labels=labels;this.preferences=new CommunicationPreferences(appId);this.values={};this.hub=null;this.active=null;this.elements={inbox:document.querySelector('#inbox'),conversation:document.querySelector('#conversation'),settings:document.querySelector('#integrationSettings'),panel:document.querySelector('#settingsPanel'),status:document.querySelector('#appStatus')};}
    async start(){
        loadAndApplyTheme().catch(()=>{});await Promise.all([ready(this.elements.inbox,'unified-inbox-ready'),ready(this.elements.conversation,'conversation-view-ready'),ready(this.elements.settings,'integration-settings-ready')]);
        this.values=await this.preferences.load(defaults(this.services));this.bind();this.configure();await this.refresh();
    }
    bind(){
        document.querySelector('#openSettings').addEventListener('click',()=>this.openSettings());
        this.elements.settings.addEventListener('integration-settings-close',()=>this.closeSettings());
        this.elements.settings.addEventListener('integration-settings-save',event=>this.saveSettings(event.detail.values));
        this.elements.settings.addEventListener('integration-action',event=>this.action(event.detail.service));
        this.elements.inbox.addEventListener('inbox-refresh',()=>this.refresh());
        this.elements.inbox.addEventListener('thread-select',event=>this.select(event.detail.thread));
        this.elements.conversation.addEventListener('communication-send',event=>this.send(event.detail));
        this.elements.panel.addEventListener('click',event=>{if(event.target===this.elements.panel)this.closeSettings()});
        document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!this.elements.panel.hidden)this.closeSettings()});
    }
    configure(){
        const providers=this.services.map(item=>({id:item.id,label:item.label}));
        this.elements.inbox.configure({channels:this.channels,providers,threads:[]});
        this.elements.settings.configure({title:this.labels.settingsTitle||'Connected services',description:this.labels.settingsDescription||'Choose which services appear in this application.',services:this.services,values:this.values});
        this.rebuildHub();
    }
    rebuildHub(){const enabled=this.services.filter(item=>this.values[item.id]?.enabled&&item.unified!==false);const providers=enabled.map(item=>new ArcaneCommunicationBridge({id:item.id,label:item.label,channels:item.channels,endpoint:this.values[item.id].endpoint||item.defaultEndpoint}));this.hub=new CommunicationHub({providers,enabledProviderIds:enabled.map(item=>item.id)});}
    setStatus(message,tone='muted'){this.elements.status.textContent=String(message||'');this.elements.status.dataset.tone=tone;}
    async refresh(){this.elements.inbox.setLoading(true);this.setStatus('Refreshing…');try{const {threads,errors}=await this.hub.refresh();this.elements.inbox.setThreads(threads);if(errors.length)this.setStatus(`${threads.length} conversations · ${errors.length} service${errors.length===1?'':'s'} need attention`,'warning');else this.setStatus(`${threads.length} conversation${threads.length===1?'':'s'}`,'success');}catch(error){this.setStatus(error.message,'error');}finally{this.elements.inbox.setLoading(false)}}
    async select(thread){this.active=thread;this.elements.inbox.setActive(thread.id);this.elements.conversation.setStatus('Loading…');try{const messages=await this.hub.messages(thread);this.elements.conversation.setConversation(thread,messages);this.elements.conversation.setStatus('');}catch(error){this.elements.conversation.setConversation(thread,[]);this.elements.conversation.setStatus(error.message);}}
    async send({thread,body}){this.elements.conversation.setBusy(true);this.elements.conversation.setStatus('Sending…');try{await this.hub.send({providerId:thread.providerId,threadId:thread.id,channel:thread.channel,body});this.elements.conversation.clearComposer();await this.select(thread);this.elements.conversation.setStatus('Sent.');}catch(error){this.elements.conversation.setStatus(error.message);}finally{this.elements.conversation.setBusy(false)}}
    openSettings(){this.elements.settings.configure({title:this.labels.settingsTitle,description:this.labels.settingsDescription,services:this.services,values:this.values});this.elements.panel.hidden=false;document.body.classList.add('modal-open');}
    closeSettings(){this.elements.panel.hidden=true;document.body.classList.remove('modal-open');}
    async saveSettings(values){try{this.values=await this.preferences.save(values);this.rebuildHub();this.elements.settings.setStatus('Services saved.');this.closeSettings();await this.refresh();}catch(error){this.elements.settings.setStatus(error.message)}}
    action(service){if(service.externalUrl){const opened=globalThis.open(service.externalUrl,'_blank','noopener,noreferrer');if(!opened)this.elements.settings.setStatus(`Open ${service.externalUrl} to continue.`);return}this.elements.settings.setStatus(`${service.label} connects through the Arcane communications bridge.`)}
}
