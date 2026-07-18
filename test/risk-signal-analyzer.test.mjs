import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeRiskSignals} from '../arcane/modules/RiskSignalAnalyzer.js';
import {assessScamText} from '../apps/scamurai/modules/ScamuraiPolicy.js';
import {scamuraiDemoScenarios} from '../apps/scamurai/modules/ScamuraiDemo.js';

test('risk analyzer reports configured matches without retaining input',()=>{
    const result=analyzeRiskSignals('please act now',{signals:[{id:'pressure',label:'Pressure',weight:20,pattern:/act now/i}]});
    assert.equal(result.score,20);
    assert.equal(result.level,'caution');
    assert.deepEqual(result.matches.map(match=>match.id),['pressure']);
    assert.equal('text' in result,false);
});

test('Scamurai raises high risk for payment and security-code pressure',()=>{
    const result=assessScamText('Buy a gift card immediately and tell me the verification code.');
    assert.equal(result.level,'critical');
    assert(result.matches.some(match=>match.id==='payment'));
    assert(result.matches.some(match=>match.id==='credential'));
});

test('analysis is bounded and reports truncation',()=>{
    const result=analyzeRiskSignals('x'.repeat(50),{maxLength:10});
    assert.equal(result.textLength,10);
    assert.equal(result.truncated,true);
});

test('demo SMS scenarios exercise critical, caution, and low-risk outcomes',()=>{
    const levels=Object.fromEntries(scamuraiDemoScenarios.map(scenario=>[scenario.id,assessScamText(scenario.text).level]));
    assert.equal(levels['bank-code'],'critical');
    assert.equal(levels['family-gift-card'],'critical');
    assert.equal(levels['delivery-link'],'caution');
    assert.equal(levels.ordinary,'low');
});
