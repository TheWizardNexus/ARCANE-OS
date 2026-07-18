import test from 'node:test';
import assert from 'node:assert/strict';
import RecordReviewStore,{normalizeReview} from '../arcane/modules/RecordReviewStore.js';

test('record review storage normalizes and persists app-supplied review state',async()=>{
    let value={};
    const adapter={async get(){return value;},async set(next){value=structuredClone(next);}};
    const store=new RecordReviewStore({namespace:'test',adapter});
    await store.load();
    const saved=await store.set('F0001',{status:'reviewed',notes:'Compared to source.'});
    assert.equal(saved.status,'reviewed');
    assert.equal(store.get('F0001').notes,'Compared to source.');
    assert.ok(saved.updatedAt);
});

test('record review notes are bounded',()=>{
    assert.equal(normalizeReview({notes:'x'.repeat(11000)}).notes.length,10000);
});
