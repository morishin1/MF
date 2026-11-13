import test from 'node:test';
import assert from 'node:assert/strict';
import {meetingStepDetails} from '../lib/sales-meeting-step-details.js';

test('meeting step 1 details are stored as bounded, allowlisted answers',()=>{
 const value=meetingStepDetails({
  materialUrl:'https://example.com/deck',dispatchPermit:'yes',
  contactMethods:['email','line'],commercialFlow:'end_direct',supportFee:'needs_review',
 });
 assert.deepEqual(value,{materialUrl:'https://example.com/deck',dispatchPermit:'yes',
  contactMethods:['email','line'],commercialFlow:'end_direct',supportFee:'needs_review'});
});
test('meeting step 1 rejects unsafe urls and unknown choice values',()=>{
 assert.equal(meetingStepDetails({materialUrl:'javascript:alert(1)'}),null);
 assert.equal(meetingStepDetails({materialUrl:'https://user:pass@example.com'}),null);
 assert.equal(meetingStepDetails({supportFee:'approved'}),null);
 assert.equal(meetingStepDetails({contactMethods:['email','email']}),null);
});

