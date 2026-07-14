const ascii=value=>Array.from(value,char=>char.charCodeAt(0));
const word=value=>[value&255,(value>>8)&255];

function palette(){const bytes=[];for(let index=0;index<256;index++){bytes.push(((index>>5)&7)*255/7,((index>>2)&7)*255/7,(index&3)*255/3)}return bytes.map(Math.round)}
function indexPixels(data){const result=new Uint8Array(data.length/4);for(let offset=0,index=0;offset<data.length;offset+=4,index++)result[index]=((data[offset]>>5)<<5)|((data[offset+1]>>5)<<2)|(data[offset+2]>>6);return result;}

function lzw(indices){
    const clear=256,end=257,bytes=[];let bits=0,bitCount=0,codeSize=9,next=258,table=new Map();
    const write=code=>{bits|=code<<bitCount;bitCount+=codeSize;while(bitCount>=8){bytes.push(bits&255);bits>>>=8;bitCount-=8}};
    const reset=()=>{table=new Map();codeSize=9;next=258};write(clear);let prefix=indices[0]??0;
    for(let position=1;position<indices.length;position++){
        const symbol=indices[position],key=`${prefix},${symbol}`;
        if(table.has(key)){prefix=table.get(key);continue}
        write(prefix);
        if(next<4096){table.set(key,next++);if(next===(1<<codeSize)&&codeSize<12)codeSize++}
        else{write(clear);reset()}
        prefix=symbol;
    }
    write(prefix);write(end);if(bitCount)bytes.push(bits&255);return bytes;
}
function blocks(data){const result=[];for(let index=0;index<data.length;index+=255){const block=data.slice(index,index+255);result.push(block.length,...block)}result.push(0);return result;}

export default class GifEncoder{
    constructor(width,height,{loop=0}={}){this.width=Math.max(1,Math.trunc(width));this.height=Math.max(1,Math.trunc(height));this.loop=Math.max(0,Math.trunc(loop));this.frames=[];}
    addFrame(imageData,{delay=250}={}){if(imageData.width!==this.width||imageData.height!==this.height)throw new RangeError('GIF frame dimensions must match the encoder.');this.frames.push({pixels:indexPixels(imageData.data),delay:Math.max(2,Math.round(delay/10))});return this.frames.length;}
    encode(){if(!this.frames.length)throw new Error('A GIF requires at least one frame.');const bytes=[...ascii('GIF89a'),...word(this.width),...word(this.height),0xF7,0,0,...palette(),0x21,0xFF,0x0B,...ascii('NETSCAPE2.0'),0x03,0x01,...word(this.loop),0];for(const frame of this.frames){bytes.push(0x21,0xF9,0x04,0x04,...word(frame.delay),0,0,0x2C,0,0,0,0,...word(this.width),...word(this.height),0,8,...blocks(lzw(frame.pixels)))}bytes.push(0x3B);return new Blob([new Uint8Array(bytes)],{type:'image/gif'});}
}

export {indexPixels,lzw};
