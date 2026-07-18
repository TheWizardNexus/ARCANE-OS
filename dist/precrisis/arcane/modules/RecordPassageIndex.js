const MONTH_NUMBER={
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12
};

const MONTH_TOKEN='January|February|March|April|May|June|July|August|September|October|November|December';

function boundedInteger(value,{minimum=0,maximum=10000,fallback=0}={}){
  const number=Number(value);
  return Number.isInteger(number)&&number>=minimum&&number<=maximum?number:fallback;
}

function textLines(value=''){
  return String(value??'').replace(/\r\n?/g,'\n').split('\n');
}

function lineOffsets(lines=[]){
  const offsets=[];
  let offset=0;
  for(const line of lines){
    offsets.push(offset);
    offset+=line.length+1;
  }
  return offsets;
}

function lineAtOffset(offsets=[],index=0){
  let low=0;
  let high=Math.max(0,offsets.length-1);
  while(low<=high){
    const middle=(low+high)>>1;
    if(offsets[middle]<=index) low=middle+1;
    else high=middle-1;
  }
  return Math.max(0,high);
}

function cleanExcerpt(lines=[],start=0,end=start,{maximumLength=1200}={}){
  const maximum=boundedInteger(maximumLength,{minimum:80,maximum:10000,fallback:1200});
  const value=lines.slice(start,end+1)
    .filter(line=>!/^\s*(?:```|---)\s*$/.test(line))
    .map(line=>line.replace(/^\s{0,4}(?:[-*+]\s+|>\s*)?/,'').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g,' ')
    .trim();
  return value.length>maximum?`${value.slice(0,maximum-1).trimEnd()}…`:value;
}

function pageMarkers(lines=[]){
  const markers=[];
  for(let index=0;index<lines.length;index++){
    const match=lines[index].match(/^#{1,6}\s+(?:PDF\s+)?Page\s+(\d+)\b/i);
    if(match) markers.push({line:index,page:Number(match[1])});
  }
  return markers;
}

function pageAtLine(markers=[],line=0){
  let page=null;
  for(const marker of markers){
    if(marker.line>line) break;
    page=marker.page;
  }
  return page;
}

function globalPattern(pattern){
  if(pattern instanceof RegExp){
    return new RegExp(pattern.source,pattern.flags.includes('g')?pattern.flags:`${pattern.flags}g`);
  }
  return new RegExp(String(pattern),'gi');
}

function passageKey(item={}){
  return `${item.ruleId}|${item.page??''}|${item.lineStart}|${item.excerpt.toLocaleLowerCase().replace(/\W+/g,' ').slice(0,180)}`;
}

function findRulePassages(text='',rules=[],{
  recordId='',
  contextLines=2,
  maximumExcerptLength=1200,
  maximumPerRule=40,
  maximumResults=1200
}={}){
  const source=String(text??'');
  const lines=textLines(source);
  const offsets=lineOffsets(lines);
  const markers=pageMarkers(lines);
  const defaultContext=boundedInteger(contextLines,{minimum:0,maximum:20,fallback:2});
  const perRule=boundedInteger(maximumPerRule,{minimum:1,maximum:500,fallback:40});
  const totalLimit=boundedInteger(maximumResults,{minimum:1,maximum:10000,fallback:1200});
  const findings=[];
  const seen=new Set();

  for(const definition of Array.isArray(rules)?rules:[]){
    if(!definition?.id) continue;
    const patterns=Array.isArray(definition.patterns)?definition.patterns:[definition.pattern];
    let ruleCount=0;
    for(const supplied of patterns.filter(Boolean)){
      const pattern=globalPattern(supplied);
      for(const match of source.matchAll(pattern)){
        if(ruleCount>=perRule||findings.length>=totalLimit) break;
        const matchIndex=match.index??0;
        const line=lineAtOffset(offsets,matchIndex);
        const localContext=boundedInteger(definition.contextLines,{minimum:0,maximum:20,fallback:defaultContext});
        const lineStart=Math.max(0,line-localContext);
        const lineEnd=Math.min(lines.length-1,line+localContext);
        const excerpt=cleanExcerpt(lines,lineStart,lineEnd,{maximumLength:definition.maximumExcerptLength||maximumExcerptLength});
        if(!excerpt) continue;
        const candidate={
          id:`${String(recordId||'record')}:${String(definition.id)}:${line+1}:${ruleCount+1}`,
          recordId:String(recordId||''),
          ruleId:String(definition.id),
          label:String(definition.label||definition.id),
          kind:String(definition.kind||'lead'),
          match:String(match[0]||''),
          lineStart:lineStart+1,
          lineEnd:lineEnd+1,
          page:pageAtLine(markers,line),
          excerpt,
          metadata:definition.metadata&&typeof definition.metadata==='object'?{...definition.metadata}:{}
        };
        if(typeof definition.accept==='function'&&!definition.accept(candidate,{match,source,lines,line})) continue;
        const key=passageKey(candidate);
        if(seen.has(key)) continue;
        seen.add(key);
        findings.push(candidate);
        ruleCount++;
      }
    }
    if(findings.length>=totalLimit) break;
  }
  return findings;
}

function validIsoDate(year,month=1,day=1){
  const y=Number(year); const m=Number(month); const d=Number(day);
  if(!Number.isInteger(y)||y<1900||y>2100||!Number.isInteger(m)||m<1||m>12||!Number.isInteger(d)||d<1||d>31) return null;
  const date=new Date(Date.UTC(y,m-1,d));
  if(date.getUTCFullYear()!==y||date.getUTCMonth()!==m-1||date.getUTCDate()!==d) return null;
  return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function parseDateMention(value=''){
  const raw=String(value||'').trim().replace(/\s+/g,' ');
  let match=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(match) return {isoDate:validIsoDate(match[1],match[2],match[3]),precision:'day'};
  match=raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);
  if(match){
    const year=match[3].length===2?2000+Number(match[3]):Number(match[3]);
    return {isoDate:validIsoDate(year,match[1],match[2]),precision:'day'};
  }
  match=raw.match(new RegExp(`^(${MONTH_TOKEN})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$`,'i'));
  if(match) return {isoDate:validIsoDate(match[3],MONTH_NUMBER[match[1].toLocaleLowerCase()],match[2]),precision:'day'};
  match=raw.match(new RegExp(`^(${MONTH_TOKEN})\\s+(\\d{4})$`,'i'));
  if(match) return {isoDate:validIsoDate(match[2],MONTH_NUMBER[match[1].toLocaleLowerCase()],1),precision:'month'};
  match=raw.match(/^(19\d{2}|20\d{2})\s+(?:through|to|[-–—])\s+(19\d{2}|20\d{2})$/i);
  if(match) return {isoDate:validIsoDate(match[1],1,1),endDate:validIsoDate(match[2],12,31),precision:'range'};
  return {isoDate:null,precision:'unknown'};
}

function extractDateMentions(text='',{
  recordId='',
  contextLines=1,
  maximumExcerptLength=900,
  maximumResults=2000
}={}){
  const source=String(text??'');
  const lines=textLines(source);
  const offsets=lineOffsets(lines);
  const markers=pageMarkers(lines);
  const context=boundedInteger(contextLines,{minimum:0,maximum:20,fallback:1});
  const limit=boundedInteger(maximumResults,{minimum:1,maximum:20000,fallback:2000});
  const patterns=[
    new RegExp(`\\b(?:${MONTH_TOKEN})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`,'gi'),
    /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
    /\b\d{1,2}[\/-]\d{1,2}[\/-](?:\d{4}|\d{2})\b/g,
    new RegExp(`\\b(?:${MONTH_TOKEN})\\s+\\d{4}\\b`,'gi'),
    /\b(?:19\d{2}|20\d{2})\s+(?:through|to|[-–—])\s+(?:19\d{2}|20\d{2})\b/gi
  ];
  const occupied=[];
  const results=[];
  for(const pattern of patterns){
    for(const match of source.matchAll(pattern)){
      if(results.length>=limit) break;
      const start=match.index??0; const end=start+match[0].length;
      if(occupied.some(range=>start<range.end&&end>range.start)) continue;
      const parsed=parseDateMention(match[0]);
      if(!parsed.isoDate) continue;
      occupied.push({start,end});
      const line=lineAtOffset(offsets,start);
      const lineStart=Math.max(0,line-context);
      const lineEnd=Math.min(lines.length-1,line+context);
      results.push({
        id:`${String(recordId||'record')}:date:${line+1}:${results.length+1}`,
        recordId:String(recordId||''),
        rawDate:String(match[0]),
        isoDate:parsed.isoDate,
        endDate:parsed.endDate||null,
        precision:parsed.precision,
        lineStart:lineStart+1,
        lineEnd:lineEnd+1,
        page:pageAtLine(markers,line),
        excerpt:cleanExcerpt(lines,lineStart,lineEnd,{maximumLength:maximumExcerptLength})
      });
    }
    if(results.length>=limit) break;
  }
  return results.sort((left,right)=>left.isoDate.localeCompare(right.isoDate)||left.lineStart-right.lineStart);
}

export {
  cleanExcerpt,
  extractDateMentions,
  findRulePassages,
  pageAtLine,
  pageMarkers,
  parseDateMention,
  textLines,
  validIsoDate
};
