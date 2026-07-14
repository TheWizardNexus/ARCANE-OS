import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const variants={
    '20b':{ model:'arcane:20b',file:'Arcane-20B.Modelfile' },
    '120b':{ model:'arcane:120b',file:'Arcane-120B.Modelfile' },
}
const alias='arcane:latest'
const settingsFile=process.platform==='win32'
    ?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Arcane OS','settings.json')
    :path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'Arcane OS','settings.json')
const option=process.argv.find(value=>value.startsWith('--model='))?.slice('--model='.length).toLowerCase()
let settings={ schemaVersion:1,preference:'auto',activeVariant:null }
try{settings={ ...settings,...JSON.parse(await fs.readFile(settingsFile,'utf8')) }}catch{}
const preference=option||String(settings.preference||'auto').toLowerCase()
if(!['auto','20b','120b'].includes(preference))throw new Error('Use --model=auto, --model=20b, or --model=120b.')

function detectedGpuMemoryBytes(){
    const result=spawnSync('nvidia-smi',['--query-gpu=memory.total','--format=csv,noheader,nounits'],{ encoding:'utf8',windowsHide:true,timeout:5000 })
    if(result.status!==0)return null
    const values=String(result.stdout||'').split(/\r?\n/).map(value=>Number(value.trim())).filter(value=>Number.isFinite(value)&&value>0)
    return values.length?Math.max(...values)*1024**2:null
}
const gpuMemoryBytes=detectedGpuMemoryBytes()
const recommendedVariant=gpuMemoryBytes!==null&&gpuMemoryBytes>=80_000_000_000?'120b':'20b'
const variant=preference==='auto'?recommendedVariant:preference
const descriptor=variants[variant]
const source=await fs.readFile(path.join(root,'arcane','models',descriptor.file),'utf8')
const match=source.match(/^FROM ([A-Za-z0-9][A-Za-z0-9._:/-]{0,255})\r?\n\r?\nSYSTEM """\r?\n([\s\S]+?)\r?\n"""\r?\n?$/)
if(!match)throw new Error(`arcane/models/${descriptor.file} is invalid.`)
const definition={ from:match[1],system:match[2] }

function canonical(value){
    const name=String(value||'').trim().toLowerCase()
    return name.includes(':')?name:`${name}:latest`
}

function request(operation,{ method='GET',body=null,stream=false,onChunk=null,timeoutMs=10*60*1000 }={}){
    const encoded=body===null?null:Buffer.from(JSON.stringify({ ...body,...(stream?{ stream:true }:{}) }))
    return new Promise((resolve,reject)=>{
        const req=http.request({
            hostname:'127.0.0.1',port:11434,path:`/api/${operation}`,method,
            headers:{ Accept:stream?'application/x-ndjson':'application/json',...(encoded?{ 'Content-Type':'application/json','Content-Length':encoded.length }:{}) },agent:false,
        },response=>{
            let pending='';let last=null
            response.setEncoding('utf8')
            response.on('data',chunk=>{
                pending+=chunk
                if(!stream)return
                const lines=pending.split(/\r?\n/);pending=lines.pop()||''
                for(const line of lines){if(line.trim()){last=JSON.parse(line);onChunk?.(last)}}
            })
            response.on('end',()=>{
                if(response.statusCode<200||response.statusCode>=300){let message=`Ollama returned HTTP ${response.statusCode}.`;try{message=JSON.parse(pending).error||message}catch{}reject(new Error(message));return}
                if(stream&&pending.trim()){last=JSON.parse(pending);onChunk?.(last)}
                if(!stream&&!pending.trim()){resolve({ status:'success' });return}
                try{resolve(stream?last:JSON.parse(pending))}catch(error){reject(error)}
            })
        })
        req.setTimeout(timeoutMs,()=>req.destroy(new Error(`Ollama ${operation} timed out.`)))
        req.on('error',reject);req.end(encoded||undefined)
    })
}
async function models(){const payload=await request('tags');return Array.isArray(payload?.models)?payload.models:[]}
function present(items,name){const wanted=canonical(name);return items.some(item=>canonical(item?.name||item?.model)===wanted)}

console.log(`Arcane model preference: ${preference}; GPU recommendation: ${recommendedVariant}; selecting ${variant}.`)
let installed=await models()
if(!present(installed,descriptor.model)){
    if(!present(installed,definition.from)){
        console.log(`Pulling ${definition.from} for ${descriptor.model}...`)
        let lastPercent=-1;let lastStatus=''
        await request('pull',{ method:'POST',body:{ model:definition.from },stream:true,timeoutMs:50*60*1000,onChunk(chunk){
            const completed=Number(chunk?.completed);const total=Number(chunk?.total)
            const percent=Number.isFinite(completed)&&Number.isFinite(total)&&total>0?Math.floor(completed/total*100):null
            if(percent!==null&&percent!==lastPercent){lastPercent=percent;console.log(`PULL ${percent}% ${chunk.status||''}`.trim())}
            else if(percent===null&&chunk?.status&&chunk.status!==lastStatus){lastStatus=chunk.status;console.log(`PULL ${chunk.status}`)}
        } })
    }else console.log(`${definition.from} is already present; skipping the base-model download.`)
    console.log(`Creating ${descriptor.model} from arcane/models/${descriptor.file}...`)
    let lastCreateStatus=''
    await request('create',{ method:'POST',body:{ model:descriptor.model,from:definition.from,system:definition.system },stream:true,timeoutMs:50*60*1000,onChunk(chunk){
        if(chunk?.status&&chunk.status!==lastCreateStatus){lastCreateStatus=chunk.status;console.log(`CREATE ${chunk.status}`)}
    } })
}
await request('copy',{ method:'POST',body:{ source:descriptor.model,destination:alias } })
installed=await models()
if(!present(installed,descriptor.model)||!present(installed,alias))throw new Error(`${descriptor.model} and ${alias} were not both returned after selection.`)
await fs.mkdir(path.dirname(settingsFile),{ recursive:true })
await fs.writeFile(settingsFile,JSON.stringify({ schemaVersion:1,preference,activeVariant:variant,updatedAt:new Date().toISOString() }),{ mode:0o600 })
console.log(`${descriptor.model} is ready and selected as ${alias} through the global ArcaneOllama service.`)
