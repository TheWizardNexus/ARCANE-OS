import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  indexPairedRecord,
  parseStructuredRecordName,
  renderedPageBlocks,
  resolveEvidenceSourcePage
} from '../arcane/modules/CaseEvidenceIndexer.js';

test('parses configurable structured record filenames without legal policy',()=>{
  assert.deepEqual(
    parseStructuredRecordName('26-04-15 [LISA MEESKE] - Certified Audio Transcript.pdf'),
    {dateToken:'26-04-15',isoDate:'2026-04-15',source:'LISA MEESKE',title:'Certified Audio Transcript',extension:'.pdf'}
  );
  assert.equal(parseStructuredRecordName('unstructured.pdf'),null);
});

test('indexes neutral paired records and extracts configured evidence boundaries',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'arcane-case-index-')); const raw=path.join(root,'raw'); const md=path.join(root,'md'); const out=path.join(root,'evidence');
  await mkdir(raw); await mkdir(md); await writeFile(path.join(raw,'record.pdf'),'raw bytes');
  await writeFile(path.join(md,'record.md'),'# Record\n\n## Exhibit A\n\nSource content long enough for extraction.');
  const result=await indexPairedRecord({rawRoot:raw,markdownRoot:md,evidenceOutputRoot:out});
  assert.equal(result.records.length,1); assert.equal(result.records[0].status,'paired'); assert.equal(result.evidence.length,1);
  assert.equal(path.basename(result.evidence[0].file),'E0001.md');
  assert.match(await readFile(path.join(out,path.basename(result.evidence[0].file)),'utf8'),/Parent SHA-256: [a-f0-9]{64}/);
});

test('resolves evidence headings inside rendered-page blocks without guessing',()=>{
  const markdown=[
    '# Record',
    '## Page 3',
    '[Page 3 image](<_rendered_pages/example/page-0003.png>)',
    '## Exhibit A',
    'Evidence body',
    '## Page 4',
    '[Page 4 image](<_rendered_pages/example/page-0004.png>)',
    'Other content'
  ].join('\n');
  const boundary=markdown.indexOf('## Exhibit A');
  assert.deepEqual(renderedPageBlocks(markdown).map(item=>item.page),[3,4]);
  assert.deepEqual(resolveEvidenceSourcePage(markdown,boundary,'Exhibit A'),{
    sourcePage:3,
    sourcePageStatus:'resolved',
    sourcePageMethod:'containing-rendered-page',
    sourcePageMarker:'_rendered_pages/example/page-0003.png',
    sourcePageCandidates:[3]
  });
});

test('resolves only a unique standalone exhibit label and preserves ambiguity',()=>{
  const unique=[
    '# Record',
    '## Exhibit B',
    'Summary entry before rendered pages.',
    '## Page 5',
    '[Page 5 image](<_rendered_pages/example/page-0005.png>)',
    '1 EXHIBIT B',
    'Evidence body'
  ].join('\n');
  assert.deepEqual(resolveEvidenceSourcePage(unique,unique.indexOf('## Exhibit B'),'Exhibit B'),{
    sourcePage:5,
    sourcePageStatus:'resolved',
    sourcePageMethod:'unique-standalone-label',
    sourcePageMarker:'_rendered_pages/example/page-0005.png',
    sourcePageCandidates:[5]
  });

  const ambiguous=[
    '# Record',
    '## Exhibit C',
    'Summary entry before rendered pages.',
    '## Page 7',
    '[Page 7 image](<_rendered_pages/example/page-0007.png>)',
    'EXHIBIT C',
    '## Page 9',
    '[Page 9 image](<_rendered_pages/example/page-0009.png>)',
    '2 EXHIBIT C'
  ].join('\n');
  assert.deepEqual(resolveEvidenceSourcePage(ambiguous,ambiguous.indexOf('## Exhibit C'),'Exhibit C'),{
    sourcePage:null,
    sourcePageStatus:'ambiguous',
    sourcePageMethod:'multiple-standalone-labels',
    sourcePageMarker:null,
    sourcePageCandidates:[7,9]
  });
});

test('does not weaken a qualified exhibit label into a generic page match',()=>{
  const markdown=[
    '# Record',
    "## Petitioner's Exhibit A",
    'Summary entry before rendered pages.',
    '## Page 8',
    '[Page 8 image](<_rendered_pages/example/page-0008.png>)',
    'EXHIBIT A'
  ].join('\n');
  assert.deepEqual(resolveEvidenceSourcePage(markdown,markdown.indexOf("## Petitioner's Exhibit A"),"Petitioner's Exhibit A"),{
    sourcePage:null,
    sourcePageStatus:'unresolved',
    sourcePageMethod:null,
    sourcePageMarker:null,
    sourcePageCandidates:[]
  });
});
