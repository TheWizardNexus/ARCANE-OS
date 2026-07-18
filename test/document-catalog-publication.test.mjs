import assert from 'node:assert/strict';
import {
    mkdtemp,
    mkdir,
    readFile,
    rm,
    symlink,
    writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    MAXIMUM_SOURCE_BYTES,
    MAXIMUM_SOURCE_LINES,
    MAXIMUM_TOTAL_SOURCE_BYTES,
    POLICY_SCHEMA_VERSION,
    SOURCE_DIRECTORY,
    buildDocumentCatalogPublication,
    extractHeadings,
    verifyDocumentCatalogPublication
} from '../tools/document-catalog/publication.mjs';

async function createFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arcane-document-catalog-'));
    const packageRoot = path.join(root, 'package');
    const publicRoot = path.join(packageRoot, 'apps', 'reference');
    const policyFile = path.join(root, 'apps', 'reference', 'public-content.json');
    const documentText = '# Hello &amp; Arcane\n\n## Repeated\n\n## Repeated\n\nSetext heading\n---\n\n```md\n# Not a heading\n```\n';
    const documentBytes = Buffer.from(documentText, 'utf8');
    const sourceDocumentBytes = Buffer.from(
        documentText.replace(/\n/g, '\r\n'),
        'utf8'
    );
    const screenshotBytes = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a
    ]);
    const policy = {
        audience: 'public',
        documents: [
            {
                category: 'Get started',
                id: 'hello',
                source: 'docs/hello.md',
                summary: 'A deterministic fixture document.',
                tags: ['fixture', 'start'],
                title: 'Hello'
            }
        ],
        schemaVersion: 1,
        screenshots: [
            {
                output: 'hello.png',
                source: 'example/hello.png'
            }
        ],
        siteId: 'reference-docs'
    };

    await mkdir(path.dirname(policyFile), {recursive: true});
    await mkdir(path.join(root, 'docs'), {recursive: true});
    await mkdir(path.join(root, 'example'), {recursive: true});
    await mkdir(publicRoot, {recursive: true});
    await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
    await writeFile(
        path.join(root, 'docs', 'hello.md'),
        sourceDocumentBytes
    );
    await writeFile(path.join(root, 'example', 'hello.png'), screenshotBytes);

    return {
        documentBytes,
        options: {
            packageRoot,
            policyFile,
            publicRoot: 'apps/reference',
            sourceRoot: root
        },
        packageRoot,
        policy,
        policyFile,
        publicRoot,
        root,
        screenshotBytes,
        sourceDocumentBytes
    };
}

async function removeFixture(fixture) {
    await rm(fixture.root, {force: true, recursive: true});
}

async function writeFixturePolicy(fixture) {
    await writeFile(
        fixture.policyFile,
        `${JSON.stringify(fixture.policy, null, 2)}\n`,
        'utf8'
    );
}

async function addFixtureSource(
    fixture,
    {
        bytes = Buffer.from('export function restoreShell() { return true; }\r\n', 'utf8'),
        id = 'runtime-source',
        source = 'src/runtime.js',
        summary = 'A reviewed runtime source fixture.',
        tags = ['runtime', 'fixture'],
        title = 'Runtime source'
    } = {}
) {
    fixture.policy.schemaVersion = POLICY_SCHEMA_VERSION;
    fixture.policy.sources ||= [];
    fixture.policy.sources.push({id, source, summary, tags, title});
    const destination = path.join(fixture.root, ...source.split('/'));

    await mkdir(path.dirname(destination), {recursive: true});
    await writeFile(destination, bytes);
    await writeFixturePolicy(fixture);
    return destination;
}

test(
    'builds and verifies a deterministic exact-byte catalog',
    async function buildsDeterministicCatalog(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        const first = await buildDocumentCatalogPublication(fixture.options);
        const verified = await verifyDocumentCatalogPublication(fixture.options);
        const manifestPath = path.join(
            fixture.publicRoot,
            'catalog',
            'document-catalog.json'
        );
        const manifestBytes = await readFile(manifestPath);
        const manifest = JSON.parse(manifestBytes.toString('utf8'));
        const publishedDocument = await readFile(
            path.join(
                fixture.publicRoot,
                'catalog',
                'documents',
                'docs',
                'hello.md'
            )
        );
        const publishedScreenshot = await readFile(
            path.join(fixture.publicRoot, 'screenshots', 'hello.png')
        );

        assert.match(first.version, /^catalog-[a-f0-9]{64}$/);
        assert.equal(first.version, verified.version);
        assert.equal(first.documentCount, 1);
        assert.equal(first.screenshotCount, 1);
        assert.equal(first.sourceCount, 0);
        assert.equal(verified.sourceCount, 0);
        assert.deepEqual(publishedDocument, fixture.documentBytes);
        assert.deepEqual(publishedScreenshot, fixture.screenshotBytes);
        assert.equal(manifest.documents[0].kind, 'get-started');
        assert.equal(manifest.documents[0].path, 'documents/docs/hello.md');
        assert.equal(Object.hasOwn(manifest.documents[0], 'sourcePath'), false);
        assert.deepEqual(
            manifest.documents[0].headings,
            [
                {id: 'hello-and-arcane', level: 1, text: 'Hello & Arcane'},
                {id: 'repeated', level: 2, text: 'Repeated'},
                {id: 'repeated-2', level: 2, text: 'Repeated'},
                {id: 'setext-heading', level: 2, text: 'Setext heading'}
            ]
        );

        const secondPackageRoot = path.join(fixture.root, 'second-package');
        const secondPublicRoot = path.join(
            secondPackageRoot,
            'apps',
            'reference'
        );

        await mkdir(secondPublicRoot, {recursive: true});
        const secondOptions = {
            ...fixture.options,
            packageRoot: secondPackageRoot
        };
        const second = await buildDocumentCatalogPublication(secondOptions);
        const secondManifest = await readFile(
            path.join(
                secondPublicRoot,
                'catalog',
                'document-catalog.json'
            )
        );

        assert.equal(second.version, first.version);
        assert.deepEqual(secondManifest, manifestBytes);
    }
);

test(
    'rejects unsafe and case-colliding policy entries',
    async function rejectsUnsafePolicy(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        fixture.policy.documents[0].source = '../private.md';
        await writeFile(
            fixture.policyFile,
            `${JSON.stringify(fixture.policy, null, 2)}\n`,
            'utf8'
        );

        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /unsafe|source/i
        );

        fixture.policy.documents[0].source = 'docs/hello.md';
        fixture.policy.documents.push(
            {
                ...fixture.policy.documents[0],
                id: 'HELLO'
            }
        );
        await writeFile(
            fixture.policyFile,
            `${JSON.stringify(fixture.policy, null, 2)}\n`,
            'utf8'
        );

        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /lowercase|case-colliding|identifier/i
        );
    }
);

test(
    'rejects source directories reached through a link or junction',
    async function rejectsLinkedSource(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        try {
            await symlink(
                path.join(fixture.root, 'docs'),
                path.join(fixture.root, 'linked-docs'),
                process.platform === 'win32' ? 'junction' : 'dir'
            );
        } catch (error) {
            if (error?.code === 'EPERM' || error?.code === 'EACCES') {
                t.skip('This host does not permit a disposable link fixture.');
                return;
            }

            throw error;
        }

        fixture.policy.documents[0].source = 'linked-docs/hello.md';
        await writeFile(
            fixture.policyFile,
            `${JSON.stringify(fixture.policy, null, 2)}\n`,
            'utf8'
        );

        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /symbolic link|junction/i
        );
    }
);

test(
    'rejects extra generated files and source drift',
    async function rejectsPublicationDrift(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        await buildDocumentCatalogPublication(fixture.options);
        await writeFile(
            path.join(
                fixture.publicRoot,
                'catalog',
                'documents',
                'docs',
                'undeclared.md'
            ),
            '# Undeclared\n',
            'utf8'
        );

        await assert.rejects(
            verifyDocumentCatalogPublication(fixture.options),
            /positive inventory/i
        );

        await rm(
            path.join(
                fixture.publicRoot,
                'catalog',
                'documents',
                'docs',
                'undeclared.md'
            )
        );
        const extraScreenshot = path.join(
            fixture.publicRoot,
            'screenshots',
            'undeclared.png'
        );

        await writeFile(extraScreenshot, fixture.screenshotBytes);
        await assert.rejects(
            verifyDocumentCatalogPublication(fixture.options),
            /positive inventory/i
        );
        await rm(extraScreenshot);

        const publishedScreenshot = path.join(
            fixture.publicRoot,
            'screenshots',
            'hello.png'
        );

        await writeFile(publishedScreenshot, Buffer.from('tampered', 'utf8'));
        await assert.rejects(
            verifyDocumentCatalogPublication(fixture.options),
            /screenshot bytes changed/i
        );
        await writeFile(publishedScreenshot, fixture.screenshotBytes);
        await writeFile(
            path.join(fixture.root, 'docs', 'hello.md'),
            '# Changed source\n',
            'utf8'
        );

        await assert.rejects(
            verifyDocumentCatalogPublication(fixture.options),
            /manifest|reviewed source bytes|changed/i
        );
    }
);

test(
    'schema 2 publishes reviewed source as inert normalized text with searchable metadata',
    async function publishesInertSource(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        const sourceText = [
            '<!doctype html>',
            '<script>',
            'export function restoreShell() {',
            '    globalThis.__mustRemainInert = true;',
            '}',
            '</script>',
            ''
        ].join('\r\n');

        await addFixtureSource(
            fixture,
            {
                bytes: Buffer.from(sourceText, 'utf8'),
                id: 'source-runtime-view',
                source: 'views/runtime.html',
                summary: 'A hostile-looking HTML source fixture.',
                tags: ['html', 'runtime'],
                title: 'Runtime HTML source'
            }
        );

        const built = await buildDocumentCatalogPublication(fixture.options);
        const verified = await verifyDocumentCatalogPublication(fixture.options);
        const manifest = JSON.parse(
            await readFile(
                path.join(
                    fixture.publicRoot,
                    'catalog',
                    'document-catalog.json'
                ),
                'utf8'
            )
        );
        const sourceRecord = manifest.documents.find(
            record=>record.id === 'source-runtime-view'
        );
        const documentRecord = manifest.documents.find(
            record=>record.id === 'hello'
        );
        const inertPath = path.join(
            fixture.publicRoot,
            'catalog',
            SOURCE_DIRECTORY,
            'views',
            'runtime.html.txt'
        );
        const published = await readFile(inertPath);
        const normalized = Buffer.from(sourceText.replace(/\r\n?/g, '\n'), 'utf8');

        assert.equal(built.sourceCount, 1);
        assert.equal(verified.sourceCount, 1);
        assert.deepEqual(published, normalized);
        assert.equal(sourceRecord.kind, 'source-code');
        assert.equal(sourceRecord.language, 'html');
        assert.equal(sourceRecord.mediaType, 'text/plain');
        assert.equal(sourceRecord.sourcePath, 'views/runtime.html');
        assert.equal(sourceRecord.path, 'sources/views/runtime.html.txt');
        assert(sourceRecord.searchTerms.includes('restoreShell'));
        assert(sourceRecord.searchTerms.includes('globalThis'));
        assert.equal(documentRecord.language, 'markdown');
        assert.equal(documentRecord.mediaType, 'text/markdown');
        assert.equal(documentRecord.sourcePath, 'docs/hello.md');
        assert(documentRecord.searchTerms.includes('Hello'));
        await assert.rejects(
            readFile(
                path.join(
                    fixture.publicRoot,
                    'catalog',
                    SOURCE_DIRECTORY,
                    'views',
                    'runtime.html'
                )
            ),
            error=>error?.code === 'ENOENT'
        );
    }
);

test(
    'schema 2 may omit the source inventory while enriching document records',
    async function acceptsSourceFreeSchemaTwo(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        fixture.policy.schemaVersion = POLICY_SCHEMA_VERSION;
        await writeFixturePolicy(fixture);
        const built = await buildDocumentCatalogPublication(fixture.options);
        const verified = await verifyDocumentCatalogPublication(fixture.options);
        const manifest = JSON.parse(
            await readFile(
                path.join(
                    fixture.publicRoot,
                    'catalog',
                    'document-catalog.json'
                ),
                'utf8'
            )
        );

        assert.equal(built.sourceCount, 0);
        assert.equal(verified.sourceCount, 0);
        assert.equal(manifest.documents[0].sourcePath, 'docs/hello.md');
        assert.equal(manifest.documents[0].mediaType, 'text/markdown');
    }
);

test(
    'source verification rejects undeclared and tampered inert outputs',
    async function rejectsSourceOutputDrift(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        await addFixtureSource(fixture);
        await buildDocumentCatalogPublication(fixture.options);
        const sourceRoot = path.join(
            fixture.publicRoot,
            'catalog',
            SOURCE_DIRECTORY
        );
        const undeclared = path.join(sourceRoot, 'src', 'undeclared.js.txt');

        await writeFile(undeclared, 'export const undeclared = true;\n', 'utf8');
        await assert.rejects(
            verifyDocumentCatalogPublication(fixture.options),
            /positive inventory/i
        );
        await rm(undeclared);

        const published = path.join(sourceRoot, 'src', 'runtime.js.txt');

        await writeFile(published, 'tampered\n', 'utf8');
        await assert.rejects(
            verifyDocumentCatalogPublication(fixture.options),
            /published source bytes changed/i
        );
    }
);

test(
    'schema 2 source policy rejects empty, unsafe, unsupported, colliding, and unknown entries',
    async function rejectsUnsafeSourcePolicy(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        fixture.policy.sources = [
            {
                id: 'runtime-source',
                source: 'src/runtime.js',
                summary: 'Runtime source.',
                tags: ['runtime'],
                title: 'Runtime source'
            }
        ];
        await writeFixturePolicy(fixture);
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /unsupported key.*sources/i
        );

        fixture.policy.schemaVersion = POLICY_SCHEMA_VERSION;
        fixture.policy.sources = [];
        await writeFixturePolicy(fixture);
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /sources must be omitted or contain 1 through/i
        );

        fixture.policy.sources = [
            {
                id: 'runtime-source',
                source: '../runtime.js',
                summary: 'Runtime source.',
                tags: ['runtime'],
                title: 'Runtime source'
            }
        ];
        await writeFixturePolicy(fixture);
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /unsafe.*source/i
        );

        fixture.policy.sources[0].source = 'src/runtime.ts';
        await writeFixturePolicy(fixture);
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /supported UTF-8 source file/i
        );

        fixture.policy.sources = [
            {
                id: 'runtime-source-a',
                source: 'src/runtime.js',
                summary: 'Runtime source A.',
                tags: ['runtime'],
                title: 'Runtime source A'
            },
            {
                id: 'runtime-source-b',
                source: 'src/Runtime.js',
                summary: 'Runtime source B.',
                tags: ['runtime'],
                title: 'Runtime source B'
            }
        ];
        await writeFixturePolicy(fixture);
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /case-colliding source/i
        );

        fixture.policy.sources = [
            {
                id: 'runtime-source',
                language: 'javascript',
                source: 'src/runtime.js',
                summary: 'Runtime source.',
                tags: ['runtime'],
                title: 'Runtime source'
            }
        ];
        await writeFixturePolicy(fixture);
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /unsupported key.*language/i
        );
    }
);

test(
    'source inputs reject linked parents',
    async function rejectsLinkedSourceInput(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        await addFixtureSource(fixture);

        try {
            await symlink(
                path.join(fixture.root, 'src'),
                path.join(fixture.root, 'linked-src'),
                process.platform === 'win32' ? 'junction' : 'dir'
            );
        } catch (error) {
            if (error?.code === 'EPERM' || error?.code === 'EACCES') {
                t.skip('This host does not permit a disposable link fixture.');
                return;
            }

            throw error;
        }

        fixture.policy.sources[0].source = 'linked-src/runtime.js';
        await writeFixturePolicy(fixture);
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /symbolic link|junction/i
        );
    }
);

test(
    'source inputs reject invalid UTF-8, binary controls, oversized bytes, and excess lines',
    async function rejectsInvalidSourceBytes(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        const sourcePath = await addFixtureSource(fixture);

        await writeFile(sourcePath, Buffer.from([0xc3, 0x28]));
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /valid UTF-8 text/i
        );

        await writeFile(sourcePath, Buffer.from('const value = "\u0000";\n', 'utf8'));
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /binary control characters/i
        );

        await writeFile(sourcePath, Buffer.alloc(MAXIMUM_SOURCE_BYTES + 1, 0x61));
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /source runtime-source exceeds.*bytes/i
        );

        await writeFile(
            sourcePath,
            Buffer.from('x\n'.repeat(MAXIMUM_SOURCE_LINES), 'utf8')
        );
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /source runtime-source exceeds.*lines/i
        );
    }
);

test(
    'source publication enforces a bounded total byte budget',
    async function rejectsExcessTotalSourceBytes(t) {
        const fixture = await createFixture();

        t.after(
            function cleanFixture() {
                return removeFixture(fixture);
            }
        );

        fixture.policy.schemaVersion = POLICY_SCHEMA_VERSION;
        fixture.policy.sources = [];
        const directory = path.join(fixture.root, 'src', 'bulk');
        const bytes = Buffer.alloc(MAXIMUM_SOURCE_BYTES, 0x20);
        const count = Math.floor(
            MAXIMUM_TOTAL_SOURCE_BYTES / MAXIMUM_SOURCE_BYTES
        ) + 1;

        await mkdir(directory, {recursive: true});

        for (let index = 0; index < count; index += 1) {
            const suffix = String(index).padStart(3, '0');
            const relative = `src/bulk/source-${suffix}.js`;

            fixture.policy.sources.push(
                {
                    id: `bulk-source-${suffix}`,
                    source: relative,
                    summary: `Bulk source ${suffix}.`,
                    tags: ['bulk'],
                    title: `Bulk source ${suffix}`
                }
            );
            await writeFile(
                path.join(fixture.root, ...relative.split('/')),
                bytes
            );
        }

        await writeFixturePolicy(fixture);
        await assert.rejects(
            buildDocumentCatalogPublication(fixture.options),
            /published sources exceed.*total limit/i
        );
    }
);

test(
    'extracts rendered headings but ignores fenced examples',
    function extractsRenderedHeadings() {
        const headings = extractHeadings(
            '# One\n\n~~~md\n# Hidden\n~~~\n\n## Two `code`\n'
        );

        assert.deepEqual(
            headings,
            [
                {id: 'one', level: 1, text: 'One'},
                {id: 'two-code', level: 2, text: 'Two code'}
            ]
        );

        assert.deepEqual(
            extractHeadings('# A ![decorative label](image.png) B\n'),
            [
                {id: 'a-b', level: 1, text: 'A  B'}
            ]
        );
        assert.throws(
            function rejectUnsupportedNamedEntity() {
                extractHeadings('# A &copy; B\n');
            },
            /unsupported named HTML entity/i
        );
    }
);
