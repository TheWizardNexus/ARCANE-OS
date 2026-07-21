import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { replaceTemplateTokenExactlyOnce } from '../../machine_bundles/arcane-os-machine-bundle-v0.8.4/tools/exact-template-replacement.mjs';
import { readMethodContracts, renderCoreMethodContracts } from '../../machine_bundles/arcane-os-machine-bundle-v0.8.4/tools/method-contracts.mjs';
import { readMethodPolicies, renderCoreMethodPolicies } from '../../machine_bundles/arcane-os-machine-bundle-v0.8.4/tools/method-policies.mjs';

const root = path.resolve('machine_bundles/arcane-os-machine-bundle-v0.8.4');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'arcane-bundle.json'), 'utf8'));
const policies = await readMethodPolicies(root);
const contracts = await readMethodContracts(root, policies);
const windows = await fs.readFile(path.join(root, 'src/native/windows.cjs'), 'utf8');
const linux = await fs.readFile(path.join(root, 'src/native/linux.cjs'), 'utf8');
const adapters = await fs.readFile(path.join(root, 'src/native/platform-adapters.cjs'), 'utf8');
let expected = await fs.readFile(path.join(root, 'src/core/arcane-core.template.cjs'), 'utf8');
expected = replaceTemplateTokenExactlyOnce(expected, '__ARCANE_NATIVE_ADAPTERS__', `${windows}\n\n${linux}\n\n${adapters}`);
expected = replaceTemplateTokenExactlyOnce(expected, '__ARCANE_METHOD_POLICIES__', renderCoreMethodPolicies(policies));
expected = replaceTemplateTokenExactlyOnce(expected, '__ARCANE_METHOD_CONTRACTS__', renderCoreMethodContracts(contracts, policies));
expected = replaceTemplateTokenExactlyOnce(expected, '__VERSION_JSON__', JSON.stringify(manifest.version));
expected = replaceTemplateTokenExactlyOnce(expected, '__BUNDLE_MANIFEST_JSON__', JSON.stringify(manifest));
const actual = await fs.readFile(path.join(root, 'runtime/arcane-core.cjs'), 'utf8');
let index = 0;
while (index < actual.length && index < expected.length && actual[index] === expected[index]) index += 1;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
console.log(JSON.stringify({
  equal: actual === expected,
  actualLength: actual.length,
  expectedLength: expected.length,
  actualHash: hash(actual),
  expectedHash: hash(expected),
  firstDifference: index,
  actualNear: actual.slice(Math.max(0, index - 120), index + 240),
  expectedNear: expected.slice(Math.max(0, index - 120), index + 240),
}, null, 2));
