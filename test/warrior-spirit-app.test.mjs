import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {programById,programPrompt,programs} from '../apps/warrior-spirit/modules/WarriorSpiritPrograms.js';
import {validateAppRegistry} from '../machine_bundles/arcane-os-machine-bundle-v0.8.4/tools/app-packager-lib.mjs';

const read=relative=>readFile(new URL(`../${relative}`,import.meta.url),'utf8');
const routes={
    'companion.html':'chat.html',
    'reflection.html':'journal.html',
    'mental-health.html':'dashboard.html',
    'memories.html':'data.html',
    'profile.html':'admin.html'
};

test('HTML imports expose sticky readiness before their ready event',async()=>{
    const source=await read('arcane/modules/HTMLImport.js');
    assert.match(source,/ready=false/);
    const sticky=source.lastIndexOf('this.ready=true');
    const event=source.lastIndexOf("new CustomEvent('html-import-ready'");
    assert(sticky>=0&&event>sticky);
});

test('Warrior Spirit routes are thin themed wrappers over the working PreCrisis surfaces',async()=>{
    for(const [route,precrisis] of Object.entries(routes)){
        const html=await read(`apps/warrior-spirit/${route}`);
        const theme=html.indexOf('arcane/css/theme.css');
        const primitives=html.indexOf('arcane/css/primitives.css');
        const skin=html.indexOf('apps/warrior-spirit/precrisis-skin.css');
        assert(theme>=0&&primitives>theme&&skin>primitives,`${route} theme order`);
        assert.match(html,/arcane\/modules\/ThemeBootstrap\.js/);
        assert.match(html,/apps\/warrior-spirit\/modules\/PreCrisisFrame\.js/);
        assert.match(html,new RegExp(`data-precrisis-page="${precrisis.replace('.','\\.')}"`));
        assert.match(html,/class="precrisis-frame"/);
    }
    const homeWrapper=await read('apps/warrior-spirit/index.html');
    assert.match(homeWrapper,/data-precrisis-page="home\.html"/);
    assert.match(homeWrapper,/PreCrisisFrame\.js\?v=9/);
});

test('the white-label keeps the established chat, journal, profile, and Mental Health Center components',async()=>{
    const [chat,journal,profile,dashboard,data]=await Promise.all([
        read('apps/precrisis/chat.html'),
        read('apps/precrisis/journal.html'),
        read('apps/precrisis/admin.html'),
        read('apps/precrisis/dashboard.html'),
        read('apps/precrisis/data.html')
    ]);
    assert.match(chat,/arcane\/components\/chat\.html/);
    assert.match(chat,/arcane\/components\/data-view\.html/);
    assert.match(chat,/AssessmentReportRunner/);
    assert.match(journal,/arcane\/components\/markdown-editor\.html/);
    assert.match(journal,/PostSaveAssessmentUI/);
    assert.match(profile,/id="username"/);
    assert.match(profile,/id="license_key"/);
    assert.match(profile,/id="AI_personality"/);
    assert.match(dashboard,/Personal Mental Health Center/);
    assert.match(dashboard,/dashboard-config\.html/);
    assert.match(dashboard,/Mental Health Notes/);
    assert.match(data,/arcane\/components\/file-manager\.html/);
});

test('Profile exposes the OpenAI key while color and support-email controls stay out of the Warrior view',async()=>{
    const [adapter,skin,profile]=await Promise.all([
        read('apps/warrior-spirit/modules/PreCrisisFrame.js'),
        read('apps/warrior-spirit/precrisis-skin.css'),
        read('apps/warrior-spirit/profile.html')
    ]);
    assert.match(skin,/section\.color-table\{[\s\S]*display:none !important/);
    assert.match(adapter,/legacyThemes/);
    assert.match(adapter,/classList\.contains\(legacyTheme\).*classList\.remove\(legacyTheme\)/);
    assert.match(adapter,/!document\.body\.classList\.contains\('warrior-spirit-white-label'\)/);
    assert.match(adapter,/section\.classList\.remove\('hidden'\)/);
    assert.match(adapter,/section\.hidden=false/);
    assert.match(adapter,/heading\.textContent='OpenAI API Key'/);
    assert.match(adapter,/document\.querySelector\('section\.color-table'\)/);
    assert.match(adapter,/document\.getElementById\('contact_1'\)\?\.closest\('section'\)/);
    assert.match(adapter,/supportSection\.hidden=true/);
    assert.match(adapter,/reason:'support_email_hidden'/);
    assert.match(adapter,/Object\.defineProperty\(host,'notifySupportNetwork'/);
    assert.match(adapter,/\[data-modal-action="notifySupportNetwork"\]/);
    assert.match(profile,/arcane\/css\/theme\.css/);
    assert.match(profile,/ThemeBootstrap\.js/);
    assert.doesNotMatch(profile,/type="color"|Color Palette/);
});

test('Warrior branding changes navigation and presentation without replacing PreCrisis functionality',async()=>{
    const [adapter,skin,home]=await Promise.all([
        read('apps/warrior-spirit/modules/PreCrisisFrame.js'),
        read('apps/warrior-spirit/precrisis-skin.css'),
        read('apps/warrior-spirit/home.html')
    ]);
    for(const label of ['Mental Health Center','Companion','Reflection','Memories & Data','Profile'])assert.match(adapter,new RegExp(label.replace('&','&')));
    assert.match(adapter,/Warrior Spirit Companion/);
    assert.match(adapter,/title\.textContent='Warrior Spirit Companion'/);
    assert.match(adapter,/const navigationOrder=\['soc\.html','chat\.html','dashboard\.html','journal\.html','data\.html','admin\.html'\]/);
    assert.match(adapter,/'chat\.html':\{label:'Companion'/);
    assert.match(adapter,/'soc\.html':\{label:'Home'/);
    assert.match(adapter,/dataView\.dataset\.button='View Previous Companion Conversations'/);
    assert.match(adapter,/heading\.textContent='Companion Check-in'/);
    for(const replacement of ['Companion Check-in','Crisis Check-in','General Risk Check-in','Relationship Risk Check-in','Fitness for Service Check-in']){
        assert.match(adapter,new RegExp(replacement));
    }
    assert.match(adapter,/if\(!definition\)\{[\s\S]*item\.hidden=true/);
    for(const removedLabel of ['Stream of Consciousness','Clinician','Leadership','Import Many']){
        assert.doesNotMatch(adapter,new RegExp(removedLabel));
    }
    assert.match(adapter,/warrior-spirit-logo\.png/);
    assert.match(adapter,/html-import-ready/);
    assert.doesNotMatch(adapter,/MutationObserver/);
    assert.match(adapter,/precrisis-frame-ready/);
    assert.match(skin,/--warrior-white-label-amber:rgb\(/);
    assert.doesNotMatch(skin,/#[0-9a-f]{3,8}\b/i);
    assert.match(home,/A Servant's Heart/);
    assert.match(home,/Why Warrior Spirit has a Companion/);
    assert.match(home,/Support should still be within reach between programs, conversations, and hard days\./);
    assert.match(home,/Five paths, one mission/);
    assert.match(home,/warriorspirittexas\.org/);
    assert.match(home,/Powered by <strong>The Wizard Nexus's PreCrisis\.ai<\/strong>/);
});

test('Warrior home navigation begins Home, Companion, then Mental Health Center',async()=>{
    const [adapter,wrapper,home]=await Promise.all([
        read('apps/warrior-spirit/modules/PreCrisisFrame.js'),
        read('apps/warrior-spirit/index.html'),
        read('apps/warrior-spirit/home.html')
    ]);
    assert.match(adapter,/const navigationOrder=\['soc\.html','chat\.html','dashboard\.html','journal\.html','data\.html','admin\.html'\]/);
    assert.match(wrapper,/data-precrisis-page="home\.html"/);
    const header=home.indexOf('html-import class="header"');
    const nav=home.indexOf('html-import class="nav"');
    const main=home.indexOf('<main');
    assert(header>=0&&nav>header&&main>nav);
    assert.doesNotMatch(home,/Stream of Consciousness|Clinician|Leadership|Import Many/);
});

test('the existing PreCrisis DBOPFS records and profile remain the white-label data model',async()=>{
    const [chat,journal,user,home]=await Promise.all([
        read('arcane/entities/Chat.js'),
        read('apps/precrisis/entities/Journal.js'),
        read('arcane/entities/User.js'),
        read('apps/warrior-spirit/home.html')
    ]);
    assert.match(chat,/#tableName='chats'/);
    assert.match(chat,/dbopfs\.set\(\s*'memories'/);
    assert.match(journal,/dbopfs\.set\(\s*'journal_entries'/);
    assert.match(user,/dbopfs/);
    assert.match(home,/saved through PreCrisis DBOPFS storage on this device/i);
    assert.match(home,/OpenAI key is stored locally with the on-device PreCrisis profile/i);
});

test('saved Companion conversations render as dated private transcripts instead of raw JSON',async()=>{
    const adapter=await read('apps/warrior-spirit/modules/PreCrisisFrame.js');
    assert.match(adapter,/chat\.aiName='Companion'/);
    assert.match(adapter,/speaker\.textContent=message\.role==='user'\?'You':'Companion'/);
    assert.match(adapter,/messages\[0\]\?\.role==='system'&&messages\[1\]\?\.role==='user'/);
    assert.match(adapter,/messages\.slice\(2\)/);
    assert.match(adapter,/`Conversation \u2014 \$\{new Date\(timestamp\)\.toLocaleString\(\)\}`/);
    assert.match(adapter,/new MD\(String\(message\.content\?\?''\)\)\.safeRendered/);
    assert.match(adapter,/event\.detail\?\.entry\?\.directory!=='chats'/);
    assert.match(adapter,/event\.preventDefault\(\)/);
    assert.match(adapter,/Private Companion conversation stored only on this device\./);
    assert.match(adapter,/configureCompanionManager\(manager,document\)/);
});

test('Reflections use the shared safe Markdown renderer while retaining the DBOPFS contract',async()=>{
    const adapter=await read('apps/warrior-spirit/modules/PreCrisisFrame.js');
    for(const copy of ['View Reflections','Reflection Preview','Write your reflection in Markdown...','Save Reflection']){
        assert(adapter.includes(copy));
    }
    assert.match(adapter,/dbopfs\.get\('journal_entries'/);
    assert.match(adapter,/new MD\(String\(record\.entry\|\|''\)\)\.safeRendered/);
    assert.match(adapter,/source_reflection:true/);
});

test('all page headers reuse Auto Light Dark without boxed browser buttons',async()=>{
    const adapter=await read('apps/warrior-spirit/modules/PreCrisisFrame.js');
    assert.match(adapter,/arcane\/components\/theme-switcher\.html/);
    assert.match(adapter,/customTheme\.hidden=true/);
    assert.match(adapter,/#back,#forward,#refresh\{background:transparent;border:0/);
    assert.match(adapter,/image\.hidden=false/);
    assert.match(adapter,/button\.querySelector\('\.warrior-header-glyph'\)\?\.remove\(\)/);
});

test('PreCrisis personality and prompt behavior are reused with the Warrior profile field',async()=>{
    const chat=await read('apps/precrisis/chat.html');
    assert.match(chat,/You are an AI designed to analyze user input using DSM-5 criteria/);
    assert.match(chat,/one question at a time/);
    assert.match(chat,/user\.AI_personality\|\|user\.personality/);
    assert.match(chat,/AI is not configured\. Add an API key in Profile/);
});

test('988 actions use the official website and remain backed by visible PreCrisis crisis controls',async()=>{
    const [adapter,chat,crisis]=await Promise.all([
        read('apps/warrior-spirit/modules/PreCrisisFrame.js'),
        read('apps/precrisis/chat.html'),
        read('apps/precrisis/modules/CrisisModal.js')
    ]);
    assert.match(adapter,/https:\/\/988lifeline\.org\//);
    assert.match(adapter,/globalThis\.open\([^)]*'_blank'/);
    assert.match(adapter,/prepareSafetyModal/);
    assert.match(adapter,/supportWindowOpened=true/);
    assert.match(chat,/Speak to Someone Now \(988\)/);
    assert.match(crisis,/Speak to Someone Now \(988\)/);
});

test('Warrior Spirit organization programs stay available on the landing page',()=>{
    assert.deepEqual(programs.map(program=>program.id),['veterans','teach','youth','recovery','first-watch']);
    assert.equal(programById('first-watch').name,'Warrior Spirit First Watch');
    assert.match(programPrompt('recovery'),/People in recovery/);
    assert(programs.every(Object.isFrozen));
});

test('public and native package policy includes all white-label routes and PreCrisis capabilities',async()=>{
    const packageConfig=JSON.parse(await read('apps/warrior-spirit/arcane-package.json'));
    const registry=validateAppRegistry(JSON.parse(await read('machine_bundles/arcane-os-machine-bundle-v0.8.4/arcane-apps.json')));
    assert.equal(packageConfig.strategy,'adapter');
    assert.equal(packageConfig.adapter,'scripts/build_public_release.mjs');
    assert(packageConfig.include.includes('mental-health.html'));
    assert(packageConfig.include.includes('home.html'));
    assert(packageConfig.include.includes('precrisis-skin.css'));
    assert(!packageConfig.include.includes('prompts'));
    const warrior=registry.apps['warrior-spirit'];
    for(const capability of registry.apps.precrisis.capabilities)assert(warrior.capabilities.includes(capability));
    assert(!warrior.capabilities.includes('ai.profile.manage'));
    assert(!warrior.capabilities.includes('external.open'));
    assert.deepEqual(warrior.security.connectOrigins,registry.apps.precrisis.security.connectOrigins);
    assert(warrior.include.includes('mental-health.html'));
    assert(warrior.include.includes('home.html'));
});

test('the package adapter carries the authoritative PreCrisis runtime without copied research material',async()=>{
    const adapter=await read('apps/warrior-spirit/scripts/build_public_release.mjs');
    assert.match(adapter,/prepareBase\(outputRoot\)/);
    assert.match(adapter,/apps','precrisis/);
    assert.match(adapter,/img\/deepwiki_ollama_blog\.html/);
    assert.match(adapter,/modules','PreCrisisFrame\.js/);
});
