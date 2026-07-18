import {assetUrl,fmtDate} from './InvestigatorCaseData.js';
import {openInvestigatorFinding} from './InvestigatorFindingDialog.js';
import {waitForMethod} from './InvestigatorRecordDialog.js';
import {loadInvestigatorReferral} from './InvestigatorReferralData.js?v=2';

const $=selector=>document.querySelector(selector);
const text=(selector,value)=>{$(selector).textContent=String(value??'');};
const statusLabel=value=>String(value||'').replaceAll('-',' ');
let referral; let candidates; let candidateById; let sourceById; let requestById; let motiveByCandidateId; let reviewStore; let selectedId='';

function node(tag,{className='',textContent='',attrs={}}={}){
  const element=document.createElement(tag);
  if(className) element.className=className;
  element.textContent=String(textContent??'');
  for(const [key,value] of Object.entries(attrs)) element.setAttribute(key,String(value));
  return element;
}

function appendList(target,items,emptyLabel){
  const list=$(target); list.replaceChildren();
  for(const item of items) list.append(node('li',{textContent:item}));
  if(!items.length) list.append(node('li',{textContent:emptyLabel}));
}

function sourceCitation(source){
  return [source.recordId,source.page?`PDF p. ${source.page}`:'',source.lineStart?`MD ${source.lineStart}–${source.lineEnd}`:''].filter(Boolean).join(' · ');
}

function sourceButton(source,candidateId){
  const citation=sourceCitation(source);
  const button=node('button',{className:`source-card ${source.role==='contrary'||source.role==='limitation'?'contrary':'support'}`,attrs:{type:'button','data-open-candidate':candidateId,'data-source-id':source.id,'aria-label':`Open ${citation} in the full source analysis`}});
  button.append(node('strong',{textContent:source.filename||source.title||source.recordId}),node('span',{textContent:citation}),node('p',{textContent:source.excerpt||'No excerpt available.'}));
  if(source.note) button.append(node('small',{textContent:source.note}));
  return button;
}

function renderCandidateRail(){
  const list=$('#candidateList'); list.replaceChildren();
  for(const candidate of candidates){
    const button=node('button',{className:'candidate-button',attrs:{type:'button','data-candidate-id':candidate.id,'aria-pressed':String(candidate.id===selectedId)}});
    button.append(node('span',{textContent:`#${candidate.rank} · ${candidate.id}`}),node('strong',{textContent:candidate.title}),node('em',{textContent:candidate.offenseTheory}),node('small',{textContent:candidate.readiness}));
    list.append(button);
  }
}

function renderElements(candidate){
  const body=$('#elementRows'); body.replaceChildren();
  for(const item of candidate.elements){
    const row=document.createElement('tr');
    const status=node('td'); status.append(node('span',{className:`element-status ${item.status}`,textContent:statusLabel(item.status)}));
    const proposition=node('th',{textContent:item.proposition,attrs:{scope:'row'}});
    const fact=node('td',{textContent:item.fact});
    const sources=node('td',{className:'matrix-sources'});
    for(const id of item.sourceIds){
      const source=sourceById.get(id); if(!source) continue;
      sources.append(node('button',{textContent:sourceCitation(source),attrs:{type:'button','data-open-candidate':candidate.id,'data-source-id':source.id}}));
    }
    if(!sources.childElementCount) sources.append(node('span',{textContent:'No cited proof'}));
    const gap=node('td',{textContent:item.gap||'No additional gap recorded.'});
    row.append(status,proposition,fact,sources,gap); body.append(row);
  }
}

function renderAuthorities(candidate){
  const list=$('#candidateAuthorities'); list.replaceChildren();
  for(const authority of candidate.authority||[]){
    const item=node('li');
    const link=node('a',{textContent:authority.label||'Official legal authority',attrs:{href:authority.url,target:'_blank',rel:'noreferrer'}});
    item.append(link,node('small',{textContent:authority.asOf?`Screened ${fmtDate(authority.asOf)}`:'Screening date not recorded'}));
    list.append(item);
  }
  if(!list.childElementCount) list.append(node('li',{textContent:'No official screening authority has been assigned.'}));
}

function renderMotive(candidate){
  const motive=motiveByCandidateId.get(candidate.id);
  if(!motive){
    text('#candidateMotive','No motive hypothesis has been assigned. Motive is not required to identify every investigative lead.');
    text('#candidateMotiveContrary','No alternative explanation has been recorded.');
    return;
  }
  text('#candidateMotive',`Hypothesis only. Trigger: ${motive.trigger}. Possible incentive: ${motive.incentive}. Possible benefit: ${motive.anticipatedBenefit}.`);
  text('#candidateMotiveContrary',`Strongest alternative: ${motive.contrary}`);
}

function renderCandidateChronology(candidate){
  const events=referral.chronology.filter(event=>event.candidateIds.includes(candidate.id));
  text('#candidateChronologySummary',`${events.length} linked event${events.length===1?'':'s'}. Unknown incident dates remain unknown; filing dates are not substituted.`);
  const body=$('#candidateChronologyRows'); body.replaceChildren();
  for(const event of events){
    const row=document.createElement('tr');
    const eventDate=node('td',{textContent:event.eventDate?fmtDate(event.eventDate):'Date unresolved'});
    if(event.eventDate) eventDate.append(node('small',{textContent:event.datePrecision&&event.datePrecision!=='day'?event.datePrecision:'event date'}));
    else eventDate.append(node('small',{textContent:'Do not substitute filing date'}));
    const filed=node('td',{textContent:event.filedDate?fmtDate(event.filedDate):'Not resolved'});
    const posture=node('td'); posture.append(node('span',{className:`chronology-posture ${event.classification}`,textContent:statusLabel(event.classification)}));
    const title=node('th',{textContent:event.title,attrs:{scope:'row'}});
    const sources=node('td',{className:'matrix-sources'});
    for(const sourceId of event.sourceIds){
      const source=sourceById.get(sourceId); if(!source) continue;
      sources.append(node('button',{textContent:sourceCitation(source),attrs:{type:'button','data-open-candidate':candidate.id,'data-source-id':source.id}}));
    }
    if(!sources.childElementCount) sources.append(node('span',{textContent:'No cited source'}));
    row.append(eventDate,filed,posture,title,sources); body.append(row);
  }
  if(!body.childElementCount){
    const row=document.createElement('tr'); row.append(node('td',{textContent:'No candidate-linked chronology has been assigned.',attrs:{colspan:'5'}})); body.append(row);
  }
}

function renderCandidate(candidate){
  selectedId=candidate.id; renderCandidateRail();
  text('#candidateRank',`Rank ${candidate.rank} · ${candidate.id} · ${statusLabel(candidate.status)} · ${candidate.investigativeUrgency} urgency`);
  text('#candidateTitle',candidate.title); text('#candidateAssessment',candidate.assessment);
  text('#candidateActor',`Alleged actor: ${candidate.actor}`); text('#candidateReadiness',candidate.readiness);
  text('#candidateRankBasis',candidate.rankBasis);
  text('#candidateOffense',candidate.offenseTheory); text('#candidateTarget',candidate.victimTarget);
  text('#candidateEventVenue',candidate.eventVenue); text('#candidateEvidencePosture',candidate.evidencePosture);
  text('#candidatePrincipalBlocker',candidate.principalBlocker);
  text('#candidateMateriality',candidate.materiality); $('#openCandidate').dataset.openCandidate=candidate.id;
  $('#openCandidate').removeAttribute('data-source-id');
  renderAuthorities(candidate); renderMotive(candidate); renderElements(candidate); renderCandidateChronology(candidate);
  const sourceList=$('#candidateSources'); sourceList.replaceChildren();
  for(const source of candidate.sources) sourceList.append(sourceButton(source,candidate.id));
  appendList('#candidateDefenses',candidate.defenses,'No defense recorded.');
  appendList('#candidateGaps',candidate.blockingGaps,'No blocking gap recorded.');
  const actions=$('#candidateActions'); actions.replaceChildren();
  for(const actionId of candidate.actionIds){
    const action=requestById.get(actionId); if(!action) continue;
    const item=node('li');
    item.append(node('span',{className:`action-priority ${action.priority}`,textContent:action.priority}),node('strong',{textContent:action.action}),node('small',{textContent:`Target: ${action.target}`}));
    actions.append(item);
  }
  history.replaceState(null,'',`${location.pathname}${location.search}#${candidate.id}`);
}

function renderContacts(){
  const body=$('#contactRows'); body.replaceChildren();
  for(const contact of referral.contacts){
    const row=document.createElement('tr');
    const sources=node('td',{className:'matrix-sources'});
    for(const sourceId of contact.sourceIds){const source=sourceById.get(sourceId);if(source)sources.append(node('span',{textContent:sourceCitation(source)}));}
    if(!sources.childElementCount) sources.append(node('span',{textContent:'Verify from current record'}));
    row.append(node('th',{textContent:contact.name,attrs:{scope:'row'}}),node('td',{textContent:contact.role}),node('td',{textContent:typeof contact.contact==='string'?contact.contact:Object.values(contact.contact||{}).filter(Boolean).join(' · ')}),sources); body.append(row);
  }
}

function renderReports(){
  const target=$('#reportLinks'); target.replaceChildren();
  for(const report of Object.values(referral.reports||{})){
    const link=node('a',{textContent:report.label,attrs:{href:assetUrl(report.path)}}); target.append(link);
  }
}

async function openCandidate(id,initialSourceId=''){
  const candidate=candidateById.get(id); if(!candidate) return;
  await openInvestigatorFinding({modal:$('#findingDialog'),template:$('#findingDialogContent'),item:candidate,reviewStore,initialSourceId,onSaved:()=>{$('#appStatus').textContent=`Review saved for ${candidate.id}.`;}});
}

try{
  ({referral,candidates,candidateById,sourceById,requestById,reviewStore}=await loadInvestigatorReferral());
  motiveByCandidateId=new Map((referral.motives||[]).map(item=>[item.candidateId,item]));
  const summary=await waitForMethod($('#referralSummary'),'setItems','summary-strip-ready');
  const unresolved=candidates.flatMap(item=>item.elements).filter(item=>item.status!=='supported').length;
  summary.setItems([
    {id:'candidates',value:candidates.length,label:'Curated candidates',detail:'Ranked for targeted investigation'},
    {id:'ready',value:candidates.filter(item=>item.readiness.toLocaleLowerCase().includes('charge-ready')&&!item.readiness.toLocaleLowerCase().includes('not charge-ready')).length,label:'Charge-ready now',detail:'Every required element must be proven'},
    {id:'gaps',value:unresolved,label:'Unresolved proof rows',detail:'Partial, missing, contested, or not supported'},
    {id:'actions',value:referral.requests.filter(item=>item.priority==='critical').length,label:'Critical agency requests',detail:'Originals, custodians, records, and legal screens'}
  ]);
  text('#executiveSummary',referral.theory.executiveSummary);
  text('#actionRequested',referral.theory.actionRequested);
  text('#criminalTrack',referral.reliefTracks.criminalReferral.requestedOutcome);
  text('#familyTrack',referral.reliefTracks.familyCourt.requestedOutcome);
  text('#familyWarning',referral.reliefTracks.familyCourt.warning);
  renderContacts(); renderReports();
  const requested=location.hash.slice(1); renderCandidate(candidateById.get(requested)||candidates[0]);
}catch(error){
  const alert=node('p',{className:'error',textContent:`Unable to load the Police / DA brief: ${error.message}. Rebuild the app-owned referral dataset and reload.`,attrs:{role:'alert'}});
  $('.candidate-detail')?.replaceChildren(alert); $('#appStatus').textContent=alert.textContent; throw error;
}

document.addEventListener('click',event=>{
  const select=event.target.closest('[data-candidate-id]'); if(select){renderCandidate(candidateById.get(select.dataset.candidateId)); return;}
  const open=event.target.closest('[data-open-candidate]'); if(open) openCandidate(open.dataset.openCandidate,open.dataset.sourceId||'').catch(error=>{$('#appStatus').textContent=`Unable to open allegation: ${error.message}`;});
});
