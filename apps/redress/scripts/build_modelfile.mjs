import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const redressDirectory = path.resolve(scriptDirectory, '..');
const promptPath = path.join(redressDirectory, 'prompts', 'system.md');
const modelfilePath = path.join(redressDirectory, 'Modelfile');

const prompt = (await readFile(promptPath, 'utf8')).replace(/\r\n/g, '\n').trim();

if (prompt.includes('"""')) {
    throw new Error('The canonical Redress prompt cannot contain a triple-quote sequence.');
}

const baseModel = 'gpt-oss:120b';
const modelfile = `FROM ${baseModel}\n\nSYSTEM """\n${prompt}\n"""\n`;

await writeFile(modelfilePath, modelfile, 'utf8');
console.log(`Wrote ${modelfilePath}`);
