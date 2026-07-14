import CommunicationAppController from '../../../arcane/modules/CommunicationAppController.js';

const services=[
 {id:'gmail',label:'Gmail',description:'Gmail inbox, threads, labels, and replies through an OAuth-enabled Arcane bridge.',channels:['email'],acceptsEndpoint:true,actionLabel:'Connection help'},
 {id:'microsoft-mail',label:'Microsoft Outlook',description:'Outlook and Microsoft 365 mail through Microsoft Graph and an Arcane bridge.',channels:['email'],acceptsEndpoint:true,actionLabel:'Connection help'},
 {id:'mail-bridge',label:'Other email',description:'Connect IMAP, SMTP, Fastmail, Proton Bridge, or another account through a compatible bridge.',channels:['email'],acceptsEndpoint:true,actionLabel:'Connection help'}
];

new CommunicationAppController({appId:'mail',services,channels:['email'],labels:{settingsTitle:'Mail services',settingsDescription:'Choose the email accounts that Arcane Mail may display and use for replies.'}}).start().catch(error=>{document.querySelector('#appStatus').textContent=error.message});
