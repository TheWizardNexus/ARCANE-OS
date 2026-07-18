import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,stat,utimes,writeFile} from 'node:fs/promises';
import http from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
    createDomainRequestHandler,
    createStaticSiteRelease,
    listConfiguredHostnames,
    loadDomainConfiguration
} from '../arcane/server/StaticDomainServer.mjs';

const workspaceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporaryRoots=new Set();

test.afterEach(async()=>{
    await Promise.all([...temporaryRoots].map(root=>rm(root,{recursive:true,force:true})));
    temporaryRoots.clear();
});

function digest(value){
    return createHash('sha256').update(value).digest('hex');
}

function contrastRatio(left,right){
    const luminance=rgb=>{
        const channels=rgb.map(value=>value/255).map(value=>value<=0.03928?value/12.92:((value+0.055)/1.055)**2.4);
        return 0.2126*channels[0]+0.7152*channels[1]+0.0722*channels[2];
    };
    const values=[luminance(left),luminance(right)].sort((a,b)=>b-a);
    return (values[0]+0.05)/(values[1]+0.05);
}

async function writeJson(file,value){
    await mkdir(path.dirname(file),{recursive:true});
    await writeFile(file,`${JSON.stringify(value,null,2)}\n`,'utf8');
}

async function fixture({
    registryConnectOrigins=['http://127.0.0.1:9999','https://api.example.test'],
    publicConnectOrigins=['https://api.example.test'],
    tamperUnusedHtml=false
}={}){
    const root=await mkdtemp(path.join(tmpdir(),'arcane-static-domain-'));
    temporaryRoots.add(root);
    const siteRoot=path.join(root,'domain','public');
    const appRoot=path.join(root,'dist','fixture');
    const siteHtml='<!doctype html><html lang="en"><head><title>Fixture</title></head><body>Site home</body></html>\n';
    const appHtml='<!doctype html><html lang="en"><head><title>App</title><script>window.fixture=true;</script></head><body>App home</body></html>\n';
    const unusedHtml='<!doctype html><html lang="en"><head><script>window.unused=true;</script></head><body>Unused</body></html>\n';
    const sharedCss=':root{color-scheme:light dark}\n';
    await mkdir(path.join(siteRoot,'.well-known','acme-challenge'),{recursive:true});
    await mkdir(path.join(appRoot,'apps','fixture'),{recursive:true});
    await mkdir(path.join(appRoot,'arcane','css'),{recursive:true});
    await writeFile(path.join(siteRoot,'index.html'),siteHtml);
    await writeFile(path.join(appRoot,'apps','fixture','index.html'),appHtml);
    await writeFile(path.join(appRoot,'apps','fixture','unused.html'),unusedHtml);
    await writeFile(path.join(appRoot,'arcane','css','theme.css'),sharedCss);
    await writeJson(path.join(root,'domain','site-release.json'),await createStaticSiteRelease({siteRoot,site:'example.test'}));
    await writeJson(path.join(appRoot,'ARCANE_APP_RELEASE.json'),{
        schemaVersion:1,
        app:{id:'fixture',displayName:'Fixture',version:'1.0.0',entry:'index.html',start:'./apps/fixture/index.html'},
        files:[
            {path:'apps/fixture/index.html',bytes:Buffer.byteLength(appHtml),sha256:digest(appHtml)},
            {path:'apps/fixture/unused.html',bytes:Buffer.byteLength(unusedHtml),sha256:digest(unusedHtml)},
            {path:'arcane/css/theme.css',bytes:Buffer.byteLength(sharedCss),sha256:digest(sharedCss)}
        ]
    });
    if(tamperUnusedHtml) await writeFile(path.join(appRoot,'apps','fixture','unused.html'),'<script>window.attacker=true;</script>\n');
    await writeJson(path.join(root,'registry.json'),{
        apps:{fixture:{capabilities:[],security:{connectOrigins:registryConnectOrigins,frameOrigins:[],mediaOrigins:[]}}}
    });
    await writeJson(path.join(root,'domain','domain.config.json'),{
        schemaVersion:1,
        projectRoot:'..',
        canonicalHost:'example.test',
        baseDomain:'example.test',
        siteRoot:'domain/public',
        siteManifest:'domain/site-release.json',
        distRoot:'dist',
        appRegistry:'registry.json',
        redirectHosts:{'www.example.test':'example.test'},
        distApps:{app:'fixture'},
        publicAppSecurity:{fixture:{connectOrigins:publicConnectOrigins}},
        siteMounts:[{urlPrefix:'/arcane/',distApp:'fixture',pathPrefix:'arcane'}],
        siteAssetAliases:{},
        tls:{certificatePath:'/missing/fullchain.pem',privateKeyPath:'/missing/privkey.pem'}
    });
    const configuration=await loadDomainConfiguration(path.join(root,'domain','domain.config.json'));
    const server=http.createServer(createDomainRequestHandler(configuration));
    await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,'127.0.0.1',resolve);
    });
    return {root,siteRoot,configuration,server,port:server.address().port};
}

function request(port,{hostname='example.test',method='GET',target='/',headers={}}={}){
    return new Promise((resolve,reject)=>{
        const client=http.request({host:'127.0.0.1',port,method,path:target,headers:{host:hostname,...headers}},response=>{
            const chunks=[];
            response.on('data',chunk=>chunks.push(chunk));
            response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
        });
        client.once('error',reject);
        client.end();
    });
}

test('domain configuration produces one explicit canonical, redirect, and app host inventory',async()=>{
    const {configuration,server}=await fixture();
    try{
        assert.deepEqual(listConfiguredHostnames(configuration),['app.example.test','example.test','www.example.test']);
        assert.equal(configuration.appHosts.get('app.example.test'),'fixture');
        assert.equal(configuration.redirectHosts.get('www.example.test'),'example.test');
    }finally{
        await new Promise(resolve=>server.close(resolve));
    }
});

test('site, redirect, application, shared mount, HEAD, and ACME routes remain isolated',async()=>{
    const {siteRoot,server,port}=await fixture();
    try{
        const site=await request(port);
        assert.equal(site.status,200);
        assert.match(site.body.toString('utf8'),/Site home/);
        assert.match(site.headers['content-security-policy'],/default-src 'none'/);
        assert.equal(site.headers['x-content-type-options'],'nosniff');
        assert.equal(site.headers['x-frame-options'],'DENY');
        assert.equal(site.headers['referrer-policy'],'no-referrer');

        const head=await request(port,{method:'HEAD'});
        assert.equal(head.status,200);
        assert.equal(head.body.length,0);
        assert.equal(Number(head.headers['content-length']),site.body.length);

        const canonical=await request(port,{hostname:'www.example.test',target:'/path?x=1'});
        assert.equal(canonical.status,308);
        assert.equal(canonical.headers.location,'http://example.test/path?x=1');

        const app=await request(port,{hostname:'app.example.test'});
        assert.equal(app.status,302);
        assert.equal(app.headers.location,'/apps/fixture/index.html');
        const scriptDirective=app.headers['content-security-policy']
            .split('; ')
            .find((directive)=>directive.startsWith('script-src '));
        assert.doesNotMatch(scriptDirective,/unsafe-inline/);
        assert.match(scriptDirective,/script-src 'self' 'sha256-/);
        const connectDirective=app.headers['content-security-policy']
            .split('; ')
            .find((directive)=>directive.startsWith('connect-src '));
        assert.match(connectDirective,/https:\/\/api\.example\.test/);
        assert.doesNotMatch(connectDirective,/127\.0\.0\.1/);

        const appPage=await request(port,{hostname:'app.example.test',target:'/apps/fixture/index.html'});
        assert.equal(appPage.status,200);
        assert.match(appPage.body.toString('utf8'),/App home/);

        const mounted=await request(port,{target:'/arcane/css/theme.css'});
        assert.equal(mounted.status,200);
        assert.equal(mounted.headers['content-type'],'text/css; charset=utf-8');

        const token='fixture_token-123';
        const challengeBody=`${token}.fixtureThumbprint_123\n`;
        await writeFile(path.join(siteRoot,'.well-known','acme-challenge',token),challengeBody);
        const challenge=await request(port,{hostname:'app.example.test',target:`/.well-known/acme-challenge/${token}`});
        assert.equal(challenge.status,200);
        assert.equal(challenge.body.toString('utf8'),challengeBody);
        assert.equal(challenge.headers['cache-control'],'no-store');

        const invalidToken='invalid_token-123';
        await writeFile(path.join(siteRoot,'.well-known','acme-challenge',invalidToken),'not an ACME key authorization\n');
        assert.equal((await request(port,{target:`/.well-known/acme-challenge/${invalidToken}`})).status,404);
    }finally{
        await new Promise(resolve=>server.close(resolve));
    }
});

test('unknown hosts, unsupported methods, request bodies, traversal, malformed encoding, and directory scans fail closed',async()=>{
    const {server,port}=await fixture();
    try{
        assert.equal((await request(port,{hostname:'unknown.example.test'})).status,421);
        const method=await request(port,{method:'POST'});
        assert.equal(method.status,405);
        assert.equal(method.headers.allow,'GET, HEAD');
        assert.equal((await request(port,{headers:{'content-length':'1'}})).status,400);
        assert.equal((await request(port,{target:'/..%2fsecret.txt'})).status,400);
        assert.equal((await request(port,{target:'/%ZZ'})).status,400);
        assert.equal((await request(port,{target:'/arcane/'})).status,404);
        assert.equal((await request(port,{target:'/ARCANE_APP_RELEASE.json'})).status,404);
    }finally{
        await new Promise(resolve=>server.close(resolve));
    }
});

test('a changed published byte is rejected instead of being served',async()=>{
    const {root,server,port}=await fixture();
    try{
        const file=path.join(root,'dist','fixture','apps','fixture','index.html');
        const original=await readFile(file,'utf8');
        const metadata=await stat(file);
        assert.equal((await request(port,{hostname:'app.example.test',target:'/apps/fixture/index.html'})).status,200);
        const tampered=original.replace('App home','Bad home');
        assert.equal(Buffer.byteLength(tampered),Buffer.byteLength(original));
        await writeFile(file,tampered);
        await utimes(file,metadata.atime,metadata.mtime);
        const response=await request(port,{hostname:'app.example.test',target:'/apps/fixture/index.html'});
        assert.equal(response.status,500);
        assert.doesNotMatch(response.body.toString('utf8'),/tampered/);
    }finally{
        await new Promise(resolve=>server.close(resolve));
    }
});

test('registry and public CSP origins reject directive injection, paths, and loopback widening',async()=>{
    await assert.rejects(
        ()=>fixture({registryConnectOrigins:['https://api.example.test; script-src *']}),
        /application registry connectOrigins/
    );
    await assert.rejects(
        ()=>fixture({publicConnectOrigins:['http://127.0.0.1:9999']}),
        /must contain only exact HTTPS origins/
    );
    await assert.rejects(
        ()=>fixture({
            registryConnectOrigins:['https://api.example.test/path'],
            publicConnectOrigins:[]
        }),
        /application registry connectOrigins/
    );
});

test('startup rejects tampered non-entry HTML before deriving global CSP hashes',async()=>{
    await assert.rejects(
        ()=>fixture({tamperUnusedHtml:true}),
        /published file (?:size|digest|changed)/
    );
});

test('PreCrisis domain site preserves theme order, updated people, exact app CTA, and accessible page structure',async()=>{
    const [index,privacy,css,themeCss,config,certbot,caddy,release,mailService]=await Promise.all([
        readFile(path.join(workspaceRoot,'domains','precrisis.ai','public','index.html'),'utf8'),
        readFile(path.join(workspaceRoot,'domains','precrisis.ai','public','privacy.html'),'utf8'),
        readFile(path.join(workspaceRoot,'domains','precrisis.ai','public','site.css'),'utf8'),
        readFile(path.join(workspaceRoot,'dist','precrisis','arcane','css','theme.css'),'utf8'),
        readFile(path.join(workspaceRoot,'domains','precrisis.ai','domain.config.json'),'utf8').then(JSON.parse),
        readFile(path.join(workspaceRoot,'domains','precrisis.ai','certbot.sh'),'utf8'),
        readFile(path.join(workspaceRoot,'domains','precrisis.ai','Caddyfile.example'),'utf8'),
        readFile(path.join(workspaceRoot,'domains','precrisis.ai','site-release.json'),'utf8').then(JSON.parse),
        readFile(path.join(workspaceRoot,'domains','precrisis.ai','arcane-mail.service.example'),'utf8')
    ]);
    const theme=index.indexOf('/arcane/css/theme.css');
    const primitives=index.indexOf('/arcane/css/primitives.css');
    const siteCss=index.indexOf('/site.css');
    assert(theme>=0&&primitives>theme&&siteCss>primitives);
    assert.match(index,/\/arcane\/modules\/ThemeBootstrap\.js/);
    assert.match(index,/\/site\.js/);
    assert.match(index,/<a class="skip-link" href="#main">/);
    assert.match(index,/<main id="main" tabindex="-1">/);
    assert.match(index,/Erich Zimmer/);
    assert.match(index,/George Davis Jr\./);
    assert.doesNotMatch(index,/Joshua|Mateo/i);
    assert.match(index,/href="https:\/\/app\.precrisis\.ai\/"/);
    assert.match(index,/href="\/privacy\.html"/);
    assert.match(privacy,/network model[\s\S]{0,80}sends prompts and relevant conversation content/i);
    assert.equal(config.distApps.app,'precrisis');
    assert.equal(config.distApps.scamurai,'scamurai');
    assert.equal(config.distApps.boss,undefined);
    assert.deepEqual(config.publicAppSecurity.precrisis.connectOrigins,['https://api.openai.com']);
    assert.equal(config.redirectHosts['www.precrisis.ai'],'precrisis.ai');
    assert.match(certbot,/server\.mjs" --list-hostnames/);
    assert.match(certbot,/--webroot/);
    assert.match(certbot,/--run-deploy-hooks/);
    assert.match(caddy,/Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
    assert.match(caddy,/header_up -Authorization/);
    assert.match(caddy,/header_up -Cookie/);
    assert.match(caddy,/app\.precrisis\.ai \{[\s\S]*basic_auth[\s\S]*@arcane_mail path \/v1\/mail/);
    assert.match(caddy,/reverse_proxy 127\.0\.0\.1:8025[\s\S]*header_up X-Mail-App precrisis[\s\S]*header_up X-Mail-Key \{\$ARCANE_MAIL_PRECRISIS_KEY\}/);
    assert.equal((caddy.match(/response_header_timeout 450s/g)||[]).length,2);
    assert.match(mailService,/TimeoutStopSec=450s/);
    assert.match(caddy,/www\.precrisis\.ai \{[\s\S]*redir https:\/\/precrisis\.ai\{uri\} permanent/);
    for(const hostname of ['precrisis.ai','www.precrisis.ai',...Object.keys(config.distApps).map(label=>`${label}.precrisis.ai`)]) assert.match(caddy,new RegExp(hostname.replaceAll('.','\\.')));
    assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b/i);
    assert.match(css,/--site-warm:rgb\(142,82,15\)/);
    assert.match(css,/\.principles \.eyebrow\{color:rgb\(204,139,61\);\}/);
    assert.match(themeCss,/--focus-color:rgb\(118, 87, 213\)/);
    assert.match(themeCss,/--focus-color:rgb\(171, 148, 255\)/);
    for(const [foreground,background] of [
        [[255,255,255],[118,87,213]],
        [[13,18,32],[171,148,255]],
        [[142,82,15],[244,246,251]],
        [[204,139,61],[13,44,53]],
        [[13,44,53],[199,235,230]]
    ]) assert(contrastRatio(foreground,background)>=4.5);
    assert.match(css,/@media \(forced-colors:active\)/);
    assert.match(css,/@media \(prefers-reduced-motion:reduce\)/);
    assert.deepEqual(release,await createStaticSiteRelease({
        siteRoot:path.join(workspaceRoot,'domains','precrisis.ai','public'),
        site:'precrisis.ai'
    }));
});
