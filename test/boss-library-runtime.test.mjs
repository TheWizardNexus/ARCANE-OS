import assert from 'node:assert/strict';
import {describe,it} from 'node:test';

import {
    BOSS_LIBRARY_MANIFEST_VERSION_KEY,
    BOSS_LIBRARY_SEED_PREFIX,
    buildBossLibraryContext,
    createBossLibraryContext,
    fetchMatchedMarkdownBodies,
    loadBossLibraryManifest,
    loadUserMarkdownDocuments,
    normalizeBossLibraryManifest,
    rankBossLibraryDocuments,
    seedBossLibraryDocuments,
    stableDocumentFileName
} from '../apps/boss/boss-library.js';

const MANIFEST_URL='https://example.test/apps/boss/documents/document-manifest.json';

function jsonResponse(value,{ok=true,status=200}={}){
    return {
        ok,
        status,
        async json(){
            return value;
        }
    };
}

function textResponse(value,{ok=true,status=200}={}){
    return {
        ok,
        status,
        async text(){
            return value;
        }
    };
}

class FakeOpfs {
    constructor(entries={}){
        this.files=new Map(Object.entries(entries));
        this.writes=[];
        this.deletes=[];
        this.reads=[];
    }

    async getAllKeys(tableName){
        assert.equal(tableName,'documents');
        return [...this.files.keys()];
    }

    async get(tableName,name){
        assert.equal(tableName,'documents');
        this.reads.push(name);

        if(!this.files.has(name)){
            const error=new Error(`${name} not found`);
            error.name='NotFoundError';
            throw error;
        }

        return this.files.get(name);
    }

    async set(tableName,name,value){
        assert.equal(tableName,'documents');
        this.writes.push(name);
        this.files.set(name,value);
        return value;
    }

    async delete(tableName,name){
        assert.equal(tableName,'documents');
        this.deletes.push(name);
        this.files.delete(name);
        return true;
    }
}

describe('BOSS library runtime',()=>{
    it('normalizes anticipated snake_case manifest fields',()=>{
        const manifest=normalizeBossLibraryManifest(
            {
                manifest_version:'2026-07-12.1',
                generated_at:'2026-07-12T12:00:00Z',
                documents:[
                    {
                        document_id:'score-mentor',
                        document_title:'Find a SCORE Mentor',
                        file_name:'find-score-mentor.md',
                        markdown_path:'score/find-score-mentor.md',
                        source_url:'https://www.score.org/mentors/',
                        tags:'mentor, startup',
                        short_summary:'Request a business mentor.',
                        organization:'SCORE',
                        category:'Business advising',
                        lifecycle_stage:'Ideation / Validation',
                        location:'Houston / National',
                        resource_type:'Mentoring',
                        search_text:'Free counseling for business owners.',
                        access:'public'
                    }
                ]
            },
            {manifestUrl:MANIFEST_URL}
        );
        const [document]=manifest.documents;

        assert.equal(manifest.version,'2026-07-12.1');
        assert.equal(document.id,'score-mentor');
        assert.equal(document.title,'Find a SCORE Mentor');
        assert.equal(document.name,'find-score-mentor.md');
        assert.equal(
            document.documentUrl,
            'https://example.test/apps/boss/documents/score/find-score-mentor.md'
        );
        assert.equal(document.sourceUrl,'https://www.score.org/mentors/');
        assert.deepEqual(document.tags,['mentor','startup']);
        assert.deepEqual(document.organizations,['SCORE']);
        assert.deepEqual(document.stages,['Ideation','Validation']);
        assert.deepEqual(document.locations,['Houston','National']);
        assert.deepEqual(document.resourceTypes,['Mentoring']);
    });

    it('weights title and structured metadata, applies filters and synonyms, and hides restricted records',()=>{
        const records=[
            {
                id:'score-public',
                title:'Business Startup Mentoring',
                name:'score.md',
                path:'score.md',
                source_url:'https://score.example/mentor',
                tags:['mentor','startup'],
                summary:'One-on-one help for a new business concept.',
                organization:'SCORE',
                category:'Advising',
                lifecycle_stage:'Ideation',
                location:'Greater Houston',
                resource_type:'Mentoring',
                access:'public'
            },
            {
                id:'sbdc-public',
                title:'Market Research Support',
                name:'sbdc.md',
                path:'sbdc.md',
                tags:['market research'],
                summary:'Local advising for established companies.',
                organization:'SBDC',
                lifecycle_stage:'Operations',
                location:'Houston',
                resource_type:'Advising',
                access:'public'
            },
            {
                id:'restricted',
                title:'Private Business Startup Advisor Directory',
                name:'private.md',
                path:'private.md',
                tags:['startup','advisor'],
                organization:'SCORE',
                lifecycle_stage:'Ideation',
                location:'77084',
                resource_type:'Mentoring',
                access:'restricted'
            },
            {
                id:'body-only',
                title:'General Resource List',
                name:'general.md',
                path:'general.md',
                organization:'SCORE',
                lifecycle_stage:'Ideation',
                location:'Houston',
                resource_type:'Mentoring',
                search_text:'business startup mentoring advisor',
                access:'public'
            }
        ];
        const ranked=rankBossLibraryDocuments(
            records,
            'startup advisor Houston',
            {
                topK:5,
                filters:{
                    stage:'starting',
                    location:'77084',
                    resource:'score'
                }
            }
        );

        assert.deepEqual(
            ranked.map(item=>item.id),
            ['score-public','body-only']
        );
        assert.ok(ranked[0].score>ranked[1].score);
        assert.match(ranked[0].whyMatched,/title/);
        assert.ok(!ranked.some(item=>item.id==='restricted'));

        const restricted=rankBossLibraryDocuments(
            records,
            'startup advisor',
            {
                includeRestricted:true,
                filters:{access:'restricted'}
            }
        );

        assert.deepEqual(restricted.map(item=>item.id),['restricted']);
    });

    it('fetches only matched Markdown bodies within per-document and total limits',async()=>{
        const manifest=normalizeBossLibraryManifest(
            {
                version:'limits',
                documents:[
                    {id:'one',title:'One',name:'one.md',path:'one.md'},
                    {id:'two',title:'Two',name:'two.md',path:'two.md'},
                    {id:'three',title:'Three',name:'three.md',path:'three.md'}
                ]
            },
            {manifestUrl:MANIFEST_URL}
        );
        const calls=[];
        const bodies={
            [manifest.documents[0].documentUrl]:'111111111111',
            [manifest.documents[1].documentUrl]:'222222222222',
            [manifest.documents[2].documentUrl]:'333333333333'
        };
        const matches=manifest.documents.map(
            (record,index)=>({
                ...record,
                rank:index+1,
                whyMatched:'Matched title.'
            })
        );
        const result=await fetchMatchedMarkdownBodies(matches,{
            fetchImpl:async url=>{
                calls.push(url);
                return textResponse(bodies[url]);
            },
            perDocumentCharacterLimit:8,
            totalCharacterLimit:13
        });

        assert.equal(calls.length,2);
        assert.equal(result.documents.length,2);
        assert.deepEqual(result.documents.map(item=>item.content.length),[8,5]);
        assert.equal(result.charactersUsed,13);
        assert.equal(result.errors.length,0);
    });

    it('builds compact escaped context with exact title, name, source, link, and match reason',()=>{
        const context=buildBossLibraryContext(
            [
                {
                    rank:1,
                    title:'SCORE & Mentor <Guide>',
                    name:'SCORE Mentor Guide.md',
                    sourceUrl:'https://score.example/?a=1&b=2',
                    documentUrl:'https://app.example/SCORE%20Mentor%20Guide.md',
                    whyMatched:'Matched title & tags.',
                    content:'# Use <care> & verify links.'
                }
            ],
            {query:'mentor & startup'}
        );

        assert.match(context,/^<boss_library_context>/);
        assert.match(context,/<title>SCORE &amp; Mentor &lt;Guide&gt;<\/title>/);
        assert.match(context,/<name>SCORE Mentor Guide\.md<\/name>/);
        assert.match(context,/<source_url>https:\/\/score\.example\/\?a=1&amp;b=2<\/source_url>/);
        assert.match(context,/<link>https:\/\/app\.example\/SCORE%20Mentor%20Guide\.md<\/link>/);
        assert.match(context,/<why_matched>Matched title &amp; tags\.<\/why_matched>/);
        assert.match(context,/<content># Use &lt;care&gt; &amp; verify links\.<\/content>/);
        assert.match(context,/<\/boss_library_context>$/);
    });

    it('includes matching user-uploaded Markdown without reloading seeded static OPFS documents',async()=>{
        const seededName=`${BOSS_LIBRARY_SEED_PREFIX}static--12345678.md`;
        const opfs=new FakeOpfs({
            [seededName]:'# Static duplicate\nDo not load as a user upload.',
            [BOSS_LIBRARY_MANIFEST_VERSION_KEY]:'{"manifestVersion":"1"}',
            'notes.pdf':'binary',
            'my-beekeeping-plan.md':'Source URL: https://local.example/bees\n\n# My Beekeeping Plan\n\nNeed county licensing for an apiary.'
        });
        const uploads=await loadUserMarkdownDocuments({opfs});

        assert.deepEqual(uploads.records.map(item=>item.name),['my-beekeeping-plan.md']);
        assert.ok(!opfs.reads.includes(seededName));

        const result=await createBossLibraryContext(
            'apiary county licensing',
            {
                manifest:{version:'1',documents:[]},
                opfs,
                fetchImpl:async()=>{
                    throw new Error('No static body should be fetched.');
                },
                topK:2
            }
        );

        assert.equal(result.documents.length,1);
        assert.equal(result.documents[0].name,'my-beekeeping-plan.md');
        assert.match(result.context,/My Beekeeping Plan/);
        assert.match(result.context,/https:\/\/local\.example\/bees/);
        assert.ok(!result.context.includes('Static duplicate'));
    });

    it('seeds manifest Markdown in bounded batches, stores a version key, and is idempotent',async()=>{
        const source={
            manifest_version:'seed-v1',
            documents:[
                {id:'a',title:'Alpha',name:'alpha.md',path:'alpha.md',access:'public'},
                {id:'b',title:'Beta',name:'beta.md',path:'beta.md',access:'restricted'},
                {id:'c',title:'Gamma',name:'gamma.md',path:'gamma.md',access:'public'},
                {id:'pdf',title:'PDF',name:'not-markdown.pdf',path:'not-markdown.pdf'}
            ]
        };
        const normalized=normalizeBossLibraryManifest(source,{manifestUrl:MANIFEST_URL});
        const bodies=new Map(
            normalized.documents
                .filter(item=>item.name.endsWith('.md'))
                .map(item=>[item.documentUrl,`# ${item.title}\n\nBody`])
        );
        const staleName=`${BOSS_LIBRARY_SEED_PREFIX}stale--00000000.md`;
        const opfs=new FakeOpfs({[staleName]:'# Stale'});
        const refreshDetails=[];
        let active=0;
        let maxActive=0;
        let fetchCalls=0;
        const fetchImpl=async url=>{
            fetchCalls++;
            active++;
            maxActive=Math.max(maxActive,active);
            await new Promise(resolve=>setTimeout(resolve,2));
            active--;
            return textResponse(bodies.get(url));
        };
        const first=await seedBossLibraryDocuments({
            manifest:source,
            manifestUrl:MANIFEST_URL,
            fetchImpl,
            opfs,
            batchSize:2,
            onRefresh:detail=>refreshDetails.push(detail)
        });

        assert.equal(first.ok,true);
        assert.equal(first.seeded,3);
        assert.equal(first.removed,1);
        assert.equal(first.notified,true);
        assert.equal(refreshDetails.length,1);
        assert.equal(maxActive,2);
        assert.ok(opfs.files.has(BOSS_LIBRARY_MANIFEST_VERSION_KEY));
        assert.ok(!opfs.files.has(staleName));
        assert.equal(
            JSON.parse(opfs.files.get(BOSS_LIBRARY_MANIFEST_VERSION_KEY)).manifestVersion,
            'seed-v1'
        );

        for(const document of normalized.documents.slice(0,3)){
            assert.ok(opfs.files.has(stableDocumentFileName(document)));
        }

        assert.ok(
            ![...opfs.files.keys()].some(name=>name.includes('not-markdown'))
        );

        const callsAfterFirst=fetchCalls;
        const second=await seedBossLibraryDocuments({
            manifest:source,
            fetchImpl,
            opfs,
            batchSize:2,
            onRefresh:detail=>refreshDetails.push(detail)
        });

        assert.equal(second.ok,true);
        assert.equal(second.idempotent,true);
        assert.equal(second.seeded,0);
        assert.equal(second.notified,false);
        assert.equal(fetchCalls,callsAfterFirst);
        assert.equal(refreshDetails.length,1);
    });

    it('returns structured failures when manifest fetch or OPFS is unavailable',async()=>{
        const loaded=await loadBossLibraryManifest({
            manifestUrl:MANIFEST_URL,
            fetchImpl:async()=>{
                throw new Error('offline');
            }
        });

        assert.equal(loaded.ok,false);
        assert.equal(loaded.manifest.documents.length,0);
        assert.match(loaded.error.message,/offline/);

        const seeded=await seedBossLibraryDocuments({
            manifest:{version:'1',documents:[]},
            opfs:null
        });

        assert.equal(seeded.ok,false);
        assert.equal(seeded.seeded,0);
        assert.match(seeded.errors[0].message,/OPFS is unavailable/);
    });
});
