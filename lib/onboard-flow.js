// 入社の人別画面（入退社管理 ＞ 入社の詳細）に出す、6つの段階と「次にすること」。
//
//   基本情報 → 契約書の準備 → 本人の確認・署名 → 入社情報・必要書類 → アカウント・貸与品 → 会社確認・完了
//
// ■ 新しい判定を作らない
//   済んだか・止まっているかは、既存の lib/onboard-stage.js（stageFlags / computeStage）が決める。
//   ここはその結果と、表から読んだ事実（署名依頼の閲覧・期限、チェックリストの項目）を、この並びに置くだけの純粋関数。
//   並びは進み具合を分かりやすくする案内で、実際の作業は並行して進む（直列にしない）。
//
// ■ 区別して見せる
//   署名依頼済み ≠ 締結済み／本人の提出 ≠ 会社の確認／入社日が来た ≠ 手続き完了
//   閲覧は「本人が署名画面で書類を開いた記録」（読み終えた証明ではない）
//   対象外（na）は未完了に数えない

import { stageFlags, computeStage } from "./onboard-stage.js";

export const FLOW_STEPS = [
  { key: "basic",    label: "基本情報" },
  { key: "contract", label: "契約書の準備" },
  { key: "sign",     label: "本人の確認・署名" },
  { key: "intake",   label: "入社情報・必要書類" },
  { key: "setup",    label: "アカウント・貸与品" },
  { key: "company",  label: "会社確認・完了" },
];

const slash = (d) => (d ? String(d).slice(0, 10).replace(/-/g, "/") : "");
const SOURCE_LABEL = { uploaded: "作成済みPDF", advisor: "作成依頼（社労士）", template: "入力して作成" };

/**
 * @param {object} p
 *   facts      gatherFacts の結果（procedure・order・sign・profile・consentsOk・items・notice）
 *   sign       最新の署名依頼の詳細 { status, source, first_viewed_at, due_on, sent_at, signed_at } | null
 *   employee   { user_id, joined_on }
 *   targetOn   入社日（手続きの日付）
 *   items      チェックリスト [{ owner, category, required, status, title, due_on }]
 *   assets     この人に貸し出している貸与品の数
 *   today      日本時間の YYYY-MM-DD
 */
export function onboardFlow({ facts, sign = null, employee = {}, targetOn = null, items = [], assets = 0, today }) {
  const x = stageFlags(facts || {});
  const stage = computeStage(facts || {});
  const hasAccount = Boolean(employee?.user_id);
  const isDone = (i) => i.status === "done" || i.status === "na";
  const required = (i) => i.required !== false && i.status !== "na";

  // 1. 基本情報：入社日と、本人のアカウント（無いと署名画面に入れない）
  const basic = { key: "basic", state: targetOn && hasAccount ? "done" : "current",
    status: `${targetOn ? `入社日 ${slash(targetOn)}` : "入社日 未設定"}・本人のアカウント${hasAccount ? "あり" : "なし"}`,
    actions: hasAccount && targetOn ? [] : ["basic"],
    note: hasAccount ? "" : "アカウントが無いと、本人は署名画面に入れません。先にメンバー管理で作ってください（契約の署名のために Office の権限は付けません）" };

  // 2. 契約書の準備
  const order = x.order;
  let contract;
  if (x.issued) {
    const src = SOURCE_LABEL[sign?.source] || (sign ? "入力して作成" : x.noticePath ? "労働条件通知書（公開）" : "準備済み");
    contract = { key: "contract", state: "done", status: `準備済み（${src}）`, actions: [] };
  } else if (order?.status === "uploaded") {
    contract = { key: "contract", state: "current", status: "書面あり・送付前", actions: ["send_order"] };
  } else if (order?.status === "requested") {
    contract = { key: "contract", state: "current", status: "作成を依頼中（依頼先の対応待ち）", actions: ["order"] };
  } else {
    contract = { key: "contract", state: "current", status: "未準備", actions: ["make", "pdf"] };
  }

  // 3. 本人の確認・署名
  let signStep;
  if (!x.issued) signStep = { key: "sign", state: "todo", status: "契約書の準備のあと", actions: [] };
  else if (x.signed && x.consentsOk) signStep = { key: "sign", state: "done", status: x.noticePath ? "確認済み" : "締結済み", actions: [] };
  else if (x.signed) signStep = { key: "sign", state: "current", status: `${x.noticePath ? "確認済み" : "締結済み"}・誓約書／同意の確認待ち`, actions: ["self"] };
  else {
    const flags = [];
    if (sign?.first_viewed_at) flags.push("閲覧記録あり");
    const late = Boolean(sign?.due_on && sign.due_on < today);
    if (late) flags.push("期限超過");
    signStep = { key: "sign", state: "current",
      status: `${x.noticePath ? "通知書を公開済み・本人の確認待ち" : "署名依頼済み・本人の署名待ち"}${flags.length ? `（${flags.join("・")}）` : ""}`,
      dueOn: sign?.due_on || null, late, actions: x.noticePath ? [] : ["sign_status"] };
  }

  // 4. 入社情報・必要書類（本人の提出と、会社の確認を分ける）
  const empItems = items.filter((i) => i.owner === "employee" && required(i));
  const notSubmitted = empItems.filter((i) => i.status === "todo").length;
  const waitingReview = empItems.filter((i) => i.status === "submitted").length;
  const intakeDone = x.profileSubmitted && notSubmitted === 0 && waitingReview === 0;
  const intake = { key: "intake", state: intakeDone ? "done" : x.signed ? "current" : "todo",
    status: `本人の提出：入社情報 ${x.profileSubmitted ? "済み" : "未提出"}・書類 ${notSubmitted ? `残り${notSubmitted}件` : "済み"}／会社の確認：${waitingReview ? `${waitingReview}件待ち` : "待ちなし"}`,
    actions: notSubmitted || !x.profileSubmitted ? ["guide"] : waitingReview ? ["review"] : [] };

  // 5. アカウント・貸与品（社内の準備。本人の作業と並行して進む）
  const setupItems = items.filter((i) => i.owner !== "employee" && ["account", "equipment"].includes(i.category) && required(i));
  const setupOpen = setupItems.filter((i) => !isDone(i)).length;
  const setup = { key: "setup", state: setupItems.length === 0 ? "na" : setupOpen ? "current" : "done",
    status: setupItems.length === 0 ? `対象の項目なし・貸与品 ${assets}件` : `残り${setupOpen}件／全${setupItems.length}件・貸与品 ${assets}件`,
    actions: setupOpen ? ["setup", "assets"] : ["assets"] };

  // 6. 会社確認・完了（必須の項目がすべて済むと、既存の判定で「完了」になる。入社日が来ただけでは完了にしない）
  const internalOpen = items.filter((i) => i.owner !== "employee" && required(i) && !isDone(i)).length;
  const complete = stage.key === "complete" && !stage.cancelled;
  const company = { key: "company", state: complete ? "done" : "todo",
    status: complete ? "入社準備 完了" : `必須の未完了：社内 ${internalOpen}件${stage.blockers?.length ? `・${stage.blockers[0]}` : ""}`,
    note: complete ? "" : `必須の項目がすべて済むと、自動で完了になります。${targetOn && targetOn <= today ? "入社日を過ぎていますが、手続きはまだ完了していません。" : ""}`,
    actions: [] };

  const steps = [basic, contract, signStep, intake, setup, company]
    .map((s) => ({ ...FLOW_STEPS.find((d) => d.key === s.key), ...s }));

  // 次にすること：いちばん先に手を付けるべきもの（契約・署名が進まないと、本人は何もできない）
  const order1 = ["basic", "contract", "sign", "intake", "setup", "company"];
  const first = order1.map((k) => steps.find((s) => s.key === k)).find((s) => s.state === "current") || null;
  const WHO = { basic: "人事", contract: "人事", sign: "本人", intake: waitingReview && !notSubmitted && x.profileSubmitted ? "人事" : "本人", setup: "人事", company: "人事" };
  const TEXT = {
    basic: hasAccount ? "入社日を入れる" : "本人のアカウントを作る",
    contract: contract.status === "書面あり・送付前" ? "契約書を確認して送る" : contract.status.startsWith("作成を依頼中") ? "作成の依頼先からの書面を待つ" : "契約書を準備する",
    sign: signStep.status.includes("誓約書") ? "本人の誓約書・同意の確認待ち" : "本人の署名待ち",
    intake: WHO.intake === "人事" ? "提出された書類を確認する" : "本人の入社情報・書類の提出待ち",
    setup: "アカウント・貸与品を準備する",
    company: "残っている社内の項目を済ませる",
  };
  const next = first
    ? { step: first.key, text: TEXT[first.key], who: WHO[first.key],
        dueOn: first.dueOn || targetOn || null, late: Boolean(first.late || (targetOn && targetOn < today && !complete)) }
    : (complete ? null : { step: "company", text: TEXT.company, who: "人事", dueOn: targetOn || null, late: false });

  const counted = steps.filter((s) => s.state !== "na");
  return { steps, next, done: counted.filter((s) => s.state === "done").length, total: counted.length, complete, stageKey: stage.key };
}
