let libraryPromise=null;

function loadChartLibrary(){
    if(window.uPlot){
        return Promise.resolve(window.uPlot);
    }

    if(libraryPromise){
        return libraryPromise;
    }

    libraryPromise=new Promise(
        function loadChartLibraryPromise(resolve,reject){
            const script=document.createElement('script');

            script.src='./modules/uPlot.iife.min.js';
            script.addEventListener(
                'load',
                ()=>window.uPlot
                    ?resolve(window.uPlot)
                    :reject(new Error('uPlot did not initialize'))
            );
            script.addEventListener(
                'error',
                ()=>reject(new Error('Unable to load the chart library'))
            );

            document.head.append(script);
        }
    );

    return libraryPromise;
}

export default loadChartLibrary;
