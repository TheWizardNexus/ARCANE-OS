import CommunicationMessage from '../entities/CommunicationMessage.js';
import CommunicationThread from '../entities/CommunicationThread.js';

export default class InMemoryCommunicationProvider{
    constructor({id='demo-provider',label='Demo provider',channels=['other'],threads=[],messages={}}={}){
        this.id=String(id);this.label=String(label);this.channels=Object.freeze(Array.from(channels,String));
        this.threadRecords=Array.from(threads,value=>value instanceof CommunicationThread?value:new CommunicationThread({...value,providerId:this.id}));
        this.messageRecords=new Map(Object.entries(messages).map(([threadId,values])=>[threadId,Array.from(values,item=>item instanceof CommunicationMessage?item:new CommunicationMessage({...item,threadId,providerId:this.id}))]));
        this.sequence=0;
    }
    async listThreads(){return this.threadRecords.map(thread=>new CommunicationThread(thread.toJSON()));}
    async getMessages(threadId){return Array.from(this.messageRecords.get(String(threadId))||[],message=>new CommunicationMessage(message.toJSON()));}
    async send({threadId,channel='other',body,recipients=[]}={}){const id=`demo-outbound-${++this.sequence}`,records=this.messageRecords.get(String(threadId))||[],latest=records.reduce((value,item)=>Math.max(value,new Date(item.timestamp).valueOf()),0),timestamp=new Date(Math.max(Date.now(),latest+1)).toISOString(),message=new CommunicationMessage({id,threadId,providerId:this.id,channel,direction:'outbound',body,recipients,timestamp,status:'sent'});records.push(message);this.messageRecords.set(String(threadId),records);return new CommunicationMessage(message.toJSON());}
}
