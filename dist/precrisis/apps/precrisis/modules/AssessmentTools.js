function tool(name='',description='',properties={},required=[]){
    return Object.freeze(
        {
            type:'function',
            function:{
                name:name,
                description:description,
                parameters:{
                    type:'object',
                    properties:properties,
                    required:required
                }
            }
        }
    );
}

function number(description=''){
    return {
        type:'number',
        description:description
    };
}

function string(description=''){
    return {
        type:'string',
        description:description
    };
}

const textAssessmentTool=tool(
    'text_assessment',
    'Assess the users mental health according to the DSM5 and various disorders, especially those concerning veterans, military personnel, government employees or contractors.',
    {
        mental_health_assessment:string('The assessment of the users mental health for a clinician, leader, or member of the support network to consider.'),
        treatment_options:string('Potential treatment options which may benefit the user based on their symptoms.'),
        topics_of_discussion_or_activities:string('Topics of discussion or activities which may benefit the user with their support network, like ice breakers for people who want to help.')
    },
    [
        'mental_health_assessment',
        'treatment_options',
        'topics_of_discussion_or_activities'
    ]
);

const fitnessForServiceTool=tool(
    'fitness_for_service',
    'Determine if an individual is fit to serve or lead others in the military or government.',
    {
        serve:number('0-10 likelihood the individual is fit to serve'),
        lead:number('0-10 likelihood the individual is fit to lead or be responsible for others')
    },
    ['serve','lead']
);

const crisisDetectionTool=tool(
    'crisis_detection',
    'Called immediately when the possibility of mental health crisis has been detected or may be actively developing.',
    {
        crisis:number('0-10 likelihood the individual is in crisis now'),
        crisis_prediction:number('0-10 likelihood the individual will go into crisis if this conversation continues'),
        immediate_intervention_required:number('0-10 likelihood the individual requires immediate intervention')
    },
    [
        'crisis',
        'crisis_prediction',
        'immediate_intervention_required'
    ]
);

const possibleRisksProperties={
    possible_danger_to_others:number('0-10 likelihood and severity the user poses a danger to others'),
    possibly_in_danger_from_others:number('0-10 likelihood and severity the user is in danger from others'),
    possible_danger_to_self:number('0-10 likelihood and severity the user is a danger to themselves'),
    possible_danger_to_property:number('0-10 likelihood and severity the user is a danger to property'),
    possible_danger_to_animals:number('0-10 likelihood and severity the user is a danger to animals'),
    possible_sexual_danger_to_others:number('0-10 likelihood and severity the user is a sexual danger to others'),
    possibly_in_sexual_danger_from_others:number('0-10 likelihood and severity the user is possibly in sexual danger from others'),
    possible_sexual_danger_to_self:number('0-10 likelihood and severity the user is a sexual danger to themselves'),
    possibly_in_danger_from_coercion:number('0-10 likelihood and severity the user is in danger of being coerced in a negative or dangerous way'),
    propensity_for_terroristic_activity:number('0-10 likelihood and severity the user may engage in possible terrorist activity'),
    propensity_to_violate_the_law:number('0-10 likelihood and severity for the users propensity to violate the law'),
    propensity_to_be_deceitful:number('0-10 likelihood and severity for the users propensity to be deceitful')
};

const possibleRisksTool=tool(
    'possible_risks',
    'Assess the possible or imminent risks to self, others, property, or animals.',
    possibleRisksProperties,
    Object.keys(possibleRisksProperties)
);

const relationshipRisksProperties={
    possibly_in_abusive_relationship:number('0-10 likelihood the user is in an abusive relationship'),
    possibly_in_emotionally_abusive_relationship:number('0-10 likelihood the user is in an emotionally abusive relationship'),
    possibly_in_socially_abusive_relationship:number('0-10 likelihood the user is in a socially abusive relationship'),
    possibly_in_physically_abusive_relationship:number('0-10 likelihood the user is in a physically abusive relationship'),
    possibly_in_financially_abusive_relationship:number('0-10 likelihood the user is in a financially abusive relationship'),
    propensity_to_be_abusive:number('0-10 propensity to be abusive')
};

const relationshipRisksTool=tool(
    'possible_risks_relationship',
    'Assess the possible or imminent relationship risks surrounding abuse including financial, emotional, social and physical.',
    relationshipRisksProperties,
    Object.keys(relationshipRisksProperties)
);

const assessmentProperties={
    major_depression:number('0-10 likelihood and severity the user suffers from major depressive disorder'),
    stress:number('0-10 likelihood and severity the user suffers from stress'),
    anxiety:number('0-10 likelihood and severity the user suffers from an anxiety disorder'),
    functionality:number('0-10 likelihood the user has good functionality'),
    disfunctionality:number('0-10 likelihood and severity the user suffers from disfunctionality'),
    environmental_MH_impact:number('0-10 likelihood and severity of negative impact from the users environment on their mental health'),
    trauma:number('0-10 likelihood and severity the user suffers from trauma'),
    resilience:number('0-10 users resilience in the face of mental health, daily life issues, and stress'),
    self_sabotage:number('0-10 likelihood and severity the user self sabotages'),
    self_confidence:number('0-10 likelihood the user has high self confidence'),
    religious_trauma:number('0-10 likelihood and severity the user suffers from religious trauma'),
    controlling_personality:number('0-10 likelihood and severity the user suffers from a controlling personality'),
    narcisistic_personality:number('0-10 likelihood and severity the user suffers from a narcissistic personality'),
    stability:number('0-10 user stability'),
    instability:number('0-10 user instability'),
    suicidal_ideation:number('0-10 likelihood and severity the user has suicidal ideation'),
    homicidal_ideation:number('0-10 likelihood and severity the user has homicidal ideation'),
    anger_issues:number('0-10 likelihood and severity the user has anger issues'),
    chronic_pain:number('0-10 likelihood and severity the user suffers from chronic pain'),
    PTSD:number('0-10 likelihood and severity the user suffers from PTSD'),
    panic_disorder:number('0-10 likelihood and severity the user suffers from panic disorder'),
    substance_use_disorder:number('0-10 likelihood and severity the user suffers from substance use disorder'),
    dissociative_disorders:number('0-10 likelihood and severity the user suffers from dissociative disorders'),
    borderline_personality_disorder:number('0-10 likelihood and severity the user suffers from borderline personality disorder'),
    neurocognitive_disorder:number('0-10 likelihood and severity the user suffers from a neurocognitive disorder'),
    personality_disorder:number('0-10 likelihood and severity the user suffers from a personality disorder'),
    eating_disorder:number('0-10 likelihood and severity the user suffers from an eating disorder'),
    schizophrenia:number('0-10 likelihood and severity the user suffers from schizophrenia'),
    manic:number('0-10 likelihood and severity the user experiences manic states'),
    bipolar:number('0-10 likelihood and severity the user suffers from bipolar disorder'),
    cognitive_dissonance:number('0-10 likelihood and severity the user has cognitive dissonance'),
    ocd:number('0-10 likelihood and severity the user suffers from obsessive-compulsive disorder'),
    phobias:number('0-10 likelihood and severity the user suffers from one or more phobias'),
    paraphilic_disorder:number('0-10 likelihood and severity the user suffers from a paraphilic disorder'),
    other_psychotic_disorders:number('0-10 likelihood and severity the user suffers from other psychotic disorders'),
    honesty:number('0-10 likelihood the user is honest'),
    dishonesty:number('0-10 likelihood and severity the user is dishonest'),
    moral_trauma:number('0-10 likelihood and severity the user suffers from moral trauma'),
    betrayal:number('0-10 likelihood and severity the user suffers betrayal')
};

const assessmentCompleteTool=tool(
    'assessment_complete',
    'Analyze the mental health assessment according to DSM-5 criteria and cultural nuances or references.',
    assessmentProperties,
    Object.keys(assessmentProperties)
);

export {
    assessmentCompleteTool,
    crisisDetectionTool,
    fitnessForServiceTool,
    possibleRisksTool,
    relationshipRisksTool,
    textAssessmentTool
};
