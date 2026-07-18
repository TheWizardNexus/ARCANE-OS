import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createStaticSiteRelease} from '../../../arcane/server/StaticDomainServer.mjs';

const domainRoot=fileURLToPath(new URL('../',import.meta.url));
const siteRoot=fileURLToPath(new URL('../public/',import.meta.url));
const output=fileURLToPath(new URL('../site-release.json',import.meta.url));
const release=await createStaticSiteRelease({siteRoot,site:'precrisis.ai'});
await writeFile(output,`${JSON.stringify(release,null,2)}\n`,'utf8');
process.stdout.write(`Wrote ${release.files.length} verified site files beneath ${domainRoot}.\n`);
