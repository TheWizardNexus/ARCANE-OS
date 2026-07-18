import {lstat, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {
    buildDocumentCatalogPublication,
    verifyDocumentCatalogPublication
} from '../../../tools/document-catalog/publication.mjs';

const PUBLIC_APP_ROOT = 'apps/docs';
const PUBLIC_POLICY_NAME = 'public-content.json';

function resolvePackageFile(outputRoot, relative, label) {
    const root = path.resolve(outputRoot);
    const candidate = path.resolve(root, ...relative.split('/'));
    const resolved = path.relative(root, candidate);

    if (!resolved || resolved.startsWith('..') || path.isAbsolute(resolved)) {
        throw new Error(`${label} leaves the assigned package root.`);
    }

    return candidate;
}

function publicationOptions(workspaceRoot, appRoot, outputRoot) {
    return {
        packageRoot: outputRoot,
        policyFile: path.join(appRoot, PUBLIC_POLICY_NAME),
        publicRoot: PUBLIC_APP_ROOT,
        sourceRoot: workspaceRoot
    };
}

async function buildArcanePackage(
    {
        appRoot,
        outputRoot,
        prepareBase,
        workspaceRoot
    }
) {
    if (typeof prepareBase !== 'function') {
        throw new TypeError('The Docs package adapter requires prepareBase.');
    }

    await prepareBase(outputRoot);
    const result = await buildDocumentCatalogPublication(
        publicationOptions(workspaceRoot, appRoot, outputRoot)
    );
    const marker = resolvePackageFile(outputRoot, '.nojekyll', 'Pages marker');

    await writeFile(marker, '', {encoding: 'utf8', flag: 'wx'});
    return result;
}

async function verifyArcanePackage(
    {
        appRoot,
        outputRoot,
        workspaceRoot
    }
) {
    const marker = resolvePackageFile(outputRoot, '.nojekyll', 'Pages marker');
    const details = await lstat(marker);

    if (details.isSymbolicLink() || !details.isFile() || details.size !== 0) {
        throw new Error('The Docs package must contain an empty, regular .nojekyll marker.');
    }

    return verifyDocumentCatalogPublication(
        publicationOptions(workspaceRoot, appRoot, outputRoot)
    );
}

export {
    buildArcanePackage,
    verifyArcanePackage
};
