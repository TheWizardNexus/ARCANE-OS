import RecordReviewStore from '../../../arcane/modules/RecordReviewStore.js';

const CASE_ROOT='./apps/investigator/data/cases/24FL001068/';
const REVIEW_OPTIONS=[
  {value:'not-reviewed',label:'Not reviewed'},
  {value:'reviewed',label:'Reviewed against source'},
  {value:'potential-evidence',label:'Potential evidence'},
  {value:'follow-up',label:'Follow-up required'}
];
const ACTOR_OPTIONS=[
  {value:'unassigned',label:'Unassigned — verify before attribution'},
  {value:'petitioner',label:'Petitioner — Teruko Miller'},
  {value:'respondent',label:'Respondent — Brandon Miller'}
];
const FINDING_OPTIONS=[
  {value:'',label:'Select a finding type'},
  {value:'self-impeaching-statement',label:'Self-impeaching statement'},
  {value:'apparent-false-statement',label:'Apparent false statement'},
  {value:'contradiction',label:'Contradiction across sources'},
  {value:'corroboration',label:'Corroborating evidence'},
  {value:'apparent-order-violation',label:'Apparent order violation'},
  {value:'financial-misrepresentation',label:'Financial misrepresentation'},
  {value:'evidence-integrity',label:'Evidence integrity issue'},
  {value:'coercion-or-threat',label:'Coercion or threat'},
  {value:'violence-or-abuse',label:'Violence or abuse'},
  {value:'investigative-lead',label:'Other investigative lead'}
];
const CONFIDENCE_OPTIONS=[
  {value:'unassigned',label:'Unassigned'},
  {value:'low',label:'Low — needs verification'},
  {value:'medium',label:'Medium — contextual support'},
  {value:'high',label:'High — direct source comparison'}
];
const DISPOSITION_OPTIONS=[
  {value:'unassessed',label:'Unassessed'},
  {value:'supporting',label:'Supports an investigative theory'},
  {value:'needs-corroboration',label:'Needs corroboration'},
  {value:'dismissed',label:'Not supported / dismissed'}
];
const STATUS_LABELS=Object.fromEntries(REVIEW_OPTIONS.map(option=>[option.value,option.label]));
const ACTOR_LABELS={petitioner:'Petitioner',respondent:'Respondent',unassigned:'Unassigned'};

const fmtBytes=value=>new Intl.NumberFormat(undefined,{style:'unit',unit:'megabyte',maximumFractionDigits:1}).format(Number(value||0)/1048576);
const fmtDate=value=>value?new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(`${value}T00:00:00Z`)):'Date not parsed';
function assetUrl(relative){
  const value=String(relative||'').trim();
  const segments=value.split('/');
  if(!value||value.startsWith('/')||value.includes('\\')||segments.some(segment=>!segment||segment==='.'||segment==='..')){
    throw new TypeError('Case asset paths must stay inside the Investigator case-data folder.');
  }
  const root=new URL(CASE_ROOT,document.baseURI);
  const target=new URL(segments.map(encodeURIComponent).join('/'),root);
  if(target.origin!==root.origin||!target.pathname.startsWith(root.pathname)){
    throw new TypeError('Case asset paths must stay inside the Investigator case-data folder.');
  }
  return target.href;
}

function defaultReview(){
  return {status:'not-reviewed',classification:'unassigned',attributes:{},notes:'',updatedAt:null};
}

function reviewFields(){
  return [
    {key:'findingType',label:'Finding type',type:'select',options:FINDING_OPTIONS},
    {key:'disposition',label:'Human disposition',type:'select',options:DISPOSITION_OPTIONS},
    {key:'confidence',label:'Attribution confidence',type:'select',options:CONFIDENCE_OPTIONS},
    {key:'citation',label:'Exact page, paragraph, line, or timestamp',placeholder:'Example: PDF page 14, lines 8–16',maxLength:1000},
    {key:'relatedRecords',label:'Linked filing and exhibit IDs',type:'textarea',rows:3,placeholder:'Example: F0042, F0118, E0031',maxLength:4000},
    {key:'attributionBasis',label:'Why this side is the alleged actor',type:'textarea',rows:3,maxLength:4000}
  ];
}

function mergeReview(item,reviewStore){
  const persisted=reviewStore.get(item.id);
  Object.assign(item,defaultReview(),item.initialReview||{},persisted.updatedAt?persisted:{});
  return item;
}

function hasInvestigativeActivity(record){
  if(record.updatedAt&&record.attributes?.disposition==='dismissed') return false;
  if(record.updatedAt){
    return Boolean(record.signals?.length||record.attributes?.findingType||['potential-evidence','follow-up'].includes(record.status));
  }
  return Boolean(record.signals?.length);
}

function isHumanReviewed(record){
  return Boolean(record.updatedAt&&record.status!=='not-reviewed');
}

async function loadInvestigatorCase(){
  const response=await fetch(`${CASE_ROOT}case-index.json`,{cache:'no-store',credentials:'same-origin'});
  if(!response.ok) throw new Error(`Case index unavailable (${response.status})`);
  const data=await response.json();
  const reviewStore=new RecordReviewStore({namespace:'investigator.24FL001068'});
  await reviewStore.load();
  data.filings.forEach(item=>mergeReview(item,reviewStore));
  data.exhibits.forEach(item=>mergeReview(item,reviewStore));
  return {data,reviewStore};
}

export {
  ACTOR_LABELS,
  ACTOR_OPTIONS,
  CASE_ROOT,
  CONFIDENCE_OPTIONS,
  DISPOSITION_OPTIONS,
  FINDING_OPTIONS,
  REVIEW_OPTIONS,
  STATUS_LABELS,
  assetUrl,
  fmtBytes,
  fmtDate,
  hasInvestigativeActivity,
  isHumanReviewed,
  loadInvestigatorCase,
  reviewFields
};
