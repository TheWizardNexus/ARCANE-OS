import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const timeline=await readFile(new URL('../arcane/components/record-timeline.html',import.meta.url),'utf8');
const board=await readFile(new URL('../arcane/components/relationship-board.html',import.meta.url),'utf8');
const explanation=await readFile(new URL('../arcane/components/source-explanation.html',import.meta.url),'utf8');

test('timeline exposes a bounded native-button chronology contract',()=>{
  assert.match(timeline,/host\.setItems=setItems/);
  assert.match(timeline,/record-timeline-open/);
  assert.match(timeline,/slice\(0,5000\)/);
  assert.match(timeline,/<ol class="timeline"/);
});

test('relationship board provides lanes and an accessible connection list',()=>{
  assert.match(board,/host\.setGraph=setGraph/);
  assert.match(board,/relationship-node-open/);
  assert.match(board,/data-edges/);
  assert.match(board,/aria-pressed/);
});

test('source explanation avoids unsafe legal conclusions and embeds only same-origin originals',()=>{
  assert.match(explanation,/What the allegation would require/);
  assert.match(explanation,/How the cited facts apply/);
  assert.match(explanation,/What may weaken or defeat the allegation/);
  assert.match(explanation,/sameOrigin/);
  assert.match(explanation,/source-explanation-save/);
  assert.match(explanation,/originalPicker\.addEventListener\('change'/);
  assert.match(explanation,/host\.selectSource=selectSource/);
  assert.match(explanation,/config\.initialSourceId/);
  assert.match(explanation,/requestedSourceIndex/);
  assert.match(explanation,/showSource\(initialSourceIndex\)/);
  assert.match(explanation,/searchParams\.set\('arcane-pdf-page'/);
  assert.doesNotMatch(explanation,/\bCRAC\b/);
  assert.doesNotMatch(explanation,/innerHTML\s*=/);
});
