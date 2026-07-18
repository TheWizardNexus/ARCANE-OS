import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function inlineScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[0]))
    .map((match) => match[1]);
}

function sha256Source(script) {
  return `'sha256-${crypto.createHash('sha256').update(script, 'utf8').digest('base64')}'`;
}

test('build-core hashes browser-normalized LF inline scripts when source input uses CRLF', async () => {
  const buildSource = await fs.readFile(path.join(root, 'tools/build-core.mjs'), 'utf8');
  const normalizeAt = buildSource.indexOf("html = html.replace(/\\r\\n?/g, '\\n');");
  const extractAt = buildSource.indexOf('const scriptMatches = [...html.matchAll(');
  assert(normalizeAt >= 0 && normalizeAt < extractAt, 'build must normalize HTML before extracting inline scripts');

  const build = spawnSync(process.execPath, ['tools/build-core.mjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr || build.stdout);

  for (const app of ['provisioner', 'shell']) {
    const source = await fs.readFile(path.join(root, `src/frontend/${app}/index.html`), 'utf8');
    const crlfFixture = source.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
    const browserNormalized = crlfFixture.replace(/\r\n?/g, '\n');
    const generated = await fs.readFile(path.join(root, `dist/app/${app}/index.html`), 'utf8');

    assert.equal(generated.includes('\r'), false, `${app} output must use canonical LF bytes`);
    for (const script of inlineScripts(browserNormalized)) {
      const expected = sha256Source(script);
      const preNormalizationHash = sha256Source(script.replace(/\n/g, '\r\n'));
      assert.notEqual(expected, preNormalizationHash, `${app} fixture must distinguish CRLF from LF hashing`);
      assert.match(generated, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
});
