import runAsyncBoundary from '../../arcane/modules/AsyncBoundary.js';

const scenario=document.querySelector('#scenario');
const runButton=document.querySelector('#run');
const cancelButton=document.querySelector('#cancel');
const status=document.querySelector('#status');
let callerController=null;

function syntheticTask(signal,durationMs){
    return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{
            signal.removeEventListener('abort',onAbort);
            resolve(`Completed after ${durationMs} ms.`);
        },durationMs);
        function onAbort(){
            clearTimeout(timer);
            reject(signal.reason);
        }
        signal.addEventListener('abort',onAbort,{once:true});
    });
}

runButton.addEventListener('click',async()=>{
    callerController=new AbortController();
    const durationMs=scenario.value==='complete'?100:1000;
    runButton.disabled=true;
    cancelButton.disabled=false;
    scenario.disabled=true;
    status.textContent='Task running.';

    try{
        const result=await runAsyncBoundary(
            signal=>syntheticTask(signal,durationMs),
            {signal:callerController.signal,timeoutMs:300}
        );
        status.textContent=result;
    }catch(error){
        status.textContent=error.code==='ASYNC_BOUNDARY_TIMEOUT'
            ?'The task reached its 300 ms timeout and stopped.'
            :error.code==='ASYNC_BOUNDARY_ABORTED'
                ?'The task was cancelled and stopped.'
                :`The task failed: ${error.message}`;
    }finally{
        callerController=null;
        runButton.disabled=false;
        cancelButton.disabled=true;
        scenario.disabled=false;
    }
});

cancelButton.addEventListener('click',()=>{
    callerController?.abort(new Error('Cancelled from the example.'));
});
