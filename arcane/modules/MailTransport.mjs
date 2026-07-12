export async function sendMailReport({
    appKey,
    appName,
    endpoint,
    fetchImpl=globalThis.fetch,
    report,
    reportKey,
    requestTimeout=300_000,
}){
    if(typeof fetchImpl!=='function'){
        throw new Error('Mail transport is unavailable');
    }

    const controller=new AbortController();
    const timeout=setTimeout(
        () => controller.abort(new Error('Mail request timed out')),
        requestTimeout
    );

    try{
        const response=await fetchImpl(
            endpoint,
            {
                method:'POST',
                headers:{
                    'Content-Type':'application/json',
                    'Idempotency-Key':reportKey,
                    'X-Mail-App':appName,
                    'X-Mail-Key':appKey,
                },
                body:JSON.stringify(report),
                signal:controller.signal,
            }
        );

        const responseText=await response.text();
        let responseBody={};
        if(responseText){
            try{
                responseBody=JSON.parse(responseText);
            }catch{
                responseBody={};
            }
        }

        if(!response.ok){
            throw new Error(`Mail server rejected the request (${response.status})`);
        }

        return {
            requestId:responseBody.requestId,
            sent:true,
            status:responseBody.status || 'accepted',
            statusCode:response.status,
        };
    }finally{
        clearTimeout(timeout);
    }
}
