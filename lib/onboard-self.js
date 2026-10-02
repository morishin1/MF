// 本人（入社する人）に見せる入社準備の並べ方。
//
// 判定は作らない。lib/onboard-six.js の mapSix（audience:"self"）と、事実の読み取り
// （lib/onboard-stage.js stageFlags）を、本人にとって分かりやすいステップに「並べ替える」だけ。
// /keiei の入社準備一覧は mapSix をそのまま使うので、ここを変えても一覧は変わらない。
//
//   0. 入社案内を確認        … 案内が発行されているときだけ
//   1. 契約条件を確認        … 会社が労働条件を準備し終えたら、画面の「あなたの契約条件」で確認できる
//   2. 契約書を確認・署名    … 労働条件通知書の確認、または電子署名（既存の contract）
//   3. 入社情報を入力
//   4. 必要書類を提出
//   5. オリエンテーションを確認
//   6. 会社確認              … 会社が確認・準備する（本人の操作は無い）
//   7. 入社準備完了
//
// 本人がやること（actor=employee）と、会社がやること（それ以外）は、必ず分かる。
// 内部の言葉（DB・API・migration）は、ここにも画面にも出さない。

const step = (key, n, label, extra) => ({
  key, n, label, state: "todo", actor: null, actorLabel: null, note: "", ...extra,
});

/** 本人が押す先。入力・署名・提出は、これまでの画面で行う（作り直さない） */
export function ctaFor(key, x) {
  if (key === "guide") return { label: "入社案内を確認する", action: "guide" };
  if (key === "contract") {
    // 通知書を公開した人（電子署名の依頼が無い）は、この画面の中で確認する
    if (x?.noticePath && !x.signed) return { label: "労働条件を確認する", action: "notice" };
    return x && !x.signed
      ? { label: "契約書を確認して署名する", href: "/contracts.html" }
      : { label: "誓約書などを確認する", href: "/onboarding.html#consents-card" };
  }
  if (key === "info") return { label: "入社情報を入力する", href: "/onboarding.html#step-3" };
  if (key === "docs") return { label: "必要書類を提出する", href: "/onboarding.html#step-4" };
  if (key === "orientation") return { label: "オリエンテーションを確認する", href: "/onboarding.html#step-2" };
  return null;
}

/** 次にやることの文。「〜してください」。会社の番のときは待ってもらう言い方 */
const NEXT_TITLE = {
  guide: "入社案内を確認してください",
  contract_notice: "労働条件通知書を確認してください",
  contract_sign: "契約書を確認して、署名してください",
  contract_pledge: "誓約書などを確認してください",
  info: "入社情報を入力してください",
  docs: "必要書類を提出してください",
  orientation: "オリエンテーションを確認してください",
};

/**
 * @param {object} six  mapSix(...audience:"self") の結果
 * @param {object|null} x stageFlags(facts) | null（事実が読めない）
 */
export function selfSteps(six, x) {
  const by = (k) => six.steps.find((s) => s.key === k) || null;
  const guide = by("guide"), contract = by("contract"), info = by("info"), docs = by("docs");
  const company = by("company"), complete = by("complete");
  const unlinked = (s) => !s || s.state === "unlinked";
  const intake = six.stage === "intake" || six.stage === "complete";
  const out = [];

  if (guide && guide.state !== "na") {
    out.push(step("guide", 0, "入社案内を確認", { ...pick(guide) }));
  }

  // 1. 契約条件を確認（条件が揃って、本人が見られる状態か）
  if (unlinked(contract)) {
    out.push(step("conditions", 1, "契約条件を確認", { state: "unlinked" }));
  } else if (contract.state === "done" || contract.stage === "signing") {
    out.push(step("conditions", 1, "契約条件を確認", { state: "done", note: "「あなたの契約条件」でご確認いただけます" }));
  } else {
    out.push(step("conditions", 1, "契約条件を確認", {
      state: "current", actor: contract.actor, actorLabel: contract.actorLabel, note: "会社で準備しています" }));
  }

  // 2. 契約書を確認・署名
  if (unlinked(contract)) out.push(step("contract", 2, "契約書を確認・署名", { state: "unlinked" }));
  else if (contract.state === "done") out.push(step("contract", 2, "契約書を確認・署名", { state: "done", note: contract.note }));
  else if (contract.stage === "signing") out.push(step("contract", 2, "契約書を確認・署名", { ...pick(contract) }));
  else out.push(step("contract", 2, "契約書を確認・署名", { state: "todo", note: "会社の準備が終わると、確認・署名できます" }));

  // 3. 入社情報を入力
  out.push(step("info", 3, "入社情報を入力", { ...pick(info) }));

  // 4. 必要書類を提出 / 5. オリエンテーション（six の docs は、この2つをまとめている）
  if (unlinked(docs)) {
    out.push(step("docs", 4, "必要書類を提出", { state: "unlinked" }));
    out.push(step("orientation", 5, "オリエンテーションを確認", { state: "unlinked" }));
  } else if (!intake || !x) {
    out.push(step("docs", 4, "必要書類を提出", { ...pick(docs) }));
    out.push(step("orientation", 5, "オリエンテーションを確認", { state: docs.state === "done" ? "done" : "todo", note: docs.state === "done" ? "確認済み" : docs.note }));
  } else if (six.stage === "complete") {
    out.push(step("docs", 4, "必要書類を提出", { state: "done", note: "提出済み" }));
    out.push(step("orientation", 5, "オリエンテーションを確認", { state: "done", note: "確認済み" }));
  } else {
    out.push(x.employeeOpen
      ? step("docs", 4, "必要書類を提出", { state: "current", actor: "employee", actorLabel: "あなた", note: `書類の提出が ${x.employeeOpen} 件残っています` })
      : step("docs", 4, "必要書類を提出", { state: "done", note: "提出済み" }));
    out.push(x.orientationOk
      ? step("orientation", 5, "オリエンテーションを確認", { state: "done", note: "確認済み" })
      : step("orientation", 5, "オリエンテーションを確認", { state: "current", actor: "employee", actorLabel: "あなた", note: "確認がまだです" }));
  }

  // 6. 会社確認 / 7. 入社準備完了
  out.push(step("company", 6, "会社の確認", { ...pick(company) }));
  out.push(step("complete", 7, "入社準備完了", { ...pick(complete) }));

  for (const s of out) s.cta = s.state === "current" && s.actor === "employee" ? ctaFor(s.key === "contract" ? "contract" : s.key, x) : null;

  const counted = out.filter((s) => !["unlinked", "na"].includes(s.state));
  const done = counted.filter((s) => s.state === "done").length;

  // 次にやること（1つ）。本人の番のステップを先に
  const mine = out.find((s) => s.state === "current" && s.actor === "employee");
  const wait = out.find((s) => s.state === "current");
  let next;
  if (complete?.state === "done") {
    next = { key: null, title: "入社準備は完了しました", mine: false, done: true, cta: null,
      sub: "ご入社を楽しみにしています" };
  } else if (mine) {
    const k = mine.key === "contract"
      ? (x?.noticePath && !x.signed ? "contract_notice" : x && !x.signed ? "contract_sign" : "contract_pledge")
      : mine.key;
    next = { key: mine.key, title: NEXT_TITLE[k] || mine.label, mine: true, done: false, cta: mine.cta,
      sub: "あなたの操作が必要です" };
  } else if (wait) {
    next = { key: wait.key, title: wait.key === "conditions" ? "会社が契約条件を準備しています" : "会社の対応をお待ちください",
      mine: false, done: false, cta: null, sub: "いまは、あなたの操作は必要ありません" };
  } else {
    next = { key: null, title: "入社手続き情報を現在確認できません", mine: false, done: false, cta: null,
      sub: "管理担当者へお問い合わせください" };
  }

  // 現在（ひと言）
  let phase;
  if (complete?.state === "done") phase = { key: "done", label: "入社準備完了" };
  else if (out.some((s) => s.state === "current" && s.actor === "employee")) phase = { key: "self", label: "本人手続き中" };
  else if (wait) phase = { key: "company", label: "会社確認中" };
  else phase = { key: "unknown", label: "確認中" };

  return { steps: out, done, total: counted.length, next, phase };
}

function pick(s) {
  return { state: s.state, actor: s.actor, actorLabel: s.actorLabel, note: s.note };
}

/**
 * 必要書類の一覧（本人が出すもの）。「提出済みか・まだ必要か・会社確認済みか」が分かる言い方にする。
 * @param {object[]} items gw_procedure_items（owner / item_key / title / required / status）
 */
export function documentRows(items) {
  return (items || [])
    .filter((i) => i.owner === "employee" && String(i.item_key || "").startsWith("doc_") && i.item_key !== "doc_mynumber")
    .map((i) => {
      const state = i.status === "done" ? "confirmed" : i.status === "na" ? "na"
        : i.status === "submitted" ? "submitted" : "open";
      const label = { confirmed: "会社確認済み", na: "提出は不要", submitted: "提出済み（会社が確認中）", open: "未提出" }[state];
      return { key: i.item_key, title: i.title, required: i.required !== false, state, label };
    });
}
