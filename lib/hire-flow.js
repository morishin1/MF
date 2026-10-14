// Office の入社の流れ。「いま何をするか」（NEXT ACTION）を、次の4つの言い方にそろえる。純関数。
//
//   ① 入社書類  ② アカウント・端末  ③ オリエンテーション  ④ 入社完了
//
//   HR で正式契約（LegalSign）まで完了して、HR が Office へ引き渡す。Office は「入社書類」から始まる。
//     HRで正式契約まで完了 → 入社書類 → アカウント・端末 → オリエンテーション → 入社完了
//   「正式契約」は Office の段ではない（HR の採用条件・契約フローで終わっている。引き渡し＝その完了の印）。
//
// ■ 第3の判定は作らない
//   Office には入社の判定がすでに2つある（段階 lib/onboard-stage.js・6ステップ lib/onboard-six.js）。
//   ここはその「事実の読み取り」（stageFlags / computeStage）を、4つの言い方に並べ直すだけで、数え直さない
//   （署名が済んだか・書類の残りは何件かを、ここで別に決めない）。
//   ① 入社書類 は、既存の「契約書類（労働条件通知書・契約書の準備 → 社労士の確認 → 本人の締結）」と
//   「入社情報・本人の提出書類」をまとめて言う（雇用契約書・NDA・扶養控除等申告書などの入社・契約書類。HR の LegalSign とは別）。
//   社員登録の前（入社手続きがまだ無い）は、①の入り口＝「社員登録をして、入社書類の依頼を始める」と言う。
//
// ■ 出さないもの
//   給与・連絡先・承諾の IP などは扱わない（状態と件数だけ）。
import { computeStage, stageFlags } from "./onboard-stage.js";

export const HIRE_STEPS = [
  { key: "docs",        n: 1, label: "入社書類",           action: "入社書類を集める",           icon: "upload_file" },
  { key: "account",     n: 2, label: "アカウント・端末",   action: "アカウント・端末を用意する", icon: "devices" },
  { key: "orientation", n: 3, label: "オリエンテーション", action: "オリエンテーションを行う",   icon: "co_present" },
  { key: "complete",    n: 4, label: "入社完了",           action: "入社完了",                   icon: "task_alt" },
];
export const HIRE_KEYS = HIRE_STEPS.map((s) => s.key);
export const hireStepOf = (key) => HIRE_STEPS.find((s) => s.key === key) || null;

/** 4つの前に付ける印（Office のステップではない）。HR で終わっていること */
export const HIRE_FROM_HR_LABEL = "HRで正式契約まで完了";

/** 誰の番か（段階の actor → 画面の言い方） */
export const HIRE_ACTOR_LABEL = { admin: "人事・労務", advisor: "社労士", employee: "本人" };

const step = (key, state, extra = {}) => {
  const def = hireStepOf(key);
  return { key, n: def.n, label: def.label, icon: def.icon, state, actor: null, actorLabel: null, note: "", ...extra };
};
const actorOf = (a) => ({ actor: a, actorLabel: HIRE_ACTOR_LABEL[a] || null });

/**
 * HR から引き渡された人の「HR で終えたこと」（4つの前に付ける印）。引き渡されていない人は null
 * @param {{formalRequired?: boolean|null, formalSignedAt?: string|null}|null} h handoffFactsOf の結果
 */
export function hrDoneOf(h) {
  if (!h) return null;
  return {
    label: HIRE_FROM_HR_LABEL,
    detail: h.formalRequired === false ? "正式契約：不要" : "正式契約：署名済み",
    formalRequired: h.formalRequired !== false, formalSignedAt: h.formalSignedAt || null,
  };
}

/**
 * @param {object} p
 *   handoff  HR から引き渡された版の情報（handoffFactsOf）| null（HR を通らない人）
 *   facts    入社手続きの事実（gatherFacts / gatherFactsBulk の1人ぶん）| null（社員登録の前）
 * @returns {{
 *   hr: {label:string, detail:string, formalRequired:boolean, formalSignedAt:string|null}|null,
 *   steps: {key:string, n:number, label:string, icon:string, state:"done"|"current"|"todo"|"na", actor:string|null, actorLabel:string|null, note:string}[],
 *   next: {key:string, label:string, phase:string, actor:string|null, actorLabel:string|null, note:string, done:boolean},
 *   registered: boolean, complete: boolean, cancelled: boolean
 * }}
 */
export function hireFlowOf({ handoff = null, facts = null } = {}) {
  const registered = Boolean(facts);
  const x = facts ? stageFlags(facts) : null;
  const at = facts ? computeStage(facts).key : null;
  const cancelled = Boolean(x?.cancelled);
  const reached = at === "intake" || at === "complete";     // 契約書類の締結が済み、入社情報・書類・社内準備に進んだ
  const done = at === "complete" && !cancelled;

  // HR の LegalSign の正式契約は済んでいる人が、Office で契約書類（雇用契約書など）の準備・締結に進むとき、別の書類の話だと分かるようにする
  const lead = handoff && handoff.formalRequired !== false && handoff.formalSignedAt ? "LegalSign の正式契約は HR で済んでいます。" : "";

  // ---- ① 入社書類 ----
  let docs;
  if (cancelled) {
    docs = step("docs", "na", { note: "入社手続きは取り消されています" });
  } else if (!registered) {
    docs = step("docs", "current", { ...actorOf("admin"), note: "社員登録をして、入社書類の依頼を始めます" });
  } else if (done) {
    docs = step("docs", "done", { note: "提出済み" });
  } else if (!reached) {
    // 契約書類：労働条件通知書・契約書の準備 → 社労士の確認 → 本人の締結（段階 conditions / advisor_review / signing）
    if (!x.ordered) docs = step("docs", "todo", { ...actorOf("admin"), note: `${lead}契約書類の準備がまだです（入力して作る・作成済みPDFを使う・作成を依頼する）` });
    else if (!x.issued) docs = step("docs", "todo", { ...actorOf("advisor"), note: `${lead}${x.orderUploaded ? "書面は届いています。発行がまだです" : "社労士の確認待ちです"}` });
    else {
      const b = [];
      if (!x.signed) b.push(x.noticePath ? "労働条件通知書の確認がまだです" : "契約書類の締結がまだです");
      if (!x.consentsOk) b.push("誓約書・同意の確認がまだです");
      docs = step("docs", "todo", { ...actorOf("employee"), note: `${lead}${b.join("／")}` });
    }
  } else {
    // 契約書類は済み：入社情報の入力・本人の提出書類
    const open = [];
    if (!x.profileSubmitted) open.push("入社情報の入力がまだです");
    if (x.employeeOpen) open.push(`書類の提出が ${x.employeeOpen} 件残っています`);
    docs = open.length
      ? step("docs", "todo", { ...actorOf("employee"), note: open.join("／") })
      : step("docs", "done", { note: "提出済み" });
  }

  // ---- ② アカウント・端末 / ③ オリエンテーション ----
  let account, orientation;
  if (cancelled) {
    account = step("account", "na"); orientation = step("orientation", "na");
  } else if (done) {
    account = step("account", "done", { note: "準備済み" });
    orientation = step("orientation", "done", { note: "確認済み" });
  } else if (!registered) {
    account = step("account", "todo", { note: "社員登録のあとに始まります" });
    orientation = step("orientation", "todo", { note: "社員登録のあとに始まります" });
  } else if (!reached) {
    // 入社書類（契約書類の締結）が済むまで始まらない。社内準備の残りは、ここで数だけ見せる
    account = step("account", "todo", { note: x.internalOpen ? `社内準備 ${x.internalOpen} 件（契約書類の締結後に確認します）` : "契約書類の締結後に確認します" });
    orientation = step("orientation", "todo", { note: "契約書類の締結後に始まります" });
  } else {
    account = x.internalOpen
      ? step("account", "todo", { ...actorOf("admin"), note: `社内準備が ${x.internalOpen} 件残っています` })
      : step("account", "done", { note: "準備済み" });
    orientation = x.orientationOk
      ? step("orientation", "done", { note: "確認済み" })
      : step("orientation", "todo", { ...actorOf("employee"), note: "オリエンテーションの確認がまだです" });
  }

  const complete = step("complete", done ? "done" : cancelled ? "na" : "todo",
    { note: done ? "入社手続きは完了しました" : cancelled ? "" : "①〜③ がそろうと完了になります" });

  // いまの番は、順番の最初の「済んでいない」ステップ（並行して進むものは、各ステップの note に残りを書く）
  const steps = [docs, account, orientation, complete];
  const cur = cancelled ? null : steps.find((s) => s.key !== "complete" && !["done", "na"].includes(s.state)) || null;
  if (cur) cur.state = "current";

  let next;
  if (cancelled) next = { key: "docs", label: "入社手続きは取り消されました", phase: "—", actor: null, actorLabel: null, note: "", done: false };
  else if (cur) {
    const def = hireStepOf(cur.key);
    next = { key: cur.key, label: def.action, phase: def.label, actor: cur.actor, actorLabel: cur.actorLabel, note: cur.note, done: false };
  } else {
    const def = hireStepOf("complete");
    next = { key: "complete", label: def.action, phase: def.label, actor: null, actorLabel: null, note: complete.note, done };
  }

  return { hr: hrDoneOf(handoff), steps, next, registered, complete: done, cancelled };
}
