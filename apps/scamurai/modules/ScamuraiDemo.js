export const scamuraiDemoScenarios=Object.freeze([
    Object.freeze({id:'bank-code',label:'Fake bank security alert',source:'Google Messages demo',text:'URGENT: Your bank account will be closed. Reply with your one-time verification code immediately.'}),
    Object.freeze({id:'family-gift-card',label:'Grandchild gift-card emergency',source:'Google Messages demo',text:'Grandma, this is your grandson. I have a family emergency. Do not tell anyone. Buy gift cards and stay on the line.'}),
    Object.freeze({id:'delivery-link',label:'Unexpected delivery link',source:'Google Messages demo',text:'Your delivery is waiting. Act now and click the link to update your payment.'}),
    Object.freeze({id:'ordinary',label:'Ordinary appointment reminder',source:'Google Messages demo',text:'Reminder: Your dental appointment is Tuesday at 2 PM. Call the office number on your card if you need to reschedule.'}),
]);

export function getScamuraiDemoScenario(id){return scamuraiDemoScenarios.find(item=>item.id===String(id))||scamuraiDemoScenarios[0];}
