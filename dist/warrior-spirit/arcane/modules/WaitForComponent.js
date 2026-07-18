function waitForComponent(element,options={}){
    const {
        errorEvent='',
        methods=[],
        property='',
        event='',
        timeoutMs=0
    }=options;

    if(!Number.isFinite(timeoutMs)||timeoutMs<0||timeoutMs>60000){
        return Promise.reject(new RangeError('timeoutMs must be between 0 and 60000.'));
    }

    return new Promise(
        function waitForComponentPromise(resolve,reject){
            let timeout=null;

            function cleanup(){
                if(element&&event){
                    element.removeEventListener(event,eventHandler);
                }
                if(element&&errorEvent){
                    element.removeEventListener(errorEvent,errorHandler);
                }
                if(timeout!==null){
                    clearTimeout(timeout);
                    timeout=null;
                }
            }

            function isReady(){
                if(property&&element[property]!==true){
                    return false;
                }

                return methods.every(
                    method=>typeof element[method]==='function'
                );
            }

            function complete(){
                cleanup();
                resolve(element);
            }

            function fail(error){
                cleanup();
                reject(error);
            }

            function check(){
                if(isReady()){
                    complete();
                    return true;
                }
                return false;
            }

            function eventHandler(){
                if(isReady()){
                    complete();
                }
            }

            function errorHandler(errorEventObject){
                const error=new Error(
                    errorEventObject?.detail?.message
                    ||'The component reported a loading error.'
                );
                error.code=errorEventObject?.detail?.code||'COMPONENT_READY_FAILED';
                fail(error);
            }

            if(!element){
                fail(new Error('Component element is required.'));
                return;
            }

            if(event){
                element.addEventListener(event,eventHandler);
            }else if(!isReady()){
                fail(new Error('A component readiness event is required.'));
                return;
            }

            if(errorEvent){
                element.addEventListener(errorEvent,errorHandler);
            }
            if(timeoutMs>0){
                timeout=setTimeout(()=>{
                    const error=new Error(`Component readiness timed out after ${timeoutMs} ms.`);
                    error.code='COMPONENT_READY_TIMEOUT';
                    fail(error);
                },timeoutMs);
            }

            check();
        }
    );
}

export default waitForComponent;
