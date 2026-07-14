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

            script.src=new URL('./uPlot.iife.min.js',import.meta.url).href;
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
