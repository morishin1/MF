import {renderMeetingBrief} from "./sales-company-meeting-summary.js?v=20261107hub1";
import {renderAnalysisView,renderProposalNext} from "./sales-company-analysis-view.js?v=20261108flow3";
import {renderCompanyMeetingHub} from "./sales-company-meeting-hub.js?v=20261108flow3";
import {renderCompactProposal} from "./sales-company-compact-proposal.js?v=20261108compact1";
import {renderCompanyHistoricalPanel} from "./sales-company-historical-panel.js?v=20261107id-channel";
// 企業詳細のステータスバー：企業分析 → ニーズ確認 → マッチング → 企業共有 → オファー・成約。
// 「企業情報」は既存のワークベンチ（js/sales-company-workbench.js）をそのまま使う。
// ここでは残り3つのタブを描く。API は /api/sales/company-talents・company-portal・company-progress。
// 決まりごとは docs/sales-company-portal.md。
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stamp = (v) => (v ? new Date(v).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const day = (v) => (v ? new Date(v).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—");
const errText = (e, fallback) => e?.hint || e?.message || fallback;
const STAGES = ["info","analysis","proposal"];
const PANEL = { info:"lc-detail", analysis:"lc-panel-analysis", proposal:"lc-panel-prep" };
const SOURCE = { info:"info", analysis:"analysis", proposal:"prep" };
const STEP_HINT = {
 info:"法人番号・公式ホームページを確認し、電話・メール・フォーム対応と営業履歴もこの画面で操作できます。",
 analysis:"AIで企業サマリー、ニーズ、技術領域、営業仮説を分析します。公開求人は確定案件ではありません。",
 proposal:"検索で案件・人材を絞り込み、AIのおすすめから候補をチェック。「商談へ進む」で別ページに表示します。"
};
const LINK_ORDER = ["saved", "planned", "proposed", "declined"];

export function createPortalTabs() {
  let row = null, gen = 0, active = "info", progress = null;
  const fallback = {info:"未確認",analysis:"未分析",proposal:"未選定"};
  let analyzing=false,lastAnalysisError="";
  function updateAnalysisControl(){
    const host=$("lc-stage-action-row"),button=$("lc-stage-analyze"),
      label=$("lc-stage-analysis-status"),spinner=$("lc-ai-spinner"),next=$("lc-stage-next");
    if(!host||!button||!label)return;
    host.hidden=active!=="analysis";
    const pilot=progress?.pilot, status=pilot?.status||"unstarted";
    const done=progress?.steps?.analysis?.state==="done";
    const eligible=Boolean(pilot?.eligible);
    const ready=eligible&&pilot?.canRun&&["unstarted","failed"].includes(status)&&
      (pilot?.attemptCount||0)<3;
    button.hidden=done;
    button.disabled=!ready||analyzing;
    button.textContent=status==="failed"?"AI企業分析を再試行":"この企業をAI分析する";
    if(spinner)spinner.hidden=!analyzing;
    if(next)next.hidden=!done||analyzing;
    if(analyzing)label.textContent="AIが公開情報・技術領域・人材需要・案件傾向を分析中です…";
    else if(lastAnalysisError)label.textContent=lastAnalysisError;
    else if(done)label.textContent="分析結果を保存済みです。企業サマリーを確認し、次のマッチングへ進めます。";
    else if(status==="processing")label.textContent="別の処理で分析中です。二重実行を防止しています。";
    else if(!eligible)label.textContent="ENGER企業IDとSales企業IDの紐づけが必要です。";
    else if(!pilot?.canRun)label.textContent=!progress?.analysis?.hasCorporateNumber||!progress?.analysis?.hasWebsite?
      "法人番号・公式HPを基本情報で登録してから分析してください。":
      pilot?.registeredCount>=10&&!pilot?.selected?"試験対象10社の上限です。管理者レビューが必要です。":
      "AI実行は現在、経営者権限と試験環境でのみ利用できます。";
    else label.textContent="ワンクリックでこの企業を調査し、サマリーと推奨ニーズを作成します。";
  }
  $("lc-stage-next")?.addEventListener("click",()=>select("proposal"));
  $("lc-stage-analyze")?.addEventListener("click",async()=>{
    if(analyzing||active!=="analysis"||!progress?.pilot?.canRun||!row?.companyId)return;
    const n=gen,id=row.companyId,salesCompanyId=progress.pilot.salesCompanyId;
    if(!salesCompanyId)return;
    analyzing=true;lastAnalysisError="";updateAnalysisControl();
    try{
      if(!progress.pilot.selected){
        await API.api("/api/sales/company-ai-batch",{method:"POST",
          body:{action:"extend",companyIds:[id]}});
        if(n!==gen||row?.companyId!==id)return;
      }
      const result=await API.api("/api/sales/company-ai-pilot",
        {method:"POST",body:{companyId:salesCompanyId}});
      if(n!==gen||row?.companyId!==id)return;
      if(result?.ok!==true)throw Error("AI分析結果を確認できませんでした。");
      await loadProgress();
    }catch(e){
      if(n===gen&&row?.companyId===id){
        lastAnalysisError=e?.hint||e?.message||"AI分析を完了できませんでした。再試行してください。";
        await loadProgress();
      }
    }finally{
      analyzing=false;
      if(n===gen&&row?.companyId===id)updateAnalysisControl();
    }
  });
  function updateStage(){
    for (const t of STAGES){
      const b=document.querySelector(`[data-modal-tab="${t}"]`);
      if(!b)continue;
      if(t===active)b.setAttribute("aria-current","step");
      else b.removeAttribute("aria-current");
      const data=progress?.steps?.[t];
      b.dataset.stageState=data?.state||"unknown";
      const small=b.querySelector("[data-step-label]");
      if(small)small.textContent=data?.label||fallback[t];
    }
    const baseNext=$("lc-go-to-prep");
    if(baseNext){baseNext.disabled=!row?.companyId||progress?.steps?.info?.state!=="done";
      baseNext.title=baseNext.disabled?"法人番号・公式HPを確認してから進めます":"AI分析へ進む";}
    const info=$("lc-stage-context");
    if(info)info.textContent=STEP_HINT[active];
    updateAnalysisControl();
    const insight=$("lc-stage-insight");
    if(insight) {
      insight.hidden=active!=="analysis";
      const a=progress?.analysis;
      const body=$("lc-stage-insight-text");
      if(body)body.textContent=!progress ? "企業分析状況を確認中…" : a?.summary||
        (!a?.hasCorporateNumber&&!a?.hasWebsite
          ?"法人番号と公式HPが未登録です。企業情報の確認から始めてください。"
          :"AIによる企業サマリーは未生成です。公式情報と案件ニーズを確認してください。");
      const meta=$("lc-stage-insight-meta");
      if(meta)meta.textContent=a?.generatedAt
        ? "分析記録："+new Date(a.generatedAt).toLocaleDateString("ja-JP",{timeZone:"Asia/Tokyo"})
        : "確認済み案件は別途ヒアリングが必要です";
    }
  }
  async function loadProgress(){
    const n=gen,id=row?.companyId;
    if(!id||row.salesOnly)return;
    try{
      const data=await API.api("/api/sales/company-workflow-status?"+new URLSearchParams({companyId:id}));
      if(n!==gen||row?.companyId!==id)return;
      progress=data;updateStage();renderAnalysisView($("lc-panel-analysis"),progress);renderProposalNext($("lp-proposal-next"),progress);
    }catch(e){
      if(n!==gen)return;
      const context=$("lc-stage-context");
      if(context)context.textContent=STEP_HINT[active]+"（進捗記録は取得できませんでした）";
    }
  }
  function showPrepSection(){
    const matching=active==="proposal";
    for(const id of ["lp-brief","lp-history-review"]){
      const panel=$(id);if(panel)panel.hidden=matching;
    }
    const details=$("lp-search-details");
    if(details){
      details.hidden=!matching;
      details.classList.toggle("lp-step-match-open",matching);
      details.open=matching;
    }
    const note=$("lp-stage-match-note");
    if(note)note.hidden=!matching;
    // The matching stage must retain actionable ENGER recommendations.
    const target="recommended";
    const chosen=$("lp-meeting-hub")?.querySelector(`[data-meeting-tab="${target}"]`);
    if(chosen && chosen.getAttribute("aria-pressed")!=="true")chosen.click();
    renderProposalNext($("lp-proposal-next"),progress);
  }
  const loaded = new Set();
  let clearPortalPassword=()=>{};
  const prep = { tab: "all", page: 1, selected: new Set(), rows: [], options: null };
  const live = (n) => n === gen && $("lc-dialog").open;

  function select(tab) {
    if(!STAGES.includes(tab))return;
    const btn=document.querySelector(`[data-modal-tab="${tab}"]`);
    if(!btn||btn.disabled)return;
    active=tab;
    for(const id of Object.values(PANEL))$(id).hidden=PANEL[tab]!==id;
    for(const t of STAGES){const b=document.querySelector(`[data-modal-tab="${t}"]`);
      if(b)b.tabIndex=t===tab?0:-1;}
    const toolbar=$("lc-ai-quick");if(toolbar)toolbar.hidden=tab!=="analysis";
    updateStage();
    if(tab==="analysis")renderAnalysisView($("lc-panel-analysis"),progress);
    if(tab==="proposal")$("lc-panel-prep").scrollTop=0;
    if(tab==="proposal"&&!loaded.has("prep")){loaded.add("prep");void loadPrep();}
    if(tab==="proposal")showPrepSection();
  }

  document.querySelectorAll("[data-modal-tab]").forEach((b)=>{
    b.addEventListener("click",()=>select(b.dataset.modalTab));
    b.addEventListener("keydown",(e)=>{
      if(!["ArrowRight","ArrowLeft"].includes(e.key))return;
      e.preventDefault();
      const enabled=STAGES.filter(t=>!document.querySelector(`[data-modal-tab="${t}"]`).disabled);
      const i=enabled.indexOf(active),direction=e.key==="ArrowRight"?1:-1;
      const next=enabled[(i+direction+enabled.length)%enabled.length];
      select(next);
      document.querySelector(`[data-modal-tab="${next}"]`)?.focus();
    });
  });

  function open(r) {
    row=r;gen++;progress=null;loaded.clear();lastAnalysisError="";
    Object.assign(prep,{tab:"all",page:1,selected:new Set(),rows:[]});
    const usable=Boolean(r?.companyId)&&!r?.salesOnly;
    for(const t of ["analysis","proposal"]){
      const b=document.querySelector(`[data-modal-tab="${t}"]`);
      b.disabled=!usable;
      b.title=usable?"":"ENGER企業IDとの照合が必要です";
      $(PANEL[t]).innerHTML=usable?'<p class="lc-detail-note">情報を読み込み中…</p>':
        '<p class="lc-detail-note">企業IDの照合が必要です。</p>';
    }
    select("info");updateStage();
    if(usable)void loadProgress();
  }

  // ---------------------------------------------------------------- 商談準備
  function prepFilters() {
    const v = (id) => $(id)?.value || "";
    return { q: v("lp-q"), skills: v("lp-skills"), remote: v("lp-remote"), prefecture: v("lp-pref"), weekDays: v("lp-days"), start: $("lp-start")?.checked ? "immediate" : "", sort: v("lp-sort") };
  }

  function prepShell(options) {
    const o = options || { remote: {}, prefectures: [], linkStatuses: {} };
    $("lc-panel-prep").innerHTML =
      '<div class="lp-wrap"><div id="lp-proposal-next"></div><p id="lp-stage-match-note" class="lp-stage-match-explainer" hidden>確認した条件を使って候補を検索・保存します。推定した需要だけで提案確定にはしません。</p><div id="lp-brief" aria-live="polite"><p class="lc-detail-note">企業サマリーを読み込み中…</p></div><div id="lp-meeting-hub"></div><div id="lp-history-review"></div><details id="lp-search-details" class="lp-prep-more"><summary>詳細な人材検索・候補を保存（必要なときに開く）</summary><div class="lp-prep-search-content"><p class="lc-detail-note">ENGERの人材DBを条件で検索します。氏名・連絡先・所属会社・仕入単価・スキルシート原本は公開しません。</p>' +
      '<div class="lp-subtabs" role="group" aria-label="人材の種類">' + [["all", "全人材"], ["focus", "注力人材"], ["new", "新着人材"], ["linked", "この企業に紐づけ済み"]].map(([k, l]) => `<button type="button" data-prep-tab="${k}" aria-pressed="${prep.tab === k}">${l}${k === "linked" ? ' <b id="lp-linked-count"></b>' : ""}</button>`).join("") + "</div>" +
      '<form id="lp-form" class="lp-filters" role="search"><input id="lp-q" type="search" maxlength="100" placeholder="職種・スキル・人材番号" aria-label="キーワード">' +
      '<input id="lp-skills" maxlength="200" placeholder="スキル（カンマ区切り。すべて一致）" aria-label="スキル">' +
      `<select id="lp-remote" aria-label="働き方"><option value="">働き方：すべて</option>${Object.entries(o.remote).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join("")}</select>` +
      `<select id="lp-pref" aria-label="居住地"><option value="">居住地：すべて</option>${o.prefectures.map((p) => `<option>${esc(p)}</option>`).join("")}</select>` +
      '<select id="lp-days" aria-label="稼働日数"><option value="">稼働日数：すべて</option><option value="5">週5日</option><option value="4">週4日以上</option><option value="3">週3日以上</option></select>' +
      '<label class="lp-check"><input type="checkbox" id="lp-start"> 早めに稼働できる</label>' +
      '<select id="lp-sort" aria-label="並べ替え"><option value="">並び：自動（キーワードがあれば関連度）</option><option value="relevance">関連度</option><option value="new">新着順</option></select>' +
      '<button type="submit" class="lc-primary">検索</button></form>' +
      '<p id="lp-status" class="lc-detail-note" role="status" aria-live="polite"></p>' +
      '<div class="lc-table-wrap"><table class="lc-table lp-table"><thead><tr><th><input type="checkbox" id="lp-all" aria-label="表示中の人材をすべて選択"></th><th>人材</th><th>職種</th><th>スキル</th><th>稼働開始</th><th>働き方・居住地</th><th>この企業への紐づけ</th></tr></thead><tbody id="lp-rows"></tbody></table></div>' +
      '<div class="lc-pager"><button type="button" id="lp-prev" disabled>前へ</button><span id="lp-page"></span><button type="button" id="lp-next" disabled>次へ</button></div>' +
      `<section id="lp-bulk" class="lc-bulk" hidden aria-label="選んだ人材をこの企業に保存"><strong id="lp-selected"></strong><label>状態<select id="lp-bulk-status">${LINK_ORDER.map((k) => `<option value="${k}">${esc((o.linkStatuses || {})[k] || k)}</option>`).join("")}</select></label><button type="button" id="lp-save" class="lc-primary">この企業に保存</button><button type="button" id="lp-clear">選択解除</button></section></div></details></div>`;

    showPrepSection();
    document.querySelectorAll("[data-prep-tab]").forEach((b) => (b.onclick = () => { prep.tab = b.dataset.prepTab; prep.page = 1; document.querySelectorAll("[data-prep-tab]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); void searchPrep(); }));
    $("lp-form").onsubmit = (e) => { e.preventDefault(); prep.page = 1; void searchPrep(); };
    $("lp-prev").onclick = () => { prep.page--; void searchPrep(); };
    $("lp-next").onclick = () => { prep.page++; void searchPrep(); };
    $("lp-all").onchange = (e) => { for (const r of prep.rows) e.target.checked ? prep.selected.add(r.id) : prep.selected.delete(r.id); drawPrepRows(); };
    $("lp-clear").onclick = () => { prep.selected.clear(); drawPrepRows(); };
    $("lp-save").onclick = () => void saveLinks([...prep.selected], $("lp-bulk-status").value);
    $("lp-rows").onclick = (e) => { if (e.target.closest("input")) return; const tr = e.target.closest("[data-talent]"); if (tr) void openTalent(tr.dataset.talent); };
    $("lp-rows").onkeydown = (e) => { if (e.key === "Enter" && e.target.matches("[data-talent]")) void openTalent(e.target.dataset.talent); };
    $("lp-rows").onchange = (e) => { const cb = e.target.closest("[data-pick]"); if (!cb) return; cb.checked ? prep.selected.add(cb.dataset.pick) : prep.selected.delete(cb.dataset.pick); drawPrepRows(); };
  }

  const badges = (t) => (t.isFocus ? '<span class="lp-badge focus">注力</span>' : "") + (t.isNew ? '<span class="lp-badge new">新着</span>' : "");

  function drawPrepRows() {
    const body = $("lp-rows"); if (!body) return;
    body.innerHTML = prep.rows.length ? prep.rows.map((t) => `<tr data-talent="${esc(t.id)}" tabindex="0" class="${prep.selected.has(t.id) ? "chosen" : ""}"><td><input type="checkbox" data-pick="${esc(t.id)}" ${prep.selected.has(t.id) ? "checked" : ""} aria-label="${esc(t.displayName)}を選択"></td>` +
      `<td><strong>${esc(t.displayName)}</strong>${badges(t)}<small>${esc(t.talentNo || "")}</small></td><td>${esc(t.title || "—")}<small>${esc((t.roles || []).join(" / "))}</small></td>` +
      `<td><div class="lp-skills">${(t.skills || []).slice(0, 6).map((s) => `<span>${esc(s)}</span>`).join("")}${t.skills?.length > 6 ? `<span>他${t.skills.length - 6}</span>` : ""}</div></td>` +
      `<td>${esc(t.availability || "—")}<small>${esc(t.weekDays || "")}</small></td><td>${esc(t.remoteLabel || "—")}<small>${esc(t.prefecture || "")}</small></td>` +
      `<td>${t.link ? `<span class="lp-link ${esc(t.link.status)}">${esc(t.link.statusLabel)}</span><small>${esc(day(t.link.updatedAt))}</small>` : '<small>未保存</small>'}</td></tr>`).join("")
      : `<tr><td colspan="7">${prep.tab === "linked" ? "この企業に紐づけた人材はまだありません。「全人材」から選んで保存してください。" : "条件に合う人材はいません。条件を減らしてお試しください。"}</td></tr>`;
    $("lp-bulk").hidden = !prep.selected.size;
    $("lp-selected").textContent = prep.selected.size + "人を選択";
    $("lp-all").checked = prep.rows.length > 0 && prep.rows.every((r) => prep.selected.has(r.id));
  }

  async function searchPrep(preloaded = null) {
    const n = gen;
    if (!$("lp-rows")) return;
    $("lp-status").textContent = "ENGER の人材を検索しています…";
    const f = prepFilters();
    const p = new URLSearchParams({ companyId: row.companyId, tab: prep.tab, page: String(prep.page) });
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    try {
      const d = preloaded || await API.api("/api/sales/company-talents?" + p);
      if (!live(n)) return;
      prep.rows = d.rows || [];
      $("lp-linked-count").textContent = d.linkedCount ? String(d.linkedCount) : "";
      $("lp-status").textContent = `${d.total.toLocaleString("ja-JP")}人` + (d.truncated ? "（新しい順に2,000人までを対象に絞り込み）" : "") +
        (d.missing?.length ? `　※ この環境では ${d.missing.join("・")} の列が無いため、その条件は使えません` : "") + (d.linkReady ? "" : `　※ ${d.linkHint}`);
      $("lp-page").textContent = `${d.page} / ${d.pages}ページ`;
      $("lp-prev").disabled = d.page <= 1; $("lp-next").disabled = d.page >= d.pages;
      prep.page = d.page;
      $("lp-save").disabled = !d.linkReady;
      drawPrepRows();
    } catch (e) {
      if (!live(n)) return;
      prep.rows = []; drawPrepRows();
      $("lp-status").textContent = errText(e, "人材を取得できませんでした。再度お試しください。");
    }
  }

  async function loadPrep() {
    const n=gen,companyId=row?.companyId;
    const host=$("lc-panel-prep");
    if(!host||!companyId)return;
    host.innerHTML='<p class="lc-detail-note">AI分析とENGERの候補を照合しています…</p>';
    let brief={company:{name:row.name},source:{},suggestions:{
      jobs:[],talents:[],basis:"企業の確認済みニーズ・分析条件が未登録",verified:false
    }};
    try{
      const result=await API.api("/api/sales/company-meeting-brief?"+
        new URLSearchParams({companyId}));
      if(!live(n)||row?.companyId!==companyId)return;
      if(result?.company&&result?.suggestions)brief=result;
    }catch(e){
      if(!live(n)||row?.companyId!==companyId)return;
      // Search remains available even if the matching brief cannot be read.
    }
    renderCompactProposal(host,{companyId,brief,
      onTalent:(id)=>{if(live(n)&&row?.companyId===companyId)void openTalent(id);},
      onPublished:()=>{if(live(n)&&row?.companyId===companyId)void loadProgress();}
    });
  }

  async function saveLinks(ids, status) {
    if (!ids.length) return;
    const n = gen;
    $("lp-save").disabled = true; $("lp-status").textContent = "保存しています…";
    try {
      const d = await API.api("/api/sales/company-talents", { method: "POST", body: { companyId: row.companyId, talentIds: ids, status } });
      if (!live(n)) return;
      prep.selected.clear();
      const label = { saved: "保存候補", planned: "提案予定", proposed: "提案済み", declined: "見送り" }[status] || status;
      const done = `${d.linked}人を「${label}」で保存しました。` + (d.skipped?.length ? `（${d.skipped.length}人は企業へ提示できない状態のため保存していません）` : "");
      await searchPrep();
      if (live(n) && $("lp-status")) $("lp-status").textContent = done + "　" + $("lp-status").textContent;
      loaded.delete("offers");
      void loadProgress();
    } catch (e) {
      if (live(n)) $("lp-status").textContent = errText(e, "保存できませんでした。再度お試しください。");
    } finally { if ($("lp-save")) $("lp-save").disabled = false; }
  }

  // 人材詳細（サマリーを最初に出す。スキルシートはタブで1クリック）
  async function openTalent(id) {
    const dlg = $("lc-talent-dialog"), n = gen;
    $("lc-talent-title").textContent = "人材の詳細";
    $("lc-talent-body").innerHTML = '<p class="lc-detail-note">読み込み中…</p>';
    if (!dlg.open) dlg.showModal();
    try {
      const d = await API.api("/api/sales/company-talents?" + new URLSearchParams({ companyId: row.companyId, id }));
      if (!live(n)) return;
      const t = d.talent;
      $("lc-talent-title").textContent = `${t.displayName}（${t.talentNo || "番号なし"}）`;
      const kv = (k, v) => `<div class="lc-kv"><dt>${esc(k)}</dt><dd>${esc(v || "—")}</dd></div>`;
      $("lc-talent-body").innerHTML =
        `<div class="lp-subtabs" role="tablist" aria-label="人材詳細"><button type="button" role="tab" data-talent-view="summary" aria-selected="true">サマリー</button><button type="button" role="tab" data-talent-view="sheet" aria-selected="false">スキルシート（公開用）</button></div>` +
        `<section data-talent-panel="summary"><p>${badges(t)}</p><dl>${kv("職種", [t.title, ...(t.roles || [])].filter(Boolean).join(" / "))}${kv("経験年数", t.experience)}${kv("稼働開始", t.availability)}${kv("稼働日数", t.weekDays)}${kv("働き方", t.remoteLabel)}${kv("居住地", t.prefecture)}${kv("最寄り駅", t.nearestStation)}${kv("年代", t.ageBand)}</dl>` +
        `<div class="lp-skills">${(t.skills || []).map((s) => `<span>${esc(s)}</span>`).join("")}</div></section>` +
        `<section data-talent-panel="sheet" hidden><h4>${esc(d.sheet.title)}</h4><dl>${d.sheet.rows.map(([k, v]) => kv(k, v)).join("")}</dl><div class="lp-skills">${d.sheet.skills.map((s) => `<span>${esc(s)}</span>`).join("")}</div><p class="lc-detail-note">${esc(d.sheet.note)}</p></section>` +
        `<section class="lp-link-editor"><h4>この企業への紐づけ（社内向け・企業には表示しません）</h4>` +
        (d.linkReady ? `<label>状態<select id="lt-status">${LINK_ORDER.map((k) => `<option value="${k}" ${d.link?.status === k ? "selected" : ""}>${esc({ saved: "保存候補", planned: "提案予定", proposed: "提案済み", declined: "見送り" }[k])}</option>`).join("")}</select></label>` +
          (d.link ? `<label>社内メモ<textarea id="lt-note" rows="3" maxlength="1000">${esc(d.link.note)}</textarea></label><button type="button" id="lt-save" class="lc-primary">状態・メモを保存</button><small>最終更新 ${esc(stamp(d.link.updatedAt))}</small>` : `<button type="button" id="lt-link" class="lc-primary">この企業に保存</button>`)
          : '<p class="lc-detail-note">紐づけの DB が未適用のため保存できません。</p>') +
        `<p id="lt-status-msg" class="lc-detail-note" role="status"></p></section>` +
        `<section class="lp-brief-card"><h4>マッチング精度を上げる（社内向け）</h4><p class="lc-detail-note">公開用サマリーだけでは採点しません。ENGER DXで原本スキルシートとの照合・解析・承認を行います。</p><a class="lc-primary-link" href="https://dx.enger.jp/talents/${encodeURIComponent(t.id)}/local-ai" target="_blank" rel="noopener noreferrer">スキルシートをMD出力・AI結果を取り込む ↗</a><p><a class="lc-link" href="${esc(d.dxUrl)}" target="_blank" rel="noopener noreferrer">ENGER DX で人材詳細を開く ↗</a></p></section>`;
      document.querySelectorAll("[data-talent-view]").forEach((b) => (b.onclick = () => {
        document.querySelectorAll("[data-talent-view]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
        document.querySelectorAll("[data-talent-panel]").forEach((p) => (p.hidden = p.dataset.talentPanel !== b.dataset.talentView));
      }));
      if ($("lt-link")) $("lt-link").onclick = async () => { await saveLinks([t.id], $("lt-status").value); if (live(n)) void openTalent(id); };
      if ($("lt-save")) $("lt-save").onclick = async () => {
        $("lt-save").disabled = true; $("lt-status-msg").textContent = "保存しています…";
        try {
          await API.api("/api/sales/company-talents", { method: "PATCH", body: { companyId: row.companyId, talentId: t.id, status: $("lt-status").value, note: $("lt-note").value } });
          if (!live(n)) return;
          $("lt-status-msg").textContent = "保存しました。"; loaded.delete("offers"); void searchPrep();
        } catch (e) { $("lt-status-msg").textContent = errText(e, "保存できませんでした。"); }
        finally { if ($("lt-save")) $("lt-save").disabled = false; }
      };
    } catch (e) {
      if (live(n)) $("lc-talent-body").innerHTML = `<p class="lc-error">${esc(errText(e, "人材の詳細を取得できませんでした。"))}</p>`;
    }
  }

  // ---------------------------------------------------------------- 企業ポータル
  let portal = null;
  async function loadPortal(message = "") {
    const n = gen;
    try {
      const d = await API.api("/api/sales/company-portal?" + new URLSearchParams({ companyId: row.companyId }));
      if (!live(n)) return;
      portal = d; drawPortal(message);
    } catch (e) {
      if (live(n)) $("lc-panel-portal").innerHTML = `<p class="lc-error">${esc(errText(e, "企業ポータルの情報を読み込めませんでした。"))}</p>`;
    }
  }

  // ---------------------------------------------------------------- 商談URL
  function drawPortal(message) {
    const d=portal,host=$("lc-panel-portal");
    clearPortalPassword();
    host.replaceChildren();
    const make=(tag,text,cls="")=>{
      const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);
      if(cls)e.className=cls;return e;
    };
    const wrapper=make("div",undefined,"lp-wrap lp-portal-simple");
    const card=make("section",undefined,"lp-card lp-meeting-url-card");
    const head=make("div",undefined,"lp-meeting-url-head");
    head.append(make("h3","商談URL"),make("small","企業ID "+(d.portal.displayId||row.displayId||"—")));
    card.append(head);
    const form=make("div",undefined,"lp-meeting-url-grid");
    const members=(d.members||[]).filter(m=>m.status!=="disabled");
    const selector=make("select");selector.id="pt-member-select";
    for(const m of members){
      const option=make("option",m.displayName+" ／ "+m.email+"（"+m.statusLabel+"）");
      option.value=m.id;selector.append(option);
    }
    const idBox=make("input");idBox.id="pt-login-id";idBox.readOnly=true;
    idBox.placeholder="アカウント未発行";
    const pwBox=make("div","未発行・保存済みパスワードは再表示できません","lp-password-state");
    pwBox.id="pt-password-text";
    const field=(label,control)=>{
      const e=make("label",undefined,"lp-meeting-url-field");
      e.append(make("span",label),control);return e;
    };
    const label=make("div",undefined,"lp-meeting-url-field");
    label.append(make("span","ログインID（企業担当者のメール）"));
    if(members.length>1)label.append(selector);
    label.append(idBox);
    form.append(label,field("パスワード",pwBox));
    card.append(form);
    const buttons=make("div",undefined,"lp-meeting-url-actions");
    const meeting=make("button","商談画面を開く","lc-primary");
    meeting.type="button";
    meeting.onclick=()=>{
      // Staff authorization, never a customer's password in URL or browser storage.
      const url="/sales/company-meeting.html?"+
        new URLSearchParams({companyId:row.companyId});
      window.open(url,"_blank","noopener,noreferrer");
    };
    const issue=make("button","アカウント発行","lp-meeting-secondary");
    issue.type="button";issue.disabled=!d.canEnable;
    buttons.append(meeting,issue);card.append(buttons);
    const status=make("p",message||"","lp-msg");status.id="pt-msg";status.setAttribute("role","status");
    card.append(status);
    const credentials=make("div",undefined,"lp-temp-credentials");credentials.id="pt-temp-credentials";
    credentials.hidden=true;card.append(credentials);
    const issuePanel=make("div",undefined,"lp-portal-issue-panel");
    issuePanel.hidden=true;issuePanel.id="pt-issue-panel";
    const notice=make("p","管理者が新しいログインIDと強固な一時パスワードを発行します。既存IDの再発行は現在のパスワードを変更します。","lp-meeting-note");
    const issueType=make("select");
    for(const [val,t] of [["new","新しい企業担当者を発行"],["reset","既存アカウントのパスワードを再発行"]]){
      const op=make("option",t);op.value=val;issueType.append(op);
    }
    const inputEmail=make("input");inputEmail.type="email";inputEmail.maxLength=254;
    inputEmail.placeholder="メールアドレス（ログインID）";
    const inputName=make("input");inputName.maxLength=100;inputName.placeholder="企業担当者名";
    const resetMember=make("select");resetMember.hidden=true;
    for(const m of members.filter(x=>x.status==="active")){
      const opt=make("option",m.email);opt.value=m.id;resetMember.append(opt);
    }
    const submit=make("button","発行する","lc-primary");submit.type="button";
    issueType.onchange=()=>{
      const reset=issueType.value==="reset";
      inputEmail.hidden=reset;inputName.hidden=reset;resetMember.hidden=!reset;
      submit.textContent=reset?"パスワードを再発行":"アカウントを発行";
    };
    issuePanel.append(notice,issueType,inputEmail,inputName,resetMember,submit);
    card.append(issuePanel);
    issue.onclick=()=>{issuePanel.hidden=!issuePanel.hidden;if(!issuePanel.hidden)inputEmail.focus();};
    const memberChanged=()=>{
      const selected=members.find(x=>x.id===selector.value)||members[0];
      idBox.value=selected?.email||"";
      pwBox.textContent=selected?"保存済みパスワードは表示できません（再発行時のみ表示）":
        "アカウント未発行";
    };
    selector.onchange=memberChanged;memberChanged();
    const showPassword=(data)=>{
      clearPortalPassword();
      credentials.replaceChildren();
      const title=make("strong","発行した一時パスワード（1回だけ表示）");
      const line=make("div",undefined,"lp-temp-credential-line");
      const email=make("span","ID："+(data.email||""));
      const secret=make("code",data.temporaryPassword);
      const copy=make("button","コピー");copy.type="button";
      copy.onclick=async()=>{
        try{await navigator.clipboard.writeText(secret.textContent);copy.textContent="コピーしました";}
        catch{copy.textContent="コピーできませんでした";}
      };
      line.append(email,secret,copy);
      credentials.append(title,line,make("small",
        "画面を離れるか2分後に消えます。メールやURLにパスワードを埋め込まず、安全な方法で担当者へ渡してください。"));
      credentials.hidden=false;
      pwBox.textContent="発行済み（一時表示は下記）";
      let timeout=setTimeout(()=>clearPortalPassword(),120000);
      clearPortalPassword=()=>{
        clearTimeout(timeout);credentials.replaceChildren();credentials.hidden=true;
        pwBox.textContent="パスワードは非表示（再発行時のみ一度表示）";
      };
    };
    submit.onclick=async()=>{
      const reset=issueType.value==="reset";
      const member=members.find(x=>x.id===resetMember.value);
      if(reset&&!member){status.textContent="再発行する有効アカウントがありません。";return;}
      if(!reset&&(!inputEmail.validity.valid||!inputEmail.value.trim()||!inputName.value.trim())){
        status.textContent="企業担当者名と正しいメールアドレスを入力してください。";return;
      }
      if(!confirm(reset?"現在のパスワードを無効にし、新しい一時パスワードを発行しますか？":
        "この企業の担当者アカウントを発行しますか？"))return;
      submit.disabled=true;status.textContent="アカウントを発行中…";
      try{
        const data=await API.api("/api/sales/company-portal",{method:"POST",body:
          reset?{companyId:row.companyId,action:"generate_password",memberId:member.id,confirmed:true}:
          {companyId:row.companyId,action:"issue_account",confirmed:true,
            email:inputEmail.value.trim(),displayName:inputName.value.trim(),role:"member"}
        });
        if(!data.oneTime||!data.temporaryPassword)throw Error("発行結果を確認できませんでした。");
        await loadPortal("アカウントを発行しました。IDと一時パスワードを控えてください。");
        const current=$("lc-panel-portal");
        if(current?.querySelector("#pt-temp-credentials")){
          // A fresh draw after issuance, therefore attach the one-time password there.
          const target=current.querySelector("#pt-temp-credentials");
          target.replaceChildren();
          const title=make("strong","一時パスワード（発行時の1回だけ表示）");
          const line=make("div",undefined,"lp-temp-credential-line");
          const mail=make("span","ログインID："+data.email);
          const code=make("code",data.temporaryPassword);
          const copy=make("button","コピー");copy.type="button";
          copy.onclick=()=>navigator.clipboard.writeText(code.textContent).then(()=>{
            copy.textContent="コピー済み";}).catch(()=>{copy.textContent="コピーできません";});
          line.append(mail,code,copy);target.append(title,line,
            make("small","2分後に自動で非表示になります。ブラウザに保存しません。"));
          target.hidden=false;
          const state=current.querySelector("#pt-password-text");
          if(state)state.textContent="発行済み（下記に一時表示）";
          let timeout=setTimeout(()=>clearPortalPassword(),120000);
          clearPortalPassword=()=>{
            clearTimeout(timeout);target.replaceChildren();target.hidden=true;
            if(state)state.textContent="パスワードは非表示（発行時のみ表示）";
          };
        }
      }catch(e){status.textContent=errText(e,"アカウントを発行できませんでした。");submit.disabled=false;}
    };
    wrapper.append(card);host.append(wrapper);
  }

  // ---------------------------------------------------------------- オファー・進捗
  // ---------------------------------------------------------------- オファー・履歴
  async function loadOffers(){
    const n=gen;
    const host=$("lc-panel-offers");if(!host)return;
    host.innerHTML='<p class="lc-detail-note">企業オファー・ログイン・保存履歴を読み込み中…</p>';
    try{
      const q=new URLSearchParams({companyId:row.companyId});
      const [offers,portalDetail,progress]=await Promise.all([
        API.api("/api/sales/company-offers?"+q),
        API.api("/api/sales/company-portal?"+q),
        API.api("/api/sales/company-progress?"+q),
      ]);
      if(!live(n))return;
      const statuses=offers.statusLabels||{};
      const offerRows=offers.offers||[];
      const login=portalDetail.loginHistory||[];
      const saved=portalDetail.saved||[];
      const c=progress.prep?.counts||{};
      host.innerHTML=
        '<div class="lp-wrap lp-offer-management">'+
        '<section class="lp-card"><div class="lp-offer-head"><h3>企業からのオファー</h3><strong>'+offerRows.length+'件</strong></div>'+
        '<p class="lc-detail-note">相手企業が「オファーする」で送信した情報を表示。問い合わせや社内お気に入りとは別の履歴です。</p>'+
        (offerRows.length?'<div class="lc-table-wrap lp-offer-table-wrap"><table class="lc-table"><thead><tr><th>受信日時</th><th>案件・人材</th><th>企業担当者</th><th>対応状態</th></tr></thead><tbody>'+
          offerRows.map(o=>'<tr><td>'+esc(stamp(o.createdAt))+'</td><td><b>'+esc(o.type==="job"?"案件":"人材")+'</b><small>'+
            esc((o.itemNo?o.itemNo+" ／ ":"")+(o.title||"未登録"))+'</small>'+
            (o.message?'<small>'+esc(o.message)+'</small>':'')+'</td><td>'+esc(o.memberName||"—")+
            '<small>'+esc(o.loginId||"")+'</small></td><td><select data-offer-status="'+esc(o.id)+'" data-offer-old="'+esc(o.status)+'">'+
            Object.entries(statuses).map(([code,label])=>'<option value="'+esc(code)+'"'+(o.status===code?' selected':'')+'>'+esc(label)+'</option>').join("")+
            '</select><small>'+esc(o.reviewedAt?"確認 "+stamp(o.reviewedAt):"未確認")+'</small></td></tr>').join("")+
          '</tbody></table></div>':
          '<p class="lc-detail-note">正式なオファーはまだありません。企業が商談画面から送信すると、この企業IDに記録されます。</p>')+
        '</section>'+
        '<div class="lp-offer-history-grid">'+
        '<section class="lp-card"><h4>ログイン履歴 <small>'+login.length+'件</small></h4>'+
          (login.length?'<div class="lp-offer-scroll"><table class="lc-table"><thead><tr><th>日時</th><th>担当者・ログインID</th></tr></thead><tbody>'+
          login.map(e=>'<tr><td>'+esc(stamp(e.at))+'</td><td>'+esc(e.member||"不明")+
            '<small>'+esc(e.email||"")+'</small></td></tr>').join("")+
          '</tbody></table></div>':'<p class="lc-detail-note">ログイン履歴はありません。</p>')+
        '</section>'+
        '<section class="lp-card"><h4>企業が保存した人材 <small>'+saved.length+'件</small></h4>'+
          (saved.length?'<div class="lp-offer-scroll"><ul class="lp-list">'+saved.map(x=>
            '<li><strong>'+esc((x.talentNo||"")+" "+(x.title||"人材"))+'</strong>'+
            '<small>'+esc(x.savedBy||"")+' ／ '+esc(stamp(x.savedAt))+'</small></li>').join("")+
          '</ul></div>':'<p class="lc-detail-note">企業が保存した人材はありません。</p>')+
        '</section></div>'+
        '<details class="lp-offer-progress"><summary>提案・面談・成約の進捗を確認</summary>'+
        '<section class="lp-card"><div class="lp-kpis">'+Object.keys(progress.prep?.labels||{}).map(k=>
          '<div><b>'+Number(c[k]||0)+'</b><small>'+esc(progress.prep.labels[k])+'</small></div>').join("")+'</div>'+
        '<div class="lc-table-wrap"><table class="lc-table"><thead><tr><th>状態</th><th>案件・人材</th><th>営業担当</th><th>提案日時</th><th>面談日時</th><th>参照</th></tr></thead><tbody>'+
        ((progress.proposals||[]).length?progress.proposals.map(p=>
          '<tr><td>'+esc(p.statusLabel||p.status)+'</td><td>'+esc(p.jobTitle||p.title||"未設定")+'</td>'+
          '<td>'+esc(p.salesOwner||"—")+'</td><td>'+esc(stamp(p.sentAt))+'</td>'+
          '<td>'+esc(stamp(p.meetingAt))+'</td><td><a class="lc-link" href="'+esc(p.url)+'">提案を開く</a></td></tr>').join(""):
          '<tr><td colspan="6">この企業の営業提案はありません。</td></tr>')+
        '</tbody></table></div><p class="lc-detail-note">成約確定はSales提案管理で記録します。オファーを「成約確認待ち」にしても売上は確定しません。</p></section></details>'+
        '</div>';
      host.querySelectorAll("[data-offer-status]").forEach(select=>select.onchange=async()=>{
        const offer=offerRows.find(o=>o.id===select.dataset.offerStatus);
        if(!offer)return;
        if(!confirm("オファーの対応状態を「"+(statuses[select.value]||select.value)+"」へ変更しますか？")){
          select.value=offer.status;return;
        }
        select.disabled=true;
        try{
          await API.api("/api/sales/company-offers",{method:"PATCH",body:{
            companyId:row.companyId,offerId:offer.id,status:select.value,
            expectedStatus:offer.status,confirmed:true,
          }});
          if(live(n))await loadOffers();
        }catch(e){if(live(n)){select.value=offer.status;
          const note=document.createElement("p");note.className="lc-error";
          note.textContent=errText(e,"オファーの更新に失敗しました。");
          host.prepend(note);select.disabled=false;}}
      });
    }catch(e){if(live(n))host.innerHTML='<p class="lc-error">'+
      esc(errText(e,"オファー・ログイン履歴を確認できませんでした。"))+'</p>';}
  }

  $("lc-talent-close")?.addEventListener("click", () => $("lc-talent-dialog").close());
  function refresh(tab="prep"){
    const source=SOURCE[tab]||tab;
    loaded.delete(source);
    void loadProgress();
    if(source==="analysis")renderAnalysisView($("lc-panel-analysis"),progress);
    if(SOURCE[active]===source&&row?.companyId){
      loaded.add(source);
      if(source==="prep")void loadPrep();
      else if(source==="portal")void loadPortal();
      else if(source==="offers")void loadOffers();
    }
  }
  document.addEventListener("sales:proposal-prepared",e=>{
    if(row?.companyId===e.detail?.companyId)void loadProgress();
  });
  return { open, select, refresh };
}
