import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const promptPath = new URL('../apps/boss/prompts/system.md', import.meta.url);
const modelfilePath = new URL('../apps/boss/Modelfile', import.meta.url);

test('BOSS Modelfile uses a variable base model and the canonical system prompt', async () => {
    const prompt = (await readFile(promptPath, 'utf8')).replace(/\r\n/g, '\n').trim();
    const modelfile = (await readFile(modelfilePath, 'utf8')).replace(/\r\n/g, '\n');
    const match = modelfile.match(/^FROM \$\{BASE_MODEL\}\n\nSYSTEM """\n([\s\S]*?)\n"""\n$/);

    assert.ok(match, 'Modelfile should retain FROM ${BASE_MODEL} and one SYSTEM block');
    assert.equal(match[1], prompt);
});
