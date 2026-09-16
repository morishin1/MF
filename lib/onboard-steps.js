// 本人の画面の STEP。5つ。
//
//   1. 契約書確認・同意   … 労働条件通知書の締結 ＋ 誓約書等の同意
//   2. オリエンテーション … 会社説明・社内ルール等を「確認済み」に
//   3. 入社情報入力       … 住所・連絡先・口座など（届出）
//   4. 必要書類提出       … 履歴書・扶養控除等申告書など
//   5. 完了               … 社内準備も終わって、手続き全体が完了
//
// ■ 管理者の5段階（lib/onboard-stage.js）とは別の軸
//
//   管理者の段階は「いま誰の番か」。本人の STEP は「本人が何をすればよいか」。
//   管理者の ③④ が、本人には 1〜4 に分かれて見える。
//   混ぜると、本人の画面に「社労士確認」が出てきて、本人にはやることが無い段階を
//   本人が眺めることになる。
//
// ■ 並行してよい
//
//   契約書がまだ届いていなくても（会社側の準備中）、情報の入力や書類の提出はできる。
//   「今やること」は、本人が動ける最初の STEP。待つしかない STEP は飛ばす。
//
// ■ 純粋関数
//
//   表は読まない。api/onboarding/me.js が事実を渡す。テストは test/stepstest.mjs

export const EMP_STEPS = [
  { key: "contract",    n: 1, label: "契約書確認・同意", icon: "history_edu",
    todo: "労働条件通知書を確認して締結し、3つの書類にチェックを入れる" },
  { key: "orientation", n: 2, label: "オリエンテーション", icon: "school",
    todo: "会社説明・社内ルールを読んで、確認済みにする" },
  { key: "profile",     n: 3, label: "入社情報入力", icon: "edit_note",
    todo: "住所・連絡先・振込口座などを入力して提出する" },
  { key: "documents",   n: 4, label: "必要書類提出", icon: "upload_file",
    todo: "手元の書類を出す。無いものは「ありません」を押す" },
  { key: "complete",    n: 5, label: "完了", icon: "celebration",
    todo: "" },
];
export const EMP_STEP_KEYS = EMP_STEPS.map((s) => s.key);

const isIn = (st) => st === "submitted" || st === "done" || st === "na";

/**
 * 事実から、本人の STEP を出す。
 *
 * @param {object} f
 *   contracts    [{ id, title, status, dueOn, signedAt }]   自分あての署名依頼（取消し以外）
 *   consents     [{ key, title, agreed, needsReconsent }]   同意書類の状態
 *   orientation  [{ id, title, required, confirmed }]        教材と確認
 *   profileStatus "draft" | "submitted"
 *   missing      [{ label }]                                 届出の未入力
 *   documents    [{ key, title, required, collect, status }] 出す書類（collect:false は数えない）
 *   stage        管理者の段階（"complete" なら 5 も済み）
 *   procedureStatus "in_progress" | "done" | "cancelled"
 * @returns {{ steps: object[], current: string|null, pct: number, allMine: boolean }}
 */
export function computeSteps(f = {}) {
  const contracts = f.contracts || [];
  const consents = f.consents || [];
  const orientation = f.orientation || [];
  const documents = (f.documents || []).filter((d) => d.collect !== false);

  // ---- 1. 契約書・同意 ----
  const employment = contracts.filter((c) => c.kind === "employment" || !c.kind);
  const pendingSign = contracts.filter((c) => c.status === "sent");
  const signedAll = contracts.length > 0 && pendingSign.length === 0;
  // 労働条件通知書がまだ届いていない＝会社側（社労士）の準備中。本人は待つだけ
  const waitingContract = employment.length === 0;
  const consentsOk = consents.length > 0 && consents.every((c) => c.agreed && !c.needsReconsent);
  const contractItems = [
    ...(waitingContract
      ? [{ label: "労働条件通知書・雇用契約書", done: false, waiting: true,
           note: "会社が準備中です。届いたらお知らせします" }]
      : contracts.map((c) => ({
          label: c.title, done: c.status === "signed", href: "contracts.html",
          note: c.status === "signed" ? "締結済み" : `締結してください${c.dueOn ? `（期限 ${c.dueOn}）` : ""}`,
        }))),
    ...consents.map((c) => ({
      label: c.title, done: c.agreed && !c.needsReconsent, href: "#step-1",
      note: c.agreed && !c.needsReconsent ? "同意済み" : c.needsReconsent ? "改定されました。読み直してください" : "読んで同意してください",
    })),
  ];
  const contractDone = signedAll && consentsOk;

  // ---- 2. オリエンテーション ----
  const oriRequired = orientation.filter((o) => o.required !== false);
  const orientationDone = oriRequired.every((o) => o.confirmed);
  const orientationItems = orientation.map((o) => ({
    label: o.title, done: !!o.confirmed, href: "#step-2",
    note: o.confirmed ? "確認済み" : (o.required === false ? "任意" : "確認してください"),
  }));

  // ---- 3. 入社情報 ----
  const profileDone = f.profileStatus === "submitted";
  const missing = f.missing || [];
  const profileItems = [{
    label: "入社情報の届出", done: profileDone, href: "#step-3",
    note: profileDone ? "提出済み"
      : missing.length ? `あと ${missing.length} 項目（${missing.slice(0, 3).map((m) => m.label).join("・")}${missing.length > 3 ? "…" : ""}）`
        : "入力は済んでいます。「この内容で提出する」を押してください",
  }];

  // ---- 4. 書類 ----
  const docRequired = documents.filter((d) => d.required !== false);
  const documentsDone = docRequired.every((d) => isIn(d.status));
  const documentItems = documents.map((d) => ({
    label: d.title + (d.required === false ? "（任意）" : ""), done: isIn(d.status), href: "#step-4",
    note: d.status === "na" ? "「ありません」で受け付けました"
      : d.status === "done" ? "会社が確認しました"
        : d.status === "submitted" ? "提出済み" : "未提出",
  }));

  // ---- 5. 完了 ----
  const allMine = contractDone && orientationDone && profileDone && documentsDone;
  const completeDone = f.stage === "complete" || f.procedureStatus === "done";

  const raw = [
    { key: "contract",    done: contractDone,    waiting: waitingContract && consentsOk, items: contractItems },
    { key: "orientation", done: orientationDone, items: orientationItems },
    { key: "profile",     done: profileDone,     items: profileItems },
    { key: "documents",   done: documentsDone,   items: documentItems },
    { key: "complete",    done: completeDone,    waiting: allMine && !completeDone, items: [] },
  ];

  // 今やること＝本人が動ける最初の STEP。待つだけの STEP は飛ばす
  const current = raw.find((s) => !s.done && !s.waiting)?.key
    || raw.find((s) => !s.done)?.key || null;

  const steps = raw.map((s) => {
    const def = EMP_STEPS.find((d) => d.key === s.key);
    // 待つだけの STEP は、たとえ現在地でも「待ち」と出す。
    // 本人が押せるものが無いのに「今やること」に見えると、探し続けることになる
    const state = s.done ? "done" : s.waiting ? "waiting" : s.key === current ? "current" : "todo";
    return { ...def, ...s, state,
      // 完了の STEP の説明は、そのときの状態で変える
      todo: s.key === "complete"
        ? (completeDone ? "すべての手続きが終わりました" : allMine ? "あなたの分は終わりました。会社側の準備が終わると完了になります" : "1〜4 が終わると、会社側の準備を待って完了になります")
        : def.todo,
    };
  });

  const done = steps.filter((s) => s.done).length;
  return { steps, current, pct: Math.round((done / steps.length) * 100), allMine };
}
