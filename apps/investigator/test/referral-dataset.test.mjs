import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';

const root=new URL('../data/cases/24FL001068/',import.meta.url);
const data=JSON.parse(await readFile(new URL('Referral/referral-case.json',root),'utf8'));
const sourceById=new Map(data.sources.map(source=>[source.id,source]));
const requestIds=new Set(data.requests.map(request=>request.id));

test('curated referral is narrow, allegation-framed, and not represented as charge-ready',()=>{
  assert.equal(data.schemaVersion,1);
  assert.equal(data.case.id,'24FL001068');
  assert.equal(data.candidates.length,5);
  assert.equal(data.chronology.length,21);
  assert.match(data.case.posture,/not a finding of guilt/i);
  assert.match(data.theory.criminalScope,/does not declare guilt/i);
  assert.match(data.theory.familyScope,/separate family-court matters/i);
  assert.ok(data.candidates.every(candidate=>candidate.actor==='Teruko Miller'&&candidate.side==='petitioner'));
  assert.ok(data.candidates.every(candidate=>!/^charge-ready$/i.test(candidate.readiness)));
  assert.ok(data.candidates.every(candidate=>candidate.offenseTheory&&candidate.victimTarget&&candidate.eventVenue));
  assert.ok(data.candidates.every(candidate=>candidate.rankBasis&&candidate.evidencePosture&&candidate.principalBlocker));
  assert.ok(data.candidates.every(candidate=>requestIds.has(candidate.immediateActionId)));
});

test('every proof row resolves to exact app-owned sources and every action exists',async()=>{
  for(const source of data.sources){
    const encodedPage=source.id.match(/-P(\d+)-L/)?.[1];
    assert.equal(Number(encodedPage),source.page,`${source.id} must encode its displayed PDF page`);
  }
  for(const candidate of data.candidates){
    assert.ok(candidate.elements.length>=5);
    assert.ok(candidate.defenses.length);
    assert.ok(candidate.blockingGaps.length);
    for(const sourceId of [...candidate.sourceIds,...candidate.contrarySourceIds,...candidate.elements.flatMap(item=>item.sourceIds)]){
      const source=sourceById.get(sourceId);
      assert.ok(source,`${candidate.id} is missing ${sourceId}`);
      assert.match(source.recordId,/^F\d{4}$/);
      assert.ok(source.page>0&&source.lineStart>0&&source.lineEnd>=source.lineStart);
      assert.ok(source.excerpt.length>0);
      await access(new URL(source.pdfPath,root));
      await access(new URL(source.markdownPath,root));
    }
    for(const actionId of candidate.actionIds) assert.ok(requestIds.has(actionId));
  }
});

test('known evidentiary limitations stay explicit in the referral model',()=>{
  const audioCertificate=data.sources.find(source=>source.recordId==='F0144'&&source.page===5);
  assert.match(audioCertificate.note,/unsigned and undated/i);
  const visitationOrder=data.sources.find(source=>source.recordId==='F0233'&&source.role==='contrary');
  assert.equal(visitationOrder.id,'S-F0233-P17-L709-713');
  assert.equal(visitationOrder.page,17);
  assert.match(visitationOrder.note,/visitation-only/i);
  const suzie=data.candidates.find(candidate=>candidate.id==='RC-05');
  assert.ok(suzie.elements.some(item=>item.status==='not-supported'&&/court order/i.test(item.proposition)));
  assert.ok(!data.candidates.some(candidate=>candidate.sourceIds.some(id=>sourceById.get(id)?.recordId==='F0188')));
});

test('clerk certificate citation resolves to the certificate text on parent PDF page 10',()=>{
  const clerkCertificate=data.sources.find(source=>source.id==='S-F0142-P10-L360-381');
  assert.ok(clerkCertificate);
  assert.equal(clerkCertificate.page,10);
  assert.equal(clerkCertificate.extractedPage,10);
  assert.match(clerkCertificate.excerpt,/DATE: 01\/15\/2026/);
  assert.match(clerkCertificate.excerpt,/no record of any filings or convictions/i);
});

test('physical-conduct screen preserves neutral police corroboration and contrary denial',()=>{
  const candidate=data.candidates.find(item=>item.id==='RC-03');
  const policeSources=candidate.sourceIds.map(id=>sourceById.get(id)).filter(source=>source?.sourceTier==='police-report');
  assert.equal(policeSources.length,2);
  assert.ok(policeSources.every(source=>source.role==='mixed'));
  assert.ok(candidate.contrarySourceIds.some(id=>sourceById.get(id)?.recordId==='F0267'));
  assert.ok(data.chronology.some(event=>event.id==='CT-02A'&&event.eventDate==='2022-05-28'&&event.sourceIds.every(id=>sourceById.has(id))));
});

test('critical chronology separates unknown event dates from filing dates',()=>{
  const unknown=data.chronology.filter(event=>event.eventDate===null);
  assert.ok(unknown.length>=4);
  assert.ok(unknown.every(event=>event.filedDate&&/unresolved/i.test(event.datePrecision)));
  assert.ok(data.chronology.every(event=>Array.isArray(event.sourceIds)&&event.sourceIds.every(id=>sourceById.has(id))));
});

test('private contacts and report artifacts stay under the app-owned case folder',()=>{
  assert.ok(data.contacts.length>=6);
  assert.ok(data.contacts.every(contact=>contact.sourceIds.length&&/verify/i.test(contact.contact)));
  for(const report of Object.values(data.reports)) assert.match(report.path,/^Reports\/Police\//);
});
