import { EVALUATION_AXES } from '../lib/company-evaluation-policy.js';
const root=document.getElementById('company-evaluation-editor');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let generation=0, selected=null, busy=false;
function show(data) {
  const evaluation=data.current?.evaluation || {}; const scores=evaluation.scores || {};
  root.innerHTML=`<h3>${esc(data.company.name)}：評価と履歴</h3><p>根拠付き手動採点です。保存した方針は表示・審査用で、既存の提案停止・配信設定を変更しません。</p>
    <p>保存状態：${evaluation.status==='confirmed' ? `確定 ${esc(evaluation.rank)} / ${esc(evaluation.score)}点` : '未確定'}${data.needsReevaluation ? "（90日内の根拠不足・再評価が必要）" : ""}／改訂 ${esc(data.current?.revision || '0')}</p>
    <form id="company-evaluation-save-form"><fieldset ${data.canConfirm ? '' : 'disabled'}><legend>評価を編集（管理者）</legend>
    ${EVALUATION_AXES.map(a=>{const v=scores[a.key]||{};return `<fieldset><legend>${a.label}（${a.max}点）</legend><label>点数 <input type="number" name="${a.key}-points" min="0" max="${a.max}" step="0.1" value="${esc(v.points)}"></label><label> 確認日 <input type="date" name="${a.key}-date" value="${esc(v.observedAt ? new Date(Date.parse(v.observedAt)+32400000).toISOString().slice(0,10) : '')}"></label><label style="display:block">根拠（個人情報は記入しない）<input name="${a.key}-evidence" maxlength="500" value="${esc(v.evidence)}" style="width:100%"></label></fieldset>`;}).join('')}
    <label>確定ランク <select name="rank">${['A','B','C','D'].map(rank=>`<option ${evaluation.rank===rank?'selected':''}>${rank}</option>`).join('')}</select></label>
    <label>取引方針 <select name="policy">${[['normal','通常'],['restricted','制限候補'],['hold','一時保留方針'],['stopped','新規提案停止方針'],['blast_only','ブラスト移行方針']].map(([v,label])=>`<option value="${v}" ${evaluation.policy===v?'selected':''}>${label}</option>`).join('')}</select></label>
    <label style="display:block">判断理由 <textarea name="reason" maxlength="1000">${esc(evaluation.reason)}</textarea></label>
    <label><input type="checkbox" name="improvementDiscussed" ${evaluation.improvementDiscussed?'checked':''}>改善協議を実施済み</label>
    <label><input type="checkbox" name="noProgressConfirmed" ${evaluation.noProgressConfirmed?'checked':''}>協議後も進展なしを確認済み（D確定には両方必要）</label>
    <p>下書き保存はランクを確定しません。既存の確定評価を下書きに戻す場合も履歴に残ります。</p>
    <button type="submit" name="action" value="draft">下書き保存</button> <button type="submit" name="action" value="confirmed">根拠を確認して評価を確定</button>
    </fieldset></form><p id="company-evaluation-save-message" role="status"></p>
    <details><summary>直近20件の変更履歴</summary><ol>${data.history.map(h=>`<li>改訂 ${esc(h.revision)}・${esc(h.created_at)}・${esc(h.evaluation.status)}・${esc(h.evaluation.rank || '未確定')}：${esc(h.evaluation.reason)}</li>`).join('') || '<li>履歴はありません。</li>'}</ol></details>`;
  document.getElementById('company-evaluation-save-form').addEventListener('submit',save);
}
async function load(companyId, message='') {
  if(busy)return;
  const id=++generation;selected=null;root.hidden=false;root.textContent='保存済み評価を確認中…';
  try {const data=await window.API.api(`/api/sales/company-evaluations/detail?company_id=${encodeURIComponent(companyId)}`);if(id!==generation)return;selected=data;show(data);if(message)document.getElementById('company-evaluation-save-message').textContent=message;}
  catch(e){if(id===generation)root.textContent=e.hint || '評価保存のDB準備・閲覧権限を確認してください。';}
}
async function save(event) {
  event.preventDefault();if(busy||!selected?.canConfirm)return;
  const action=event.submitter?.value;if(!['draft','confirmed'].includes(action))return;
  const form=event.currentTarget;const data=new FormData(form);const scores={};
  for(const axis of EVALUATION_AXES){const p=data.get(`${axis.key}-points`),day=data.get(`${axis.key}-date`);scores[axis.key]={points:p===''?null:Number(p),evidence:String(data.get(`${axis.key}-evidence`)||''),observedAt:day?`${day}T00:00:00+09:00`:null};}
  const companyId=selected.company.id;
  const body={company_id:companyId,expected_revision:String(selected.current?.revision || '0'),request_id:crypto.randomUUID(),reviewedAt:new Date().toISOString(),status:action,scores,rank:data.get('rank'),policy:data.get('policy'),reason:data.get('reason'),improvementDiscussed:data.has('improvementDiscussed'),noProgressConfirmed:data.has('noProgressConfirmed')};
  busy=true;form.querySelectorAll('button').forEach(b=>b.disabled=true);
  const message=document.getElementById('company-evaluation-save-message');message.textContent='保存結果を確認中…';
  let resultMessage;
  try{await window.API.api('/api/sales/company-evaluations/detail',{method:'POST',body,invalidates:['/api/sales/company-evaluations']});resultMessage='評価を保存しました。既存の停止・配信設定は変更していません。';}
  catch(e){if(e.status===400 || e.status===422){message.textContent=e.hint || '点数・根拠・確認日・判断理由を確認してください。入力は保持しています。';form.querySelectorAll('button').forEach(b=>b.disabled=false);return;}resultMessage=e.status===409?'他の変更と競合しました。最新の評価を確認してから編集し直してください。':`保存完了を確認できません。自動再送せず、最新状態を読み直しました。${e.hint || ''}`;}
  finally{busy=false;}
  await load(companyId,resultMessage);
}
window.addEventListener('company-evaluation-selected',event=>{const id=event.detail?.companyId;if(typeof id==='string')load(id);});
