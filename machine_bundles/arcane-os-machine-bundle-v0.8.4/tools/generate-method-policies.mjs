import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readMethodPolicies,
  renderAndroidApplicationRegistry,
  renderAndroidCapabilityRegistry,
} from './method-policies.mjs';
import { readMethodContracts, renderAndroidMethodContracts } from './method-contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policies = await readMethodPolicies(root);
const contracts = await readMethodContracts(root, policies);
const bundleManifest = JSON.parse(await fs.readFile(path.join(root, 'arcane-bundle.json'), 'utf8'));
await fs.writeFile(
  path.join(root, 'src', 'hosts', 'android', 'GeneratedAndroidCapabilityRegistry.kt'),
  renderAndroidCapabilityRegistry(policies),
);
await fs.writeFile(
  path.join(root, 'src', 'hosts', 'android', 'GeneratedAndroidMethodContracts.kt'),
  renderAndroidMethodContracts(contracts, policies),
);
await fs.writeFile(
  path.join(root, 'src', 'hosts', 'android', 'GeneratedAndroidApplicationRegistry.kt'),
  renderAndroidApplicationRegistry(bundleManifest, policies),
);
console.log('Generated Arcane host capability registries.');
