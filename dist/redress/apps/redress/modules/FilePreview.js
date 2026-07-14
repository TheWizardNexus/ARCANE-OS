const GENERIC_MIME_TYPES=new Set([
    '',
    'application/octet-stream',
    'binary/octet-stream'
]);

const MARKDOWN_EXTENSIONS=new Set(['.md','.markdown','.mdown','.mkd']);

const TEXT_EXTENSIONS=new Set([
    '.asc','.cfg','.cjs','.conf','.css','.csv','.eml','.html','.htm','.ics','.ini','.js',
    '.json','.jsonl','.log','.mjs','.properties','.ps1','.py','.rtf','.sh','.sql','.svg',
    '.text','.toml','.tsv','.txt','.xml','.yaml','.yml'
]);

const TEXT_MIME_TYPES=new Set([
    'application/json',
    'application/ld+json',
    'application/rtf',
    'application/x-ndjson',
    'application/xml',
    'application/yaml',
    'message/rfc822'
]);

const MIME_BY_EXTENSION=Object.freeze({
    '.avi':'video/x-msvideo',
    '.bmp':'image/bmp',
    '.gif':'image/gif',
    '.jpeg':'image/jpeg',
    '.jpg':'image/jpeg',
    '.m4a':'audio/mp4',
    '.m4v':'video/mp4',
    '.md':'text/markdown',
    '.mov':'video/quicktime',
    '.mp3':'audio/mpeg',
    '.mp4':'video/mp4',
    '.oga':'audio/ogg',
    '.ogg':'audio/ogg',
    '.ogv':'video/ogg',
    '.pdf':'application/pdf',
    '.png':'image/png',
    '.svg':'image/svg+xml',
    '.tif':'image/tiff',
    '.tiff':'image/tiff',
    '.wav':'audio/wav',
    '.webm':'video/webm',
    '.webp':'image/webp'
});

function extensionOf(value=''){
    const name=String(value).split(/[\\/]/).pop()||'';
    const index=name.lastIndexOf('.');
    return index>0?name.slice(index).toLowerCase():'';
}

function previewExtension(record={},file={}){
    return String(record.extension||'').toLowerCase()
        ||extensionOf(record.name||record.path||record.originalName||file.name||'');
}

function previewMimeType(record={},file={}){
    const extension=previewExtension(record,file);
    const candidates=[record.mimeType,file.type]
        .map(value=>String(value||'').split(';')[0].trim().toLowerCase());
    const declared=candidates.find(value=>!GENERIC_MIME_TYPES.has(value));
    return declared||MIME_BY_EXTENSION[extension]||candidates[0]||candidates[1]||'';
}

function previewKind(record={},file={}){
    const extension=previewExtension(record,file);
    const mimeType=previewMimeType(record,file);

    if(MARKDOWN_EXTENSIONS.has(extension)||mimeType==='text/markdown'){
        return 'markdown';
    }
    if(extension==='.pdf'||mimeType==='application/pdf'){
        return 'pdf';
    }
    if(extension==='.svg'||mimeType==='image/svg+xml'){
        return 'text';
    }
    if(mimeType.startsWith('image/')){
        return 'image';
    }
    if(mimeType.startsWith('audio/')){
        return 'audio';
    }
    if(mimeType.startsWith('video/')){
        return 'video';
    }
    if(mimeType.startsWith('text/')||TEXT_MIME_TYPES.has(mimeType)||TEXT_EXTENSIONS.has(extension)){
        return 'text';
    }
    return 'unsupported';
}

async function hasPdfSignature(file){
    if(!file||typeof file.slice!=='function'){
        return false;
    }
    const bytes=new Uint8Array(await file.slice(0,1024).arrayBuffer());
    const signature=[0x25,0x50,0x44,0x46,0x2d];
    for(let index=0;index<=bytes.length-signature.length;index++){
        if(signature.every((value,offset)=>bytes[index+offset]===value)){
            return true;
        }
    }
    return false;
}

export {
    MIME_BY_EXTENSION,
    hasPdfSignature,
    previewExtension,
    previewKind,
    previewMimeType
};
