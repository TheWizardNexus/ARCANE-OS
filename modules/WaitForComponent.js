function waitForComponent(element,options={}){
    const {
        methods=[],
        property='',
        event='',
        retries=100,
        interval=50
    }=options;

    return new Promise(
        function waitForComponentPromise(resolve,reject){
            let checks=0;
            let timer;

            function cleanup(){
                if(timer){
                    clearTimeout(timer);
                }

                if(event){
                    element.removeEventListener(event,eventHandler);
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

            function check(){
                if(isReady()){
                    complete();
                    return;
                }

                checks++;

                if(checks>retries){
                    cleanup();
                    reject(new Error('Component did not become ready.'));
                    return;
                }

                timer=setTimeout(check,interval);
            }

            function eventHandler(){
                if(isReady()){
                    complete();
                }
            }

            if(!element){
                reject(new Error('Component element is required.'));
                return;
            }

            if(event){
                element.addEventListener(event,eventHandler);
            }

            check();
        }
    );
}

export default waitForComponent;
