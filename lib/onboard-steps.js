// 入社手続きのSTEP。6つ。全員が同じ並びを見る。
//
//   1. 社労士確認   … 社労士が労働条件通知書を確認・承認・発行する
//   2. 本人契約     … 本人が労働条件通知書・誓約書等を確認して締結する
//   3. 入社情報     … 本人が住所・連絡先・口座などを入力する
//   4. 必要書類     … 本人が書類を出し、オリエンテーションを確認する
//   5. 会社確認     … 管理者がPC・Slack・勤怠等の社内準備を終える
//   6. 完了
//
// ■ なぜ6つに変えたか
//
//   これまでは本人の画面だけの5STEPで、STEP1が「契約書確認・同意」だった。
//   社労士が確認している間、本人には「まだ何も出ていない」としか見えず、
//   管理者・社労士にも本人が今どこにいるかは別画面でしか分からなかった。
//
//   実際に動いている順番（管理者が入力→社労士が確認・承認・発行→
//   本人が契約→本人が情報・書類→会社が準備→完了）を、そのままSTEPにする。
//   3者とも同じ並びを見て、違うのは「どこまで見えるか」「何を押せるか」だけ
//   （api/onboarding/status.js、lib/onboard-viewer.js）。
//
// ■ 労働条件の作成・承認・発行は、作り直さない
//
//   admin-esign.html・advisor.html・api/sign/orders.js が、
//   管理者→社労士→発行の流れを既に持っている（gw_doc_orders → gw_sign_requests）。
//   STEP1・2はそこから生まれた事実（本人あての契約書面 contracts、
//   同意 consents）をそのまま使う。二重に判定を持たない。
//
// ■ 「会社確認」を独立させた
//
//   これまでは本人の4STEPが終わると、暗黙に「あとは会社の準備待ち」だった。
//   会社側の準備（PC・Slack・勤怠など）が止まっていても、
//   何が残っているかが1画面で見えなかった。STEPとして出す。
//   本人の情報入力・書類提出とは並行して進む（順番に待つものではない）。
//
// ■ 「今どこで止まっているか」は role.js が決める
//
//   STEPの done／current は役割によらない、ただ1つの事実。
//   「あなたの番です」か「○○さん待ち」かは、見ている人の役割で言い方が
//   変わるだけなので、ここでは決めない（statusBanner が決める）。
//
// ■ 純粋関数
//
//   表は読まない。api/onboarding/me.js・api/onboarding/status.js が事実を渡す。
//   テストは test/stepstest.mjs

export const STEPS = [
  { key: "advisor_check", n: 1, label: "社労士確認", icon: "fact_check",
    actor: "advisor", actorLabel: "社労士",
    todo: "労働条件通知書を確認して、承認・発行する" },
  { key: "contract",      n: 2, label: "本人契約",   icon: "history_edu",
    actor: "employee", actorLabel: "本人",
    todo: "労働条件通知書を確認して締結し、誓約書等に同意する" },
  { key: "profile",       n: 3, label: "入社情報",   icon: "edit_note",
    actor: "employee", actorLabel: "本人",
    todo: "住所・連絡先・振込口座などを入力して提出する" },
  { key: "documents",     n: 4, label: "必要書類",   icon: "upload_file",
    actor: "employee", actorLabel: "本人",
    todo: "手元の書類を出し、オリエンテーションを確認する" },
  { key: "company",       n: 5, label: "会社確認",   icon: "domain_verification",
    actor: "admin",    actorLabel: "管理者",
    todo: "PC・アカウント・勤怠などの社内準備を終える" },
  { key: "complete",      n: 6, label: "完了",       icon: "celebration",
    actor: null,        actorLabel: "—",
    todo: "" },
];
export const STEP_KEYS = STEPS.map((s) => s.key);
export const stepOf = (key) => STEPS.find((s) => s.key === key) || null;

const isDoneItem = (st) => st === "done" || st === "na";
const isInItem = (st) => isDoneItem(st) || st === "submitted";

/**
 * 事実から、6STEPを出す。
 *
 * @param {object} f
 *   contracts     [{ id, title, kind, status, dueOn, signedAt }]  本人あての契約書面（cancelled以外）
 *   consents      [{ key, title, agreed, needsReconsent }]         誓約書等
 *   orientation   [{ id, title, required, confirmed }]             教材と確認
 *   profileStatus "draft" | "submitted"
 *   missing       [{ label }]                                     届出の未入力
 *   documents     [{ key, title, required, collect, status }]     本人が出す書類（collect:false は数えない）
 *   internalItems [{ title, required, status }] | undefined       会社側準備（owner=hr、書類以外）。
 *                 渡せない呼び出し元は stage / procedureStatus で代わりに判定する
 *   stage         管理者の5段階（後方互換・completeの目安）
 *   procedureStatus "in_progress" | "done" | "cancelled"
 * @returns {{ steps: object[], current: string|null, pct: number, allMine: boolean }}
 */
export function computeSteps(f = {}) {
  const contracts = f.contracts || [];
  const consents = f.consents || [];
  const orientation = f.orientation || [];
  const documents = (f.documents || []).filter((d) => d.collect !== false);

  // ---- 1. 社労士確認 ----
  // 本人あての労働条件通知書（employment）は、社労士が承認・発行して初めて
  // gw_sign_requests に行ができる。無い＝まだ社労士が確認・修正している
  const employment = contracts.filter((c) => c.kind === "employment" || !c.kind);
  const advisorDone = employment.length > 0;

  // ---- 2. 本人契約 ----
  const pendingSign = contracts.filter((c) => c.status === "sent");
  const signedAll = contracts.length > 0 && pendingSign.length === 0;
  const consentsOk = consents.length > 0 && consents.every((c) => c.agreed && !c.needsReconsent);
  const contractItems = [
    ...employment.map((c) => ({
      label: c.title, done: c.status === "signed", href: "contracts.html",
      note: c.status === "signed" ? "締結済み" : `締結してください${c.dueOn ? `（期限 ${c.dueOn}）` : ""}`,
    })),
    ...consents.map((c) => ({
      label: c.title, done: c.agreed && !c.needsReconsent, href: "#step-2",
      note: c.agreed && !c.needsReconsent ? "同意済み"
        : c.needsReconsent ? "改定されました。読み直してください" : "読んで同意してください",
    })),
  ];
  const contractDone = advisorDone && signedAll && consentsOk;

  // ---- 3. 入社情報 ----
  const profileDone = f.profileStatus === "submitted";
  const missing = f.missing || [];
  const profileItems = [{
    label: "入社情報の届出", done: profileDone, href: "#step-3",
    note: profileDone ? "提出済み"
      : missing.length
        ? `あと ${missing.length} 項目（${missing.slice(0, 3).map((m) => m.label).join("・")}${missing.length > 3 ? "…" : ""}）`
        : "入力は済んでいます。「この内容で提出する」を押してください",
  }];

  // ---- 4. 必要書類（＋オリエンテーション）----
  const docRequired = documents.filter((d) => d.required !== false);
  const documentsDone = docRequired.every((d) => isInItem(d.status));
  const oriRequired = orientation.filter((o) => o.required !== false);
  const orientationDone = oriRequired.every((o) => o.confirmed);
  const documentItems = [
    ...documents.map((d) => ({
      label: d.title + (d.required === false ? "（任意）" : ""), done: isInItem(d.status), href: "#step-4",
      note: d.status === "na" ? "「ありません」で受け付けました"
        : d.status === "done" ? "会社が確認しました"
          : d.status === "submitted" ? "提出済み" : "未提出",
    })),
    ...orientation.map((o) => ({
      label: o.title, done: !!o.confirmed, href: "#step-4",
      note: o.confirmed ? "確認済み" : (o.required === false ? "任意" : "確認してください"),
    })),
  ];
  const step4Done = documentsDone && orientationDone;

  // ---- 5. 会社確認（本人の3・4と並行して進む）----
  const hasInternal = Array.isArray(f.internalItems);
  const internalRequired = hasInternal ? f.internalItems.filter((i) => i.required !== false) : [];
  const companyDone = hasInternal
    ? internalRequired.every((i) => isDoneItem(i.status))
    // 内訳を渡せない呼び出し元は、これまでどおり段階で代わりに判定する
    : (f.stage === "complete" || f.procedureStatus === "done");
  const companyItems = hasInternal
    ? f.internalItems.map((i) => ({
        label: i.title + (i.required === false ? "（任意）" : ""), done: isDoneItem(i.status),
        note: isDoneItem(i.status) ? "準備済み" : "準備中",
      }))
    : [];

  // ---- 6. 完了 ----
  const allMine = advisorDone && contractDone && profileDone && step4Done;
  const completeDone = f.stage === "complete" || f.procedureStatus === "done";

  const raw = [
    { key: "advisor_check", done: advisorDone,  items: [] },
    { key: "contract",      done: contractDone, items: contractItems },
    { key: "profile",       done: profileDone,  items: profileItems },
    { key: "documents",     done: step4Done,    items: documentItems },
    { key: "company",       done: companyDone,  items: companyItems },
    { key: "complete",      done: completeDone, items: [] },
  ];

  // 今どこで止まっているか。本人・社労士の並び（1〜4）を先に見て、
  // それが済んでいれば会社確認、それも済んでいれば完了
  const current = raw.slice(0, 4).find((s) => !s.done)?.key
    || raw.find((s) => !s.done)?.key || null;

  const steps = raw.map((s) => {
    const def = stepOf(s.key);
    const state = s.done ? "done" : s.key === current ? "current" : "todo";
    return {
      ...def, ...s, state,
      todo: s.key === "complete"
        ? (completeDone ? "すべての手続きが終わりました"
          : allMine ? "あなたの分は終わりました。会社側の準備が終わると完了になります"
            : "1〜5 が終わると完了になります")
        : def.todo,
    };
  });

  const done = steps.filter((s) => s.done).length;
  return { steps, current, pct: Math.round((done / steps.length) * 100), allMine };
}

/**
 * 「今どこで止まっているか」を、見ている人ごとの言い方にする。
 *
 * 同じ事実でも、いま動く番の人には「あなたの番です」、
 * それ以外の人には「○○さん待ち」と伝える。STEPの done/current は
 * 役割で変えない、ただ1つの事実（computeSteps）。言い方だけをここで変える。
 *
 * @param {{steps:object[], current:string|null}} r  computeSteps() の戻り値
 * @param {'self'|'admin'|'advisor'} viewerRole
 */
export function statusBanner(r, viewerRole) {
  const cur = r.steps.find((s) => s.key === r.current);
  if (!cur) {
    return { title: "入社手続き完了", detail: "すべての手続きが終わりました。", nextActorLabel: "—" };
  }

  const myTurn = viewerRole === "self" ? cur.actor === "employee"
    : viewerRole === "admin" ? cur.actor === "admin"
      : viewerRole === "advisor" ? cur.actor === "advisor" : false;

  if (myTurn) {
    return {
      title: cur.key === "advisor_check" ? "確認をお願いします"
        : cur.key === "company" ? "社内準備をお願いします"
          : "あなたの確認が必要です",
      detail: cur.todo,
      nextActorLabel: cur.actorLabel,
      mine: true,
    };
  }

  return {
    title: `${cur.label}待ち`,
    detail: cur.key === "advisor_check" ? "労働条件通知書を社労士が確認しています。"
      : cur.key === "contract" ? "労働条件通知書を送付済みです。本人の契約をお待ちください。"
        : cur.key === "company" ? "本人の手続きは完了しています。会社側の準備をお待ちください。"
          : `${cur.actorLabel}の対応をお待ちください。`,
    nextActorLabel: cur.actorLabel,
    mine: false,
  };
}
