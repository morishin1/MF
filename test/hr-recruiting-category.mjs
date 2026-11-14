import assert from 'node:assert/strict';
import {checkRecruitingCategoryChange,RECRUITING_CATEGORY_KEYS} from '../lib/hr-recruiting-category.js';
const row={id:'fixture-applicant',stage:'applied',status:'todo',decision:null,employee_id:null,lead_category:'recruitment'};
assert.equal(checkRecruitingCategoryChange(row,'executive_employee').ok,true,'正社員を採用予定にできる');
assert.equal(checkRecruitingCategoryChange(row,'part_time').ok,true,'パート・アルバイトを採用予定にできる');
assert.equal(checkRecruitingCategoryChange(row,'trial_2weeks').ok,true,'2週間トライアルを採用予定にできる');
assert.ok(RECRUITING_CATEGORY_KEYS.includes('contractor'),'業務委託も分類可能');
for(const category of ['random',null,'','office_signed'])assert.equal(checkRecruitingCategoryChange(row,category).ok,false);
for(const blocked of [{status:'done'},{status:'accepted'},{status:'declined'},{decision:'hold'},{decision:'rejected'},{employee_id:'emp-1'},{lead_category:'mugendojo'}])
 assert.equal(checkRecruitingCategoryChange({...row,...blocked},'part_time').ok,false,'選考終了・Office移行・別受付には使わない');
for(const x of [{hasOffer:true},{hasContract:true},{hasPdfFlow:true}])
 assert.equal(checkRecruitingCategoryChange(row,'executive_employee',x).ok,false,'契約・通知が発行済みの場合には変更不可');
console.log('PASS HR recruitment category: non-binding planning; no completed hires or active offers can change');
