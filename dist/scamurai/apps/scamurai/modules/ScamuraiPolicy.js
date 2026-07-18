import {analyzeRiskSignals} from '../../../arcane/modules/RiskSignalAnalyzer.js';

export const scamSignals=Object.freeze([
    {id:'urgency',label:'Urgency or secrecy pressure',weight:18,pattern:/\b(urgent|immediately|act now|do not tell|keep (?:this|it) secret|stay on the line)\b/i,guidance:'Pause. A legitimate organization will let you verify independently.'},
    {id:'payment',label:'Unusual payment request',weight:32,pattern:/\b(gift card|bitcoin|crypto(?:currency)?|wire transfer|cash courier|payment app|prepaid card)\b/i,guidance:'Do not pay. Contact the organization using a trusted number.'},
    {id:'credential',label:'Credential or access request',weight:35,pattern:/\b(password|passcode|verification code|one[- ]time code|otp|remote access|screen share)\b/i,guidance:'Never share security codes or grant remote access to an unexpected contact.'},
    {id:'impersonation',label:'Authority or family impersonation',weight:24,pattern:/\b(irs|social security|medicare|police|sheriff|grandson|granddaughter|family emergency|tech support)\b/i,guidance:'End the contact and verify through an independently found official channel.'},
    {id:'threat',label:'Threat or fear tactic',weight:28,pattern:/\b(arrest|warrant|deport|account (?:will be )?closed|service (?:will be )?cut off|in danger|kidnapped)\b/i,guidance:'Threats are designed to prevent careful checking. Stop and contact someone you trust.'},
    {id:'prize',label:'Unexpected prize or refund',weight:20,pattern:/\b(lottery|sweepstakes|prize|inheritance|refund|you(?: have|'ve) won)\b/i,guidance:'Do not pay a fee or disclose information to receive an unexpected benefit.'},
]);

export function assessScamText(text){
    return analyzeRiskSignals(text,{signals:scamSignals});
}

export function guidanceFor(result){
    if(result.level==='critical'||result.level==='high')return 'Stop contact. Do not send money, codes, or personal information. Verify independently and ask a trusted person for help.';
    if(result.level==='caution')return 'Pause and verify the sender using contact information you already trust.';
    return 'No strong warning signs were detected, but automated checks can miss scams. Stay cautious.';
}
