import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
    hasPdfSignature,
    previewKind,
    previewMimeType
} from '../modules/FilePreview.js';
import {neutralizeMarkdownSource} from '../modules/MarkdownSafety.js';
import {marked} from '../../../arcane/modules/Marked.min.js';

const redressRoot=fileURLToPath(new URL('../',import.meta.url));
const repositoryRoot=fileURLToPath(new URL('../../../',import.meta.url));

async function text(relativePath){
    return readFile(path.join(redressRoot,relativePath),'utf8');
}

function localReferences(source=''){
    return Array.from(source.matchAll(/(?:href|src)=["'](\.\/[^"'?#]+)(?:[?#][^"']*)?["']/g),match=>match[1]);
}

test('app shell points only to present repository resources',async()=>{
    const index=await text('index.html');
    const nav=await text('components/nav.html');
    const references=[...localReferences(index),...localReferences(nav)];

    assert.match(index,/<base href="\.\.\/\.\.\/">/);
    assert.ok(references.length>=8);

    for(const reference of references){
        await assert.doesNotReject(
            access(path.join(repositoryRoot,reference.slice(2))),
            `Missing local resource ${reference}`
        );
    }
});

test('controller-required controls exist in the static shell',async()=>{
    const index=await text('index.html');
    const requiredIds=[
        'aiSettingsDialog','aiSettingsForm','analysisForm','analysisOutput','assistantDrawerToggle','assistantPanel',
        'argumentForm','argumentOutput','caseDropZone','caseFolderInput',
        'caseProfileDialog','caseProfileForm','caseSwitcher','caseTree','chatForm','chatInput',
        'chatMessages','draftForm','draftOutput','evidenceDropZone','evidenceInput',
        'closeFilePreview','downloadPreviewFile','fileInspector','filePreviewDialog','filePreviewMeta','filePreviewSurface','filePreviewTitle',
        'filingDropZone','filingInput','importProgress','importStatus','newCaseDialog','newCaseForm',
        'researchForm','researchOutput','selectedFileActions','startSocraticPractice','caseSummaryStrip'
    ];

    for(const id of requiredIds){
        assert.match(index,new RegExp(`id=["']${id}["']`),`Missing #${id}`);
    }
});

test('assistant drawer delegates shell behavior to the shared Arcane panel',async()=>{
    const index=await text('index.html');
    const controller=await text('modules/RedressApp.js');
    const component=await readFile(path.join(repositoryRoot,'arcane/components/assistant-panel.html'),'utf8');

    assert.match(index,/id="assistantPanel"[^>]+assistant-panel\.html\?v=3/);
    assert.match(index,/id="clearChat"[^>]+data-assistant-clear/);
    assert.match(controller,/event:'assistant-ready'/);
    assert.match(controller,/panel\.addEventListener\('assistant-send'/);
    assert.match(controller,/panel\.addEventListener\('assistant-clear'/);
    assert.match(component,/part="close-button"/);
    assert.match(component,/event\.key==='Escape'/);
});

test('legal forms and file previews use the shared Arcane modal component',async()=>{
    const index=await text('index.html');
    const controller=await text('modules/RedressApp.js');

    await assert.doesNotReject(access(path.join(redressRoot,'redress-modal.css')));
    const modal=await readFile(path.join(repositoryRoot,'arcane/components/modal.html'),'utf8');
    assert.equal((index.match(/href="\.\/arcane\/components\/modal\.html\?v=13"/g)||[]).length,4);
    assert.doesNotMatch(index,/<dialog\b/);
    assert.doesNotMatch(index,/class="[^"]*redress-dialog/);
    assert.doesNotMatch(controller,/\.showModal\(/);
    assert.match(controller,/waitForComponent/);
    assert.match(controller,/host\.populate\(content,false\)/);
    assert.match(controller,/redress-modal\.css\?v=4/);
    assert.match(modal,/<dialog\b/);
    assert.doesNotMatch(modal,/modal-overlay/);
});

test('modal fields honor the native hidden attribute',async()=>{
    const modalCSS=await text('redress-modal.css');

    assert.match(modalCSS,/\.redress-modal-content \[hidden\]\s*\{[^}]*display:none!important;/s);
});

test('case navigation uses the shared provider tree and summary strip',async()=>{
    const index=await text('index.html');
    const controller=await text('modules/RedressApp.js');
    const caseTreeCSS=await text('case-tree.css');
    const redressCSS=await text('redress.css');
    const packageConfiguration=JSON.parse(await text('arcane-package.json'));

    await assert.doesNotReject(access(path.join(redressRoot,'case-tree.css')));
    assert.match(index,/id="caseTree"[^>]+data-layout="tree"[^>]+data-open-mode="event"/);
    assert.match(index,/id="caseSummaryStrip"[^>]+summary-strip\.html\?v=2/);
    assert.match(controller,/createCaseTreeProvider/);
    assert.match(controller,/host\.setProvider\(/);
    assert.match(controller,/file-manager-select/);
    assert.match(controller,/file-manager-open/);
    assert.match(controller,/event\.preventDefault\(\)/);
    assert.match(controller,/openSelectedFile\(record\)/);
    assert.match(controller,/case-tree\.css\?v=2/);
    assert.match(controller,/new URL\('\.\.\/case-tree\.css\?v=2',import\.meta\.url\)/);
    assert.match(controller,/entry\?\.kind==='directory'/);
    assert.match(controller,/clearSelection\?\.\(\{emit:false\}\)/);
    assert.match(controller,/pointerDirectoryActivation/);
    assert.match(controller,/focusedEntry\.blur\(\)/);
    assert.match(controller,/renderInspectorError\(error\)/);
    assert.match(caseTreeCSS,/--file-icon-filter:/);
    assert.match(caseTreeCSS,/data-kind="directory"/);
    assert.match(caseTreeCSS,/:focus-visible>\.tree-item-row/);
    assert.match(redressCSS,/\.case-tree\{[\s\S]*--file-icon-filter:/);
    assert.ok(packageConfiguration.include.includes('case-tree.css'));
    assert.doesNotMatch(index,/treeFolderTemplate/);
});

test('startup follows Arcane module events without readiness polling',async()=>{
    const index=await text('index.html');
    const controller=await text('modules/RedressApp.js');
    const repository=await text('modules/CaseRepository.js');
    const fileManager=await readFile(path.join(repositoryRoot,'arcane/components/file-manager.html'),'utf8');
    const componentWait=await readFile(path.join(repositoryRoot,'arcane/modules/WaitForComponent.js'),'utf8');

    assert.match(index,/file-manager\.html\?v=19/);
    assert.match(index,/RedressApp\.js\?v=16/);
    assert.match(fileManager,/window\.addEventListener\(\s*'dbopfs-ready',\s*init,\s*\{once:true\}\s*\)/);
    assert.match(fileManager,/if\(window\.dbopfs\?\.ready\)\{\s*init\(\);\s*\}/);
    assert.doesNotMatch(fileManager,/if\(layout==='tree'\)\{\s*init\(\);/);
    assert.ok(fileManager.indexOf("await import('../modules/WaitForComponent.js')")<fileManager.indexOf('host.ready=false;'));
    assert.ok(fileManager.indexOf('let treeLoadSequence=0;')<fileManager.indexOf('host.loadAll=loadAll;'));
    assert.doesNotMatch(componentWait,/setTimeout|setInterval|retries|interval/);
    assert.doesNotMatch(repository,/Arcane storage did not become ready|setTimeout/);
    assert.doesNotMatch(controller,/waitForWindowEvent|did not arrive/);
    assert.match(repository,/addEventListener\('dbopfs-ready',complete\)/);
    assert.match(controller,/addEventListener\('ai-ready',ready\)/);
});

test('file previews use native browser elements and lifecycle-scoped blob URLs',async()=>{
    const index=await text('index.html');
    const controller=await text('modules/RedressApp.js');
    const modalCSS=await text('redress-modal.css');
    const openSelectedFile=controller.slice(
        controller.indexOf('async openSelectedFile'),
        controller.indexOf('async showFilePreview')
    );

    assert.match(index,/id="filePreviewDialog"[^>]+file-preview-modal/);
    assert.match(index,/id="downloadPreviewFile"/);
    assert.match(controller,/document\.createElement\('iframe'\)/);
    assert.match(controller,/document\.createElement\('img'\)/);
    assert.match(controller,/document\.createElement\('audio'\)/);
    assert.match(controller,/document\.createElement\('video'\)/);
    assert.match(controller,/hasPdfSignature\(file\)/);
    assert.match(controller,/TEXT_PREVIEW_BYTE_LIMIT/);
    assert.match(controller,/modal-closed/);
    assert.match(controller,/URL\.revokeObjectURL/);
    assert.match(controller,/filePreviewRequestSequence/);
    assert.match(controller,/requestSequence!==this\.filePreviewRequestSequence/);
    assert.ok(
        openSelectedFile.indexOf('if(!buttonOwner)')<openSelectedFile.indexOf('const requestSequence=++this.filePreviewRequestSequence'),
        'A rejected overlapping open must not invalidate the in-flight preview request'
    );
    assert.match(controller,/dialog\.host\.shadowRoot\?\.querySelector\('#close'\)\?\.focus/);
    assert.match(controller,/catch\(error\)\{\s*if\(this\.filePreview===state\)/s);
    assert.doesNotMatch(controller,/setTimeout\(\(\)=>URL\.revokeObjectURL/);
    assert.match(modalCSS,/\.native-file-frame/);
    assert.match(modalCSS,/\.native-audio-preview/);
});

test('async inspector rendering suppresses stale duplicate previews',async()=>{
    const controller=await text('modules/RedressApp.js');

    assert.match(controller,/const sequence=\+\+this\.inspectorSequence;/);
    assert.match(controller,/this\.inspectorSequence===sequence/);
    assert.match(controller,/Ignoring a stale file-inspector error/);
    assert.match(controller,/renderInspectorError\(error\)\s*\{\s*this\.inspectorSequence\+\+;/s);
});

test('preview classification rejects active SVG rendering and validates PDF bytes',async()=>{
    assert.equal(previewKind({name:'order.pdf',mimeType:'application/octet-stream'}),'pdf');
    assert.equal(previewMimeType({name:'order.pdf',mimeType:'application/octet-stream'}),'application/pdf');
    assert.equal(previewKind({name:'diagram.svg',mimeType:'image/svg+xml'}),'text');
    assert.equal(previewKind({name:'page.html',mimeType:'text/html'}),'text');
    assert.equal(previewKind({name:'hearing.m4a',mimeType:''}),'audio');
    assert.equal(previewKind({name:'brief.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),'unsupported');
    assert.equal(await hasPdfSignature(new Blob(['%PDF-1.7\n'])) ,true);
    assert.equal(await hasPdfSignature(new Blob(['not a pdf'])) ,false);
});

test('Arcane Markdown safely renders source files, work product, and assistant responses',async()=>{
    const index=await text('index.html');
    const controller=await text('modules/RedressApp.js');
    const css=await text('redress.css');

    assert.match(controller,/import MD from '\.\.\/\.\.\/\.\.\/arcane\/modules\/MD\.js'/);
    assert.match(controller,/new MD\(neutralizeMarkdownSource\(markdown\)\)\.safeRendered/);
    assert.doesNotMatch(controller,/new MD\([^\n]+\)\.rendered/);
    assert.match(controller,/constrainMarkdownFragment\(template\.content\)/);
    assert.match(controller,/MARKDOWN_ALLOWED_TAGS/);
    assert.match(controller,/MARKDOWN_ALLOWED_ATTRIBUTES/);
    assert.match(controller,/element\.removeAttribute\(attribute\.name\)/);
    assert.match(controller,/const sourcePreview=this\.filePreview;/);
    assert.match(controller,/this\.filePreviewRequestSequence!==sourceRequestSequence/);
    assert.match(controller,/template\.content\.querySelectorAll\('img'\)/);
    assert.match(controller,/this\.renderMarkdown\(output,workProduct\)/);
    assert.match(controller,/this\.renderMarkdown\(message,text\)/);
    assert.equal((index.match(/class="legal-output markdown-content"/g)||[]).length,4);
    assert.doesNotMatch(index,/<pre id="(?:analysis|draft|research|argument)Output"/);
    assert.match(css,/\.markdown-content :is\(h1,h2,h3,h4,h5,h6\)/);
    assert.match(css,/\.markdown-content table/);
});

test('Markdown source is inert before Arcane performs its DOM sanitization pass',()=>{
    const hostile=[
        '<table background="/remote.png"><tr><td>Private</td></tr></table>',
        '<svg><image href="/probe.svg"></image></svg>',
        '![remote image](/probe.png)',
        String.raw`\\![escaped image probe](/probe-2.png)`
    ].join('\n');
    const safe=neutralizeMarkdownSource(hostile);

    assert.doesNotMatch(safe,/<(?:table|svg|image)\b/i);
    assert.match(safe,/&lt;table background=/);
    assert.match(safe,/\\!\[remote image\]\(\/probe\.png\)/);
    assert.match(safe,/\\{3}!\[escaped image probe\]\(\/probe-2\.png\)/);
    assert.equal(
        neutralizeMarkdownSource('[Case file](<../Raw/Browser PDF.pdf>)'),
        '[Case file](<../Raw/Browser PDF.pdf>)'
    );
    assert.equal(neutralizeMarkdownSource('<https://example.test/path>'),'<https://example.test/path>');
    assert.match(
        marked.parse(neutralizeMarkdownSource('<svg><image href="/probe"></image></svg>\n\n> Quoted finding')),
        /<blockquote>[\s\S]*Quoted finding[\s\S]*<\/blockquote>/
    );
});

test('source inspector reuses bounded preview classification for Markdown variants',async()=>{
    const controller=await text('modules/RedressApp.js');

    assert.match(controller,/const kind=previewKind\(record\);/);
    assert.match(controller,/const result=await this\.readFilePreviewText\(file\);/);
    assert.match(controller,/Inspector preview limited to the first/);
    assert.doesNotMatch(controller,/record\.extension==='\.md'/);
});

test('Redress app navigation is composed from the shared Arcane app bar',async()=>{
    const nav=await text('components/nav.html');
    assert.match(nav,/app-bar\.html\?v=3/);
    assert.match(nav,/location\.hash\.replace\(\/\^#\/,''\)\|\|'workspace'/);
    assert.match(nav,/slot="brand-mark"/);
    assert.equal((nav.match(/slot="navigation"/g)||[]).length,5);
});

test('public package includes the modal form stylesheet loaded at runtime',async()=>{
    const configuration=JSON.parse(await text('arcane-package.json'));
    assert.ok(configuration.include.includes('redress-modal.css'));
});

test('Redress follows Arcane skins and the system color scheme',async()=>{
    const css=await text('redress.css');
    const modalCSS=await text('redress-modal.css');
    const nav=await text('components/nav.html');

    assert.doesNotMatch(css,/:root\s*\{[^}]*color-scheme\s*:\s*light/s);
    assert.match(css,/body:not\(\[class\]\),\s*body\.default\s*\{/);
    assert.match(css,/@media\(prefers-color-scheme:dark\)/);
    assert.match(modalCSS,/:host\s*\{[^}]*color-scheme:inherit/s);
    assert.match(nav,/--nav-start:var\(--primary-color/);
});

test('navigation links retain the relative Redress path under the repository base',async()=>{
    const nav=await text('components/nav.html');

    assert.doesNotMatch(nav,/href="#/);
    for(const view of ['workspace','analyze','draft','research','argue']){
        assert.match(nav,new RegExp(`href="\\./apps/redress/index\\.html#${view}"`));
    }
});

test('manifest and shell expose the Redress product entrypoint',async()=>{
    const manifest=JSON.parse(await text('manifest.json'));
    const index=await text('index.html');
    const nav=await text('components/nav.html');
    const productSurface=`${index}\n${nav}`;

    assert.equal(manifest.start_url,'./index.html');
    assert.equal(manifest.scope,'./');
    assert.match(manifest.name,/Redress Legal Workbench/);
    assert.match(productSurface,/Workspace/);
    assert.match(productSurface,/Analyze/);
    assert.match(productSurface,/Draft/);
    assert.match(productSurface,/Research/);
    assert.match(productSurface,/Argue/);
    assert.match(index,/Filing by Filing\/PDF/);
    assert.match(index,/New evidence/);
});

test('docs distinguish the logical DBOPFS build from planned native providers',async()=>{
    const readme=await text('README.md');
    const architecture=await text('ARCHITECTURE.md');

    assert.match(readme,/uses DBOPFS explicitly/);
    assert.match(readme,/nested case tree is a Redress logical structure/);
    assert.match(readme,/does not yet have a live connector/);
    assert.match(architecture,/implemented first browser pass represents this tree logically/);
    assert.match(architecture,/native provider will be implemented/);
    assert.doesNotMatch(architecture,/Evidence\/Files/);
});
