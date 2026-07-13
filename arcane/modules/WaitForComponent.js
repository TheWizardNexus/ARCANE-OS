function waitForComponent(element,options={}){
    const {
        methods=[],
        property='',
        event=''
    }=options;

    return new Promise(
        function waitForComponentPromise(resolve,reject){
            function cleanup(){
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
                    return true;
                }
                return false;
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
            }else if(!isReady()){
                reject(new Error('A component readiness event is required.'));
                return;
            }

            check();
        }
    );
}

export default waitForComponent;
