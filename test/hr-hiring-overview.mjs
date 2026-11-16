import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const ctx=vm.createContext({URL});
for(const f of ['js/hr-applicant-list.js','js/hr-hiring-overview.js'])vm.runInContext(readFileSync(f,'utf8'),ctx);
const H=ctx.HRHiringOverview;
const people=[
 {id:'new',status:'todo',stage:'applied'},
 {id:'meeting',status:'interview_scheduled',stage:'casual_interview'},
 {id:'eval',status:'eval_pending',stage:'casual_interview'},
 {id:'decide',status:'ceo_decision_pending',stage:'ceo_interview'},
 {id:'setup',status:'ceo_interview_pending',stage:'ceo_interview'},
 {id:'trial',status:'todo',stage:'applied',currentTrial:{status:'active'}},
 {id:'terms',status:'accepted',pdfFlow:{phase:'terms_preparing',acceptedAt:'today'}},
 {id:'withdrawn',status:'todo',pdfFlow:{phase:'declined'}},
 {id:'cancelled',status:'todo',pdfFlow:{phase:'cancelled'}},
 {id:'done',status:'done'},
 {id:'lead',status:'todo',leadCategory:'mugendojo'},
];
const live=people.filter(H.active);
assert.equal(live.length,7);
const ids=key=>live.filter(a=>H.matches(a,key)).map(a=>a.id);
assert.deepEqual(ids('scheduled'),['meeting']);
assert.deepEqual(ids('evaluation'),['eval']);
assert.deepEqual(ids('decision'),['decide'],'meeting scheduling is not a hiring decision');
assert.deepEqual(ids('procedures'),['trial','terms'],'recorded trial and PDF phase override old status');
assert.deepEqual(ids('priority'),['new','eval','decide','trial']);
assert.equal(H.listUrl('decision'),'/hr/applicants.html?scope=decision');
assert.equal(ids('all').length,live.length);
// Use Git's ignore matcher to reproduce the Vercel packaging regression.
const dir=mkdtempSync(join(tmpdir(),'hr-ignore-'));
try{
 execFileSync('git',['init','--quiet',dir]);
 writeFileSync(join(dir,'.gitignore'),readFileSync('.vercelignore'));
 mkdirSync(join(dir,'hr'));writeFileSync(join(dir,'dashboard.html'),'demo');writeFileSync(join(dir,'hr/dashboard.html'),'HR');
 const excluded=execFileSync('git',['-C',dir,'check-ignore','dashboard.html','hr/dashboard.html'],{encoding:'utf8'}).trim().split('\n');
 assert.deepEqual(excluded,['dashboard.html'],'HR dashboard must ship; root demo must stay excluded');
}finally{rmSync(dir,{recursive:true,force:true});}
console.log('HR dashboard population, scope links, trial/PDF state and deployment packaging PASS');
