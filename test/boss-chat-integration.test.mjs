import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {describe,it} from 'node:test';
import {inflateSync} from 'node:zlib';

function paethPredictor(left,up,upLeft){
    const prediction=left+up-upLeft;
    const leftDistance=Math.abs(prediction-left);
    const upDistance=Math.abs(prediction-up);
    const upLeftDistance=Math.abs(prediction-upLeft);

    if(leftDistance<=upDistance&&leftDistance<=upLeftDistance){
        return left;
    }
    if(upDistance<=upLeftDistance){
        return up;
    }
    return upLeft;
}

function decodeRgbaPng(bytes){
    const idat=[];
    let width=0;
    let height=0;
    let offset=8;

    while(offset<bytes.length){
        const length=bytes.readUInt32BE(offset);
        const type=bytes.toString('ascii',offset+4,offset+8);
        const data=bytes.subarray(offset+8,offset+8+length);

        if(type==='IHDR'){
            width=data.readUInt32BE(0);
            height=data.readUInt32BE(4);
            assert.equal(data[8],8,'logo PNG must use 8-bit channels');
            assert.equal(data[9],6,'logo PNG must use RGBA pixels');
            assert.equal(data[12],0,'logo PNG must not be interlaced');
        }else if(type==='IDAT'){
            idat.push(data);
        }else if(type==='IEND'){
            break;
        }
        offset+=length+12;
    }

    const encoded=inflateSync(Buffer.concat(idat));
    const bytesPerPixel=4;
    const rowBytes=width*bytesPerPixel;
    const pixels=Buffer.alloc(rowBytes*height);
    let sourceOffset=0;

    for(let y=0;y<height;y++){
        const filter=encoded[sourceOffset++];
        const rowOffset=y*rowBytes;

        for(let x=0;x<rowBytes;x++){
            const raw=encoded[sourceOffset++];
            const left=x>=bytesPerPixel?pixels[rowOffset+x-bytesPerPixel]:0;
            const up=y?pixels[rowOffset-rowBytes+x]:0;
            const upLeft=y&&x>=bytesPerPixel
                ?pixels[rowOffset-rowBytes+x-bytesPerPixel]
                :0;
            let value=raw;

            if(filter===1){
                value+=left;
            }else if(filter===2){
                value+=up;
            }else if(filter===3){
                value+=Math.floor((left+up)/2);
            }else if(filter===4){
                value+=paethPredictor(left,up,upLeft);
            }else{
                assert.equal(filter,0,`unsupported PNG filter ${filter}`);
            }
            pixels[rowOffset+x]=value&255;
        }
    }

    return {width,height,pixels};
}

const chat=await readFile(
    new URL('../apps/boss/chat.html',import.meta.url),
    'utf8'
);
const prompt=await readFile(
    new URL('../apps/boss/prompts/system.md',import.meta.url),
    'utf8'
);
const admin=await readFile(
    new URL('../apps/boss/admin.html',import.meta.url),
    'utf8'
);
const bossCss=await readFile(
    new URL('../apps/boss/boss.css',import.meta.url),
    'utf8'
);
const bossNav=await readFile(
    new URL('../apps/boss/components/nav.html',import.meta.url),
    'utf8'
);
const bossNavPages=await Promise.all(
    [
        'admin.html',
        'chat.html',
        'export.html',
        'import.html',
        'library.html',
        'library-setup.html'
    ].map(name=>readFile(new URL(`../apps/boss/${name}`,import.meta.url),'utf8'))
);
const bossNavLogoBytes=await readFile(
    new URL(
        '../apps/boss/img/boss-libraries-logo-horizontal-transparent.png',
        import.meta.url
    )
);
const fileManager=await readFile(
    new URL('../arcane/components/file-manager.html',import.meta.url),
    'utf8'
);
const htmlImport=await readFile(
    new URL('../arcane/modules/HTMLImport.js',import.meta.url),
    'utf8'
);
const manifest=JSON.parse(
    await readFile(
        new URL('../apps/boss/manifest.json',import.meta.url),
        'utf8'
    )
);
const manifestIcon=manifest.icons[0];
const manifestIconBytes=await readFile(
    new URL(
        `../apps/boss/${manifestIcon.src.replace(/^\.\//,'')}`,
        import.meta.url
    )
);

describe('BOSS Libraries chat integration',()=>{
    it('loads the canonical prompt and normalized document runtime',()=>{
        assert.match(chat,/\.\/apps\/boss\/prompts\/system\.md/);
        assert.match(chat,/createBossLibraryContext/);
        assert.match(chat,/loadBossLibraryManifest/);
        assert.match(chat,/inspectBossLibrarySeedState/);
        assert.doesNotMatch(chat,/seedBossLibraryDocuments/);
    });

    it('routes first-time library setup through an explicit import flow',()=>{
        assert.match(chat,/inspectBossLibrarySeedState/);
        assert.match(chat,/\.\/apps\/boss\/library-setup\.html/);
        assert.match(chat,/setupUrl\.searchParams\.set\('start','1'\)/);
        assert.match(chat,/first time|first-time/i);
        assert.match(chat,/import[^\n]{0,100}BOSS[^\n]{0,100}documents/i);
        assert.match(chat,/modal\.(?:populate|open)/);
        assert.match(chat,/modal-closed/);
        assert.match(chat,/providerSetupRequested/);
        assert.match(chat,/BOSS_MODAL_UNAVAILABLE/);
        assert.match(chat,/id="uploadStatus"[^>]*role="status"[^>]*aria-live="polite"/);
        assert.doesNotMatch(chat,/seedBossLibraryDocuments/);
    });

    it('offers a Profile action when the selected provider or license is missing',()=>{
        assert.match(chat,/user\.license_key/);
        assert.match(chat,/\.\/apps\/boss\/admin\.html/);
        assert.match(chat,/Profile/);
        assert.match(chat,/AI is not configured|license|provider/i);
        assert.match(chat,/modal\.(?:populate|open)/);
    });

    it('uses focused librarian tools instead of dumping every document',()=>{
        assert.match(chat,/name:'search_boss_library'/);
        assert.match(chat,/name:'prepare_boss_handoff'/);
        assert.match(
            chat,
            /call it with a narrower or corrected query whenever the automatically supplied library context does not directly support/
        );
        assert.match(
            prompt,
            /If those records do not directly support the requested answer, call `search_boss_library` with a narrower or corrected query/
        );
        assert.match(
            prompt,
            /Do not fall back to general model knowledge merely because the first search was incomplete/
        );
        assert.doesNotMatch(chat,/check_for_related_resources/);
        assert.doesNotMatch(chat,/getAll\(['"]documents['"]\)/);
        assert.doesNotMatch(chat,/# Documents\s*:/);
    });

    it('defines the master brand as a librarian rather than a mentor',()=>{
        assert.match(prompt,/BOSS Libraries AI Librarian/);
        assert.match(prompt,/You are not a mentor/);
        assert.match(prompt,/What are you trying to find or get done\?/);
        assert.doesNotMatch(chat,/PROFILE-FIRST RULE/);
        assert.doesNotMatch(chat,/SCORE HANDOFF SUMMARY/);
    });

    it('retrieves a bounded context for each request and keeps restricted records opt-in',()=>{
        assert.match(chat,/topK:options\.topK\|\|4/);
        assert.match(chat,/totalCharacterLimit:15000/);
        assert.match(chat,/includeRestricted:options\.includeRestricted===true/);
        assert.match(chat,/includeRestricted:params\.include_restricted===true/);
    });

    it('keeps the phone chat usable and supplies a square install icon',()=>{
        assert.match(
            bossCss,
            /@media \(max-width:36em\)[\s\S]*?\.file-manager\s*\{[\s\S]*?display:none/
        );
        assert.match(
            bossCss,
            /main\.contents\s*\{[\s\S]*?grid-template-rows:minmax\(0,1fr\) auto/
        );

        const [width,height]=manifestIcon.sizes.split('x').map(Number);

        assert.equal(width,height);
        assert.ok(manifestIconBytes.length>1000);
    });

    it('keeps a large document shelf independently scrollable',()=>{
        assert.match(
            fileManager,
            /:host\s*\{[\s\S]*?overflow-y:auto;[\s\S]*?height:100%;/
        );
        assert.match(
            fileManager,
            /\.directory\.open\s*\{[\s\S]*?max-height:none;[\s\S]*?overflow:visible;/
        );
        assert.match(chat,/file-manager\.html\?v=18/);
        assert.match(chat,/data-hidden-prefixes="\.boss-library-"/);
    });

    it('executes imported component scripts with their host on repeat loads',()=>{
        assert.match(htmlImport,/document\.createElement\('script'\)/);
        assert.match(htmlImport,/document\.head\.appendChild\(executable\)/);
        assert.match(htmlImport,/arcaneHostToken/);
        assert.match(htmlImport,/htmlImportHostRegistry\.set\(hostToken,this\)/);
        assert.doesNotMatch(htmlImport,/\beval\s*\(|new AsyncFunction/);
    });

    it('keeps every selectable appearance inside the BOSS brand system',()=>{
        for(const theme of ['warm','curious','hopeful','harmony','warrior']){
            const selector=new RegExp(
                `body\\.${theme},\\s*\\.boss-palette-${theme}\\s*\\{`,
                'g'
            );

            assert.equal(
                [...bossCss.matchAll(selector)].length,
                2,
                `${theme} should define light and dark BOSS palettes`
            );
        }

        assert.match(bossCss,/--boss-icon-navy-filter:/);
        assert.match(bossCss,/--boss-icon-gold-filter:/);
        assert.ok(
            (bossCss.match(/--file-icon-filter:/g)||[]).length>=12,
            'each light and dark BOSS palette should choose a file color'
        );
        assert.match(bossCss,/--button-hover-text-color:/);
        assert.match(bossCss,/button:hover,[\s\S]*?--button-hover-text-color/);
    });

    it('lets the BOSS navigation inherit every selected appearance',()=>{
        for(const token of [
            'start',
            'end',
            'text',
            'border',
            'active-bg',
            'active-border',
            'active-text',
            'focus',
            'shadow'
        ]){
            assert.match(bossCss,new RegExp(`--boss-nav-${token}:`));
            assert.match(bossNav,new RegExp(`var\\(--boss-nav-${token}`));
        }

        assert.match(
            bossCss,
            /@media \(prefers-color-scheme:dark\)[\s\S]*?--boss-nav-start:var\(--modal-background\)/
        );
        assert.match(bossNav,/--app-bar-surface:linear-gradient\(125deg,var\(--nav-start\),var\(--nav-end\)\)/);
        assert.match(bossNav,/--app-bar-text:var\(--nav-text\)/);
        assert.match(bossNav,/app-bar\.html\?v=3/);
        assert.match(chat,/boss\.css\?v=7/);
        for(const page of bossNavPages){
            assert.match(page,/components\/nav\.html\?v=12/);
        }
        assert.match(admin,/boss\.css\?v=7/);
        assert.match(bossNav,/boss-libraries-logo-horizontal-transparent\.png\?v=2/);
        assert.match(bossNav,/\.logo\s*\{[\s\S]*?position:absolute;[\s\S]*?inset:0;/);
        assert.match(bossNav,/width:clamp\(9\.75rem,14vw,10\.5rem\)/);
        assert.match(bossNav,/color-mix\(in srgb,var\(--boss-cream\) 72%,var\(--nav-start\)\)/);
        assert.doesNotMatch(bossNav,/var\(--boss-cream\) 88%/);
        assert.match(bossNav,/object-fit:contain/);
        assert.match(bossNav,/object-position:50% 50%/);
        assert.match(bossNav,/transform:none/);
        assert.match(bossNav,/color-mix\(in srgb,var\(--boss-cream\)/);
        assert.doesNotMatch(bossNav,/background:#fff/);
        assert.doesNotMatch(bossNav,/object-fit:cover/);
        assert.doesNotMatch(bossNav,/transform:scale/);
        assert.equal(bossNavLogoBytes.readUInt32BE(16),1031);
        assert.equal(bossNavLogoBytes.readUInt32BE(20),396);
        assert.equal(bossNavLogoBytes[25],6,'navigation wordmark must be an RGBA PNG');

        const decodedLogo=decodeRgbaPng(bossNavLogoBytes);
        let partialWhiteMatte=0;
        let transparentWhitePayload=0;
        let wordmarkKeyResidue=0;

        for(let y=0;y<decodedLogo.height;y++){
            for(let x=0;x<decodedLogo.width;x++){
                const offset=(y*decodedLogo.width+x)*4;
                const red=decodedLogo.pixels[offset];
                const green=decodedLogo.pixels[offset+1];
                const blue=decodedLogo.pixels[offset+2];
                const alpha=decodedLogo.pixels[offset+3];

                if(alpha>0&&alpha<255&&Math.min(red,green,blue)>=220){
                    partialWhiteMatte++;
                }
                if(alpha===0&&(red||green||blue)){
                    transparentWhitePayload++;
                }
                if(
                    x>=400
                    &&alpha>0
                    &&Math.max(
                        Math.abs(red-254),
                        Math.abs(green-254),
                        Math.abs(blue-254)
                    )<=20
                ){
                    wordmarkKeyResidue++;
                }
            }
        }

        assert.equal(partialWhiteMatte,0,'logo must not retain a partial white matte');
        assert.equal(transparentWhitePayload,0,'transparent pixels must not retain white RGB data');
        assert.equal(wordmarkKeyResidue,0,'wordmark counters must expose the CSS surface');
        assert.equal((bossNav.match(/aria-label="[^"]+"/g)||[]).length>=5,true);
    });

    it('opens customer support from the BOSS header',()=>{
        assert.match(bossNav,/id="supportButton"[^>]*slot="trailing"/);
        assert.match(bossNav,/aria-label="Customer support"/);
        assert.match(bossNav,/id="supportModal"[^>]*modal\.html\?v=13/);
        assert.match(bossNav,/admin@bosslibraries\.com/);
        assert.match(bossNav,/navigator\.clipboard\.writeText\(supportEmail\)/);
        assert.match(bossNav,/document\.execCommand\('copy'\)/);
        assert.match(bossNav,/Email address copied\./);
        assert.match(bossNav,/href=`mailto:\$\{supportEmail\}`/);
        assert.match(bossNav,/Email support/);
        assert.match(bossNav,/role','status'/);
        assert.match(bossNav,/modal-ready/);
        assert.doesNotMatch(bossNav,/setTimeout|setInterval/);
    });

    it('shows accurate palette previews and a usable local OpenAI key field',()=>{
        for(const theme of ['default','warm','curious','hopeful','harmony','warrior']){
            assert.match(admin,new RegExp(`boss-palette-${theme}`));
        }

        assert.doesNotMatch(admin,/rgb\(255, 135, 60\)/);
        assert.match(admin,/id="license_key"[\s\S]*?type="password"/);
        assert.match(admin,/id="toggle-api-key"/);
        assert.match(admin,/license_key: apiKeyInput\.value/);
        assert.doesNotMatch(admin,/<section class=['"]hidden['"]>[\s\S]*?License Key/);
    });

    it('hydrates a Library search as an editable Librarian draft without auto-sending it',()=>{
        assert.match(chat,/chatParameters\.get\('q'\)/);
        assert.match(chat,/libraryHandoffQuery[\s\S]*?\.trim\(\)\.slice\(0,500\)/);
        assert.match(chat,/chatInput\.value=libraryHandoffQuery/);
        assert.match(chat,/chatInput\.dispatchEvent\(new Event\('keyup',\{bubbles:true\}\)\)/);
        assert.match(chat,/chatInput\.focus\(\{preventScroll:true\}\)/);
        assert.match(chat,/if\(libraryHandoffQuery\)\{\s*return;\s*\}\s*sendMessage\(message\)/);
        assert.doesNotMatch(chat,/innerHTML=libraryHandoffQuery/);
    });

    it('offers editable one-question-at-a-time pitch practice without creating a second AI surface',()=>{
        assert.match(bossNav,/href="\.\/apps\/boss\/chat\.html\?mode=pitch"/);
        assert.match(bossNav,/aria-label="Practice a business pitch with the BOSS Librarian"/);
        assert.match(chat,/chatParameters\.get\('mode'\)==='pitch'/);
        assert.match(chat,/Ask for my audience, desired outcome, and target length one focused question at a time/);
        assert.match(chat,/Be a rehearsal evaluator, not a mentor or professional adviser/);
        assert.match(chat,/Search the BOSS Library before recommending any resource/);
        assert.match(chat,/Pitch-practice instructions to review with the BOSS Librarian/);
        assert.match(chat,/pitchPracticeMode\?pitchPracticePrompt/);
        assert.doesNotMatch(chat,/pitchPracticePrompt[\s\S]*?sendMessage\(pitchPracticePrompt\)/);
    });
});
