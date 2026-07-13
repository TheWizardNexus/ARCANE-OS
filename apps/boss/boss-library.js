const DEFAULT_MANIFEST_URL=new URL(
    './documents/document-manifest.json',
    import.meta.url
).href;

const BOSS_LIBRARY_SEED_PREFIX='boss-library--';
const BOSS_LIBRARY_MANIFEST_VERSION_KEY='.boss-library-manifest-version.json';
const BOSS_LIBRARY_REFRESH_EVENT='boss-library-documents-refreshed';

const DEFAULT_TOP_K=5;
const DEFAULT_PER_DOCUMENT_CHARACTER_LIMIT=6000;
const DEFAULT_TOTAL_CHARACTER_LIMIT=18000;
const DEFAULT_SEED_BATCH_SIZE=8;

const RESTRICTED_ACCESS_VALUES=new Set([
    'restricted',
    'private',
    'confidential'
]);

const LOCATION_WILDCARDS=new Set([
    'all',
    'all locations',
    'any',
    'national',
    'nationwide',
    'online',
    'virtual',
    'united states',
    'us',
    'usa'
]);

const DEFAULT_SYNONYM_GROUPS=[
    ['idea','ideas','ideation','concept','pre formation','preformation','startup','starting'],
    ['validation','validate','feasibility','customer discovery','market research'],
    ['formation','form','forming','legal structure','llc','register','registration','ein'],
    ['launch','launching','first customer','first customers','go to market'],
    ['operations','operating','operational','systems','workflow','bookkeeping'],
    ['growth','grow','growing','scale','scaling','expansion','expand'],
    ['exit','sell','selling','succession','transition','close business'],
    ['recovery','troubleshooting','stabilization','stabilize','disaster recovery'],
    ['funding','finance','financing','capital','loan','loans','lender','grant','grants'],
    ['mentor','mentoring','advisor','advising','counseling','counselling'],
    ['score','score mentor','score mentoring'],
    ['sbdc','small business development center','small business development centers'],
    ['sba','small business administration'],
    ['procurement','government contracting','government contracts','federal contracting','bid','solicitation'],
    ['apex','apex accelerator','uh apex','ptac'],
    ['sam','sam gov','system for award management'],
    ['veteran','veterans','military','service member','military spouse','boots to business'],
    ['vboc','veterans business outreach center'],
    ['woman owned','women owned','wosb','women business center','wbc'],
    ['marketing','sales','customer','customers','branding','promotion'],
    ['houston','greater houston','harris county','77084'],
    ['texas','tx']
];

const SEARCH_FIELD_WEIGHTS={
    title:18,
    tags:11,
    organization:9,
    summary:7,
    category:6,
    searchText:3
};

const QUERY_STOP_WORDS=new Set([
    'a','an','and','are','as','at','be','can','do','for','from','get','help',
    'how','i','in','is','it','me','my','of','on','or','please','the','to',
    'what','where','which','with','you'
]);

function firstDefined(source={},keys=[]){
    for(const key of keys){
        const value=source?.[key];

        if(value!==undefined&&value!==null&&value!==''){
            return value;
        }
    }

    return '';
}

function toStringValue(value=''){
    if(value===undefined||value===null){
        return '';
    }

    if(typeof value==='string'||typeof value==='number'){
        return String(value).trim();
    }

    if(typeof value==='object'){
        return toStringValue(
            firstDefined(value,['name','title','label','value','url','href'])
        );
    }

    return String(value).trim();
}

function toUrlValue(value=''){
    if(value&&typeof value==='object'){
        return toStringValue(
            firstDefined(value,['url','href','source_url','link','value'])
        );
    }

    return toStringValue(value);
}

function toStringList(value=[]){
    if(value===undefined||value===null||value===''){
        return [];
    }

    const values=Array.isArray(value)
        ?value
        :typeof value==='string'
            ?value.split(/[,;|\n/]/)
            :[value];

    return [...new Set(
        values.flatMap(
            item=>Array.isArray(item)?item:[item]
        ).map(toStringValue).filter(Boolean)
    )];
}

function normalizeText(value=''){
    return toStringValue(value)
        .toLowerCase()
        .replace(/&/g,' and ')
        .replace(/[^a-z0-9]+/g,' ')
        .replace(/\s+/g,' ')
        .trim();
}

function tokenize(value=''){
    return [...new Set(
        normalizeText(value)
            .split(' ')
            .filter(term=>term.length>1&&!QUERY_STOP_WORDS.has(term))
    )];
}

function includesTerm(normalizedValue='',term=''){
    if(!normalizedValue||!term){
        return false;
    }

    return ` ${normalizedValue} `.includes(` ${normalizeText(term)} `);
}

function expandTerms(value='',synonymGroups=DEFAULT_SYNONYM_GROUPS){
    const normalized=normalizeText(value);
    const baseTerms=tokenize(normalized);
    const expanded=new Set(baseTerms);
    const phrases=new Set();

    if(normalized){
        phrases.add(normalized);
    }

    for(const group of synonymGroups){
        const normalizedGroup=group.map(normalizeText).filter(Boolean);
        const groupMatched=normalizedGroup.some(
            phrase=>includesTerm(normalized,phrase)
                || phrase.includes(' ')&&normalized.includes(phrase)
        );

        if(!groupMatched){
            continue;
        }

        for(const phrase of normalizedGroup){
            phrases.add(phrase);

            for(const token of tokenize(phrase)){
                expanded.add(token);
            }
        }
    }

    return {
        normalized,
        baseTerms,
        expandedTerms:[...expanded],
        phrases:[...phrases]
    };
}

function pathBaseName(path=''){
    return toStringValue(path)
        .replaceAll('\\','/')
        .split('/')
        .filter(Boolean)
        .pop()||'';
}

function titleFromName(name=''){
    return pathBaseName(name)
        .replace(/\.(?:md|markdown)$/i,'')
        .replace(/[_-]+/g,' ')
        .replace(/\s+/g,' ')
        .trim();
}

function resolveDocumentUrl(path='',manifestUrl=DEFAULT_MANIFEST_URL){
    const value=toStringValue(path).replaceAll('\\','/');

    if(!value){
        return '';
    }

    try{
        if(/^[a-z][a-z0-9+.-]*:/i.test(value)){
            return new URL(value).href;
        }

        if(/^\.?\/?apps\/boss\//i.test(value)){
            const appRelative=value.replace(/^\.?\/?apps\/boss\//i,'');
            return new URL(`../${appRelative}`,manifestUrl).href;
        }

        if(/^\.?\/?documents\//i.test(value)
            &&/\/boss\/documents\//i.test(new URL(manifestUrl).pathname)){
            return new URL(
                value.replace(/^\.?\/?documents\//i,''),
                manifestUrl
            ).href;
        }

        return new URL(value,manifestUrl).href;
    }catch{
        return value;
    }
}

function resolveOriginalUrl(
    path='',
    manifestUrl=DEFAULT_MANIFEST_URL,
    originalRoot=''
){
    const value=toStringValue(path).replaceAll('\\','/');
    const root=toStringValue(originalRoot).replaceAll('\\','/');
    const segments=value.split('/');

    if(!value||!root||segments.some(
        segment=>!segment||segment==='.'||segment==='..'
    )){
        return '';
    }

    try{
        const encodedPath=segments.map(encodeURIComponent).join('/');
        const manifestLocation=new URL(manifestUrl);
        const base=new URL(root.endsWith('/')?root:`${root}/`,manifestLocation);

        if(base.origin!==manifestLocation.origin){
            return '';
        }

        return new URL(encodedPath,base).href;
    }catch{
        return '';
    }
}

function normalizeAccess(value='public'){
    return normalizeText(value)||'public';
}

function isRestrictedAccess(value=''){
    return RESTRICTED_ACCESS_VALUES.has(normalizeAccess(value));
}

function normalizeBossLibraryRecord(
    source={},
    index=0,
    {manifestUrl=DEFAULT_MANIFEST_URL,originalRoot=''}={}
){
    if(source?.__bossLibraryRecord===true){
        return source;
    }

    const markdownPath=toStringValue(
        firstDefined(
            source,
            [
                'markdown_path','markdownPath','markdown_file','markdown_url','document_path',
                'relative_path','output_path','output','path','file','href'
            ]
        )
    ).replaceAll('\\','/');
    const explicitName=toStringValue(
        firstDefined(
            source,
            [
                'document_name','markdown_name','markdown_file_name',
                'markdown_filename','file_name','filename','source_file',
                'source_name','name'
            ]
        )
    );
    const name=explicitName||pathBaseName(markdownPath)||`document-${index+1}.md`;
    const title=toStringValue(
        firstDefined(
            source,
            ['document_title','canonical_title','display_title','title','heading']
        )
    )||titleFromName(name);
    const sourceValue=firstDefined(
        source,
        [
            'source_url','sourceUrl','official_url','reference_url',
            'canonical_url','source_link','source'
        ]
    );
    const listedLinks=toStringList(
        firstDefined(source,['links','source_links','urls'])
    );
    const sourcePath=toStringValue(
        firstDefined(source,['source_path','sourcePath','original_path'])
    ).replaceAll('\\','/');
    const declaredSourceExtension=toStringValue(
        firstDefined(source,['source_extension','extension'])
    ).trim().toLowerCase();
    const derivedSourceExtension=toStringValue(
        pathBaseName(sourcePath).match(/\.[^.]+$/)?.[0]
    ).trim().toLowerCase();
    const sourceExtension=declaredSourceExtension
        ?(declaredSourceExtension.startsWith('.')
            ?declaredSourceExtension
            :`.${declaredSourceExtension}`)
        :derivedSourceExtension;
    const sourceMime=toStringValue(
        firstDefined(source,['source_mime','mime_type','content_type'])
    );
    const sourceBytes=Number(
        firstDefined(source,['source_bytes','size_bytes','bytes'])
    )||0;
    const contacts=toStringList(
        firstDefined(source,['contacts','contact','contact_details'])
    );
    const people=toStringList(
        firstDefined(source,['people','persons','named_people'])
    );
    let sourceUrl=toUrlValue(sourceValue)
        ||listedLinks.find(value=>/^https?:/i.test(value))
        ||'';
    let explicitLink=toUrlValue(
        firstDefined(source,['document_url','documentUrl','local_url','link','url'])
    );

    if(!sourceUrl&&/^https?:/i.test(explicitLink)&&!explicitlyLooksLikeMarkdown(explicitLink)){
        sourceUrl=explicitLink;
    }

    const localPath=markdownPath||(
        explicitlyLooksLikeMarkdown(explicitLink)?explicitLink:''
    );
    const documentUrl=resolveDocumentUrl(localPath,manifestUrl);
    const originalUrl=resolveOriginalUrl(
        sourcePath,
        manifestUrl,
        originalRoot
    );
    const tags=toStringList([
        ...toStringList(
            firstDefined(source,['search_tags','keywords','tag_list','tags'])
        ),
        ...toStringList(source.topics)
    ]);
    const organizations=toStringList(
        firstDefined(
            source,
            [
                'organizations','organization','organisation','source_organization',
                'provider','agency'
            ]
        )
    );
    const categories=toStringList(
        firstDefined(
            source,
            [
                'categories','document_category','top_level_category','category',
                'subcategory','collection'
            ]
        )
    );
    const stages=toStringList(
        firstDefined(
            source,
            [
                'lifecycle_stages','lifecycle_stage','business_stages',
                'business_stage','stage_tags','stages','stage'
            ]
        )
    );
    const locations=toStringList(
        firstDefined(
            source,
            [
                'locations','location','geographies','geography','service_areas',
                'service_area','location_tags','operating_area'
            ]
        )
    );
    const resourceTypes=toStringList(
        firstDefined(
            source,
            [
                'resource_types','resourceTypes','resource_type','resource_categories',
                'resource_category','resource','document_type','type'
            ]
        )
    );
    const summary=toStringValue(
        firstDefined(
            source,
            ['short_summary','document_summary','description','purpose','summary']
        )
    );
    const searchText=toStringValue(
        firstDefined(source,['search_text','searchText','retrieval_text','index_text'])
    );
    const stableIdentityParts=[
        firstDefined(source,['document_id','record_id','id','slug']),
        markdownPath,
        title,
        sourceUrl,
        sourcePath,
        listedLinks.join('|'),
        contacts.join('|'),
        people.join('|'),
        name
    ].map(toStringValue);
    const stableBasis=stableIdentityParts.some(Boolean)
        ?stableIdentityParts.join('|')
        :`document-${index+1}`;

    return {
        id:toStringValue(
            firstDefined(source,['document_id','record_id','id','slug'])
        )||`boss-document-${stableHash(stableBasis)}`,
        title,
        name,
        path:markdownPath,
        documentUrl,
        link:documentUrl||explicitLink||sourceUrl,
        sourceUrl,
        sourcePath,
        sourceExtension,
        sourceMime,
        sourceBytes,
        originalUrl,
        links:listedLinks,
        contacts,
        people,
        tags,
        organizations,
        categories,
        stages,
        locations,
        resourceTypes,
        summary,
        searchText,
        access:normalizeAccess(
            firstDefined(source,['access_level','access','visibility'])
        ),
        sensitive:source.sensitive===true||normalizeText(source.sensitive)==='true',
        format:normalizeText(
            firstDefined(source,['format'])||sourceMime||sourceExtension
        ),
        origin:toStringValue(source.origin)||'manifest',
        opfsName:toStringValue(source.opfsName||source.opfs_name),
        manifestIndex:index,
        raw:source,
        __bossLibraryRecord:true
    };
}

function explicitlyLooksLikeMarkdown(value=''){
    return /(?:^|[/?#])[^/?#]+\.(?:md|markdown)(?:[?#].*)?$/i.test(
        toStringValue(value)
    );
}

function stableHash(value=''){
    let hash=0x811c9dc5;
    const text=String(value);

    for(let i=0;i<text.length;i++){
        hash^=text.charCodeAt(i);
        hash=Math.imul(hash,0x01000193);
    }

    return (hash>>>0).toString(16).padStart(8,'0');
}

function isMarkdownRecord(record={}){
    return explicitlyLooksLikeMarkdown(record.path)
        || explicitlyLooksLikeMarkdown(record.name)
        || record.format.includes('markdown')
        || record.format==='md';
}

function normalizeBossLibraryManifest(
    source={},
    {manifestUrl=DEFAULT_MANIFEST_URL}={}
){
    if(source?.__bossLibraryManifest===true){
        return source;
    }

    const rawDocumentValue=Array.isArray(source)
        ?source
        :firstDefined(source,['documents','records','entries','items','files']);
    const rawDocuments=Array.isArray(rawDocumentValue)
        ?rawDocumentValue
        :rawDocumentValue&&typeof rawDocumentValue==='object'
            ?Object.values(rawDocumentValue)
            :[];
    const audience=normalizeText(
        firstDefined(source,['audience','deployment_audience','deploymentAudience'])
    );
    const originalRoot=toStringValue(
        firstDefined(
            source,
            ['original_root','originalRoot','original_base_url','originalBaseUrl']
        )
    );

    if(audience==='public'){
        const expectedOriginalBase=new URL('../originals/',manifestUrl).href;
        let declaredOriginalBase='';

        try{
            declaredOriginalBase=new URL(originalRoot,manifestUrl).href;
        }catch{
            // The validation below reports one fail-closed error for bad roots.
        }

        if(declaredOriginalBase!==expectedOriginalBase){
            throw new Error(
                'Public BOSS manifests must use the isolated ../originals/ root.'
            );
        }

        const unsafeRecord=rawDocuments.find(record=>{
            const explicitAccess=normalizeText(record?.access);
            const sensitive=record?.sensitive===true
                ||normalizeText(record?.sensitive)==='true';

            return explicitAccess!=='public'||sensitive;
        });

        if(unsafeRecord){
            throw new Error(
                'Public BOSS manifests may contain only explicit public, non-sensitive records.'
            );
        }
    }

    const documents=rawDocuments.map(
        (record,index)=>normalizeBossLibraryRecord(
            record,
            index,
            {manifestUrl,originalRoot}
        )
    );

    if(audience==='public'&&documents.some(record=>!record.originalUrl)){
        throw new Error(
            'Every public BOSS record must resolve to an isolated public original.'
        );
    }
    const declaredVersion=toStringValue(
        firstDefined(
            source,
            [
                'manifest_version','manifestVersion','document_manifest_version',
                'schema_version','content_version','version','generated_at'
            ]
        )
    );
    const derivedVersion=stableHash(
        documents.map(
            document=>[
                document.id,
                document.path,
                document.sourceUrl,
                document.access
            ].join('|')
        ).join('\n')
    );

    return {
        version:declaredVersion||derivedVersion,
        audience,
        generatedAt:toStringValue(
            firstDefined(source,['generated_at','generatedAt','created_at','updated_at'])
        ),
        originalRoot,
        manifestUrl,
        documents,
        raw:source,
        __bossLibraryManifest:true
    };
}

function getFetchImplementation(fetchImpl){
    if(typeof fetchImpl==='function'){
        return fetchImpl;
    }

    if(typeof globalThis.fetch==='function'){
        return globalThis.fetch.bind(globalThis);
    }

    return null;
}

async function loadBossLibraryManifest({
    manifestUrl=DEFAULT_MANIFEST_URL,
    fetchImpl
}={}){
    const fetcher=getFetchImplementation(fetchImpl);

    if(!fetcher){
        return {
            ok:false,
            manifest:normalizeBossLibraryManifest({}, {manifestUrl}),
            error:new Error('Fetch is not available to load the BOSS document manifest.')
        };
    }

    try{
        const response=await fetcher(manifestUrl,{cache:'no-cache'});

        if(!response?.ok){
            throw new Error(
                `BOSS document manifest request failed${response?.status?` (${response.status})`:''}.`
            );
        }

        const source=await response.json();

        return {
            ok:true,
            manifest:normalizeBossLibraryManifest(source,{manifestUrl}),
            error:null
        };
    }catch(error){
        return {
            ok:false,
            manifest:normalizeBossLibraryManifest({}, {manifestUrl}),
            error:normalizeError(error,'Unable to load the BOSS document manifest.')
        };
    }
}

function normalizeError(error,fallback='BOSS Libraries operation failed.'){
    if(error instanceof Error){
        return error;
    }

    return new Error(toStringValue(error)||fallback);
}

function normalizeFilters(filters={}){
    return {
        stages:toStringList(
            firstDefined(filters,['lifecycle_stage','business_stage','stages','stage'])
        ),
        locations:toStringList(
            firstDefined(filters,['locations','location','geography','service_area'])
        ),
        resources:toStringList(
            firstDefined(
                filters,
                ['resource_types','resource_type','resources','resource','organization']
            )
        ),
        access:toStringList(
            firstDefined(filters,['access_levels','access_level','access','visibility'])
        )
    };
}

function synonymTermSet(values=[],synonymGroups=DEFAULT_SYNONYM_GROUPS){
    const terms=new Set();

    for(const value of values){
        const expanded=expandTerms(value,synonymGroups);

        terms.add(expanded.normalized);
        expanded.expandedTerms.forEach(term=>terms.add(term));
        expanded.phrases.forEach(term=>terms.add(term));
    }

    terms.delete('');
    return terms;
}

function filterValuesMatch(
    documentValues=[],
    requestedValues=[],
    {synonymGroups=DEFAULT_SYNONYM_GROUPS,wildcards=new Set()}={}
){
    if(!requestedValues.length){
        return true;
    }

    const normalizedDocumentValues=documentValues.map(normalizeText).filter(Boolean);

    if(normalizedDocumentValues.some(value=>wildcards.has(value))){
        return true;
    }

    const documentTerms=synonymTermSet(normalizedDocumentValues,synonymGroups);
    const requestedTerms=synonymTermSet(requestedValues,synonymGroups);

    for(const requested of requestedTerms){
        for(const available of documentTerms){
            if(requested===available
                || requested.length>2&&includesTerm(available,requested)
                || available.length>2&&includesTerm(requested,available)){
                return true;
            }
        }
    }

    return false;
}

function recordMatchesFilters(
    record={},
    filters={},
    synonymGroups=DEFAULT_SYNONYM_GROUPS
){
    if(!filterValuesMatch(
        record.stages,
        filters.stages,
        {synonymGroups,wildcards:new Set(['all','all stages','any'])}
    )){
        return false;
    }

    if(!filterValuesMatch(
        record.locations,
        filters.locations,
        {synonymGroups,wildcards:LOCATION_WILDCARDS}
    )){
        return false;
    }

    const resourceValues=[
        ...record.resourceTypes,
        ...record.organizations,
        ...record.categories,
        ...record.tags
    ];

    if(!filterValuesMatch(
        resourceValues,
        filters.resources,
        {synonymGroups}
    )){
        return false;
    }

    if(filters.access.length&&!filterValuesMatch(
        [record.access],
        filters.access,
        {synonymGroups:[]}
    )){
        return false;
    }

    return true;
}

function scoreSearchField(
    fieldValue='',
    queryInfo={},
    weight=1
){
    const normalized=normalizeText(fieldValue);

    if(!normalized){
        return {score:0,terms:[]};
    }

    let score=0;
    const terms=[];

    if(queryInfo.normalized&&normalized.includes(queryInfo.normalized)){
        score+=weight*3;
    }

    const baseTerms=new Set(queryInfo.baseTerms||[]);

    for(const term of queryInfo.expandedTerms||[]){
        if(!includesTerm(normalized,term)){
            continue;
        }

        score+=baseTerms.has(term)?weight:weight*.45;
        terms.push(term);
    }

    return {score,terms:[...new Set(terms)]};
}

function scoreBossLibraryRecord(record={},queryInfo={}){
    const fields={
        title:record.title,
        tags:record.tags.join(' '),
        organization:record.organizations.join(' '),
        summary:record.summary,
        category:record.categories.join(' '),
        searchText:[
            record.searchText,
            record.sourcePath,
            record.people.join(' '),
            record.contacts.join(' '),
            record.stages.join(' '),
            record.locations.join(' '),
            record.resourceTypes.join(' ')
        ].join(' ')
    };
    let score=0;
    const matchedFields=[];
    const matchedTerms=[];

    for(const [field,value]of Object.entries(fields)){
        const result=scoreSearchField(
            value,
            queryInfo,
            SEARCH_FIELD_WEIGHTS[field]
        );

        if(result.score>0){
            score+=result.score;
            matchedFields.push(field);
            matchedTerms.push(...result.terms);
        }
    }

    return {
        score:Math.round(score*100)/100,
        matchedFields,
        matchedTerms:[...new Set(matchedTerms)]
    };
}

function buildWhyMatched(scoreResult={},filters={}){
    const fieldNames={
        title:'title',
        tags:'tags',
        organization:'organization',
        summary:'summary',
        category:'category',
        searchText:'indexed content'
    };
    const fields=scoreResult.matchedFields.map(
        field=>fieldNames[field]||field
    );
    const filterLabels=[];

    if(filters.stages.length){
        filterLabels.push(`stage ${filters.stages.join(', ')}`);
    }
    if(filters.locations.length){
        filterLabels.push(`location ${filters.locations.join(', ')}`);
    }
    if(filters.resources.length){
        filterLabels.push(`resource ${filters.resources.join(', ')}`);
    }

    let reason=fields.length
        ?`Matched ${fields.join(', ')}`
        :'Matched requested filters';

    if(scoreResult.matchedTerms.length){
        reason+=` for ${scoreResult.matchedTerms.slice(0,6).join(', ')}`;
    }

    if(filterLabels.length){
        reason+=`; ${filterLabels.join('; ')}`;
    }

    return `${reason}.`;
}

function rankBossLibraryDocuments(
    records=[],
    query='',
    {
        topK=DEFAULT_TOP_K,
        filters={},
        includeRestricted=false,
        synonymGroups=DEFAULT_SYNONYM_GROUPS
    }={}
){
    const normalizedFilters=normalizeFilters(filters);
    const allowRestricted=includeRestricted
        || normalizedFilters.access.some(isRestrictedAccess);
    const queryInfo=expandTerms(query,synonymGroups);
    const limit=Math.max(0,Math.min(50,Number(topK)||DEFAULT_TOP_K));
    const scored=[];

    for(let index=0;index<records.length;index++){
        const record=normalizeBossLibraryRecord(records[index],index);

        if(!isMarkdownRecord(record)){
            continue;
        }

        if(isRestrictedAccess(record.access)&&!allowRestricted){
            continue;
        }

        if(!recordMatchesFilters(record,normalizedFilters,synonymGroups)){
            continue;
        }

        const scoreResult=scoreBossLibraryRecord(record,queryInfo);

        if(queryInfo.expandedTerms.length&&scoreResult.score<=0){
            continue;
        }

        scored.push({
            ...record,
            score:scoreResult.score||1,
            matchedFields:scoreResult.matchedFields,
            matchedTerms:scoreResult.matchedTerms,
            whyMatched:buildWhyMatched(scoreResult,normalizedFilters),
            rankSourceIndex:index
        });
    }

    scored.sort(
        (left,right)=>right.score-left.score
            || left.rankSourceIndex-right.rankSourceIndex
    );

    return scored.slice(0,limit).map(
        (record,index)=>({...record,rank:index+1})
    );
}

async function getOpfsDocumentKeys(opfs){
    if(!opfs){
        return [];
    }

    if(typeof opfs.getAllKeys==='function'){
        return await opfs.getAllKeys('documents');
    }

    const directory=typeof opfs.getTableHandle==='function'
        ?await opfs.getTableHandle('documents')
        :opfs;
    const keys=[];

    if(typeof directory?.entries==='function'){
        for await(const [name]of directory.entries()){
            keys.push(name);
        }
    }

    return keys;
}

async function readOpfsDocument(opfs,name=''){
    if(typeof opfs?.get==='function'){
        const value=await opfs.get('documents',name,true);
        return valueToText(value);
    }

    if(typeof opfs?.readFile==='function'){
        return valueToText(await opfs.readFile('documents',name));
    }

    const directory=typeof opfs?.getTableHandle==='function'
        ?await opfs.getTableHandle('documents')
        :opfs;
    const handle=await directory.getFileHandle(name,{create:false});
    return valueToText(await handle.getFile());
}

async function valueToText(value){
    if(typeof value==='string'){
        return value;
    }

    if(value&&typeof value.text==='function'){
        return await value.text();
    }

    if(value===undefined||value===null){
        return '';
    }

    return JSON.stringify(value);
}

function extractMarkdownTitle(text='',fallback=''){
    const match=String(text).match(/^#\s+(.+)$/m);
    return match?.[1]?.trim()||titleFromName(fallback);
}

function extractMarkdownSourceUrl(text=''){
    const match=String(text).match(/^Source URL:\s*(https?:\/\/\S+)/im);
    return match?.[1]?.trim()||'';
}

function extractMarkdownSummary(text=''){
    const cleaned=String(text)
        .replace(/^Source URL:.*$/im,'')
        .replace(/^#{1,6}\s+.*$/gm,'')
        .split(/\n\s*\n/)
        .map(value=>value.replace(/\s+/g,' ').trim())
        .find(Boolean)||'';

    return cleaned.slice(0,500);
}

async function loadUserMarkdownDocuments({
    opfs,
    maxDocuments=Number.POSITIVE_INFINITY,
    searchCharacterLimit=12000
}={}){
    const records=[];
    const errors=[];

    if(!opfs){
        return {records,errors};
    }

    let keys=[];

    try{
        keys=await getOpfsDocumentKeys(opfs);
    }catch(error){
        errors.push(normalizeError(error,'Unable to list uploaded BOSS documents.'));
        return {records,errors};
    }

    const requestedLimit=Number(maxDocuments);
    const limit=Number.isFinite(requestedLimit)
        ?Math.max(0,requestedLimit)
        :keys.length;
    const markdownKeys=keys
        .filter(name=>explicitlyLooksLikeMarkdown(name))
        .filter(name=>!name.startsWith(BOSS_LIBRARY_SEED_PREFIX))
        .filter(name=>name!==BOSS_LIBRARY_MANIFEST_VERSION_KEY)
        .sort((a,b)=>a.localeCompare(b))
        .slice(0,limit);

    for(const [index,name]of markdownKeys.entries()){
        try{
            const text=await readOpfsDocument(opfs,name);
            const preview=text.slice(0,Math.max(500,Number(searchCharacterLimit)||12000));
            const sourceUrl=extractMarkdownSourceUrl(preview);

            records.push(normalizeBossLibraryRecord(
                {
                    id:`user-${stableHash(name)}`,
                    title:extractMarkdownTitle(preview,name),
                    name,
                    source_url:sourceUrl,
                    summary:extractMarkdownSummary(preview),
                    search_text:`${name}\n${preview}`,
                    tags:['user upload'],
                    category:'User documents',
                    resource_type:'uploaded document',
                    access:'private-user',
                    origin:'user-upload',
                    opfsName:name
                },
                index
            ));
        }catch(error){
            errors.push(
                normalizeError(error,`Unable to read uploaded document ${name}.`)
            );
        }
    }

    return {records,errors};
}

async function fetchStaticMarkdown(record={},fetcher){
    const url=record.documentUrl||record.link;

    if(!url){
        throw new Error(`No Markdown link is available for ${record.title||record.name}.`);
    }

    const response=await fetcher(url,{cache:'no-cache'});

    if(!response?.ok){
        throw new Error(
            `Document request failed for ${record.name}${response?.status?` (${response.status})`:''}.`
        );
    }

    return await response.text();
}

async function fetchMatchedMarkdownBodies(
    matches=[],
    {
        fetchImpl,
        opfs,
        perDocumentCharacterLimit=DEFAULT_PER_DOCUMENT_CHARACTER_LIMIT,
        totalCharacterLimit=DEFAULT_TOTAL_CHARACTER_LIMIT
    }={}
){
    const fetcher=getFetchImplementation(fetchImpl);
    const hydrated=[];
    const errors=[];
    let remaining=Math.max(0,Number(totalCharacterLimit)||DEFAULT_TOTAL_CHARACTER_LIMIT);
    const perDocument=Math.max(
        1,
        Number(perDocumentCharacterLimit)||DEFAULT_PER_DOCUMENT_CHARACTER_LIMIT
    );

    for(const match of matches){
        if(remaining<1){
            break;
        }

        try{
            let body='';

            if(match.origin==='user-upload'){
                body=await readOpfsDocument(opfs,match.opfsName||match.name);
            }else{
                if(!fetcher){
                    throw new Error('Fetch is unavailable for bundled BOSS documents.');
                }

                body=await fetchStaticMarkdown(match,fetcher);
            }

            const limit=Math.min(perDocument,remaining);
            const content=String(body).slice(0,limit);
            remaining-=content.length;

            hydrated.push({
                ...match,
                sourceUrl:match.sourceUrl||extractMarkdownSourceUrl(body),
                content,
                contentTruncated:String(body).length>content.length
            });
        }catch(error){
            errors.push(
                normalizeError(
                    error,
                    `Unable to load matched document ${match.title||match.name}.`
                )
            );
        }
    }

    return {
        documents:hydrated,
        errors,
        charactersUsed:(Number(totalCharacterLimit)||DEFAULT_TOTAL_CHARACTER_LIMIT)-remaining
    };
}

function escapeXml(value=''){
    return String(value)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'",'&apos;');
}

function buildBossLibraryContext(documents=[],{query=''}={}){
    const lines=['<boss_library_context>'];

    if(query){
        lines.push(`  <query>${escapeXml(query)}</query>`);
    }

    if(!documents.length){
        lines.push('  <status>No matching readable BOSS Libraries documents were found.</status>');
    }

    for(const document of documents){
        lines.push(`  <document rank="${Number(document.rank)||1}">`);
        lines.push(`    <title>${escapeXml(document.title)}</title>`);
        lines.push(`    <name>${escapeXml(document.name)}</name>`);
        lines.push(`    <source_path>${escapeXml(document.sourcePath)}</source_path>`);
        lines.push(`    <source_url>${escapeXml(document.sourceUrl)}</source_url>`);
        lines.push(`    <link>${escapeXml(document.documentUrl||document.link)}</link>`);
        lines.push(`    <people>${escapeXml(document.people?.join(', ')||'')}</people>`);
        lines.push(`    <contacts>${escapeXml(document.contacts?.join(', ')||'')}</contacts>`);
        lines.push(`    <why_matched>${escapeXml(document.whyMatched)}</why_matched>`);
        lines.push(`    <content>${escapeXml(document.content)}</content>`);
        lines.push('  </document>');
    }

    lines.push('</boss_library_context>');
    return lines.join('\n');
}

async function createBossLibraryContext(query='',{
    manifest,
    manifestUrl=DEFAULT_MANIFEST_URL,
    fetchImpl,
    opfs,
    topK=DEFAULT_TOP_K,
    filters={},
    includeRestricted=false,
    synonymGroups=DEFAULT_SYNONYM_GROUPS,
    perDocumentCharacterLimit=DEFAULT_PER_DOCUMENT_CHARACTER_LIMIT,
    totalCharacterLimit=DEFAULT_TOTAL_CHARACTER_LIMIT,
    userDocumentLimit=Number.POSITIVE_INFINITY,
    userSearchCharacterLimit=12000
}={}){
    const warnings=[];
    let normalizedManifest;

    if(manifest){
        normalizedManifest=normalizeBossLibraryManifest(manifest,{manifestUrl});
    }else{
        const loaded=await loadBossLibraryManifest({manifestUrl,fetchImpl});
        normalizedManifest=loaded.manifest;

        if(!loaded.ok&&loaded.error){
            warnings.push(loaded.error);
        }
    }

    const uploads=await loadUserMarkdownDocuments({
        opfs,
        maxDocuments:userDocumentLimit,
        searchCharacterLimit:userSearchCharacterLimit
    });
    warnings.push(...uploads.errors);

    const matches=rankBossLibraryDocuments(
        [...normalizedManifest.documents,...uploads.records],
        query,
        {topK,filters,includeRestricted,synonymGroups}
    );
    const hydrated=await fetchMatchedMarkdownBodies(matches,{
        fetchImpl,
        opfs,
        perDocumentCharacterLimit,
        totalCharacterLimit
    });
    warnings.push(...hydrated.errors);

    return {
        context:buildBossLibraryContext(hydrated.documents,{query}),
        documents:hydrated.documents,
        matches,
        manifest:normalizedManifest,
        warnings
    };
}

async function searchBossLibrary(query='',options={}){
    return createBossLibraryContext(query,options);
}

function stableDocumentFileName(record={}){
    const normalized=normalizeBossLibraryRecord(record);
    const label=normalizeText(normalized.title||normalized.name)
        .replaceAll(' ','-')
        .slice(0,88)
        .replace(/-+$/,'')||'document';
    const identity=[
        normalized.id,
        normalized.path,
        normalized.sourceUrl,
        normalized.title
    ].join('|');

    return `${BOSS_LIBRARY_SEED_PREFIX}${label}--${stableHash(identity)}.md`;
}

async function writeOpfsDocument(opfs,name='',value=''){
    if(typeof opfs?.set==='function'){
        return await opfs.set('documents',name,value);
    }

    if(typeof opfs?.writeFile==='function'){
        return await opfs.writeFile('documents',name,value);
    }

    const directory=typeof opfs?.getTableHandle==='function'
        ?await opfs.getTableHandle('documents')
        :opfs;
    const handle=await directory.getFileHandle(name,{create:true});
    const writable=await handle.createWritable();

    try{
        await writable.write(value);
    }finally{
        await writable.close();
    }
}

async function deleteOpfsDocument(opfs,name=''){
    if(typeof opfs?.delete==='function'){
        return await opfs.delete('documents',name);
    }

    const directory=typeof opfs?.getTableHandle==='function'
        ?await opfs.getTableHandle('documents')
        :opfs;

    if(typeof directory?.removeEntry==='function'){
        return await directory.removeEntry(name);
    }
}

async function readSeedState(opfs){
    try{
        const value=await readOpfsDocument(
            opfs,
            BOSS_LIBRARY_MANIFEST_VERSION_KEY
        );

        if(value===undefined||value===null||value===''){
            return null;
        }

        return typeof value==='string'?JSON.parse(value):value;
    }catch(error){
        if(error?.name==='NotFoundError'){
            return null;
        }

        throw normalizeError(error,'Unable to read the BOSS library seed state.');
    }
}

async function resolveBossLibraryManifest({
    manifest,
    manifestUrl=DEFAULT_MANIFEST_URL,
    fetchImpl
}={}){
    if(manifest){
        return {
            ok:true,
            manifest:normalizeBossLibraryManifest(manifest,{manifestUrl}),
            error:null
        };
    }

    return loadBossLibraryManifest({manifestUrl,fetchImpl});
}

async function inspectNormalizedBossLibrarySeedState(normalizedManifest,opfs){
    const expectedFiles=normalizedManifest.documents
        .filter(isMarkdownRecord)
        .map(stableDocumentFileName);
    const errors=[];

    if(!opfs){
        errors.push(new Error('OPFS is unavailable for BOSS document inspection.'));
        return {
            ok:false,
            needsImport:true,
            firstRun:false,
            complete:false,
            sameVersion:false,
            manifestVersion:normalizedManifest.version,
            expected:expectedFiles.length,
            present:0,
            missing:expectedFiles.length,
            expectedFiles,
            presentFiles:[],
            missingFiles:expectedFiles,
            existingKeys:[],
            errors
        };
    }

    let existingKeys=[];

    try{
        existingKeys=await getOpfsDocumentKeys(opfs);
    }catch(error){
        errors.push(normalizeError(error,'Unable to inspect BOSS library documents.'));
    }

    let state=null;

    if(!errors.length){
        try{
            state=await readSeedState(opfs);
        }catch(error){
            errors.push(
                normalizeError(error,'Unable to inspect the BOSS library seed state.')
            );
        }
    }
    const existingSet=new Set(existingKeys);
    const presentFiles=expectedFiles.filter(name=>existingSet.has(name));
    const missingFiles=expectedFiles.filter(name=>!existingSet.has(name));
    const managedFiles=existingKeys.filter(
        name=>name.startsWith(BOSS_LIBRARY_SEED_PREFIX)
    );
    const sameVersion=toStringValue(state?.manifestVersion||state?.version)
        ===toStringValue(normalizedManifest.version);
    const complete=!errors.length
        &&sameVersion
        &&missingFiles.length===0
        &&state?.complete!==false;
    const firstRun=!errors.length&&!state&&managedFiles.length===0;

    return {
        ok:errors.length===0,
        needsImport:!complete,
        firstRun,
        complete,
        sameVersion,
        manifestVersion:normalizedManifest.version,
        expected:expectedFiles.length,
        present:presentFiles.length,
        missing:missingFiles.length,
        expectedFiles,
        presentFiles,
        missingFiles,
        existingKeys,
        state,
        errors
    };
}

async function inspectBossLibrarySeedState({
    manifest,
    manifestUrl=DEFAULT_MANIFEST_URL,
    fetchImpl,
    opfs
}={}){
    const resolved=await resolveBossLibraryManifest({
        manifest,
        manifestUrl,
        fetchImpl
    });

    if(!resolved.ok){
        const expected=resolved.manifest.documents.filter(isMarkdownRecord).length;
        return {
            ok:false,
            needsImport:true,
            firstRun:false,
            complete:false,
            sameVersion:false,
            manifestVersion:resolved.manifest.version,
            expected,
            present:0,
            missing:expected,
            expectedFiles:[],
            presentFiles:[],
            missingFiles:[],
            existingKeys:[],
            errors:[resolved.error]
        };
    }

    return inspectNormalizedBossLibrarySeedState(resolved.manifest,opfs);
}

async function reportSeedProgress(onProgress,detail={}){
    if(typeof onProgress!=='function'){
        return false;
    }

    try{
        await onProgress({...detail});
        return true;
    }catch(error){
        console.warn('BOSS library progress listener failed.',error);
        return false;
    }
}

async function notifySeedRefresh({
    onRefresh,
    eventTarget,
    eventName=BOSS_LIBRARY_REFRESH_EVENT,
    detail={}
}={}){
    if(typeof onRefresh==='function'){
        await onRefresh(detail);
        return true;
    }

    const target=eventTarget||(
        typeof globalThis.window!=='undefined'?globalThis.window:null
    );

    if(typeof target?.dispatchEvent!=='function'){
        return false;
    }

    const CustomEventConstructor=target?.ownerDocument?.defaultView?.CustomEvent
        ||globalThis.CustomEvent;

    if(typeof CustomEventConstructor==='function'){
        target.dispatchEvent(
            new CustomEventConstructor(eventName,{detail})
        );
        return true;
    }

    if(typeof globalThis.Event==='function'){
        const event=new globalThis.Event(eventName);
        Object.defineProperty(event,'detail',{value:detail});
        target.dispatchEvent(event);
        return true;
    }

    return false;
}

async function seedBossLibraryDocuments({
    manifest,
    manifestUrl=DEFAULT_MANIFEST_URL,
    fetchImpl,
    opfs,
    batchSize=DEFAULT_SEED_BATCH_SIZE,
    removeStale=true,
    onProgress,
    onRefresh,
    eventTarget,
    eventName=BOSS_LIBRARY_REFRESH_EVENT
}={}){
    const errors=[];

    if(!opfs){
        await reportSeedProgress(onProgress,{
            phase:'complete',
            processed:0,
            total:0,
            seeded:0,
            failed:1,
            ok:false
        });
        return {
            ok:false,
            idempotent:false,
            seeded:0,
            skipped:0,
            failed:1,
            removed:0,
            notified:false,
            errors:[new Error('OPFS is unavailable for BOSS document seeding.')]
        };
    }

    const resolved=await resolveBossLibraryManifest({
        manifest,
        manifestUrl,
        fetchImpl
    });

    if(!resolved.ok){
        await reportSeedProgress(onProgress,{
            phase:'complete',
            processed:0,
            total:0,
            seeded:0,
            failed:1,
            ok:false
        });
        return {
            ok:false,
            idempotent:false,
            seeded:0,
            skipped:0,
            failed:1,
            removed:0,
            notified:false,
            errors:[resolved.error]
        };
    }

    const normalizedManifest=resolved.manifest;

    const fetcher=getFetchImplementation(fetchImpl);
    const entries=normalizedManifest.documents
        .filter(isMarkdownRecord)
        .map(record=>({
            record,
            fileName:stableDocumentFileName(record)
        }));
    const expectedFiles=entries.map(entry=>entry.fileName);
    const inspection=await inspectNormalizedBossLibrarySeedState(
        normalizedManifest,
        opfs
    );
    errors.push(...inspection.errors);
    const state=inspection.state;
    const existingKeys=inspection.existingKeys;
    const existingSet=new Set(existingKeys);
    const sameVersion=inspection.sameVersion;
    const allPresent=inspection.missing===0;

    await reportSeedProgress(onProgress,{
        phase:'inspect',
        processed:inspection.sameVersion&&state?.complete!==false
            ?inspection.present
            :0,
        total:entries.length,
        seeded:0,
        failed:errors.length,
        present:inspection.present,
        missing:inspection.missing,
        firstRun:inspection.firstRun
    });

    if(!inspection.ok){
        await reportSeedProgress(onProgress,{
            phase:'complete',
            processed:0,
            total:entries.length,
            seeded:0,
            skipped:0,
            failed:errors.length,
            removed:0,
            ok:false,
            idempotent:false
        });
        return {
            ok:false,
            idempotent:false,
            manifestVersion:normalizedManifest.version,
            seeded:0,
            skipped:0,
            failed:errors.length,
            removed:0,
            notified:false,
            files:expectedFiles,
            errors
        };
    }

    if(sameVersion&&allPresent&&state?.complete!==false&&!errors.length){
        await reportSeedProgress(onProgress,{
            phase:'complete',
            processed:entries.length,
            total:entries.length,
            seeded:0,
            failed:0,
            removed:0,
            ok:true,
            idempotent:true
        });
        return {
            ok:true,
            idempotent:true,
            manifestVersion:normalizedManifest.version,
            seeded:0,
            skipped:entries.length,
            failed:0,
            removed:0,
            notified:false,
            files:expectedFiles,
            errors:[]
        };
    }

    const pending=sameVersion&&state?.complete!==false
        ?entries.filter(entry=>!existingSet.has(entry.fileName))
        :entries;
    const skipped=entries.length-pending.length;
    const boundedBatchSize=Math.max(
        1,
        Math.min(32,Number(batchSize)||DEFAULT_SEED_BATCH_SIZE)
    );
    let seeded=0;
    let failed=errors.length;
    let processed=entries.length-pending.length;

    await reportSeedProgress(onProgress,{
        phase:'start',
        processed,
        total:entries.length,
        seeded,
        failed,
        skipped,
        pending:pending.length
    });

    try{
        await writeOpfsDocument(
            opfs,
            BOSS_LIBRARY_MANIFEST_VERSION_KEY,
            JSON.stringify({
                manifestVersion:normalizedManifest.version,
                complete:false,
                files:expectedFiles
            })
        );
    }catch(error){
        failed++;
        errors.push(
            normalizeError(error,'Unable to begin the BOSS document import safely.')
        );
    }

    if(errors.length){
        // A durable incomplete marker is required before any document mutation.
    }else if(!fetcher&&pending.length){
        errors.push(new Error('Fetch is unavailable for BOSS document seeding.'));
        failed++;
    }else{
        for(let offset=0;offset<pending.length;offset+=boundedBatchSize){
            const batch=pending.slice(offset,offset+boundedBatchSize);
            await reportSeedProgress(onProgress,{
                phase:'batch',
                processed,
                total:entries.length,
                seeded,
                failed,
                batch:Math.floor(offset/boundedBatchSize)+1,
                batchSize:batch.length
            });
            const results=await Promise.allSettled(
                batch.map(
                    async entry=>{
                        const body=await fetchStaticMarkdown(entry.record,fetcher);
                        await writeOpfsDocument(
                            opfs,
                            entry.fileName,
                            body
                        );
                        return entry.fileName;
                    }
                )
            );

            for(let i=0;i<results.length;i++){
                processed++;
                if(results[i].status==='fulfilled'){
                    seeded++;
                }else{
                    failed++;
                    errors.push(
                        normalizeError(
                            results[i].reason,
                            `Unable to seed ${batch[i].record.title}.`
                        )
                    );
                }

                await reportSeedProgress(onProgress,{
                    phase:'document',
                    status:results[i].status==='fulfilled'?'imported':'failed',
                    processed,
                    total:entries.length,
                    seeded,
                    failed,
                    title:batch[i].record.title,
                    fileName:batch[i].fileName
                });
            }
        }
    }

    let removed=0;

    if(removeStale&&!errors.length){
        const expectedSet=new Set(expectedFiles);
        const stale=toStringList([
            ...toStringList(state?.files),
            ...existingKeys.filter(
                name=>name.startsWith(BOSS_LIBRARY_SEED_PREFIX)
            )
        ]).filter(
            name=>name.startsWith(BOSS_LIBRARY_SEED_PREFIX)
                &&!expectedSet.has(name)
        );

        for(const name of stale){
            try{
                await deleteOpfsDocument(opfs,name);
                removed++;
                await reportSeedProgress(onProgress,{
                    phase:'cleanup',
                    processed,
                    total:entries.length,
                    seeded,
                    failed,
                    removed,
                    fileName:name
                });
            }catch(error){
                failed++;
                errors.push(
                    normalizeError(error,`Unable to remove stale document ${name}.`)
                );
            }
        }
    }

    try{
        await writeOpfsDocument(
            opfs,
            BOSS_LIBRARY_MANIFEST_VERSION_KEY,
            JSON.stringify({
                manifestVersion:normalizedManifest.version,
                complete:errors.length===0,
                files:expectedFiles
            })
        );
        await reportSeedProgress(onProgress,{
            phase:'marker',
            processed,
            total:entries.length,
            seeded,
            failed,
            complete:errors.length===0
        });
    }catch(error){
        failed++;
        errors.push(normalizeError(error,'Unable to store the BOSS manifest version.'));
    }

    const changed=seeded>0||removed>0;
    const detail={
        manifestVersion:normalizedManifest.version,
        seeded,
        skipped,
        failed,
        removed,
        complete:errors.length===0
    };
    let notified=false;

    if(changed){
        try{
            notified=await notifySeedRefresh({
                onRefresh,
                eventTarget,
                eventName,
                detail
            });
        }catch(error){
            failed++;
            errors.push(normalizeError(error,'BOSS document refresh notification failed.'));
        }
    }

    await reportSeedProgress(onProgress,{
        phase:'complete',
        processed,
        total:entries.length,
        seeded,
        failed,
        removed,
        ok:errors.length===0,
        idempotent:false
    });

    return {
        ok:errors.length===0,
        idempotent:false,
        manifestVersion:normalizedManifest.version,
        seeded,
        skipped,
        failed,
        removed,
        notified,
        files:expectedFiles,
        errors
    };
}

export {
    BOSS_LIBRARY_MANIFEST_VERSION_KEY,
    BOSS_LIBRARY_REFRESH_EVENT,
    BOSS_LIBRARY_SEED_PREFIX,
    DEFAULT_MANIFEST_URL,
    DEFAULT_SYNONYM_GROUPS,
    buildBossLibraryContext,
    createBossLibraryContext,
    expandTerms,
    fetchMatchedMarkdownBodies,
    isMarkdownRecord,
    loadBossLibraryManifest,
    loadUserMarkdownDocuments,
    inspectBossLibrarySeedState,
    normalizeBossLibraryManifest,
    normalizeBossLibraryRecord,
    normalizeFilters,
    rankBossLibraryDocuments,
    searchBossLibrary,
    seedBossLibraryDocuments,
    stableDocumentFileName,
    stableHash
};
