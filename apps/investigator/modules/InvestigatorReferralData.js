import RecordReviewStore from '../../../arcane/modules/RecordReviewStore.js';
import {CASE_ROOT,assetUrl} from './InvestigatorCaseData.js';

const REFERRAL_PATH='Referral/referral-case.json';

function validateReferral(data){
  if(!data||data.schemaVersion!==1||data.case?.id!=='24FL001068'||!Array.isArray(data.candidates)||!Array.isArray(data.sources)||!Array.isArray(data.requests)){
    throw new TypeError('The police referral model is missing or uses an unsupported schema.');
  }
  const sourceIds=new Set(data.sources.map(source=>source.id));
  const requestIds=new Set(data.requests.map(request=>request.id));
  for(const candidate of data.candidates){
    if(!candidate.id||!candidate.title||!Array.isArray(candidate.elements)) throw new TypeError('A referral candidate is incomplete.');
    for(const sourceId of [...candidate.sourceIds,...candidate.contrarySourceIds]){
      if(!sourceIds.has(sourceId)) throw new TypeError(`${candidate.id} refers to missing source ${sourceId}.`);
    }
    for(const requestId of candidate.actionIds){
      if(!requestIds.has(requestId)) throw new TypeError(`${candidate.id} refers to missing request ${requestId}.`);
    }
  }
  return data;
}

function hydrateSource(source={}){
  return {
    ...source,
    pdfUrl:source.pdfPath?assetUrl(source.pdfPath):'',
    markdownUrl:source.markdownPath?assetUrl(source.markdownPath):''
  };
}

function initialReview(candidate={}){
  return {
    status:'unassessed',
    classification:String(candidate.side||'unassigned'),
    attributes:{confidence:'medium'},
    notes:'',
    updatedAt:null
  };
}

function explainableCandidate(candidate,sourceById,requestById,reviewStore,additionalSourceIds=[]){
  const stored=reviewStore.get(candidate.id);
  const review=stored.updatedAt?stored:initialReview(candidate);
  const citedSourceIds=[...new Set([
    ...candidate.sourceIds,
    ...candidate.contrarySourceIds,
    ...candidate.elements.flatMap(item=>item.sourceIds),
    ...additionalSourceIds
  ])];
  const citedSources=citedSourceIds.map(id=>sourceById.get(id)).filter(Boolean);
  const actions=candidate.actionIds.map(id=>requestById.get(id)).filter(Boolean);
  return {
    ...candidate,
    label:candidate.title,
    kind:'Human-curated offense screen',
    allegedActor:candidate.side,
    allegedActorLabel:`${candidate.actor} (${candidate.side})`,
    confidence:candidate.status==='insufficient-proof'?'low':'medium',
    status:`human-curated · ${candidate.status}`,
    application:`${candidate.assessment} Materiality screen: ${candidate.materiality}`,
    elementsToVerify:candidate.elements.map(item=>`${item.proposition} — ${item.status}. ${item.fact}${item.gap?` Gap: ${item.gap}`:''}`),
    limitations:[...candidate.defenses,...candidate.blockingGaps.map(item=>`Blocking gap: ${item}`)],
    nextSteps:actions.map(item=>item.action),
    sources:citedSources,
    review
  };
}

async function loadInvestigatorReferral(){
  const response=await fetch(`${CASE_ROOT}${REFERRAL_PATH}`,{cache:'no-store',credentials:'same-origin'});
  if(!response.ok) throw new Error(`Police referral model unavailable (${response.status})`);
  const referral=validateReferral(await response.json());
  const sourceById=new Map(referral.sources.map(source=>[source.id,hydrateSource(source)]));
  const requestById=new Map(referral.requests.map(request=>[request.id,request]));
  const contextualSourceIds=new Map(referral.candidates.map(candidate=>[candidate.id,new Set()]));
  for(const event of referral.chronology||[]){
    for(const candidateId of event.candidateIds||[]){
      const ids=contextualSourceIds.get(candidateId); if(!ids) continue;
      for(const sourceId of event.sourceIds||[]) ids.add(sourceId);
    }
  }
  for(const motive of referral.motives||[]){
    const ids=contextualSourceIds.get(motive.candidateId); if(!ids) continue;
    for(const sourceId of motive.supportingSourceIds||[]) ids.add(sourceId);
  }
  const reviewStore=new RecordReviewStore({namespace:'investigator.24FL001068.referral'});
  await reviewStore.load();
  const candidates=referral.candidates
    .map(candidate=>explainableCandidate(candidate,sourceById,requestById,reviewStore,[...(contextualSourceIds.get(candidate.id)||[])]))
    .sort((left,right)=>left.rank-right.rank);
  return {referral,candidates,candidateById:new Map(candidates.map(item=>[item.id,item])),sourceById,requestById,reviewStore};
}

export {REFERRAL_PATH,loadInvestigatorReferral};
