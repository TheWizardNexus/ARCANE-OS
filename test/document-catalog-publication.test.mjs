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
        assert.deepEqual(publishedDocument, fixture.documentBytes);
        assert.deepEqual(publishedScreenshot, fixture.screenshotBytes);
        assert.equal(manifest.documents[0].kind, 'get-started');
        assert.equal(manifest.documents[0].path, 'documents/docs/hello.md');
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
