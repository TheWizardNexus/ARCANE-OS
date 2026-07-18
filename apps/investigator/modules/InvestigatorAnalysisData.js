import RecordReviewStore from '../../../arcane/modules/RecordReviewStore.js';
import {CASE_ROOT,assetUrl} from './InvestigatorCaseData.js';

const ANALYSIS_PATH='Analysis/investigative-analysis.json';
const ANALYSIS_ACTOR_OPTIONS=[
  {value:'unassigned',label:'Unassigned — verify the speaker or actor'},
  {value:'petitioner',label:'Petitioner — Teruko Miller'},
  {value:'petitioner-counsel',label:"Petitioner's counsel"},
  {value:'petitioner-side',label:'Petitioner side — actor requires precision'},
  {value:'respondent',label:'Respondent — Brandon Miller'},
  {value:'both-parties',label:'Both parties — separate statements'},
  {value:'third-party',label:'Third party'}
];
const ANALYSIS_DISPOSITION_OPTIONS=[
  {value:'unassessed',label:'Unassessed — automated lead'},
  {value:'supports-investigation',label:'Supports further investigation'},
  {value:'needs-corroboration',label:'Needs corroboration'},
  {value:'credibility-only',label:'Credibility issue, not an offense'},
  {value:'not-supported',label:'Not supported / rejected'}
];
const ANALYSIS_CONFIDENCE_OPTIONS=[
  {value:'unassigned',label:'Unassigned'},
  {value:'low',label:'Low — source allegation only'},
  {value:'medium',label:'Medium — contextual or independent support'},
  {value:'high',label:'High — direct primary-source comparison'}
];

function hydrateSource(source={}){
  return {
    ...source,
    pdfUrl:source.pdfPath?assetUrl(source.pdfPath):'',
    markdownUrl:source.markdownPath?assetUrl(source.markdownPath):''
  };
}

function prioritizeFindings(items=[]){
  const confidenceRank={high:4,'medium-high':3,medium:2,low:1,unassigned:0};
  return [...items].sort((left,right)=>{
    const leftCurated=String(left.status||'').includes('curated')?1:0;
    const rightCurated=String(right.status||'').includes('curated')?1:0;
    const curatedDifference=rightCurated-leftCurated;
    if(curatedDifference) return curatedDifference;
    const confidenceDifference=(confidenceRank[String(right.confidence||'unassigned')]||0)-(confidenceRank[String(left.confidence||'unassigned')]||0);
    return confidenceDifference||String(left.id||'').localeCompare(String(right.id||''));
  });
}

function initialReview(item={}){
  return {
    status:'unassessed',
    classification:String(item.allegedActor||item.actor||'unassigned'),
    attributes:{confidence:String(item.confidence||'unassigned')},
    notes:'',
    updatedAt:null
  };
}

function reviewItem(item,reviewStore){
  const stored=reviewStore.get(item.id);
  const review=stored.updatedAt?stored:initialReview(item);
  item.review=review;
  item.sources=(Array.isArray(item.sources)?item.sources:[]).map(hydrateSource);
  return item;
}

function validateAnalysis(data){
  if(!data||data.schemaVersion!==1||!Array.isArray(data.filings)||!Array.isArray(data.findings)){
    throw new TypeError('The investigative analysis index is missing or uses an unsupported schema.');
  }
  if(data.coverage?.filingsRepresented!==data.filings.length){
    throw new TypeError('The investigative analysis does not represent every indexed filing.');
  }
  return data;
}

async function loadInvestigatorAnalysis(){
  const response=await fetch(`${CASE_ROOT}${ANALYSIS_PATH}`,{cache:'no-store',credentials:'same-origin'});
  if(!response.ok) throw new Error(`Investigative analysis unavailable (${response.status})`);
  const data=validateAnalysis(await response.json());
  const reviewStore=new RecordReviewStore({namespace:'investigator.24FL001068.analysis'});
  await reviewStore.load();
  for(const collectionName of ['findings','crossReferences','timeline','orders','motives']){
    data[collectionName]=(Array.isArray(data[collectionName])?data[collectionName]:[]).map(item=>reviewItem(item,reviewStore));
  }
  data.findingById=new Map(data.findings.map(item=>[item.id,item]));
  data.findingsByRecord=new Map(data.filings.map(filing=>[
    filing.recordId,
    filing.findingIds.map(id=>data.findingById.get(id)).filter(Boolean)
  ]));
  data.itemById=new Map([
    ...data.findings,
    ...data.crossReferences,
    ...data.timeline,
    ...data.orders,
    ...data.motives
  ].map(item=>[item.id,item]));
  return {analysis:data,analysisReviewStore:reviewStore};
}

function explainableItem(item={}){
  if(item.elementsToVerify) return item;
  if(item.category&&item.whyItMayConflict){
    return {
      ...item,
      kind:'Cross-record comparison',
      allegedActor:item.allegedActor||'unassigned',
      assessment:`The cited records may conflict: ${item.whyItMayConflict}`,
      application:item.summary,
      elementsToVerify:['Confirm both atomic statements address the same fact.','Keep event, signature, filing, and comparison dates separate.','Determine whether changed circumstances, qualifications, or different meanings reconcile the records.'],
      limitations:[item.alternativeExplanation||'A nonculpable explanation has not yet been recorded.','This comparison does not select a truthful source or establish knowing falsity.'],
      nextSteps:item.resolveWith||['Compare the complete originals.']
    };
  }
  if(item.obligation){
    return {
      ...item,label:item.title,kind:'Order compliance review',allegedActor:'unassigned',allegedActorLabel:item.boundActor,
      assessment:`Current status: ${item.status}. ${item.assessment}`,application:item.obligation,
      elementsToVerify:['Confirm the operative signed order and exact mandatory language.','Confirm the person bound, effective date, service, deadline, and exceptions.','Establish performance, ability, willfulness, and any later modification.'],
      limitations:['A later party allegation does not establish noncompliance.','“May” and “up to” language must not be converted into a mandatory obligation.'],
      nextSteps:['Compare every alleged event date to the order operative on that date.','Use outcome-not-in-record when performance cannot be established.']
    };
  }
  if(item.hypothesis){
    return {
      ...item,label:item.hypothesis,kind:'Motive hypothesis',allegedActor:item.actor,allegedActorLabel:item.actorLabel,
      assessment:`Hypothesis only: ${item.summary}`,application:`The cited sources may provide an incentive connected to ${item.allegedConduct?.join(', ')||'the alleged conduct'}.`,
      elementsToVerify:['Establish the underlying conduct before relying on motive.','Show a source-grounded incentive tied to the relevant date.','Test alternative explanations and contrary conduct.'],
      limitations:item.contraryConsiderations||['Motive cannot substitute for proof of an act or intent.'],
      nextSteps:['Interview the actor about legitimate objectives.','Seek independent timing and benefit evidence.']
    };
  }
  return {
    ...item,label:item.title||'Dated source event',kind:item.category||'Timeline event',allegedActor:'unassigned',allegedActorLabel:item.actor,
    assessment:item.summary||'This dated source event requires review.',application:`Recorded date: ${item.date||'not resolved'}.`,
    elementsToVerify:['Confirm whether the date is an event, statement, record-created, signed, filed, scheduled, or comparison date.','Inspect the complete cited source and record any date anomaly.'],
    limitations:['A scheduled or retrospectively reported event is not equivalent to a contemporaneous record of occurrence.'],
    nextSteps:['Verify the original source and date metadata.']
  };
}

export {
  ANALYSIS_ACTOR_OPTIONS,
  ANALYSIS_CONFIDENCE_OPTIONS,
  ANALYSIS_DISPOSITION_OPTIONS,
  ANALYSIS_PATH,
  explainableItem,
  loadInvestigatorAnalysis,
  prioritizeFindings
};
