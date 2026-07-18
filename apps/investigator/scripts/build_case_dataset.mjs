import {writeFile,mkdir,link,copyFile,readFile,readdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {indexPairedRecord,parseStructuredRecordName,sha256} from '../../../arcane/modules/CaseEvidenceIndexer.js';

const source=process.argv[2]||'C:/Users/codex/Desktop/24FL001068';
const appRoot=path.resolve(import.meta.dirname,'..');
const outputRoot=path.join(appRoot,'data','cases','24FL001068');
const evidenceRoot=path.join(outputRoot,'Evidence','MD');
const documentPdfRoot=path.join(outputRoot,'Documents','PDF');
const documentMarkdownRoot=path.join(outputRoot,'Documents','MD');
const importRoot=path.join(outputRoot,'Import');

async function coupleLocalFile(sourcePath,destinationPath){
  try{
    await link(sourcePath,destinationPath);
  }catch(error){
    if(error.code==='EEXIST') return;
    if(error.code!=='EXDEV'&&error.code!=='EPERM') throw error;
    await copyFile(sourcePath,destinationPath);
  }
}

async function pruneVerifiedDuplicateCouplings(root,filings,{sourceKey,pathKey,extension}){
  const rootPath=path.resolve(root);
  const filingBySourceName=new Map(filings.map(item=>[item[sourceKey],item]));
  const removed=[];
  for(const name of await readdir(rootPath)){
    if(new RegExp(`^F\\d{4}\\${extension}$`,'i').test(name)) continue;
    const filing=filingBySourceName.get(name);
    if(!filing) continue;
    const target=path.resolve(rootPath,name);
    const canonical=path.resolve(outputRoot,filing[pathKey]);
    if(path.dirname(target)!==rootPath||path.dirname(canonical)!==rootPath) throw new Error(`Refusing unsafe duplicate cleanup target: ${name}`);
    const [targetBytes,canonicalBytes]=await Promise.all([readFile(target),readFile(canonical)]);
    if(sha256(targetBytes)!==sha256(canonicalBytes)) continue;
    await unlink(target);
    removed.push({name,canonical:path.basename(canonical),sha256:sha256(canonicalBytes)});
  }
  return removed;
}

async function pruneLegacyEvidenceSummaries(root,evidence){
  const rootPath=path.resolve(root);
  const expected=new Set(evidence.map(item=>path.basename(item.file)));
  const removed=[];
  for(const name of await readdir(rootPath)){
    if(expected.has(name)||!/^E\d{4}\s+-\s+.+\.md$/i.test(name)) continue;
    const target=path.resolve(rootPath,name);
    if(path.dirname(target)!==rootPath) throw new Error(`Refusing unsafe evidence-summary cleanup target: ${name}`);
    await unlink(target);
    removed.push(name);
  }
  return removed;
}
const signalRules=[
  {id:'false-sworn-statement',pattern:/\b(perjur|false sworn|false statement|verified denial|under penalty of perjury)\b/i},
  {id:'order-violation',pattern:/\b(violat(?:e|ed|ion)|noncompliance|failed to comply|disobey)\b.{0,80}\b(order|restraining|custody|visitation)\b/i},
  {id:'coercion-or-threat',pattern:/\b(coerc|threat|extort|intimidat|harass)\w*\b/i},
  {id:'financial-misrepresentation',pattern:/\b(hidden income|false income|income and expense|financial fraud|asset conceal)\b/i},
  {id:'evidence-integrity',pattern:/\b(fabricat|altered|tamper|metadata|authenticat|original recording)\w*\b/i},
  {id:'violence-or-abuse',pattern:/\b(assault|battery|domestic violence|abuse|hit|struck|injur)\w*\b/i}
];
const crimeContextPattern=/\b(perjur\w*|false sworn|false statement|verified denial|violat\w*|noncompliance|failed to comply|disobey\w*|coerc\w*|threat\w*|extort\w*|intimidat\w*|harass\w*|hidden income|false income|financial fraud|asset conceal\w*|fabricat\w*|altered|tamper\w*|assault\w*|battery|domestic violence|abuse|hit|struck|injur\w*)\b/gi;
const petitionerTerms=/\b(petitioner|teruko(?: nozaki)? miller|teruko nozaki|f1)\b/i;
const respondentTerms=/\b(respondent|brandon(?: charles)? miller|f2)\b/i;
const selfImpeachingPattern=/\bI\s+(?:admit(?:ted)?|lied|made (?:a )?false|violated|threatened|hit|struck|refused to comply|failed to comply)\b/i;

function sourceSide(source=''){
  const value=String(source).toUpperCase();
  if(value.includes('TERUKO')) return 'petitioner';
  if(value.includes('BRANDON')) return 'respondent';
  return '';
}

function findingType(signals=[]){
  const priority=[
    ['false-sworn-statement','apparent-false-statement'],
    ['order-violation','apparent-order-violation'],
    ['financial-misrepresentation','financial-misrepresentation'],
    ['evidence-integrity','evidence-integrity'],
    ['coercion-or-threat','coercion-or-threat'],
    ['violence-or-abuse','violence-or-abuse']
  ];
  return priority.find(([signal])=>signals.includes(signal))?.[1]||'';
}

function inferProvisionalReview({markdown='',signals=[],filingParty=''}){
  if(!signals.length) return {status:'not-reviewed',classification:'unassigned',attributes:{findingType:'',citation:'',relatedRecords:'',attributionBasis:'No automated conduct signal.',confidence:'unassigned',attributionSource:'automated-provisional'},notes:'',updatedAt:null};
  const source=sourceSide(filingParty);
  if(source&&selfImpeachingPattern.test(markdown)){
    return {status:'potential-evidence',classification:source,attributes:{findingType:'self-impeaching-statement',citation:'',relatedRecords:'',attributionBasis:'Narrow first-person admission pattern detected; verify speaker and context against the original.',confidence:'medium',attributionSource:'automated-provisional'},notes:'',updatedAt:null};
  }
  let petitionerScore=0; let respondentScore=0;
  for(const match of markdown.matchAll(crimeContextPattern)){
    const context=markdown.slice(Math.max(0,match.index-220),Math.min(markdown.length,match.index+match[0].length+220));
    if(petitionerTerms.test(context)) petitionerScore++;
    if(respondentTerms.test(context)) respondentScore++;
  }
  let classification='unassigned'; let confidence='unassigned'; let basis='Actor references near detected conduct were ambiguous.';
  if(petitionerScore>=2&&petitionerScore>=respondentScore+2){classification='petitioner';confidence='medium';basis=`Petitioner/name references appeared near ${petitionerScore} detected conduct contexts versus ${respondentScore} Respondent contexts.`;}
  else if(respondentScore>=2&&respondentScore>=petitionerScore+2){classification='respondent';confidence='medium';basis=`Respondent/name references appeared near ${respondentScore} detected conduct contexts versus ${petitionerScore} Petitioner contexts.`;}
  else if(source){classification=source==='petitioner'?'respondent':'petitioner';confidence='low';basis=`Low-confidence fallback: a ${source}-authored filing contains accusation signals; the alleged actor is provisionally set to the opposing side. Verify before reliance.`;}
  return {status:'potential-evidence',classification,attributes:{findingType: findingType(signals),citation:'',relatedRecords:'',attributionBasis:basis,confidence,attributionSource:'automated-provisional'},notes:'',updatedAt:null};
}
const result=await indexPairedRecord({
  rawRoot:path.join(source,'Filing by Filing','PDF'),markdownRoot:path.join(source,'Filing by Filing','MD'),evidenceOutputRoot:evidenceRoot,
  signalRules,evidenceBoundary:/^#{2,6}\s+((?:(?:Petitioner(?:'s)?|Respondent(?:'s)?)\s+)?(?:Exhibit|Attachment)\b[^\r\n]*)/gim,
  buildEvidenceMarkdown:item=>`# ${item.title}\n\n- Evidence ID: ${item.id}\n- Parent filing: ${item.parentRaw}\n- Related Markdown: ${item.markdown}\n- Source page: ${item.sourcePage??'not resolved from Markdown'}\n- Source page status: ${item.sourcePageStatus}\n- Source page method: ${item.sourcePageMethod??'none'}\n- Source page marker: ${item.sourcePageMarker??'none'}\n- Source page candidates: ${item.sourcePageCandidates.join(', ')||'none'}\n- Parent SHA-256: ${item.parentSha256}\n- Extraction: Markdown exhibit boundary with conservative rendered-page matching; compare against the complete parent PDF before reliance.\n\n${item.body}\n`
});
const prunedLegacyEvidenceSummaries=await pruneLegacyEvidenceSummaries(evidenceRoot,result.evidence);
await mkdir(documentPdfRoot,{recursive:true});
await mkdir(documentMarkdownRoot,{recursive:true});
const completeRecords=result.records.filter(item=>item.markdown);
const ignoredUnpaired=result.records.filter(item=>!item.markdown);
const filings=[];
for(const item of completeRecords){
  const parsed=parseStructuredRecordName(item.name);
  const markdownText=await readFile(path.join(source,'Filing by Filing','MD',item.markdown),'utf8');
  const coupledPdfName=`${item.id}.pdf`;
  const coupledMarkdownName=`${item.id}.md`;
  await coupleLocalFile(path.join(source,'Filing by Filing','PDF',item.name),path.join(documentPdfRoot,coupledPdfName));
  await coupleLocalFile(path.join(source,'Filing by Filing','MD',item.markdown),path.join(documentMarkdownRoot,coupledMarkdownName));
  filings.push({
    ...item,
    filingDate:parsed?.isoDate||null,
    filingParty:parsed?.source||'Source not parsed',
    title:parsed?.title||item.name.replace(/\.[^.]+$/,''),
    pdfPath:`Documents/PDF/${coupledPdfName}`,
    markdownPath:`Documents/MD/${coupledMarkdownName}`,
    initialReview:inferProvisionalReview({markdown:markdownText,signals:item.signals,filingParty:parsed?.source||''}),
    exhibits:item.evidence
  });
}
const prunedDuplicateCouplings=[
  ...await pruneVerifiedDuplicateCouplings(documentPdfRoot,filings,{sourceKey:'name',pathKey:'pdfPath',extension:'.pdf'}),
  ...await pruneVerifiedDuplicateCouplings(documentMarkdownRoot,filings,{sourceKey:'markdown',pathKey:'markdownPath',extension:'.md'})
];
for(const filing of filings){
  const related=filings
    .filter(candidate=>candidate.id!==filing.id&&candidate.initialReview.classification===filing.initialReview.classification&&candidate.initialReview.classification!=='unassigned')
    .map(candidate=>({id:candidate.id,shared:candidate.signals.filter(signal=>filing.signals.includes(signal)).length}))
    .filter(candidate=>candidate.shared>0)
    .sort((left,right)=>right.shared-left.shared||left.id.localeCompare(right.id))
    .slice(0,3)
    .map(candidate=>candidate.id);
  filing.initialReview.attributes.relatedRecords=[...filing.exhibits,...related].join(', ');
}
const filingByName=new Map(filings.map(item=>[item.name,item]));
const exhibits=result.evidence.map(({parentRaw,parentSha256,body,...item})=>({
  ...item,
  parentFiling:parentRaw,
  parentFilingId:filingByName.get(parentRaw)?.id||null,
  parentPdfPath:filingByName.get(parentRaw)?.pdfPath||null,
  parentMarkdownPath:filingByName.get(parentRaw)?.markdownPath||null
}));
const evidencePageCounts={
  resolved:exhibits.filter(item=>item.sourcePageStatus==='resolved').length,
  ambiguous:exhibits.filter(item=>item.sourcePageStatus==='ambiguous').length,
  unresolved:exhibits.filter(item=>item.sourcePageStatus==='unresolved').length
};
const documentCounts={
  pdf:(await readdir(documentPdfRoot)).filter(name=>/^F\d{4}\.pdf$/i.test(name)).length,
  markdown:(await readdir(documentMarkdownRoot)).filter(name=>/^F\d{4}\.md$/i.test(name)).length
};
const counts={sourceFilings:result.records.length,filings:filings.length,markdown:result.markdownNames.length,paired:filings.length,ignoredUnpaired:ignoredUnpaired.length,orphanMarkdown:result.orphanMarkdown.length,exhibits:exhibits.length,evidencePageResolved:evidencePageCounts.resolved,evidencePageAmbiguous:evidencePageCounts.ambiguous,evidencePageUnresolved:evidencePageCounts.unresolved,documentPdfs:documentCounts.pdf,documentMarkdown:documentCounts.markdown};
const dataset={schemaVersion:2,caseId:'24FL001068',relatedCaseId:'24DV000567',generatedAt:new Date().toISOString(),sourceLabel:'Coupled local test case',counts,filings,exhibits,orphanMarkdown:result.orphanMarkdown};
await writeFile(path.join(outputRoot,'case-index.json'),JSON.stringify(dataset,null,2),'utf8');
await mkdir(importRoot,{recursive:true});
await writeFile(path.join(importRoot,'import-audit.json'),JSON.stringify({
  schemaVersion:1,
  caseId:'24FL001068',
  generatedAt:dataset.generatedAt,
  sourceLabel:dataset.sourceLabel,
  activePairs:filings.length,
  ignoredUnpaired:ignoredUnpaired.map(item=>({id:item.id,name:item.name,status:item.status,sha256:item.sha256,size:item.size,reason:'No paired Markdown source; excluded from active filing review.'})),
  prunedDuplicateCouplings,
  prunedLegacyEvidenceSummaries,
  evidencePageCounts,
  documentCounts
},null,2),'utf8');
await mkdir(path.join(outputRoot,'Reports','Police'),{recursive:true});
await writeFile(path.join(outputRoot,'Reports','Police','README.md'),'# Police reports\n\nGenerated police/DA work product belongs here. It is not evidence.\n','utf8');
console.log(JSON.stringify(counts));
await import('./build_investigative_analysis.mjs');
