import {
  STATUS_LABELS,
  fmtBytes,
  fmtDate,
  isHumanReviewed,
  loadInvestigatorCase
} from './InvestigatorCaseData.js';
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
  const alert=document.createElement('p'); alert.className='error'; alert.setAttribute('role','alert');
  alert.textContent=`Unable to load the Investigator case analysis: ${error.message}. Rebuild the app-owned case dataset and analysis, then reload.`;
  $('#filingList')?.replaceChildren(alert); $('#integrityBadge')?.replaceChildren(alert.cloneNode(true)); $('#appStatus').textContent=alert.textContent; throw error;
}

const validRecordIds=new Set([...data.filings.map(item=>item.id),...data.exhibits.map(item=>item.id)]);
let filter='all'; let actorFilter='';

function findingsFor(recordId){return prioritizeFindings(analysis.findingsByRecord.get(recordId)||[]);}
function flaggedItems(){return data.filings.filter(item=>findingsFor(item.id).length);}
function reviewedItems(){return data.filings.filter(isHumanReviewed);}
function sideClass(value=''){
  if(String(value).startsWith('petitioner')) return 'petitioner';
  if(value==='respondent') return 'respondent';
  return 'unassigned';
}

function updateDashboard(){
  const flagged=flaggedItems(); const reviewed=reviewedItems(); const unreviewed=data.filings.length-reviewed.length;
  const totalFilings=data.filings.length;
  const machineScanned=data.filings.filter(item=>item.initialReview?.attributes?.attributionSource==='automated-provisional').length;
  const petitioner=analysis.findings.filter(item=>sideClass(item.allegedSide||item.allegedActor)==='petitioner').length;
  const respondent=analysis.findings.filter(item=>sideClass(item.allegedSide||item.allegedActor)==='respondent').length;
  const unassigned=analysis.findings.length-petitioner-respondent;
  const reviewedPercent=totalFilings?Math.round(reviewed.length/totalFilings*100):0;
  $('#metrics').innerHTML=`<article><span>Imported / machine-scanned</span><strong>${machineScanned} / ${totalFilings}</strong><small>Complete PDF and Markdown pairs; not human-reviewed</small></article><article><span>Source-cited leads</span><strong>${analysis.findings.length.toLocaleString()}</strong><small>Automated and curated leads; each still requires source review</small></article><article><span>Cross-record comparisons</span><strong>${analysis.crossReferences.length}</strong><small>From ${analysis.coverage.crossRecordPairsScreened.toLocaleString()} automated topic screens</small></article><article><span>Human-reviewed against source</span><strong>${reviewed.length} / ${totalFilings}</strong><small>${reviewedPercent}% with a saved human source review</small></article>`;
  $('#allCount').textContent=data.counts.filings; $('#flaggedCount').textContent=flagged.length; $('#exhibitFilingCount').textContent=data.filings.filter(item=>item.exhibits.length).length; $('#unreviewedCount').textContent=unreviewed;
  $('#evidenceCount').textContent=data.counts.exhibits; $('#coverage').textContent=`${machineScanned} / ${totalFilings}`; $('#reviewedPercent').textContent=`${reviewed.length} / ${totalFilings}`;
  $('#petitionerActivityCount').textContent=petitioner; $('#respondentActivityCount').textContent=respondent; $('#unassignedActivityCount').textContent=unassigned; $('#connectionCount').textContent=analysis.crossReferences.length;
  $('#integrityBadge').innerHTML=`<span class="pulse"></span><div><strong>Case files imported; human review tracked separately</strong><small>${machineScanned} / ${totalFilings} machine-scanned; ${reviewed.length} / ${totalFilings} human-reviewed; gap files excluded</small></div>`;
}

function visible(item){
  const query=$('#search').value.trim().toLocaleLowerCase(); const leads=findingsFor(item.id);
  const haystack=[item.name,item.markdown,item.filingDate,item.filingParty,item.title,item.status,...item.exhibits,...leads.flatMap(finding=>[finding.label,finding.allegedActorLabel,finding.sources[0]?.excerpt])].join(' ').toLocaleLowerCase();
  const matches=!query||haystack.includes(query);
  const matchesQueue=filter==='all'||filter==='flagged'&&leads.length||filter==='exhibits'&&item.exhibits.length||filter==='unreviewed'&&!item.updatedAt;
  const matchesActor=!actorFilter||leads.some(finding=>sideClass(finding.allegedSide||finding.allegedActor)===actorFilter);
  return matches&&matchesQueue&&matchesActor;
}

function miniFinding(finding){
  const source=finding.sources[0]||{}; const side=sideClass(finding.allegedSide||finding.allegedActor);
  return `<button type="button" class="mini-finding ${side}" data-analysis-id="${escape(finding.id)}"><strong>${escape(finding.label)}</strong><span>Alleged actor: ${escape(finding.allegedActorLabel)}</span><small>${source.page?`PDF p. ${source.page}`:`MD ${source.lineStart||'?'}–${source.lineEnd||'?'}`} · explanation and evidence</small></button>`;
}

function render(){
  const query=$('#search').value.trim().toLocaleLowerCase();
  const items=data.filings.filter(visible);
  $('#filingList').innerHTML=items.map(item=>{
    const leads=findingsFor(item.id); const sides=new Set(leads.map(finding=>sideClass(finding.allegedSide||finding.allegedActor))); const actor=sides.size===1?[...sides][0]:'unassigned';
    const queryMatches=query?leads.filter(finding=>[finding.label,finding.allegedActorLabel,finding.assessment,...finding.sources.map(source=>source.excerpt)].join(' ').toLocaleLowerCase().includes(query)):[];
    const displayedLeads=queryMatches.length?queryMatches:leads; const leadButtons=displayedLeads.slice(0,8).map(miniFinding).join('');
    return `<article class="filing ${leads.length?`activity-${actor}`:''}"><div class="filing-identity"><span class="file-sequence">${item.id}</span><time class="file-date" datetime="${escape(item.filingDate)}">${escape(fmtDate(item.filingDate))}</time><strong class="file-party">${escape(item.filingParty)}</strong></div><div class="file-content"><button class="file-main file-open" type="button" data-open-filing="${item.id}" aria-label="Open ${escape(item.title)}, filed ${escape(fmtDate(item.filingDate))} by ${escape(item.filingParty)}"><span class="file-title" title="${escape(item.name)}">${escape(item.title)}</span><span class="file-pair">Open original PDF, filing text, details, and review</span><span class="chips">${item.exhibits.length?`<span>${item.exhibits.length} exhibit${item.exhibits.length===1?'':'s'}</span>`:''}</span></button><div class="filing-analysis">${leadButtons}${displayedLeads.length>8?`<a href="./apps/investigator/conduct.html">${displayedLeads.length-8} more matching leads</a>`:''}${!displayedLeads.length?'<span class="no-local-lead">No local allegation found; cross-record relevance may still exist.</span>':''}</div></div><div class="file-meta"><span class="review-state ${escape(item.status)}">${escape(STATUS_LABELS[item.status]||item.status)}</span><small>${fmtBytes(item.size)}</small><code title="SHA-256">${item.sha256.slice(0,10)}…</code></div></article>`;
  }).join('')||'<p class="empty">No filings match this review filter.</p>';
}

async function openFiling(recordId){
  const item=data.filings.find(filing=>filing.id===recordId); if(!item) return;
  await openInvestigatorRecord({modal:$('#filingDialog'),template:$('#filingDialogContent'),record:item,reviewStore,validRecordIds,onSaved:()=>{$('#appStatus').textContent=`Review saved for ${item.title}.`; updateDashboard(); render();}});
}
async function openFinding(id){
  const item=analysis.itemById.get(id); if(!item) return;
  await openInvestigatorFinding({modal:$('#findingDialog'),template:$('#findingDialogContent'),item,reviewStore:analysisReviewStore,onSaved:()=>{$('#appStatus').textContent=`Decision saved for ${item.label}.`; render();}});
}

document.querySelectorAll('.filter').forEach(button=>button.addEventListener('click',()=>{document.querySelector('.filter.active')?.classList.remove('active'); button.classList.add('active'); filter=button.dataset.filter; render();}));
document.querySelectorAll('[data-actor-filter]').forEach(button=>button.addEventListener('click',()=>{const requested=button.dataset.actorFilter; actorFilter=actorFilter===requested?'':requested; document.querySelectorAll('[data-actor-filter]').forEach(candidate=>candidate.classList.toggle('active',candidate.dataset.actorFilter===actorFilter)); render();}));
$('#filingList').addEventListener('click',event=>{
  const findingTrigger=event.target.closest('[data-analysis-id]'); if(findingTrigger){openFinding(findingTrigger.dataset.analysisId).catch(error=>{$('#appStatus').textContent=`Unable to open lead: ${error.message}`;}); return;}
  const trigger=event.target.closest('[data-open-filing]'); if(trigger) openFiling(trigger.dataset.openFiling).catch(error=>{$('#appStatus').textContent=`Unable to open filing: ${error.message}`; console.error(error);});
});
$('#search').addEventListener('input',render); updateDashboard(); render();
