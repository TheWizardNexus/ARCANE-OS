import CommunicationAppController from '../../../arcane/modules/CommunicationAppController.js?v=4';
import InMemoryCommunicationProvider from '../../../arcane/modules/InMemoryCommunicationProvider.js?v=2';
import {assessScamRisk,scamSafetyGuidance} from '../../../arcane/modules/ScamRiskPolicy.js?v=1';

const demoProvider=()=>new InMemoryCommunicationProvider({
 id:'scamurai-demo',label:'Scamurai SMS demo',channels:['sms'],
 threads:[
  {id:'demo-bank',channel:'sms',title:'DEMO · Bank security',participants:['Sample sender'],preview:'URGENT: Your account will be closed…',updatedAt:'2026-07-18T14:01:00Z',unreadCount:1},
  {id:'demo-family',channel:'sms',title:'DEMO · Family emergency',participants:['Sample sender'],preview:'Grandma, this is your grandson…',updatedAt:'2026-07-18T13:01:00Z',unreadCount:1},
  {id:'demo-ordinary',channel:'sms',title:'DEMO · Appointment',participants:['Sample dental office'],preview:'Reminder: Your appointment is Tuesday…',updatedAt:'2026-07-18T12:01:00Z'}
 ],
 messages:{
  'demo-bank':[{id:'demo-bank-1',channel:'sms',direction:'inbound',sender:'Sample sender',body:'URGENT: Your bank account will be closed. Reply with your one-time verification code immediately.',timestamp:'2026-07-18T14:01:00Z',unread:true}],
  'demo-family':[{id:'demo-family-1',channel:'sms',direction:'inbound',sender:'Sample sender',body:'Grandma, this is your grandson. I have a family emergency. Do not tell anyone. Buy gift cards and stay on the line.',timestamp:'2026-07-18T13:01:00Z',unread:true}],
  'demo-ordinary':[{id:'demo-ordinary-1',channel:'sms',direction:'inbound',sender:'Sample dental office',body:'Reminder: Your dental appointment is Tuesday at 2 PM. Call the office number on your card if you need to reschedule.',timestamp:'2026-07-18T12:01:00Z'}]
 }
});

function inspectScamRisk(message){
 if(message.direction!=='inbound'||!['sms','mms','rcs'].includes(message.channel))return null;
 const assessment=assessScamRisk(message.body);
 if(assessment.level==='low')return null;
 return {level:assessment.level,title:`Scamurai ${assessment.level==='critical'?'critical warning':assessment.level==='high'?'high-risk warning':'caution'}`,summary:scamSafetyGuidance(assessment),signals:assessment.matches.map(match=>match.label)};
}

const services=[
 {id:'google-messages',label:'Google Messages',description:'Pair the official Messages for web experience. Unified Arcane reading and replies additionally require a local bridge.',channels:['sms','mms','rcs'],acceptsEndpoint:true,defaultEnabled:true,defaultStatus:'Pairing required',actionLabel:'Open Google Messages',externalUrl:'https://messages.google.com/web/'},
 {id:'scamurai-demo',label:'Scamurai SMS demo',description:'Clearly labeled sample SMS conversations for testing local Scamurai warnings. No network is used; replies are simulated on this device.',channels:['sms'],acceptsEndpoint:false,defaultEnabled:true,defaultStatus:'Sample data',actionLabel:'Demo is ready',simulated:true,providerFactory:demoProvider},
 {id:'twilio-messaging',label:'Twilio Messaging',description:'SMS, MMS, RCS, or WhatsApp numbers connected through a credential-safe Arcane bridge.',channels:['sms','mms','rcs','whatsapp'],acceptsEndpoint:true,actionLabel:'Connection help'},
 {id:'whatsapp-cloud',label:'WhatsApp Business',description:'WhatsApp Business Cloud API conversations connected through webhooks and an Arcane bridge.',channels:['whatsapp'],acceptsEndpoint:true,actionLabel:'Connection help'},
 {id:'messaging-bridge',label:'Other messaging service',description:'Connect another provider that implements the Arcane communications bridge contract.',channels:['sms','mms','rcs','whatsapp','other'],acceptsEndpoint:true,actionLabel:'Connection help'}
];

new CommunicationAppController({appId:'messages',services,channels:['sms','mms','rcs','whatsapp','other'],inspectMessage:inspectScamRisk,labels:{settingsTitle:'Messaging services',settingsDescription:'Choose the services that feed the unified Messages inbox and send replies.'}}).start().catch(error=>{document.querySelector('#appStatus').textContent=error.message});
