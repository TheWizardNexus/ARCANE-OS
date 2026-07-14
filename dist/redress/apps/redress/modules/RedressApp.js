import CaseImporter from './CaseImporter.js';
import {
    buildCaseTree,
    companionPathFor,
    normalizeRelativePath
} from './CaseModel.js';
import CaseRepository from './CaseRepository.js';
import EvidenceDescriptor from './EvidenceDescriptor.js';
import {
    hasPdfSignature,
    previewKind,
    previewMimeType
} from './FilePreview.js';
import LegalAssistant from './LegalAssistant.js';
import neutralizeMarkdownSource from './MarkdownSafety.js?v=1';
import MD from '../../../arcane/modules/MD.js';
import waitForComponent from '../../../arcane/modules/WaitForComponent.js';

const AI_SETTINGS_FILE='ai-settings.json';
const AI_SETTINGS_TABLE='redress_state';
const TEXT_PREVIEW_BYTE_LIMIT=2*1024*1024;
const MARKDOWN_ALLOWED_TAGS=new Set([
    'A','BLOCKQUOTE','BR','CODE','DEL','EM','H1','H2','H3','H4','H5','H6','HR','IMG','KBD','LI','MARK',
    'OL','P','PRE','S','SPAN','STRONG','SUB','SUP','TABLE','TBODY','TD','TFOOT','TH','THEAD','TR','UL'
]);
const MARKDOWN_ALLOWED_ATTRIBUTES={
    A:new Set(['href','title']),
    CODE:new Set(['class']),
    IMG:new Set(['alt','height','src','title','width']),
    LI:new Set(['value']),
    OL:new Set(['reversed','start']),
    SPAN:new Set(['class']),
    TD:new Set(['align','colspan','rowspan']),
    TH:new Set(['align','colspan','rowspan'])
};

function $(selector,root=document){
    return root.querySelector(selector);
}

function $$(selector,root=document){
    return Array.from(root.querySelectorAll(selector));
}

function formObject(form){
    return Object.fromEntries(new FormData(form).entries());
}

function extensionOf(name=''){
    const index=String(name).lastIndexOf('.');
    return index>0?String(name).slice(index).toLowerCase():'';
}

function formatBytes(size=0){
    const value=Number(size)||0;
    if(value<1024){
        return `${value} B`;
    }
    const units=['KB','MB','GB','TB'];
    let amount=value/1024;
    let index=0;
    while(amount>=1024&&index<units.length-1){
        amount/=1024;
        index++;
    }
    return `${amount.toFixed(amount>=10?1:2)} ${units[index]}`;
}

function formatDate(value=''){
    if(!value){
        return 'Not set';
    }
    const date=new Date(`${value}T12:00:00`);
    if(Number.isNaN(date.getTime())){
        return value;
    }
    return new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(date);
}

function safeWorkProductName(value='Work Product'){
    return String(value)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g,' ')
        .replace(/\s+/g,' ')
        .trim()
        .slice(0,96)||'Work Product';
}

function markdownAttributeAllowed(element,attribute){
    const tag=element.tagName;
    const name=attribute.name.toLowerCase();
    const value=attribute.value;
    if(!MARKDOWN_ALLOWED_ATTRIBUTES[tag]?.has(name)){
        return false;
    }
    if(tag==='CODE'&&name==='class'){
        return /^language-[a-z0-9_-]+$/i.test(value);
    }
    if(tag==='SPAN'&&name==='class'){
        return value==='markdown-image-omitted';
    }
    if(['TD','TH'].includes(tag)&&name==='align'){
        return /^(?:center|left|right)$/i.test(value);
    }
    if(['colspan','rowspan','height','width','start','value'].includes(name)){
        return /^\d{1,5}$/.test(value);
    }
    if(name==='reversed'){
        return true;
    }
    return true;
}

function constrainMarkdownFragment(fragment){
    fragment.querySelectorAll('audio,canvas,picture,source,track,video').forEach(element=>{
        const replacement=document.createElement('span');
        replacement.className='markdown-image-omitted';
        replacement.textContent='[Embedded media omitted]';
        element.replaceWith(replacement);
    });
    Array.from(fragment.querySelectorAll('*')).reverse().forEach(element=>{
        if(!MARKDOWN_ALLOWED_TAGS.has(element.tagName)){
            element.replaceWith(...element.childNodes);
            return;
        }
        for(const attribute of Array.from(element.attributes)){
            if(!markdownAttributeAllowed(element,attribute)){
                element.removeAttribute(attribute.name);
            }
        }
    });
    return fragment;
}

function contextQuery(kind='',values={}){
    return [kind,...Object.values(values).flat()]
        .filter(value=>typeof value==='string'||typeof value==='number')
        .join(' ')
        .trim();
}

function coverageNotice(coverage={}){
    const total=Number(coverage.totalDocuments)||0;
    const included=Number(coverage.includedDocuments)||0;
    const omitted=Math.max(0,Number(coverage.omittedDocuments)||total-included);
    if(!total){
        return 'Record coverage: no filing or evidence Markdown descriptions were available. Treat the response as ungrounded in the case record.';
    }
    if(omitted){
        const inventoryOmitted=Number(coverage.inventoryOmitted)||0;
        const inventoryNote=inventoryOmitted
            ?` The bounded path inventory also omitted ${inventoryOmitted} name${inventoryOmitted===1?'':'s'}.`
            :' The available file-path inventory was supplied separately.';
        return `Record coverage: ${included} of ${total} Markdown descriptions were selected for body review; ${omitted} were omitted from body context.${inventoryNote} This is not an exhaustive record review.`;
    }
    return `Record coverage: all ${total} available Markdown description${total===1?' was':'s were'} supplied.`;
}

function createCaseTreeProvider(getCaseRecord){
    if(typeof getCaseRecord!=='function'){
        throw new TypeError('A case-record provider is required.');
    }

    const findNode=(node,path)=>{
        if(node.path===path){
            return node;
        }
        for(const child of node.children||[]){
            if(child.path===path){
                return child;
            }
            if(child.kind==='directory'&&path.startsWith(`${child.path}/`)){
                const found=findNode(child,path);
                if(found){
                    return found;
                }
            }
        }
        return null;
    };

    const fileCount=node=>node.kind==='file'
        ?1
        :(node.children||[]).reduce((total,child)=>total+fileCount(child),0);

    return {
        async list(path=''){
            const normalized=path?normalizeRelativePath(path):'';
            const caseRecord=getCaseRecord()||{};
            const tree=buildCaseTree(caseRecord.files||[]);
            const parent=findNode(tree,normalized);
            if(!parent||parent.kind!=='directory'){
                return [];
            }
            return parent.children.map(node=>{
                const record=node.record||null;
                return {
                    name:node.name,
                    path:node.path,
                    kind:node.kind,
                    size:record?.size||0,
                    mimeType:record?.mimeType||'',
                    lastModified:record?.lastImportedAt||record?.importedAt||'',
                    status:record?.status||'',
                    hasChildren:node.kind==='directory'&&node.children.length>0,
                    fileCount:fileCount(node),
                    record
                };
            });
        }
    };
}

function profileView(caseRecord={}){
    const profile=caseRecord.profile||{};
    const jurisdiction=typeof profile.jurisdiction==='string'
        ?profile.jurisdiction
        :[
            profile.jurisdiction?.locality,
            profile.jurisdiction?.countyMunicipality,
            profile.jurisdiction?.stateProvince,
            profile.jurisdiction?.country
        ].filter(Boolean).join(', ');
    const court=typeof profile.court==='string'
        ?profile.court
        :profile.court?.name||profile.courtName||'';

    return {
        caseName:profile.caseName||caseRecord.title||profile.title||'Untitled legal matter',
        caseNumber:profile.caseNumber||caseRecord.caseNumber||'',
        matterType:profile.matterType||profile.matterTypes?.[0]||'family',
        userRole:profile.userRole||'',
        jurisdiction,
        court,
        courtType:profile.courtType||profile.court?.type||'trial',
        forumLevel:profile.forumLevel||profile.jurisdiction?.level||'',
        caseStage:profile.caseStage||caseRecord.status||'',
        nextHearing:profile.nextHearing||'',
        opposingParty:profile.opposingParty||'',
        goals:profile.goals||''
    };
}

class RedressApp {
    constructor(){
        this.repository=new CaseRepository();
        this.descriptor=new EvidenceDescriptor();
        this.importer=new CaseImporter({repository:this.repository,descriptor:this.descriptor});
        this.assistant=new LegalAssistant();
        this.caseRecord=null;
        this.selectedFile=null;
        this.chatHistory=[];
        this.systemPromptReady=false;
        this.caseEpoch=0;
        this.caseLookupSequence=0;
        this.activationSequence=0;
        this.activeCaseWrite=Promise.resolve();
        this.buttonOwners=new WeakMap();
        this.chatSequences=new Map();
        this.dialogs=new Map();
        this.inspectorSequence=0;
        this.filePreview=null;
        this.filePreviewRequestSequence=0;
        this.filePreviewSequence=0;
        this.caseTree=null;
        this.assistantPanel=null;
        this.summaryStrip=null;
    }

    async init(){
        await this.repository.ready();
        this.caseRecord=await this.repository.getOrCreateActiveCase({
            caseName:'New legal matter',
            matterType:'family',
            status:'active'
        });
        this.chatHistory=Array.isArray(this.caseRecord.chatHistory)
            ?this.caseRecord.chatHistory.slice(-40)
            :[];
        await Promise.all([
            this.initializeDialogs(),
            this.initializeCaseTree(),
            this.initializeAssistantPanel(),
            this.initializeSummaryStrip()
        ]);
        this.bindNavigation();
        this.bindDialogs();
        this.bindProfileForms();
        this.bindImports();
        this.bindTaskForms();
        this.bindChat();
        this.bindInspectorActions();
        await this.configureStoredAI();
        await this.assistant.loadSystemPrompt();
        this.systemPromptReady=true;
        await this.render();
        $('.redress-layout').setAttribute('aria-busy','false');
    }

    async initializeCaseTree(){
        const host=await waitForComponent($('#caseTree'),{
            methods:['setProvider','loadAll','select','clearSelection'],
            property:'ready',
            event:'file-manager-ready'
        });
        const stylesheet=document.createElement('link');
        const styleReady=new Promise(resolve=>{
            const finish=()=>resolve();
            stylesheet.addEventListener('load',finish,{once:true});
            stylesheet.addEventListener('error',finish,{once:true});
        });
        stylesheet.rel='stylesheet';
        stylesheet.href=new URL('../case-tree.css?v=2',import.meta.url).href;
        host.shadowRoot.append(stylesheet);
        await styleReady;
        await host.setProvider(createCaseTreeProvider(()=>this.caseRecord));
        let pointerDirectoryActivation=false;
        host.addEventListener('pointerdown',event=>{
            pointerDirectoryActivation=event.composedPath().some(node=>
                node?.matches?.('.tree-item[data-kind="directory"]')
            );
        },{capture:true});
        host.addEventListener('keydown',()=>{
            pointerDirectoryActivation=false;
        },{capture:true});
        host.addEventListener('file-manager-select',async event=>{
            const entry=event.detail?.entry;
            if(entry?.kind==='directory'){
                const releasePointerFocus=pointerDirectoryActivation;
                pointerDirectoryActivation=false;
                host.clearSelection({emit:false});
                const focusedEntry=host.shadowRoot.activeElement;
                if(releasePointerFocus&&focusedEntry?.matches?.('.tree-item[data-kind="directory"]')){
                    focusedEntry.blur();
                }
                return;
            }
            pointerDirectoryActivation=false;
            if(entry?.kind!=='file'){
                return;
            }
            const record=this.caseRecord.files.find(file=>file.id===entry.record?.id||file.path===event.detail.path);
            if(record){
                try{
                    await this.selectFile(record,{syncTree:false});
                }catch(error){
                    this.renderInspectorError(error);
                }
            }
        });
        host.addEventListener('file-manager-open',async event=>{
            event.preventDefault();
            const entry=event.detail?.entry;
            const record=this.caseRecord.files.find(file=>
                file.id===entry?.record?.id||file.path===event.detail?.path
            );
            if(!record){
                return;
            }
            try{
                if(this.selectedFile?.id!==record.id){
                    await this.selectFile(record,{syncTree:false});
                }
                await this.openSelectedFile(record);
            }catch(error){
                this.renderInspectorError(error);
            }
        });
        this.caseTree=host;
    }

    async initializeAssistantPanel(){
        this.assistantPanel=await waitForComponent($('#assistantPanel'),{
            methods:['open','close','toggle','setState','scrollToEnd'],
            property:'ready',
            event:'assistant-ready'
        });
        return this.assistantPanel;
    }

    async initializeSummaryStrip(){
        this.summaryStrip=await waitForComponent($('#caseSummaryStrip'),{
            methods:['setItems','updateItem'],
            property:'ready',
            event:'summary-strip-ready'
        });
        return this.summaryStrip;
    }

    async initializeDialogs(){
        const definitions=[
            ['caseProfile','#caseProfileDialog','#caseProfileDialogContent','#caseProfileForm'],
            ['newCase','#newCaseDialog','#newCaseDialogContent','#newCaseForm'],
            ['aiSettings','#aiSettingsDialog','#aiSettingsDialogContent','#aiSettingsForm'],
            ['filePreview','#filePreviewDialog','#filePreviewDialogContent',null]
        ];

        await Promise.all(definitions.map(async([name,hostSelector,templateSelector,formSelector])=>{
            const host=await waitForComponent($(hostSelector),{
                methods:['populate','open','close'],
                property:'ready',
                event:'modal-ready'
            });
            const template=$(templateSelector);
            const content=document.createElement('section');
            const stylesheet=document.createElement('link');
            const styleReady=new Promise(resolve=>{
                const finish=()=>resolve();
                stylesheet.addEventListener('load',finish,{once:true});
                stylesheet.addEventListener('error',finish,{once:true});
            });

            content.className='redress-modal-content';
            stylesheet.rel='stylesheet';
            stylesheet.href='./apps/redress/redress-modal.css?v=4';
            content.append(stylesheet,template.content.cloneNode(true));
            await host.populate(content,false);
            await styleReady;

            const closeButton=host.shadowRoot?.querySelector('#close');
            if(closeButton){
                closeButton.type='button';
                closeButton.setAttribute('aria-label','Close');
                closeButton.title='Close';
            }

            this.dialogs.set(name,{
                host,
                content,
                form:formSelector?$(formSelector,content):null
            });
        }));
    }

    dialog(name){
        const dialog=this.dialogs.get(name);
        if(!dialog){
            throw new Error(`Redress modal ${name} is unavailable.`);
        }
        return dialog;
    }

    bindNavigation(){
        const update=()=>{
            const view=location.hash.replace(/^#/,'')||'workspace';
            const selected=$$('[data-view-panel]').find(panel=>panel.dataset.viewPanel===view)
                ||$('[data-view-panel="workspace"]');
            $$('[data-view-panel]').forEach(panel=>{
                const active=panel===selected;
                panel.hidden=!active;
                panel.classList.toggle('active',active);
            });
            if($('.workbench')){
                $('.workbench').scrollTop=0;
            }
        };
        window.addEventListener('hashchange',update);
        update();
    }

    bindDialogs(){
        $('#editCaseProfile').addEventListener('click',()=>this.openProfile());
        $$('[data-open-profile]').forEach(button=>button.addEventListener('click',()=>this.openProfile()));
        $('#newCaseButton').addEventListener('click',()=>this.dialog('newCase').host.open());
        window.addEventListener('redress-open-ai-settings',()=>this.openAISettings());
        for(const dialog of this.dialogs.values()){
            $$('[data-close-dialog]',dialog.content).forEach(button=>{
                button.addEventListener('click',()=>dialog.host.close(undefined,true));
            });
        }

        const provider=this.dialog('aiSettings').form.elements.namedItem('provider');
        provider.addEventListener('change',()=>this.updateAISettingsVisibility());
    }

    bindProfileForms(){
        const caseProfileForm=this.dialog('caseProfile').form;
        const newCaseForm=this.dialog('newCase').form;
        const aiSettingsForm=this.dialog('aiSettings').form;

        $('#caseSwitcher').addEventListener('change',async event=>{
            const caseId=event.target.value;
            const lookup=++this.caseLookupSequence;
            const record=await this.repository.getCase(caseId);
            if(record&&lookup===this.caseLookupSequence){
                await this.activateCase(record);
            }
        });

        caseProfileForm.addEventListener('submit',async event=>{
            event.preventDefault();
            const values=formObject(event.currentTarget);
            const caseRecord=this.caseRecord;
            caseRecord.profile={
                ...(caseRecord.profile||{}),
                ...values,
                matterTypes:[values.matterType]
            };
            caseRecord.title=values.caseName||caseRecord.title;
            caseRecord.caseNumber=values.caseNumber||'';
            await this.repository.saveCase(caseRecord);
            await this.dialog('caseProfile').host.close(undefined,true);
            if(this.caseRecord.id===caseRecord.id){
                await this.render();
            }
        });

        newCaseForm.addEventListener('submit',async event=>{
            event.preventDefault();
            const record=await this.repository.createCase(formObject(event.currentTarget));
            await this.dialog('newCase').host.close(undefined,true);
            event.currentTarget.reset();
            await this.activateCase(record);
        });

        aiSettingsForm.addEventListener('submit',async event=>{
            event.preventDefault();
            const values=formObject(event.currentTarget);
            await this.applyAISettings(values,{persist:true});
            await this.dialog('aiSettings').host.close(undefined,true);
        });
    }

    bindImports(){
        const caseInput=$('#caseFolderInput');
        const filingInput=$('#filingInput');
        const evidenceInput=$('#evidenceInput');
        $$('[data-import-case]').forEach(button=>button.addEventListener('click',event=>{
            event.stopPropagation();
            caseInput.click();
        }));
        $$('[data-import-evidence]').forEach(button=>button.addEventListener('click',event=>{
            event.stopPropagation();
            evidenceInput.click();
        }));
        $$('[data-import-filing]').forEach(button=>button.addEventListener('click',event=>{
            event.stopPropagation();
            filingInput.click();
        }));
        caseInput.addEventListener('change',()=>this.runImport(caseInput.files,'case').finally(()=>{caseInput.value='';}));
        filingInput.addEventListener('change',()=>this.runImport(filingInput.files,'filing').finally(()=>{filingInput.value='';}));
        evidenceInput.addEventListener('change',()=>this.runImport(evidenceInput.files,'evidence').finally(()=>{evidenceInput.value='';}));

        this.bindDropZone($('#caseDropZone'),'case',()=>caseInput.click());
        this.bindDropZone($('#filingDropZone'),'filing',()=>filingInput.click());
        this.bindDropZone($('#evidenceDropZone'),'evidence',()=>evidenceInput.click());
    }

    bindDropZone(zone,mode,openPicker){
        zone.addEventListener('click',event=>{
            if(event.target.closest('button')){
                return;
            }
            openPicker();
        });
        zone.addEventListener('keydown',event=>{
            if(event.target!==zone){
                return;
            }
            if(event.key==='Enter'||event.key===' '){
                event.preventDefault();
                openPicker();
            }
        });
        for(const name of ['dragenter','dragover']){
            zone.addEventListener(name,event=>{
                event.preventDefault();
                zone.classList.add('dragover');
            });
        }
        for(const name of ['dragleave','drop']){
            zone.addEventListener(name,event=>{
                event.preventDefault();
                zone.classList.remove('dragover');
            });
        }
        zone.addEventListener('drop',event=>this.runImport(event.dataTransfer,mode));
    }

    bindTaskForms(){
        $('#analysisForm').addEventListener('submit',event=>{
            event.preventDefault();
            const values=formObject(event.currentTarget);
            this.runLegalTask('analysis',values,$('#analysisOutput'),event.submitter,`Analysis - ${values.mode}`);
        });
        $('#draftForm').addEventListener('submit',event=>{
            event.preventDefault();
            const values=formObject(event.currentTarget);
            this.runLegalTask('draft',values,$('#draftOutput'),event.submitter,`Draft - ${values.documentType}`);
        });
        $('#researchForm').addEventListener('submit',event=>{
            event.preventDefault();
            const values=formObject(event.currentTarget);
            values.scopes=$$('input[name="scopes"]:checked',event.currentTarget).map(input=>input.value);
            this.runLegalTask('research',values,$('#researchOutput'),event.submitter,'Research Plan');
        });
        $('#argumentForm').addEventListener('submit',event=>{
            event.preventDefault();
            const values=formObject(event.currentTarget);
            this.runLegalTask('argument',values,$('#argumentOutput'),event.submitter,'Oral Argument');
        });
        $('#startSocraticPractice').addEventListener('click',()=>{
            const values=formObject($('#argumentForm'));
            $('#chatInput').value=[
                `Coach me interactively for ${values.hearingType||'my next hearing'}.`,
                `The result I want is: ${values.requestedResult||'[not yet stated]'}.`,
                `My main concern is: ${values.concern||'[not yet stated]'}.`,
                'Use the configured court, jurisdiction, and case record. Ask exactly one Socratic question, wait for my answer, then give concise feedback before asking the next question. Test my rule, source citation, application, counterargument, and requested relief.'
            ].join('\n');
            this.assistantPanel.open();
            $('#chatForm').requestSubmit();
        });
    }

    bindChat(){
        const panel=this.assistantPanel;
        panel.addEventListener('assistant-send',async event=>{
            const message=event.detail.message;
            const button=event.detail.submitter||$('#chatForm button[type="submit"]');
            const buttonOwner=this.lockButton(button);
            if(!buttonOwner){
                event.preventDefault();
                return;
            }
            panel.setState('pending','Working from the case record...');
            const caseRecord=this.caseRecord;
            const caseId=caseRecord.id;
            const epoch=this.caseEpoch;
            const sequence=(this.chatSequences.get(caseId)||0)+1;
            this.chatSequences.set(caseId,sequence);
            const isCurrentRequest=()=>this.chatSequences.get(caseId)===sequence;
            const requestHistory=[...this.chatHistory,{role:'user',content:message}].slice(-40);
            this.chatHistory=requestHistory;
            this.renderChat();
            const pending=this.addChatMessage('Working from the case record...','assistant pending');
            try{
                const context=await this.repository.getLegalContext(caseRecord,{
                    query:message,
                    totalCharacterLimit:52000
                });
                this.descriptor.ai=globalThis.ai;
                const result=await this.assistant.generate('chat',{
                    profile:profileView(caseRecord),
                    documents:context.documents,
                    coverage:context.coverage,
                    history:requestHistory.slice(0,-1),
                    message
                });
                const completedHistory=[...requestHistory,{
                    role:'assistant',
                    content:`${coverageNotice(context.coverage)}\n\n${result.text}`
                }].slice(-40);
                if(!isCurrentRequest()){
                    return;
                }
                caseRecord.chatHistory=completedHistory;
                await this.repository.saveCase(caseRecord);
                if(this.caseRecord.id===caseId&&this.caseEpoch===epoch){
                    pending.remove();
                    this.chatHistory=completedHistory;
                    this.renderChat();
                }
            }catch(error){
                if(isCurrentRequest()){
                    caseRecord.chatHistory=requestHistory;
                    await this.repository.saveCase(caseRecord).catch(()=>{});
                    if(this.caseRecord.id===caseId&&this.caseEpoch===epoch){
                        pending.className='chat-message error';
                        pending.textContent=this.friendlyAIError(error);
                        panel.setState('error',pending.textContent);
                    }
                }
            }finally{
                this.unlockButton(button,buttonOwner);
                if(panel.state!=='error'){
                    panel.setState('ready');
                }
            }
        });
        panel.addEventListener('assistant-clear',async()=>{
            const caseRecord=this.caseRecord;
            this.chatSequences.set(caseRecord.id,(this.chatSequences.get(caseRecord.id)||0)+1);
            const sendButton=$('#chatForm button[type="submit"]');
            this.buttonOwners.delete(sendButton);
            sendButton.disabled=false;
            this.chatHistory=[];
            caseRecord.chatHistory=[];
            await this.repository.saveCase(caseRecord);
            this.renderChat();
            panel.setState('ready');
        });
        const toggle=$('#assistantDrawerToggle');
        toggle.addEventListener('click',()=>panel.toggle());
        panel.addEventListener('assistant-opened',()=>toggle.setAttribute('aria-expanded','true'));
        panel.addEventListener('assistant-closed',()=>toggle.setAttribute('aria-expanded','false'));

        const overlayQuery=matchMedia('(max-width:82rem)');
        const syncLayout=event=>{
            const overlay=event.matches;
            panel.layout=overlay?'overlay':'docked';
            if(overlay){
                panel.close({returnFocus:false});
            }else{
                panel.open({focus:false});
            }
            toggle.setAttribute('aria-expanded',String(panel.opened));
        };
        overlayQuery.addEventListener('change',syncLayout);
        syncLayout(overlayQuery);
    }

    bindInspectorActions(){
        $('#downloadFile').addEventListener('click',()=>this.openSelectedFile());
        $('#regenerateDescription').addEventListener('click',()=>this.regenerateSelectedDescription());
        const previewDialog=this.dialog('filePreview');
        $('#downloadPreviewFile',previewDialog.content).addEventListener('click',()=>this.downloadPreviewFile());
        previewDialog.host.addEventListener('modal-closed',()=>this.releaseFilePreview());
    }

    async runImport(source,mode){
        const caseRecord=this.caseRecord;
        const caseId=caseRecord.id;
        const epoch=this.caseEpoch;
        const isActive=()=>this.caseRecord.id===caseId&&this.caseEpoch===epoch;
        const status=$('#importStatus');
        const title=$('#importStatusTitle');
        const detail=$('#importStatusDetail');
        const progress=$('#importProgress');
        status.hidden=false;
        title.textContent=mode==='case'
            ?'Reading case folder'
            :mode==='filing'?'Reading filed PDFs':'Reading evidence';
        detail.textContent='Inspecting names and paths...';
        progress.style.width='2%';
        this.descriptor.ai=globalThis.ai;

        try{
            const result=await this.importer.import(source,{
                caseRecord,
                mode,
                onProgress:update=>{
                    if(!isActive()){
                        return;
                    }
                    const percent=update.total?Math.max(2,Math.round(update.completed/update.total*100)):2;
                    progress.style.width=`${Math.min(100,percent)}%`;
                    title.textContent=update.stage==='describing'?'Creating Markdown descriptions':'Importing case material';
                    detail.textContent=update.message||`${update.completed} of ${update.total}`;
                }
            });
            if(isActive()){
                this.caseRecord=result.caseRecord;
                progress.style.width='100%';
                title.textContent=`Imported ${result.imported.length} file${result.imported.length===1?'':'s'}`;
                detail.textContent=`Created ${result.generated.length} Markdown description${result.generated.length===1?'':'s'}; skipped ${result.skipped.length}; ${result.failures.length} need attention.`;
                await this.render();
            }
        }catch(error){
            if(isActive()){
                title.textContent='Import stopped';
                detail.textContent=error.message;
                progress.style.width='100%';
                progress.style.background='var(--danger-color)';
            }
            console.error(error);
        }
    }

    async runLegalTask(kind,values,output,button,label){
        const caseRecord=this.caseRecord;
        const caseId=caseRecord.id;
        const epoch=this.caseEpoch;
        const isActive=()=>this.caseRecord.id===caseId&&this.caseEpoch===epoch;
        const buttonOwner=this.lockButton(button);
        if(!buttonOwner){
            return;
        }
        output.classList.add('loading');
        this.renderMarkdown(output,'Reading the case descriptions and preparing a source-grounded response...');
        try{
            const context=await this.repository.getLegalContext(caseRecord,{
                query:contextQuery(kind,values)
            });
            const result=await this.assistant.generate(kind,{
                ...values,
                profile:profileView(caseRecord),
                documents:context.documents,
                coverage:context.coverage
            });
            const workProduct=`${coverageNotice(context.coverage)}\n\n${result.text}`;
            await this.saveWorkProduct(caseRecord,kind,label,workProduct);
            if(isActive()){
                this.renderMarkdown(output,workProduct);
                await this.renderTree();
            }
        }catch(error){
            if(isActive()){
                this.renderMarkdown(output,this.friendlyAIError(error));
            }
            console.warn(error);
        }finally{
            if(isActive()){
                output.classList.remove('loading');
            }
            this.unlockButton(button,buttonOwner);
        }
    }

    renderMarkdown(target,markdown='',{sourceRecord=null}={}){
        if(!target){
            return null;
        }
        const template=document.createElement('template');
        template.innerHTML=new MD(neutralizeMarkdownSource(markdown)).safeRendered;
        constrainMarkdownFragment(template.content);
        template.content.querySelectorAll('a[href]').forEach(anchor=>{
            const href=anchor.getAttribute('href')||'';
            const linkedRecord=this.resolveMarkdownCaseLink(sourceRecord,href);
            if(linkedRecord){
                anchor.href='#';
                anchor.classList.add('case-file-link');
                anchor.removeAttribute('target');
                anchor.title=`Open ${linkedRecord.name||linkedRecord.path}`;
                anchor.addEventListener('click',async event=>{
                    event.preventDefault();
                    const sourcePreview=this.filePreview;
                    const sourceRequestSequence=this.filePreviewRequestSequence;
                    try{
                        await this.selectFile(linkedRecord);
                        if(sourcePreview&&(this.filePreview!==sourcePreview
                            ||this.filePreviewRequestSequence!==sourceRequestSequence)){
                            return;
                        }
                        await this.openSelectedFile(linkedRecord);
                    }catch(error){
                        alert(`Unable to open the linked case file: ${error.message}`);
                    }
                });
                return;
            }
            if(href.startsWith('#')){
                anchor.removeAttribute('target');
                anchor.removeAttribute('rel');
                return;
            }
            if(!/^(?:https?:|mailto:|tel:)/i.test(href)){
                anchor.removeAttribute('href');
                anchor.removeAttribute('target');
                anchor.setAttribute('aria-disabled','true');
                anchor.title=/^[a-z][a-z0-9+.-]*:/i.test(href)||href.startsWith('//')
                    ?'This link type is not available in the Redress preview'
                    :'Linked case file is not available in this workspace';
                return;
            }
            anchor.target='_blank';
            anchor.rel='noopener noreferrer';
            anchor.referrerPolicy='no-referrer';
            anchor.removeAttribute('ping');
        });
        template.content.querySelectorAll('img').forEach(image=>{
            const source=image.getAttribute('src')||'';
            image.removeAttribute('srcset');
            image.removeAttribute('sizes');
            if(/^data:image\/(?:bmp|gif|jpeg|png|webp);base64,/i.test(source)){
                return;
            }
            const replacement=document.createElement('span');
            replacement.className='markdown-image-omitted';
            replacement.textContent=image.alt
                ?`[Image omitted: ${image.alt}]`
                :'[External image omitted]';
            image.replaceWith(replacement);
        });
        target.replaceChildren(template.content);
        return target;
    }

    resolveMarkdownCaseLink(sourceRecord,href=''){
        let value=String(href||'').trim();
        if(!value||value.startsWith('#')||value.startsWith('/')||value.startsWith('\\')
            ||value.startsWith('//')||/^[a-z][a-z0-9+.-]*:/i.test(value)){
            return null;
        }
        value=value.split(/[?#]/,1)[0];
        try{
            value=decodeURIComponent(value);
        }catch{
            return null;
        }
        const segments=sourceRecord?.path?sourceRecord.path.split('/').slice(0,-1):[];
        for(const segment of value.replaceAll('\\','/').split('/')){
            if(!segment||segment==='.'){
                continue;
            }
            if(segment==='..'){
                if(!segments.length){
                    return null;
                }
                segments.pop();
                continue;
            }
            segments.push(segment);
        }
        try{
            const path=normalizeRelativePath(segments.join('/'));
            return this.repository.findByPath(this.caseRecord,path)||null;
        }catch{
            return null;
        }
    }

    friendlyAIError(error){
        if(error?.code==='AI_PROVIDER_NOT_CONFIGURED'){
            return 'AI is not configured yet. Open AI settings, choose the local Redress Ollama model or OpenAI, then run this task again. Your case files remain stored.';
        }
        if(error?.code==='AI_SERVICE_UNREACHABLE'){
            return 'Redress could not reach the selected AI provider. Confirm the local model service is running or check the provider connection, then try again.';
        }
        return `Redress could not complete this work: ${error?.message||'Unknown AI error'}`;
    }

    async saveWorkProduct(caseRecord,kind,label,text){
        const folders={analysis:'Analysis',argument:'Oral Argument',draft:'Drafts',research:'Research'};
        const folder=folders[kind]||'Notes';
        const stamp=new Date().toISOString().slice(0,19).replace(/[T:]/g,'-');
        const path=this.repository.uniquePath(
            caseRecord,
            `Work Product/${folder}/${stamp} - ${safeWorkProductName(label)}.md`
        );
        await this.repository.putGeneratedMarkdown(caseRecord,path,text,{kind:'work-product',status:'needs-review'});
        await this.repository.saveCase(caseRecord);
    }

    async activateCase(record){
        this.caseLookupSequence++;
        const activation=++this.activationSequence;
        this.caseEpoch++;
        this.caseRecord=record;
        this.selectedFile=null;
        await this.caseTree?.clearSelection?.({emit:false});
        this.chatHistory=Array.isArray(record.chatHistory)?record.chatHistory.slice(-40):[];
        this.clearCaseSpecificUI();
        this.activeCaseWrite=this.activeCaseWrite
            .catch(()=>{})
            .then(()=>this.repository.setActiveCase(record.id));
        await this.activeCaseWrite;
        if(activation!==this.activationSequence){
            return;
        }
        await this.render();
    }

    clearCaseSpecificUI(){
        this.inspectorSequence++;
        this.dialogs.get('filePreview')?.host.close(undefined,true);
        this.releaseFilePreview();
        $('#selectedFileActions').hidden=true;
        const inspector=$('#fileInspector');
        inspector.className='file-inspector empty';
        inspector.innerHTML='<div class="inspector-placeholder"><span aria-hidden="true">R</span><p>Select a file from the case record to review its provenance, Markdown description, or original.</p></div>';
        this.renderMarkdown($('#analysisOutput'),'Choose an analysis and give Redress a focused question.');
        this.renderMarkdown($('#draftOutput'),'Select a document type and tell Redress what the document must accomplish.');
        this.renderMarkdown($('#researchOutput'),'State a narrow legal question. Redress will map authority levels, search terms, propositions to verify, and official-source targets.');
        this.renderMarkdown($('#argumentOutput'),'Give Redress the hearing, time limit, requested result, and the question you least want to hear.');
        $$('.legal-output').forEach(output=>output.classList.remove('loading'));
        $('#importStatus').hidden=true;
        $$('button:disabled').forEach(button=>{
            if(button.id!=='voiceNote'){
                this.buttonOwners.delete(button);
                button.disabled=false;
            }
        });
    }

    lockButton(button){
        if(!button||button.disabled){
            return null;
        }
        const owner=Symbol('redress-button-owner');
        this.buttonOwners.set(button,owner);
        button.disabled=true;
        return owner;
    }

    unlockButton(button,owner){
        if(button&&owner&&this.buttonOwners.get(button)===owner){
            this.buttonOwners.delete(button);
            button.disabled=false;
        }
    }

    async render(){
        this.renderCaseSummary();
        await this.renderCaseSwitcher();
        await this.renderTree();
        this.renderChat();
        $('#storageName').textContent=this.repository.providerName;
    }

    renderCaseSummary(){
        const profile=profileView(this.caseRecord);
        $('#railCaseName').textContent=profile.caseName;
        $('#railJurisdiction').textContent=profile.jurisdiction||'Jurisdiction needed';
        $('#caseTitle').textContent=profile.caseName==='New legal matter'
            ?'Build the record. Find the rule. Prepare the ask.'
            :profile.caseName;
        $('#caseSummary').textContent=profile.goals||'Start with the court filings and evidence. Redress keeps the source beside every description, analysis, and draft.';
        this.summaryStrip?.setItems([
            {id:'forum',label:'Forum',value:profile.court||profile.jurisdiction||'Not set'},
            {id:'matter',label:'Matter',value:profile.matterType?`${profile.matterType[0].toUpperCase()}${profile.matterType.slice(1)}`:'Not set'},
            {id:'hearing',label:'Next date',value:formatDate(profile.nextHearing)},
            {id:'record',label:'Record',value:`${this.caseRecord.files.length} file${this.caseRecord.files.length===1?'':'s'}`}
        ]);
        $('#fileCount').textContent=String(this.caseRecord.files.length);
    }

    async renderCaseSwitcher(){
        const switcher=$('#caseSwitcher');
        const records=await this.repository.listCases();
        switcher.replaceChildren();
        for(const record of records){
            const profile=profileView(record);
            const option=document.createElement('option');
            option.value=record.id;
            option.textContent=[profile.caseNumber,profile.caseName].filter(Boolean).join(' - ');
            option.selected=record.id===this.caseRecord.id;
            switcher.append(option);
        }
    }

    async renderTree(){
        if(this.caseTree){
            await this.caseTree.loadAll();
            if(this.selectedFile?.path){
                await this.caseTree.select(this.selectedFile.path,{emit:false,focus:false});
            }
        }
        $('#fileCount').textContent=String(this.caseRecord.files.length);
        this.summaryStrip?.updateItem('record',{
            value:`${this.caseRecord.files.length} file${this.caseRecord.files.length===1?'':'s'}`
        });
    }

    async selectFile(record,{syncTree=true}={}){
        if(!record){
            return;
        }
        const caseId=this.caseRecord.id;
        const epoch=this.caseEpoch;
        this.selectedFile=record;
        if(syncTree&&this.caseTree){
            await this.caseTree.select(record.path,{emit:false,focus:false});
        }
        if(this.caseRecord.id===caseId&&this.caseEpoch===epoch){
            await this.renderInspector(record);
        }
    }

    async renderInspector(record){
        const sequence=++this.inspectorSequence;
        const caseId=this.caseRecord.id;
        const epoch=this.caseEpoch;
        const isActive=()=>this.caseRecord.id===caseId
            &&this.caseEpoch===epoch
            &&this.selectedFile?.id===record.id
            &&this.inspectorSequence===sequence;
        if(!isActive()){
            return;
        }
        const inspector=$('#fileInspector');
        const actions=$('#selectedFileActions');
        actions.hidden=false;
        $('#regenerateDescription').hidden=!['filing','evidence'].includes(record.kind);
        inspector.classList.remove('empty');
        inspector.replaceChildren();

        const meta=document.createElement('div');
        meta.className='inspector-meta';
        const entries=[
            ['Case path',record.path],
            ['Original',record.originalName||record.name],
            ['Original path',record.originalPath||'Not recorded'],
            ['Type',record.mimeType||record.kind||'Unknown'],
            ['Size',formatBytes(record.size)],
            ['SHA-256',record.hash?.value||record.hash?.status||'Pending'],
            ['Imported',record.importedAt?new Date(record.importedAt).toLocaleString():'Not recorded'],
            ['Review',record.status||'ready']
        ];
        for(const [label,value] of entries){
            const cell=document.createElement('div');
            const heading=document.createElement('span');
            const content=document.createElement('strong');
            heading.textContent=label;
            content.textContent=String(value||'');
            cell.append(heading,content);
            meta.append(cell);
        }
        inspector.append(meta);

        const rename=document.createElement('form');
        rename.className='inspector-rename';
        const input=document.createElement('input');
        input.value=record.path;
        input.setAttribute('aria-label','Case-relative path');
        const save=document.createElement('button');
        save.type='submit';
        save.className='button tertiary';
        save.textContent='Save path';
        rename.append(input,save);
        rename.addEventListener('submit',async event=>{
            event.preventDefault();
            await this.renameSelectedFile(input.value);
        });
        inspector.append(rename);

        let preview;
        let truncated=false;
        const kind=previewKind(record);
        try{
            if(kind==='markdown'||kind==='text'){
            const file=await this.repository.readFile(record);
            if(!isActive()){
                return;
            }
            const result=await this.readFilePreviewText(file);
            if(!isActive()){
                return;
            }
            truncated=result.truncated;
            if(result.binary){
                preview=document.createElement('pre');
                preview.className='file-preview plain-text-preview';
                preview.textContent='This file contains binary data even though its name or media type identifies it as text. Open the original to use the download fallback.';
            }else if(kind==='markdown'){
                preview=document.createElement('article');
                preview.className='file-preview markdown-content';
                this.renderMarkdown(preview,result.text,{sourceRecord:record});
            }else{
                preview=document.createElement('pre');
                preview.className='file-preview plain-text-preview';
                preview.textContent=result.text;
            }
            }else{
                preview=document.createElement('pre');
                preview.className='file-preview plain-text-preview';
                const description=record.descriptionPath
                    ?this.repository.findByPath(this.caseRecord,record.descriptionPath)
                    :null;
                preview.textContent=description
                    ?`Original binary is preserved. Its review file is ${description.path}.\n\nSelect that Markdown file in the case tree to read the description.`
                    :'Original binary is preserved. A Markdown description is not linked yet; choose “Describe again” to create one.';
            }
        }catch(error){
            if(isActive()){
                this.renderInspectorError(error);
            }else{
                console.warn('Ignoring a stale file-inspector error.',error);
            }
            return;
        }
        if(!isActive()){
            return;
        }
        inspector.append(preview);
        if(truncated){
            const note=document.createElement('p');
            note.className='native-preview-note';
            note.textContent=`Inspector preview limited to the first ${formatBytes(TEXT_PREVIEW_BYTE_LIMIT)}. Open the original to inspect the complete file.`;
            inspector.append(note);
        }
    }

    renderInspectorError(error){
        this.inspectorSequence++;
        const inspector=$('#fileInspector');
        const message=document.createElement('p');
        message.className='form-note warning-note';
        message.textContent='Redress could not read this stored file. Reimport the authoritative original or remove the unavailable record entry.';
        inspector.classList.remove('empty');
        inspector.replaceChildren(message);
        $('#selectedFileActions').hidden=true;
        console.error('Unable to render the selected file.',error);
    }

    async renameSelectedFile(value){
        if(!this.selectedFile){
            return;
        }
        const selectedFile=this.selectedFile;
        const caseRecord=this.caseRecord;
        const caseId=caseRecord.id;
        const epoch=this.caseEpoch;
        const isActive=()=>this.caseRecord.id===caseId&&this.caseEpoch===epoch;
        try{
            if(selectedFile.kind==='description'&&selectedFile.descriptionFor){
                throw new Error('Rename the paired original; Redress will move and refresh its Markdown description with it.');
            }
            const newPath=normalizeRelativePath(value);
            const requiredRoot=selectedFile.kind==='filing'
                ?'Filing by Filing/PDF/'
                :selectedFile.kind==='evidence'?'Evidence/Raw/':'';
            if(requiredRoot&&!newPath.toLowerCase().startsWith(requiredRoot.toLowerCase())){
                throw new Error(`This source must stay inside ${requiredRoot.slice(0,-1)}.`);
            }
            const oldDescription=selectedFile.descriptionPath
                ?this.repository.findByPath(caseRecord,selectedFile.descriptionPath)
                :null;
            const newDescription=oldDescription?companionPathFor(newPath):null;
            const descriptionCollision=newDescription
                ?this.repository.findByPath(caseRecord,newDescription)
                :null;
            if(descriptionCollision&&descriptionCollision.id!==oldDescription.id){
                throw new Error(`A case file already exists at ${newDescription}.`);
            }
            await this.repository.renameFile(caseRecord,selectedFile,newPath);
            if(oldDescription&&['filing','evidence'].includes(selectedFile.kind)){
                if(newDescription){
                    await this.repository.renameFile(caseRecord,oldDescription,newDescription);
                    oldDescription.descriptionFor=newPath;
                    oldDescription.status='needs-review';
                    selectedFile.descriptionPath=newDescription;
                    await this.repository.saveCase(caseRecord);
                }
            }
            if(['filing','evidence'].includes(selectedFile.kind)&&isActive()){
                await this.regenerateSelectedDescription(selectedFile);
                return;
            }
            if(isActive()){
                await this.render();
                if(this.selectedFile?.id===selectedFile.id){
                    await this.renderInspector(selectedFile);
                }
            }
        }catch(error){
            if(isActive()){
                alert(`Unable to rename this case file: ${error.message}`);
            }else{
                console.warn(error);
            }
        }
    }

    async openSelectedFile(record=this.selectedFile){
        if(!record){
            return;
        }
        const button=$('#downloadFile');
        const buttonOwner=this.lockButton(button);
        if(!buttonOwner){
            return;
        }
        const requestSequence=++this.filePreviewRequestSequence;
        const caseId=this.caseRecord.id;
        const epoch=this.caseEpoch;
        try{
            const file=await this.repository.readFile(record);
            if(this.caseRecord.id!==caseId
                ||this.caseEpoch!==epoch
                ||requestSequence!==this.filePreviewRequestSequence){
                return;
            }
            await this.showFilePreview(record,file,{requestSequence});
        }catch(error){
            if(this.caseRecord.id===caseId
                &&this.caseEpoch===epoch
                &&requestSequence===this.filePreviewRequestSequence){
                alert(`Unable to preview this file: ${error.message}`);
            }else{
                console.warn(error);
            }
        }finally{
            this.unlockButton(button,buttonOwner);
        }
    }

    async showFilePreview(record,file,{requestSequence=this.filePreviewRequestSequence}={}){
        if(requestSequence!==this.filePreviewRequestSequence){
            return false;
        }
        const sequence=++this.filePreviewSequence;
        this.releaseFilePreview({invalidate:false});
        const dialog=this.dialog('filePreview');
        const surface=$('#filePreviewSurface',dialog.content);
        const mimeType=previewMimeType(record,file);
        let kind=previewKind(record,file);
        let reason='';

        if(kind==='pdf'&&!await hasPdfSignature(file)){
            kind='unsupported';
            reason='This item is labeled as a PDF, but its stored bytes do not contain a PDF signature.';
        }
        if(sequence!==this.filePreviewSequence||requestSequence!==this.filePreviewRequestSequence){
            return false;
        }

        const typedFile=mimeType&&file.type!==mimeType
            ?file.slice(0,file.size,mimeType)
            :file;
        const state={record,file,typedFile,mimeType,kind,reason,url:URL.createObjectURL(typedFile)};
        this.filePreview=state;
        $('#filePreviewTitle',dialog.content).textContent=record.name||record.originalName||'File preview';
        $('#filePreviewMeta',dialog.content).textContent=[
            mimeType||record.extension||'Unknown format',
            formatBytes(file.size),
            kind==='unsupported'?'Download required':'Native browser preview'
        ].join(' · ');

        try{
            await this.renderNativeFilePreview(surface,state);
            if(sequence!==this.filePreviewSequence
                ||requestSequence!==this.filePreviewRequestSequence
                ||this.filePreview!==state){
                if(this.filePreview===state){
                    this.releaseFilePreview({invalidate:false});
                }
                return false;
            }
            await dialog.host.open();
            queueMicrotask(()=>{
                if(this.filePreview===state){
                    dialog.host.shadowRoot?.querySelector('#close')?.focus({preventScroll:true});
                }
            });
            return true;
        }catch(error){
            if(this.filePreview===state){
                this.releaseFilePreview({invalidate:false});
            }
            throw error;
        }
    }

    async renderNativeFilePreview(surface,state){
        const {file,kind,record,url}=state;
        surface.replaceChildren();
        surface.dataset.kind=kind;

        if(!file.size){
            this.renderPreviewFallback(surface,'This file is empty.','There are no bytes to display. You can still download the original record.');
            return;
        }

        if(kind==='pdf'){
            const frame=document.createElement('iframe');
            frame.className='native-file-frame';
            frame.src=url;
            frame.title=`PDF preview: ${record.name||record.originalName||'case file'}`;
            surface.append(frame);
            return;
        }

        if(kind==='image'){
            const image=document.createElement('img');
            image.className='native-image-preview';
            image.src=url;
            image.alt=`Preview of ${record.name||record.originalName||'case image'}`;
            this.bindNativePreviewError(image,surface,state,'This browser could not decode the stored image.');
            surface.append(image);
            return;
        }

        if(kind==='audio'){
            const audio=document.createElement('audio');
            audio.className='native-audio-preview';
            audio.src=url;
            audio.controls=true;
            audio.preload='metadata';
            audio.textContent='This browser cannot play the stored audio.';
            this.bindNativePreviewError(audio,surface,state,'This browser does not support the stored audio encoding.');
            surface.append(audio);
            return;
        }

        if(kind==='video'){
            const video=document.createElement('video');
            video.className='native-video-preview';
            video.src=url;
            video.controls=true;
            video.preload='metadata';
            video.playsInline=true;
            video.textContent='This browser cannot play the stored video.';
            this.bindNativePreviewError(video,surface,state,'This browser does not support the stored video encoding.');
            surface.append(video);
            return;
        }

        if(kind==='markdown'||kind==='text'){
            const result=await this.readFilePreviewText(file);
            if(this.filePreview!==state){
                return;
            }
            if(result.binary){
                this.renderPreviewFallback(surface,'Preview unavailable in this browser.','The file contains binary data even though its name or media type identifies it as text. Download the original to inspect it with a suitable native application.');
                return;
            }
            const preview=document.createElement(kind==='markdown'?'article':'pre');
            preview.className=kind==='markdown'
                ?'native-text-preview markdown-content'
                :'native-text-preview plain-text-preview';
            if(kind==='markdown'){
                this.renderMarkdown(preview,result.text,{sourceRecord:record});
            }else{
                preview.textContent=result.text;
            }
            surface.append(preview);
            if(result.truncated){
                const note=document.createElement('p');
                note.className='native-preview-note';
                note.textContent=`Preview limited to the first ${formatBytes(TEXT_PREVIEW_BYTE_LIMIT)}. Download the original to inspect the complete file.`;
                surface.append(note);
            }
            return;
        }

        this.renderPreviewFallback(
            surface,
            'Preview unavailable in this browser.',
            state.reason||'This format does not have a safe native browser viewer. Download the original to open it in a suitable native application.'
        );
    }

    bindNativePreviewError(element,surface,state,detail){
        element.addEventListener('error',()=>{
            if(this.filePreview!==state||!surface.isConnected){
                return;
            }
            surface.replaceChildren();
            this.renderPreviewFallback(surface,'Preview unavailable in this browser.',`${detail} Download the original to open it in a suitable native application.`);
        },{once:true});
    }

    async readFilePreviewText(file){
        const truncated=file.size>TEXT_PREVIEW_BYTE_LIMIT;
        const bytes=new Uint8Array(await file.slice(0,TEXT_PREVIEW_BYTE_LIMIT).arrayBuffer());
        return {
            binary:bytes.includes(0),
            text:new TextDecoder().decode(bytes),
            truncated
        };
    }

    renderPreviewFallback(surface,title,detail){
        const message=document.createElement('div');
        message.className='native-preview-fallback';
        const heading=document.createElement('strong');
        const body=document.createElement('p');
        heading.textContent=title;
        body.textContent=detail;
        message.append(heading,body);
        surface.append(message);
    }

    downloadPreviewFile(){
        if(!this.filePreview){
            return;
        }
        const anchor=document.createElement('a');
        anchor.href=this.filePreview.url;
        anchor.download=this.filePreview.record.name||this.filePreview.record.originalName||'case-file';
        anchor.hidden=true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
    }

    releaseFilePreview({invalidate=true}={}){
        if(invalidate){
            this.filePreviewRequestSequence++;
            this.filePreviewSequence++;
        }
        const dialog=this.dialogs.get('filePreview');
        const surface=dialog?$('#filePreviewSurface',dialog.content):null;
        surface?.querySelectorAll('audio,video').forEach(media=>media.pause());
        surface?.querySelectorAll('iframe,img,audio,video').forEach(element=>element.removeAttribute('src'));
        surface?.replaceChildren();
        if(this.filePreview?.url){
            URL.revokeObjectURL(this.filePreview.url);
        }
        this.filePreview=null;
    }

    async regenerateSelectedDescription(record=this.selectedFile){
        if(!record||!['filing','evidence'].includes(record.kind)){
            return;
        }
        const caseRecord=this.caseRecord;
        const caseId=caseRecord.id;
        const epoch=this.caseEpoch;
        const button=$('#regenerateDescription');
        const buttonOwner=this.lockButton(button);
        if(!buttonOwner){
            return;
        }
        try{
            const blob=await this.repository.readFile(record);
            const file=new File([blob],record.originalName||record.name,{
                type:record.mimeType||blob.type,
                lastModified:record.lastModified||Date.now()
            });
            this.descriptor.ai=globalThis.ai;
            const result=await this.descriptor.analyze(file,{
                kind:record.kind,
                path:record.path,
                caseProfile:profileView(caseRecord)
            });
            const descriptionPath=companionPathFor(record.path);
            const markdown=this.descriptor.buildMarkdown({
                kind:record.kind,
                rawRecord:record,
                analysis:result.analysis,
                extraction:result.extraction
            });
            await this.repository.putGeneratedMarkdown(caseRecord,descriptionPath,markdown,{
                kind:'description',
                descriptionFor:record.path,
                status:result.analysis.needsReview?'needs-review':'ready'
            });
            record.descriptionPath=descriptionPath;
            await this.repository.saveCase(caseRecord);
            if(this.caseRecord.id===caseId&&this.caseEpoch===epoch){
                await this.render();
                if(this.selectedFile?.id===record.id){
                    await this.renderInspector(record);
                }
            }
        }catch(error){
            if(this.caseRecord.id===caseId&&this.caseEpoch===epoch){
                alert(`Unable to create the description: ${error.message}`);
            }else{
                console.warn(error);
            }
        }finally{
            this.unlockButton(button,buttonOwner);
        }
    }

    openProfile(){
        const values=profileView(this.caseRecord);
        const form=this.dialog('caseProfile').form;
        for(const [name,value] of Object.entries(values)){
            const field=form.elements.namedItem(name);
            if(field){
                field.value=value||'';
            }
        }
        this.dialog('caseProfile').host.open();
    }

    async openAISettings(){
        const settings=await this.loadAISettings();
        const form=this.dialog('aiSettings').form;
        form.elements.provider.value=settings.provider||'OLLAMA';
        form.elements.localModel.value=settings.localModel||'REDRESS:120b';
        form.elements.apiKey.value=globalThis.user?.license_key||'';
        this.updateAISettingsVisibility();
        this.dialog('aiSettings').host.open();
    }

    updateAISettingsVisibility(){
        const form=this.dialog('aiSettings').form;
        const provider=form.elements.namedItem('provider').value;
        $('[data-local-model]',form).hidden=provider!=='OLLAMA';
        $('[data-openai-key]',form).hidden=provider!=='OPENAI';
    }

    async loadAISettings(){
        try{
            return await globalThis.dbopfs.get(AI_SETTINGS_TABLE,AI_SETTINGS_FILE,true)||{};
        }catch{
            return {};
        }
    }

    async configureStoredAI(){
        const settings=await this.loadAISettings();
        if(settings.provider){
            await this.applyAISettings(settings,{persist:false});
        }else{
            if(globalThis.ai){
                globalThis.ai.redressConfigured=false;
            }
            this.dispatchAIStatus();
        }
    }

    async getAI(){
        if(globalThis.ai?.ready){
            return globalThis.ai;
        }
        return new Promise(resolve=>{
            const ready=()=>{
                if(!globalThis.ai?.ready){
                    return;
                }
                window.removeEventListener('ai-ready',ready);
                resolve(globalThis.ai);
            };
            window.addEventListener('ai-ready',ready);
            ready();
        });
    }

    async applyAISettings(values,{persist=true}={}){
        const settings={
            provider:values.provider==='OPENAI'?'OPENAI':'OLLAMA',
            localModel:values.localModel||'REDRESS:120b'
        };
        let ai=await this.getAI();
        if(!ai){
            throw new Error('Arcane AI could not be initialized.');
        }
        if(settings.provider==='OLLAMA'){
            ai.llmService='OLLAMA';
            ai.model=settings.localModel;
        }else{
            ai.llmService='OPENAI';
            ai.model='gpt-4o';
            ai.license=values.apiKey||globalThis.user?.license_key||'';
            if(globalThis.user&&values.apiKey!==undefined){
                globalThis.user.license_key=values.apiKey;
            }
        }
        ai.ready=true;
        ai.redressConfigured=true;
        this.assistant.ai=ai;
        this.descriptor.ai=ai;
        if(persist){
            await globalThis.dbopfs.set(AI_SETTINGS_TABLE,AI_SETTINGS_FILE,JSON.stringify(settings));
        }
        this.dispatchAIStatus();
        return ai;
    }

    dispatchAIStatus(){
        const configured=Boolean(globalThis.ai?.configured&&globalThis.ai?.redressConfigured);
        window.dispatchEvent(new CustomEvent('redress-ai-status',{detail:{ai:{configured}}}));
    }

    renderChat(){
        const container=$('#chatMessages');
        container.replaceChildren();
        if(!this.chatHistory.length){
            this.addChatMessage('Tell me what happened or what you need to create. I will tie the answer to the case record and ask for missing jurisdiction or proof.','assistant');
            return;
        }
        for(const message of this.chatHistory){
            this.addChatMessage(message.content,message.role==='user'?'user':'assistant');
        }
        this.assistantPanel?.scrollToEnd();
    }

    addChatMessage(text,className='assistant'){
        const message=document.createElement('div');
        message.className=`chat-message ${className}`;
        if(className.split(/\s+/).includes('assistant')){
            message.classList.add('markdown-content');
            this.renderMarkdown(message,text);
        }else{
            message.textContent=text;
        }
        $('#chatMessages').append(message);
        this.assistantPanel?.scrollToEnd();
        return message;
    }
}

const app=new RedressApp();
app.init().catch(error=>{
    console.error('Redress failed to initialize.',error);
    const layout=$('.redress-layout');
    if(layout){
        layout.setAttribute('aria-busy','false');
        layout.innerHTML=`<section class="view-panel"><div class="section-card"><h1>Redress could not open</h1><p></p></div></section>`;
        $('p',layout).textContent=error.message;
    }
});

export {RedressApp,contextQuery,coverageNotice,formatBytes,profileView,safeWorkProductName};
export default app;
