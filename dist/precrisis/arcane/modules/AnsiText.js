const ANSI_PATTERN=/\x1b\[([0-9;?]*)([ -\/]*)([@-~])/g;
const COLORS=['black','red','green','yellow','blue','magenta','cyan','white'];

function freshStyle(){ return {bold:false,dim:false,italic:false,underline:false,inverse:false,foreground:null,background:null}; }
function snapshot(style){ return Object.freeze({...style}); }

function applyCodes(style,raw=''){
    const codes=(raw?raw.split(';'):['0']).map(value=>Number(value||0));
    for(let index=0;index<codes.length;index+=1){
        const code=codes[index];
        if(code===0) Object.assign(style,freshStyle());
        else if(code===1) style.bold=true;
        else if(code===2) style.dim=true;
        else if(code===3) style.italic=true;
        else if(code===4) style.underline=true;
        else if(code===7) style.inverse=true;
        else if(code===22){style.bold=false;style.dim=false;}
        else if(code===23) style.italic=false;
        else if(code===24) style.underline=false;
        else if(code===27) style.inverse=false;
        else if(code===39) style.foreground=null;
        else if(code===49) style.background=null;
        else if(code>=30&&code<=37) style.foreground=COLORS[code-30];
        else if(code>=40&&code<=47) style.background=COLORS[code-40];
        else if(code>=90&&code<=97) style.foreground=`bright-${COLORS[code-90]}`;
        else if(code>=100&&code<=107) style.background=`bright-${COLORS[code-100]}`;
        else if((code===38||code===48)&&codes[index+1]===5&&Number.isInteger(codes[index+2])){
            style[code===38?'foreground':'background']=`index-${Math.max(0,Math.min(255,codes[index+2]))}`;
            index+=2;
        }
    }
}

export function parseAnsi(input=''){
    const text=String(input??'');
    const tokens=[];
    const style=freshStyle();
    let cursor=0;
    let match;
    ANSI_PATTERN.lastIndex=0;
    while((match=ANSI_PATTERN.exec(text))){
        if(match.index>cursor) tokens.push(Object.freeze({text:text.slice(cursor,match.index),style:snapshot(style)}));
        if(match[3]==='m') applyCodes(style,match[1]);
        cursor=ANSI_PATTERN.lastIndex;
    }
    if(cursor<text.length) tokens.push(Object.freeze({text:text.slice(cursor),style:snapshot(style)}));
    return Object.freeze(tokens);
}

export function stripAnsi(input=''){
    ANSI_PATTERN.lastIndex=0;
    return String(input??'').replace(ANSI_PATTERN,'');
}
