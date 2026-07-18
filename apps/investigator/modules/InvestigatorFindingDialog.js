import {waitForMethod} from './InvestigatorRecordDialog.js';
import {
  ANALYSIS_ACTOR_OPTIONS,
  ANALYSIS_CONFIDENCE_OPTIONS,
  ANALYSIS_DISPOSITION_OPTIONS,
  explainableItem
} from './InvestigatorAnalysisData.js?v=2';

async function openInvestigatorFinding({modal,template,item,reviewStore,initialSourceId='',onSaved=()=>{}}){
  if(!item) throw new TypeError('An investigative item is required.');
  const readyModal=await waitForMethod(modal,'populate','modal-ready');
  const shell=template.content.firstElementChild.cloneNode(true);
  const explanation=explainableItem(item);
  shell.querySelector('[data-dialog-title]').textContent=explanation.label||explanation.title||'Investigative lead';
  shell.querySelector('[data-dialog-subtitle]').textContent=[explanation.id,explanation.kind,explanation.status].filter(Boolean).join(' · ');
  await readyModal.populate(shell,false);
  const component=await waitForMethod(shell.querySelector('[data-source-explanation]'),'showFinding','source-explanation-ready');
  component.addEventListener('source-explanation-save',async event=>{
    if(event.detail.recordId!==item.id) return;
    try{
      const review=await reviewStore.set(item.id,event.detail);
      item.review=review;
      component.markSaved('Decision saved on this device.');
      onSaved(item,review);
    }catch(error){
      component.markSaved(`Unable to save: ${error.message}`);
    }
  });
  component.showFinding({...explanation,review:item.review},{
    actorOptions:ANALYSIS_ACTOR_OPTIONS,
    dispositionOptions:ANALYSIS_DISPOSITION_OPTIONS,
    confidenceOptions:ANALYSIS_CONFIDENCE_OPTIONS,
    initialSourceId
  });
  await readyModal.open();
}

export {openInvestigatorFinding};
