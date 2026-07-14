const OPENAI_PROVIDER='OPENAI';
const PROFILE_REQUIREMENT_PAGES=new Set(['chat.html','journal.html']);

export function warriorProfileRequirements(user={}){
    const provider=String(user?.preferredModels?.[0]??'').trim().toUpperCase();
    const missingName=!String(user?.username??'').trim();
    const missingLicense=provider===OPENAI_PROVIDER
        &&!String(user?.license_key??'').trim();

    return {
        missingLicense,
        missingName,
        required:missingName||missingLicense
    };
}

const frame=globalThis.document?.querySelector('iframe[data-precrisis-page]');

if(frame){
    const pageName=frame.dataset.precrisisPage;
    const appRoot=new URL('../',import.meta.url);
    const precrisisRoot=new URL(['..','..','precrisis',''].join('/'),import.meta.url);
    const target=pageName==='home.html'
        ?new URL('home.html',appRoot)
        :new URL(pageName,precrisisRoot);
    const activeNavigationPage=pageName==='home.html'?'soc.html':pageName;
    const titles={
        'admin.html':'Profile',
        'chat.html':'Companion',
        'dashboard.html':'Mental Health Center',
        'data.html':'Memories & Data',
        'home.html':'Home',
        'journal.html':'Reflection'
    };
    const legacyThemes=['curious','default','harmony','hopeful','warm','warrior'];
    const navigation={
        'dashboard.html':{label:'Mental Health Center',icon:'MH',route:'mental-health.html'},
        'chat.html':{label:'Companion',icon:'Chat',route:'companion.html'},
        'journal.html':{label:'Reflection',icon:'Write',route:'reflection.html'},
        'soc.html':{label:'Home',icon:'Home',route:'index.html'},
        'data.html':{label:'Memories & Data',icon:'Data',route:'memories.html'},
        'admin.html':{label:'Profile',icon:'Me',route:'profile.html'}
    };
    const navigationOrder=['soc.html','chat.html','dashboard.html','journal.html','data.html','admin.html'];
    const visibleCopyReplacements=[
        [/Your support team is being notified\./gi,'Please use 988 or another trusted source of immediate human support.'],
        [/notify your support network/gi,'reach someone you trust'],
        [/Mental Health Assessment/g,'Companion Check-in'],
        [/Crisis Assessment/g,'Crisis Check-in'],
        [/General Risk Assessment/g,'General Risk Check-in'],
        [/Relationship Risk Assessment/g,'Relationship Risk Check-in'],
        [/Fitness for Service Assessment/g,'Fitness for Service Check-in'],
        [/\bAssessments\b/g,'Companion Check-ins'],
        [/\bAssessment\b/g,'Companion Check-in'],
        [/\bassessments\b/g,'Companion check-ins'],
        [/\bassessment\b/g,'Companion check-in']
    ];
    let supportWindowOpened=false;
    const guardedProfileDocuments=new WeakSet();

    frame.ready=false;

    function addSkin(document){
        if(document.querySelector('link[data-warrior-spirit-skin]'))return;
        const stylesheet=document.createElement('link');
        stylesheet.rel='stylesheet';
        stylesheet.href=new URL('precrisis-skin.css?v=1',appRoot).href;
        stylesheet.dataset.warriorSpiritSkin='';
        document.head.append(stylesheet);
    }

    function normalizeBodyTheme(document){
        if(!document.body)return;
        for(const legacyTheme of legacyThemes){
            if(document.body.classList.contains(legacyTheme))document.body.classList.remove(legacyTheme);
        }
        if(!document.body.classList.contains('warrior-spirit-white-label')){
            document.body.classList.add('warrior-spirit-white-label');
        }
        if(pageName==='home.html'&&!document.body.classList.contains('warrior-home-page')){
            document.body.classList.add('warrior-home-page');
        }
    }

    function applyBodyTheme(window,document){
        normalizeBodyTheme(document);
        window.addEventListener('user-entity-loaded',()=>normalizeBodyTheme(document));
        if(pageName==='admin.html'){
            document.addEventListener('input',()=>normalizeBodyTheme(document));
        }
    }

    function whenImportReady(host){
        return new Promise((resolve,reject)=>{
            if(!host){
                reject(new Error('Required PreCrisis component is missing.'));
                return;
            }
            const complete=()=>{
                if(host.ready!==true)return;
                host.removeEventListener('html-import-ready',complete);
                resolve(host);
            };
            host.addEventListener('html-import-ready',complete);
            complete();
        });
    }

    function whenComponentReady(host,{event='',methods=[]}={}){
        return new Promise((resolve,reject)=>{
            if(!host){
                reject(new Error('Required Arcane component is missing.'));
                return;
            }
            const complete=()=>{
                if(host.ready!==true||methods.some(method=>typeof host[method]!=='function'))return;
                host.removeEventListener('html-import-ready',complete);
                if(event)host.removeEventListener(event,complete);
                resolve(host);
            };
            host.addEventListener('html-import-ready',complete);
            if(event)host.addEventListener(event,complete);
            complete();
        });
    }

    function whenUserReady(window){
        return new Promise(resolve=>{
            const complete=event=>{
                const user=event?.detail?.user||window.user;
                if(user?.ready!==true)return;
                window.removeEventListener('user-entity-loaded',complete);
                resolve(user);
            };
            window.addEventListener('user-entity-loaded',complete);
            complete();
        });
    }

    function profileRequirementContent(document,requirements){
        const section=document.createElement('section');
        const heading=document.createElement('h1');
        const introduction=document.createElement('p');
        const list=document.createElement('ul');
        const privacy=document.createElement('p');
        const button=document.createElement('button');

        section.dataset.warriorProfileRequired='';
        heading.textContent='Finish setting up your Companion';
        introduction.textContent='Before you begin, the Companion needs the profile details that help it recognize you and connect to your chosen AI.';
        if(requirements.missingName){
            const item=document.createElement('li');
            item.textContent='Add your name or a private ID so the Companion knows how to address you.';
            list.append(item);
        }
        if(requirements.missingLicense){
            const item=document.createElement('li');
            item.textContent='Add your Warrior Spirit AI Licence key to use Cloud AI with the Companion.';
            list.append(item);
        }
        privacy.textContent='These details are stored with your on-device PreCrisis profile.';
        button.type='button';
        button.autofocus=true;
        button.dataset.warriorProfileLink='';
        button.textContent='Go to Profile';
        button.addEventListener('click',()=>{
            globalThis.location.assign(new URL('profile.html',appRoot).href);
        });
        section.append(heading,introduction,list,privacy,button);
        return section;
    }

    async function prepareProfileRequirements(window,document){
        if(!PROFILE_REQUIREMENT_PAGES.has(pageName)||guardedProfileDocuments.has(document))return;
        guardedProfileDocuments.add(document);
        const user=await whenUserReady(window);
        const requirements=warriorProfileRequirements(user);
        if(!requirements.required)return;
        const modal=await whenComponentReady(
            document.getElementById('modal'),
            {event:'modal-ready',methods:['populate','open']}
        );
        await modal.populate(profileRequirementContent(document,requirements),false);
        await modal.open();
    }

    function addNavigationBrand(root,document){
        const brandContainer=root.querySelector('.logo-container');
        if(!brandContainer)return;
        let style=root.querySelector('style[data-warrior-spirit-brand]');
        if(!style){
            style=document.createElement('style');
            style.dataset.warriorSpiritBrand='';
            style.textContent='.warrior-white-label-logo{block-size:3rem;inline-size:3rem;object-fit:contain;vertical-align:middle}.logo-container{align-items:center;display:flex;gap:.65rem}.logo-container h2{font-size:1rem;margin:0}';
            root.append(style);
        }
        const heading=brandContainer.querySelector('h2')||document.createElement('h2');
        let logo=brandContainer.querySelector('img.warrior-white-label-logo');
        if(!logo){
            logo=document.createElement('img');
            logo.alt='Warrior Spirit';
            logo.className='warrior-white-label-logo';
            logo.height=48;
            logo.width=48;
            brandContainer.prepend(logo);
        }
        logo.src=new URL('img/warrior-spirit-logo.png',appRoot).href;
        heading.textContent='Warrior Spirit Companion';
        if(!heading.isConnected)brandContainer.append(heading);
    }

    function applyNavigation(host,document){
        const root=host.shadowRoot;
        const list=root?.querySelector('nav>ul');
        const links=[...(root?.querySelectorAll('nav a')||[])];
        if(!list||!links.length)return false;

        const items=new Map();
        for(const link of links){
            const sourcePage=new URL(link.href).pathname.split('/').pop();
            const definition=navigation[sourcePage];
            const item=link.closest('li');
            if(!definition){
                if(item)item.hidden=true;
                continue;
            }
            const label=link.querySelector('.label');
            const iconLabel=link.querySelector('.icon');
            if(label)label.textContent=definition.label;
            if(iconLabel)iconLabel.textContent=definition.icon;
            link.href=new URL(definition.route,appRoot).href;
            link.target='_top';
            link.removeAttribute('aria-current');
            if(sourcePage===activeNavigationPage)link.setAttribute('aria-current','page');
            if(item)items.set(sourcePage,item);
        }
        for(const sourcePage of navigationOrder){
            const item=items.get(sourcePage);
            if(item)list.append(item);
        }
        addNavigationBrand(root,document);
        return true;
    }

    async function prepareNavigation(document){
        const host=await whenImportReady(document.querySelector('html-import.nav'));
        if(!applyNavigation(host,document)){
            throw new Error('PreCrisis navigation did not finish loading.');
        }
    }

    async function prepareHeader(document){
        const host=await whenImportReady(document.querySelector('html-import.header'));
        const title=host.shadowRoot?.querySelector('#title');
        if(title)title.textContent='Warrior Spirit Companion';
        for(const [id,label] of [
            ['back','Go back'],
            ['forward','Go forward'],
            ['refresh','Refresh']
        ]){
            const button=host.shadowRoot?.querySelector(`#${id}`);
            if(!button)continue;
            button.setAttribute('aria-label',label);
            const image=button.querySelector('img');
            if(image)image.hidden=false;
            button.querySelector('.warrior-header-glyph')?.remove();
        }
        let themeSwitcher=host.shadowRoot?.querySelector('html-import.warrior-header-theme');
        if(host.shadowRoot&&!themeSwitcher){
            themeSwitcher=document.createElement('html-import');
            themeSwitcher.className='warrior-header-theme';
            themeSwitcher.setAttribute(
                'href',
                new URL('../../../arcane/components/theme-switcher.html?v=2',import.meta.url).href
            );
            host.shadowRoot.querySelector('.internet-status')?.before(themeSwitcher);
        }
        if(themeSwitcher){
            await whenImportReady(themeSwitcher);
            const customTheme=themeSwitcher.shadowRoot?.querySelector('[data-scheme="custom"]');
            if(customTheme)customTheme.hidden=true;
        }
        if(host.shadowRoot&&!host.shadowRoot.querySelector('style[data-warrior-spirit-header]')){
            const style=document.createElement('style');
            style.dataset.warriorSpiritHeader='';
            style.textContent='header{background:var(--modal-background);color:var(--text-color);grid-template-columns:2.2rem 2.2rem 2.2rem minmax(5rem,1fr) auto 1rem 4.25rem}h1{color:var(--text-color);font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#back,#forward,#refresh{background:transparent;border:0;color:var(--text-color);opacity:.88;padding:.35rem}#back img,#forward img,#refresh img{filter:var(--warrior-header-icon-filter);height:1.15rem}#back:hover,#forward:hover,#refresh:hover,#back:focus-visible,#forward:focus-visible,#refresh:focus-visible{background:transparent;opacity:1}.warrior-header-theme{color:var(--text-color)}.crisis-call{opacity:1;padding:.55em .35em}@media(max-width:30rem){header{grid-template-columns:2rem 2rem 2rem minmax(4rem,1fr) auto 0 3.25rem;padding-inline:.2rem}.internet-status{overflow:hidden;width:0}h1{font-size:.8rem}}';
            host.shadowRoot.append(style);
        }
    }

    function prepareProfile(document){
        if(pageName!=='admin.html')return;
        const profileHeading=document.querySelector('main.contents section h1');
        const profileDescription=profileHeading?.nextElementSibling;
        if(profileHeading)profileHeading.textContent='Your Warrior Spirit Profile';
        if(profileDescription)profileDescription.textContent='Use your name or a private ID, then choose how you want the Companion to speak with you.';
        const input=document.getElementById('license_key');
        const section=input?.closest('section');
        if(input&&section){
            section.classList.remove('hidden');
            section.hidden=false;
            const heading=section.querySelector('h1');
            const description=section.querySelector('p');
            if(heading)heading.textContent='Warrior Spirit AI Licence key';
            if(description)description.textContent='Stored with your on-device PreCrisis profile. It is used only when the Companion sends a request to your chosen AI.';
            input.type='password';
            input.placeholder='Warrior Spirit AI Licence key';
            input.autocomplete='off';
            input.spellcheck=false;
        }
        const colorTable=document.querySelector('section.color-table');
        if(colorTable){
            colorTable.hidden=true;
            colorTable.setAttribute('aria-hidden','true');
        }
        const supportSection=document.getElementById('contact_1')?.closest('section');
        if(supportSection){
            supportSection.hidden=true;
            supportSection.setAttribute('aria-hidden','true');
        }
        for(const selector of [
            'section.model-preference',
            'section.model-select',
            'section.developer-preference'
        ]){
            const profileSection=document.querySelector(selector);
            if(!profileSection)continue;
            profileSection.hidden=true;
            profileSection.setAttribute('aria-hidden','true');
        }
    }

    function companionMessages(record){
        if(Array.isArray(record))return record;
        if(Array.isArray(record?.messages))return record.messages;
        if(typeof record!=='string')return [];
        return record.split('\n').flatMap(row=>{
            try{
                return [JSON.parse(row.trim())];
            }catch{
                return [];
            }
        });
    }

    function visibleCompanionMessages(record){
        const messages=companionMessages(record);
        const conversation=messages[0]?.role==='system'&&messages[1]?.role==='user'
            ?messages.slice(2)
            :messages;
        return conversation.filter(
            message=>message?.role==='user'||message?.role==='assistant'
        );
    }

    function companionConversationTitle(messages=[],fileName=''){
        const messageTimestamp=Number(messages.find(message=>Number.isFinite(Number(message?.timestamp)))?.timestamp);
        const timestamp=Number.isFinite(messageTimestamp)
            ?messageTimestamp
            :Number(fileName.match(/chat-(\d+)/)?.[1]);
        return Number.isFinite(timestamp)
            ?`Conversation — ${new Date(timestamp).toLocaleString()}`
            :'Companion Conversation';
    }

    async function showCompanionConversation(manager,document,fileName=''){
        const modal=await whenComponentReady(
            manager.shadowRoot?.querySelector('#fileModal'),
            {event:'modal-ready',methods:['populate','open']}
        );
        const record=await document.defaultView.dbopfs.get('chats',fileName,true);
        const messages=visibleCompanionMessages(record);
        const {default:MD}=await import(new URL('../../../arcane/modules/MD.js?v=2',import.meta.url));
        const section=document.createElement('section');
        const style=document.createElement('style');
        const heading=document.createElement('h1');
        const privacy=document.createElement('p');
        const transcript=document.createElement('ol');
        style.textContent='.warrior-companion-detail{color:var(--text-color);display:grid;gap:1rem}.warrior-companion-detail h1,.warrior-companion-detail p{margin:0}.warrior-companion-meta{color:var(--muted-text-color)}.warrior-companion-transcript{display:flex;flex-direction:column;gap:.8rem;list-style:none;margin:0;padding:0}.warrior-companion-message{align-self:flex-start;background:var(--modal-background);border:1px solid var(--border-color);border-radius:.85rem;box-sizing:border-box;inline-size:min(82%,42rem);padding:.8rem 1rem}.warrior-companion-message[data-role="user"]{align-self:flex-end;background:var(--secondary-color)}.warrior-companion-speaker{display:block;font-size:.78rem;margin-block-end:.35rem}.warrior-companion-body{line-height:1.55;overflow-wrap:anywhere}.warrior-companion-body>:first-child{margin-block-start:0}.warrior-companion-body>:last-child{margin-block-end:0}';
        section.className='warrior-companion-detail';
        heading.textContent=companionConversationTitle(messages,fileName);
        privacy.className='warrior-companion-meta';
        privacy.textContent='Private Companion conversation stored only on this device.';
        transcript.className='warrior-companion-transcript';
        for(const message of messages){
            const item=document.createElement('li');
            const speaker=document.createElement('strong');
            const body=document.createElement('div');
            item.className='warrior-companion-message';
            item.dataset.role=message.role;
            speaker.className='warrior-companion-speaker';
            speaker.textContent=message.role==='user'?'You':'Companion';
            body.className='warrior-companion-body';
            body.innerHTML=new MD(String(message.content??'')).safeRendered;
            for(const link of body.querySelectorAll('a')){
                link.target='_blank';
                link.rel='noopener noreferrer';
            }
            item.append(speaker,body);
            transcript.append(item);
        }
        if(!messages.length){
            const empty=document.createElement('li');
            empty.className='warrior-companion-meta';
            empty.textContent='This conversation does not contain any visible messages.';
            transcript.append(empty);
        }
        section.append(style,heading,privacy,transcript);
        await modal.populate(section,false);
        await modal.open();
    }

    async function labelCompanionRecords(manager,document){
        const roots=[manager.shadowRoot];
        const directoryRoot=manager.shadowRoot?.querySelector('#directoryModal')?.shadowRoot;
        if(directoryRoot)roots.push(directoryRoot);
        for(const root of roots.filter(Boolean)){
            for(const label of root.querySelectorAll('.directory[data-directory="chats"]>.folder>span:not(.file-count)')){
                label.textContent='Companion Conversations';
            }
            for(const heading of root.querySelectorAll('h1')){
                if(heading.textContent.trim()==='chats')heading.textContent='Companion Conversations';
            }
            await Promise.all(
                [...root.querySelectorAll('button.file-row-open[data-directory="chats"]')].map(
                    async button=>{
                        const messages=visibleCompanionMessages(
                            await document.defaultView.dbopfs.get('chats',button.dataset.file,true)
                        );
                        const title=companionConversationTitle(messages,button.dataset.file);
                        const label=button.querySelector('.file-name');
                        if(label)label.textContent=title;
                        button.title=title;
                        const deleteButton=button.closest('.file-row')?.querySelector('.file-delete');
                        if(deleteButton){
                            deleteButton.title=`Delete conversation: ${title}`;
                            deleteButton.setAttribute('aria-label',deleteButton.title);
                        }
                    }
                )
            );
        }
    }

    async function configureCompanionManager(manager,document){
        await whenComponentReady(manager,{event:'file-manager-ready',methods:['loadAll']});
        if(!manager.dataset.warriorCompanionView){
            manager.dataset.warriorCompanionView='true';
            manager.addEventListener('file-manager-open',event=>{
                if(event.detail?.entry?.directory!=='chats')return;
                event.preventDefault();
                void showCompanionConversation(manager,document,event.detail.entry.fileName).catch(
                    error=>console.error('Unable to open Warrior Spirit conversation.',error)
                );
            });
            const directoryModal=manager.shadowRoot?.querySelector('#directoryModal');
            directoryModal?.addEventListener('modal-opened',()=>{
                void labelCompanionRecords(manager,document);
            });
            const loadAll=manager.loadAll.bind(manager);
            manager.loadAll=async (...args)=>{
                const result=await loadAll(...args);
                await labelCompanionRecords(manager,document);
                return result;
            };
        }
        await labelCompanionRecords(manager,document);
    }

    async function prepareCompanion(document){
        if(pageName!=='chat.html')return;
        const dataView=document.getElementById('assessmentDataView');
        const chat=document.getElementById('chat');
        if(!dataView||!chat)return;
        dataView.dataset.button='View Previous Companion Conversations';
        dataView.dataset.title='Previous Companion Conversations';
        await Promise.all([
            whenComponentReady(dataView,{event:'data-view-ready',methods:['open']}),
            whenComponentReady(chat,{event:'chat-ready',methods:['streamMessage']})
        ]);
        chat.aiName='Companion';
        const openButton=dataView.shadowRoot?.querySelector('#openData');
        if(openButton)openButton.textContent=dataView.dataset.button;
        const dataModal=await whenComponentReady(
            dataView.shadowRoot?.querySelector('#dataModal'),
            {event:'modal-ready',methods:['populate','open']}
        );
        dataModal.addEventListener('modal-opened',()=>{
            const manager=dataModal.shadowRoot?.querySelector('html-import.file-manager');
            if(manager)void configureCompanionManager(manager,document);
        });
    }

    function reflectionTitle(record={}){
        const title=String(record.title||'').trim();
        return !title||title==='Journal Entry'?'Reflection':title;
    }

    async function showReflection(manager,document,fileName=''){
        const modal=await whenComponentReady(
            manager.shadowRoot?.querySelector('#fileModal'),
            {event:'modal-ready',methods:['populate','open']}
        );
        const record=await document.defaultView.dbopfs.get('journal_entries',fileName);
        if(!record||typeof record!=='object')throw new Error('The selected reflection is unavailable.');
        const {default:MD}=await import(new URL('../../../arcane/modules/MD.js?v=2',import.meta.url));
        const article=document.createElement('article');
        const style=document.createElement('style');
        const heading=document.createElement('h1');
        const metadata=document.createElement('p');
        const rendered=document.createElement('section');
        style.textContent='.warrior-reflection-detail{color:var(--text-color);display:grid;gap:1rem;line-height:1.65}.warrior-reflection-detail h1,.warrior-reflection-detail p{margin:0}.warrior-reflection-meta{color:var(--muted-text-color)}.warrior-reflection-content{background:var(--background);border:1px solid var(--border-color);border-radius:.5rem;padding:1rem}.warrior-reflection-content>:first-child{margin-block-start:0}.warrior-reflection-content>:last-child{margin-block-end:0}';
        article.className='warrior-reflection-detail';
        heading.textContent=reflectionTitle(record);
        metadata.className='warrior-reflection-meta';
        metadata.textContent=record.date
            ?`Saved on this device ${new Date(record.date).toLocaleString()}`
            :'Saved on this device';
        rendered.className='warrior-reflection-content';
        rendered.innerHTML=new MD(String(record.entry||'')).safeRendered;
        for(const link of rendered.querySelectorAll('a')){
            link.target='_blank';
            link.rel='noopener noreferrer';
        }
        article.append(style,heading,metadata,rendered);
        await modal.populate(article,false);
        await modal.open();
    }

    async function labelReflectionRecords(manager,document){
        const roots=[manager.shadowRoot];
        for(const id of ['directoryModal']){
            const root=manager.shadowRoot?.querySelector(`#${id}`)?.shadowRoot;
            if(root)roots.push(root);
        }
        for(const root of roots.filter(Boolean)){
            for(const directory of root.querySelectorAll('.directory[data-directory="streams_of_consciousness"]')){
                directory.hidden=true;
                directory.setAttribute('aria-hidden','true');
            }
            for(const label of root.querySelectorAll('.directory[data-directory="journal_entries"]>.folder>span:not(.file-count)')){
                label.textContent='Reflections';
            }
            for(const heading of root.querySelectorAll('h1')){
                if(heading.textContent.trim()==='journal_entries')heading.textContent='Reflections';
            }
            await Promise.all(
                [...root.querySelectorAll('button.file-row-open[data-directory="journal_entries"]')].map(
                    async button=>{
                        const record=await document.defaultView.dbopfs.get('journal_entries',button.dataset.file);
                        const title=reflectionTitle(record||{});
                        const label=button.querySelector('.file-name');
                        if(label)label.textContent=title;
                        button.title=title;
                        const deleteButton=button.closest('.file-row')?.querySelector('.file-delete');
                        if(deleteButton){
                            deleteButton.title=`Delete reflection: ${title}`;
                            deleteButton.setAttribute('aria-label',deleteButton.title);
                        }
                    }
                )
            );
        }
    }

    async function configureReflectionManager(manager,document){
        await whenComponentReady(manager,{event:'file-manager-ready',methods:['loadAll']});
        if(!manager.dataset.warriorReflectionView){
            manager.dataset.warriorReflectionView='true';
            manager.addEventListener('file-manager-open',event=>{
                if(event.detail?.entry?.directory!=='journal_entries')return;
                event.preventDefault();
                void showReflection(manager,document,event.detail.entry.fileName).catch(
                    error=>console.error('Unable to open Warrior Spirit reflection.',error)
                );
            });
            const directoryModal=manager.shadowRoot?.querySelector('#directoryModal');
            directoryModal?.addEventListener('modal-opened',()=>{
                void labelReflectionRecords(manager,document);
            });
            const loadAll=manager.loadAll.bind(manager);
            manager.loadAll=async (...args)=>{
                const result=await loadAll(...args);
                await labelReflectionRecords(manager,document);
                return result;
            };
        }
        await labelReflectionRecords(manager,document);
    }

    async function saveReflectionMemory(document,event){
        const markdown=String(event.detail?.markdown||'').trim();
        if(!markdown||!document.defaultView.dbopfs?.ready)return;
        const title=String(event.detail?.title||'').trim()||'Reflection';
        const memory=`The user wrote a private reflection titled "${title}": ${markdown.slice(0,4000)}`;
        const uuid=document.defaultView.crypto.randomUUID?.()||`${Date.now()}`;
        await document.defaultView.dbopfs.set(
            'memories',
            `memory-reflection-${Date.now()}-${uuid}.json`,
            {memory,source_reflection:true,timestamp:Date.now()}
        );
    }

    async function prepareReflection(document){
        if(pageName!=='journal.html')return;
        const dataView=document.getElementById('journalDataView');
        const editor=document.getElementById('journalEditor');
        dataView.dataset.button='View Reflections';
        dataView.dataset.title='Reflections';
        await Promise.all([
            whenComponentReady(dataView,{event:'data-view-ready',methods:['open']}),
            whenComponentReady(editor,{event:'markdown-editor-ready',methods:['configure']})
        ]);
        const openButton=dataView.shadowRoot?.querySelector('#openData');
        if(openButton)openButton.textContent='View Reflections';
        editor.configure({
            bodyPlaceholder:'Write your reflection in Markdown...',
            previewLabel:'Reflection Preview',
            saveLabel:'Save Reflection'
        });
        if(!editor.dataset.warriorReflectionMemory){
            editor.dataset.warriorReflectionMemory='true';
            editor.addEventListener('markdown-editor-saved',event=>{
                void saveReflectionMemory(document,event).catch(
                    error=>console.error('Unable to save the reflection memory.',error)
                );
            });
        }
        const dataModal=await whenComponentReady(
            dataView.shadowRoot?.querySelector('#dataModal'),
            {event:'modal-ready',methods:['populate','open']}
        );
        dataModal.addEventListener('modal-opened',()=>{
            const manager=dataModal.shadowRoot?.querySelector('html-import.file-manager');
            if(manager)void configureReflectionManager(manager,document);
        });
    }

    async function prepareMemories(document){
        if(pageName!=='data.html')return;
        const heading=document.querySelector('.data-header h1');
        const description=document.querySelector('.data-header p');
        if(heading)heading.textContent='Memories & Data';
        if(description)description.textContent='Explore Companion conversations, reflections, memories, reports, and notes stored on this device.';
        const manager=document.getElementById('fileManager');
        if(manager){
            await Promise.all([
                configureCompanionManager(manager,document),
                configureReflectionManager(manager,document)
            ]);
        }
    }

    function prepareMentalHealthCenter(document){
        if(pageName!=='dashboard.html')return;
        for(const heading of document.querySelectorAll('th')){
            if(heading.textContent.trim()==='Mental Health Assessment'){
                heading.textContent='Companion Check-in';
            }
        }
    }

    function open988Website(){
        const opened=globalThis.open('https://988lifeline.org/','_blank','noopener,noreferrer');
        if(opened){
            opened.opener=null;
            supportWindowOpened=true;
        }
        return Boolean(opened);
    }

    function applyVisibleCopy(root){
        if(!root)return;
        for(const control of root.querySelectorAll('[data-modal-action="notifySupportNetwork"]')){
            control.remove();
        }
        const walker=root.ownerDocument.createTreeWalker(root,4);
        let textNode=walker.nextNode();
        while(textNode){
            let copy=textNode.nodeValue||'';
            for(const [pattern,replacement] of visibleCopyReplacements){
                copy=copy.replace(pattern,replacement);
            }
            if(copy!==textNode.nodeValue)textNode.nodeValue=copy;
            textNode=walker.nextNode();
        }
    }

    const supportEmailDisabled=async () => ({
        reason:'support_email_hidden',
        sent:false
    });

    function isHotlineAction(event,window){
        return event.composedPath().some(node=>
            node instanceof window.HTMLElement
            &&(
                node.dataset?.modalAction==='callHotline'
                ||((node.tagName==='BUTTON'||node.tagName==='A')&&/988/.test(node.textContent||''))
            )
        );
    }

    async function prepareSafetyModal(host){
        await whenImportReady(host);
        if(pageName==='chat.html'){
            Object.defineProperty(host,'notifySupportNetwork',{
                configurable:true,
                get:()=>supportEmailDisabled,
                set:()=>{}
            });
        }
        const inspect=()=>{
            applyVisibleCopy(host.shadowRoot);
            if(supportWindowOpened)return;
            const supportButton=[...host.shadowRoot.querySelectorAll('button')]
                .find(button=>/988/.test(button.textContent||''));
            if(supportButton)open988Website();
        };
        host.addEventListener('modal-opened',inspect);
    }

    async function prepareSafety(window,document){
        await Promise.all(
            [...document.querySelectorAll('html-import.modal')].map(prepareSafetyModal)
        );
        document.addEventListener('click',event=>{
            if(!isHotlineAction(event,window))return;
            event.preventDefault();
            event.stopImmediatePropagation();
            open988Website();
        },true);
    }

    async function enhanceFrame(){
        try{
            const window=frame.contentWindow;
            const document=frame.contentDocument;
            if(!window||!document||new URL(window.location.href).pathname!==target.pathname)return;
            document.documentElement.dataset.whiteLabel='warrior-spirit';
            document.title=`Warrior Spirit Companion \u2014 ${titles[pageName]||'Powered by PreCrisis.ai'}`;
            const icon=document.querySelector('link[rel="icon"]');
            if(icon)icon.href=new URL('img/warrior-spirit-logo.png',appRoot).href;
            addSkin(document);
            applyBodyTheme(window,document);
            prepareProfile(document);
            prepareMentalHealthCenter(document);
            await Promise.all([
                prepareHeader(document),
                prepareNavigation(document),
                prepareCompanion(document),
                prepareReflection(document),
                prepareMemories(document),
                prepareSafety(window,document)
            ]);
            await prepareProfileRequirements(window,document);
            frame.ready=true;
            frame.dispatchEvent(new CustomEvent('precrisis-frame-ready',{bubbles:true,detail:{pageName}}));
        }catch(error){
            frame.ready=false;
            frame.dispatchEvent(new CustomEvent('precrisis-frame-error',{bubbles:true,detail:{error,pageName}}));
            console.error('Warrior Spirit could not prepare the PreCrisis view.',error);
        }
    }

    frame.addEventListener('load',enhanceFrame);
    frame.src=target.href;
}
