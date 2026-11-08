import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudDemandHintSkills} from '../lib/sales-company-cloud-hints.js';
const NOW=Date.parse('2026-11-08T00:00:00Z'),URL='https://example.com/recruit';
const source={url:URL,source_kind:'official_site',checked_at:'2026-11-07T10:00:00Z'};
const base=(over={})=>({
 status:'completed',processed_at:'2026-11-07T10:00:00Z',sources:[source],
 match_signals:{demand_hypotheses:[{role:'Web',skills:['Java','AWS'],status:'hypothesis',source_url:URL,checked_at:source.checked_at}]},
 ...over
});
const normalize=skills=>skills.map(s=>String(s).trim()).filter(Boolean);
test('official source-backed cloud skills are provisional search terms',()=>{
 assert.deepEqual(cloudDemandHintSkills(base(),normalize,NOW),['Java','AWS']);
});
test('unverified or absent official source cannot drive matching',()=>{
 assert.deepEqual(cloudDemandHintSkills(base({sources:[]}),normalize,NOW),[]);
 assert.deepEqual(cloudDemandHintSkills(base({sources:[{url:URL,source_kind:'internal'}]}),normalize,NOW),[]);
 assert.deepEqual(cloudDemandHintSkills(base({status:'failed'}),normalize,NOW),[]);
});
test('rejects hallucinated, HTTP and stale evidence',()=>{
 assert.deepEqual(cloudDemandHintSkills(base({match_signals:{demand_hypotheses:[{skills:['AWS'],status:'hypothesis',source_url:'https://evil.example/',checked_at:source.checked_at}]} }),normalize,NOW),[]);
 assert.deepEqual(cloudDemandHintSkills(base({match_signals:{demand_hypotheses:[{skills:['AWS'],status:'hypothesis',source_url:'http://example.com/recruit',checked_at:source.checked_at}]} }),normalize,NOW),[]);
 assert.deepEqual(cloudDemandHintSkills(base({processed_at:'2026-01-01T00:00:00Z'}),normalize,NOW),[]);
 assert.deepEqual(cloudDemandHintSkills(base({match_signals:{demand_hypotheses:[{skills:['AWS'],status:'hypothesis',source_url:URL,checked_at:'not a date'}]}}),normalize,NOW),[]);
});
test('never treats approved status or arbitrary text as a hypothesis',()=>{
 assert.deepEqual(cloudDemandHintSkills(base({match_signals:{demand_hypotheses:[{skills:['AWS'],status:'verified',source_url:URL,checked_at:source.checked_at}]}}),normalize,NOW),[]);
});
test('caps unique search hints at four',()=>{
 const many=base({match_signals:{demand_hypotheses:[{status:'hypothesis',source_url:URL,checked_at:source.checked_at,skills:['A','B','C','D','E','F']}]}});
 assert.deepEqual(cloudDemandHintSkills(many,normalize,NOW),['A','B','C','D']);
});