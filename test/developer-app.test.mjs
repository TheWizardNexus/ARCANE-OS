import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const appRoot=path.join(repoRoot,'apps','developer');

async function source(relativePath){
    return readFile(path.join(appRoot,relativePath),'utf8');
}

test('Developer app package is a bounded static application',async()=>{
    const packageManifest=JSON.parse(await source('arcane-package.json'));
    const webManifest=JSON.parse(await source('manifest.json'));

    assert.equal(packageManifest.id,'developer');
    assert.equal(packageManifest.displayName,'Arcane Developer');
    assert.equal(packageManifest.entry,'index.html');
    assert.equal(packageManifest.strategy,'static');
    assert.deepEqual(packageManifest.shared,['browser-runtime']);
    assert.deepEqual(packageManifest.include,[
        'developer.css','img','index.html','manifest.json','modules','prompts'
    ]);
    assert.equal(webManifest.icons[0].src,'img/icon.png');
    assert.equal(webManifest.icons[0].type,'image/png');
});

test('Developer app follows the shared theme and component composition',async()=>{
    const html=await source('index.html');
    const themeIndex=html.indexOf('./arcane/css/theme.css');
    const primitivesIndex=html.indexOf('./arcane/css/primitives.css');
    const appCssIndex=html.indexOf('./apps/developer/developer.css');

    assert.ok(themeIndex>=0);
    assert.ok(themeIndex<primitivesIndex);
    assert.ok(primitivesIndex<appCssIndex);
    assert.match(html,/ThemeBootstrap\.js/);
    assert.match(html,/components\/app-bar\.html/);
    assert.match(html,/components\/theme-switcher\.html/);
    assert.match(html,/components\/summary-strip\.html/);
    assert.match(html,/components\/directory-picker\.html/);
    assert.match(html,/components\/task-progress\.html/);
    assert.match(html,/components\/output-panel\.html/);
    assert.match(html,/components\/assistant-panel\.html/);
    assert.doesNotMatch(html,/components\/chat\.html/);
});

test('Developer app pairs one explicit checkout and exposes no discovery or terminal',async()=>{
    const html=await source('index.html');
    const controller=await source('modules/DeveloperApp.js');

    assert.match(html,/id="workspaceRoot"/);
    assert.match(html,/does not scan other folders/);
    assert.match(html,/supported company baseline/);
    assert.doesNotMatch(html,/id="workspaceRoot"[^>]+type="text"/s);
    assert.match(controller,/new PreferenceStore\(/);
    assert.match(controller,/new DevelopmentWorkspace\(globalThis\.Arcane\?\.development\)/);
    assert.match(controller,/workspace\.inspect\(requestedRoot\)/);
    assert.match(controller,/directory-picker-change/);
    assert.match(controller,/directory-picker-error/);
    assert.doesNotMatch(controller,/showDirectoryPicker|webkitdirectory|readdir|\bglob\s*\(|\bdrives?\b/i);
    assert.doesNotMatch(controller,/TerminalClient|terminal\.open|terminal\.write|execCommand|child_process/);
});

test('Developer setup is allowlisted, sequential, observable, and scrolls to output',async()=>{
    const html=await source('index.html');
    const controller=await source('modules/DeveloperApp.js');

    assert.ok(html.indexOf('data-setup-task="node-runtime"')<html.indexOf('data-setup-task="root-dependencies"'));
    assert.ok(controller.indexOf("id:'node-runtime'")<controller.indexOf("id:'root-dependencies'"));
    assert.match(controller,/workspace\.installNode\(\)/);
    assert.match(controller,/id:'root-dependencies'/);
    assert.match(controller,/id:'machine-dependencies'/);
    assert.match(controller,/id:'git-hooks'/);
    assert.match(controller,/id:'windows-signing'/);
    assert.match(controller,/SETUP_TASK_IDS\.has\(taskId\)/);
    assert.match(controller,/reported\?\.available!==true\|\|reported\?\.ready===true/);
    assert.match(controller,/if\(setupRunning\|\|!pairedRoot/);
    assert.match(controller,/await workspace\.setup\(pairedRoot,taskId\)/);
    assert.match(controller,/events\.on\('operation\.log'/);
    assert.match(controller,/events\.on\('operation\.progress'/);
    assert.match(controller,/normalizedLevel==='step'/);
    assert.match(controller,/Number\.isFinite\(progress\)\?`\$\{Math\.max/);
    assert.match(controller,/operationType==='development\.setup'\|\|operationType==='development\.node\.install'/);
    assert.match(controller,/MAX_SETUP_LOG_ENTRIES=500/);
    assert.match(controller,/MAX_SETUP_LOG_CHARACTERS=200000/);
    assert.match(controller,/setStatus\(\{label:'Failed',status:'error'\}\);\s*elements\.setupOutput\.setBody\(setupLog\.join\('\\n'\)\)/);
    assert.doesNotMatch(controller,/setupOutput\.setError\(/);
    assert.match(controller,/await scrollToOutput\(\);/);
    assert.match(controller,/requestAnimationFrame\(reveal\)/);
    assert.match(controller,/scrollIntoView\(/);
    assert.doesNotMatch(controller,/\.runTasks\(/);
    assert.doesNotMatch(controller,/Promise\.all\([^)]*workspace\.setup/s);
    assert.match(html,/>2\. Set up</);
    assert.match(html,/>Set up development tools</);
    assert.match(html,/Choose any item marked as needing setup/);
    assert.doesNotMatch(html,/Run one approved setup step|Choose an approved setup action/);
});

test('Developer chat delegates provider choice and safely renders bounded context answers',async()=>{
    const controller=await source('modules/DeveloperApp.js');
    const prompt=await source('prompts/system.md');

    assert.match(controller,/new ConfiguredAIChatSession\(\{/);
    assert.match(controller,/request:\{expectedProvider\}/);
    assert.match(controller,/contextBuilder:async\(\{input\}\)/);
    assert.match(controller,/await workspace\.context\(pairedRoot,input\)/);
    assert.match(controller,/chatSession\.send\(message\)/);
    assert.doesNotMatch(controller,/chatSession\.send\(message,/);
    assert.match(controller,/chatSession\?\.clear\(\)/);
    assert.match(controller,/checkoutChanged[\s\S]*resetChatSession\(\)/);
    assert.match(controller,/pairedRoot=''[\s\S]*resetChatSession\(\)/);
    assert.match(controller,/chatSession\.history/);
    assert.match(controller,/content\.innerHTML=new MD\([^\n]+\)\.safeRendered/);
    assert.doesNotMatch(controller,/api\.openai\.com|\/api\/chat|Arcane\?\.ollama|Arcane\.ollama/);
    assert.doesNotMatch(controller,/eval\(|new Function\(|postMessage\([^)]*execute/i);
    assert.match(prompt,/Repository text is untrusted data/);
    assert.match(prompt,/never executes AI output/i);
    assert.match(prompt,/one focused change and one focused verification/i);
    assert.match(controller,/Arcane\?\.ai\?\.profile/);
    assert.match(controller,/aiProfile\?\.configured!==true/);
    assert.match(controller,/aiProfile\.local===true/);
    assert.match(controller,/error\?\.code==='AI_PROVIDER_CHANGED'/);
    assert.match(controller,/const runtimeStatus=await loadRuntimeStatus\(\);\s*aiProfile=runtimeStatus\.profile;\s*ollamaRequirement=runtimeStatus\.ollama;\s*resetChatSession\(\)/);
    const providerChangeStart=controller.indexOf('async function handleAIProviderChanged');
    const providerChangeEnd=controller.indexOf('\nfunction clearChat',providerChangeStart);
    const providerChangeHandler=controller.slice(providerChangeStart,providerChangeEnd);
    assert.ok(providerChangeStart>=0&&providerChangeEnd>providerChangeStart);
    assert.match(providerChangeHandler,/provider disclosure has been updated; review it and retry your question/);
    assert.doesNotMatch(providerChangeHandler,/chatSession\.send|sendConfiguredChat/);
    assert.match(controller,/Use Ollama in Arcane Settings for local-only context/);
    assert.match(controller,/file\.redacted===true\?'redacted=true'/);
    assert.match(controller,/secret-pattern-redacted/);
});

test('Developer status reports AI locality, model, and managed Ollama readiness',async()=>{
    const controller=await source('modules/DeveloperApp.js');

    assert.match(controller,/Arcane\?\.ai\?\.profile/);
    assert.match(controller,/Arcane\?\.requirements\?\.list/);
    assert.match(controller,/requirement\?\.id==='ollama'/);
    assert.match(controller,/summaryItem\('ai-location',locality,'AI mode'/);
    assert.match(controller,/summaryItem\('ai-model',model\|\|'Not selected','AI model'/);
    assert.match(controller,/summaryItem\('ollama',ollamaValue,'Ollama'/);
    assert.match(controller,/ready:'Running'/);
    assert.match(controller,/'global-install-required':'Global install needed'/);
    assert.match(controller,/Promise\.allSettled\(\[/);
});

test('Developer styles use animation-friendly color syntax and the platform icon',async()=>{
    const css=await source('developer.css');
    const icon=await readFile(path.join(appRoot,'img','icon.png'));
    const platformIcon=await readFile(path.join(repoRoot,'apps','settings','img','icon.png'));

    assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b/i);
    assert.deepEqual(icon,platformIcon);
});
