function normalizeMemoryContent(content=''){
    if(typeof content!=='string'){
        return '';
    }

    let normalized=content.trim();

    for(let i=0;i<3&&normalized;i++){
        try{
            const parsed=JSON.parse(normalized);

            if(typeof parsed!=='string'){
                break;
            }

            normalized=parsed.trim();
        }catch{
            break;
        }
    }

    return normalized;
}

function hasMemoryContent(memory={}){
    const records=Array.isArray(memory)
        ?memory
        :[memory];

    return records.some(
        record=>Boolean(
            normalizeMemoryContent(
                typeof record==='string'
                    ?record
                    :record?.memory
            )
        )
    );
}

export {
    hasMemoryContent,
    normalizeMemoryContent
};
