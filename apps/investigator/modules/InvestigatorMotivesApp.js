import {loadInvestigatorAnalysis} from './InvestigatorAnalysisData.js?v=2';
import {openInvestigatorFinding} from './InvestigatorFindingDialog.js';

const $=selector=>document.querySelector(selector);
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const {analysis,analysisReviewStore}=await loadInvestigatorAnalysis();

function side(value=''){return String(value).startsWith('petitioner')?'petitioner':value==='respondent'?'respondent':'unassigned';}
$('#motiveTotal').textContent=analysis.motives.length;
$('#motiveGrid').innerHTML=analysis.motives.map(item=>`<article class="motive-card ${side(item.actor)}"><header><span>Hypothesis · ${escape(item.confidence)}</span><h2>${escape(item.hypothesis)}</h2><strong>${escape(item.actorLabel)}</strong></header><p>${escape(item.summary)}</p><div><h3>Conduct it might help explain</h3><ul>${item.allegedConduct.map(value=>`<li>${escape(value)}</li>`).join('')}</ul></div><div class="counter"><h3>Innocent or contrary explanations</h3><ul>${item.contraryConsiderations.map(value=>`<li>${escape(value)}</li>`).join('')}</ul></div><button type="button" data-analysis-id="${escape(item.id)}">Inspect sources and decide</button></article>`).join('');

$('#motiveGrid').addEventListener('click',event=>{const trigger=event.target.closest('[data-analysis-id]'); const item=analysis.itemById.get(trigger?.dataset.analysisId); if(!item) return; openInvestigatorFinding({modal:$('#findingDialog'),template:$('#findingDialogContent'),item,reviewStore:analysisReviewStore,onSaved:()=>{$('#appStatus').textContent=`Decision saved for ${item.hypothesis}.`;}}).catch(error=>{$('#appStatus').textContent=`Unable to open motive: ${error.message}`;});});
