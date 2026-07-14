const CHANNELS=new Set(['email','sms','mms','rcs','whatsapp','other']);
const DIRECTIONS=new Set(['inbound','outbound']);
const STATUSES=new Set(['draft','queued','sending','sent','delivered','read','failed','received']);

function required(value,label){const text=String(value??'').trim();if(!text) throw new TypeError(`${label} is required.`);return text;}
function strings(value){return Array.from(value||[],item=>String(item??'').trim()).filter(Boolean);}
function instant(value){const date=value instanceof Date?value:new Date(value||Date.now());if(Number.isNaN(date.valueOf())) throw new TypeError('Message timestamp is invalid.');return date.toISOString();}

export default class CommunicationMessage{
    constructor(input={}){
        this.id=required(input.id,'Message id');
        this.threadId=required(input.threadId,'Thread id');
        this.providerId=required(input.providerId,'Provider id');
        this.channel=CHANNELS.has(input.channel)?input.channel:'other';
        this.direction=DIRECTIONS.has(input.direction)?input.direction:'inbound';
        this.sender=String(input.sender??'').trim();
        this.recipients=Object.freeze(strings(input.recipients));
        this.subject=String(input.subject??'').trim();
        this.body=String(input.body??'');
        this.timestamp=instant(input.timestamp);
        this.status=STATUSES.has(input.status)?input.status:(this.direction==='inbound'?'received':'sent');
        this.unread=Boolean(input.unread);
        this.attachments=Object.freeze(Array.from(input.attachments||[],item=>Object.freeze({name:String(item?.name||'Attachment'),type:String(item?.type||''),url:String(item?.url||'')})));
        Object.freeze(this);
    }
    toJSON(){return {...this,recipients:[...this.recipients],attachments:this.attachments.map(item=>({...item}))};}
}

export {CHANNELS as communicationChannels};
