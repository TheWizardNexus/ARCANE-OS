function markerFor(source=''){
    let marker='\uE000REDRESS_MARKDOWN_ANGLE_';
    while(source.includes(marker)){
        marker+='_';
    }
    return marker;
}

export function neutralizeMarkdownSource(value=''){
    let source=String(value||'');
    const marker=markerFor(source);
    const protectedAngles=[];
    const protect=value=>{
        const index=protectedAngles.push(value)-1;
        return `${marker}${index}\uE001`;
    };

    source=source.replace(/(\\*)!\[/g,(_match,slashes)=>
        `${slashes}${slashes.length%2===0?'\\':''}![`
    );
    source=source.replace(/\]\(<([^<>\r\n]*)>\)/g,(_match,destination)=>`](${protect(`<${destination}>`)})`);
    source=source.replace(/<(?:(?:https?:\/\/)|mailto:|tel:)[^<>\r\n]+>/gi,match=>protect(match));
    source=source.replaceAll('<','&lt;');

    protectedAngles.forEach((value,index)=>{
        source=source.replace(`${marker}${index}\uE001`,value);
    });
    return source;
}

export default neutralizeMarkdownSource;
