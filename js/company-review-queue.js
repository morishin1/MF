const root=document.getElementById('company-review-queue');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={alert_owner:'5件以上・面談到達0：担当確認',review_proposal_hold:'10件以上・面談到達0：一時保留の審査',review_blast_only:'15件以上・面談到達0：ブラスト移行の審査',confirm_loss_reasons:'見送り理由を確認',review_improvement:'面談到達の改善：再審査'};
let page=0,version=0;
async function load(next=0){const generation=++version;root.textContent='企業審査の確認事項を読込中…';try{
 const data=await window.API.api(`/api/sales/company-evaluations/review-tasks?page=${next}`);if(generation!==version)return;page=data.page;
 root.innerHTML=`<h3>企業審査の確認事項${data.scope==='assigned'?'（自分の担当）':''}</h3><p>確認・審査の候補です。返答待ちを未対応と断定せず、実停止・通知・配信は自動実行しません。${data.linkEnabled?'':'連携は有効化待ちです。'}</p>
 <div style="overflow-x:auto"><table class="sl-table"><thead><tr><th>企業</th><th>確認事項</th><th>担当・期限</th><th>最終集計</th></tr></thead><tbody>${data.items.map(row=>`<tr><td>${row.company_id ? `<a href="/sales/companies.html?id=${encodeURIComponent(row.company_id)}">${esc(row.companyName)}</a>` : esc(row.companyName)}</td><td>${esc(labels[row.kind]||row.kind)}<br>提案${esc(row.counts?.sentCount)}／面談到達${esc(row.counts?.meetingCount)}／返答待ち等${esc(Math.max(0,(row.counts?.sentCount||0)-(row.counts?.qualifiedCount||0)))}</td><td>${row.assignmentKnown?'企業の担当者に割当済み':'担当未設定・管理者の確認が必要'}<br>${row.deadlineKnown?esc(row.due_at):'期限未設定'}</td><td>${esc(row.last_seen)}${Date.now()-Date.parse(row.last_seen)>86400000?'（24時間以上前・再確認が必要）':''}</td></tr>`).join('')||'<tr><td colspan="4">取得範囲に保存された確認事項はありません。集計の未実施・未取得を確認事項ゼロとは断定しません。</td></tr>'}</tbody></table></div>
 <button type="button" data-page="${page-1}" ${page===0?'disabled':''}>前へ</button> <span>${page+1}ページ</span> <button type="button" data-page="${page+1}" ${data.hasMore?'':'disabled'}>次へ</button>`;
 }catch(e){if(generation===version)root.textContent=e.hint || '企業審査の確認事項は未取得です。保存基盤・権限を確認してください。';}}
root?.addEventListener('click',event=>{const button=event.target.closest?.('[data-page]');if(button&&!button.disabled)load(Number(button.dataset.page));});
if(root)load();
