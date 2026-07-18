import {assessScamText,guidanceFor} from './ScamuraiPolicy.js';

const STORAGE_KEY='arcane.scamurai.v1';
const state=loadState();
const form=document.querySelector('#check-form');
const message=document.querySelector('#message');
const result=document.querySelector('#result');
const history=document.querySelector('#history');
const contacts=document.querySelector('#contacts');
const saveContacts=document.querySelector('#save-contacts');

function loadState(){
    try{
        const parsed=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');
        return {contacts:Array.isArray(parsed.contacts)?parsed.contacts.slice(0,3):[],incidents:Array.isArray(parsed.incidents)?parsed.incidents.slice(0,50):[]};
    }catch{return {contacts:[],incidents:[]};}
}

function persist(){localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));}
function levelLabel(level){return ({critical:'Critical warning',high:'High risk',caution:'Use caution',low:'No strong signals'})[level]||'Review needed';}

function renderHistory(){
    if(!state.incidents.length){history.innerHTML='<p class="empty">No checks saved yet. Scamurai stores checks only on this device.</p>';return;}
    history.innerHTML=`<ol>${state.incidents.map(item=>`<li><strong>${escapeHtml(levelLabel(item.level))}</strong><span>${new Date(item.createdAt).toLocaleString()} · score ${item.score}/100</span><p>${escapeHtml(item.preview)}</p></li>`).join('')}</ol>`;
}

function renderContacts(){contacts.value=state.contacts.join('\n');}

form.addEventListener('submit',event=>{
    event.preventDefault();
    const assessment=assessScamText(message.value);
    const incident={createdAt:new Date().toISOString(),level:assessment.level,score:assessment.score,preview:message.value.trim().slice(0,180),signals:assessment.matches.map(match=>match.id)};
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
        const uri=`mailto:${encodeURIComponent(state.contacts[0])}?subject=${subject}&body=${body}`;
        if(typeof window.Arcane?.external?.open==='function')await window.Arcane.external.open(uri);
        else location.href=uri;
    });
    renderHistory();
    result.focus();
});

saveContacts.addEventListener('click',()=>{
    const values=contacts.value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean).slice(0,3);
    const valid=values.filter(value=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
    state.contacts=valid;
    persist();
    renderContacts();
    document.querySelector('#contact-status').textContent=`Saved ${valid.length} trusted contact${valid.length===1?'':'s'} on this device.`;
});

renderContacts();
renderHistory();
