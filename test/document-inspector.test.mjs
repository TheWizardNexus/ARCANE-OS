import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../arcane/components/document-inspector.html',import.meta.url),'utf8');

test('document inspector supports same-origin PDF and text-only evidence records',()=>{
  assert.match(source,/Document sources must use the current application origin/);
  assert.match(source,/pdfTab\.hidden=!hasPdf/);
  assert.match(source,/textTab\.hidden=!hasText/);
  assert.match(source,/config\.textViewLabel/);
  assert.match(source,/tabs\.filter\(candidate=>!candidate\.hidden\)/);
});

test('document inspector opens a validated initial PDF page',()=>{
  assert.match(source,/function pdfSourceUrl\(value,page=null\)/);
  assert.match(source,/PDF page must be a positive integer/);
  assert.match(source,/searchParams\.set\('arcane-pdf-page'/);
  assert.match(source,/url\.hash=`page=\$\{resolvedPage\}`/);
  assert.match(source,/config\.pdfPage/);
  assert.match(source,/`, page \$\{resolvedPage\}`/);
});

test('document inspector sanitizes Markdown and reports errors without HTML interpolation',()=>{
  assert.match(source,/querySelectorAll\('img,video,audio,source,picture'\)/);
  assert.match(source,/link\.removeAttribute\('href'\)/);
  assert.match(source,/showSurfaceMessage\(pdfPanel,error\.message,'error'\)/);
  assert.doesNotMatch(source,/pdfPanel\.innerHTML=`<p class="error">/);
  assert.match(source,/sequence!==loadSequence/);
});
