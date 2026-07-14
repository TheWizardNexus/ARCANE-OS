class AssessmentReportRunner{
    #active=Promise.resolve([]);
    #pendingCrisis=null;
    #running=false;
    #runTasks=null;
    #onStart=null;
    #beforeCrisis=null;

    constructor(options={}){
        this.#runTasks=options.runTasks;
        this.#onStart=options.onStart;
        this.#beforeCrisis=options.beforeCrisis;
    }

    get running(){
        return this.#running;
    }

    run(title='Stand By While Reports Are Generated',jobs=[]){
        if(this.#running){
            return this.#active;
        }

        const tasks=jobs.filter(
            job=>job&&typeof job.name==='string'&&typeof job.task==='function'
        );

        if(!tasks.length){
            return Promise.resolve([]);
        }

        this.#running=true;
        this.#active=Promise.resolve()
            .then(
                ()=>{
                    if(typeof this.#onStart==='function'){
                        return this.#onStart();
                    }
                }
            )
            .then(
                ()=>typeof this.#runTasks==='function'
                    ?this.#runTasks(title,tasks)
                    :Promise.allSettled(tasks.map(job=>job.task()))
            );

        this.#active=this.#active.finally(
            async ()=>{
                const showCrisis=this.#pendingCrisis;
                this.#pendingCrisis=null;

                try{
                    if(typeof showCrisis==='function'){
                        if(typeof this.#beforeCrisis==='function'){
                            await this.#beforeCrisis();
                        }

                        await showCrisis();
                    }
                }finally{
                    this.#running=false;
                }
            }
        );

        return this.#active;
    }

    showOrQueueCrisis(showCrisis){
        if(typeof showCrisis!=='function'){
            return false;
        }

        if(this.#running){
            this.#pendingCrisis=showCrisis;
            return false;
        }

        showCrisis();
        return true;
    }
}

export default AssessmentReportRunner;
