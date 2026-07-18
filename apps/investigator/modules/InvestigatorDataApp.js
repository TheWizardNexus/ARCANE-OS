import {STATUS_LABELS,fmtBytes,fmtDate,loadInvestigatorCase} from './InvestigatorCaseData.js';
import {loadInvestigatorAnalysis,prioritizeFindings} from './InvestigatorAnalysisData.js?v=2';
import {openInvestigatorFinding} from './InvestigatorFindingDialog.js';
import {openInvestigatorRecord} from './InvestigatorRecordDialog.js';

const $=selector=>document.querySelector(selector);
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let data; let reviewStore; let analysis; let analysisReviewStore;
try{
  const [caseResult,analysisResult]=await Promise.all([loadInvestigatorCase(),loadInvestigatorAnalysis()]);
  ({data,reviewStore}=caseResult); ({analysis,analysisReviewStore}=analysisResult);
}catch(error){
  const alert=document.createElement('p'); alert.className='error'; alert.setAttribute('role','alert'); alert.textContent=`Unable to load the Investigator case data: ${error.message}. Rebuild the app-owned case dataset and analysis, then reload.`;
  $('#libraryList')?.replaceChildren(alert); $('#librarySummary').textContent='Case data unavailable.'; $('#appStatus').textContent=alert.textContent; throw error;
}
const validRecordIds=new Set([...data.filings.map(item=>item.id),...data.exhibits.map(item=>item.id)]);
const parentByName=new Map(data.filings.map(item=>[item.name,item]));
let view='filings';

function sideClass(value=''){return String(value).startsWith('petitioner')?'petitioner':value==='respondent'?'respondent':'unassigned';}
function recordSearchText(record){
  if(view==='filings'){
    const leads=analysis.findingsByRecord.get(record.id)||[];
    return [record.id,record.filingDate,record.filingParty,record.title,record.name,record.markdown,record.status,...record.exhibits,...leads.flatMap(finding=>[finding.label,finding.allegedActorLabel,finding.sources[0]?.excerpt])].join(' ');
  }
  return [record.id,record.title,record.parentFilingId,record.parentFiling,record.parentPdfPath,record.markdown,record.sourcePage,record.sourcePageStatus,...(record.sourcePageCandidates||[]),record.status,record.classification].join(' ');
}
function miniFinding(finding){const source=finding.sources[0]||{}; return `<button type="button" class="mini-finding ${sideClass(finding.allegedSide||finding.allegedActor)}" data-analysis-id="${escape(finding.id)}"><strong>${escape(finding.label)}</strong><span>${escape(finding.allegedActorLabel)}</span><small>${source.page?`PDF p. ${source.page}`:`MD ${source.lineStart||'?'}–${source.lineEnd||'?'}`} · explanation and evidence</small></button>`;}
function filingCard(item){
  const leads=prioritizeFindings(analysis.findingsByRecord.get(item.id)||[]); const sides=new Set(leads.map(finding=>sideClass(finding.allegedSide||finding.allegedActor))); const actor=sides.size===1?[...sides][0]:'unassigned';
  return `<article class="library-record ${leads.length?`activity-${actor}`:''}"><div class="record-id"><strong>${item.id}</strong><time datetime="${escape(item.filingDate)}">${escape(fmtDate(item.filingDate))}</time></div><div class="record-content"><button type="button" class="record-open" data-open-record="${item.id}" data-record-type="filing"><span class="record-title">${escape(item.title)}</span><span class="record-context">Filed by ${escape(item.filingParty)} · PDF + Markdown · ${fmtBytes(item.size)}</span><span class="chips">${item.exhibits.length?`<span>${item.exhibits.length} separated exhibit${item.exhibits.length===1?'':'s'}</span>`:''}</span></button><div class="record-findings">${leads.slice(0,5).map(miniFinding).join('')}${leads.length>5?`<a href="./apps/investigator/conduct.html">${leads.length-5} more leads</a>`:''}${!leads.length?'<span class="no-local-lead">No local allegation found; cross-record relevance may still exist.</span>':''}</div></div><span class="review-state ${escape(item.status)}">${escape(STATUS_LABELS[item.status]||item.status)}</span></article>`;
}
function evidencePageContext(item){
  if(item.sourcePageStatus==='resolved'&&item.sourcePage) return `Parent PDF p. ${item.sourcePage} · mapped from ${item.sourcePageMethod==='containing-rendered-page'?'the containing rendered page':'a unique exhibit label'}`;
  if(item.sourcePageStatus==='ambiguous') return `Parent PDF available · candidate pages ${(item.sourcePageCandidates||[]).join(', ')} need human review`;
  return 'Parent PDF available · exhibit start page not reliably resolved';
}
function evidenceCard(item){const parent=parentByName.get(item.parentFiling); return `<article class="library-record evidence-record"><div class="record-id"><strong>${item.id}</strong><span>${escape(item.parentFilingId||parent?.id||'Parent unresolved')}</span></div><button type="button" class="record-open" data-open-record="${item.id}" data-record-type="evidence"><span class="record-title">${escape(item.title)}</span><span class="record-context">Separated from ${escape(parent?.title||item.parentFiling)} · ${escape(evidencePageContext(item))}</span></button><span class="review-state ${escape(item.status)}">${escape(STATUS_LABELS[item.status]||item.status)}</span></article>`;}
function render(){const records=view==='filings'?data.filings:data.exhibits; const query=$('#librarySearch').value.trim().toLocaleLowerCase(); const visible=records.filter(record=>!query||recordSearchText(record).toLocaleLowerCase().includes(query)); $('#librarySummary').textContent=`Showing ${visible.length} of ${records.length} ${view}.`; $('#libraryList').innerHTML=visible.map(record=>view==='filings'?filingCard(record):evidenceCard(record)).join('')||'<p class="empty">No records match this search.</p>';}
async function openRecord(recordId,recordType){const records=recordType==='evidence'?data.exhibits:data.filings; const record=records.find(item=>item.id===recordId); if(!record) return; await openInvestigatorRecord({modal:$('#recordDialog'),template:$('#recordDialogContent'),record,recordType,reviewStore,validRecordIds,onSaved:()=>{$('#appStatus').textContent=`Review saved for ${record.title}.`; render();}});}
async function openFinding(id){const item=analysis.itemById.get(id); if(!item) return; await openInvestigatorFinding({modal:$('#findingDialog'),template:$('#findingDialogContent'),item,reviewStore:analysisReviewStore,onSaved:()=>{$('#appStatus').textContent=`Decision saved for ${item.label}.`; render();}});}

document.querySelectorAll('[data-library-view]').forEach(button=>button.addEventListener('click',()=>{view=button.dataset.libraryView; document.querySelectorAll('[data-library-view]').forEach(tab=>tab.setAttribute('aria-pressed',String(tab===button))); render();}));
$('#librarySearch').addEventListener('input',render);
$('#libraryList').addEventListener('click',event=>{const findingTrigger=event.target.closest('[data-analysis-id]'); if(findingTrigger){openFinding(findingTrigger.dataset.analysisId).catch(error=>{$('#appStatus').textContent=`Unable to open lead: ${error.message}`;}); return;} const trigger=event.target.closest('[data-open-record]'); if(!trigger) return; openRecord(trigger.dataset.openRecord,trigger.dataset.recordType).catch(error=>{$('#appStatus').textContent=`Unable to open record: ${error.message}`; console.error(error);});});
$('#filingTotal').textContent=data.filings.length; $('#evidenceTotal').textContent=data.exhibits.length; $('#filingTabCount').textContent=data.filings.length; $('#evidenceTabCount').textContent=data.exhibits.length; render();
