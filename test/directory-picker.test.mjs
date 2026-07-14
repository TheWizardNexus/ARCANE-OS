import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import DirectoryPicker,{
    normalizeDirectoryPickerOptions,
    normalizeDirectorySelection,
} from '../arcane/modules/DirectoryPicker.js';

const read=relative=>readFile(new URL(`../${relative}`,import.meta.url),'utf8');

test('directory picker validates its neutral options and provider result',()=>{
    assert.deepEqual(
        normalizeDirectoryPickerOptions({
            title:'  Choose a workspace  ',
            initialPath:'  C:\\work\\arcane  ',
        }),
        {title:'Choose a workspace',initialPath:'C:\\work\\arcane'},
    );
    assert(Object.isFrozen(normalizeDirectoryPickerOptions({})));
    assert.throws(()=>normalizeDirectoryPickerOptions([]),/plain object/);
    assert.throws(()=>normalizeDirectoryPickerOptions({multiple:true}),/Unsupported/);
    assert.throws(()=>normalizeDirectoryPickerOptions({title:'x'.repeat(161)}),/exceeds/);
    assert.throws(()=>normalizeDirectoryPickerOptions({initialPath:'bad\u0000path'}),/control/);

    assert.deepEqual(
        normalizeDirectorySelection({cancelled:false,path:' C:\\work\\arcane '}),
        {cancelled:false,path:'C:\\work\\arcane'},
    );
    assert.deepEqual(
        normalizeDirectorySelection({cancelled:true,path:null}),
        {cancelled:true,path:null},
    );
    assert.throws(
        ()=>normalizeDirectorySelection({cancelled:true,path:'ignored'}),
        error=>error?.code==='DIRECTORY_PICKER_INVALID_RESULT',
    );
    assert.throws(
        ()=>normalizeDirectorySelection({cancelled:false,path:'C:\\work',extra:true}),
        error=>error?.code==='DIRECTORY_PICKER_INVALID_RESULT',
    );
    assert.throws(
        ()=>normalizeDirectorySelection({cancelled:false,path:''}),
        error=>error?.code==='DIRECTORY_PICKER_INVALID_RESULT',
    );
});

test('directory picker delegates once and preserves cancellation as data',async()=>{
    const calls=[];
    const picker=new DirectoryPicker({
        selectDirectory:async options=>{
            calls.push(options);
            return calls.length===1
                ?{cancelled:false,path:'C:\\selected'}
                :{cancelled:true,path:null};
        },
    });

    assert.equal(picker.available,true);
    assert.deepEqual(
        await picker.select({title:'Select folder',initialPath:'C:\\start'}),
        {cancelled:false,path:'C:\\selected'},
    );
    assert.deepEqual(await picker.select(),{cancelled:true,path:null});
    assert.deepEqual(calls,[
        {title:'Select folder',initialPath:'C:\\start'},
        {},
    ]);
});

test('directory picker fails closed when the native provider is unavailable',async()=>{
    const picker=new DirectoryPicker(null);
    assert.equal(picker.available,false);
    await assert.rejects(
        picker.select(),
        error=>error?.code==='DIRECTORY_PICKER_UNAVAILABLE',
    );
});

test('shared directory picker component exposes an accessible native-only contract',async()=>{
    const [component,example,readme]=await Promise.all([
        read('arcane/components/directory-picker.html'),
        read('example/component_directory_picker/index.html'),
        read('example/component_directory_picker/README.md'),
    ]);

    const theme=component.indexOf('arcane/css/theme.css');
    const primitives=component.indexOf('arcane/css/primitives.css');
    const componentStyle=component.indexOf('<style>');
    assert(theme>=0&&primitives>theme&&componentStyle>primitives);
    assert.match(component,/<label[^>]+for="path"/);
    assert.match(component,/<input[^>]+id="path"[^>]+readonly/);
    assert.match(component,/host\.configure=configure/);
    assert.match(component,/host\.focus=focus/);
    assert.match(component,/host\.select=select/);
    assert.match(component,/value:\{get:\(\)=>currentValue,set:setValue\}/);
    assert.match(component,/disabled:\{get:\(\)=>disabled,set:setDisabled\}/);
    for(const event of [
        'directory-picker-ready',
        'directory-picker-change',
        'directory-picker-cancel',
        'directory-picker-error',
    ]) assert.match(component,new RegExp(event));
    assert.match(component,/if\(result\.cancelled\)/);
    assert.doesNotMatch(component,/showDirectoryPicker|webkitdirectory|type="file"|readEntries|readdir/i);
    assert.doesNotMatch(component,/(?:^|[;:{\s])#[0-9a-f]{3,8}\b/i);

    assert.match(example,/arcane\/modules\/ThemeBootstrap\.js/);
    assert.match(example,/arcane\/components\/directory-picker\.html/);
    assert.match(readme,/existing value is preserved/i);
});
