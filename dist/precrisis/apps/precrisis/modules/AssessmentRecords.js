import Reports from '../entities/Reports.js';
import Score from '../entities/Score.js';

async function settleOrThrow(tasks=[]){
    const results=await Promise.allSettled(tasks);
    const failed=results.find(
        result=>result.status==='rejected'
    );

    if(failed){
        throw failed.reason;
    }

    return results.map(
        result=>result.value
    );
}

function saveScoreAndReport(type='',data={},username=''){
    const score=new Score();
    const report=new Reports();

    return settleOrThrow(
        [
            score.save(
                {
                    type:type,
                    data:data,
                    username:username
                }
            ),
            report.save(
                {
                    type:type,
                    data:data,
                    username:username
                }
            )
        ]
    );
}

export {
    saveScoreAndReport,
    settleOrThrow
};
