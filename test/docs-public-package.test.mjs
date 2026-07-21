import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
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
const EXPECTED_SCREENSHOTS = Object.freeze([
    Object.freeze({
        source: 'example/_example_assets/htmlimportExample.png',
        output: 'htmlimportExample.png'
    }),
    Object.freeze({
        source: 'example/_example_assets/modalExample.png',
        output: 'modalExample.png'
    }),
    Object.freeze({
        source: 'example/_example_assets/navExample.png',
        output: 'navExample.png'
    }),
    Object.freeze({
        source: 'example/_example_assets/navExampleMobile.png',
        output: 'navExampleMobile.png'
    }),
    Object.freeze({
        source: 'example/_example_assets/chatExample.png',
        output: 'chatExample.png'
    }),
    Object.freeze({
        source: 'example/_example_assets/dbopfsExample.png',
        output: 'dbopfsExample.png'
    }),
    Object.freeze({
        source: 'apps/docs/guides/images/windows-add-arcane-user.jpg',
        output: 'windows-add-arcane-user.jpg'
    }),
    Object.freeze({
        source: 'apps/docs/guides/images/windows-account-awaiting-activation.jpg',
        output: 'windows-account-awaiting-activation.jpg'
    }),
    Object.freeze({
        source: 'apps/docs/guides/images/windows-account-activated.jpg',
        output: 'windows-account-activated.jpg'
    }),
    Object.freeze({
        source: 'apps/docs/guides/images/windows-arcane-shell.jpg',
        output: 'windows-arcane-shell.jpg'
    }),
    Object.freeze({
        source: 'apps/docs/guides/images/linux-add-arcane-user.png',
        output: 'linux-add-arcane-user.png'
    }),
    Object.freeze({
        source: 'apps/docs/guides/images/linux-account-awaiting-activation.png',
        output: 'linux-account-awaiting-activation.png'
    }),
    Object.freeze({
        source: 'apps/docs/guides/images/linux-account-activated.png',
        output: 'linux-account-activated.png'
    }),
    Object.freeze({
        source: 'apps/docs/guides/images/linux-arcane-shell.png',
        output: 'linux-arcane-shell.png'
    })
]);
const GALLERY_SCREENSHOT_OUTPUTS = new Set(
    EXPECTED_SCREENSHOTS
        .filter(item => item.source.startsWith('example/_example_assets/'))
        .map(item => item.output)
);

async function removeDirectory(directory) {
    await rm(directory, {force: true, recursive: true});
}

async function startPagesFixtureServer(outputRoot) {
    const projectPrefix = '/ARCANE-OS/';
    const root = path.resolve(outputRoot);
    const server = createServer(
        async function servePagesArtifact(request, response) {
            try {
                const url = new URL(request.url, 'http://127.0.0.1');
                if (!url.pathname.startsWith(projectPrefix)) {
                    response.writeHead(404).end();
                    return;
                }

                let relative = decodeURIComponent(
                    url.pathname.slice(projectPrefix.length)
                );
                if (!relative || relative.endsWith('/')) {
                    relative += 'index.html';
                }

                const candidate = path.resolve(root, ...relative.split('/'));
                const contained = path.relative(root, candidate);
                if (
                    !contained
                    || contained.startsWith('..')
                    || path.isAbsolute(contained)
                ) {
                    response.writeHead(404).end();
                    return;
                }

                const body = await readFile(candidate);
                response.writeHead(200, {
                    'content-type': relative.endsWith('.json')
                        ? 'application/json; charset=utf-8'
                        : 'text/html; charset=utf-8'
                });
                response.end(body);
            } catch {
                response.writeHead(404).end();
            }
        }
    );

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    return {
        baseURL: `http://127.0.0.1:${address.port}${projectPrefix}`,
        close: async function closeServer() {
            const closed = once(server, 'close');
            server.close();
            await closed;
        }
    };
}

test(
    'materializes the reviewed Docs catalog and explicit screenshot inventory',
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
            await writeFile(
                path.join(requestedRoot, 'index.html'),
                '<!doctype html>\n<meta charset="utf-8">\n'
                + '<meta http-equiv="refresh" '
                + 'content="0; url=./apps/docs/index.html">\n'
                + '<title>Arcane OS Docs</title>\n'
                + '<a href="./apps/docs/index.html">Open Arcane OS Docs</a>\n',
                'utf8'
            );
            await writeFile(
                path.join(requestedRoot, 'apps', 'docs', 'index.html'),
                await readFile(path.join(DOCS_ROOT, 'index.html'), 'utf8'),
                'utf8'
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
        const walkthroughSource = (
            await Promise.all(
                [
                    'provision-user-windows.md',
                    'provision-user-linux.md'
                ].map(
                    file => readFile(
                        path.join(DOCS_ROOT, 'guides', file),
                        'utf8'
                    )
                )
            )
        ).join('\n');

        assert.equal(built.documentCount, policy.documents.length);
        assert.equal(built.sourceCount, policy.sources.length);
        assert.deepEqual(policy.screenshots, EXPECTED_SCREENSHOTS);
        assert.equal(built.screenshotCount, EXPECTED_SCREENSHOTS.length);
        assert.equal(verified.verified, true);
        assert.equal(verified.sourceCount, policy.sources.length);
        assert.equal(verified.screenshotCount, EXPECTED_SCREENSHOTS.length);
        assert.equal(verified.version, built.version);
        assert.equal(
            manifest.documents.length,
            policy.documents.length+policy.sources.length
        );
        assert.equal((await readFile(path.join(outputRoot, '.nojekyll'))).length, 0);

        const pagesServer = await startPagesFixtureServer(outputRoot);
        try {
            const rootResponse = await fetch(pagesServer.baseURL);
            assert.equal(rootResponse.status, 200);
            assert.match(
                await rootResponse.text(),
                /url=\.\/apps\/docs\/index\.html/
            );

            const appResponse = await fetch(
                new URL('apps/docs/index.html', pagesServer.baseURL)
            );
            assert.equal(appResponse.status, 200);
            assert.match(await appResponse.text(), /<base href="\.\.\/\.\.\/">/);

            const catalogResponse = await fetch(
                new URL(
                    'apps/docs/catalog/document-catalog.json',
                    pagesServer.baseURL
                )
            );
            assert.equal(catalogResponse.status, 200);
            assert.deepEqual(await catalogResponse.json(), manifest);
        } finally {
            await pagesServer.close();
        }

        const htmlSource=policy.sources.find(item=>item.source.endsWith('.html'));
        const htmlRecord=manifest.documents.find(item=>item.id===htmlSource.id);
        assert.equal(htmlRecord.mediaType,'text/plain');
        assert.equal(htmlRecord.sourcePath,htmlSource.source);
        assert.equal(htmlRecord.path,`sources/${htmlSource.source}.txt`);
        assert.equal(
            await readFile(
                path.join(
                    outputRoot,
                    'apps',
                    'docs',
                    'catalog',
                    ...htmlRecord.path.split('/')
                ),
                'utf8'
            ),
            (await readFile(path.join(TEST_ROOT,htmlSource.source),'utf8')).replace(/\r\n?/g,'\n')
        );

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
            assert.match(
                GALLERY_SCREENSHOT_OUTPUTS.has(screenshot.output)
                    ? docsAppSource
                    : walkthroughSource,
                new RegExp(screenshot.output.replaceAll('.', '\\.'))
            );
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
        const attributes = await readFile(
            path.join(TEST_ROOT, '.gitattributes'),
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

        for (
            const canonicalTextRule of [
                'apps/docs/**/*.css text eol=lf',
                'apps/docs/**/*.html text eol=lf',
                'apps/docs/**/*.js text eol=lf',
                'apps/docs/**/*.json text eol=lf',
                'apps/docs/**/*.md text eol=lf',
                'apps/docs/**/*.mjs text eol=lf',
                'arcane/**/*.css text eol=lf',
                'arcane/**/*.html text eol=lf',
                'arcane/**/*.js text eol=lf',
                'arcane/**/*.json text eol=lf',
                'arcane/**/*.mjs text eol=lf',
                'arcane/**/*.svg text eol=lf',
                'arcane/**/*.txt text eol=lf',
                'test/source-code-viewer.test.mjs text eol=lf'
            ]
        ) {
            assert.equal(attributes.includes(canonicalTextRule), true);
        }
    }
);

test(
    'validates Docs pull requests read-only and deploys only trusted main builds',
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
        const pushStart = workflow.indexOf('    push:');
        const pullRequestStart = workflow.indexOf('    pull_request:');
        const dispatchStart = workflow.indexOf('    workflow_dispatch:');
        const buildStart = workflow.indexOf('    build:');
        const deployStart = workflow.indexOf('    deploy:');
        const pushBlock = workflow.slice(pushStart, pullRequestStart);
        const pullRequestBlock = workflow.slice(
            pullRequestStart,
            dispatchStart
        );
        const build = workflow.slice(buildStart, deployStart);
        const deploy = workflow.slice(deployStart);
        const collectPaths = function collectWorkflowPaths(block) {
            return Array.from(
                block.matchAll(/^\s{12}- '([^']+)'/gm),
                function selectPath(match) {
                    return match[1];
                }
            );
        };
        const pushPaths = collectPaths(pushBlock);
        const pullRequestPaths = collectPaths(pullRequestBlock);
        const mainOnlyCondition =
            "if: github.event_name != 'pull_request' && "
            + "github.ref == 'refs/heads/main'";

        assert.notEqual(pushStart, -1);
        assert.notEqual(pullRequestStart, -1);
        assert.notEqual(dispatchStart, -1);
        assert.notEqual(buildStart, -1);
        assert.notEqual(deployStart, -1);

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
        assert.match(pullRequestBlock, /branches:\s*\[main\]/);
        assert.doesNotMatch(workflow, /pull_request_target/);
        assert.deepEqual(pullRequestPaths, pushPaths);
        assert.match(
            build,
            /actions\/checkout@v6\s*\r?\n\s+with:\s*\r?\n\s+persist-credentials: false/
        );
        assert.match(build, /permissions:\s*\r?\n\s+contents: read/);
        assert.doesNotMatch(build, /^\s+pages:\s*(?:read|write)\s*$/m);
        assert.doesNotMatch(build, /^\s+id-token:/m);
        assert.doesNotMatch(
            build.slice(0, build.indexOf('runs-on:')),
            /^\s+if:/m
        );
        assert.doesNotMatch(build, /actions\/configure-pages/);
        assert.match(deploy, /permissions:\s*\r?\n\s+pages: write\s*\r?\n\s+id-token: write/);
        assert.doesNotMatch(deploy, /^\s+contents:/m);
        assert.equal(
            build.includes(mainOnlyCondition),
            true
        );
        assert.equal(
            deploy.includes(mainOnlyCondition),
            true
        );
        assert(
            workflow.indexOf('node tools/package-app.mjs check docs')
            < workflow.indexOf('actions/upload-pages-artifact@v4')
        );
        assert(
            workflow.indexOf('actions/upload-pages-artifact@v4')
            < workflow.indexOf('actions/deploy-pages@v4')
        );
        assert(
            deploy.indexOf('actions/configure-pages@v5')
            < deploy.indexOf('actions/deploy-pages@v4')
        );
        assert.equal(
            (
                workflow.match(
                    /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/g
                ) || []
            ).length,
            2
        );

        for (
            const examplePath of [
                'example/component_markdown_document/**',
                'example/component_source_code_viewer/**',
                'example/module_AsyncBoundary/**',
                'example/module_BrowserTestSuite/**',
                'example/module_ScopedOPFSCache/**',
                'example/module_StaticDocumentCatalog/**'
            ]
        ) {
            assert.equal(pushPaths.includes(examplePath), true);
        }

        for (
            const focusedTest of [
                'app-data-scope',
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
                'source-code-viewer',
                'static-document-catalog',
                'wait-for-component'
            ]
        ) {
            assert.match(workflow, new RegExp(`test/${focusedTest}\\.test\\.mjs`));
        }
    }
);
