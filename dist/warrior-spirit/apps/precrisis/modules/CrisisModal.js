import waitForComponent from '../../../arcane/modules/WaitForComponent.js';

async function showCrisisModal(modal,params={}){
    const crisis=Number(params.crisis)||0;
    const prediction=Number(params.crisis_prediction)||0;
    const intervention=Number(params.immediate_intervention_required)||0;

    if(crisis<=6&&prediction<=7&&intervention<=6){
        return false;
    }

    const readyModal=await waitForComponent(
        modal,
        {
            methods:['populate','open'],
            property:'ready',
            event:'modal-ready'
        }
    );
    const content=document.createElement('section');
    const heading=document.createElement('h1');
    const message=document.createElement('p');
    const hotline=document.createElement('button');

    if(crisis>8||intervention>7){
        heading.innerText="We're Here for You";
        message.innerText='Your entry indicates that you may need immediate support. Please consider speaking with someone now.';
    }else{
        heading.innerText='You May Want to Reach Out for Help';
        message.innerText='Your entry indicates elevated risk. Consider contacting someone you trust or speaking with a crisis counselor.';
    }

    hotline.type='button';
    hotline.innerText='Speak to Someone Now (988)';
    hotline.addEventListener(
        'click',
        ()=>window.location.href='tel:988'
    );

    content.append(heading,message,hotline);
    await readyModal.populate(content,false);
    readyModal.open();

    return true;
}

export default showCrisisModal;
