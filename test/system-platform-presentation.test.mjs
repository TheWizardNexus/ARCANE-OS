import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../arcane/modules/SystemPlatformPresentation.js', import.meta.url), 'utf8');

function loadPresentation() {
    const context = vm.createContext({});
    new vm.Script(source, { filename: 'SystemPlatformPresentation.js' }).runInContext(context);
    return context.ArcaneSystemPlatformPresentation;
}

function fakeRoot(...initialClasses) {
    const classes = new Set(initialClasses);
    return {
        dataset: {},
        classList: {
            add: (...names) => names.forEach((name) => classes.add(name)),
            remove: (...names) => names.forEach((name) => classes.delete(name)),
            contains: (name) => classes.has(name),
        },
    };
}

test('system platform presentation maps technical windows/win32 identifiers to Microsoft NT', () => {
    const presentation = loadPresentation();
    assert.equal(presentation.kernelType({ platform: 'windows', rawPlatform: 'win32' }), 'nt');
    assert.equal(presentation.displayName({ platform: 'windows', displayName: 'Windows' }), 'Microsoft NT');
    assert.equal(presentation.displayName({ rawPlatform: 'win32' }), 'Microsoft NT');
});

test('system platform presentation prefers the effective platform over a different simulation host', () => {
    const presentation = loadPresentation();
    const simulatedLinux = {
        platform: 'linux',
        rawPlatform: 'linux',
        execution: { effectivePlatform: 'linux', hostPlatform: 'win32', simulation: true },
    };

    assert.equal(presentation.kernelType(simulatedLinux), 'linux');
    assert.equal(presentation.displayName(simulatedLinux), 'Linux');
});

test('system platform presentation applies one presentation-only kernel marker to the root element', () => {
    const presentation = loadPresentation();
    const root = fakeRoot('arcane-kernel', 'arcane-kernel-nt', 'unrelated');

    const linux = presentation.apply({ platform: 'linux', displayName: 'Linux' }, root);
    assert.deepEqual(JSON.parse(JSON.stringify(linux)), { kernelType: 'linux', displayName: 'Linux' });
    assert.equal(root.classList.contains('arcane-kernel'), true);
    assert.equal(root.classList.contains('arcane-kernel-linux'), true);
    assert.equal(root.classList.contains('arcane-kernel-nt'), false);
    assert.equal(root.classList.contains('unrelated'), true);
    assert.equal(root.dataset.arcaneKernel, 'linux');

    const unknown = presentation.apply({ platform: 'plan9', displayName: 'Plan 9' }, root);
    assert.equal(unknown.kernelType, null);
    assert.equal(unknown.displayName, 'Plan 9');
    assert.equal(root.classList.contains('arcane-kernel'), false);
    assert.equal(root.classList.contains('arcane-kernel-linux'), false);
    assert.equal('arcaneKernel' in root.dataset, false);
});
