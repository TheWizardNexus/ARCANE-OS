import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const bossDirectory = path.resolve(scriptDirectory, '..');
const promptPath = path.join(bossDirectory, 'prompts', 'system.md');
const modelfilePath = path.join(bossDirectory, 'Modelfile');

const prompt = (await readFile(promptPath, 'utf8')).replace(/\r\n/g, '\n').trim();

if (prompt.includes('"""')) {
    throw new Error('The canonical BOSS prompt cannot contain a triple-quote sequence.');
}

const modelfile = `FROM \${BASE_MODEL}\n\nSYSTEM """\n${prompt}\n"""\n`;

await writeFile(modelfilePath, modelfile, 'utf8');
console.log(`Wrote ${modelfilePath}`);
