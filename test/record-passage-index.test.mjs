import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDateMentions,
  findRulePassages,
  parseDateMention
} from '../arcane/modules/RecordPassageIndex.js';

const record=`# Example\n\n## Page 1\n\nThe witness reported a false statement on March 31, 2022.\nThe surrounding line gives context.\n\n## Page 2\n\nTreatment began 02/01/2023 and continued 2023 through 2024.\n`;
const extractedRecord=`# Extracted filing\n\n### Text Page 4\n\nFirst extracted page.\n\n### Text Page 5\n\nReporter certificate.\n`;

test('indexes configured passages with exact line and page provenance',()=>{
  const passages=findRulePassages(record,[{id:'credibility',label:'Credibility issue',pattern:/false statement/i}],{recordId:'F0001'});
  assert.equal(passages.length,1);
  assert.equal(passages[0].recordId,'F0001');
  assert.equal(passages[0].page,1);
  assert.ok(passages[0].lineStart<=5);
  assert.match(passages[0].excerpt,/false statement/);
});

test('extracts day, numeric, and range dates without overlapping duplicates',()=>{
  const dates=extractDateMentions(record,{recordId:'F0001'});
  assert.deepEqual(dates.map(item=>[item.isoDate,item.precision]),[
    ['2022-03-31','day'],
    ['2023-01-01','range'],
    ['2023-02-01','day']
  ]);
  assert.equal(dates[2].page,2);
  assert.equal(dates[1].endDate,'2024-12-31');
});

test('indexes extractor-style Text Page headings as PDF page markers',()=>{
  const passages=findRulePassages(extractedRecord,[{id:'certificate',pattern:/Reporter certificate/}],{recordId:'F0144'});
  assert.equal(passages.length,1);
  assert.equal(passages[0].page,5);
});

test('rejects impossible dates and normalizes common court formats',()=>{
  assert.equal(parseDateMention('04/12/2026').isoDate,'2026-04-12');
  assert.equal(parseDateMention('February 30, 2026').isoDate,null);
  assert.equal(parseDateMention('2021 through 2023').precision,'range');
});
