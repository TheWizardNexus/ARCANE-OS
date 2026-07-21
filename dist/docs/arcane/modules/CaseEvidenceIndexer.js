import {createHash} from 'node:crypto';
import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const natural=(a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'});
const stem=value=>value.replace(/\.[^.]+$/,'');
const safeName=value=>value.replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim();

function parseStructuredRecordName(name,{
  pattern=/^(?<date>\d{2}-\d{2}-\d{2})\s+\[(?<source>[^\]]+)\]\s+-\s+(?<title>.+?)(?<extension>\.[^.]+)$/
}={}){
  const match=String(name||'').match(pattern);
  if(!match?.groups) return null;
  const [year,month,day]=match.groups.date.split('-').map(Number);
  const isoDate=`20${String(year).padStart(2,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  const parsedDate=new Date(`${isoDate}T00:00:00Z`);
  const dateValid=parsedDate.getUTCFullYear()===2000+year&&parsedDate.getUTCMonth()+1===month&&parsedDate.getUTCDate()===day;
  return {
    dateToken:match.groups.date,
    isoDate:dateValid?isoDate:null,
    source:safeName(match.groups.source),
    title:safeName(match.groups.title),
    extension:match.groups.extension.toLowerCase()
  };
}

function nearestPageMarker(text,index,pattern=/^#{1,6}\s+(?:Page|PDF Page)\s+(\d+)\b/gim){
  const matches=[...text.slice(0,index).matchAll(pattern)];
  return matches.length?Number(matches.at(-1)[1]):null;
}

function normalizeEvidenceLabel(value=''){
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[\u2018\u2019']/g,'')
    .replace(/[^a-z0-9.]+/gi,' ')
    .trim()
    .toLowerCase();
}

function evidenceLabelTargets(title=''){
  const value=String(title||'').trim();
  const targets=new Set([normalizeEvidenceLabel(value)].filter(Boolean));
  const label=value.match(/\b(Exhibit|Attachment)\s+([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)?)/i);
  const qualified=/\b(?:Petitioner|Respondent)(?:['\u2019]s)?\s+(?:Exhibit|Attachment)\b/i.test(value);
  if(label&&!qualified&&(/^[A-Za-z]{1,3}(?:\.\d+)?$/.test(label[2])||/^\d+$/.test(label[2]))){
    targets.add(normalizeEvidenceLabel(`${label[1]} ${label[2]}`));
  }
  return [...targets];
}

function renderedPageBlocks(markdown=''){
  const text=String(markdown||'');
  const markerPattern=/_rendered_pages[\\/][^\r\n]*?[\\/]page-(\d+)\.png\b/gi;
  const markers=[...text.matchAll(markerPattern)]
    .map(match=>({page:Number(match[1]),marker:match[0],index:match.index}))
    .filter(item=>Number.isSafeInteger(item.page)&&item.page>0);
  return markers.map((item,index)=>({
    ...item,
    end:markers[index+1]?.index??text.length,
    text:text.slice(item.index,markers[index+1]?.index??text.length)
  }));
}

function standaloneEvidenceLabel(line='',targets=[]){
  let value=normalizeEvidenceLabel(line);
  value=value.replace(/^\d{2}(?:fl|dv)\d{6}\s+/,'').replace(/^\d{1,3}\s+/,'');
  return targets.some(target=>value===target||new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s+(?:page\\s+)?\\d{1,3}$`,'i').test(value));
}

function resolveEvidenceSourcePage(markdown='',boundaryIndex=0,title=''){
  const pages=renderedPageBlocks(markdown);
  const containing=pages.find(page=>boundaryIndex>=page.index&&boundaryIndex<page.end);
  if(containing){
    return {sourcePage:containing.page,sourcePageStatus:'resolved',sourcePageMethod:'containing-rendered-page',sourcePageMarker:containing.marker,sourcePageCandidates:[containing.page]};
  }
  const targets=evidenceLabelTargets(title);
  const candidates=pages.filter(page=>page.text.split(/\r?\n/).some(line=>standaloneEvidenceLabel(line,targets)));
  const candidatePages=[...new Set(candidates.map(item=>item.page))].sort((left,right)=>left-right);
  if(candidatePages.length===1){
    const page=pages.find(item=>item.page===candidatePages[0]);
    return {sourcePage:page.page,sourcePageStatus:'resolved',sourcePageMethod:'unique-standalone-label',sourcePageMarker:page.marker,sourcePageCandidates:candidatePages};
  }
  return {
    sourcePage:null,
    sourcePageStatus:candidatePages.length?'ambiguous':'unresolved',
    sourcePageMethod:candidatePages.length?'multiple-standalone-labels':null,
    sourcePageMarker:null,
    sourcePageCandidates:candidatePages
  };
}

async function indexPairedRecord({
  rawRoot,markdownRoot,evidenceOutputRoot,rawExtension='.pdf',
  evidenceBoundary=/^#{2,6}\s+((?:Exhibit|Attachment)\b[^\r\n]*)/gim,
  signalRules=[],recordIdPrefix='F',evidenceIdPrefix='E',buildEvidenceMarkdown
}){
  if(!rawRoot||!markdownRoot||!evidenceOutputRoot) throw new TypeError('Raw, Markdown, and evidence output roots are required.');
  await mkdir(evidenceOutputRoot,{recursive:true});
  const rawNames=(await readdir(rawRoot)).filter(name=>name.toLowerCase().endsWith(rawExtension.toLowerCase())).sort(natural);
  const markdownNames=(await readdir(markdownRoot)).filter(name=>/\.md$/i.test(name)).sort(natural);
  const markdownByStem=new Map(markdownNames.map(name=>[stem(name).toLowerCase(),name]));
  const records=[]; const evidence=[];
  for(let index=0;index<rawNames.length;index++){
    const rawName=rawNames[index]; const rawBytes=await readFile(path.join(rawRoot,rawName));
    const hash=sha256(rawBytes); const markdownName=markdownByStem.get(stem(rawName).toLowerCase())||null;
    const recordEvidence=[]; let signals=[];
    if(markdownName){
      const markdown=await readFile(path.join(markdownRoot,markdownName),'utf8');
      signals=signalRules.filter(rule=>rule.pattern.test(markdown)).map(rule=>rule.id);
      evidenceBoundary.lastIndex=0;
      const boundaries=[...markdown.matchAll(evidenceBoundary)];
      for(let n=0;n<boundaries.length;n++){
        const match=boundaries[n]; const body=markdown.slice(match.index,boundaries[n+1]?.index??markdown.length).trim();
        if(body.length<20) continue;
        const id=`${evidenceIdPrefix}${String(evidence.length+1).padStart(4,'0')}`;
        const title=safeName(match[1]); const pageResolution=resolveEvidenceSourcePage(markdown,match.index,title);
        // Keep generated evidence paths stable and short. Descriptive source and
        // exhibit labels remain in the record and Markdown instead of the path.
        const fileName=`${id}.md`;
        const item={id,title,parentRaw:rawName,markdown:markdownName,...pageResolution,file:`Evidence/MD/${fileName}`,parentSha256:hash,body};
        const output=buildEvidenceMarkdown?buildEvidenceMarkdown(item):`# ${title}\n\n- Evidence ID: ${id}\n- Parent source: ${rawName}\n- Related Markdown: ${markdownName}\n- Source page: ${item.sourcePage??'not resolved from Markdown'}\n- Source page status: ${item.sourcePageStatus}\n- Source page method: ${item.sourcePageMethod??'none'}\n- Source page marker: ${item.sourcePageMarker??'none'}\n- Source page candidates: ${item.sourcePageCandidates.join(', ')||'none'}\n- Parent SHA-256: ${hash}\n\n${body}\n`;
        await writeFile(path.join(evidenceOutputRoot,fileName),output,'utf8'); evidence.push(item); recordEvidence.push(id);
      }
    }
    records.push({id:`${recordIdPrefix}${String(index+1).padStart(4,'0')}`,name:rawName,markdown:markdownName,status:markdownName?'paired':'missing-markdown',sha256:hash,size:rawBytes.length,signals,evidence:recordEvidence,reviewStatus:'not-reviewed'});
  }
  const rawStems=new Set(rawNames.map(name=>stem(name).toLowerCase()));
  return {records,evidence,markdownNames,orphanMarkdown:markdownNames.filter(name=>!rawStems.has(stem(name).toLowerCase()))};
}

export {indexPairedRecord,nearestPageMarker,parseStructuredRecordName,renderedPageBlocks,resolveEvidenceSourcePage,safeName,sha256,stem};
