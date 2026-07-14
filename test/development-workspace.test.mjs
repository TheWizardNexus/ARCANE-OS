import assert from 'node:assert/strict';
import test from 'node:test';
import DevelopmentWorkspace,{contextQuery,setupTaskId,workspaceRoot} from '../arcane/modules/DevelopmentWorkspace.js';

test('development workspace normalizes bounded public inputs',()=>{
    assert.equal(workspaceRoot('  C:\\work\\arcane  '),'C:\\work\\arcane');
    assert.equal(contextQuery('  explain the shell  '),'explain the shell');
    assert.equal(setupTaskId('ROOT-DEPENDENCIES'),'root-dependencies');
    assert.throws(()=>workspaceRoot(''),/Choose one existing/);
    assert.throws(()=>workspaceRoot(`root\u0000escape`),/Choose one existing/);
    assert.throws(()=>contextQuery('x'.repeat(4097)),/bounded plain text/);
    assert.throws(()=>setupTaskId('../command'),/registered development setup task/);
});

test('development workspace delegates only inspect, context, and registered setup IDs',async()=>{
    const calls=[];
    const provider={
        inspect:async root=>{calls.push(['inspect',root]);return {root,valid:true};},
        context:async(root,query)=>{calls.push(['context',root,query]);return {root,query,files:[]};},
        setup:async(root,taskId)=>{calls.push(['setup',root,taskId]);return {root,taskId,status:'completed'};},
        installNode:async()=>{calls.push(['installNode']);return {installed:true};}
    };
    const workspace=new DevelopmentWorkspace(provider);

    assert.equal(workspace.available,true);
    assert.deepEqual(await workspace.inspect(' C:\\arcane '),{root:'C:\\arcane',valid:true});
    assert.deepEqual(await workspace.context('C:\\arcane',' status '),{root:'C:\\arcane',query:'status',files:[]});
    assert.deepEqual(await workspace.setup('C:\\arcane','GIT-HOOKS'),{root:'C:\\arcane',taskId:'git-hooks',status:'completed'});
    assert.equal(workspace.nodeInstallerAvailable,true);
    assert.deepEqual(await workspace.installNode(),{installed:true});
    assert.deepEqual(calls,[
        ['inspect','C:\\arcane'],
        ['context','C:\\arcane','status'],
        ['setup','C:\\arcane','git-hooks'],
        ['installNode']
    ]);
});

test('development workspace fails closed when the native provider is absent',()=>{
    const workspace=new DevelopmentWorkspace(null);
    assert.equal(workspace.available,false);
    assert.equal(workspace.nodeInstallerAvailable,false);
    assert.throws(()=>workspace.inspect('C:\\arcane'),/capability is unavailable/);
    assert.throws(()=>workspace.installNode(),/capability is unavailable/);
});
