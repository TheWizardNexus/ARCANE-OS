import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {extractDateMentions,findRulePassages,pageAtLine,pageMarkers,textLines} from '../../../arcane/modules/RecordPassageIndex.js';

const appRoot=path.resolve(import.meta.dirname,'..');
const caseRoot=path.join(appRoot,'data','cases','24FL001068');
const index=JSON.parse(await readFile(path.join(caseRoot,'case-index.json'),'utf8'));
const analysisRoot=path.join(caseRoot,'Analysis');

const PARTY_ACTORS={
  petitioner:{id:'petitioner',label:'Teruko Miller (Petitioner)',side:'petitioner'},
  respondent:{id:'respondent',label:'Brandon Miller (Respondent)',side:'respondent'},
  petitionerCounsel:{id:'petitioner-counsel',label:"Petitioner's counsel",side:'petitioner'},
  thirdParty:{id:'third-party',label:'Third party — identity requires review',side:'third-party'},
  unassigned:{id:'unassigned',label:'Actor not yet assigned',side:'unassigned'}
};

const THEORY_RULES=[
  {
    id:'possible-false-statement',label:'Possible false or materially misleading statement',kind:'possible-offense-theory',
    patterns:[/\b(?:materially\s+)?(?:false|misleading|untrue)\s+(?:sworn\s+)?(?:statement|assertion|representation|claim|report|filing)s?\b/i,/\b(?:misrepresented|falsified|lied about|made up)\b/i,/\bfraud on the court\b/i],
    elements:['Identify the exact statement and speaker.','Confirm whether it was sworn, verified, or made to an official decision-maker.','Establish literal falsity with reliable primary evidence.','Establish materiality and knowing intent; mistake, ambiguity, or stale information must be excluded.'],
    limitations:['A source calling another statement “false” is an allegation, not independent proof.','Contradiction alone does not establish knowledge, intent, oath, or materiality.'],
    nextSteps:['Obtain the complete statement and verification page.','Compare primary records, metadata, and neutral witness accounts.','Record the strongest innocent or contextual explanation.']
  },
  {
    id:'self-impeachment',label:'Self-impeaching or internally inconsistent statement',kind:'credibility-issue',
    patterns:[/\bself[- ]impeach\w*\b/i,/\b(?:internally inconsistent|contradict(?:s|ed)? (?:her|his|their) own|inconsistent with (?:her|his|their) (?:prior|earlier))\b/i,/\b(?:later|subsequently)\s+(?:denied|admitted|asserted)\b/i],
    elements:['Identify two atomic statements on the same subject.','Separate the date of each statement from the date each filing was submitted.','Test whether qualifiers, changed circumstances, or different meanings reconcile the accounts.'],
    limitations:['Impeachment is a credibility issue and is not independently a crime.','A later statement can reflect new information or a legitimate correction.'],
    nextSteps:['Display both complete passages side by side.','Verify speaker, signature, context, and chronology.']
  },
  {
    id:'admission',label:'Potential admission against interest',kind:'admission',
    patterns:[/\b(?:Petitioner|Respondent|Teruko|Brandon)\s+(?:admit(?:s|ted)?|acknowledg(?:es|ed)?|conced(?:es|ed)?)\b/i,/\bRESPONSE:\s*(?:Admit|Admitted)\b/i],
    elements:['Confirm who made the admission and in what capacity.','Preserve the complete question, qualification, objection, and surrounding context.','Determine what fact is actually admitted and what remains disputed.'],
    limitations:['A partial admission or discovery response may be narrowly qualified.','An admission may support credibility analysis without establishing a criminal offense.'],
    nextSteps:['Inspect the complete signed response or transcript.','Link corroborating and contrary primary evidence.']
  },
  {
    id:'possible-order-noncompliance',label:'Possible court-order noncompliance',kind:'order-compliance',
    patterns:[/\b(?:failed|failure|refused|has not|had not|did not)\s+(?:to\s+)?(?:comply|file|serve|provide|follow|obey)\b.{0,160}\b(?:order|court|FOAH|ROAH|visitation|itinerary)\b/i,/\b(?:order|court|FOAH|ROAH|visitation|itinerary)\b.{0,160}\b(?:noncompliance|not complied|not obeyed|remains unfiled|still not been served)\b/i],
    elements:['Locate the operative signed order and exact obligation.','Confirm effective date, service or notice, deadline, and person bound.','Distinguish mandatory “shall/must” language from “may/up to” permission.','Determine actual performance, ability to comply, willfulness, later modification, and remedy.'],
    limitations:['A party allegation is not proof that an order was violated.','Family-court noncompliance is not automatically a criminal offense.'],
    nextSteps:['Create an order-to-obligation chain.','Check superseding orders and proof of service.','Use outcome-not-in-record when performance cannot be established.']
  },
  {
    id:'possible-threat-coercion',label:'Possible threat, coercion, or intimidation',kind:'possible-offense-theory',
    patterns:[/\b(?:threat(?:en|ened|s)?|coerc(?:e|ed|ion)|intimidat\w*|extort\w*|retaliat\w*|suicide[- ]coax\w*)\b/i,/\bkill (?:yourself|himself|herself)\b/i],
    elements:['Preserve the exact words or conduct, speaker, target, date, and context.','Determine intended effect, nexus to a protected report/witness/action, and resulting fear or influence.','Locate contemporaneous communications, witnesses, recordings, or reports.'],
    limitations:['Strong or conditional language is not necessarily an unlawful threat.','Context, authority, intent, and reasonable interpretation require human review.'],
    nextSteps:['Obtain the original communication and metadata.','Interview speaker, recipient, and neutral witnesses separately.']
  },
  {
    id:'possible-evidence-integrity',label:'Possible evidence integrity or fabrication issue',kind:'possible-offense-theory',
    patterns:[/\b(?:tamper\w*|alter(?:ed|ation)|falsif(?:ied|ication)|fabricat(?:ed|ion))\b.{0,100}\b(?:evidence|record|document|audio|video|message|photo|filing)?/i,/\b(?:deleted|destroyed|withheld)\b.{0,100}\b(?:evidence|record|message|metadata|original)\b/i],
    elements:['Identify the original item, custodian, and chain of custody.','Establish what changed, was withheld, or was destroyed and when.','Determine materiality, actor identity, knowledge, and intent.'],
    limitations:['OCR defects, summaries, edits, and missing context can look like alteration.','Use originals and forensic metadata before drawing a conclusion.'],
    nextSteps:['Acquire native files and hashes.','Preserve devices/accounts through authorized process.','Compare complete originals with filed copies.']
  },
  {
    id:'possible-financial-misrepresentation',label:'Possible financial or property misrepresentation',kind:'possible-offense-theory',
    patterns:[/\b(?:false|misleading|concealed|hidden|underreported|inaccurate)\b.{0,100}\b(?:income|asset|financial|value|valuation|payment|repair|property)\b/i,/\b(?:income|asset|financial|value|valuation|payment|repair|property)\b.{0,100}\b(?:misrepresented|concealed|hidden|falsified)\b/i],
    elements:['Identify the exact figure, condition, value, payment, or disclosure.','Confirm the duty and forum in which it was represented.','Establish the true fact with independent records and the speaker’s knowledge at that time.','Determine materiality, benefit, and changed circumstances.'],
    limitations:['Valuation and repair status can change, and settlement advocacy may be approximate.','A discrepancy does not by itself establish fraud or intent.'],
    nextSteps:['Obtain invoices, bank records, valuations, service records, and timestamps.','Ask what information the speaker possessed on the statement date.']
  },
  {
    id:'alleged-violence-abuse',label:'Alleged violence or abuse',kind:'conduct-evidence',
    patterns:[/\b(?:hit|punched|pushed|kicked|struck|assaulted|battered|choked|injured)\b/i,/\b(?:physical violence|domestic violence|physical abuse)\b/i],
    elements:['Identify the alleged act, actor, target, date, location, and witnesses.','Preserve injury evidence, medical records, photographs, recordings, and contemporaneous reports.','Test self-defense, accident, attribution, and inconsistent accounts.'],
    limitations:['A report of violence may be hearsay and does not establish the act by itself.','The complete account and contrary evidence must remain visible.'],
    nextSteps:['Interview witnesses separately.','Authenticate photographs, messages, recordings, and medical or police records.']
  },
  {
    id:'possible-false-official-report',label:'Possible false report to police or another official',kind:'possible-offense-theory',
    patterns:[/\b(?:false|misleading|fabricated)\b.{0,100}\b(?:police report|report to police|law enforcement|officer|911 call)\b/i,/\b(?:police report|report to police|law enforcement|officer|911 call)\b.{0,100}\b(?:false|misleading|fabricated)\b/i],
    elements:['Identify the exact report, speaker, recipient agency, and date.','Establish literal falsity and the speaker’s knowledge.','Determine what offense or emergency was reported and what official action followed.'],
    limitations:['A disputed account is not necessarily a knowingly false report.','Obtain the agency record and recording before reliance.'],
    nextSteps:['Request CAD/dispatch, body-camera, call, and written-report records.','Compare contemporaneous physical and witness evidence.']
  }
];

const records=new Map();
for(const filing of index.filings){
  const markdown=await readFile(path.join(caseRoot,...filing.markdownPath.split('/')),'utf8');
  records.set(filing.id,{...filing,markdown,lines:textLines(markdown),markers:pageMarkers(textLines(markdown))});
}

function sourceTier(record){
  const value=`${record.filingParty} ${record.title}`.toLocaleLowerCase();
  if(record.filingParty==='COURT'||/court order|minute order|findings and order|restraining order after hearing/.test(value)) return 'court-record';
  if(/certified|reporter|transcript/.test(value)) return 'certified-record';
  if(/teruko|brandon|petitioner|respondent/.test(record.filingParty.toLocaleLowerCase())) return 'party-record';
  if(/counsel|attorney|rivera|mayberry/.test(value)) return 'advocate-record';
  return 'third-party-record';
}

function actorFromFiler(filingParty=''){
  const party=String(filingParty).toLocaleLowerCase();
  if(/teruko|petitioner/.test(party)) return PARTY_ACTORS.petitioner;
  if(/brandon|respondent/.test(party)) return PARTY_ACTORS.respondent;
  return PARTY_ACTORS.unassigned;
}

function inferActor(passage,record){
  const excerpt=String(passage.excerpt||'');
  const petitionerCounsel=/(?:Eric\s+Riv(?:iera|era)[- ]?Jurado|Elizabeth\s+Mayberry|Petitioner'?s?\s+counsel|her\s+counsel)\b/i;
  const petitioner=/(?:Teruko(?:\s+Nozaki)?(?:\s+Miller)?|\bPetitioner)\b/i;
  const respondent=/(?:Brandon(?:\s+Charles)?(?:\s+Miller)?|\bRespondent)\b/i;
  const action=/(?:admit|assert|claim|state|represent|report|deny|refus|fail|mislead|fals|fabricat|hit|punch|push|kick|struck|threat|coerc|intimidat|withhold|conceal|tell|said|wrote)/i;
  const subject=(pattern)=>new RegExp(`${pattern.source}.{0,140}${action.source}`,'i').test(excerpt);
  if(subject(petitionerCounsel)) return {...PARTY_ACTORS.petitionerCounsel,confidence:'medium',basis:'Petitioner-side counsel is named as the actor near the detected conduct.'};
  if(subject(petitioner)) return {...PARTY_ACTORS.petitioner,confidence:'medium',basis:'Petitioner/Teruko is named as the actor near the detected conduct.'};
  if(subject(respondent)) return {...PARTY_ACTORS.respondent,confidence:'medium',basis:'Respondent/Brandon is named as the actor near the detected conduct.'};
  if(/^\s*(?:I\s+)?(?:admit|I\s+(?:lied|hit|struck|refused|failed))/i.test(passage.match)||/\bI\s+(?:admit|acknowledge|lied|hit|struck|refused|failed)\b/i.test(excerpt)){
    const filer=actorFromFiler(record.filingParty);
    if(filer.id!=='unassigned') return {...filer,confidence:'low',basis:'A first-person pattern appears in a filing by this party; speaker identity still requires source review.'};
  }
  return {...PARTY_ACTORS.unassigned,confidence:'unassigned',basis:'The nearby passage does not identify one alleged actor with enough precision.'};
}

function sourceFromPassage(record,passage){
  return {
    recordId:record.id,
    filename:record.name,
    title:record.title,
    filedDate:record.filingDate,
    filingParty:record.filingParty,
    pdfPath:record.pdfPath,
    markdownPath:record.markdownPath,
    page:passage.page,
    lineStart:passage.lineStart,
    lineEnd:passage.lineEnd,
    excerpt:passage.excerpt,
    sourceTier:sourceTier(record)
  };
}

function makeFinding(record,passage,indexNumber){
  const rule=THEORY_RULES.find(item=>item.id===passage.ruleId);
  const actor=inferActor(passage,record);
  const status=rule.kind==='credibility-issue'?'credibility lead — unverified':'automated lead — unverified';
  return {
    id:`L-${record.id}-${String(indexNumber+1).padStart(3,'0')}`,
    recordId:record.id,
    label:rule.label,
    category:rule.id,
    kind:rule.kind,
    status,
    allegedActor:actor.id,
    allegedActorLabel:actor.label,
    allegedSide:actor.side,
    attributionConfidence:actor.confidence,
    attributionBasis:actor.basis,
    confidence:'low',
    statementDate:record.filingDate,
    filedDate:record.filingDate,
    assessment:`The cited passage supports investigation of ${rule.label.toLocaleLowerCase()}. It does not establish criminal liability or a knowing falsehood without the listed verification.`,
    application:`This filing contains the detected language “${String(passage.match||'').replace(/\s+/g,' ').trim().slice(0,180)}.” The complete cited passage and original PDF page must control over this automated lead.`,
    elementsToVerify:[...rule.elements],
    limitations:[...rule.limitations],
    nextSteps:[...rule.nextSteps],
    sources:[sourceFromPassage(record,passage)]
  };
}

const filings=[];
const findings=[];
for(const record of records.values()){
  const passages=record.filingParty==='COURT'?[]:findRulePassages(record.markdown,THEORY_RULES.map(rule=>({...rule,accept:candidate=>candidate.page!==null})),{
    recordId:record.id,contextLines:2,maximumPerRule:18,maximumResults:120
  });
  const candidates=passages.map((passage,indexNumber)=>makeFinding(record,passage,indexNumber));
  const recordFindings=[...new Map(candidates.map(item=>[`${item.category}|${item.sources[0]?.page}|${item.allegedActor}`,item])).values()]
    .map((item,indexNumber)=>({...item,id:`L-${record.id}-${String(indexNumber+1).padStart(3,'0')}`}));
  findings.push(...recordFindings);
  filings.push({
    recordId:record.id,
    filedDate:record.filingDate,
    filingParty:record.filingParty,
    title:record.title,
    filename:record.name,
    pdfPath:record.pdfPath,
    markdownPath:record.markdownPath,
    auditStatus:'automated passage audit complete — human review required',
    findingIds:recordFindings.map(item=>item.id),
    findingCount:recordFindings.length
  });
}

function sourceByLines(recordId,lineStart,lineEnd,page=null){
  const record=records.get(recordId);
  if(!record) throw new Error(`Unknown record ${recordId}`);
  const start=Math.max(1,Number(lineStart)||1); const end=Math.max(start,Number(lineEnd)||start);
  const excerpt=record.lines.slice(start-1,end).map(line=>line.trim()).filter(line=>line&&!/^```|^---$/.test(line)).join(' ').replace(/\s+/g,' ').slice(0,2400);
  return sourceFromPassage(record,{page:page??pageAtLine(record.markers,start-1),lineStart:start,lineEnd:end,excerpt});
}

function sourceByPattern(recordId,pattern,{context=3}={}){
  const record=records.get(recordId);
  if(!record) throw new Error(`Unknown record ${recordId}`);
  const match=record.markdown.match(pattern);
  if(!match||match.index===undefined) throw new Error(`Pattern not found in ${recordId}: ${pattern}`);
  const before=record.markdown.slice(0,match.index).split('\n').length;
  return sourceByLines(recordId,Math.max(1,before-context),before+context);
}

function addCuratedFinding({recordId,label,category,kind,actor,actorLabel,side,confidence='medium',assessment,application,sources,limitations=[],nextSteps=[]}){
  const record=records.get(recordId); const rule=THEORY_RULES.find(item=>item.id===category)||THEORY_RULES.find(item=>item.id==='self-impeachment');
  const existing=filings.find(item=>item.recordId===recordId); if(!record||!existing) throw new Error(`Unknown curated-finding record ${recordId}`);
  const sequence=findings.filter(item=>item.recordId===recordId&&item.id.startsWith('C-')).length+1;
  const finding={
    id:`C-${recordId}-${String(sequence).padStart(3,'0')}`,recordId,label,category,kind,status:'curated source comparison — unverified',
    allegedActor:actor,allegedActorLabel:actorLabel,allegedSide:side,attributionConfidence:'high',attributionBasis:'Actor is explicitly identified in the cited source comparison.',confidence,
    statementDate:record.filingDate,filedDate:record.filingDate,assessment,application,
    elementsToVerify:[...(rule?.elements||['Identify the exact statement or act.','Compare the complete originals.','Establish knowledge, materiality, and contrary facts.'])],
    limitations:[...(rule?.limitations||[]),...limitations],nextSteps:[...(rule?.nextSteps||[]),...nextSteps],sources
  };
  findings.push(finding); existing.findingIds.push(finding.id); existing.findingCount++;
}

addCuratedFinding({
  recordId:'F0003',label:'Possible sworn misstatement that Respondent was already convicted',category:'possible-false-statement',kind:'possible-offense-theory',actor:'petitioner',actorLabel:'Teruko Miller (Petitioner)',side:'petitioner',confidence:'medium-high',
  assessment:'The declaration uses “convicted,” while its own exhibits and nearby text describe an active complaint, arraignment, and charges awaiting dismissal. This supports focused investigation of wording, knowledge, and materiality; it does not prove perjury.',
  application:'Compare the exact sworn sentence to the contemporaneous official portal exhibit and the declaration’s own description of pending dismissal.',
  sources:[sourceByLines('F0003',149,151,2),sourceByLines('F0003',382,394,8),sourceByLines('F0003',417,442,10)],
  nextSteps:['Obtain a certified docket and disposition as of November 4, 2024.','Determine whether “convicted” was intentional terminology, mistake, or shorthand.']
});
addCuratedFinding({
  recordId:'F0003',label:'Alleged destruction of an electronic journal and unauthorized access',category:'possible-evidence-integrity',kind:'possible-offense-theory',actor:'respondent',actorLabel:'Brandon Miller (Respondent)',side:'respondent',confidence:'medium',
  assessment:'Teruko alleges deletion of her electronic journal and an admission of destruction. Device and backup evidence are required before attributing deletion or intent.',application:'The filing supplies the allegation and an asserted admission, but not a forensic chain.',sources:[sourceByLines('F0003',162,198,2)],
  nextSteps:['Preserve devices and backups through authorized process.','Obtain repair-shop records and native account logs.']
});
addCuratedFinding({
  recordId:'F0003',label:'Police-record allegation of assault with observed injury',category:'alleged-violence-abuse',kind:'conduct-evidence',actor:'respondent',actorLabel:'Brandon Miller (Respondent)',side:'respondent',confidence:'medium-high',
  assessment:'An embedded police report attributes pinning conduct to Brandon, records observed redness/bruising, and says he was booked. The underlying report, body-camera evidence, and final disposition still control.',application:'This is stronger than a later party summary because it reproduces an official report with contemporaneous observations, but it remains subject to authentication and disposition review.',sources:[sourceByLines('F0003',987,1078,36)],
  nextSteps:['Request the original report, photographs, CAD, body-camera/MAVRS, and final charging disposition.']
});
addCuratedFinding({
  recordId:'F0023',label:'Possible employment-history misstatement on sworn financial disclosure',category:'possible-financial-misrepresentation',kind:'possible-offense-theory',actor:'petitioner',actorLabel:'Teruko Miller (Petitioner)',side:'petitioner',confidence:'medium',
  assessment:'Teruko’s FL-150 lists a 2016 job-end date; a later third-party declaration describes work activity through December 2017. Whether that activity was paid employment or volunteer work remains unresolved.',application:'The records create a dated employment-history discrepancy relevant to financial disclosure, not proof of knowing falsity.',sources:[sourceByLines('F0023',61,70,1),sourceByLines('F0023',90,94,1),sourceByLines('F0103',53,82,1)],
  nextSteps:['Obtain payroll, tax, contract, and bank records.','Clarify whether the 2017 activity met the FL-150 meaning of employment.']
});
addCuratedFinding({
  recordId:'F0107',label:'Conditional restraining-order recommendation after copying an oversight office',category:'possible-threat-coercion',kind:'possible-offense-theory',actor:'third-party',actorLabel:'Derek Austin',side:'third-party',confidence:'low-medium',
  assessment:'The email conditionally links continued copying of the Attorney General to recommending a state restraining order. It supports review of pressure or retaliation but does not establish an unlawful threat.',application:'The complete email thread, sender authority, and legitimate communication-management rationale are essential.',sources:[sourceByLines('F0107',161,176,4)],limitations:['The filing contains an apparent 2024/2025 date typo; the exhibit date controls.']
});
addCuratedFinding({
  recordId:'F0127',label:'Sworn denial of a visitation agreement disputed by the neutral supervisor',category:'possible-false-statement',kind:'possible-offense-theory',actor:'petitioner',actorLabel:'Teruko Miller (Petitioner)',side:'petitioner',confidence:'medium-high',
  assessment:'Teruko’s sworn response says she clearly did not agree; Zollmann later says Teruko agreed, confirmed details, later cancelled, and then denied agreement. This is a strong account conflict, not an automatic finding of knowing falsity.',application:'The exact condition, separate 24-hour and three-hour discussions, calls, and texts must be reconstructed.',sources:[sourceByLines('F0127',353,360,7),sourceByLines('F0127',391,397,8),sourceByLines('F0137',177,229,4),sourceByLines('F0137',255,258,6)]
});
addCuratedFinding({
  recordId:'F0133',label:'Counselor reports Petitioner admitted striking Respondent',category:'admission',kind:'admission',actor:'petitioner',actorLabel:'Teruko Miller (Petitioner)',side:'petitioner',confidence:'medium-high',
  assessment:'Caton swears that Teruko admitted striking Brandon during counseling and then blamed him. The exact session date is absent, and the admission requires testimony, notes, and privilege/admissibility review.',application:'This is a third-party account of an alleged admission rather than a direct recording.',sources:[sourceByLines('F0133',285,303,4)],nextSteps:['Locate Caton’s contemporaneous messages or notes and identify the session date.','Address consent, privilege, and admissibility with agency counsel.']
});
addCuratedFinding({
  recordId:'F0136',label:'“Refused to find a supervisor” statement qualified by later contact history',category:'possible-false-statement',kind:'possible-offense-theory',actor:'petitioner',actorLabel:'Teruko Miller (Petitioner)',side:'petitioner',confidence:'medium',
  assessment:'A declaration signed December 8 and filed January 12 attributes the delay to Brandon’s refusal; Sada later listed Brandon contacts beginning December 16. This may be a stale or overbroad statement rather than a knowing lie.',application:'Signature date, filing date, later contacts, provider availability, and apparent typos in the Sada email must remain separate.',sources:[sourceByLines('F0136',320,333,5),sourceByLines('F0136',560,562,10),sourceByLines('F0140',347,370,9)]
});
addCuratedFinding({
  recordId:'F0142',label:'Temporal/scope contradiction in “no criminal filings, charges, or convictions” statement',category:'self-impeachment',kind:'credibility-issue',actor:'respondent',actorLabel:'Brandon Miller (Respondent)',side:'respondent',confidence:'medium',
  assessment:'Brandon’s later verified statement and attached no-record letters rebut a conviction claim but may be overbroad when compared with the earlier portal showing a complaint and active case. Dismissal, sealing, and search scope may reconcile the records.',application:'Distinguish historical arrest/complaint, current charge, conviction, dismissal, and a no-record search as of a later date.',sources:[sourceByLines('F0142',115,140,2),sourceByLines('F0142',331,333,8),sourceByLines('F0003',417,442,10)]
});
addCuratedFinding({
  recordId:'F0147',label:'Possible undisclosed Ghana bank-account lead',category:'possible-financial-misrepresentation',kind:'possible-offense-theory',actor:'petitioner',actorLabel:'Teruko Miller (Petitioner)',side:'petitioner',confidence:'medium',
  assessment:'A certified transcript records an affirmative response to mention of a Ghana account, while Brandon alleges nondisclosure. Account existence does not itself establish a disclosure omission.',application:'Compare the original audio and transcript to the operative preliminary/final declarations of disclosure.',sources:[sourceByLines('F0147',268,279,6),sourceByLines('F0147',613,625,16)],nextSteps:['Obtain account ownership, dates, balances, and disclosure schedules.']
});
addCuratedFinding({
  recordId:'F0245',label:'“Suzie” email authorship and identity contradiction',category:'self-impeachment',kind:'credibility-issue',actor:'petitioner',actorLabel:'Teruko Miller (Petitioner)',side:'petitioner',confidence:'medium',
  assessment:'An email from Teruko’s address opens “My name is Suzie” and closes “Teruko”; she later admits the sender address but denies claiming to be Suzie. Header and drafting evidence are needed.',application:'The facial wording creates a credibility lead and possible deceptive communication issue; it does not prove impersonation or an order violation.',sources:[sourceByLines('F0245',303,330,6),sourceByLines('F0267',627,650,11),sourceByLines('F0233',709,713,15)]
});
addCuratedFinding({
  recordId:'F0267',label:'Makeup-time statement and admitted failure to file a makeup RFO',category:'self-impeachment',kind:'credibility-issue',actor:'petitioner',actorLabel:'Teruko Miller (Petitioner)',side:'petitioner',confidence:'medium',
  assessment:'Teruko admits saying she was doing everything possible to support the father-child relationship and separately admits she had not filed a makeup-time RFO by May 21. The two facts may be inconsistent but do not establish a crime.',application:'Determine whether filing an RFO was necessary, promised, practicable, or only one of several ways to facilitate contact.',sources:[sourceByLines('F0267',181,184,2),sourceByLines('F0267',227,232,3)]
});

const crossReferences=[
  {
    id:'X0001',category:'direct-account-conflict',label:'Supervised-visitation agreement and document-request accounts',allegedActor:'petitioner-side',allegedActorLabel:'Teruko Miller and Eric Rivera-Jurado',confidence:'high-conflict-low-falsity',
    statementDate:'2025-12-10',comparisonDate:'2026-01-15',dateConfidence:'high',
    summary:'Petitioner and counsel described an unconfirmed or pressured 24-hour proposal with missing documentation; neutral supervisor Johanna Zollmann later described an optional maximum, a separate three-hour agreement, cancellation, and later denial.',
    whyItMayConflict:'The accounts differ on whether a three-hour visit was actually agreed, who cancelled it, whether documents were requested, and whether “up to 24 hours” was optional or coercive.',
    alternativeExplanation:'The participants may have conflated an optional 24-hour discussion with final three-hour scheduling, a conditional agreement, or a later cancellation.',
    resolveWith:['Original texts and call logs','Complete recordings if lawfully available','Message metadata','Separate testimony from all participants'],
    sources:[sourceByLines('F0125',104,124,2),sourceByLines('F0127',294,302,5),sourceByLines('F0137',177,192,4),sourceByLines('F0137',209,229,5)]
  },
  {
    id:'X0002',category:'timing-and-stale-statement',label:'“Refused to find/contact a supervisor” versus Sada contact history',allegedActor:'petitioner',allegedActorLabel:'Teruko Miller',confidence:'medium',
    statementDate:'2025-12-08',filedDate:'2026-01-12',comparisonDate:'2026-01-16',dateConfidence:'mixed-signature-and-filing-dates',
    summary:'A declaration signed December 8 and filed January 12 attributes the problem to Brandon’s refusal; Sada later listed contacts beginning December 16 and additional contacts through January 13.',
    whyItMayConflict:'The statement may have been accurate when signed but stale when filed. Later contacts contradict a broad continuing-refusal characterization, not necessarily the original December 8 state.',
    alternativeExplanation:'Signature and filing dates differ; contacts post-date the signature; the Sada email itself contains apparent year typos.',
    resolveWith:['Original signed declaration metadata','Court submission history','Sada call/message records','Clarification of apparent date typos'],
    sources:[sourceByLines('F0136',320,329,5),sourceByLines('F0140',347,370,9)]
  },
  {
    id:'X0003',category:'property-representation-conflict',label:'Nissan Leaf condition, value, and repair-payment representations',allegedActor:'petitioner-side',allegedActorLabel:"Petitioner’s counsel; Teruko Miller’s knowledge unresolved",confidence:'high-conflict-low-knowledge',
    statementDate:'2026-03-25',comparisonDate:'2026-04-02',dateConfidence:'high',
    summary:'The hearing transcript describes a dead battery, low vehicle value, and unwillingness to pay; a dealership director later declared the vehicle was operational, a repair was agreed and paid, and Teruko took it home.',
    whyItMayConflict:'The factual descriptions of operability, value, repair authorization, payment, and possession differ materially.',
    alternativeExplanation:'Repair or payment may have occurred after the hearing, counsel may have had stale information, or the statements may have been settlement advocacy.',
    resolveWith:['Dealer repair order and invoice','Payment timestamp','Vehicle delivery record','Counsel/client communications and knowledge as of March 25'],
    sources:[sourceByLines('F0197',419,442,7),sourceByLines('F0197',647,685,11),sourceByLines('F0199',115,134,2),sourceByLines('F0199',151,167,3),sourceByLines('F0199',188,200,4)]
  },
  {
    id:'X0004',category:'formal-denial-versus-certified-transcript',label:'Certified audio statements versus later Request-for-Admission denials',allegedActor:'petitioner',allegedActorLabel:'Teruko Miller',confidence:'high-record-conflict-low-intent',
    eventDate:null,statementDate:'2026-01-20',comparisonDate:'2026-06-24',dateConfidence:'audio-event-date-unknown',
    summary:'A certified transcript attributes specific hostile statements to Teruko; later verified discovery responses deny requests quoting those statements after objections and document-attachment qualifications.',
    whyItMayConflict:'The formal records attribute and deny the same quoted language, but authentication, context, and the legal scope of the denials remain disputed.',
    alternativeExplanation:'Voice/authentication or context dispute, lack of an attached transcript, qualified legal objection, or memory issue.',
    resolveWith:['Original audio and hash','Recording metadata and event date','Voice authentication','Complete certified transcript and verified RFA language'],
    sources:[sourceByLines('F0144',90,120,2),sourceByLines('F0144',169,187,3),sourceByLines('F0144',246,250,4),sourceByLines('F0267',290,432,4)]
  },
  {
    id:'X0005',category:'email-authorship-and-order-conflict',label:'“Suzie” email, authorship denial, and TalkingParents-only order',allegedActor:'petitioner',allegedActorLabel:'Teruko Miller',confidence:'high-literal-conflict-order-applicability-unresolved',
    eventDate:'2026-05-10',statementDate:'2026-05-10',comparisonDate:'2026-06-24',dateConfidence:'high',
    summary:'An email from Teruko’s address opens “My name is Suzie” and closes “Teruko”; her later response admits the address but denies claiming to be Suzie. A prior order directs visitation communications through TalkingParents only.',
    whyItMayConflict:'The sender line and message language create a literal authorship/identity conflict; direct email may also conflict with the communication channel order depending on who and what the clause binds.',
    alternativeExplanation:'Forwarded or intermediary text, third-party drafting, a shared account, pasted salutation, or an order limited to visitation rather than property communication.',
    resolveWith:['Native email headers and account access history','Testimony from “Suzie” or drafter','Exact operative order and service','Clarification of subject matter and parties bound'],
    sources:[sourceByLines('F0245',305,330,6),sourceByLines('F0267',627,637,11),sourceByLines('F0233',709,713,15)]
  },
  {
    id:'X0006',category:'visitation-count-conflict',label:'Denied six missed visits versus neutral supervisor’s outstanding-hours record',allegedActor:'petitioner',allegedActorLabel:'Teruko Miller',confidence:'medium',
    statementDate:'2026-06-24',comparisonDate:'2026-06-23',dateConfidence:'high',
    summary:'Teruko denied an RFA asking whether six scheduled visits had not occurred; a supervisor email described 21 outstanding hours while attributing unavailable dates to both parents.',
    whyItMayConflict:'The records suggest missed time but use different units and may cover different scopes. Twenty-one hours does not necessarily equal six visits.',
    alternativeExplanation:'Different date ranges, cancellation attribution, visit durations, or RFA wording may reconcile the records.',
    resolveWith:['Supervisor master schedule','Exact RFA service and verification time','Cancellation reasons and attribution','Duration of each scheduled visit'],
    sources:[sourceByLines('F0267',209,213,3),sourceByLines('F0268',230,265,6)]
  },
  {
    id:'X0007',category:'respondent-precision-issue',label:'“Ordered visits/hours” must follow the operative order language',allegedActor:'respondent',allegedActorLabel:'Brandon Miller',confidence:'medium',
    statementDate:'2026-06-29',comparisonDate:'2026-04-20',dateConfidence:'high',
    summary:'Brandon characterized visits and hours as ordered and denied. The March order used “up to” language; the later April order appears to state a fixed twice-weekly schedule.',
    whyItMayConflict:'Using a later fixed schedule for an earlier period could overstate what was mandatory. The operative order must be selected for every missed date.',
    alternativeExplanation:'The statement may be a good-faith reading of the April fixed schedule and actual missed time.',
    resolveWith:['Effective and service dates of each order','Date-by-date schedule','Provider availability and parent cancellations'],
    sources:[sourceByLines('F0195',91,97,2),sourceByLines('F0233',566,590,14),sourceByLines('F0268',120,150,3)]
  },
  {
    id:'X0008',category:'conditional-pressure',label:'Conditional oversight email and possible retaliation pressure',allegedActor:'third-party',allegedActorLabel:'Derek Austin',confidence:'medium-statement-low-offense',
    eventDate:'2025-11-18',statementDate:'2025-11-18',comparisonDate:'2025-11-19',dateConfidence:'high-with-filing-typo-flag',
    summary:'An email asks Brandon to remove the Attorney General from communications and says a state restraining order will be recommended if he does not.',
    whyItMayConflict:'The conditional statement may pressure a person to stop copying an oversight office, but unlawfulness, authority, intent, and reasonable interpretation are not established.',
    alternativeExplanation:'Counsel may have been trying to stop broad or irrelevant mass-copying based on perceived erratic communications.',
    resolveWith:['Complete email thread and headers','Sender authority and agency policy','Recipient account and surrounding communications'],
    sources:[sourceByLines('F0107',161,173,4)]
  },
  {
    id:'X0009',category:'two-sided-criminal-record-precision',label:'Criminal conviction, charge, and filing terminology across sworn records',allegedActor:'both-parties',allegedActorLabel:'Teruko Miller and Brandon Miller — separate statements require review',confidence:'high-wording-conflict-low-intent',
    statementDate:'2024-11-04',comparisonDate:'2026-01-20',dateConfidence:'high-filing-dates-temporal-scope-unresolved',
    summary:'Teruko’s 2024 declaration says Brandon was already convicted, while an attached portal showed an active complaint/arraignment and the declaration elsewhere described charges awaiting dismissal. Brandon later swore there were no criminal filings, charges, or convictions while attaching later no-record letters.',
    whyItMayConflict:'“Convicted,” “charged,” “filed,” “arrested,” “active,” “dismissed,” and “no record found” are not interchangeable. Each statement may be materially overbroad depending on the official docket status and search date.',
    alternativeExplanation:'Colloquial use of “convicted,” later dismissal/sealing, different search databases or identifiers, and a statement limited to current records may explain part of the conflict.',
    resolveWith:['Certified criminal docket and disposition history','Complaint and arraignment records','Dismissal/sealing orders','Search criteria, date, name, and date-of-birth scope for each no-record letter'],
    sources:[sourceByLines('F0003',149,151,2),sourceByLines('F0003',382,394,8),sourceByLines('F0003',417,442,10),sourceByLines('F0142',115,140,2),sourceByLines('F0142',331,333,8)]
  }
];

const orders=[
  {
    id:'O0001',date:'2026-04-20',title:'TalkingParents-only communication term',status:'candidate-conflict',boundActor:'human legal review required',
    obligation:'The order text states that communication between the parties related to visitation shall be through TalkingParents only, with no other form of contact.',
    assessment:'A direct May 10 email creates a candidate conflict. Applicability to the protected party and to property rather than visitation requires review.',
    sources:[sourceByLines('F0233',709,713,15),sourceByLines('F0245',305,330,6),sourceByLines('F0267',627,637,11)]
  },
  {
    id:'O0002',date:'2026-03-25',supersededDate:'2026-04-20',title:'Professionally supervised visitation frequency',status:'disputed',boundActor:'both parties / provider logistics',
    obligation:'The March record offered visits “up to” twice weekly for “up to” three hours; the later April order appears to specify twice weekly for three hours.',
    assessment:'A later supervisor email reports 21 outstanding hours but attributes unavailable dates to both parents. A date-by-date operative-order analysis is required.',
    sources:[sourceByLines('F0195',91,97,2),sourceByLines('F0233',566,590,14),sourceByLines('F0268',230,265,6)]
  },
  {
    id:'O0003',date:'2026-03-25',deadline:'2026-05-15',title:'Personal-property retrieval and civil standby',status:'partial',boundActor:'Brandon and Teruko Miller',
    obligation:'The record sets a May 15 deadline for retrieval and says Teruko shall arrange a civil standby; later communications discuss dates and responsibility.',
    assessment:'The corpus shows a partial compliance offer but does not establish whether pickup occurred by the deadline. Use outcome-not-in-record for final performance.',
    sources:[sourceByLines('F0195',77,86,2),sourceByLines('F0237',556,585,14),sourceByLines('F0245',315,330,6),sourceByLines('F0267',575,596,10)]
  },
  {
    id:'O0004',date:'2025-11-24',title:'Travel itinerary through TalkingParents',status:'outcome-not-in-record',boundActor:'travelling parent',
    obligation:'The order text requires an itinerary through TalkingParents at least seven days before travel.',
    assessment:'A later filing repeats the term and planned travel, but the reviewed sources do not establish that an itinerary was withheld.',
    sources:[sourceByLines('F0120',69,74,1),sourceByLines('F0253',453,459)]
  },
  {
    id:'O0005',date:'2025-10-27',title:'Preparation of findings/order after hearing',status:'satisfied',boundActor:"Petitioner's counsel",
    obligation:'The court directed petitioner’s counsel to prepare an order after hearing for review and identify needed documents.',
    assessment:'Later proposed-order correspondence and the filed findings/order indicate preparation occurred; the reviewed excerpt does not support criminalizing delay.',
    sources:[sourceByLines('F0086',59,63,1),sourceByPattern('F0115',/proposed order|order after hearing/i),sourceByPattern('F0131',/findings and order after hearing/i)]
  }
];

const motives=[
  {
    id:'M0001',actor:'petitioner',actorLabel:'Teruko Miller',hypothesis:'Custody and contact positioning',confidence:'medium-incentive-low-criminal-intent',status:'hypothesis — human review required',
    summary:'Maintaining supervised-only contact or reducing contact could provide litigation leverage while custody remains contested.',
    allegedConduct:['Visitation agreement/denial conflict','Makeup-time conduct','Safety-risk narrative'],
    contraryConsiderations:['Genuine safety concerns','Provider availability','Travel conflicts','Need for court-authorized makeup time'],
    sources:[sourceByLines('F0136',320,329,5),sourceByLines('F0137',177,229,4),sourceByLines('F0267',209,228,3),sourceByLines('F0268',230,265,6)]
  },
  {
    id:'M0002',actor:'petitioner-side',actorLabel:'Teruko Miller / petitioner-side counsel',hypothesis:'Property or financial leverage',confidence:'medium-incentive-low-knowledge',status:'hypothesis — human review required',
    summary:'Vehicle value, repair cost, payment, and possession positions could affect settlement value or control of marital property.',
    allegedConduct:['Nissan Leaf representation conflict','Property retrieval disputes'],
    contraryConsiderations:['Settlement advocacy','Rapidly changing repair status','Incomplete client/counsel information','Safety and logistics concerns'],
    sources:[sourceByLines('F0189',213,215,4),sourceByLines('F0197',419,442,7),sourceByLines('F0199',115,167,2),sourceByLines('F0245',315,330,6)]
  },
  {
    id:'M0003',actor:'petitioner',actorLabel:'Teruko Miller',hypothesis:'Defensive credibility positioning',confidence:'medium-incentive-low-intent',status:'hypothesis — human review required',
    summary:'Denying adverse attributed audio statements could limit their effect on credibility and custody litigation.',
    allegedConduct:['Certified-audio attribution and RFA denial conflict'],
    contraryConsiderations:['Legitimate authentication challenge','No document attached to the RFA','Context dispute','Memory issue'],
    sources:[sourceByLines('F0144',90,120,2),sourceByLines('F0267',290,432,4)]
  },
  {
    id:'M0004',actor:'respondent',actorLabel:'Brandon Miller',hypothesis:'Custody and Family Code 3044 rebuttal positioning',confidence:'medium-incentive-low-overstatement-intent',status:'hypothesis — human review required',
    summary:'Characterizing missed time as ordered and denied may strengthen a custody-modification or rebuttal narrative.',
    allegedConduct:['Possible overstatement of mandatory visitation hours'],
    contraryConsiderations:['Good-faith reading of the April fixed schedule','Actual missed time','Later order may control much of the period'],
    sources:[sourceByLines('F0195',91,97,2),sourceByLines('F0233',566,590,14),sourceByLines('F0268',120,150,3)]
  },
  {
    id:'M0005',actor:'third-party',actorLabel:'Derek Austin',hypothesis:'Oversight deterrence or communication control',confidence:'medium-statement-low-unlawful-intent',status:'hypothesis — human review required',
    summary:'The conditional email could have been intended to stop copying an oversight office.',
    allegedConduct:['Conditional restraint recommendation'],
    contraryConsiderations:['Managing mass-copying','Perceived harassment','Attempt to narrow irrelevant recipients'],
    sources:[sourceByLines('F0107',161,173,4)]
  }
];

function genericActor(excerpt=''){
  const passage={excerpt,match:''};
  const actor=inferActor(passage,{filingParty:''});
  return actor.label;
}

const timeline=[];
for(const record of records.values()){
  timeline.push({
    id:`T-FILING-${record.id}`,date:record.filingDate,datePrecision:'day',category:'Filing',actor:record.filingParty,
    title:`${record.id} filed — ${record.title}`,summary:record.name,sourceLabel:record.id,sourceCount:1,
    sources:[sourceByLines(record.id,1,Math.min(5,record.lines.length),1)]
  });
  const mentions=extractDateMentions(record.markdown,{recordId:record.id,contextLines:2,maximumResults:800});
  for(const mention of mentions){
    if(mention.page===null) continue;
    const excerpt=mention.excerpt;
    let category='';
    if(/\b(?:therapy|therapist|counsel(?:ing|or)|psycholog|psychiatr|VA\b|RISE\b|IPV\b|Surfside|Gie?mar|Lippert|Evans|McGarry)\b/i.test(excerpt)) category='Treatment / counseling';
    else if(/\b(?:police|sheriff|officer|law enforcement|911|civil standby)\b/i.test(excerpt)) category='Police / official event';
    else if(/\b(?:order|ordered|shall|must|FOAH|ROAH|DV-130|visitation)\b/i.test(excerpt)) category='Order / compliance';
    else if(/\b(?:false statement|misrepresent|admit|denied|sworn|perjury|contradict|impeach)\b/i.test(excerpt)) category='Statement / credibility';
    else if(record.id==='F0133') category='Caton chronology';
    if(!category) continue;
    timeline.push({
      id:`T-${record.id}-${mention.lineStart}-${mention.isoDate}`,date:mention.isoDate,endDate:mention.endDate,datePrecision:mention.precision,category,
      actor:genericActor(excerpt),title:`${category}: ${mention.rawDate}`,summary:excerpt,sourceLabel:record.id,sourceCount:1,
      sources:[sourceFromPassage(record,mention)]
    });
  }
}

const curatedTimeline=[
  ['T-CATON-2021','2021-01-01','range','Caton chronology','Deacon Jon Caton; Brandon and Teruko Miller','Caton counseling relationship begins','Caton states he served as family and pastoral counselor during 2021 through 2023.','F0133',120,123,1],
  ['T-CATON-2022-03-31','2022-03-31','day','Caton chronology','Teruko Miller alleged; Brandon reported; Jon Caton received','Reported suicide-coaxing and verbal abuse disclosure','Caton says Brandon reported specific statements on or about March 31, 2022.','F0133',161,183,2],
  ['T-CATON-2022-04-05','2022-04-05','day','Caton chronology','Teruko Miller alleged; Brandon reported; Jon Caton received','Reported physical-violence disclosure and injury photographs','Caton says Brandon reported being hit and injured and that Caton saw photographs.','F0133',214,230,3],
  ['T-CATON-2022-05','2022-05-01','month','Caton chronology','Teruko Miller alleged; Brandon reported','Reported ongoing abuse and control during May 2022','Caton describes reported yelling, disparagement, and coercive parenting control.','F0133',233,247,3],
  ['T-CATON-2022-06-01','2022-06-01','day','Police / official event','Neighbors/police; Teruko and Brandon Miller','Neighbors reportedly called police after fighting in the home','Caton records Brandon’s report of police involvement, another alleged hit, and a proof-related statement.','F0133',263,270,4],
  ['T-CATON-2022-06-16','2022-06-16','day','Caton chronology','Teruko Miller alleged; Brandon reported; child present','Reported physical incident in front of the child','Caton says Brandon reported being struck in the jaw with a forearm.','F0133',273,282,4],
  ['T-CATON-ADMISSION-UNDATED','2021-01-01','range','Statement / credibility','Teruko Miller; Deacon Jon Caton','Alleged counseling admission — exact date not stated','Caton says Teruko admitted striking Brandon during an argument and then blamed him; the exact session date is absent.','F0133',285,303,4],
  ['T-CATON-FILED','2025-12-31','day','Filing','Deacon Jon Caton; Brandon Miller','Caton declaration filed and executed','The filing stamp shows 5:02 PM and Caton signs under penalty of perjury.','F0133',327,342,5],
  ['T-VA-2023-02-01','2023-02-01','day','Treatment / counseling','Brandon Miller; Dr. Csilla Lippert','VA treatment relationship begins','Lippert states she and Brandon have worked together since February 1, 2023.','F0265',60,69,1],
  ['T-VA-2023-05-18','2023-05-18','day','Treatment / counseling','Brandon and Teruko Miller; Giemar Fernandez, LCSW','VA counseling session with documented interruption','The embedded VA note says Teruko entered Brandon’s session, challenged his account, and was asked to provide privacy.','F0118',1009,1127,25],
  ['T-VA-2023-05-25','2023-05-25','day','Treatment / counseling','Brandon Miller; Giemar Fernandez, LCSW','VA discharge/follow-up session','The embedded VA note records a 25-minute discharge/follow-up and recommends mental-health and Lippert follow-up.','F0118',847,985,21],
  ['T-SURFSIDE-2024-10-11','2024-10-11','day','Treatment / counseling','Brandon and Teruko Miller; Linka M. Griswold, PsyD','Surfside joint couples-therapy assessment','The provider note begins with both parties present and records both perspectives and recommendations.','F0118',1314,1637,34],
  ['T-SURFSIDE-2024-10-12','2024-10-12','day','Treatment / counseling','Brandon Miller; Linka M. Griswold, PsyD','Surfside individual/relationship session','The provider note discusses financial and relationship distress and continued treatment.','F0118',1647,1770,41],
  ['T-SURFSIDE-2024-10-28','2024-10-28','day','Treatment / counseling','Brandon Miller; Linka M. Griswold, PsyD','Next Surfside session scheduled','The October 12 note schedules a next session for Monday the 28th at 5 PM; occurrence is not established.','F0118',1749,1763,43],
  ['T-RISE-2025-04-30','2025-04-30','day','Treatment / counseling','Brandon Miller; Darcie Evans, LCSW','RISE intake communication','Evans thanks Brandon for their conversation, sends RISE materials, and confirms a scheduled start.','F0174',529,550,14],
  ['T-RISE-2025-05-09','2025-05-09','day','Treatment / counseling','Brandon Miller; RISE','Scheduled RISE start','Evans says Brandon is scheduled to begin RISE by video; this email alone does not prove attendance.','F0174',535,540,14],
  ['T-RISE-2025-08-25','2025-08-25','day','Treatment / counseling','Brandon Miller; Megan McGarry, LCSW','IPVAP session supported by same-day reply','McGarry sends last-session measures; Brandon replies that it was nice to see her again that day.','F0174',632,662,18]
];
for(const [id,date,datePrecision,category,actor,title,summary,recordId,lineStart,lineEnd,page] of curatedTimeline){
  const record=records.get(recordId); if(!record) continue;
  timeline.push({id,date,datePrecision,category,actor,title,summary,sourceLabel:recordId,sourceCount:1,sources:[sourceByLines(recordId,lineStart,Math.min(lineEnd,record.lines.length),page)]});
}

const additionalTreatmentTimeline=[
  {id:'T-SIERRA-2023-08-30',date:'2023-08-30',datePrecision:'day',status:'occurred',factualPosture:'provider-letter',actor:'Brandon Miller; Sierra Health + Wellness',title:'Intensive outpatient mental-health program begins',summary:'A Sierra letter states Brandon was admitted from August 30 through November 9, 2023 for group, individual, and family therapy.',recordId:'F0008',lineStart:1208,lineEnd:1221,page:27},
  {id:'T-SIERRA-2023-11-09',date:'2023-11-09',datePrecision:'day',status:'occurred',factualPosture:'provider-letter',actor:'Brandon Miller; Sierra Health + Wellness',title:'Intensive outpatient program interval ends',summary:'Provider letter gives November 9 as the end of the documented program interval.',recordId:'F0008',lineStart:1208,lineEnd:1221,page:27},
  {id:'T-VA-ANGER-2024-05-08',date:'2024-05-08',datePrecision:'day',status:'occurred',factualPosture:'certificate-visual-check-needed',actor:'Brandon Miller; Dan Gutkind, PhD',title:'VA anger-management course completion',summary:'Source page visually identifies completion of a 12–16 hour Anger Management Skills for Veterans course; Markdown OCR is defective.',recordId:'F0008',lineStart:1267,lineEnd:1277,page:29},
  {id:'T-VA-CONSULT-2024-05-13',date:'2024-05-13',datePrecision:'day',status:'recorded',factualPosture:'VA-record',actor:'Brandon Miller; VA Community Care',title:'Mental-health consult opened',summary:'VA note opens a Community Care mental-health consult.',recordId:'F0118',lineStart:1362,lineEnd:1394,page:35},
  {id:'T-VA-SURFSIDE-REFERRAL-2024-05-23',date:'2024-05-23',datePrecision:'day',status:'authorized',factualPosture:'referral-not-attendance',actor:'Brandon Miller; VA Community Care; Surfside',title:'Surfside mental-health services authorized',summary:'VA letter approves Community Care services and identifies Surfside Online Therapy and Linka Griswold; this is not proof of attendance.',recordId:'F0118',lineStart:1229,lineEnd:1304,page:31},
  {id:'T-POLICE-COUNSELING-2024-09-08',date:'2024-09-08',datePrecision:'day',status:'reported',factualPosture:'police-report-statements',actor:'Brandon and Teruko Miller; Monterey Police',title:'Both parties reportedly described ongoing counseling',summary:'The police report records Brandon and Teruko separately saying both were receiving or attending counseling; provider and appointment dates are not specified.',recordId:'F0003',lineStart:828,lineEnd:864,page:29},
  {id:'T-VA-PSYCH-2024-09-16',date:'2024-09-16',datePrecision:'day',status:'occurred',factualPosture:'provider-letter',actor:'Brandon Miller; VA psychiatry',title:'Psychiatry appointment',summary:'A November 5 VA letter identifies September 16 as the last psychiatry appointment.',recordId:'F0008',lineStart:1235,lineEnd:1255,page:28},
  {id:'T-VA-THERAPY-2024-10-24',date:'2024-10-24',datePrecision:'day',status:'occurred',factualPosture:'provider-letter',actor:'Brandon Miller; VA therapist',title:'Therapy appointment',summary:'A November 5 VA letter identifies October 24 as the last therapy appointment.',recordId:'F0008',lineStart:1235,lineEnd:1255,page:28},
  {id:'T-VA-LETTER-2024-11-05',date:'2024-11-05',datePrecision:'day',status:'attested',factualPosture:'provider-letter',actor:'Vanessa Jones, LCSW; Brandon Miller',title:'VA treatment-verification letter',summary:'Letter confirms individual therapy, psychiatry, and identified recent and next appointments.',recordId:'F0008',lineStart:1235,lineEnd:1255,page:28},
  {id:'T-VA-PSYCH-SCHEDULED-2024-12-13',date:'2024-12-13',datePrecision:'day',status:'scheduled',factualPosture:'scheduled-not-proven-attended',actor:'Brandon Miller; VA psychiatry',title:'Psychiatry appointment scheduled',summary:'The VA letter lists December 13 as the next scheduled appointment.',recordId:'F0008',lineStart:1235,lineEnd:1244,page:28},
  {id:'T-RISE-ASSERTION-2025-03-21',date:'2025-03-21',datePrecision:'day',status:'reported',factualPosture:'party-self-report',actor:'Brandon Miller',title:'VA IPV-track participation asserted',summary:'Brandon states he is in a VA IPV track; no program-specific record is attached at this marker.',recordId:'F0043',lineStart:553,lineEnd:586,page:12},
  {id:'T-SURFSIDE-ADDENDA-2025-04-28',date:'2025-04-28',datePrecision:'day',status:'recorded',factualPosture:'record-incorporation-not-session',actor:'VA Community Care',title:'Surfside notes incorporated into VA record',summary:'VA staff addenda incorporate the October 2024 Surfside notes; this is a record date, not a therapy-session date.',recordId:'F0118',lineStart:1618,lineEnd:1636,page:40},
  {id:'T-REUNIFICATION-2025-05-26',date:'2025-05-26',datePrecision:'day',status:'recommended',factualPosture:'supervisor-recommendation-not-attendance',actor:'Both parents; visitation supervisor',title:'Family-reunification therapy recommended',summary:'Supervisor states visits would pause after May 29–30 and recommends family-reunification therapy.',recordId:'F0061',lineStart:1665,lineEnd:1669,page:39},
  {id:'T-IPVAP-2025-08-12',date:'2025-08-12',datePrecision:'day',status:'canceled',factualPosture:'appointment-screenshot',actor:'Brandon Miller; Megan McGarry, LCSW',title:'IPVAP appointment canceled',summary:'Inbox screenshot shows an August 12 booking canceled August 11; visually recheck before report use.',recordId:'F0174',lineStart:618,lineEnd:622,page:17},
  {id:'T-IPVAP-2025-08-13',date:'2025-08-13',datePrecision:'day',status:'canceled',factualPosture:'appointment-screenshot',actor:'Brandon Miller; Megan McGarry, LCSW',title:'IPVAP appointment canceled',summary:'Inbox screenshot shows an August 13 booking canceled August 12; visually recheck before report use.',recordId:'F0174',lineStart:618,lineEnd:622,page:17},
  {id:'T-IPVAP-2025-08-19',date:'2025-08-19',datePrecision:'day',status:'canceled',factualPosture:'appointment-screenshot',actor:'Brandon Miller; Megan McGarry, LCSW',title:'IPVAP appointment canceled',summary:'Inbox screenshot shows an August 19 booking canceled August 17; visually recheck before report use.',recordId:'F0174',lineStart:618,lineEnd:622,page:17},
  {id:'T-IPVAP-2025-08-21',date:'2025-08-21',datePrecision:'day',status:'schedule-unclear',factualPosture:'appointment-screenshot',actor:'Brandon Miller; Megan McGarry, LCSW',title:'IPVAP appointment time changed',summary:'Inbox screenshot shows a booking and a changed-time message; final attendance is unclear.',recordId:'F0174',lineStart:618,lineEnd:622,page:17},
  {id:'T-IPVAP-2025-08-26',date:'2025-08-26',datePrecision:'day',status:'recorded',factualPosture:'post-session-email',actor:'Brandon Miller; Megan McGarry, LCSW',title:'Post-session measures acknowledged',summary:'McGarry acknowledges returned measures following the August 25 session evidence.',recordId:'F0174',lineStart:672,lineEnd:677,page:19},
  {id:'T-IPV-COMPLETION-ASSERTION-2025-09-10',date:'2025-09-10',datePrecision:'day',status:'reported',factualPosture:'party-self-report-no-certificate',actor:'Brandon Miller',title:'IPV course completion asserted',summary:'Brandon states he graduated IPV courses; no provider-issued completion certificate appears at this marker.',recordId:'F0068',lineStart:603,lineEnd:626,page:15},
  {id:'T-VA-RISE-ATTESTATION-2026-06-17',date:'2026-06-17',datePrecision:'day',status:'attested',factualPosture:'treating-physician-letter',actor:'Brandon Miller; Dr. Csilla Lippert',title:'VA treatment and active RISE participation attested',summary:'Lippert attests to treatment, referral, active participation, and perceived benefit; no completion date is supplied.',recordId:'F0265',lineStart:56,lineEnd:70,page:1}
];
for(const event of additionalTreatmentTimeline){
  const record=records.get(event.recordId); if(!record) continue;
  timeline.push({...event,category:'Treatment / counseling',filedDate:record.filingDate,sourceLabel:event.recordId,sourceCount:1,sources:[sourceByLines(event.recordId,event.lineStart,event.lineEnd,event.page)]});
}

for(const comparison of crossReferences){
  if(comparison.statementDate){timeline.push({id:`T-${comparison.id}-STATEMENT`,date:comparison.statementDate,datePrecision:'day',category:'Statement / credibility',actor:comparison.allegedActorLabel,title:`Statement date — ${comparison.label}`,summary:comparison.summary,sourceLabel:comparison.sources[0]?.recordId||comparison.id,sourceCount:comparison.sources.length,crossReferenceId:comparison.id,sources:comparison.sources});}
  if(comparison.comparisonDate){timeline.push({id:`T-${comparison.id}-COMPARISON`,date:comparison.comparisonDate,datePrecision:'day',category:'Contradiction / impeachment',actor:comparison.allegedActorLabel,title:`Comparison date — ${comparison.label}`,summary:comparison.whyItMayConflict,sourceLabel:comparison.sources.at(-1)?.recordId||comparison.id,sourceCount:comparison.sources.length,crossReferenceId:comparison.id,sources:comparison.sources});}
}
for(const order of orders){timeline.push({id:`T-${order.id}`,date:order.date,datePrecision:'day',category:'Court order',actor:order.boundActor,title:order.title,summary:`Status: ${order.status}. ${order.assessment}`,sourceLabel:order.sources[0]?.recordId||order.id,sourceCount:order.sources.length,orderId:order.id,sources:order.sources});}

const uniqueTimeline=[...new Map(timeline.map(item=>[`${item.id}|${item.date}`,item])).values()].sort((left,right)=>left.date.localeCompare(right.date)||left.id.localeCompare(right.id));

const mapNodes=[
  {id:'P-PETITIONER',lane:'People',label:'Teruko Miller — Petitioner',summary:'Alleged actor or speaker in several source conflicts; every attribution remains reviewable.'},
  {id:'P-RESPONDENT',lane:'People',label:'Brandon Miller — Respondent',summary:'Filer, alleged victim, and alleged actor in the visitation-hours precision issue.'},
  {id:'P-ZOLLMANN',lane:'People',label:'Johanna Zollmann — neutral supervisor',summary:'Provides a competing account of visitation scheduling and later sworn descriptions.'},
  {id:'P-CATON',lane:'People',label:'Deacon Jon Caton — family counselor',summary:'Reports contemporaneous counseling communications and a claimed admission.'},
  {id:'P-LIPPERT',lane:'People',label:'Dr. Csilla Lippert — VA physician',summary:'Attests to treatment relationship and RISE IPV referral/participation.'},
  ...crossReferences.map(item=>({id:item.id,lane:'Statements & conduct',label:item.label,summary:item.summary,recordType:'cross-reference'})),
  ...orders.map(item=>({id:item.id,lane:'Evidence & orders',label:item.title,summary:`${item.status}: ${item.assessment}`,recordType:'order'})),
  ...motives.map(item=>({id:item.id,lane:'Motive hypotheses',label:item.hypothesis,summary:`${item.actorLabel}: ${item.summary}`,recordType:'motive'}))
];
const mapEdges=[];
function edge(from,to,label,summary=''){mapEdges.push({id:`E-${String(mapEdges.length+1).padStart(3,'0')}`,from,to,label,summary});}
for(const id of ['X0001','X0002','X0003','X0004','X0005','X0006']) edge('P-PETITIONER',id,'linked to','Source comparison attributes a statement or conduct issue to the petitioner side.');
edge('P-PETITIONER','X0009','statement requires review','The criminal-record terminology cluster includes a petitioner statement.');
edge('P-RESPONDENT','X0009','statement requires review','The criminal-record terminology cluster also includes a respondent statement.');
edge('P-RESPONDENT','X0007','linked to','Precision review of respondent’s characterization.'); edge('P-ZOLLMANN','X0001','provides counter-account'); edge('P-CATON','X0004','contextual evidence'); edge('P-LIPPERT','M0001','provides treatment context');
edge('X0005','O0001','possible order conflict'); edge('X0006','O0002','schedule evidence'); edge('X0007','O0002','qualified by operative order');
edge('X0001','M0001','supports hypothesis'); edge('X0002','M0001','supports hypothesis'); edge('X0003','M0002','supports hypothesis'); edge('X0004','M0003','supports hypothesis'); edge('X0007','M0004','supports hypothesis'); edge('X0008','M0005','supports hypothesis');

const TOPIC_RULES=[
  ['visitation-supervision',/visitation supervisor|supervised visitation/i],['nissan-leaf',/Nissan Leaf/i],['criminal-record',/criminal (?:record|charge|conviction|case)|convicted/i],
  ['audio-transcript',/audiotape|audio transcript|certified transcript/i],['talkingparents',/TalkingParents/i],['property-retrieval',/personal property|civil standby|retrieve/i],
  ['travel-itinerary',/travel itinerary|itinerary/i],['treatment-counseling',/therapy|counseling|psychiatr|RISE|IPV/i],['police-record',/police|sheriff|law enforcement/i],
  ['financial-income',/income and expense|financial|asset/i],['firearm',/firearm|gun/i],['child-safety',/safety risk|child safety/i],['domestic-violence',/domestic violence|abuse/i],
  ['court-order',/court order|ordered that|findings and order/i],['service-notice',/proof of service|served|notice/i]
];
const topicsByRecord=new Map([...records.values()].map(record=>[record.id,new Set(TOPIC_RULES.filter(([,pattern])=>pattern.test(record.markdown)).map(([id])=>id))]));
let screenedPairs=0; let pairsWithSharedTopics=0;
const recordIds=[...records.keys()];
for(let left=0;left<recordIds.length;left++) for(let right=left+1;right<recordIds.length;right++){
  screenedPairs++;
  const leftTopics=topicsByRecord.get(recordIds[left]); const rightTopics=topicsByRecord.get(recordIds[right]);
  if([...leftTopics].some(topic=>rightTopics.has(topic))) pairsWithSharedTopics++;
}
for(const filing of filings) filing.crossScreenTopics=[...(topicsByRecord.get(filing.recordId)||[])];

const categoryCounts=Object.fromEntries(THEORY_RULES.map(rule=>[rule.id,findings.filter(item=>item.category===rule.id).length]));
const result={
  schemaVersion:1,
  caseId:index.caseId,
  generatedAt:new Date().toISOString(),
  posture:{
    label:'Automated investigative leads — not findings of guilt',
    statement:'Every allegation, contradiction, motive, and order status requires human comparison to the complete original record.',
    prohibitedInference:'A contradiction, filing title, or accusation does not by itself establish a crime, knowing falsity, intent, or a charge.'
  },
  coverage:{filingsScanned:index.filings.length,markdownScanned:index.filings.length,filingsRepresented:filings.length,filingsWithLeads:filings.filter(item=>item.findingCount).length,filingsWithoutLeads:filings.filter(item=>!item.findingCount).length,crossRecordPairsScreened:screenedPairs,pairsWithSharedTopics,curatedCrossReferences:crossReferences.length},
  categoryCounts,
  filings,
  findings,
  crossReferences,
  timeline:uniqueTimeline,
  orders,
  motives,
  map:{lanes:['People','Statements & conduct','Evidence & orders','Motive hypotheses'],nodes:mapNodes,edges:mapEdges}
};

await mkdir(analysisRoot,{recursive:true});
await writeFile(path.join(analysisRoot,'investigative-analysis.json'),JSON.stringify(result,null,2),'utf8');
console.log(JSON.stringify({coverage:result.coverage,findings:findings.length,timeline:uniqueTimeline.length,crossReferences:crossReferences.length,orders:orders.length,motives:motives.length,categoryCounts},null,2));
