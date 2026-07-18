import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
    buildArcanePackage,
    verifyArcanePackage
} from '../apps/docs/scripts/build_public_release.mjs';

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_ROOT = path.join(TEST_ROOT, 'apps', 'docs');

async function removeDirectory(directory) {
    await rm(directory, {force: true, recursive: true});
}

test(
    'materializes the reviewed Docs catalog and all six screenshots',
    async function materializesDocsPublication(t) {
        const temporaryRoot = await mkdtemp(
            path.join(os.tmpdir(), 'arcane-docs-package-')
        );
        const outputRoot = path.join(temporaryRoot, 'release');

        t.after(
            function cleanRelease() {
                return removeDirectory(temporaryRoot);
            }
        );

        async function prepareBase(requestedRoot) {
            assert.equal(path.resolve(requestedRoot), path.resolve(outputRoot));
            await mkdir(
                path.join(requestedRoot, 'apps', 'docs'),
                {recursive: true}
            );
        }

        const built = await buildArcanePackage(
            {
                appRoot: DOCS_ROOT,
                outputRoot,
                prepareBase,
                workspaceRoot: TEST_ROOT
            }
        );
        const verified = await verifyArcanePackage(
            {
                appRoot: DOCS_ROOT,
                outputRoot,
                workspaceRoot: TEST_ROOT
            }
        );
        const policy = JSON.parse(
            await readFile(
                path.join(DOCS_ROOT, 'public-content.json'),
                'utf8'
            )
        );
        const manifest = JSON.parse(
            await readFile(
                path.join(
                    outputRoot,
                    'apps',
                    'docs',
                    'catalog',
                    'document-catalog.json'
                ),
                'utf8'
            )
        );
        const docsAppSource = await readFile(
            path.join(DOCS_ROOT, 'modules', 'DocsApp.js'),
            'utf8'
        );

        assert.equal(built.documentCount, policy.documents.length);
        assert.equal(built.screenshotCount, 6);
        assert.equal(verified.verified, true);
        assert.equal(verified.version, built.version);
        assert.equal(manifest.documents.length, policy.documents.length);
        assert.equal((await readFile(path.join(outputRoot, '.nojekyll'))).length, 0);

        for (const screenshot of policy.screenshots) {
            const source = await readFile(path.join(TEST_ROOT, screenshot.source));
            const published = await readFile(
                path.join(
                    outputRoot,
                    'apps',
                    'docs',
                    'screenshots',
                    screenshot.output
                )
            );

            assert.deepEqual(published, source);
            assert.match(docsAppSource, new RegExp(screenshot.output.replace('.', '\\.')));
        }
    }
);

test(
    'keeps the Docs package adapter thin and generated content out of source includes',
    async function verifiesDocsPackagePolicy() {
        const config = JSON.parse(
            await readFile(path.join(DOCS_ROOT, 'arcane-package.json'), 'utf8')
        );
        const adapter = await readFile(
            path.join(DOCS_ROOT, 'scripts', 'build_public_release.mjs'),
            'utf8'
        );

        assert.equal(config.strategy, 'adapter');
        assert.equal(config.adapter, 'scripts/build_public_release.mjs');
        assert.equal(config.include.includes('catalog'), false);
        assert.equal(config.include.includes('guides'), false);
        assert.equal(config.include.includes('screenshots'), false);
        assert.equal(config.exclude.includes('scripts'), true);
        assert.match(adapter, /buildDocumentCatalogPublication/);
        assert.match(adapter, /verifyDocumentCatalogPublication/);
        assert.doesNotMatch(adapter, /readdir|documents\.map|createHash/);
    }
);

test(
    'defines a verified main-only GitHub Pages deployment',
    async function verifiesPagesWorkflow() {
        const workflow = await readFile(
            path.join(
                TEST_ROOT,
                '.github',
                'workflows',
                'arcane-docs-pages.yml'
            ),
            'utf8'
        );

        assert.match(workflow, /actions\/checkout@v6/);
        assert.match(workflow, /actions\/configure-pages@v5/);
        assert.match(workflow, /actions\/upload-pages-artifact@v4/);
        assert.match(workflow, /actions\/deploy-pages@v4/);
        assert.match(workflow, /branches:\s*\[main\]/);
        assert.match(workflow, /group:\s*arcane-docs-pages-\$\{\{ github\.ref \}\}/);
        assert.match(workflow, /npm run verify:package-locks/);
        assert.match(workflow, /npm ci/);
        assert.match(workflow, /node tools\/package-app\.mjs package docs/);
        assert.match(workflow, /node tools\/package-app\.mjs check docs/);
        assert.match(workflow, /path:\s*dist\/docs/);
        assert.match(workflow, /needs:\s*build/);
        assert.match(workflow, /pages:\s*write/);
        assert.match(workflow, /id-token:\s*write/);
        assert.doesNotMatch(workflow, /pull_request:/);
        assert(
            workflow.indexOf('node tools/package-app.mjs check docs')
            < workflow.indexOf('actions/upload-pages-artifact@v4')
        );
        assert(
            workflow.indexOf('actions/upload-pages-artifact@v4')
            < workflow.indexOf('actions/deploy-pages@v4')
        );
        assert.equal(
            (
                workflow.match(
                    /if: github\.ref == 'refs\/heads\/main'/g
                ) || []
            ).length,
            2
        );

        for (
            const focusedTest of [
                'async-boundary',
                'browser-test-suite',
                'component-contracts',
                'configured-ai-chat-session',
                'docs-site',
                'document-catalog-publication',
                'docs-public-package',
                'html-import-cache',
                'markdown-document-component',
                'scoped-opfs-cache',
                'static-document-catalog',
                'wait-for-component'
            ]
        ) {
            assert.match(workflow, new RegExp(`test/${focusedTest}\\.test\\.mjs`));
        }
    }
);
