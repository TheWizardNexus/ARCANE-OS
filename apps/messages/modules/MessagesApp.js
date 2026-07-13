import CommunicationAppController from '../../../arcane/modules/CommunicationAppController.js';

const services=[
 {id:'google-messages',label:'Google Messages',description:'Pair the official Messages for web experience. Unified Arcane reading and replies additionally require a local bridge.',channels:['sms','mms','rcs'],acceptsEndpoint:true,defaultEnabled:true,defaultStatus:'Pairing required',actionLabel:'Open Google Messages',externalUrl:'https://messages.google.com/web/'},
 {id:'twilio-messaging',label:'Twilio Messaging',description:'SMS, MMS, RCS, or WhatsApp numbers connected through a credential-safe Arcane bridge.',channels:['sms','mms','rcs','whatsapp'],acceptsEndpoint:true,actionLabel:'Connection help'},
 {id:'whatsapp-cloud',label:'WhatsApp Business',description:'WhatsApp Business Cloud API conversations connected through webhooks and an Arcane bridge.',channels:['whatsapp'],acceptsEndpoint:true,actionLabel:'Connection help'},
 {id:'messaging-bridge',label:'Other messaging service',description:'Connect another provider that implements the Arcane communications bridge contract.',channels:['sms','mms','rcs','whatsapp','other'],acceptsEndpoint:true,actionLabel:'Connection help'}
];

new CommunicationAppController({appId:'messages',services,channels:['sms','mms','rcs','whatsapp','other'],labels:{settingsTitle:'Messaging services',settingsDescription:'Choose the services that feed the unified Messages inbox and send replies.'}}).start().catch(error=>{document.querySelector('#appStatus').textContent=error.message});
