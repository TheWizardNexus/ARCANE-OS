import {parseRecordLinks} from '../../../arcane/modules/RecordLinkIndex.js';
import {
  ACTOR_OPTIONS,
  REVIEW_OPTIONS,
  assetUrl,
  fmtBytes,
  fmtDate,
  reviewFields
} from './InvestigatorCaseData.js';

async function waitForMethod(host,method,eventName){
  if(typeof host?.[method]==='function') return host;
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`${method} did not become available.`)),5000);
    const ready=()=>{
      if(typeof host?.[method]!=='function') return;
      clearTimeout(timeout);
      host.removeEventListener(eventName,ready);
      resolve();
    };
    host.addEventListener(eventName,ready);
  });
  return host;
}

function filingConfig(record){
  return {
    subtitle:`${fmtDate(record.filingDate)} · ${record.filingParty} · ${record.id}`,
    pdfUrl:assetUrl(record.pdfPath),
    markdownUrl:assetUrl(record.markdownPath),
    metadata:{
      'Filing ID':record.id,
      Filed:fmtDate(record.filingDate),
      'Filing party':record.filingParty,
      'Original filename':record.name,
      Size:fmtBytes(record.size),
      'SHA-256':record.sha256,
      'Exhibits separated':record.exhibits.length
    },
    initialView:'pdf'
  };
}

function evidenceConfig(record){
  const sourcePage=Number(record.sourcePage);
  const pageResolved=record.sourcePageStatus==='resolved'&&Number.isSafeInteger(sourcePage)&&sourcePage>0;
  const candidates=Array.isArray(record.sourcePageCandidates)?record.sourcePageCandidates.join(', '):'';
  return {
    subtitle:`${record.id} · Separated from ${record.parentFiling}`,
    pdfUrl:record.parentPdfPath?assetUrl(record.parentPdfPath):'',
    pdfPage:pageResolved?sourcePage:null,
    markdownUrl:assetUrl(record.file),
    metadata:{
      'Evidence ID':record.id,
      'Exhibit title':record.title,
      'Parent filing':record.parentFiling,
      'Parent filing ID':record.parentFilingId,
      'Parent PDF':record.parentPdfPath||'Not resolved',
      'Related Markdown':record.markdown,
      'Source page':pageResolved?`PDF page ${sourcePage}`:'Not resolved',
      'Page mapping status':record.sourcePageStatus||'unresolved',
      'Page mapping method':record.sourcePageMethod||'No reliable rendered-page match',
      'Candidate pages':candidates||'None',
      Extraction:'Markdown exhibit boundary with conservative page matching; compare against the complete parent PDF before reliance.'
    },
    initialView:pageResolved?'pdf':'text',
    textViewLabel:'Evidence text'
  };
}

async function openInvestigatorRecord({
  modal,
  template,
  record,
  recordType='filing',
  reviewStore,
  validRecordIds,
  onSaved=()=>{}
}){
  if(!record) throw new TypeError('A record is required.');
  const readyModal=await waitForMethod(modal,'populate','modal-ready');
  const shell=template.content.firstElementChild.cloneNode(true);
  const config=recordType==='evidence'?evidenceConfig(record):filingConfig(record);
  shell.querySelector('[data-dialog-title]').textContent=record.title;
  shell.querySelector('[data-dialog-subtitle]').textContent=config.subtitle;
  await readyModal.populate(shell,false);
  const inspector=await waitForMethod(shell.querySelector('[data-document-inspector]'),'loadDocument','document-inspector-ready');
  inspector.addEventListener('document-review-change',async event=>{
    if(event.detail.recordId!==record.id) return;
    try{
      const review=await reviewStore.set(record.id,{
        ...event.detail,
        attributes:{...record.attributes,...event.detail.attributes,attributionSource:'human-reviewed'}
      });
      Object.assign(record,review);
      const unknown=parseRecordLinks(review.attributes.relatedRecords).filter(id=>!validRecordIds.has(id));
      const message=unknown.length
        ?`Review saved. Unknown linked IDs: ${unknown.join(', ')}.`
        :'Review saved on this device.';
      inspector.markSaved(message);
      onSaved(record,message);
    }catch(error){
      inspector.markSaved(`Unable to save: ${error.message}`);
    }
  });
  const loading=inspector.loadDocument({
    recordId:record.id,
    title:record.title,
    pdfUrl:config.pdfUrl,
    pdfPage:config.pdfPage,
    markdownUrl:config.markdownUrl,
    metadata:config.metadata,
    reviewHeading:'Investigative review',
    reviewOptions:REVIEW_OPTIONS,
    classificationLabel:'Alleged actor',
    classificationOptions:ACTOR_OPTIONS,
    reviewFields:reviewFields(),
    notesLabel:'Investigative notes, proof gaps, and contrary evidence',
    review:record,
    initialView:config.initialView,
    textViewLabel:config.textViewLabel
  });
  await readyModal.open();
  await loading;
}

export {openInvestigatorRecord,waitForMethod};
