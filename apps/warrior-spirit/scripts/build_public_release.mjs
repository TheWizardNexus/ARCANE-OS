import {copyFile,lstat,mkdir,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';

const EXCLUDED_SOURCE_FILES=new Set(['img/deepwiki_ollama_blog.html']);
const REQUIRED_WHITE_LABEL_FILES=[
    'admin.html',
    'chat.html',
    'components/nav.html',
    'dashboard.html',
    'data.html',
    'entities/Journal.js',
    'journal.html',
    'modules/PostSaveAssessmentUI.js'
];

function inside(root,...segments){
    const resolved=path.resolve(root,...segments);
    const relative=path.relative(path.resolve(root),resolved);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)){
        throw new Error(`Path leaves the assigned package root: ${segments.join('/')}`);
    }
    return resolved;
}

async function copyTree(sourceRoot,targetRoot,relative=''){
    const source=relative?inside(sourceRoot,...relative.split('/')):path.resolve(sourceRoot);
    const details=await lstat(source);
    if(details.isSymbolicLink())throw new Error(`White-label source cannot contain links: ${relative||'.'}`);
    if(details.isDirectory()){
        if(relative)await mkdir(inside(targetRoot,...relative.split('/')),{recursive:true});
        const entries=await readdir(source,{withFileTypes:true});
        for(const entry of entries.sort((left,right)=>left.name.localeCompare(right.name))){
            const child=relative?`${relative}/${entry.name}`:entry.name;
            if(EXCLUDED_SOURCE_FILES.has(child))continue;
            await copyTree(sourceRoot,targetRoot,child);
        }
        return;
    }
    if(!details.isFile())throw new Error(`Unsupported white-label source entry: ${relative}`);
    const destination=inside(targetRoot,...relative.split('/'));
    await mkdir(path.dirname(destination),{recursive:true});
    await copyFile(source,destination);
}

export async function buildArcanePackage({workspaceRoot,outputRoot,prepareBase}){
    await prepareBase(outputRoot);
    const precrisisRoot=inside(workspaceRoot,'apps','precrisis');
    const packagedPrecrisisRoot=inside(outputRoot,'apps','precrisis');
    await mkdir(packagedPrecrisisRoot,{recursive:true});
    await copyTree(precrisisRoot,packagedPrecrisisRoot);
}

export async function verifyArcanePackage({outputRoot}){
    const packagedPrecrisisRoot=inside(outputRoot,'apps','precrisis');
    for(const relative of REQUIRED_WHITE_LABEL_FILES){
        const target=inside(packagedPrecrisisRoot,...relative.split('/'));
        const details=await lstat(target);
        if(!details.isFile()||details.isSymbolicLink()){
            throw new Error(`Invalid packaged PreCrisis white-label dependency: ${relative}`);
        }
    }
    const frameAdapter=await readFile(inside(outputRoot,'apps','warrior-spirit','modules','PreCrisisFrame.js'),'utf8');
    if(!frameAdapter.includes("data-precrisis-page")||!frameAdapter.includes("precrisis-frame-ready")){
        throw new Error('Packaged Warrior Spirit runtime is missing its PreCrisis frame adapter.');
    }
    try{
        await lstat(inside(packagedPrecrisisRoot,'img','deepwiki_ollama_blog.html'));
        throw new Error('Excluded PreCrisis research material was packaged.');
    }catch(error){
        if(error?.code!=='ENOENT')throw error;
    }
    return true;
}
