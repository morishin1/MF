// Dashboard and applicant list use the same population and filter definitions.
(function (root) {
  'use strict';
  const scopes = [
    {key:'all',label:'すべての対応'},
    {key:'scheduled',label:'面談予定'},
    {key:'evaluation',label:'評価・推薦待ち'},
    {key:'decision',label:'採用判断待ち'},
    {key:'procedures',label:'内定・引継ぎ'},
    {key:'priority',label:'優先対応'},
  ];
  const active = a => !root.HRApplicantList.isClosed(a) && a.leadCategory !== 'mugendojo';
  function matches(a, key) {
    if (key === 'scheduled') return a.status === 'interview_scheduled';
    if (key === 'evaluation') return ['eval_pending','ceo_recommend_pending'].includes(a.status);
    if (key === 'decision') return a.status === 'ceo_decision_pending';
    if (key === 'procedures') return ['offer','trial','terms','agreement','office'].includes(root.HRApplicantList.pipeline(a).stage);
    if (key === 'priority') return Boolean(a.overdue || a.priority <= 2 || matches(a,'evaluation') || matches(a,'decision') || a.status === 'todo');
    return true;
  }
  const listUrl = key => '/hr/applicants.html?scope=' + encodeURIComponent(key);
  root.HRHiringOverview = {scopes,active,matches,listUrl};
})(globalThis);
