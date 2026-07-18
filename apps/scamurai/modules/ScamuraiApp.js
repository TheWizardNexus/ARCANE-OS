import {assessScamText,guidanceFor} from './ScamuraiPolicy.js';
import {getScamuraiDemoScenario,scamuraiDemoScenarios} from './ScamuraiDemo.js';
import DBLS from '../../../arcane/modules/DBLS.js';

const storage=new DBLS();
const STORAGE_KEY='state.v1';
const state=loadState();
const form=document.querySelector('#check-form');
const message=document.querySelector('#message');
const result=document.querySelector('#result');
const history=document.querySelector('#history');
const contacts=document.querySelector('#contacts');
const saveContacts=document.querySelector('#save-contacts');
const demoScenario=document.querySelector('#demo-scenario');
const demoStatus=document.querySelector('#demo-status');
let currentSource='Manual check';

function loadState(){
    try{
        const parsed=storage.get(STORAGE_KEY)||{};
        return {contacts:Array.isArray(parsed.contacts)?parsed.contacts.slice(0,3):[],incidents:Array.isArray(parsed.incidents)?parsed.incidents.slice(0,50):[]};
    }catch{return {contacts:[],incidents:[]};}
}

function persist(){storage.set(STORAGE_KEY,state);}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));}
function levelLabel(level){return ({critical:'Critical warning',high:'High risk',caution:'Use caution',low:'No strong signals'})[level]||'Review needed';}

function renderHistory(){
    if(!state.incidents.length){history.innerHTML='<p class="empty">No checks saved yet. Scamurai stores checks only on this device.</p>';return;}
    history.innerHTML=`<ol>${state.incidents.map(item=>`<li><strong>${escapeHtml(levelLabel(item.level))}</strong><span>${new Date(item.createdAt).toLocaleString()} · score ${item.score}/100</span><p>${escapeHtml(item.source||'Manual check')} · message content not retained</p></li>`).join('')}</ol>`;
}

function renderContacts(){contacts.value=state.contacts.join('\n');}

form.addEventListener('submit',event=>{
    event.preventDefault();
    const assessment=assessScamText(message.value);
    const incident={createdAt:new Date().toISOString(),level:assessment.level,score:assessment.score,source:currentSource,signals:assessment.matches.map(match=>match.id)};
    state.incidents.unshift(incident);
    state.incidents=state.incidents.slice(0,50);
    persist();
    result.dataset.level=assessment.level;
    result.hidden=false;
    result.innerHTML=`<h2>${escapeHtml(levelLabel(assessment.level))}: ${assessment.score}/100</h2><p>${escapeHtml(guidanceFor(assessment))}</p>${assessment.matches.length?`<ul>${assessment.matches.map(match=>`<li><strong>${escapeHtml(match.label)}</strong> — ${escapeHtml(match.guidance)}</li>`).join('')}</ul>`:'<p>No configured warning phrase matched.</p>'}<div class="result-actions"><button type="button" id="copy-report">Copy a privacy-safe report</button><button type="button" id="email-contact" ${state.contacts.length?'':'disabled'}>Prepare email to trusted contact</button></div><p class="disclaimer">Scamurai is a decision aid, not a guarantee. If anyone may be in immediate danger, contact local emergency services.</p>`;
    document.querySelector('#copy-report').addEventListener('click',async()=>{
        await navigator.clipboard.writeText(`Scamurai check: ${levelLabel(assessment.level)} (${assessment.score}/100). Signals: ${assessment.matches.map(match=>match.label).join(', ')||'none configured'}. No message content included.`);
    });
    document.querySelector('#email-contact').addEventListener('click',async()=>{
        const subject=encodeURIComponent(`Scamurai warning: ${levelLabel(assessment.level)}`);
        const body=encodeURIComponent(`Scamurai found a ${levelLabel(assessment.level).toLowerCase()} (score ${assessment.score}/100). Please contact me using a trusted method. The original message is not included for privacy.`);
        const recipient=encodeURIComponent(state.contacts[0]);
        const uri=`mailto:${recipient}?subject=${subject}&body=${body}`;
        if(typeof window.Arcane?.external?.open==='function')await window.Arcane.external.open(uri);
        else location.href=uri;
    });
    renderHistory();
    result.focus();
});

saveContacts.addEventListener('click',()=>{
    const values=contacts.value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean).slice(0,3);
    const valid=values.filter(value=>/^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(value));
    state.contacts=valid;
    persist();
    renderContacts();
    document.querySelector('#contact-status').textContent=`Saved ${valid.length} trusted contact${valid.length===1?'':'s'} on this device.`;
});

for(const scenario of scamuraiDemoScenarios){const option=document.createElement('option');option.value=scenario.id;option.textContent=scenario.label;demoScenario.append(option);}
document.querySelector('#load-demo').addEventListener('click',()=>{const scenario=getScamuraiDemoScenario(demoScenario.value);message.value=scenario.text;currentSource=scenario.source;demoStatus.textContent=`Loaded fictional scenario: ${scenario.label}. Select “Check for scam warning signs” to analyze it.`;message.focus();});
document.querySelector('#open-google-messages').addEventListener('click',()=>{const opened=globalThis.open('https://messages.google.com/web/','_blank','noopener,noreferrer');demoStatus.textContent=opened?'Google Messages opened separately. Copy only the suspicious text you want Scamurai to check.':'Open https://messages.google.com/web/ in a supported browser, then copy only the suspicious text you want checked.';});

const source=new URLSearchParams(location.search).get('source');
if(source==='google-messages'){currentSource='Arcane Messages handoff';demoStatus.textContent='Opened from an Arcane Messages warning. The SMS was not copied automatically; paste only the suspicious text if you want a second review.';message.focus();}

renderContacts();
renderHistory();
