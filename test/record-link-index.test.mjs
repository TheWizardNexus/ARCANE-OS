import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecordLinkIndex,parseRecordLinks} from '../arcane/modules/RecordLinkIndex.js';

test('parses filing and exhibit ids and builds directional cross-record links',()=>{
    assert.deepEqual(parseRecordLinks('Compare F0002, exhibit E0010, and f0002.'),['F0002','E0010']);
    const index=buildRecordLinkIndex([{id:'F0001',links:['F0002','E0010','X9999']},{id:'F0002',links:[]}],{validIds:['F0001','F0002','E0010']});
    assert.deepEqual(index.outbound.F0001,['F0002','E0010']);
    assert.deepEqual(index.inbound.F0002,['F0001']);
    assert.deepEqual(index.invalid.F0001,['X9999']);
    assert.equal(index.linkCount,2);
});
