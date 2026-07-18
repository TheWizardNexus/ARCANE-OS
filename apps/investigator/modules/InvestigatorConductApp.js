import {loadInvestigatorAnalysis,prioritizeFindings} from './InvestigatorAnalysisData.js?v=2';
import {openInvestigatorFinding} from './InvestigatorFindingDialog.js';

const $=selector=>document.querySelector(selector);
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let analysis; let analysisReviewStore;
try{
  ({analysis,analysisReviewStore}=await loadInvestigatorAnalysis());
}catch(error){
  const alert=document.createElement('p'); alert.className='error'; alert.setAttribute('role','alert'); alert.textContent=`Unable to load the investigative analysis: ${error.message}. Run the app analysis builder and reload.`;
  $('#conductList')?.replaceChildren(alert); $('#appStatus').textContent=alert.textContent; throw error;
}

let sideFilter='';

function sideClass(value=''){
  if(String(value).startsWith('petitioner')) return 'petitioner';
  if(value==='respondent') return 'respondent';
  return 'unassigned';
}

function findingVisible(finding,query,category){
  const side=sideClass(finding.allegedSide||finding.allegedActor);
  if(sideFilter&&side!==sideFilter) return false;
  if(category&&finding.category!==category) return false;
  if(!query) return true;
  return [finding.label,finding.category,finding.kind,finding.allegedActorLabel,finding.assessment,...finding.sources.map(source=>`${source.filename} ${source.excerpt}`)].join(' ').toLocaleLowerCase().includes(query);
}

function findingButton(finding){
  const side=sideClass(finding.allegedSide||finding.allegedActor);
  const source=finding.sources[0]||{};
  const review=finding.review||{};
  return `<button class="conduct-chip ${side}" type="button" data-analysis-id="${escape(finding.id)}"><span class="conduct-kind">${escape(finding.kind.replaceAll('-',' '))}</span><strong>${escape(finding.label)}</strong><span>Alleged actor: ${escape(finding.allegedActorLabel)}</span><small>${source.page?`PDF p. ${source.page} · `:''}MD ${source.lineStart||'?'}–${source.lineEnd||'?'} · ${escape(review.status||finding.status)}</small></button>`;
}

function renderFilings(){
  const query=$('#conductSearch').value.trim().toLocaleLowerCase();
  const category=$('#categoryFilter').value;
  let visibleFindings=0;
  const rows=[];
  for(const filing of analysis.filings){
    const all=prioritizeFindings(analysis.findingsByRecord.get(filing.recordId)||[]);
    const leads=all.filter(finding=>findingVisible(finding,query,category));
    const filingMatches=!query||[filing.recordId,filing.filedDate,filing.filingParty,filing.title,filing.filename].join(' ').toLocaleLowerCase().includes(query);
    if((query||category||sideFilter)&&!leads.length&&!filingMatches) continue;
    if((category||sideFilter)&&!leads.length) continue;
    visibleFindings+=leads.length;
    rows.push(`<article class="conduct-record"><header><div><span class="file-sequence">${escape(filing.recordId)}</span><time datetime="${escape(filing.filedDate)}">${escape(filing.filedDate)}</time><strong>${escape(filing.filingParty)}</strong></div><div><h3>${escape(filing.title)}</h3><p>${escape(filing.filename)}</p></div><span class="lead-count">${all.length} lead${all.length===1?'':'s'}</span></header><div class="conduct-findings">${leads.length?leads.map(findingButton).join(''):`<p class="no-local-lead">${all.length?'No lead in this filing matches the active filters.':'No local allegation found. This does not mean “no crime”; cross-record relevance and human review may still add context.'}</p>`}</div></article>`);
  }
  $('#conductList').innerHTML=rows.join('')||'<p class="empty">No filing or lead matches these filters.</p>';
  $('#conductSummary').textContent=`Showing ${rows.length} filings and ${visibleFindings} source-cited leads.`;
}

function renderCrossReferences(){
  $('#crossReferenceList').innerHTML=analysis.crossReferences.map(item=>{
    const side=sideClass(item.allegedActor);
    return `<button type="button" class="cross-card ${side}" data-analysis-id="${escape(item.id)}"><span class="cross-dates"><time datetime="${escape(item.statementDate||'')}">${escape(item.statementDate||'Date unresolved')}</time><b aria-hidden="true">→</b><time datetime="${escape(item.comparisonDate||'')}">${escape(item.comparisonDate||'Comparison date unresolved')}</time></span><strong>${escape(item.label)}</strong><span>${escape(item.summary)}</span><small>Actor under review: ${escape(item.allegedActorLabel)} · ${item.sources.length} cited sources · ${escape(item.confidence)}</small></button>`;
  }).join('');
}

async function openItem(id){
  const item=analysis.itemById.get(id); if(!item) return;
  await openInvestigatorFinding({modal:$('#findingDialog'),template:$('#findingDialogContent'),item,reviewStore:analysisReviewStore,onSaved:()=>{renderFilings(); $('#appStatus').textContent=`Decision saved for ${item.label||item.title}.`;}});
}

for(const [id,label] of Object.entries({
  'possible-false-statement':'Possible false statement','self-impeachment':'Self-impeachment / inconsistency','admission':'Admission','possible-order-noncompliance':'Order noncompliance','possible-threat-coercion':'Threat / coercion','possible-evidence-integrity':'Evidence integrity','possible-financial-misrepresentation':'Financial / property','alleged-violence-abuse':'Violence / abuse','possible-false-official-report':'False official report'
})){
  const option=document.createElement('option'); option.value=id; option.textContent=`${label} (${analysis.categoryCounts[id]||0})`; $('#categoryFilter').append(option);
}

document.addEventListener('click',event=>{
  const trigger=event.target.closest('[data-analysis-id]'); if(!trigger) return;
  openItem(trigger.dataset.analysisId).catch(error=>{$('#appStatus').textContent=`Unable to open analysis: ${error.message}`; console.error(error);});
});
document.querySelectorAll('[data-side-filter]').forEach(button=>button.addEventListener('click',()=>{
  sideFilter=sideFilter===button.dataset.sideFilter?'':button.dataset.sideFilter;
  document.querySelectorAll('[data-side-filter]').forEach(candidate=>candidate.classList.toggle('active',candidate.dataset.sideFilter===sideFilter)); renderFilings();
}));
$('#conductSearch').addEventListener('input',renderFilings); $('#categoryFilter').addEventListener('change',renderFilings);
$('#clearConductFilters').addEventListener('click',()=>{sideFilter=''; $('#conductSearch').value=''; $('#categoryFilter').value=''; document.querySelectorAll('[data-side-filter]').forEach(button=>button.classList.remove('active')); renderFilings();});

const petitioner=analysis.findings.filter(item=>sideClass(item.allegedSide||item.allegedActor)==='petitioner').length;
const respondent=analysis.findings.filter(item=>sideClass(item.allegedSide||item.allegedActor)==='respondent').length;
$('#petitionerFindingCount').textContent=petitioner; $('#respondentFindingCount').textContent=respondent; $('#otherFindingCount').textContent=analysis.findings.length-petitioner-respondent;
$('#coveragePanel').innerHTML=`<strong>${analysis.coverage.filingsRepresented}/${analysis.coverage.filingsScanned}</strong><span>filings represented</span><small>${analysis.coverage.crossRecordPairsScreened.toLocaleString()} record pairs topic-screened · ${analysis.crossReferences.length} source-promoted comparisons</small>`;
renderCrossReferences(); renderFilings();
