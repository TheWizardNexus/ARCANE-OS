import CommunicationMessage from './CommunicationMessage.js';

function required(value,label){const text=String(value??'').trim();if(!text) throw new TypeError(`${label} is required.`);return text;}

export default class CommunicationThread{
    constructor(input={}){
        this.id=required(input.id,'Thread id');
        this.providerId=required(input.providerId,'Provider id');
        this.channel=String(input.channel||'other');
        this.title=String(input.title||input.subject||'Untitled conversation').trim()||'Untitled conversation';
        this.participants=Object.freeze(Array.from(input.participants||[],value=>String(value??'').trim()).filter(Boolean));
        this.preview=String(input.preview||'');
        const date=new Date(input.updatedAt||Date.now());
        if(Number.isNaN(date.valueOf())) throw new TypeError('Thread update time is invalid.');
        this.updatedAt=date.toISOString();
        this.unreadCount=Math.max(0,Number.parseInt(input.unreadCount||0,10)||0);
        this.messages=Object.freeze(Array.from(input.messages||[],value=>value instanceof CommunicationMessage?value:new CommunicationMessage({...value,threadId:value.threadId||this.id,providerId:value.providerId||this.providerId,channel:value.channel||this.channel})));
        Object.freeze(this);
    }
    toJSON(){return {...this,participants:[...this.participants],messages:this.messages.map(message=>message.toJSON())};}
}
