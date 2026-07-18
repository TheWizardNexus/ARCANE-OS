import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {
    listConfiguredHostnames,
    loadDomainConfiguration,
    startDomainServer
} from '../../arcane/server/StaticDomainServer.mjs';

const configPath=fileURLToPath(new URL('./domain.config.json',import.meta.url));

function readBoolean(name,defaultValue=false){
    const raw=process.env[name];
    if(raw===undefined) return defaultValue;
    if(['1','true','yes','on'].includes(raw.toLowerCase())) return true;
    if(['0','false','no','off'].includes(raw.toLowerCase())) return false;
    throw new Error(`${name} must be true or false.`);
}

function readPort(name,defaultValue){
    const raw=process.env[name];
    if(raw===undefined) return defaultValue;
    const value=Number(raw);
    if(!Number.isSafeInteger(value)||value<0||value>65535) throw new Error(`${name} must be a port from 0 through 65535.`);
    return value;
}

if(process.argv.includes('--list-hostnames')){
    const configuration=await loadDomainConfiguration(configPath);
    for(const hostname of listConfiguredHostnames(configuration)) process.stdout.write(`${hostname}\n`);
    process.exit(0);
}

const host=process.env.ARCANE_WEB_HOST??'127.0.0.1';
const server=await startDomainServer({
    configPath,
    host,
    httpPort:readPort('ARCANE_HTTP_PORT',8080),
    httpsPort:readPort('ARCANE_HTTPS_PORT',8443),
    certificatePath:process.env.ARCANE_TLS_CERT_PATH??null,
    privateKeyPath:process.env.ARCANE_TLS_KEY_PATH??null,
    requireTls:readBoolean('ARCANE_REQUIRE_TLS',false),
    redirectHttp:readBoolean('ARCANE_REDIRECT_HTTP',true),
    allowDevelopmentHosts:readBoolean('ARCANE_ALLOW_DEVELOPMENT_HOSTS',host==='127.0.0.1'||host==='::1'||host==='localhost')
});

const httpAddress=server.httpAddress;
const httpsAddress=server.httpsAddress;
process.stdout.write(`PreCrisis domain HTTP listener: ${httpAddress.address}:${httpAddress.port}\n`);
if(httpsAddress) process.stdout.write(`PreCrisis domain HTTPS listener: ${httpsAddress.address}:${httpsAddress.port}\n`);
else process.stdout.write('TLS certificate not present; HTTPS listener is disabled.\n');

let shuttingDown=false;
async function shutdown(signal){
    if(shuttingDown) return;
    shuttingDown=true;
    process.stdout.write(`Received ${signal}; closing listeners.\n`);
    await server.close();
}

process.once('SIGINT',()=>void shutdown('SIGINT').catch(error=>{console.error(error);process.exitCode=1;}));
process.once('SIGTERM',()=>void shutdown('SIGTERM').catch(error=>{console.error(error);process.exitCode=1;}));
process.on('SIGHUP',()=>void server.reloadTls()
    .then(reloaded=>process.stdout.write(reloaded?'TLS certificate reloaded.\n':'HTTPS is not active; nothing to reload.\n'))
    .catch(error=>console.error(`TLS reload failed: ${error.message}`)));
