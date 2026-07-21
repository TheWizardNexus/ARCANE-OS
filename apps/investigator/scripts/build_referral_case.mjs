import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {cleanExcerpt,pageAtLine,pageMarkers,textLines} from '../../../arcane/modules/RecordPassageIndex.js';

const appRoot=path.resolve(import.meta.dirname,'..');
const caseRoot=path.join(appRoot,'data','cases','24FL001068');
const referralRoot=path.join(caseRoot,'Referral');
const index=JSON.parse(await readFile(path.join(caseRoot,'case-index.json'),'utf8'));
const analysis=JSON.parse(await readFile(path.join(caseRoot,'Analysis','investigative-analysis.json'),'utf8'));
const contactOverrides=JSON.parse(await readFile(path.join(referralRoot,'contact-overrides.json'),'utf8'));
const filings=new Map(index.filings.map(item=>[item.id,item]));
const analysisItems=new Map([...analysis.findings,...analysis.crossReferences].map(item=>[item.id,item]));
const markdownCache=new Map();

async function recordText(recordId){
  if(markdownCache.has(recordId)) return markdownCache.get(recordId);
  const record=filings.get(recordId);
  if(!record) throw new Error(`Unknown record ${recordId}`);
  const markdown=await readFile(path.join(caseRoot,...record.markdownPath.split('/')),'utf8');
  const value={record,lines:textLines(markdown)};
  value.markers=pageMarkers(value.lines);
  markdownCache.set(recordId,value);
  return value;
}

async function citation(recordId,page,lineStart,lineEnd,{role='support',sourceTier='',pageOverride=null,note=''}={}){
  const {record,lines,markers}=await recordText(recordId);
  const extractedPage=pageAtLine(markers,lineStart-1);
  if(pageOverride===null&&extractedPage!==page){
    throw new Error(`${recordId} line ${lineStart} resolves to PDF page ${extractedPage}, expected ${page}`);
  }
  return {
    id:`S-${recordId}-P${pageOverride??page}-L${lineStart}-${lineEnd}`,
    recordId,
    filename:record.name,
    title:record.title,
    filedDate:record.filingDate,
    filingParty:record.filingParty,
    pdfPath:record.pdfPath,
    markdownPath:record.markdownPath,
    page:pageOverride??page,
    extractedPage,
    lineStart,
    lineEnd,
    excerpt:cleanExcerpt(lines,lineStart-1,lineEnd-1,{maximumLength:2200}),
    role,
    sourceTier:sourceTier||'filed-record',
    note
  };
}

function itemSource(itemId,index,{role='support',note=''}={}){
  const item=analysisItems.get(itemId);
  const source=item?.sources?.[index];
  if(!source) throw new Error(`Missing source ${index} on ${itemId}`);
  return {
    id:`S-${source.recordId}-P${source.page}-L${source.lineStart}-${source.lineEnd}`,
    ...source,
    role,
    note
  };
}

function element(id,proposition,status,fact,sourceIds=[],gap=''){
  return {id,proposition,status,fact,sourceIds,gap};
}

function contact(id,role,name,sourceIds=[]){
  const value=contactOverrides.contacts.find(item=>item.id===id);
  if(!value) throw new Error(`Missing private contact override ${id}`);
  const summary=[value.address,value.phone,value.email,value.note].filter(Boolean).join(' · ');
  return {id,role,name,contact:summary,contactDetails:value,sourceIds};
}

const sources={
  convictionStatement:itemSource('C-F0003-001',0),
  convictionOath:itemSource('C-F0003-001',1),
  activeDocket:itemSource('C-F0003-001',2),
  brandonNoFilings:itemSource('C-F0142-001',0,{role:'contrary'}),
  brandonNoFilingsOath:itemSource('C-F0142-001',1,{role:'contrary'}),
  catonAdmission:itemSource('C-F0133-001',0),
  audioP2:itemSource('X0004',0),
  audioP3:itemSource('X0004',1),
  audioP4:itemSource('X0004',2),
  audioRfa:itemSource('X0004',3),
  suzieEmail:itemSource('C-F0245-001',0),
  suzieDenial:itemSource('C-F0245-001',1),
  visitationOnlyOrder:itemSource('C-F0245-001',2,{role:'contrary',note:'The operative text is visitation-only. Visual review places this clause on source PDF page 17; the Markdown marker reports page 15.'}),
  catonMarch:await citation('F0133',2,164,178,{sourceTier:'third-party-declaration'}),
  catonApril:await citation('F0133',3,214,230,{sourceTier:'third-party-declaration'}),
  catonJune:await citation('F0133',4,263,282,{sourceTier:'third-party-declaration'}),
  catonOath:await citation('F0133',5,330,337,{sourceTier:'third-party-declaration'}),
  audioCertificate:await citation('F0144',5,287,315,{role:'limitation',sourceTier:'reporter-transcript',note:'The certificate page is facially unsigned and undated in the supplied PDF.'}),
  rfaVerification:await citation('F0267',11,644,652,{sourceTier:'verified-party-response'}),
  phoneAccount:await citation('F0158',12,720,768,{sourceTier:'reporter-transcript',note:'The reporter certificate in this supplied transcript is facially unsigned and undated.'}),
  phoneCondition:await citation('F0158',14,846,894,{sourceTier:'reporter-transcript'}),
  keysProvided:await citation('F0158',15,909,945,{role:'contrary',sourceTier:'reporter-transcript'}),
  phoneCertificate:await citation('F0158',17,1040,1068,{role:'limitation',sourceTier:'reporter-transcript',note:'The certificate page is facially unsigned and undated in the supplied PDF.'}),
  phoneFileDate:await citation('F0068',2,168,174,{sourceTier:'party-declaration'}),
  phoneStill:await citation('F0068',22,820,829,{sourceTier:'party-declaration'}),
  suzieVerification:await citation('F0267',11,644,652,{sourceTier:'verified-party-response'}),
  brandonContact:await citation('F0269',1,34,41,{sourceTier:'filed-contact'}),
  johannaContact:await citation('F0269',1,53,57,{sourceTier:'filed-contact'}),
  terukoContact:await citation('F0230',1,57,64,{sourceTier:'filed-contact'}),
  terukoEmail:await citation('F0247',3,97,103,{sourceTier:'filed-contact'}),
  mayberryContact:await citation('F0267',1,100,109,{sourceTier:'filed-contact'}),
  catonContact:await citation('F0008',42,1639,1669,{sourceTier:'filed-contact'}),
  johannaPhone:await citation('F0137',8,326,334,{sourceTier:'filed-contact'}),
  reporterContact:await citation('F0144',1,53,82,{sourceTier:'filed-contact'})
  ,googleSession:await citation('F0043',32,1353,1373,{sourceTier:'party-exhibit'}),
  laterAccessDate:await citation('F0172',4,214,235,{sourceTier:'party-declaration',note:'The cited passage spans extracted PDF pages 4-5.'}),
  mobileAssociation:await citation('F0043',47,1722,1746,{sourceTier:'party-exhibit'}),
  clerkSearch:await citation('F0142',10,360,381,{sourceTier:'clerk-certificate',note:'The clerk certificate is embedded on parent filing PDF page 10.'}),
  policeMay28Summary:await citation('F0170',12,450,500,{role:'mixed',sourceTier:'police-report',note:'Filed copy of MPD report YG2202018. Obtain the native/certified report, CAD, and identified body-worn-camera media.'}),
  policeMay28Neighbor:await citation('F0170',13,513,564,{role:'mixed',sourceTier:'police-report',note:'The officer records Teruko\'s denial of physical contact and neighbor Allison Smith\'s contrary auditory account; the neighbor did not report seeing the event.'}),
  temporaryOrderDenied:await citation('F0245',1,128,140,{role:'contrary',sourceTier:'court-order'}),
  strikeDenial:await citation('F0267',7,444,486,{role:'contrary',sourceTier:'verified-party-response',note:'The passage continues onto PDF page 8.'})
};

// Correct the visually verified page for the visitation-only clause without changing the parent analysis index.
sources.visitationOnlyOrder={
  ...sources.visitationOnlyOrder,
  id:`S-${sources.visitationOnlyOrder.recordId}-P17-L${sources.visitationOnlyOrder.lineStart}-${sources.visitationOnlyOrder.lineEnd}`,
  page:17,
  extractedPage:15
};

const authority={
  perjury:{label:'California Penal Code section 118 - perjury / false declaration screen',url:'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=118.',asOf:'2026-07-18'},
  declaration:{label:'California Code of Civil Procedure section 2015.5 - unsworn declaration requirements',url:'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CCP&sectionNum=2015.5.',asOf:'2026-07-18'},
  authentication:{label:'California Evidence Code section 1400 - authentication',url:'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=EVID&sectionNum=1400.',asOf:'2026-07-18'},
  domesticBattery:{label:'California Penal Code sections 242 and 243(e)(1) - domestic battery screen',url:'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=243.',asOf:'2026-07-18'},
  corporalInjury:{label:'California Penal Code section 273.5 - corporal injury screen',url:'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=273.5.',asOf:'2026-07-18'},
  computerAccess:{label:'California Penal Code section 502 - unauthorized computer access screen',url:'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=502.',asOf:'2026-07-18'},
  limitations:{label:'California Penal Code sections 801.5, 801.7, 802, 803, 803.6, and 803.7 - limitations review',url:'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=803.6.',asOf:'2026-07-18'}
};

const candidates=[
  {
    id:'RC-01',rank:1,actor:'Teruko Miller',side:'petitioner',title:'Sworn "already convicted" assertion versus the attached active-case record',
    offenseTheory:'Penal Code section 118 perjury / false-declaration screen',
    victimTarget:'Court fact-finding and Brandon Miller\'s status in DVRO and custody litigation',
    eventVenue:'November 4, 2024 filing in Monterey County Superior Court',
    rankBasis:'Highest current intake utility because the oath, challenged statement, and contradictory active-case portal appear in the same filing; rank is not charge probability.',
    evidencePosture:'Direct same-filing documentary conflict; certified historical disposition and knowledge evidence remain missing',
    investigativeUrgency:'high',
    principalBlocker:'Certified complete 23CR009384 disposition as of November 4, 2024 and proof of knowing falsity',
    immediateActionId:'REQ-01',
    status:'elements-partially-supported',readiness:'Focused perjury investigation; not charge-ready',eventDates:['2024-11-04'],discoveryDate:'2024-11-04',findingIds:['C-F0003-001','C-F0142-001','X0009'],
    authority:[authority.perjury,authority.declaration,authority.authentication,authority.limitations],
    assessment:'The declaration states that Brandon had already been convicted, while its own attached portal shows an active misdemeanor complaint and arraignment with no listed conviction. The same filing is signed under penalty of perjury. A certified complete docket and drafting/knowledge evidence are still required.',
    materiality:'The statement was offered in support of a domestic-violence restraining-order request and could affect dangerousness, credibility, custody, and visitation decisions.',
    elements:[
      element('RC-01-E1','A legally authorized oath or declaration under penalty of perjury','supported','The filing contains penalty-of-perjury language.',[sources.convictionOath.id]),
      element('RC-01-E2','A specific factual proposition was stated as true','supported','The declaration says Brandon was "already convicted" and identifies case 23CR009384.',[sources.convictionStatement.id]),
      element('RC-01-E3','The proposition was objectively false when made','partial','The attached portal shows an active complaint and arraignment but is not a certified complete disposition history.',[sources.activeDocket.id],'Obtain the certified docket, plea, diversion, dismissal, sealing, and disposition history as of November 4, 2024.'),
      element('RC-01-E4','The proposition was material','partial','The statement appears in a DVRO declaration and is used as dangerousness history.',[sources.convictionStatement.id,sources.convictionOath.id],'Document how the statement was presented to and relied upon by the court.'),
      element('RC-01-E5','The declarant knew the proposition was false and acted willfully','missing','The record does not identify the drafter or establish what Teruko understood about the criminal case on the statement date.',[],'Interview Teruko and drafting counsel; obtain contemporaneous communications and the complete criminal file.'),
      element('RC-01-E6','Falsity is corroborated as required by section 118(b)','partial','The portal is a record independent of a one-person contradiction, but its completeness and certification remain unresolved.',[sources.activeDocket.id],'Obtain a certified court record and clerk foundation.')
    ],
    sourceIds:[sources.convictionStatement.id,sources.convictionOath.id,sources.activeDocket.id],
    contrarySourceIds:[sources.brandonNoFilings.id,sources.brandonNoFilingsOath.id],
    defenses:['"Convicted" may have been colloquial shorthand or a drafting error.','An unshown plea, diversion, or deferred disposition may have existed.','The portal page may be incomplete.','Counsel may have drafted the wording without Teruko appreciating the legal distinction.'],
    blockingGaps:['Certified complete criminal docket as of the statement date','Evidence of authorship and contemporaneous knowledge','Materiality and reliance evidence','Section 118(b)-adequate corroboration'],
    actionIds:['REQ-01','REQ-02','REQ-03'],motiveId:'M-01'
  },
  {
    id:'RC-02',rank:2,actor:'Teruko Miller',side:'petitioner',title:'Reporter transcript statements versus later verified Request-for-Admission denials',
    offenseTheory:'Penal Code section 118 screen based on verified denials, contingent on authentication, falsity, knowledge, and materiality',
    victimTarget:'Court discovery and fact-finding process; underlying statements concern Brandon Miller',
    eventVenue:'June 24, 2026 verification in Monterey County Superior Court; recording date unresolved',
    rankBasis:'High-specificity record conflict with urgent native-audio preservation needs; rank is not charge probability.',
    evidencePosture:'Reporter-prepared transcript versus verified denials; native audio, voice identity, date, and signed certificate remain missing',
    investigativeUrgency:'critical',
    principalBlocker:'Native authenticated audio and proof that the verified denials were knowingly and materially false',
    immediateActionId:'REQ-04',
    status:'elements-partially-supported',readiness:'High record conflict; authenticate original audio before offense referral',eventDates:[],discoveryDate:'2026-06-24',findingIds:['X0004'],
    authority:[authority.perjury,authority.declaration,authority.authentication,authority.limitations],
    assessment:'A reporter-prepared transcript attributes specific statements to Teruko. Later verified discovery responses deny requests quoting those statements after objections and a stated reasonable inquiry. The supplied reporter certificate is facially unsigned and undated, and the underlying recording date is unresolved.',
    materiality:'The denials concern party conduct and credibility in active family and DVRO proceedings, but the exact material issue and legal effect require prosecutor review.',
    elements:[
      element('RC-02-E1','A legally authorized verified response','supported','Teruko signed a verification under penalty of perjury dated June 24, 2026.',[sources.rfaVerification.id]),
      element('RC-02-E2','A specific proposition was denied','supported','The responses deny requests quoting identified transcript statements after stated objections and reasonable inquiry.',[sources.audioRfa.id]),
      element('RC-02-E3','The denial was objectively false','partial','The transcript attributes the words to Teruko, but the original audio, event date, voice identification, and complete context are not authenticated.',[sources.audioP2.id,sources.audioP3.id,sources.audioP4.id],'Preserve and authenticate the original recording and obtain a signed reporter certificate/workfile.'),
      element('RC-02-E4','The denial was material','partial','The statements bear on credibility and alleged abuse, but the report must identify the precise issue on which the denial could influence a decision.',[sources.audioRfa.id],'Obtain the full discovery set, motion use, and court reliance history.'),
      element('RC-02-E5','The declarant knew the denial was false and acted willfully','missing','The response says the transcript was vague, unattached, and could not be confirmed after reasonable inquiry.',[sources.audioRfa.id],'Establish what audio/transcript was supplied, what inquiry occurred, memory, voice identity, and counsel/client drafting roles.'),
      element('RC-02-E6','The original evidence is authenticated','missing','The supplied certificate page is unsigned and undated, and no native audio/hash is in the filing corpus.',[sources.audioCertificate.id],'Obtain the native recording, metadata, hash, device/cloud provenance, signed CSR certificate, and reporter testimony.')
    ],
    sourceIds:[sources.audioP2.id,sources.audioP3.id,sources.audioP4.id,sources.audioRfa.id,sources.rfaVerification.id],
    contrarySourceIds:[sources.audioCertificate.id],
    defenses:['Voice, completeness, context, and event date are unresolved.','The RFA responses expressly objected that no transcript was attached and stated that reasonable inquiry was insufficient.','Memory or a good-faith qualification may defeat knowing falsity.','Hostile words alone do not establish a criminal threat.'],
    blockingGaps:['Native audio and hash','Recording date and full context','Voice authentication','Signed reporter certificate and workfile','Proof of what was available for the stated reasonable inquiry','Materiality and willfulness evidence'],
    actionIds:['REQ-04','REQ-05','REQ-06'],motiveId:'M-02'
  },
  {
    id:'RC-03',rank:3,actor:'Teruko Miller',side:'petitioner',title:'Reported physical strikes and a third-party account of a counseling admission',
    offenseTheory:'Penal Code sections 242 / 243(e)(1) domestic-battery screen; section 273.5 only if traumatic condition is proved',
    victimTarget:'Brandon Miller; reported conduct also occurred in Juliet\'s presence on one alleged date',
    eventVenue:'Reported 2022 incidents in Monterey; exact location and venue for each act require verification',
    rankBasis:'Highest seriousness and a combination of third-party and neutral police leads, offset by privilege, limitations, and admissibility issues; rank is not charge probability.',
    evidencePosture:'Third-party declaration plus filed MPD neighbor account and identified body-camera evidence; originals and lawful corroboration remain incomplete',
    investigativeUrgency:'critical',
    principalBlocker:'Limitations and privilege analysis plus native police, photo, medical, and witness corroboration',
    immediateActionId:'REQ-08',
    status:'limitations-review-required',readiness:'Strong interview lead; privilege, corroboration, venue, and limitations unresolved',eventDates:['2022-04-05','2022-06-01','2022-06-16'],discoveryDate:'2025-12-31',findingIds:['C-F0133-001'],
    authority:[authority.domesticBattery,authority.corporalInjury,authority.authentication,authority.limitations],
    assessment:'Jon Caton declares that Brandon reported repeated strikes and injuries, that Caton saw injury photographs, and that Teruko later admitted striking Brandon during counseling. A filed MPD report independently records a May 28, 2022 neighbor call, the male statement "You can\'t touch me like that," Teruko\'s denial of contact, and identified body-camera evidence. The counseling date, original notes/photos, privilege, self-defense, incident location, and limitations posture remain unresolved.',
    materiality:'If timely and lawfully corroborated, the evidence may support investigation of domestic battery or corporal injury. It also supplies potential pattern and credibility evidence, subject to admissibility rules.',
    elements:[
      element('RC-03-E1','Identity and qualifying intimate-partner relationship','partial','The declaration identifies the parties as spouses/fellow parents, but agency records should independently confirm identity and relationship on each date.',[sources.catonApril.id,sources.catonJune.id]),
      element('RC-03-E2','A willful touching or use of force by Teruko','partial','Caton reports Brandon described hitting, punching, pushing, kicking, and a forearm strike; Caton separately reports Teruko admitted striking Brandon. MPD YG2202018 records a neighbor hearing a male say "You can\'t touch me like that" and a female respond sarcastically, while Teruko denied contact.',[sources.catonApril.id,sources.catonJune.id,sources.catonAdmission.id,sources.policeMay28Summary.id,sources.policeMay28Neighbor.id],'Interview Caton, Allison Smith, and the parties; obtain original notes, messages, native police records, CAD, body-camera media, and other neutral witnesses.'),
      element('RC-03-E3','Traumatic condition caused by the force, if section 273.5 is screened','partial','Caton says he saw injury photographs and reports bleeding, but no original photographs, medical records, or custodian foundation are supplied.',[sources.catonApril.id],'Obtain original photographs/metadata, medical records, and causation evidence.'),
      element('RC-03-E4','The act was unlawful and not self-defense or defense of another','missing','The supplied accounts do not resolve proximity, provocation, accident, self-defense, or defense of another. Teruko denied physical contact to MPD, and the neighbor reported hearing but not seeing the interaction.',[sources.catonAdmission.id,sources.policeMay28Neighbor.id],'Interview separately and preserve all contrary evidence.'),
      element('RC-03-E5','Venue and timely prosecution','contested','The incidents are reported as occurring in 2022. Simple battery limitations may have expired, and later statutory extensions do not revive an already barred prosecution.',[],'Determine exact locations, offense grading, discovery, tolling, and the statute version in force for each event.'),
      element('RC-03-E6','Lawful admissibility of the counseling admission','contested','Caton reports an admission during counseling, which may raise clergy, counseling, marital, or psychotherapist privilege issues depending on role and circumstances.',[sources.catonAdmission.id],'Agency counsel should resolve privilege and obtain admissible nonprivileged corroboration.')
    ],
    sourceIds:[sources.catonMarch.id,sources.catonApril.id,sources.catonJune.id,sources.catonAdmission.id,sources.catonOath.id,sources.policeMay28Summary.id,sources.policeMay28Neighbor.id],
    contrarySourceIds:[sources.strikeDenial.id],
    defenses:['Teruko denied physical contact to MPD, and the neighbor did not see the interaction.','Privilege may bar or limit the counseling account.','The declaration was prepared years later at Brandon\'s request.','Self-defense, accident, and context are unresolved.','The original notes and injury photographs are not attached.','Limitations may bar prosecution of some or all 2022 conduct.'],
    blockingGaps:['Original Caton notes/messages and exact counseling date','Privilege determination','Original injury photographs and metadata','Native/certified MPD YG2202018 report, CAD, body-camera media, and witness follow-up','Medical records and other neutral witnesses','Venue and limitations analysis'],
    actionIds:['REQ-07','REQ-08','REQ-09'],motiveId:'M-03'
  },
  {
    id:'RC-04',rank:4,actor:'Teruko Miller',side:'petitioner',title:'Account retention and conditional phone-access discussion',
    offenseTheory:'Penal Code section 502 unauthorized-access screen; subsection and covered access/data act unresolved',
    victimTarget:'Brandon Miller\'s account, device access, and data',
    eventVenue:'Recording filename indicates November 4, 2024; device, provider, access location, and venue remain unresolved',
    rankBasis:'Time-sensitive forensic lead but most offense elements remain unproved; rank is not charge probability.',
    evidencePosture:'Transcript and party screenshots support preservation only; no provider logs, forensic image, or completed data act is proved',
    investigativeUrgency:'critical',
    principalBlocker:'Proof of access without permission and a specific covered data act under section 502',
    immediateActionId:'REQ-10',
    status:'insufficient-proof',readiness:'Computer-access lead; current record does not prove unauthorized access or data use',eventDates:['2024-11-04'],discoveryDate:'2026-01-21',findingIds:[],
    authority:[authority.computerAccess,authority.authentication,authority.limitations],
    assessment:'A reporter-prepared transcript discusses Brandon\'s account remaining on Teruko\'s phone and conditions for showing or removing access. A separate filing identifies the underlying media filename as dated November 4, 2024. The record does not establish account ownership, permission scope, actual access after revocation, copying/deletion, or intent.',
    materiality:'If forensic records confirm knowing access without permission and a covered data act, the conduct may support a Penal Code section 502 screen. The current transcript alone does not establish those elements.',
    elements:[
      element('RC-04-E1','A computer, system, network, account, or data belonging to another person','partial','The transcript describes Brandon\'s account on Teruko\'s phone, but ownership and account-control records are not supplied.',[sources.phoneAccount.id]),
      element('RC-04-E2','Knowing access without permission or beyond the scope of permission','missing','Shared-device, saved-password, former-permission, and marital-access histories are unresolved.',[sources.phoneAccount.id],'Obtain consent/revocation communications and provider login/security records.'),
      element('RC-04-E3','A covered act such as taking, copying, using, altering, damaging, deleting, or destroying data','missing','The record discusses access and removal but does not establish a completed covered data act.',[sources.phoneCondition.id],'Obtain forensic device/account evidence identifying the specific access and data act.'),
      element('RC-04-E4','Knowledge and required intent','missing','A conditional phone review may reflect leverage, security concerns, or a shared-account dispute rather than criminal intent.',[sources.phoneCondition.id],'Interview both parties and reconstruct authorization and purpose.'),
      element('RC-04-E5','The source recording is authentic and complete','partial','A filing identifies a dated PXL media filename and still, but the native file, hash, and signed reporter certificate are not in the corpus.',[sources.phoneFileDate.id,sources.phoneStill.id,sources.phoneCertificate.id],'Preserve the native file/devices and obtain a signed certificate and full workfile.')
    ],
    sourceIds:[sources.phoneAccount.id,sources.phoneCondition.id,sources.phoneFileDate.id,sources.phoneStill.id],
    contrarySourceIds:[sources.keysProvided.id,sources.phoneCertificate.id],
    defenses:['The account may have been installed or shared with permission.','Permission may not have been clearly revoked.','The reciprocal phone request may reflect hacking/security concerns.','The keys were ultimately provided.','The supplied transcript certificate is unsigned and undated.'],
    blockingGaps:['Native media and device forensic images','Account ownership and authorization history','Provider access logs','Evidence of a completed covered data act','Intent and venue evidence','Signed reporter certificate'],
    actionIds:['REQ-10','REQ-11'],motiveId:'M-04'
  },
  {
    id:'RC-05',rank:5,actor:'Teruko Miller',side:'petitioner',title:'"Suzie" email wording versus a later verified denial',
    offenseTheory:'No supported standalone offense on the current record; section 118 credibility screen only if authorship, falsity, knowledge, and materiality are established',
    victimTarget:'Court discovery process and Brandon Miller as email recipient',
    eventVenue:'May 10, 2026 email and June 24, 2026 verified response; sending location unresolved',
    rankBasis:'Literal wording conflict is easy to understand, but authorship, materiality, and any prohibited communication theory are weak; rank is not charge probability.',
    evidencePosture:'Screenshot plus admission of sender address; native email, drafter identity, provider records, and materiality remain missing',
    investigativeUrgency:'high',
    principalBlocker:'Native-message authorship plus proof of knowing falsity and materiality',
    immediateActionId:'REQ-12',
    status:'credibility-lead',readiness:'Credibility lead; weak standalone offense theory',eventDates:['2026-05-10','2026-06-24'],discoveryDate:'2026-06-24',findingIds:['C-F0245-001','X0005'],
    authority:[authority.perjury,authority.declaration,authority.authentication,authority.limitations],
    assessment:'An email from Teruko\'s address opens "My name is Suzie" and closes "Teruko." A later verified response admits the sender address but denies claiming to be Suzie. Native email/header and drafting evidence are missing. The governing order limits communications related to visitation; this property-pickup email is not facially an order violation.',
    materiality:'The comparison bears on authorship and credibility. Its materiality to a court decision or criminal offense is presently weak and must not be assumed.',
    elements:[
      element('RC-05-E1','A verified factual denial','supported','The RFA response admits the sender address, denies claiming to be Suzie, and is followed by a penalty-of-perjury verification.',[sources.suzieDenial.id,sources.suzieVerification.id]),
      element('RC-05-E2','The denial was objectively false','partial','The screenshot facially opens in Suzie\'s name and closes in Teruko\'s name, but it does not establish who drafted or sent the native email.',[sources.suzieEmail.id],'Obtain native .eml, full headers, account logs, drafting history, and Suzie\'s testimony.'),
      element('RC-05-E3','The declarant knew the denial was false and acted willfully','missing','Third-party drafting, dictation, translation, pasted text, or account sharing remain plausible.',[],'Interview Teruko, the recipient, and the alleged Suzie; obtain provider logs.'),
      element('RC-05-E4','The denial was material','missing','The record does not establish that the wording influenced a material court issue.',[],'Identify the precise court use and effect before any perjury screen.'),
      element('RC-05-E5','A court order prohibited this communication','not-supported','The cited order applies to communications related to visitation only; the email concerns property pickup.',[sources.visitationOnlyOrder.id],'Do not present this email as an order violation on the current record.'),
      element('RC-05-E6','The source is authenticated','partial','The screenshot and admission of the sender address support a lead, but native headers and provider records are missing.',[sources.suzieEmail.id,sources.suzieDenial.id],'Obtain and hash the native message and provider records.')
    ],
    sourceIds:[sources.suzieEmail.id,sources.suzieDenial.id,sources.suzieVerification.id],
    contrarySourceIds:[sources.visitationOnlyOrder.id],
    defenses:['Suzie may have drafted or dictated the email.','Text may have been pasted or translated.','The closing "Teruko" may negate deceptive intent.','The order is visitation-only and does not facially cover the property email.','Materiality and resulting harm are weak.'],
    blockingGaps:['Native .eml and full headers','Provider access/login records','Identity and testimony of Suzie','Drafting history','Materiality and intent evidence'],
    actionIds:['REQ-12'],motiveId:'M-05'
  }
];

function packetSource(source,use,pages=[source.page],note=''){
  if(!['candidate','context'].includes(use)) throw new Error(`Unsupported packet source use ${use}`);
  return {sourceId:source.id,use,pages:[...pages],note};
}

function packetAttachment(id,title,recordId,candidateIds,purpose,sourceReviews){
  return {id,title,recordId,candidateIds:[...candidateIds],purpose,sourceReviews};
}

// This is a human-curated page allowlist, not a query over the full referral source table.
// Pages 5, 6, and 8 of F0267 and page 5 of F0172 are explicit reviewed spillovers.
// They are not inferred by the report generator from OCR or Markdown line ranges.
const packetPlan={
  schemaVersion:1,
  status:'human-curated-page-allowlist',
  selectionPolicy:'Include every support/contrary source row selected by the five referral candidates, explicit reviewed spillover pages, and only the listed non-contact context pages. Deduplicate physical PDF pages. Do not infer adjacent pages.',
  highlightMode:'guide-only-callouts',
  highlightPolicy:'Exact extracted passages appear in yellow divider callouts labeled for verification. Original source-page content is scaled only and receives no evidentiary rectangle because OCR coordinates have not been independently verified.',
  expectedSourcePageCount:36,
  attachments:[
    packetAttachment('ATT-01','Sworn conviction assertion and same-filing portal','F0003',['RC-01'],'Compare the challenged wording, penalty-of-perjury context, and attached active-case portal in the same filed PDF.',[
      packetSource(sources.convictionStatement,'candidate'),
      packetSource(sources.convictionOath,'candidate'),
      packetSource(sources.activeDocket,'candidate')
    ]),
    packetAttachment('ATT-02','Respondent denial and later clerk-search context','F0142',['RC-01'],'Preserve the opposing sworn account and the later clerk certificate as qualified context; neither reconstructs the complete November 2024 disposition by itself.',[
      packetSource(sources.brandonNoFilings,'candidate'),
      packetSource(sources.brandonNoFilingsOath,'candidate'),
      packetSource(sources.clerkSearch,'context')
    ]),
    packetAttachment('ATT-03','Audiotape 2 reporter transcript and facial certificate','F0144',['RC-02'],'Show the reporter identity, attributed statements, and the facially unsigned/undated certificate together so authentication limits remain visible.',[
      packetSource(sources.reporterContact,'context'),
      packetSource(sources.audioP2,'candidate'),
      packetSource(sources.audioP3,'candidate'),
      packetSource(sources.audioP4,'candidate'),
      packetSource(sources.audioCertificate,'candidate')
    ]),
    packetAttachment('ATT-04','Verified admissions responses and reviewed spillovers','F0267',['RC-02','RC-03','RC-05'],'Compare the quoted Audiotape 2 requests, the physical-contact denial, the Suzie-email response, and the shared verification. Pages 5, 6, and 8 are explicitly reviewed spillovers.',[
      packetSource(sources.audioRfa,'candidate',[4,5,6,7],'The cited passage begins on page 4 and was reviewed through page 7.'),
      packetSource(sources.strikeDenial,'candidate',[7,8],'The cited passage begins on page 7 and continues onto page 8.'),
      packetSource(sources.suzieDenial,'candidate'),
      packetSource(sources.rfaVerification,'candidate')
    ]),
    packetAttachment('ATT-05','Jon Caton declaration excerpts and oath','F0133',['RC-03'],'Keep the dated reported incidents, counselor-observation/admission account, and declaration oath in one source sequence.',[
      packetSource(sources.catonMarch,'candidate'),
      packetSource(sources.catonApril,'candidate'),
      packetSource(sources.catonJune,'candidate'),
      packetSource(sources.catonAdmission,'candidate'),
      packetSource(sources.catonOath,'candidate')
    ]),
    packetAttachment('ATT-06','Filed MPD YG2202018 excerpts','F0170',['RC-03'],'Preserve the filed police-report copy containing the neighbor call, party accounts, and body-worn-camera reference; obtain native/certified agency records separately.',[
      packetSource(sources.policeMay28Summary,'candidate'),
      packetSource(sources.policeMay28Neighbor,'candidate')
    ]),
    packetAttachment('ATT-07','Audiotape 3 account and phone-access discussion','F0158',['RC-04'],'Show the account-removal discussion, conditional access language, contrary key-return context, and facial certificate limitation together.',[
      packetSource(sources.phoneAccount,'candidate'),
      packetSource(sources.phoneCondition,'candidate'),
      packetSource(sources.keysProvided,'candidate'),
      packetSource(sources.phoneCertificate,'candidate')
    ]),
    packetAttachment('ATT-08','Underlying media filename and device still','F0068',['RC-04'],'Tie the transcript lead to the filed declaration passage identifying the media date and the device/account still without treating either as forensic proof.',[
      packetSource(sources.phoneFileDate,'candidate'),
      packetSource(sources.phoneStill,'candidate')
    ]),
    packetAttachment('ATT-09','Temporary-order disposition and Suzie email image','F0245',['RC-05'],'Keep the procedural temporary-order denial visible as context and the filed email screenshot as the challenged wording source.',[
      packetSource(sources.temporaryOrderDenied,'context'),
      packetSource(sources.suzieEmail,'candidate')
    ]),
    packetAttachment('ATT-10','Visitation-only communication clause','F0233',['RC-05'],'Show the operative clause limiting the cited communication restriction to visitation-related communications.',[
      packetSource(sources.visitationOnlyOrder,'candidate')
    ]),
    packetAttachment('ATT-11','Account-session and mobile-association context','F0043',['RC-04'],'Provide the dated Google session and T-Mobile association screenshots as preservation context, not proof of a particular user or unauthorized access.',[
      packetSource(sources.googleSession,'context'),
      packetSource(sources.mobileAssociation,'context')
    ]),
    packetAttachment('ATT-12','Later last-access account with reviewed spillover','F0172',['RC-04'],'Preserve the later party declaration giving a different last-access date; page 5 is an explicitly reviewed spillover.',[
      packetSource(sources.laterAccessDate,'context',[4,5],'The cited passage begins on page 4 and spans extracted pages 4-5.')
    ])
  ],
  contactOnlySourceIdsExcludedFromEvidenceSelection:[
    sources.brandonContact.id,
    sources.johannaContact.id,
    sources.terukoContact.id,
    sources.terukoEmail.id,
    sources.catonContact.id,
    sources.reporterContact.id,
    sources.mayberryContact.id,
    sources.johannaPhone.id
  ],
  contactPolicy:'Eight contact-only source rows (seven physical page keys) are excluded from candidate-evidence selection and remain available on request. F0144 page 1 is separately allowlisted only as reporter/transcript identity context; its contact details are not an evidentiary proposition.'
};

const motives=[
  {id:'M-01',candidateId:'RC-01',actor:'Teruko Miller',status:'hypothesis-only',trigger:'DVRO and custody litigation',incentive:'Present Brandon as a proven violent offender',anticipatedBenefit:'Stronger dangerousness and credibility position',supportingSourceIds:[sources.convictionStatement.id,sources.convictionOath.id],contrary:'A genuine safety concern or nontechnical use of "convicted" may explain the wording without criminal intent.'},
  {id:'M-02',candidateId:'RC-02',actor:'Teruko Miller',status:'hypothesis-only',trigger:'Formal discovery seeking admissions to hostile statements',incentive:'Avoid admissions harmful to credibility or family-court positioning',anticipatedBenefit:'Preserve litigation position',supportingSourceIds:[sources.audioRfa.id,sources.rfaVerification.id],contrary:'The transcript was allegedly vague or unattached and memory/authentication could justify a good-faith denial.'},
  {id:'M-03',candidateId:'RC-03',actor:'Teruko Miller',status:'hypothesis-only',trigger:'Interpersonal conflict and marital breakdown',incentive:'Control proximity, conflict, or household dynamics',anticipatedBenefit:'Immediate conflict leverage',supportingSourceIds:[sources.catonApril.id,sources.catonJune.id,sources.catonAdmission.id],contrary:'Self-defense, accident, distorted reporting, or incomplete counseling context may explain the accounts.'},
  {id:'M-04',candidateId:'RC-04',actor:'Teruko Miller',status:'hypothesis-only',trigger:'Account, device, vehicle, and parenting dispute',incentive:'Retain information access or obtain reciprocal phone access',anticipatedBenefit:'Information or negotiation leverage',supportingSourceIds:[sources.phoneAccount.id,sources.phoneCondition.id],contrary:'Shared-account history and security concerns may explain the discussion without unauthorized access.'},
  {id:'M-05',candidateId:'RC-05',actor:'Teruko Miller',status:'hypothesis-only',trigger:'Property-pickup coordination during contentious litigation',incentive:'Use an intermediary identity or buffer direct interaction',anticipatedBenefit:'Control timing and tone of the exchange',supportingSourceIds:[sources.suzieEmail.id],contrary:'A real Suzie may have drafted, dictated, translated, or sent the message for Teruko.'}
];

const requests=[
  {id:'REQ-01',priority:'critical',candidateIds:['RC-01'],action:'Obtain the certified complete docket for case 23CR009384 as it existed on November 4, 2024, including complaint, plea, diversion, dismissal, sealing, and disposition records.',target:'Monterey County Superior Court criminal-records custodian',status:'open'},
  {id:'REQ-02',priority:'high',candidateIds:['RC-01'],action:'Determine who drafted the "already convicted" language and what Teruko knew when she signed it.',target:'Teruko Miller and relevant drafting counsel',status:'open'},
  {id:'REQ-03',priority:'high',candidateIds:['RC-01'],action:'Obtain the orders, hearing use, and reliance history needed to assess materiality.',target:'Family/DVRO court record',status:'open'},
  {id:'REQ-04',priority:'critical',candidateIds:['RC-02'],action:'Preserve the native audio, original device/cloud copy, metadata, hash, and full context.',target:'Recording custodian / Brandon Miller',status:'open'},
  {id:'REQ-05',priority:'critical',candidateIds:['RC-02'],action:'Obtain a signed reporter certificate, workfile, and testimony; resolve why the supplied certificate is unsigned and undated.',target:'Jenna Osborn, CSR 8681',status:'open'},
  {id:'REQ-06',priority:'high',candidateIds:['RC-02'],action:'Establish what transcript/audio was supplied before the RFA responses and what reasonable inquiry occurred.',target:'Teruko Miller and discovery counsel',status:'open'},
  {id:'REQ-07',priority:'critical',candidateIds:['RC-03'],action:'Interview Jon Caton and lawfully obtain contemporaneous notes, messages, photographs, session dates, and participant records.',target:'Jon Caton',status:'open'},
  {id:'REQ-08',priority:'critical',candidateIds:['RC-03'],action:'Obtain the native/certified MPD YG2202018 report, CAD, identified body-camera media, Allison Smith interview/contact, photographs, medical records, and police records for the other reported incidents.',target:'Monterey Police Department, medical custodians, Allison Smith, and other witnesses',status:'open'},
  {id:'REQ-09',priority:'critical',candidateIds:['RC-03'],action:'Resolve privilege, venue, offense grading, statutory version, tolling, and limitations before substantive use.',target:'Agency/DA legal review',status:'open'},
  {id:'REQ-10',priority:'critical',candidateIds:['RC-04'],action:'Preserve the native PXL media, devices, forensic images, account security history, and provider access logs.',target:'Device/account custodians and provider',status:'open'},
  {id:'REQ-11',priority:'high',candidateIds:['RC-04'],action:'Reconstruct account ownership, permission, revocation, actual access, data acts, and purpose.',target:'Brandon and Teruko Miller; account provider',status:'open'},
  {id:'REQ-12',priority:'high',candidateIds:['RC-05'],action:'Preserve the native email and headers, obtain provider logs, identify/interview Suzie and recipients, and establish authorship before treating the denial as knowingly false.',target:'Email custodians, Teruko Miller, recipients, alleged Suzie',status:'open'}
];

const chronology=[
  {id:'CT-01',date:null,datePrecision:'range / session date unresolved',eventDate:null,filedDate:'2025-12-31',candidateIds:['RC-03'],classification:'support-with-gap',title:'Caton describes a 2021-2023 counseling relationship and says Teruko admitted striking Brandon; exact session date remains unresolved',sourceIds:[sources.catonAdmission.id]},
  {id:'CT-02',date:'2022-04-05',datePrecision:'day',eventDate:'2022-04-05',filedDate:'2025-12-31',candidateIds:['RC-03'],classification:'support',title:'Caton says Brandon contemporaneously reported repeated strikes, bleeding, and injury photographs later seen by Caton',sourceIds:[sources.catonApril.id]},
  {id:'CT-02A',date:'2022-05-28',datePrecision:'police incident date; report dated 2022-05-29',eventDate:'2022-05-28',filedDate:'2026-01-22',candidateIds:['RC-03'],classification:'mixed-neutral-record',title:'MPD YG2202018 records a neighbor call, a male saying "You can\'t touch me like that," a female sarcastic response, Teruko\'s denial of contact, and identified body-camera evidence',sourceIds:[sources.policeMay28Summary.id,sources.policeMay28Neighbor.id]},
  {id:'CT-03',date:'2022-06-01',datePrecision:'day',eventDate:'2022-06-01',filedDate:'2025-12-31',candidateIds:['RC-03'],classification:'support',title:'Caton reports neighbors called police and Brandon described another physical incident',sourceIds:[sources.catonJune.id]},
  {id:'CT-04',date:'2022-06-16',datePrecision:'day',eventDate:'2022-06-16',filedDate:'2025-12-31',candidateIds:['RC-03'],classification:'support',title:'Caton records a reported forearm strike to Brandon\'s jaw in Juliet\'s presence',sourceIds:[sources.catonJune.id]},
  {id:'CT-05',date:'2023-11-20',datePrecision:'court-portal event',eventDate:'2023-11-20',filedDate:'2024-11-04',candidateIds:['RC-01'],classification:'comparison',title:'Portal exhibit shows an active misdemeanor complaint, arraignment, and release rather than a listed conviction',sourceIds:[sources.activeDocket.id]},
  {id:'CT-06',date:'2024-11-04',datePrecision:'day',eventDate:'2024-11-04',filedDate:'2024-11-04',candidateIds:['RC-01'],classification:'support',title:'Teruko signs and files the declaration stating Brandon had already been convicted',sourceIds:[sources.convictionStatement.id,sources.convictionOath.id]},
  {id:'CT-07',date:'2024-11-04',datePrecision:'day',eventDate:'2024-11-04',filedDate:'2024-11-04',candidateIds:['RC-01'],classification:'internal-comparison',title:'The same declaration also says Brandon was waiting for criminal charges to be dismissed',sourceIds:[sources.convictionOath.id]},
  {id:'CT-08',date:'2024-12-26',datePrecision:'screenshot date; later claim differs',eventDate:'2024-12-26',filedDate:'2025-03-21',candidateIds:['RC-04'],classification:'mixed',title:'Google screenshot shows a Pixel 8 Pro session; a later declaration gives December 28 as the last-access date',sourceIds:[sources.googleSession.id,sources.laterAccessDate.id]},
  {id:'CT-09',date:'2025-03-09',datePrecision:'screenshot date',eventDate:'2025-03-09',filedDate:'2025-03-21',candidateIds:['RC-04'],classification:'support-with-gap',title:'T-Mobile screenshot associates Teruko\'s line with a Google Pixel 8 Pro but does not identify a specific account session or user',sourceIds:[sources.mobileAssociation.id]},
  {id:'CT-10',date:'2026-01-15',datePrecision:'certificate date',eventDate:'2026-01-15',filedDate:'2026-01-20',candidateIds:['RC-01'],classification:'qualified-neutral-record',title:'Clerk certificate reports no filings or convictions under Brandon\'s identifiers as of the search date, without reconstructing the earlier case history',sourceIds:[sources.clerkSearch.id]},
  {id:'CT-11',date:null,datePrecision:'recording date unresolved',eventDate:null,filedDate:'2026-01-20',candidateIds:['RC-02'],classification:'support-with-gap',title:'Audiotape 2 transcript attributes financial-control language and insults to Teruko',sourceIds:[sources.audioP2.id]},
  {id:'CT-12',date:null,datePrecision:'same unresolved recording',eventDate:null,filedDate:'2026-01-20',candidateIds:['RC-02'],classification:'support-with-gap',title:'Transcript attributes refusal to apologize, unwillingness to improve, hatred, and an "I wish you dead" statement; hostile words are not automatically a standalone crime',sourceIds:[sources.audioP3.id,sources.audioP4.id]},
  {id:'CT-13',date:null,datePrecision:'recording date unresolved',eventDate:null,filedDate:'2026-01-21',candidateIds:['RC-04'],classification:'mixed',title:'Phone transcript supports account possession while recording Teruko\'s claim that Brandon installed it and she requested removal',sourceIds:[sources.phoneAccount.id]},
  {id:'CT-14',date:null,datePrecision:'same unresolved recording',eventDate:null,filedDate:'2026-01-21',candidateIds:['RC-04'],classification:'support-with-defense',title:'Teruko conditions allowing account removal on seeing Brandon\'s phone while asserting reciprocal security concerns',sourceIds:[sources.phoneCondition.id,sources.keysProvided.id]},
  {id:'CT-15',date:'2026-04-20',datePrecision:'order date',eventDate:'2026-04-20',filedDate:'2026-04-20',candidateIds:['RC-05'],classification:'limiting-order-scope',title:'TalkingParents clause applies only to communications related to visitation, limiting an order-violation theory for a property email',sourceIds:[sources.visitationOnlyOrder.id]},
  {id:'CT-16',date:'2026-05-10',datePrecision:'day',eventDate:'2026-05-10',filedDate:'2026-05-15',candidateIds:['RC-05'],classification:'support-with-gap',title:'Email displayed from Teruko\'s address opens "My name is Suzie" and closes "Teruko"',sourceIds:[sources.suzieEmail.id]},
  {id:'CT-17',date:'2026-05-14',datePrecision:'order date',eventDate:'2026-05-14',filedDate:'2026-05-15',candidateIds:['RC-05'],classification:'contrary-procedural',title:'Court denies temporary orders on the request to prohibit impersonation; the denial is not a merits adjudication',sourceIds:[sources.temporaryOrderDenied.id]},
  {id:'CT-18',date:'2026-06-24',datePrecision:'verification date',eventDate:'2026-06-24',filedDate:'2026-06-24',candidateIds:['RC-02'],classification:'qualified-denial',title:'Teruko verifies denials to Audio 2 quotations after objections and a stated reasonable inquiry',sourceIds:[sources.audioRfa.id,sources.rfaVerification.id]},
  {id:'CT-19',date:'2026-06-24',datePrecision:'verification date',eventDate:'2026-06-24',filedDate:'2026-06-24',candidateIds:['RC-03'],classification:'qualified-denial',title:'Teruko verifies a compound denial tied to an alleged face strike, Audiotape 4, and Caton',sourceIds:[sources.strikeDenial.id,sources.rfaVerification.id]},
  {id:'CT-20',date:'2026-06-24',datePrecision:'verification date',eventDate:'2026-06-24',filedDate:'2026-06-24',candidateIds:['RC-05'],classification:'mixed',title:'Teruko admits the May 10 email came from her address but denies claiming to be Suzie under verification',sourceIds:[sources.suzieDenial.id,sources.suzieVerification.id]}
];

const uniqueSources=[...new Map(Object.values(sources).map(source=>[source.id,source])).values()];

const referral={
  schemaVersion:1,
  generatedAt:new Date().toISOString(),
  case:{
    id:'24FL001068',relatedCase:'24DV000567',court:'Superior Court of California, County of Monterey',preparedFor:['Monterey Police Department','Monterey County District Attorney'],venue:'Monterey County, California - verify each alleged act location',
    reportingParty:{name:'Brandon Charles Miller',role:'Respondent / reporting party',contactStatus:'Verify from current source record before submission'},
    subject:{name:'Teruko Nozaki Miller',role:'Petitioner / subject of selected allegations',contactStatus:'Verify from current source record before submission'},
    purpose:'Request intake, evidence preservation, targeted interviews, certified-record collection, and prosecutor review of the ranked candidates if investigation confirms the missing elements.',
    posture:'Agency charging screen - not a finding of guilt. Automated leads are excluded from this brief unless promoted into a human-curated candidate.'
  },
  theory:{
    executiveSummary:'The supplied family and DVRO record contains several concrete source comparisons involving Teruko Miller, but no candidate is presently charge-ready. The clearest false-statement screen is the November 4, 2024 declaration using "already convicted" while attaching an active-case portal. The clearest corroborated conduct lead is Jon Caton\'s account of repeated physical reports and a counseling admission, subject to privilege and limitations. Later verified denials create additional record conflicts, but original audio, native email, metadata, and intent evidence must be obtained. The recommended path is a narrow investigation of these five candidates, with contrary evidence and defenses preserved from the outset.',
    strongestComparisonId:'RC-01',
    actionRequested:'Take an informational report, preserve identified original evidence, obtain certified and native records, interview the named witnesses/custodians, and refer only candidates whose missing elements are resolved for DA review.',
    criminalScope:'Police and prosecutors decide whether facts support an investigation or charge. This brief does not declare guilt or promise prosecution, conviction, or incarceration.',
    familyScope:'Custody, visitation, sanctions, parental rights, and family access are separate family-court matters. Police and the DA cannot award those remedies. The same authenticated facts may be supplied separately to family-court counsel and the court.'
  },
  contacts:[
    contact('P-BRANDON','Reporting party / Respondent','Brandon Charles Miller',[sources.brandonContact.id]),
    contact('P-TERUKO','Subject / Petitioner','Teruko Nozaki Miller',[sources.terukoContact.id,sources.terukoEmail.id]),
    contact('P-CATON','Third-party counselor/declarant','Jon Caton',[sources.catonContact.id,sources.catonOath.id]),
    contact('P-OSBORN','Reporter / transcript custodian','Jenna Osborn, CSR 8681',[sources.reporterContact.id,sources.audioCertificate.id,sources.phoneCertificate.id]),
    contact('P-MAYBERRY','Current counsel for Petitioner','Elizabeth Mayberry, BSS Legal',[sources.mayberryContact.id]),
    contact('P-JOHANNA','LCSW declarant / service witness','Johanna Zollmann',[sources.johannaContact.id,sources.johannaPhone.id])
  ],
  candidates,
  motives,
  chronology,
  requests,
  reliefTracks:{
    criminalReferral:{owner:'Law enforcement / prosecutor',requestedOutcome:'Investigation, evidence preservation, interviews, certified records, and charging review if the evidence satisfies every element.',candidateIds:candidates.map(item=>item.id)},
    familyCourt:{owner:'Family court / family-law counsel',requestedOutcome:'Separate review of custody, visitation, sanctions, parental rights, and family access under governing family-law standards.',sharedFactCandidateIds:candidates.map(item=>item.id),warning:'Do not present a criminal referral as if it itself restores custody or awards sanctions.'}
  },
  statusDefinitions:{
    supported:'The current source directly supports this proposition, subject to authentication and admissibility.',
    partial:'Some proof exists, but a material part remains unresolved.',
    missing:'The supplied record does not establish this proposition.',
    contested:'A legal, factual, privilege, venue, or limitations dispute must be resolved.',
    'not-supported':'The current source affirmatively does not fit this proposed theory.'
  },
  packetPlan,
  sources:uniqueSources,
  reports:{
    actionReport:{label:'Police / DA Action Report',path:'Reports/Police/Police-DA-Action-Report.pdf'},
    actionReportMarkdown:{label:'Police / DA Action Report - Markdown',path:'Reports/Police/Police-DA-Action-Report.md'},
    sourceIndex:{label:'Police / DA Source Index',path:'Reports/Police/Police-DA-Source-Index.csv'},
    evidencePacket:{label:'Police / DA Evidence Packet',path:'Reports/Police/Police-DA-Evidence-Packet.pdf'},
    evidencePacketHighlightGuide:{label:'Evidence Packet Highlight Guide',path:'Reports/Police/Police-DA-Evidence-Packet-Highlight-Guide.md'},
    evidencePacketIndex:{label:'Evidence Packet Machine Index',path:'Reports/Police/Police-DA-Evidence-Packet-Index.json'},
    manifest:{label:'Report hash manifest',path:'Reports/Police/Police-DA-Report-Manifest.json'}
  },
  reviewHistory:[]
};

for(const candidate of referral.candidates){
  for(const sourceId of [...candidate.sourceIds,...candidate.contrarySourceIds]){
    if(!referral.sources.some(source=>source.id===sourceId)) throw new Error(`${candidate.id} references missing source ${sourceId}`);
  }
  for(const actionId of candidate.actionIds){
    if(!referral.requests.some(request=>request.id===actionId)) throw new Error(`${candidate.id} references missing request ${actionId}`);
  }
}

await mkdir(referralRoot,{recursive:true});
await writeFile(path.join(referralRoot,'referral-case.json'),`${JSON.stringify(referral,null,2)}\n`,'utf8');
console.log(`Referral case written: ${referral.candidates.length} candidates, ${referral.sources.length} sources, ${referral.chronology.length} critical events.`);
