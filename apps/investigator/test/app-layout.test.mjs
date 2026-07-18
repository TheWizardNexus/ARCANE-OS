import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const css=await readFile(new URL('../investigator.css',import.meta.url),'utf8');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const dataHtml=await readFile(new URL('../data.html',import.meta.url),'utf8');
const briefHtml=await readFile(new URL('../brief.html',import.meta.url),'utf8');
const packageManifest=JSON.parse(await readFile(new URL('../arcane-package.json',import.meta.url),'utf8'));

test('standalone app overrides the shared sidebar grid',()=>{
  assert.match(css,/body\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css,/\.topbar,main\{grid-column:1\}/);
  assert.match(css,/main\{padding:0;border-radius:0\}/);
});

test('dark-theme text uses the correct surface channels',()=>{
  assert.match(css,/\.hero p\{color:var\(--investigator-ink\)\}/);
  assert.match(css,/\.metrics strong\{color:var\(--text-color\)\}/);
  assert.match(html,/investigator\.css\?v=12/);
});

test('analysis pages stay inside Investigator and inherit the Arcane theme',async()=>{
  for(const name of ['brief.html','conduct.html','timeline.html','motives.html','case-map.html']){
    const page=await readFile(new URL(`../${name}`,import.meta.url),'utf8');
    assert.match(page,/arcane\/css\/theme\.css/);
    assert.match(page,/arcane\/modules\/ThemeBootstrap\.js/);
    assert.doesNotMatch(page,/apps\/(?:redress|precrisis)\//);
    assert.ok(packageManifest.include.includes(name));
  }
});

test('police brief uses shared neutral surfaces and an app-owned semantic proof matrix',async()=>{
  const script=await readFile(new URL('../modules/InvestigatorBriefApp.js',import.meta.url),'utf8');
  const dataModule=await readFile(new URL('../modules/InvestigatorReferralData.js',import.meta.url),'utf8');
  assert.match(briefHtml,/summary-strip\.html/);
  assert.match(briefHtml,/source-explanation\.html/);
  assert.match(briefHtml,/<table class="evidence-matrix">/);
  assert.match(briefHtml,/Selected allegation chronology/);
  assert.match(briefHtml,/Keep criminal referral and family relief separate/);
  assert.match(briefHtml,/id="executiveSummary"/);
  assert.match(briefHtml,/id="actionRequested"/);
  assert.match(briefHtml,/id="candidateAuthorities"/);
  assert.match(briefHtml,/id="candidateMotive"/);
  assert.match(briefHtml,/id="candidateChronologyRows"/);
  assert.match(briefHtml,/id="candidateOffense"/);
  assert.match(briefHtml,/id="candidateTarget"/);
  assert.match(briefHtml,/id="candidatePrincipalBlocker"/);
  assert.match(script,/renderAuthorities\(candidate\)/);
  assert.match(script,/renderMotive\(candidate\)/);
  assert.match(script,/renderCandidateChronology\(candidate\)/);
  assert.match(script,/'data-source-id':source\.id/);
  assert.match(script,/initialSourceId/);
  assert.match(script,/textContent/);
  assert.doesNotMatch(script,/innerHTML/);
  assert.match(dataModule,/Referral\/referral-case\.json/);
  assert.match(dataModule,/contextualSourceIds/);
  assert.match(dataModule,/candidate\.elements\.flatMap\(item=>item\.sourceIds\)/);
  assert.doesNotMatch(`${briefHtml}\n${script}\n${dataModule}`,/apps\/(?:redress|precrisis)\//);
});

test('filing cards expose clickable source-explanation leads without nesting buttons',async()=>{
  const script=await readFile(new URL('../modules/InvestigatorApp.js',import.meta.url),'utf8');
  assert.match(script,/class="mini-finding/);
  assert.match(script,/data-analysis-id/);
  assert.match(script,/prioritizeFindings/);
  assert.match(script,/queryMatches/);
  assert.match(html,/source-explanation\.html/);
  assert.doesNotMatch(html,/\bCRAC\b/);
});

test('overview distinguishes machine scan coverage from saved human review',async()=>{
  const script=await readFile(new URL('../modules/InvestigatorApp.js',import.meta.url),'utf8');
  const caseIndex=JSON.parse(await readFile(new URL('../data/cases/24FL001068/case-index.json',import.meta.url),'utf8'));
  const machineScanned=caseIndex.filings.filter(item=>item.initialReview?.attributes?.attributionSource==='automated-provisional').length;
  const humanReviewed=caseIndex.filings.filter(item=>item.reviewStatus!=='not-reviewed').length;
  assert.equal(machineScanned,262);
  assert.equal(humanReviewed,0);
  assert.match(html,/Machine-scanned/);
  assert.match(html,/InvestigatorApp\.js\?v=7/);
  assert.match(script,/Imported \/ machine-scanned/);
  assert.match(script,/Complete PDF and Markdown pairs; not human-reviewed/);
  assert.match(script,/Human-reviewed against source/);
  assert.match(script,/\$\{machineScanned\} \/ \$\{totalFilings\}/);
  assert.match(script,/\$\{reviewed\.length\} \/ \$\{totalFilings\}/);
});

test('same-app data library exposes filings and evidence without cross-app imports',()=>{
  assert.match(dataHtml,/data-library/);
  assert.match(dataHtml,/data-library-view="filings"/);
  assert.match(dataHtml,/data-library-view="evidence"/);
  assert.match(dataHtml,/ThemeBootstrap\.js/);
  assert.doesNotMatch(dataHtml,/apps\/precrisis/);
  assert.match(html,/href="\.\/apps\/investigator\/data\.html"/);
  assert.match(dataHtml,/document-inspector\.html\?v=5/);
  assert.match(dataHtml,/InvestigatorDataApp\.js\?v=4/);
});

test('case data path is centralized inside the Investigator app',async()=>{
  const config=await readFile(new URL('../modules/InvestigatorCaseData.js',import.meta.url),'utf8');
  assert.match(config,/apps\/investigator\/data\/cases\/24FL001068/);
  assert.doesNotMatch(config,/apps\/investigator\/cases\/24FL001068/);
  assert.match(config,/segment==='\.\.'/);
});

test('record dialog waits for the inspector contract, not early import completion',async()=>{
  const dialog=await readFile(new URL('../modules/InvestigatorRecordDialog.js',import.meta.url),'utf8');
  assert.match(dialog,/loadDocument','document-inspector-ready'/);
  assert.doesNotMatch(dialog,/loadDocument','html-import-ready'/);
  assert.match(dialog,/record\.parentPdfPath\?assetUrl\(record\.parentPdfPath\)/);
  assert.match(dialog,/record\.sourcePageStatus==='resolved'/);
  assert.match(dialog,/pdfPage:config\.pdfPage/);
});

test('private case data is excluded from shareable package content',()=>{
  assert.ok(packageManifest.exclude.includes('data'));
  assert.ok(packageManifest.include.every(entry=>!entry.startsWith('data/')));
});

test('every Investigator page links the same-app Police / DA brief',async()=>{
  for(const name of ['index.html','brief.html','data.html','conduct.html','timeline.html','motives.html','case-map.html']){
    const page=await readFile(new URL(`../${name}`,import.meta.url),'utf8');
    assert.match(page,/apps\/investigator\/brief\.html/);
  }
  assert.ok(packageManifest.include.includes('brief.html'));
});

test('filing audit exposes a distinct id, date, filer, and title hierarchy',async()=>{
  const script=await readFile(new URL('../modules/InvestigatorApp.js',import.meta.url),'utf8');
  assert.match(script,/class="file-sequence"/);
  assert.match(script,/class="file-date"/);
  assert.match(script,/class="file-party"/);
  assert.match(script,/escape\(item\.title\)/);
  assert.match(css,/\.filing\{grid-template-columns:132px minmax\(0,1fr\) auto\}/);
});
