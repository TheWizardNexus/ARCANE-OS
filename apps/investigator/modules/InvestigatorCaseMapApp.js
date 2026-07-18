import {loadInvestigatorAnalysis} from './InvestigatorAnalysisData.js?v=2';
import {openInvestigatorFinding} from './InvestigatorFindingDialog.js';
import {waitForMethod} from './InvestigatorRecordDialog.js';

const $=selector=>document.querySelector(selector);
const {analysis,analysisReviewStore}=await loadInvestigatorAnalysis();
const board=await waitForMethod($('#caseBoard'),'setGraph','relationship-board-ready');
let selectedItem=null;
board.setGraph(analysis.map,{lanes:analysis.map.lanes});
board.addEventListener('relationship-node-open',event=>{
  selectedItem=analysis.itemById.get(event.detail.id)||null;
  $('#mapStatus').textContent=selectedItem?`${event.detail.node.label}. Open the source-cited analysis when ready.`:`${event.detail.node.label}. This orientation card has no separate allegation analysis.`;
  $('#openMapItem').disabled=!selectedItem;
});
board.addEventListener('relationship-edge-open',event=>{
  const candidates=[event.detail.edge.to,event.detail.edge.from].map(id=>analysis.itemById.get(id)).filter(Boolean); selectedItem=candidates[0]||null;
  $('#openMapItem').disabled=!selectedItem; $('#mapStatus').textContent=selectedItem?`Connection selected: ${event.detail.edge.label}.`:'This connection has no separate analysis card.';
});
$('#openMapItem').addEventListener('click',()=>{if(!selectedItem) return; openInvestigatorFinding({modal:$('#findingDialog'),template:$('#findingDialogContent'),item:selectedItem,reviewStore:analysisReviewStore,onSaved:()=>{$('#appStatus').textContent='Case-map decision saved.';}}).catch(error=>{$('#appStatus').textContent=`Unable to open map analysis: ${error.message}`;});});
