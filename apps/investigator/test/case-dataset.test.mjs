import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile,readdir} from 'node:fs/promises';

const root=new URL('../data/cases/24FL001068/',import.meta.url);
const data=JSON.parse(await readFile(new URL('case-index.json',root),'utf8'));

test('activates every complete PDF and Markdown pair and excludes gap files',()=>{
  assert.equal(data.schemaVersion,2);
  assert.equal(data.counts.sourceFilings,269);
  assert.equal(data.filings.length,262);
  assert.equal(data.counts.markdown,262);
  assert.equal(data.counts.paired,262);
  assert.equal(data.counts.ignoredUnpaired,7);
  assert.equal(data.counts.orphanMarkdown,0);
  assert.equal(data.counts.documentPdfs,262);
  assert.equal(data.counts.documentMarkdown,262);
});

test('canonical document folders contain no duplicate descriptive-name copies',async()=>{
  const pdfNames=await readdir(new URL('Documents/PDF/',root));
  const markdownNames=await readdir(new URL('Documents/MD/',root));
  assert.equal(pdfNames.length,262);
  assert.equal(markdownNames.length,262);
  assert.ok(pdfNames.every(name=>/^F\d{4}\.pdf$/.test(name)));
  assert.ok(markdownNames.every(name=>/^F\d{4}\.md$/.test(name)));
});

test('every filing has provenance, coupled documents, and a provisional review',async()=>{
  for(const filing of data.filings){
    assert.match(filing.id,/^F\d{4}$/);
    assert.match(filing.sha256,/^[a-f0-9]{64}$/);
    assert.ok(filing.size>0);
    assert.match(filing.filingDate,/^20\d{2}-\d{2}-\d{2}$/);
    assert.notEqual(filing.filingParty,'Source not parsed');
    assert.ok(filing.title);
    assert.match(filing.pdfPath,/^Documents\/PDF\//);
    assert.match(filing.markdownPath,/^Documents\/MD\//);
    assert.ok(filing.initialReview);
    assert.ok(['petitioner','respondent','unassigned'].includes(filing.initialReview.classification));
    await access(new URL(filing.pdfPath,root));
    await access(new URL(filing.markdownPath,root));
  }
});

test('every separated exhibit points to a filing id, Markdown, and evidence file',async()=>{
  const names=new Set(await readdir(new URL('Evidence/MD/',root)));
  const filingsByName=new Map(data.filings.map(item=>[item.name,item.id]));
  const filingIds=new Set(data.filings.map(item=>item.id));
  assert.equal(names.size,data.exhibits.length);
  for(const exhibit of data.exhibits){
    assert.equal(exhibit.parentFilingId,filingsByName.get(exhibit.parentFiling));
    assert.ok(filingIds.has(exhibit.parentFilingId));
    assert.ok(exhibit.markdown);
    assert.equal(exhibit.parentPdfPath,`Documents/PDF/${exhibit.parentFilingId}.pdf`);
    assert.equal(exhibit.parentMarkdownPath,`Documents/MD/${exhibit.parentFilingId}.md`);
    assert.match(exhibit.file,/^Evidence\/MD\/E\d{4}\.md$/);
    await access(new URL(exhibit.parentPdfPath,root));
    const name=exhibit.file.replace('Evidence/MD/','');
    assert.ok(names.has(name));
    const text=await readFile(new URL(exhibit.file,root),'utf8');
    assert.match(text,/Parent SHA-256: [a-f0-9]{64}/);
    assert.ok(text.includes(`Parent filing: ${exhibit.parentFiling}`));
    assert.ok(text.includes(`Source page status: ${exhibit.sourcePageStatus}`));
  }
  assert.equal([...names].filter(name=>!/^E\d{4}\.md$/.test(name)).length,0);
});

test('evidence page mappings are conservative and disclose uncertainty',()=>{
  const byStatus=Object.groupBy(data.exhibits,item=>item.sourcePageStatus);
  assert.equal(byStatus.resolved.length,data.counts.evidencePageResolved);
  assert.equal(byStatus.ambiguous.length,data.counts.evidencePageAmbiguous);
  assert.equal(byStatus.unresolved.length,data.counts.evidencePageUnresolved);
  assert.deepEqual(
    [byStatus.resolved.length,byStatus.ambiguous.length,byStatus.unresolved.length],
    [96,4,32]
  );
  for(const exhibit of byStatus.resolved){
    assert.ok(Number.isSafeInteger(exhibit.sourcePage)&&exhibit.sourcePage>0);
    assert.ok(['containing-rendered-page','unique-standalone-label'].includes(exhibit.sourcePageMethod));
    assert.deepEqual(exhibit.sourcePageCandidates,[exhibit.sourcePage]);
  }
  for(const exhibit of byStatus.ambiguous){
    assert.equal(exhibit.sourcePage,null);
    assert.equal(exhibit.sourcePageMethod,'multiple-standalone-labels');
    assert.ok(exhibit.sourcePageCandidates.length>1);
  }
  for(const exhibit of byStatus.unresolved){
    assert.equal(exhibit.sourcePage,null);
    assert.equal(exhibit.sourcePageMethod,null);
    assert.deepEqual(exhibit.sourcePageCandidates,[]);
  }
});

test('import audit lists every excluded unpaired source without activating it',async()=>{
  const audit=JSON.parse(await readFile(new URL('Import/import-audit.json',root),'utf8'));
  assert.equal(audit.activePairs,262);
  assert.equal(audit.ignoredUnpaired.length,7);
  assert.ok(audit.ignoredUnpaired.every(item=>item.status==='missing-markdown'));
  assert.ok(audit.ignoredUnpaired.every(item=>item.reason.includes('excluded from active filing review')));
  assert.deepEqual(audit.evidencePageCounts,{resolved:96,ambiguous:4,unresolved:32});
  assert.deepEqual(audit.documentCounts,{pdf:262,markdown:262});
});
