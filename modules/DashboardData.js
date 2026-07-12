import {dashboardCharts} from './DashboardCharts.js';

const dashboardNoteKeys=Object.freeze(
    [
        'mental_health_assessment',
        'topics_of_discussion_or_activities',
        'treatment_options'
    ]
);
const dashboardChartKeys=new Set(
    dashboardCharts.map(chart=>chart.key)
);

function collectDashboardChartData(records=[],selectedUser=''){
    const data=new Map();
    const overall=new Map();

    for(let i=0;i<records.length;i++){
        const score=records[i];

        if(!score||typeof score!=='object'){
            continue;
        }

        if(selectedUser&&`${score.username}`!==selectedUser){
            continue;
        }

        if(!score.data||typeof score.data!=='object'||Array.isArray(score.data)){
            continue;
        }

        const date=Number(score.date);

        if(!Number.isFinite(date)){
            continue;
        }

        const keys=Object.keys(score.data);

        for(let j=0;j<keys.length;j++){
            const key=keys[j];
            const value=score.data[key];

            if(typeof value!=='number'){
                continue;
            }

            if(dashboardChartKeys.has(key)&&key!=='overall_MH'){
                if(!data.has(key)){
                    data.set(key,[]);
                }

                data.get(key).push([date,value]);
            }

            if(!dashboardNoteKeys.includes(key)&&key!=='stability'){
                const combined=overall.get(date)||[0,0];
                combined[0]+=value;
                combined[1]++;
                overall.set(date,combined);
            }
        }
    }

    data.set(
        'overall_MH',
        Array.from(overall.entries()).map(
            ([date,values])=>[date,10-values[0]/values[1]]
        )
    );

    return data;
}

export {
    collectDashboardChartData,
    dashboardNoteKeys
};
