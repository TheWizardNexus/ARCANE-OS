import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
);

const GOVERNANCE_DOCUMENTS = {
    'docs/rc-acceptance.md': {
        headings: [
            '## Required outcome',
            '## Required release artifacts',
            '#### Evidence gates',
            '#### Decision',
            '## Completion test'
        ],
        links: [
            'docs/rc-success-criteria.md',
            'docs/rc-requirements-traceability.md',
            'docs/security-privacy-review.md',
            'docs/accessibility-verification.md'
        ]
    },
    'docs/rc-success-criteria.md': {
        headings: [
            '## RC eligibility criteria',
            '### RC blocker thresholds',
            '## Pilot exit criteria',
            '#### Findings and decision',
            '## Human-authority decisions'
        ],
        links: [
            'docs/rc-acceptance.md',
            'docs/rc-requirements-traceability.md'
        ]
    },
    'docs/rc-requirements-traceability.md': {
        headings: [
            '## RC accountability roles',
            '## Traceability matrix',
            '## Matrix review checklist',
            '## Change record'
        ],
        links: [
            'docs/rc-acceptance.md',
            'docs/rc-success-criteria.md',
            'docs/threat-model.md',
            'docs/accessibility-baseline.md'
        ]
    },
    'docs/security-privacy-review.md': {
        headings: [
            '## Required outcome',
            '## Compact review record',
            '#### Findings',
            '#### Decision',
            '## Completion test'
        ],
        links: [
            'docs/threat-model.md'
        ]
    },
    'docs/threat-model.md': {
        headings: [
            '## Protected assets and harmful outcomes',
            '## Architecture and trust boundaries',
            '## Privacy data inventory',
            '## Abuse-case register',
            '## Priority residual risks'
        ],
        links: [
            'docs/security-privacy-review.md',
            'docs/rc-requirements-traceability.md'
        ]
    },
    'docs/accessibility-verification.md': {
        headings: [
            '## Required outcome',
            '## Required test matrix',
            '## Compact verification record',
            '#### Findings',
            '#### Decision',
            '## Completion test'
        ],
        links: [
            'docs/accessibility-baseline.md'
        ]
    },
    'docs/accessibility-baseline.md': {
        headings: [
            '## Conformance requirements',
            '## Required verification matrix',
            '## Severity and release gates',
            '## Candidate evidence record',
            '#### Findings',
            '#### Decision',
            '## Completion test'
        ],
        links: [
            'docs/accessibility-verification.md'
        ]
    }
};

const REQUIRED_GOVERNANCE_PATHS = Object.keys(GOVERNANCE_DOCUMENTS);

function readRepositoryFile(relativePath) {
    return fs.readFileSync(
        path.join(REPOSITORY_ROOT, relativePath),
        'utf8'
    );
}

function assertContains(content, expected, ownerPath) {
    assert.ok(
        content.includes(expected),
        `${ownerPath} must contain ${expected}`
    );
}

function localMarkdownTargets(ownerPath, content) {
    const ownerDirectory = path.dirname(
        path.join(REPOSITORY_ROOT, ownerPath)
    );
    const targets = new Set();
    const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

    for (const match of content.matchAll(linkPattern)) {
        const rawTarget = match[1].split('#', 1)[0];

        if (!rawTarget || /^[a-z]+:/i.test(rawTarget)) {
            continue;
        }

        targets.add(path.resolve(ownerDirectory, rawTarget));
    }

    return targets;
}

function assertLinksTo(content, expectedPath, ownerPath) {
    const expectedTarget = path.resolve(REPOSITORY_ROOT, expectedPath);
    const targets = localMarkdownTargets(ownerPath, content);

    assert.ok(
        targets.has(expectedTarget),
        `${ownerPath} must link to ${expectedPath}`
    );
    assert.ok(
        fs.existsSync(expectedTarget),
        `${ownerPath} link target must exist: ${expectedPath}`
    );
}

function assertGovernanceReferences(ownerPath) {
    const content = readRepositoryFile(ownerPath);

    for (const governancePath of REQUIRED_GOVERNANCE_PATHS) {
        assertLinksTo(content, governancePath, ownerPath);
    }
}

function assertGovernanceDocumentContract(documentPath, contract) {
    const content = readRepositoryFile(documentPath);

    for (const heading of contract.headings) {
        assertContains(content, heading, documentPath);
    }

    for (const link of contract.links) {
        assertLinksTo(content, link, documentPath);
    }
}

test(
    'repository orientation references every RC governance artifact',
    function testRepositoryGovernanceReferences() {
        assertGovernanceReferences('AGENTS.md');
        assertGovernanceReferences('README.md');
    }
);

test(
    'RC governance documents preserve required records, gates, and cross-links',
    function testGovernanceDocumentContracts() {
        for (const documentPath of Object.keys(GOVERNANCE_DOCUMENTS)) {
            assertGovernanceDocumentContract(
                documentPath,
                GOVERNANCE_DOCUMENTS[documentPath]
            );
        }
    }
);

test(
    'traceability matrix preserves success, threat, and accessibility artifacts',
    function testTraceabilityGovernanceArtifacts() {
        const traceability = readRepositoryFile(
            'docs/rc-requirements-traceability.md'
        );
        const requiredArtifacts = [
            'docs/rc-success-criteria.md',
            'docs/threat-model.md',
            'docs/accessibility-baseline.md'
        ];

        for (const requiredArtifact of requiredArtifacts) {
            assertLinksTo(
                traceability,
                requiredArtifact,
                'docs/rc-requirements-traceability.md'
            );
        }
    }
);
