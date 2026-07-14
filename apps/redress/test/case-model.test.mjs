import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CASE_FOLDERS,
    CASE_SCHEMA_VERSION,
    buildCaseTree,
    buildEvidenceFileName,
    canonicalImportPath,
    classifyCasePath,
    companionPathFor,
    createCaseProfile,
    createCaseRecord,
    importSkipReason,
    normalizeRelativePath,
    pairCaseCompanions,
    parseFilingFileName,
    shouldSkipImportPath
} from '../modules/CaseModel.js';

const PETITION='24-10-28 [TERUKO MILLER] - Petition for Dissolution of Marriage';
const ORDER_COPY='24-12-04 [COURT] - Restraining Order After Hearing DV-130 Original Order Copy 2';

test('exports the versioned canonical filing and evidence folders',()=>{
    assert.equal(CASE_SCHEMA_VERSION,1);
    assert.deepEqual(CASE_FOLDERS,{
        filingRoot:'Filing by Filing',
        filingPdf:'Filing by Filing/PDF',
        filingMarkdown:'Filing by Filing/MD',
        evidenceRoot:'Evidence',
        evidenceRaw:'Evidence/Raw',
        evidenceMarkdown:'Evidence/MD'
    });
    assert.ok(Object.isFrozen(CASE_FOLDERS));
});

test('normalizes Windows separators while preserving meaningful filename text',()=>{
    assert.equal(
        normalizeRelativePath(`Filing by Filing\\PDF\\${ORDER_COPY}.pdf`),
        `Filing by Filing/PDF/${ORDER_COPY}.pdf`
    );
    assert.equal(normalizeRelativePath('Evidence/Raw/Caf\u00e9/photo.jpg'),'Evidence/Raw/Caf\u00e9/photo.jpg');
    assert.equal(normalizeRelativePath(''),'');
});

test('rejects absolute paths, traversal, malformed segments, and Windows devices',()=>{
    for(const path of [
        'C:\\case\\file.pdf',
        '/case/file.pdf',
        '..\\outside.pdf',
        'Evidence//file.pdf',
        'Evidence/./file.pdf',
        'Evidence/Raw/NUL.txt',
        'Evidence/Raw/bad?.txt',
        'Evidence/Raw/trailing. '
    ]){
        assert.throws(()=>normalizeRelativePath(path),RangeError,path);
    }
    assert.throws(()=>normalizeRelativePath(null),TypeError);
});

test('skip rules exclude merged, derived, workspace, QA, temp, and junk paths',()=>{
    const skipped=[
        '24FL001068/Court provided merged PDFs/packet.pdf',
        `Filing by Filing/MD/_rendered_pages/${PETITION}/page-0001.png`,
        'tmp/pdf_to_markdown/work.txt',
        'qa_highlight_review/page.png',
        'output/report.pdf',
        '.git/config',
        'Evidence/Raw/Thumbs.db',
        'Evidence/Raw/~$notes.docx'
    ];
    for(const path of skipped){
        assert.equal(shouldSkipImportPath(path),true,path);
    }
    assert.equal(shouldSkipImportPath('Evidence/Raw/client/photo.jpg'),false);
    assert.equal(
        shouldSkipImportPath('Filing by Filing/MD/_rendered_pages/doc/page.png',{includeDerived:true}),
        false
    );
    assert.equal(importSkipReason('C:\\absolute\\file.pdf'),'invalid-path');
});

test('parses filing names and preserves Copy suffixes as meaningful title text',()=>{
    const parsed=parseFilingFileName(`${ORDER_COPY}.pdf`);
    assert.deepEqual(
        {
            dateToken:parsed.dateToken,
            isoDate:parsed.isoDate,
            actor:parsed.actor,
            title:parsed.title,
            baseTitle:parsed.baseTitle,
            copySuffix:parsed.copySuffix,
            copyNumber:parsed.copyNumber,
            extension:parsed.extension
        },
        {
            dateToken:'24-12-04',
            isoDate:'2024-12-04',
            actor:'COURT',
            title:'Restraining Order After Hearing DV-130 Original Order Copy 2',
            baseTitle:'Restraining Order After Hearing DV-130 Original Order',
            copySuffix:'Copy 2',
            copyNumber:2,
            extension:'.pdf'
        }
    );
    assert.equal(
        parseFilingFileName('24-12-27 [DEREK AUSTIN AND ERIC RIVIERA-JURADO] - Proof of Electronic Service.md').actor,
        'DEREK AUSTIN AND ERIC RIVIERA-JURADO'
    );
});

test('filing parser rejects malformed names and impossible dates',()=>{
    assert.equal(parseFilingFileName('Petition.pdf'),null);
    assert.equal(parseFilingFileName('24-02-30 [COURT] - Impossible Order.pdf'),null);
    assert.equal(parseFilingFileName('24-10-28 [] - Missing Actor.pdf'),null);
    assert.equal(parseFilingFileName('24-10-28 [COURT] - .pdf'),null);
});

test('canonical import mapping recognizes complete roots and folder-only drops',()=>{
    assert.equal(
        canonicalImportPath(`24FL001068/Filing by Filing/PDF/${PETITION}.pdf`),
        `Filing by Filing/PDF/${PETITION}.pdf`
    );
    assert.equal(
        canonicalImportPath(`PDF/${PETITION}.pdf`),
        `Filing by Filing/PDF/${PETITION}.pdf`
    );
    assert.equal(
        canonicalImportPath('old-export/Evidence/Files/phone/photo.jpg'),
        'Evidence/Raw/phone/photo.jpg'
    );
    assert.equal(
        canonicalImportPath('messages/thread.json',{target:'evidence'}),
        'Evidence/Raw/messages/thread.json'
    );
    assert.equal(canonicalImportPath('RFA_question_text_comparison.md'),null);
    assert.equal(canonicalImportPath('output/report.pdf'),null);
});

test('canonical import auto-routes loose convention-compliant filings',()=>{
    assert.equal(
        canonicalImportPath(`${PETITION}.pdf`),
        `Filing by Filing/PDF/${PETITION}.pdf`
    );
    assert.equal(
        canonicalImportPath(`${PETITION}.md`),
        `Filing by Filing/MD/${PETITION}.md`
    );
});

test('classifies canonical filing, evidence, description, render, and unsupported paths',()=>{
    const filing=classifyCasePath(`Filing by Filing/PDF/${PETITION}.pdf`);
    assert.equal(filing.kind,'filing-pdf');
    assert.equal(filing.bucket,'filing');
    assert.equal(filing.parsedFiling.actor,'TERUKO MILLER');

    assert.equal(classifyCasePath(`Filing by Filing/MD/${PETITION}.md`).kind,'filing-markdown');
    assert.equal(classifyCasePath('Evidence/Raw/phone/call.m4a').kind,'evidence-raw');
    assert.equal(classifyCasePath('Evidence/MD/phone/call.md').kind,'evidence-markdown');
    assert.equal(classifyCasePath('Filing by Filing/PDF/notes.docx').kind,'filing-unsupported');

    const render=classifyCasePath('Filing by Filing/MD/_rendered_pages/doc/page-0001.png');
    assert.equal(render.kind,'filing-render');
    assert.equal(render.skipped,true);
    assert.equal(render.skipReason,'derived-render-cache');
});

test('builds same-basename Markdown companion paths without dropping Copy suffixes',()=>{
    assert.equal(
        companionPathFor(`Filing by Filing/PDF/${ORDER_COPY}.pdf`),
        `Filing by Filing/MD/${ORDER_COPY}.md`
    );
    assert.equal(
        companionPathFor('Evidence/Raw/audio/visit-call.m4a'),
        'Evidence/MD/audio/visit-call.md'
    );
    assert.equal(companionPathFor(`Filing by Filing/MD/${PETITION}.md`),null);
    assert.equal(
        companionPathFor('phone/photo.jpg',{target:'evidence'}),
        'Evidence/MD/phone/photo.md'
    );
});

test('pairs companions by canonical basename and reports missing and orphan Markdown',()=>{
    const paired=pairCaseCompanions([
        `24FL001068/Filing by Filing/PDF/${PETITION}.pdf`,
        `24FL001068/Filing by Filing/MD/${PETITION}.md`,
        `24FL001068/Filing by Filing/PDF/${ORDER_COPY}.pdf`,
        '24FL001068/Filing by Filing/MD/25-01-01 [COURT] - Orphan.md'
    ]);
    assert.equal(paired.pairs.length,2);
    assert.equal(paired.pairs[0].hasCompanion,true);
    assert.equal(paired.pairs[1].hasCompanion,false);
    assert.equal(paired.missingCompanions.length,1);
    assert.equal(paired.missingCompanions[0].sourcePath,`Filing by Filing/PDF/${ORDER_COPY}.pdf`);
    assert.deepEqual(
        paired.orphanCompanions.map(item=>item.path),
        ['Filing by Filing/MD/25-01-01 [COURT] - Orphan.md']
    );
});

test('builds grounded evidence names with a known date or explicit UNDated marker',()=>{
    assert.equal(
        buildEvidenceFileName({
            date:'2025-06-14',
            actors:['Brandon Miller','Teruko Miller'],
            what:'Recorded Conversation About Visitation Scheduling',
            extension:'m4a'
        }),
        '25-06-14 [BRANDON MILLER AND TERUKO MILLER] - Recorded Conversation About Visitation Scheduling.m4a'
    );
    assert.equal(
        buildEvidenceFileName({
            sourceActor:'Ashley Onofre',
            description:'Email: proposed pickup / return?',
            originalName:'scan.PNG'
        }),
        '[UNDATED] [ASHLEY ONOFRE] - Email proposed pickup return.png'
    );
    assert.equal(
        buildEvidenceFileName({who:'Court',what:'Audio Certificate Copy 2',extension:'.PDF',copyNumber:3}),
        '[UNDATED] [COURT] - Audio Certificate Copy 2.pdf'
    );
});

test('evidence naming refuses missing descriptions, missing actors, and invented dates',()=>{
    assert.throws(()=>buildEvidenceFileName({who:'Court',extension:'pdf'}),/descriptive what/u);
    assert.throws(()=>buildEvidenceFileName({what:'A recording',extension:'wav'}),/requires who/u);
    assert.throws(
        ()=>buildEvidenceFileName({date:'sometime last summer',who:'Client',what:'Call',extension:'wav'}),
        /Evidence date must/u
    );
    assert.throws(
        ()=>buildEvidenceFileName({date:'2025-02-29',who:'Client',what:'Call',extension:'wav'}),
        /invalid/u
    );
});

test('creates deterministic, independently mutable case profiles and records',()=>{
    const input={
        caseNumber:'24FL001068',
        title:'Miller v. Miller',
        matterTypes:['family'],
        parties:[{name:'Brandon Miller',role:'respondent'}],
        jurisdiction:{country:'US',state:'CA',county:'Monterey'},
        createdAt:'2026-07-12T00:00:00.000Z'
    };
    const first=createCaseRecord(input);
    const second=createCaseRecord(input);
    assert.deepEqual(first,second);
    assert.equal(first.id,'24fl001068');
    assert.equal(first.schemaVersion,CASE_SCHEMA_VERSION);
    assert.equal(first.storageBackend,'dbopfs');
    assert.equal(first.profile.jurisdiction.countyMunicipality,'Monterey');
    assert.deepEqual(first.profile.matterTypes,['family']);
    first.profile.parties.push({name:'Teruko Miller'});
    assert.equal(second.profile.parties.length,1);

    assert.deepEqual(createCaseProfile({matterType:'criminal'}).matterTypes,['criminal']);
});

test('constructs a stable nested tree with canonical roots, directory-first sorting, and deduplication',()=>{
    const tree=buildCaseTree([
        {path:'Evidence/Raw/phone/z-call.m4a',size:10},
        {path:'Evidence/Raw/phone/a-photo.jpg',size:20},
        {path:`Filing by Filing/PDF/${PETITION}.pdf`,size:30},
        {path:'Evidence/Raw/phone/a-photo.jpg',size:999},
        {path:'tmp/ignored.txt',size:1}
    ]);

    assert.deepEqual(tree.children.map(node=>node.name),['Evidence','Filing by Filing']);
    const evidence=tree.children[0];
    assert.deepEqual(evidence.children.map(node=>node.name),['MD','Raw']);
    const raw=evidence.children.find(node=>node.name==='Raw');
    const phone=raw.children.find(node=>node.name==='phone');
    assert.deepEqual(phone.children.map(node=>node.name),['a-photo.jpg','z-call.m4a']);
    assert.equal(phone.children[0].record.size,20);

    const filing=tree.children.find(node=>node.name==='Filing by Filing');
    const pdf=filing.children.find(node=>node.name==='PDF');
    assert.equal(pdf.children[0].caseKind,'filing-pdf');
});

test('tree construction accepts explicit nested directories and detects file-directory collisions',()=>{
    const tree=buildCaseTree(
        [{path:'Analysis/Issues',kind:'directory'},{path:'Analysis/Issues/contempt.md'}],
        {includeCanonicalFolders:false}
    );
    assert.equal(tree.children[0].children[0].children[0].name,'contempt.md');

    assert.throws(
        ()=>buildCaseTree(['Evidence/Raw/item',{path:'Evidence/Raw/item/photo.jpg'}]),
        /blocks directory path/u
    );
});

