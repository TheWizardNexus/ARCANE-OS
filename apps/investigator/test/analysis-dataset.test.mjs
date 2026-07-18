import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../data/cases/24FL001068/',import.meta.url);
const caseIndex=JSON.parse(await readFile(new URL('case-index.json',root),'utf8'));
const analysis=JSON.parse(await readFile(new URL('Analysis/investigative-analysis.json',root),'utf8'));
const filingIds=new Set(caseIndex.filings.map(item=>item.id));

test('represents every filing and truthfully separates automated screening from promoted comparisons',()=>{
  assert.equal(analysis.schemaVersion,1);
  assert.equal(analysis.coverage.filingsScanned,262);
  assert.equal(analysis.coverage.filingsRepresented,262);
  assert.equal(analysis.filings.length,262);
  assert.equal(analysis.coverage.crossRecordPairsScreened,262*261/2);
  assert.equal(analysis.coverage.curatedCrossReferences,analysis.crossReferences.length);
  assert.equal(new Set(analysis.filings.map(item=>item.recordId)).size,262);
});

test('every local lead identifies its alleged actor posture and exact source passage',()=>{
  assert.ok(analysis.findings.length>0);
  for(const finding of analysis.findings){
    assert.match(finding.id,/^[LC]-F\d{4}-\d{3}$/);
    assert.ok(filingIds.has(finding.recordId));
    assert.ok(finding.label);
    assert.ok(finding.kind);
    assert.ok(finding.allegedActorLabel);
    assert.match(finding.status,/unverified/);
    assert.ok(finding.assessment);
    assert.ok(finding.application);
    assert.ok(finding.elementsToVerify.length>=3);
    assert.ok(finding.limitations.length>=2);
    assert.ok(finding.nextSteps.length>=2);
    assert.ok(finding.sources.length>=1);
    for(const source of finding.sources){
      assert.ok(filingIds.has(source.recordId));
      assert.ok(Number.isInteger(source.page)&&source.page>0);
      assert.ok(Number.isInteger(source.lineStart)&&source.lineStart>0);
      assert.ok(source.lineEnd>=source.lineStart);
      assert.ok(source.excerpt.length>0);
      assert.match(source.pdfPath,/^Documents\/PDF\/F\d{4}\.pdf$/);
    }
  }
});

test('cross-record comparisons retain both sources, dates, and innocent explanations',()=>{
  assert.ok(analysis.crossReferences.length>=9);
  for(const comparison of analysis.crossReferences){
    assert.ok(comparison.label);
    assert.ok(comparison.whyItMayConflict);
    assert.ok(comparison.alternativeExplanation);
    assert.ok(comparison.resolveWith.length>=3);
    assert.ok(comparison.sources.length>=1);
  }
  const criminalRecord=analysis.crossReferences.find(item=>item.id==='X0009');
  assert.ok(criminalRecord.sources.some(item=>item.recordId==='F0003'));
  assert.ok(criminalRecord.sources.some(item=>item.recordId==='F0142'));
});

test('timeline contains the complete Caton dates and source-grounded treatment milestones',()=>{
  const ids=new Set(analysis.timeline.map(item=>item.id));
  for(const id of ['T-CATON-2021','T-CATON-2022-03-31','T-CATON-2022-04-05','T-CATON-2022-05','T-CATON-2022-06-01','T-CATON-2022-06-16','T-CATON-ADMISSION-UNDATED','T-CATON-FILED','T-VA-2023-02-01','T-VA-2023-05-18','T-SURFSIDE-2024-10-11','T-RISE-2025-08-25']) assert.ok(ids.has(id),id);
  assert.ok(analysis.timeline.some(item=>item.status==='scheduled'));
  assert.ok(analysis.timeline.some(item=>item.status==='canceled'));
  assert.ok(analysis.timeline.some(item=>item.factualPosture==='treating-physician-letter'));
});

test('orders never default to a proven violation and motives always retain counter-considerations',()=>{
  const allowed=new Set(['satisfied','partial','candidate-conflict','disputed','superseded','deadline-pending','outcome-not-in-record']);
  for(const order of analysis.orders){assert.ok(allowed.has(order.status)); assert.ok(order.sources.length); assert.ok(order.assessment);}
  for(const motive of analysis.motives){assert.match(motive.status,/hypothesis/); assert.ok(motive.contraryConsiderations.length); assert.ok(motive.sources.length);}
});
