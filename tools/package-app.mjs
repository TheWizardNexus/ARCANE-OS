#!/usr/bin/env node

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    bumpVersion,
    discoverApps,
    inspectApp,
    packageApp,
    parseSemver,
    verifyApp
} from './app-packager/core.mjs';

const SCRIPT_PATH=fileURLToPath(import.meta.url);
const DEFAULT_WORKSPACE=path.resolve(path.dirname(SCRIPT_PATH),'..');
const FLAG_OPTIONS=new Set(['all','dry-run','help','json']);
const VALUE_OPTIONS=new Set(['bump','preid','set','workspace']);

function usage(){
    return `Arcane OS public app packager

Usage:
  node tools/package-app.mjs list [--json]
  node tools/package-app.mjs inspect <app> [--json]
  node tools/package-app.mjs package <app> [--bump patch|minor|major|prerelease] [--preid rc] [--set 1.2.3] [--dry-run]
  node tools/package-app.mjs package --all [--dry-run]
  node tools/package-app.mjs release <app> [--bump patch|minor|major|prerelease] [--preid rc] [--dry-run]
  node tools/package-app.mjs check <app>
  node tools/package-app.mjs check --all
  node tools/package-app.mjs bump <app> <patch|minor|major|prerelease|version> [--preid rc] [--dry-run]

Aliases:
  build = package, verify = check

Behavior:
  package builds the configured version reproducibly.
  release defaults to a patch bump and commits the version only after a verified build.
  Every output is isolated at dist/<app>; --dry-run changes neither source nor dist.
`;
}

function parseArguments(argv){
    const positionals=[];
    const options={};

    for(let index=0;index<argv.length;index++){
        const token=argv[index];

        if(token==='-h'){
            options.help=true;
            continue;
        }

        if(!token.startsWith('--')){
            positionals.push(token);
            continue;
        }

        const separator=token.indexOf('=');
        const name=token.slice(2,separator===-1?undefined:separator);

        if(!FLAG_OPTIONS.has(name)&&!VALUE_OPTIONS.has(name)){
            throw new Error(`Unknown option: --${name}`);
        }

        if(Object.hasOwn(options,name)){
            throw new Error(`Option --${name} was provided more than once.`);
        }

        if(FLAG_OPTIONS.has(name)){
            if(separator!==-1){
                throw new Error(`Option --${name} does not take a value.`);
            }

            options[name]=true;
            continue;
        }

        const value=separator===-1?argv[++index]:token.slice(separator+1);

        if(!value||value.startsWith('--')){
            throw new Error(`Option --${name} requires a value.`);
        }

        options[name]=value;
    }

    return {positionals,options};
}

function assertOptions(options,allowed){
    for(const name of Object.keys(options)){
        if(!allowed.has(name)){
            throw new Error(`Option --${name} is not valid for this command.`);
        }
    }
}

function requireOneApp(positionals,options){
    if(options.all){
        if(positionals.length){
            throw new Error('Choose one app id or --all, not both.');
        }

        return null;
    }

    if(positionals.length!==1){
        throw new Error('Exactly one app id is required (or use --all).');
    }

    return positionals[0];
}

async function selectedApps(workspaceRoot,appId,all){
    if(!all){
        return [appId];
    }

    const discovered=await discoverApps({workspaceRoot});
    const invalid=discovered.filter(app=>app.configured&&app.status!=='ready');

    if(invalid.length){
        throw new Error(`Cannot package --all while app configurations are invalid: ${invalid.map(app=>app.id).join(', ')}`);
    }

    const ready=discovered.filter(app=>app.status==='ready').map(app=>app.id);

    if(!ready.length){
        throw new Error('No configured apps are ready.');
    }

    return ready;
}

function formatBytes(bytes){
    if(bytes<1024){
        return `${bytes} B`;
    }

    const units=['KiB','MiB','GiB','TiB'];
    let value=bytes;
    let unit=-1;

    do{
        value/=1024;
        unit+=1;
    }while(value>=1024&&unit<units.length-1);

    return `${value.toFixed(value>=10?1:2)} ${units[unit]}`;
}

function printList(apps){
    const headings=['APP','VERSION','DIST','STRATEGY','STATUS'];
    const rows=apps.map(app=>[
        app.id,
        app.version??'-',
        app.distVersion??'-',
        app.strategy??'-',
        app.status
    ]);
    const widths=headings.map((heading,index)=>Math.max(
        heading.length,
        ...rows.map(row=>String(row[index]).length)
    ));
    const render=row=>row.map((value,index)=>String(value).padEnd(widths[index])).join('  ').trimEnd();
    console.log(render(headings));
    console.log(render(widths.map(width=>'-'.repeat(width))));

    for(const row of rows){
        console.log(render(row));
    }
}

function printInspection(result){
    console.log(`${result.displayName} (${result.id})`);
    console.log(`  Version: ${result.version}${result.distVersion?` (dist: ${result.distVersion})`:''}`);
    console.log(`  Strategy: ${result.strategy}${result.adapter?` via ${result.adapter}`:''}`);
    console.log(`  Entry: ${result.entry}`);
    console.log(`  Output: ${result.output}`);
    console.log(`  Static base: ${result.baseFileCount} files, ${formatBytes(result.baseBytes)}`);
    console.log(`  Shared payloads: ${result.shared.join(', ')||'[none]'}`);
    console.log(`  Includes: ${result.include.join(', ')}`);
    console.log(`  Excludes: ${result.exclude.join(', ')||'[none]'}`);

    if(result.note){
        console.log(`  Note: ${result.note}`);
    }

    if(result.largestFiles.length){
        console.log('  Largest base files:');

        for(const file of result.largestFiles.slice(0,5)){
            console.log(`    ${formatBytes(file.bytes).padStart(10)}  ${file.path}`);
        }
    }
}

function printOperation(result,verb){
    const version=result.currentVersion===result.version
        ?result.version
        :`${result.currentVersion} -> ${result.version}`;
    const prefix=result.dryRun?'Dry run':'Done';
    console.log(`${prefix}: ${verb} ${result.app} ${version}`);

    if(result.output){
        console.log(`  Output: ${result.output}`);
    }

    if(result.fileCount!==undefined){
        console.log(`  Verified: ${result.fileCount} files, ${formatBytes(result.totalBytes)}`);
        console.log(`  Content SHA-256: ${result.contentSha256}`);
    }else if(result.baseFileCount!==undefined){
        console.log(`  Static base: ${result.baseFileCount} files, ${formatBytes(result.baseBytes)}`);
    }
}

function output(value,json,printer){
    if(json){
        console.log(JSON.stringify(value,null,2));
        return;
    }

    printer(value);
}

async function withMachineReadableStdout(enabled,operation){
    if(!enabled){
        return operation();
    }

    const originalLog=console.log;
    console.log=(...values)=>console.error(...values);

    try{
        return await operation();
    }finally{
        console.log=originalLog;
    }
}

async function main(argv=process.argv.slice(2)){
    const {positionals,options}=parseArguments(argv);
    const command=positionals.shift();

    if(options.help||!command||command==='help'){
        assertOptions(options,new Set(['help','workspace']));
        console.log(usage());
        return;
    }

    const workspaceRoot=path.resolve(options.workspace??DEFAULT_WORKSPACE);

    if(command==='list'){
        assertOptions(options,new Set(['json','workspace']));

        if(positionals.length){
            throw new Error('list does not accept an app id.');
        }

        const apps=await discoverApps({workspaceRoot});
        output(apps,options.json,printList);
        return;
    }

    if(command==='inspect'){
        assertOptions(options,new Set(['json','workspace']));

        if(positionals.length!==1){
            throw new Error('inspect requires exactly one app id.');
        }

        const result=await inspectApp({workspaceRoot,appId:positionals[0]});
        output(result,options.json,printInspection);
        return;
    }

    if(command==='package'||command==='build'||command==='release'){
        assertOptions(options,new Set([
            'all',
            'bump',
            'dry-run',
            'json',
            'preid',
            'set',
            'workspace'
        ]));
        const appId=requireOneApp(positionals,options);
        let bump=options.bump;

        if(bump==='none'){
            bump=undefined;
        }else if(bump&&!['major','minor','patch','prerelease'].includes(bump)){
            throw new Error(`Unsupported bump: ${bump}`);
        }

        if(command==='release'&&!options.set&&!options.bump){
            bump='patch';
        }

        if(options.all&&(bump||options.set)){
            throw new Error('Version-changing --all releases are not atomic. Package current versions with --all, or release apps individually.');
        }

        if(options.preid&&bump!=='prerelease'){
            throw new Error('--preid requires --bump prerelease.');
        }

        if(options.set){
            parseSemver(options.set);
        }

        const ids=await selectedApps(workspaceRoot,appId,options.all);
        const results=await withMachineReadableStdout(options.json,async()=>{
            const packaged=[];

            for(const id of ids){
                packaged.push(await packageApp({
                    workspaceRoot,
                    appId:id,
                    bump,
                    preid:options.preid,
                    exactVersion:options.set,
                    dryRun:options['dry-run']
                }));
            }

            return packaged;
        });

        output(
            options.all?results:results[0],
            options.json,
            value=>{
                for(const result of Array.isArray(value)?value:[value]){
                    printOperation(result,options['dry-run']?'would package':'packaged');
                }
            }
        );
        return;
    }

    if(command==='check'||command==='verify'){
        assertOptions(options,new Set(['all','json','workspace']));
        const appId=requireOneApp(positionals,options);
        const ids=await selectedApps(workspaceRoot,appId,options.all);
        const results=await withMachineReadableStdout(options.json,async()=>{
            const verified=[];

            for(const id of ids){
                verified.push(await verifyApp({workspaceRoot,appId:id}));
            }

            return verified;
        });

        output(
            options.all?results:results[0],
            options.json,
            value=>{
                for(const result of Array.isArray(value)?value:[value]){
                    console.log(`Verified ${result.app} ${result.version}: ${result.fileCount} files, ${formatBytes(result.totalBytes)} (${result.output})`);
                }
            }
        );
        return;
    }

    if(command==='bump'){
        assertOptions(options,new Set(['dry-run','json','preid','workspace']));

        if(positionals.length!==2){
            throw new Error('bump requires an app id and a level or exact semantic version.');
        }

        const [appId,revision]=positionals;
        const isLevel=['major','minor','patch','prerelease'].includes(revision);

        if(options.preid&&revision!=='prerelease'){
            throw new Error('--preid is only valid with the prerelease bump level.');
        }

        if(!isLevel){
            parseSemver(revision);
        }

        const result=await bumpVersion({
            workspaceRoot,
            appId,
            bump:isLevel?revision:undefined,
            preid:options.preid,
            exactVersion:isLevel?undefined:revision,
            dryRun:options['dry-run']
        });
        output(result,options.json,value=>printOperation(value,'version'));
        return;
    }

    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

if(path.resolve(process.argv[1]??'')===path.resolve(SCRIPT_PATH)){
    main().catch(error=>{
        console.error(process.env.ARCANE_PACKAGER_DEBUG==='1'
            ?error?.stack||error
            :`Arcane packager: ${error?.message||error}`
        );
        process.exitCode=1;
    });
}

export {main};
