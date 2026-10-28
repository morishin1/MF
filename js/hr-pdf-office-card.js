// One canonical flow is displayed in both Office dashboard and join/leave views.
(async()=>{
// Match the Office page gate before requesting any HR data; finance/managers must not call HR APIs.
const me=await API.me().catch(()=>null);
if(!me||!KPLayout.hasAccess(me,'officeHr'))return;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={terms_preparing:'労働条件通知書準備中',terms_waiting:'本人確認待ち',onboarding:'入社手続中',ready:'入社準備完了',joined:'入社済み'};
API.api('/api/hr/pdf-flow?office=1').then(data=>{if(!data.enabled)return;const box=document.createElement('section');box.className='card';box.style.cssText='padding:18px;margin:16px 0;background:#fff;border:1px solid #dedfd9;border-radius:10px';box.innerHTML=`<h2 style="font-size:17px">内定承諾からの入社準備</h2><p style="font-size:12px">本人が最新版を承諾した方を表示します。社員・アカウントは自動作成しません。</p>${(data.flows||[]).map(f=>`<p><a href="/hr/pdf-flow.html?applicantId=${encodeURIComponent(f.applicantId||f.applicant_id)}">${esc(f.applicantName||f.name)} — ${esc(labels[f.phase]||f.phase)}</a></p>`).join('')||'<p>対象はありません。</p>'}`;(document.querySelector('.wrap')||document.body).prepend(box);}).catch(e=>{if(['disabled','not_found','forbidden'].includes(e.code)||[403,404].includes(e.status))return;const box=document.createElement('p');box.setAttribute('role','status');box.textContent='内定承諾の入社準備を取得できません。再読み込みするか管理者へ確認してください。';(document.querySelector('.wrap')||document.body).prepend(box);});})();
