import {createHash} from 'node:crypto';
import {
    lstat,
    mkdir,
    readFile,
    readdir,
    realpath,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';

import {marked} from '../../arcane/modules/Marked.min.js';
import {
    normalizeStaticDocumentCatalog
} from '../../arcane/modules/StaticDocumentCatalog.js';

const POLICY_SCHEMA_VERSION = 1;
const CATALOG_FILE_NAME = 'document-catalog.json';
const DOCUMENT_DIRECTORY = 'documents';
const SCREENSHOT_DIRECTORY = 'screenshots';
const MAXIMUM_DOCUMENT_BYTES = 1048576;
const MAXIMUM_SCREENSHOT_BYTES = 5242880;
const MAXIMUM_DOCUMENTS = 512;
const MAXIMUM_SCREENSHOTS = 64;
const MAXIMUM_HEADINGS = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DOCUMENT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SITE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SCREENSHOT_EXTENSIONS = new Set([
    '.jpeg',
    '.jpg',
    '.png',
    '.webp'
]);
const FORBIDDEN_SOURCE_SEGMENTS = new Set([
    '.agents',
    '.codex',
    '.git',
    'dist',
    'local',
    'node_modules'
]);

function fail(message) {
    throw new Error(message);
}

function isPlainObject(value) {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function compareText(left, right) {
    const leftText = String(left);
    const rightText = String(right);

    if (leftText < rightText) {
        return -1;
    }

    if (leftText > rightText) {
        return 1;
    }

    return 0;
}

function compareDocuments(left, right) {
    return compareText(left.id, right.id);
}

function compareScreenshots(left, right) {
    return compareText(left.output, right.output);
}

function compareFileRecords(left, right) {
    return compareText(left.relative, right.relative);
}

function assertOnlyKeys(value, allowed, label) {
    if (!isPlainObject(value)) {
        fail(`${label} must be a JSON object.`);
    }

    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            fail(`${label} has an unsupported key: ${key}`);
        }
    }
}

function boundedText(value, label, maximum) {
    if (
        typeof value !== 'string'
        || !value.trim()
        || value !== value.trim()
        || value.length > maximum
        || CONTROL_CHARACTERS.test(value)
        || value !== value.normalize('NFC')
    ) {
        fail(`${label} must be bounded, trimmed Unicode NFC text.`);
    }

    return value;
}

function pathKey(value) {
    return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function safeRelativePath(value, label) {
    if (
        typeof value !== 'string'
        || !value
        || value.includes('\\')
        || value.includes('%')
        || value.includes('?')
        || value.includes('#')
        || CONTROL_CHARACTERS.test(value)
        || value !== value.normalize('NFC')
        || path.posix.isAbsolute(value)
        || /^[a-z]:/i.test(value)
    ) {
        fail(`Unsafe ${label}: ${String(value)}`);
    }

    const segments = value.split('/');

    for (const segment of segments) {
        if (
            !segment
            || segment === '.'
            || segment === '..'
            || segment.includes(':')
            || segment.endsWith('.')
            || segment.endsWith(' ')
            || WINDOWS_RESERVED_NAME.test(segment)
        ) {
            fail(`Unsafe ${label}: ${value}`);
        }
    }

    return segments.join('/');
}

function safeSourcePath(value, label) {
    const normalized = safeRelativePath(value, label);

    for (const segment of normalized.split('/')) {
        const key = pathKey(segment);

        if (
            FORBIDDEN_SOURCE_SEGMENTS.has(key)
            || key === '.env'
            || key.startsWith('.env.')
        ) {
            fail(`${label} selects a forbidden source segment: ${value}`);
        }
    }

    return normalized;
}

function isInside(root, candidate, allowEqual = false) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));

    return (allowEqual && relative === '')
        || Boolean(
            relative
            && !relative.startsWith('..')
            && !path.isAbsolute(relative)
        );
}

function resolveInside(root, relative, label, allowRoot = false) {
    const normalized = allowRoot && relative === '.'
        ? '.'
        : safeRelativePath(relative, label);
    const candidate = normalized === '.'
        ? path.resolve(root)
        : path.resolve(root, ...normalized.split('/'));

    if (!isInside(root, candidate, allowRoot)) {
        fail(`${label} leaves its assigned root: ${relative}`);
    }

    return candidate;
}

function relativeFrom(root, candidate, label) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));

    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        fail(`${label} must be inside the source root.`);
    }

    return safeRelativePath(relative.replaceAll('\\', '/'), label);
}

async function assertRealDirectory(directory, label) {
    const details = await lstat(directory);

    if (details.isSymbolicLink() || !details.isDirectory()) {
        fail(`${label} must be a real directory.`);
    }
}

async function assertRealDirectoryWithin(root, directory, label) {
    const resolvedRoot = path.resolve(root);
    const resolvedDirectory = path.resolve(directory);

    if (!isInside(resolvedRoot, resolvedDirectory, true)) {
        fail(`${label} leaves its assigned root.`);
    }

    await assertRealDirectory(resolvedRoot, `${label} root`);

    const relative = path.relative(resolvedRoot, resolvedDirectory);
    let current = resolvedRoot;

    for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const details = await lstat(current);

        if (details.isSymbolicLink() || !details.isDirectory()) {
            fail(`${label} must not contain a symbolic link, junction, or non-directory parent.`);
        }
    }

    const actualRoot = await realpath(resolvedRoot);
    const actualDirectory = await realpath(resolvedDirectory);

    if (!isInside(actualRoot, actualDirectory, true)) {
        fail(`${label} resolves outside its assigned root.`);
    }
}

async function assertRealSourceFile(sourceRoot, relative, label) {
    const normalized = safeSourcePath(relative, label);
    const root = path.resolve(sourceRoot);
    const candidate = resolveInside(root, normalized, label);

    await assertRealDirectory(root, 'Source root');

    let current = root;
    const segments = normalized.split('/');

    for (let index = 0; index < segments.length; index += 1) {
        current = path.join(current, segments[index]);
        const details = await lstat(current);

        if (details.isSymbolicLink()) {
            fail(`${label} cannot contain a symbolic link or junction: ${relative}`);
        }

        if (index < segments.length - 1 && !details.isDirectory()) {
            fail(`${label} contains a non-directory parent: ${relative}`);
        }

        if (index === segments.length - 1 && !details.isFile()) {
            fail(`${label} must select a regular file: ${relative}`);
        }
    }

    const actualRoot = await realpath(root);
    const actualCandidate = await realpath(candidate);

    if (!isInside(actualRoot, actualCandidate)) {
        fail(`${label} resolves outside the source root: ${relative}`);
    }

    return candidate;
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8(bytes, label) {
    try {
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch (error) {
        fail(`${label} must contain valid UTF-8 text: ${error.message}`);
    }
}

function normalizeTags(value, label) {
    if (!Array.isArray(value) || value.length > 32) {
        fail(`${label} must be an array with no more than 32 tags.`);
    }

    const tags = [];
    const seen = new Set();

    for (let index = 0; index < value.length; index += 1) {
        const tag = boundedText(value[index], `${label}[${index}]`, 64);
        const key = pathKey(tag);

        if (seen.has(key)) {
            fail(`${label} contains a duplicate tag: ${tag}`);
        }

        seen.add(key);
        tags.push(tag);
    }

    return tags;
}

function categoryKind(value, label) {
    const category = boundedText(value, label, 64);
    const kind = category
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);

    if (!kind || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(kind)) {
        fail(`${label} cannot be represented as a catalog kind.`);
    }

    return kind;
}

function normalizeDocumentPolicy(value, index) {
    const label = `documents[${index}]`;

    assertOnlyKeys(
        value,
        new Set([
            'category',
            'id',
            'source',
            'summary',
            'tags',
            'title'
        ]),
        label
    );

    const id = boundedText(value.id, `${label}.id`, 80);

    if (!DOCUMENT_ID.test(id)) {
        fail(`${label}.id must be a lowercase, filesystem-safe identifier.`);
    }

    const source = safeSourcePath(value.source, `${label}.source`);

    if (path.posix.extname(source).toLowerCase() !== '.md') {
        fail(`${label}.source must select a Markdown file.`);
    }

    return {
        category: boundedText(value.category, `${label}.category`, 64),
        id,
        kind: categoryKind(value.category, `${label}.category`),
        source,
        summary: boundedText(value.summary, `${label}.summary`, 2048),
        tags: normalizeTags(value.tags, `${label}.tags`),
        title: boundedText(value.title, `${label}.title`, 256)
    };
}

function normalizeScreenshotPolicy(value, index) {
    const label = `screenshots[${index}]`;

    assertOnlyKeys(
        value,
        new Set([
            'output',
            'source'
        ]),
        label
    );

    const source = safeSourcePath(value.source, `${label}.source`);
    const output = safeRelativePath(value.output, `${label}.output`);
    const sourceExtension = path.posix.extname(source).toLowerCase();
    const outputExtension = path.posix.extname(output).toLowerCase();

    if (
        !SCREENSHOT_EXTENSIONS.has(sourceExtension)
        || sourceExtension !== outputExtension
    ) {
        fail(`${label} must preserve a supported screenshot extension.`);
    }

    return {output, source};
}

function assertUnique(values, field, label) {
    const seen = new Set();

    for (const value of values) {
        const item = value[field];
        const key = pathKey(item);

        if (seen.has(key)) {
            fail(`${label} contains a case-colliding ${field}: ${item}`);
        }

        seen.add(key);
    }
}

function normalizePolicy(value) {
    assertOnlyKeys(
        value,
        new Set([
            'audience',
            'documents',
            'schemaVersion',
            'screenshots',
            'siteId'
        ]),
        'Public content policy'
    );

    if (value.schemaVersion !== POLICY_SCHEMA_VERSION) {
        fail(`Public content policy schemaVersion must be ${POLICY_SCHEMA_VERSION}.`);
    }

    if (value.audience !== 'public') {
        fail('Public content policy audience must be "public".');
    }

    const siteId = boundedText(value.siteId, 'Public content policy siteId', 80);

    if (!SITE_ID.test(siteId)) {
        fail('Public content policy siteId must be a lowercase, filesystem-safe identifier.');
    }

    if (
        !Array.isArray(value.documents)
        || !value.documents.length
        || value.documents.length > MAXIMUM_DOCUMENTS
    ) {
        fail(`Public content policy documents must contain 1 through ${MAXIMUM_DOCUMENTS} entries.`);
    }

    if (
        !Array.isArray(value.screenshots)
        || value.screenshots.length > MAXIMUM_SCREENSHOTS
    ) {
        fail(`Public content policy screenshots must contain at most ${MAXIMUM_SCREENSHOTS} entries.`);
    }

    const documents = [];
    const screenshots = [];

    for (let index = 0; index < value.documents.length; index += 1) {
        documents.push(normalizeDocumentPolicy(value.documents[index], index));
    }

    for (let index = 0; index < value.screenshots.length; index += 1) {
        screenshots.push(normalizeScreenshotPolicy(value.screenshots[index], index));
    }

    assertUnique(documents, 'id', 'Public content policy documents');
    assertUnique(documents, 'source', 'Public content policy documents');
    assertUnique(screenshots, 'source', 'Public content policy screenshots');
    assertUnique(screenshots, 'output', 'Public content policy screenshots');
    documents.sort(compareDocuments);
    screenshots.sort(compareScreenshots);

    return {
        audience: 'public',
        documents,
        schemaVersion: POLICY_SCHEMA_VERSION,
        screenshots,
        siteId
    };
}

async function loadPolicy(sourceRoot, policyFile) {
    const relativePolicy = relativeFrom(
        sourceRoot,
        policyFile,
        'Public content policy path'
    );
    const resolvedPolicy = await assertRealSourceFile(
        sourceRoot,
        relativePolicy,
        'Public content policy path'
    );
    const bytes = await readFile(resolvedPolicy);
    const text = decodeUtf8(bytes, 'Public content policy');
    let value;

    try {
        value = JSON.parse(text);
    } catch (error) {
        fail(`Public content policy is not valid JSON: ${error.message}`);
    }

    return normalizePolicy(value);
}

function inlineTokenText(tokens) {
    let text = '';

    if (!Array.isArray(tokens)) {
        return text;
    }

    for (const token of tokens) {
        if (token.type === 'image') {
            continue;
        }

        if (Array.isArray(token.tokens)) {
            text += inlineTokenText(token.tokens);
            continue;
        }

        if (typeof token.text === 'string') {
            text += token.text;
        }
    }

    return text;
}

function decodeEntity(entity) {
    const named = {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        quot: '"'
    };
    const body = entity.slice(1, -1);

    if (Object.hasOwn(named, body)) {
        return named[body];
    }

    if (/^[a-z][a-z0-9]+$/i.test(body)) {
        fail(`Markdown heading contains an unsupported named HTML entity: &${body};`);
    }

    const hexadecimal = /^#x([0-9a-f]+)$/i.exec(body);
    const decimal = /^#([0-9]+)$/.exec(body);
    const codePoint = hexadecimal
        ? Number.parseInt(hexadecimal[1], 16)
        : decimal
            ? Number.parseInt(decimal[1], 10)
            : Number.NaN;

    if (
        !Number.isInteger(codePoint)
        || codePoint < 0
        || codePoint > 0x10ffff
        || codePoint >= 0xd800 && codePoint <= 0xdfff
    ) {
        fail(`Markdown heading contains an invalid numeric HTML entity: ${entity}`);
    }

    return String.fromCodePoint(codePoint);
}

function headingText(token) {
    const raw = inlineTokenText(token.tokens) || String(token.text || '');
    const withoutTags = raw.replace(/<[^>]*>/g, '');
    const decoded = withoutTags.replace(
        /&(?:[a-z][a-z0-9]+|#\d+|#x[0-9a-f]+);/gi,
        decodeEntity
    );
    const normalized = decoded.trim();

    return normalized || 'Untitled section';
}

function headingBase(value) {
    const identifier = String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

    return identifier || 'section';
}

function nextHeadingIdentifier(value, usedIdentifiers) {
    const base = headingBase(value);
    let candidate = base;
    let suffix = 2;

    while (usedIdentifiers.has(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
    }

    usedIdentifiers.add(candidate);
    return candidate;
}

function extractHeadings(markdown) {
    const tokens = marked.lexer(
        markdown,
        {
            gfm: true,
            pedantic: false
        }
    );
    const headings = [];
    const usedIdentifiers = new Set();

    marked.walkTokens(
        tokens,
        function collectHeadingToken(token) {
            if (token.type !== 'heading') {
                return;
            }

            if (headings.length >= MAXIMUM_HEADINGS) {
                fail(`Markdown contains more than ${MAXIMUM_HEADINGS} headings.`);
            }

            const text = headingText(token);

            if (text.length > 256) {
                fail('Markdown heading text exceeds 256 characters.');
            }

            headings.push(
                {
                    id: nextHeadingIdentifier(text, usedIdentifiers),
                    level: token.depth,
                    text
                }
            );
        }
    );

    return headings;
}

async function inspectDocument(sourceRoot, policy) {
    const source = await assertRealSourceFile(
        sourceRoot,
        policy.source,
        `Document source for ${policy.id}`
    );
    const sourceBytes = await readFile(source);

    if (sourceBytes.byteLength > MAXIMUM_DOCUMENT_BYTES) {
        fail(`Document ${policy.id} exceeds ${MAXIMUM_DOCUMENT_BYTES} bytes.`);
    }

    const sourceText = decodeUtf8(sourceBytes, `Document ${policy.id}`);
    const text = sourceText.replace(/\r\n?|\n/g, '\n');
    const bytes = Buffer.from(text, 'utf8');
    const record = {
        byteSize: bytes.byteLength,
        examples: [],
        headings: extractHeadings(text),
        id: policy.id,
        kind: policy.kind,
        path: `${DOCUMENT_DIRECTORY}/${policy.source}`,
        screenshots: [],
        sha256: sha256(bytes),
        summary: policy.summary,
        tags: policy.tags,
        title: policy.title
    };

    return {bytes, policy, record};
}

async function inspectScreenshot(sourceRoot, policy) {
    const source = await assertRealSourceFile(
        sourceRoot,
        policy.source,
        `Screenshot source for ${policy.output}`
    );
    const bytes = await readFile(source);

    if (bytes.byteLength > MAXIMUM_SCREENSHOT_BYTES) {
        fail(`Screenshot ${policy.output} exceeds ${MAXIMUM_SCREENSHOT_BYTES} bytes.`);
    }

    return {
        byteSize: bytes.byteLength,
        bytes,
        output: policy.output,
        sha256: sha256(bytes),
        source: policy.source
    };
}

async function inspectPublicationInputs(sourceRoot, policyFile) {
    const policy = await loadPolicy(sourceRoot, policyFile);
    const documents = [];
    const screenshots = [];

    for (const documentPolicy of policy.documents) {
        documents.push(await inspectDocument(sourceRoot, documentPolicy));
    }

    for (const screenshotPolicy of policy.screenshots) {
        screenshots.push(await inspectScreenshot(sourceRoot, screenshotPolicy));
    }

    const records = [];

    for (const document of documents) {
        records.push(document.record);
    }

    const versionSource = {
        audience: policy.audience,
        documents: records,
        schemaVersion: POLICY_SCHEMA_VERSION,
        screenshots: screenshots.map(
            function projectScreenshot(screenshot) {
                return {
                    byteSize: screenshot.byteSize,
                    output: screenshot.output,
                    sha256: screenshot.sha256
                };
            }
        ),
        siteId: policy.siteId
    };
    const version = `catalog-${sha256(Buffer.from(JSON.stringify(versionSource), 'utf8'))}`;
    const manifest = normalizeStaticDocumentCatalog(
        {
            documents: records,
            version
        }
    );

    return {documents, manifest, policy, screenshots};
}

function renderedManifest(manifest) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function assertFreshDirectory(directory, label) {
    try {
        await mkdir(directory);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            fail(`${label} must not exist before publication.`);
        }

        throw error;
    }
}

function normalizePublicationOptions(options) {
    if (!isPlainObject(options)) {
        fail('Publication options must be an object.');
    }

    assertOnlyKeys(
        options,
        new Set([
            'packageRoot',
            'policyFile',
            'publicRoot',
            'sourceRoot'
        ]),
        'Publication options'
    );

    for (const field of ['packageRoot', 'policyFile', 'publicRoot', 'sourceRoot']) {
        if (typeof options[field] !== 'string' || !options[field].trim()) {
            fail(`Publication option ${field} must be a path.`);
        }
    }

    const packageRoot = path.resolve(options.packageRoot);
    const sourceRoot = path.resolve(options.sourceRoot);
    const publicRelative = safeRelativePath(options.publicRoot, 'publicRoot');
    const publicRoot = resolveInside(packageRoot, publicRelative, 'publicRoot');

    return {
        catalogRoot: resolveInside(publicRoot, 'catalog', 'catalog output'),
        documentRoot: resolveInside(
            publicRoot,
            `catalog/${DOCUMENT_DIRECTORY}`,
            'document output'
        ),
        packageRoot,
        policyFile: path.resolve(options.policyFile),
        publicRoot,
        screenshotRoot: resolveInside(
            publicRoot,
            SCREENSHOT_DIRECTORY,
            'screenshot output'
        ),
        sourceRoot
    };
}

async function collectFiles(root, relative = '') {
    const directory = relative
        ? resolveInside(root, relative, 'publication inventory directory')
        : path.resolve(root);
    const details = await lstat(directory);

    if (details.isSymbolicLink() || !details.isDirectory()) {
        fail('Publication inventory root must be a real directory.');
    }

    const entries = await readdir(directory, {withFileTypes: true});
    const files = [];
    entries.sort(
        function compareDirectoryEntries(left, right) {
            return compareText(left.name, right.name);
        }
    );

    for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        const target = resolveInside(root, child, 'publication inventory entry');
        const childDetails = await lstat(target);

        if (entry.isSymbolicLink() || childDetails.isSymbolicLink()) {
            fail(`Publication inventory cannot contain links: ${child}`);
        }

        if (entry.isDirectory() && childDetails.isDirectory()) {
            files.push(...await collectFiles(root, child));
            continue;
        }

        if (!entry.isFile() || !childDetails.isFile()) {
            fail(`Publication inventory contains a special entry: ${child}`);
        }

        files.push({absolute: target, relative: child});
    }

    files.sort(compareFileRecords);
    return files;
}

function assertExactInventory(actual, expected, label) {
    const actualPaths = actual.map(
        function selectActualPath(file) {
            return file.relative;
        }
    );
    const expectedPaths = [...expected].sort(compareText);

    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
        fail(`${label} does not match its positive inventory.`);
    }
}

function buffersEqual(left, right) {
    return left.byteLength === right.byteLength && left.equals(right);
}

async function buildDocumentCatalogPublication(options) {
    const normalized = normalizePublicationOptions(options);

    await assertRealDirectory(normalized.sourceRoot, 'Source root');
    await assertRealDirectory(normalized.packageRoot, 'Package root');
    await assertRealDirectoryWithin(
        normalized.packageRoot,
        normalized.publicRoot,
        'Public app root'
    );

    const inspected = await inspectPublicationInputs(
        normalized.sourceRoot,
        normalized.policyFile
    );

    await assertFreshDirectory(normalized.catalogRoot, 'Catalog output');
    await mkdir(normalized.documentRoot);
    await assertFreshDirectory(normalized.screenshotRoot, 'Screenshot output');

    for (const document of inspected.documents) {
        const destination = resolveInside(
            normalized.documentRoot,
            document.policy.source,
            `Document output for ${document.policy.id}`
        );

        await mkdir(path.dirname(destination), {recursive: true});
        await writeFile(destination, document.bytes, {flag: 'wx'});
    }

    for (const screenshot of inspected.screenshots) {
        const destination = resolveInside(
            normalized.screenshotRoot,
            screenshot.output,
            `Screenshot output for ${screenshot.output}`
        );

        await mkdir(path.dirname(destination), {recursive: true});
        await writeFile(destination, screenshot.bytes, {flag: 'wx'});
    }

    await writeFile(
        resolveInside(normalized.catalogRoot, CATALOG_FILE_NAME, 'Catalog manifest'),
        renderedManifest(inspected.manifest),
        {
            encoding: 'utf8',
            flag: 'wx'
        }
    );

    return {
        documentCount: inspected.documents.length,
        screenshotCount: inspected.screenshots.length,
        version: inspected.manifest.version
    };
}

async function verifyDocumentCatalogPublication(options) {
    const normalized = normalizePublicationOptions(options);

    await assertRealDirectory(normalized.sourceRoot, 'Source root');
    await assertRealDirectory(normalized.packageRoot, 'Package root');
    await assertRealDirectoryWithin(
        normalized.packageRoot,
        normalized.publicRoot,
        'Public app root'
    );
    await assertRealDirectoryWithin(
        normalized.publicRoot,
        normalized.catalogRoot,
        'Catalog output'
    );
    await assertRealDirectoryWithin(
        normalized.catalogRoot,
        normalized.documentRoot,
        'Document output'
    );
    await assertRealDirectoryWithin(
        normalized.publicRoot,
        normalized.screenshotRoot,
        'Screenshot output'
    );

    const inspected = await inspectPublicationInputs(
        normalized.sourceRoot,
        normalized.policyFile
    );
    const manifestPath = resolveInside(
        normalized.catalogRoot,
        CATALOG_FILE_NAME,
        'Catalog manifest'
    );
    const actualManifestBytes = await readFile(manifestPath);
    const expectedManifestBytes = Buffer.from(
        renderedManifest(inspected.manifest),
        'utf8'
    );

    if (!buffersEqual(actualManifestBytes, expectedManifestBytes)) {
        fail('Catalog manifest does not match the reviewed source bytes and metadata.');
    }

    let actualManifest;

    try {
        actualManifest = JSON.parse(decodeUtf8(actualManifestBytes, 'Catalog manifest'));
    } catch (error) {
        fail(`Catalog manifest is not valid JSON: ${error.message}`);
    }

    normalizeStaticDocumentCatalog(actualManifest);

    const catalogFiles = await collectFiles(normalized.catalogRoot);
    const expectedCatalogFiles = [CATALOG_FILE_NAME];

    for (const document of inspected.documents) {
        expectedCatalogFiles.push(`${DOCUMENT_DIRECTORY}/${document.policy.source}`);
    }

    assertExactInventory(catalogFiles, expectedCatalogFiles, 'Catalog output');

    for (const document of inspected.documents) {
        const published = await readFile(
            resolveInside(
                normalized.documentRoot,
                document.policy.source,
                `Published document ${document.policy.id}`
            )
        );

        if (!buffersEqual(published, document.bytes)) {
            fail(`Published document bytes changed: ${document.policy.id}`);
        }
    }

    const screenshotFiles = await collectFiles(normalized.screenshotRoot);
    const expectedScreenshotFiles = inspected.screenshots.map(
        function selectScreenshotOutput(screenshot) {
            return screenshot.output;
        }
    );

    assertExactInventory(
        screenshotFiles,
        expectedScreenshotFiles,
        'Screenshot output'
    );

    for (const screenshot of inspected.screenshots) {
        const published = await readFile(
            resolveInside(
                normalized.screenshotRoot,
                screenshot.output,
                `Published screenshot ${screenshot.output}`
            )
        );

        if (!buffersEqual(published, screenshot.bytes)) {
            fail(`Published screenshot bytes changed: ${screenshot.output}`);
        }
    }

    return {
        documentCount: inspected.documents.length,
        screenshotCount: inspected.screenshots.length,
        verified: true,
        version: inspected.manifest.version
    };
}

export {
    CATALOG_FILE_NAME,
    DOCUMENT_DIRECTORY,
    POLICY_SCHEMA_VERSION,
    SCREENSHOT_DIRECTORY,
    buildDocumentCatalogPublication,
    extractHeadings,
    verifyDocumentCatalogPublication
};
