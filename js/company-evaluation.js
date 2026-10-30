import { EVALUATION_AXES, evaluateScores } from '../lib/company-evaluation-policy.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {alert_owner:'担当者への確認候補',review_proposal_hold:'提案一時保留の審査候補',review_blast_only:'ブラスト移行の審査候補',confirm_loss_reasons:'見送り理由の確認候補',review_improvement:'改善による再審査候補'};
let version = 0;
export async function load() {
  const target = $('company-evaluation-results'); if (!target) return;
  const current = ++version;
  target.textContent = '直近90日の記録を確認中…';
  try {
    const data = await window.API.api('/api/sales/company-evaluations');
    if (current !== version) return;
    const format = value => new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
    target.innerHTML = `<p>${esc(data.note)}</p><p>対象期間（JST）：${esc(format(data.window.since))} 〜 ${esc(format(data.window.until))}</p>
      <p>企業ID未照合：${esc(data.unmappedCount)}件／全件確認：${data.complete ? '取得済み' : '未完了（審査候補を確定しません）'}</p>
      <div style="overflow-x:auto"><table class="sl-table"><thead><tr><th>企業</th><th>提案</th><th>面談・成約到達</th><th>返答待ち等</th><th>評価</th><th>次の確認</th></tr></thead><tbody>${data.companies.length ? data.companies.map(row => `<tr><td>${esc(row.companyName)}${row.localCompanyId ? `<br><button type="button" data-evaluation-company-id="${esc(row.localCompanyId)}">評価・履歴を開く</button>` : ''}</td><td>${esc(row.sentCount)}</td><td>${esc(row.meetingCount)}</td><td>${esc(row.sentCount-row.qualifiedCount)}</td><td>${row.savedEvaluation ? esc(row.savedEvaluation.status==='confirmed' ? `${row.savedEvaluation.rank} / ${row.savedEvaluation.score}点${row.savedEvaluation.needsReevaluation?'（再評価要）':''}` : '未確定（下書き）') : '未評価'}</td><td>${esc(row.review.status === 'unavailable' ? '全件・同期状態・配信種別の確認が必要' : row.review.actions.map(x=>labels[x] || x).join('／') || '採点根拠を確認')}</td></tr>`).join('') : '<tr><td colspan="6">対象の企業記録はありません。</td></tr>'}</tbody></table></div>`;
  } catch (error) {
    if (current !== version) return;
    target.textContent = error?.hint || error?.data?.hint || '企業評価を取得できません。管理権限・全件取得・DB構成の確認が必要です。';
  }
}
function setup() {
  const form = $('company-evaluation-preview'); if (!form) return;
  $('company-evaluation-axes').innerHTML = EVALUATION_AXES.map(axis=>`<fieldset style="margin:8px 0"><legend>${axis.label}（${axis.max}点）</legend><label>点数 <input name="${axis.key}-points" type="number" min="0" max="${axis.max}" step="0.1" style="width:6em"></label> <label>確認日 <input name="${axis.key}-date" type="date"></label><label style="display:block">根拠（個人情報は記入しない） <input name="${axis.key}-evidence" type="text" maxlength="500" style="width:100%"></label></fieldset>`).join('');
  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = new FormData(form); const scores = {};
    for (const axis of EVALUATION_AXES) {
      const raw = values.get(`${axis.key}-points`); const day = values.get(`${axis.key}-date`);
      scores[axis.key] = {points:raw === '' ? null : Number(raw), evidence:values.get(`${axis.key}-evidence`), observedAt:day ? `${day}T00:00:00+09:00` : null};
    }
    const result = evaluateScores(scores);
    $('company-evaluation-preview-result').textContent = result.score == null
      ? `未評価：${result.axes.filter(x=>x.points==null).map(x=>x.label).join('・')}の有効な点数・直近90日の確認日・根拠が必要です。`
      : `試算 ${result.score} / 100点 → ${result.suggestedRank}候補（未保存・未確定）。${result.suggestedRank === 'D' ? 'D確定には改善協議の記録と管理者判断が必要です。' : '企業への反映には根拠確認と保存処理が必要です。'}`;
  });
  $('company-evaluation-refresh').addEventListener('click', load);
  $('company-evaluation-results').addEventListener('click', event => {const button=event.target.closest?.('[data-evaluation-company-id]');if(button)window.dispatchEvent(new CustomEvent('company-evaluation-selected',{detail:{companyId:button.dataset.evaluationCompanyId}}));});
  $('company-evaluation-panel').addEventListener('toggle', event => {if(event.target.open && !$('company-evaluation-results').textContent.trim())load();});
}
setup();
