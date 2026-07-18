import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';

const caseRoot=new URL('../data/cases/24FL001068/',import.meta.url);
const reportRoot=new URL('Reports/Police/',caseRoot);
const manifest=JSON.parse(await readFile(new URL('Police-DA-Report-Manifest.json',reportRoot),'utf8'));
const referral=JSON.parse(await readFile(new URL('Referral/referral-case.json',caseRoot),'utf8'));

const digest=payload=>createHash('sha256').update(payload).digest('hex');
const normalizeReportText=value=>String(value)
  .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g,'-')
  .replace(/\u00a0/g,' ');

function decodeAscii85(payload){
  const text=payload.toString('ascii').replace(/\s+/g,'').replace(/^<~/,'');
  const output=[];
  let group=[];
  for(const character of text){
    if(character==='~') break;
    if(character==='z'){
      assert.equal(group.length,0,'ASCII85 z shorthand must begin at a group boundary');
      output.push(0,0,0,0);
      continue;
    }
    const code=character.charCodeAt(0);
    if(code<33||code>117) continue;
    group.push(code-33);
    if(group.length===5){
      let value=0;
      for(const digit of group) value=value*85+digit;
      output.push((value>>>24)&255,(value>>>16)&255,(value>>>8)&255,value&255);
      group=[];
    }
  }
  if(group.length){
    const outputLength=group.length-1;
    while(group.length<5) group.push(84);
    let value=0;
    for(const digit of group) value=value*85+digit;
    output.push(...[(value>>>24)&255,(value>>>16)&255,(value>>>8)&255,value&255].slice(0,outputLength));
  }
  return Buffer.from(output);
}

function extractPdfStreams(pdf){
  const raw=pdf.toString('latin1');
  const pattern=/stream\r?\n([\s\S]*?)endstream/g;
  const decoded=[];
  let match;
  while((match=pattern.exec(raw))){
    const dictionary=raw.slice(Math.max(0,match.index-200),match.index);
    if(!dictionary.includes('/FlateDecode')) continue;
    let payload=Buffer.from(match[1],'latin1');
    if(dictionary.includes('/ASCII85Decode')) payload=decodeAscii85(payload);
    decoded.push(inflateSync(payload).toString('latin1'));
  }
  return decoded.join('\n');
}

function parseCsv(text){
  const rows=[];
  let row=[];
  let value='';
  let quoted=false;
  for(let index=0;index<text.length;index+=1){
    const character=text[index];
    if(character==='"'){
      if(quoted&&text[index+1]==='"'){
        value+='"';
        index+=1;
      }else quoted=!quoted;
    }else if(character===','&&!quoted){
      row.push(value);
      value='';
    }else if((character==='\n'||character==='\r')&&!quoted){
      if(character==='\r'&&text[index+1]==='\n') index+=1;
      row.push(value);
      if(row.some(cell=>cell.length)) rows.push(row);
      row=[];
      value='';
    }else value+=character;
  }
  if(value.length||row.length){
    row.push(value);
    rows.push(row);
  }
  const [headers,...records]=rows;
  return records.map(record=>Object.fromEntries(headers.map((header,index)=>[header,record[index]??''])));
}

test('report manifest binds the current referral input and every generated artifact',async()=>{
  const input=await readFile(new URL(manifest.input.path,caseRoot));
  assert.equal(input.length,manifest.input.byteLength);
  assert.equal(digest(input),manifest.input.sha256);
  for(const output of manifest.outputs){
    const payload=await readFile(new URL(output.path,caseRoot));
    assert.equal(payload.length,output.byteLength,output.path);
    assert.equal(digest(payload),output.sha256,output.path);
  }
});

test('action report renders the structured intake decision contract',async()=>{
  const markdown=await readFile(new URL('Police-DA-Action-Report.md',reportRoot),'utf8');
  assert.match(markdown,/not a finding of guilt/i);
  assert.match(markdown,/No candidate is represented as charge-ready/i);
  assert.match(markdown,/## Ranked intake decision screen/);
  assert.match(markdown,/Potential offense/);
  assert.match(markdown,/Victim (?:or|\/) target/);
  assert.match(markdown,/Event \/ venue/);
  assert.match(markdown,/Evidence posture/);
  assert.match(markdown,/(?:Decisive|Principal) blocker/);
  for(const candidate of referral.candidates){
    for(const field of ['offenseTheory','victimTarget','eventVenue','evidencePosture','principalBlocker']){
      assert.ok(
        markdown.includes(normalizeReportText(candidate[field])),
        `${candidate.id} ${field} must appear in the generated action report`
      );
    }
  }
  assert.match(markdown,/## Authority boundary/);
  assert.match(markdown,/Do not present a criminal referral as if it itself restores custody or awards sanctions/);
});

test('PDF identifies the packet as a private-party unverified referral',async()=>{
  const pdf=await readFile(new URL('Police-DA-Action-Report.pdf',reportRoot));
  assert.equal(pdf.subarray(0,5).toString('ascii'),'%PDF-');
  assert.ok(pdf.length>100000);
  assert.match(extractPdfStreams(pdf),/PRIVATE-PARTY REFERRAL - UNVERIFIED - NOT AN AGENCY RECORD/);
});

test('source index and referral preserve corrected display-page identities',async()=>{
  const csv=await readFile(new URL('Police-DA-Source-Index.csv',reportRoot),'utf8');
  assert.match(csv,/^source_id,record_id,role,source_tier,filed_date,filing_party,title,filename,pdf_page,markdown_lines,/);
  assert.ok(csv.trim().split(/\r?\n/).length>=40);
  const indexedSources=new Map(parseCsv(csv).map(source=>[source.source_id,source]));
  const expected=[
    {id:'S-F0142-P10-L360-381',recordId:'F0142',page:10,lines:'360-381',extractedPage:10},
    {id:'S-F0233-P17-L709-713',recordId:'F0233',page:17,lines:'709-713',extractedPage:15}
  ];
  for(const item of expected){
    const source=referral.sources.find(candidate=>candidate.id===item.id);
    assert.ok(source,`${item.id} must remain in the referral source set`);
    assert.equal(source.recordId,item.recordId);
    assert.equal(source.page,item.page);
    assert.equal(source.extractedPage,item.extractedPage);
    const indexed=indexedSources.get(item.id);
    assert.ok(indexed,`${item.id} must remain in the generated source index`);
    assert.equal(indexed.record_id,item.recordId);
    assert.equal(Number(indexed.pdf_page),item.page);
    assert.equal(indexed.markdown_lines,item.lines);
  }
  for(const source of indexedSources.values()){
    const encodedPage=source.source_id.match(/-P(\d+)-L/)?.[1];
    assert.equal(Number(encodedPage),Number(source.pdf_page),`${source.source_id} must encode its displayed PDF page`);
  }
});
