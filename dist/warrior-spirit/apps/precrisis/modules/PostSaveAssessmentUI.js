import PostSaveAssessment from './PostSaveAssessment.js';
import showCrisisModal from './CrisisModal.js';
import waitForComponent from '../../../arcane/modules/WaitForComponent.js';

function createPostSaveAssessment(progressModal,crisisModal){
    return new PostSaveAssessment(
        {
            runTasks:async (title,jobs)=>{
                const readyModal=await waitForComponent(
                    progressModal,
                    {
                        methods:['runTasks'],
                        property:'ready',
                        event:'modal-ready'
                    }
                );

                return readyModal.runTasks(title,jobs);
            },
            beforeCrisis:()=>progressModal.close?.(undefined,true),
            onCrisis:params=>showCrisisModal(crisisModal,params)
        }
    );
}

export default createPostSaveAssessment;
