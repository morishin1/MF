// HR専用ナビ表示切替。共有hr-layout.jsのキャッシュ版を変更せず、HRの画面にだけ適用する。
// 本体の認証・権限・ユーザーメニュー処理を変えない。
(function(){
"use strict";
const init=window.HRLayout?.init;
if(typeof init!=="function")return;
window.HRLayout.init=async function(options){
  const result=await init.call(window.HRLayout,options);
  if(!result)return result;
  const nav=document.querySelector(".hr-nav");
  if(!nav)return result;
  const oldDashboard=nav.querySelector('a[href="/hr/"]');
  const applicant=nav.querySelector('a[href="/hr/applicants.html"]');
  if(!oldDashboard||!applicant)return result;
  const labelOf=(a)=>a.querySelector(".material-symbols-outlined");
  applicant.innerHTML='<span class="material-symbols-outlined">dashboard</span>ダッシュボード';
  oldDashboard.innerHTML='<span class="material-symbols-outlined">bar_chart</span>応募分析';
  nav.insertBefore(applicant,oldDashboard);
  // 応募者画面ではダッシュボードを選択中と表示。旧 /hr/ は分析ページ。
  const onAnalytics=options?.active==="dashboard";
  oldDashboard.classList.toggle("on",onAnalytics);
  applicant.classList.toggle("on",options?.active==="applicants");
  if(onAnalytics) {
    oldDashboard.setAttribute("aria-current","page");
    applicant.removeAttribute("aria-current");
  } else if(options?.active==="applicants"){
    applicant.setAttribute("aria-current","page");
    oldDashboard.removeAttribute("aria-current");
  }
  return result;
};
})();