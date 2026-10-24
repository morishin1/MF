// Analysis navigation and hypothesis prompts. No business writes or stored experiment ledger.
(function () {
  "use strict";
  const keys = ["matching", "attack", "proposal"];
  const plans = {
    matching: [
      ["スキルの需給を確認する", "人材構成・案件の必須スキル・未入力件数を同じ期間/定義で確認。", "仮説例（未検証）：必要スキルと供給のずれが候補不足につながっているかもしれない。", "条件が明確な案件を選び、スキル・単価・開始時期のどれか1条件だけ比較する。", "同じ案件/人材IDの候補数・提案数・面談実施数と不一致理由を確認。この画面には候補の件数がまだつながっていません（未接続）。"],
      ["条件・記録の不足を確認する", "単価・開始時期・勤務地・必須条件の未入力を先に確認。", "仮説例（未検証）：不適合ではなく条件の未確認で提案できていないかもしれない。", "対象案件の未確認条件を1つ確認し、比較前後の条件を記録する。", "条件確認で候補/提案が増えたか、面談実施につながったか。未記録と不適合を分ける。"]
    ],
    attack: [
      ["送信から反応までを見直す", "同じ送信期間・チャネル・集計対象で返信/商談を比較。フォーム送信担当と企業担当は別。", "仮説例（未検証）：対象企業か文章が相手の需要に合っていないかもしれない。", "対象条件を固定し、文章かチャネルのどちらか1つだけ変える。送信許可/連絡停止を守る。", "返信・商談・成約の件数と集計対象を同じ期間で比較。クリックだけで成功としない。"],
      ["商談から受注までを見直す", "成約日ベースの金額とアタック起点の比較表を混ぜず、案件明細と見送り理由を確認。", "仮説例（未検証）：商談後の条件確認や次回合意が不足しているかもしれない。", "一群の案件で次の確認項目を1つ統一し、結果と確認日を記録する。", "成約/見送りと受注額を観測。会計売上・利益はこの画面の金額ではない。"]
    ],
    proposal: [
      ["提案から面談実施までを見直す", "期間内に送信した提案のうち面談を実施した件数と集計対象、未実施の経過日数を確認。調整・日程確定・実施は別。", "仮説例（未検証）：条件の伝わり方や日程調整で止まっているかもしれない。", "根拠明細から対象提案IDを選び、条件確認か日程確認のどちらか1つを試す。", "同じ期間に送信した提案で、面談実施件数と送信から実施までの日数を比較。終了案件を滞留扱いしない。"],
      ["面談後の合格・見送り理由を確認する", "合格証拠/未確認と、記録された見送り理由/情報取得状態を別々に確認。", "仮説例（未検証）：提案の条件適合ではなく結果や理由の未回収が多いかもしれない。", "未聴取・回答なし・具体性なしを区別し、確認可能な案件の理由を1つ具体化する。連絡停止は守る。", "合格の記録と理由取得状態が更新されたか確認。未確認を不合格にせず、記録理由を真因と断定しない。"]
    ]
  };
  let initialized = false, active = "attack", loadAttack, attackLoaded = false;
  const selections = { matching:0, attack:0, proposal:0 };
  const get = (id) => document.getElementById(id);
  function renderPlan() {
    const select = get("ah-question");
    select.replaceChildren(...plans[active].map((p, i) => {
      const option = document.createElement("option"); option.value = String(i); option.textContent = p[0]; return option;
    }));
    select.value = String(selections[active]);
    const p = plans[active][selections[active]], list = document.createElement("ol");
    ["根拠を確認：", "仮説：", "次の検証：", "振り返り："].forEach((label, i) => {
      const li = document.createElement("li"); li.textContent = label + p[i+1]; list.append(li);
    });
    get("ah-plan").replaceChildren(list);
  }
  function show(key, { write = false, focus = false } = {}) {
    const previous = active;
    active = keys.includes(key) ? key : "attack";
    keys.forEach((k) => {
      const selected = k === active, tab = get("ah-tab-" + k);
      tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
      get("ah-panel-" + k).hidden = !selected;
    });
    if (write && location.hash !== "#" + active) history.pushState({}, "", location.pathname + location.search + "#" + active);
    if (focus) get("ah-tab-" + active).focus();
    renderPlan();
    if (active === "attack" && !attackLoaded) { attackLoaded = true; loadAttack(); }
    if (active === "proposal" && previous !== "proposal") window.SalesProposalJourney.show();
  }
  function init(options) {
    if (initialized) return;
    initialized = true; loadAttack = options.loadAttack;
    keys.forEach((key, index) => {
      const tab = get("ah-tab-" + key);
      tab.addEventListener("click", () => show(key, {write:true}));
      tab.addEventListener("keydown", (e) => {
        const next = e.key === "ArrowRight" ? keys[(index+1)%3] : e.key === "ArrowLeft" ? keys[(index+2)%3] : e.key === "Home" ? keys[0] : e.key === "End" ? keys[2] : null;
        if (next) { e.preventDefault(); show(next, {write:true,focus:true}); }
      });
    });
    get("ah-question").addEventListener("change", (e) => {
      const i = Number(e.target.value); if (Number.isInteger(i) && plans[active][i]) { selections[active] = i; renderPlan(); }
    });
    window.addEventListener("hashchange", () => show(location.hash.slice(1)));
    window.addEventListener("popstate", () => show(location.hash.slice(1)));
    show(location.hash.slice(1));
  }
  window.SalesAnalyticsHub = { init };
})();
