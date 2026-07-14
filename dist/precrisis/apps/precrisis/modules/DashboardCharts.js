const chartEntries=[
    ['overall_MH','Overall Mental Health','A combined view of mental health scores across assessments, used to show the broad direction of change over time.'],
    ['immediate_intervention_required','Immediate Intervention Required','Indicates whether current safety, judgment, or functioning concerns may require prompt human review or support.'],
    ['crisis','Crisis','Tracks signs that the person may be experiencing an acute period of severe distress, danger, or impaired coping.'],
    ['crisis_prediction','Crisis Prediction','Tracks patterns that may indicate an increased likelihood of a crisis developing in the near future.'],
    ['instability','Instability','Measures rapid or significant changes in mood, behavior, judgment, relationships, or daily functioning.'],
    ['stability','Stability','Measures consistency in mood, behavior, judgment, relationships, and the ability to manage daily life.'],
    ['suicidal_ideation','Suicidal Ideation','Tracks reported or inferred thoughts about suicide or intentionally ending one’s life.'],
    ['homicidal_ideation','Homicidal Ideation','Tracks reported or inferred thoughts about killing another person.'],
    ['paraphilic_disorder','Paraphilic Disorder','Tracks indicators that atypical sexual interests may be causing distress, impairment, or risk of harm.'],
    ['substance_use_disorder','Substance Use Disorder','Tracks patterns of alcohol or drug use associated with impaired control, health effects, risk, or disrupted responsibilities.'],
    ['serve','Fitness to Serve','Measures functioning, judgment, reliability, and emotional readiness in relation to the demands of service.'],
    ['lead','Fitness to Lead','Measures judgment, reliability, emotional regulation, and decision-making in relation to leadership responsibilities.'],
    ['possible_danger_to_animals','Possible Danger to Animals','Tracks statements, intentions, or behavior that may indicate a risk of harming animals.'],
    ['possible_danger_to_others','Possible Danger to Others','Tracks statements, intentions, preparation, or behavior that may indicate a risk of harming another person.'],
    ['possible_danger_to_property','Possible Danger to Property','Tracks statements, intentions, or behavior that may indicate a risk of damaging or destroying property.'],
    ['possible_danger_to_self','Possible Danger to Self','Tracks behavior, intentions, or circumstances that may place the person at risk of self-inflicted harm.'],
    ['possible_sexual_danger_to_others','Possible Sexual Danger to Others','Tracks indicators of possible sexually coercive, exploitative, or harmful behavior toward another person.'],
    ['possible_sexual_danger_to_self','Possible Sexual Danger to Self','Tracks sexual behavior or circumstances that may expose the person to exploitation, injury, or other serious harm.'],
    ['possibly_in_danger_from_others','Possibly in Danger From Others','Tracks threats, violence, stalking, intimidation, or other signs that another person may pose a danger.'],
    ['possibly_in_sexual_danger_from_others','Possibly in Sexual Danger From Others','Tracks signs of sexual coercion, exploitation, threats, assault, or vulnerability to sexual harm from others.'],
    ['propensity_for_terroristic_activity','Propensity for Terroristic Activity','Tracks indicators of intent, preparation, or support for ideologically motivated violence or intimidation.'],
    ['propensity_to_violate_the_law','Propensity to Violate the Law','Tracks behavior, stated intent, or attitudes that may indicate an increased likelihood of unlawful conduct.'],
    ['chronic_pain','Chronic Pain','Tracks persistent or recurring pain and its effects on mood, sleep, activity, relationships, and daily functioning.'],
    ['self_confidence','Self Confidence','Measures belief in one’s abilities, judgment, worth, and capacity to handle challenges.'],
    ['PTSD','PTSD','Tracks trauma-related intrusion, avoidance, changes in mood or thinking, heightened arousal, and effects on functioning.'],
    ['anger_issues','Anger Issues','Tracks the frequency, intensity, control, expression, and consequences of anger.'],
    ['schizophrenia','Schizophrenia','Tracks schizophrenia-related indicators involving perception, thought organization, beliefs, motivation, and daily functioning.'],
    ['bipolar','Bipolar','Tracks shifts between elevated or irritable states and depressive states, including changes in energy, sleep, judgment, and functioning.'],
    ['borderline_personality_disorder','Borderline Personality Disorder','Tracks instability in emotions, self-image, relationships, abandonment sensitivity, and impulsive behavior.'],
    ['cognitive_dissonance','Cognitive Dissonance','Measures distress or tension associated with conflicting beliefs, values, decisions, or behavior.'],
    ['dissociative_disorders','Dissociative Disorders','Tracks disruptions in memory, identity, awareness, perception, or a sense of connection to oneself or surroundings.'],
    ['manic','Manic','Tracks elevated or irritable mood with increased energy, reduced need for sleep, impulsivity, or impaired judgment.'],
    ['neurocognitive_disorder','Neurocognitive Disorder','Tracks changes in memory, attention, language, perception, reasoning, or executive functioning.'],
    ['ocd','OCD','Tracks intrusive unwanted thoughts and repetitive behaviors or mental acts, including their effects on time and functioning.'],
    ['other_psychotic_disorders','Other Psychotic Disorders','Tracks hallucinations, delusional beliefs, disorganized thought, or other psychosis-related indicators outside the schizophrenia chart.'],
    ['panic_disorder','Panic Disorder','Tracks sudden episodes of intense fear or physical distress, concern about recurrence, and related avoidance.'],
    ['personality_disorder','Personality Disorder','Tracks enduring patterns of thought, emotion, behavior, or relationships that may cause distress or impaired functioning.'],
    ['phobias','Phobias','Tracks intense, persistent fear and avoidance associated with particular objects, situations, or activities.'],
    ['major_depression','Major Depression','Tracks persistent low mood, loss of interest or pleasure, related symptoms, and effects on daily functioning.'],
    ['stress','Stress','Measures perceived pressure, strain, or overload and its effects on the body, emotions, behavior, and functioning.'],
    ['anxiety','Anxiety','Tracks excessive fear, worry, physical arousal, avoidance, and interference with daily life.'],
    ['functionality','Functionality','Measures the ability to manage self-care, responsibilities, relationships, decisions, and ordinary daily activities.'],
    ['disfunctionality','Dysfunctionality','Measures difficulty carrying out self-care, responsibilities, relationships, decisions, or ordinary daily activities.'],
    ['environmental_MH_impact','Environmental Mental Health Impact','Tracks how housing, work, finances, safety, relationships, and surroundings may affect mental health.'],
    ['trauma','Trauma','Tracks the lasting emotional, behavioral, social, physical, or functional effects of harmful or life-threatening experiences.'],
    ['resilience','Resilience','Measures the ability to adapt, recover, maintain support, and continue functioning during or after adversity.'],
    ['self_sabotage','Self Sabotage','Tracks choices or recurring behaviors that interfere with the person’s goals, relationships, safety, or well-being.'],
    ['religious_trauma','Religious Trauma','Tracks distress or impaired functioning associated with harmful religious experiences, teachings, authority, or community responses.'],
    ['narcisistic_personality','Narcissistic Personality','Tracks patterns involving grandiosity, need for admiration, empathy difficulties, entitlement, and interpersonal impact.'],
    ['controlling_personality','Controlling Personality','Tracks recurring attempts to direct another person’s choices, access, relationships, behavior, or independence.'],
    ['possibly_in_danger_from_coercion','Possibly in Danger From Coercion','Tracks pressure, threats, manipulation, or dependency that may restrict the person’s ability to make free choices.'],
    ['moral_trauma','Moral Trauma','Tracks guilt, shame, anger, betrayal, or spiritual distress after events that conflict with deeply held morals or values.'],
    ['betrayal','Betrayal','Tracks distress and loss of trust following a perceived serious violation by a trusted person, group, or institution.'],
    ['possibly_in_abusive_relationship','Possibly in an Abusive Relationship','Tracks patterns of fear, coercion, control, degradation, exploitation, or harm within a close relationship.'],
    ['possibly_in_physically_abusive_relationship','Possibly in a Physically Abusive Relationship','Tracks physical force, injury, restraint, threats of violence, or fear of physical harm within a relationship.'],
    ['possibly_in_emotionally_abusive_relationship','Possibly in an Emotionally Abusive Relationship','Tracks humiliation, intimidation, manipulation, isolation, threats, or persistent attacks on emotional well-being.'],
    ['possibly_in_socially_abusive_relationship','Possibly in a Socially Abusive Relationship','Tracks control over friendships, family contact, communication, reputation, movement, or access to social support.'],
    ['possibly_in_financially_abusive_relationship','Possibly in a Financially Abusive Relationship','Tracks control, concealment, exploitation, or restriction involving money, work, property, credit, or essential resources.'],
    ['propensity_to_be_abusive','Propensity to Be Abusive','Tracks recurring attitudes, intentions, or behavior associated with controlling, exploiting, intimidating, or harming others.'],
    ['honesty','Honesty','Measures consistency, truthfulness, openness, and willingness to provide accurate information.'],
    ['dishonesty','Dishonesty','Tracks contradictions, concealment, false statements, or misrepresentation that may reduce confidence in reported information.'],
    ['propensity_to_be_deceitful','Propensity to Be Deceitful','Tracks a recurring tendency toward deliberate, strategic, or manipulative deception.'],
    ['eating_disorder','Eating Disorder','Tracks harmful patterns involving eating, weight, body image, compensatory behavior, health, or daily functioning.']
];

const dashboardCharts=Object.freeze(
    chartEntries.map(
        ([key,title,description])=>Object.freeze(
            {
                key:key,
                title:title,
                description:description,
                style:'line',
                fullWidth:key==='overall_MH',
                defaultVisible:true,
                min:0,
                max:10,
                seriesLabel:'Score',
                valueLabel:'Score',
                timeLabel:'Date',
                removable:true
            }
        )
    )
);

function getDashboardChart(key=''){
    return dashboardCharts.find(chart=>chart.key===key)||null;
}

export {
    dashboardCharts,
    getDashboardChart
};
