import {loadInvestigatorAnalysis} from './InvestigatorAnalysisData.js?v=2';
import {openInvestigatorFinding} from './InvestigatorFindingDialog.js';
import {waitForMethod} from './InvestigatorRecordDialog.js';

const $=selector=>document.querySelector(selector);
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let analysis; let analysisReviewStore;
try{({analysis,analysisReviewStore}=await loadInvestigatorAnalysis());}catch(error){$('#appStatus').textContent=`Unable to load timeline: ${error.message}`; throw error;}

const timeline=await waitForMethod($('#caseTimeline'),'setItems','record-timeline-ready');
const categories=[...new Set(analysis.timeline.map(item=>item.category).filter(Boolean))].sort();
for(const category of categories){const option=document.createElement('option'); option.value=category; option.textContent=category; $('#timelineCategory').append(option);}

function filtered(){
  const query=$('#timelineSearch').value.trim().toLocaleLowerCase(); const category=$('#timelineCategory').value; const from=$('#timelineFrom').value; const through=$('#timelineThrough').value;
  return analysis.timeline.filter(item=>(!category||item.category===category)&&(!from||item.date>=from)&&(!through||item.date<=through)&&(!query||[item.title,item.summary,item.actor,item.category,item.sourceLabel,item.status,item.factualPosture].join(' ').toLocaleLowerCase().includes(query)));
}
function renderTimeline(){const items=filtered(); timeline.setItems(items); $('#timelineSummary').textContent=`Showing ${items.length} of ${analysis.timeline.length} dated events.`;}
function renderOrders(){
  $('#orderList').innerHTML=analysis.orders.map(item=>`<button class="order-card status-${escape(item.status)}" type="button" data-analysis-id="${escape(item.id)}"><time datetime="${escape(item.date)}">${escape(item.date)}</time><strong>${escape(item.title)}</strong><span>${escape(item.status.replaceAll('-',' '))}</span><small>${escape(item.assessment)}</small></button>`).join('');
}
async function openItem(item){await openInvestigatorFinding({modal:$('#findingDialog'),template:$('#findingDialogContent'),item,reviewStore:analysisReviewStore,onSaved:()=>{$('#appStatus').textContent=`Decision saved for ${item.title||item.label}.`;}});}

timeline.addEventListener('record-timeline-open',event=>openItem(event.detail.item).catch(error=>{$('#appStatus').textContent=`Unable to open event: ${error.message}`;}));
$('#orderList').addEventListener('click',event=>{const trigger=event.target.closest('[data-analysis-id]'); const item=analysis.itemById.get(trigger?.dataset.analysisId); if(item) openItem(item).catch(error=>{$('#appStatus').textContent=`Unable to open order: ${error.message}`;});});
for(const input of ['#timelineSearch','#timelineCategory','#timelineFrom','#timelineThrough']) $(input).addEventListener(input==='#timelineSearch'?'input':'change',renderTimeline);
$('#clearTimelineFilters').addEventListener('click',()=>{$('#timelineSearch').value=''; $('#timelineCategory').value=''; $('#timelineFrom').value=''; $('#timelineThrough').value=''; renderTimeline();});
$('#timelineTotal').textContent=analysis.timeline.length.toLocaleString(); renderOrders(); renderTimeline();
