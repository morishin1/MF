// 月末月初業務（/office）：「今月、何が止まっているか」を、既存の印から導く。
//
// ■ 何を材料にするか（Phase 2 は、DB を増やさない）
//
//   月×要員×現場契約の1行（gw_billing_progress、db/077）の5つの印と、
//   届いたファイル（gw_submissions、db/080）だけ。
//     勤務表受領 → 稼働確認 → Board作成 → 送付 → BP請求書受領
//   状態（未提出／提出済…）や現在工程は、保存せずここで導く。保存すると、印を直したときに古くなる。
//
// ■ Phase 3：勤務表の状態・稼働時間・契約条件を、任意で受け取る（raw.sheet / raw.terms / raw.settle）
//
//   無ければ、これまでどおり印だけで導く（月初作業管理の既存の運用を壊さない）。
//   ある場合は、印を置き換えず、状態の細かさだけを足す：
//     ・稼働確認の欄に、確定した稼働時間（確認済 162.5h）／確認待ち／未読取／差し戻し／手動の印 を出す
//     ・印と勤務表の状態が食い違うときは「要確認」にする（例：稼働確認の印があるが、勤務表は下書きのまま）
//     ・稼働を確定したのに契約条件が決まらず精算できない行に、terms の印を付ける
//
// ■ 請求書は、この1行と1対1にしない
//
//   実務では、BP会社が複数要員ぶんを1枚で請求してくる。売上も、1客先に複数要員・複数案件を
//   1枚でまとめる。将来の請求は「請求書ヘッダ＋請求明細」で持ち、明細がこの行
//   （billing_progress）を指す（docs/office-migration-plan.md）。
//   だから売上請求・仕入請求の状態は、ここでは「この行の印から見た状態」として導いており、
//   請求書1枚の状態とは言わない。Phase 5・6 で、明細が指す請求書の状態から導く形に置き換える。
//
// ■ 単価は読まない・出さない
//
//   既存の unit_price は、売上単価か仕入単価かがまだ確認できていない（意味を決めていない）。
//   Phase 2 の一覧・詳細は単価に触れない。
//
// ■ 完了の考え方（要件 §27）
//
//   売上のみ（PP）… 勤務表・稼働確認・請求送付が済めば完了
//   売上＋仕入（BP）… さらに仕入請求の確認と支払済みまで。支払の管理は Phase 7 なので、
//                    いまは「支払準備」まで。完了にはしない（支払の記録が無いのに完了と言わない）
//
// 純関数だけ。DB も日付の「いま」も、呼び出し側が渡す（test/officetest.mjs）

import { bizDaysOfMonth, ymAdd, dateStr } from "./holidays.js";
import { formatHours } from "./office-time.js";
import { SHEET_STATE } from "./office-timesheet.js";

/** 勤務表の提出期限：対象月の翌月の第n営業日（初期値：第3営業日。要件 §8） */
export const DEADLINE_BIZDAY = 3;

/** その月の勤務表の提出期限（YYYY-MM-DD）。営業日が足りなければ null */
export function timesheetDeadline(month, nth = DEADLINE_BIZDAY) {
  const days = bizDaysOfMonth(ymAdd(month, 1));
  return days.length >= nth ? dateStr(days[nth - 1]) : null;
}

/** 工程。上から順に進む。前の工程が済むまで、次には進まない */
export const STAGES = [
  { key: "timesheet",      label: "勤務表待ち" },
  { key: "work",           label: "稼働確認待ち" },
  { key: "invoice_create", label: "請求作成待ち" },
  { key: "invoice_send",   label: "請求送付待ち" },
  { key: "vendor",         label: "仕入請求待ち" },
  { key: "payment",        label: "支払準備" },
  { key: "done",           label: "完了" },
];
const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));

/**
 * 絞り込みの選択肢。一覧の行は tags でこれに答える（画面は tags を見るだけで、条件を持たない）
 *   invoice … 請求作成待ち・請求送付待ち（＝売上請求がまだ送られていない）
 */
export const FILTERS = [
  { key: "timesheet", label: "勤務表待ち" },
  { key: "overdue",   label: "勤務表 期限超過" },
  { key: "work",      label: "稼働確認待ち" },
  { key: "invoice",   label: "請求未送付" },
  { key: "vendor",    label: "仕入請求待ち" },
  { key: "payment",   label: "支払準備" },
  { key: "terms",     label: "契約条件の確認" },
  { key: "check",     label: "要確認" },
  { key: "done",      label: "完了" },
];

export const KIND_LABEL = { pp: "PP（自社）", bp: "BP" };

/** YYYY-MM-DD → M/D */
export const md = (d) => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? `${Number(m[1])}/${Number(m[2])}` : "";
};

/**
 * 1行ぶんの状態を導く。
 *
 * @param {object} raw
 *   engagementKind: 'pp'|'bp'  employeeName, employeeKind('proper'|'bp'), employeeStatus, partnerName
 *   siteCompany, primeCompany, periodFrom, periodTo, renewalStatus
 *   marks: { timesheet_received, work_confirmed, board_created, sent, bp_invoice_received, （それぞれの *_at） }
 *   submissions: [{ id, kind: 'timesheet'|'invoice', fileName, submittedAt }]
 *   payable（db/117 があるときだけ。無ければ undefined）: null＝BP請求書の金額が未登録
 *     { invoiceStatus: 'received'|'approved', match: 'match'|'mismatch'|'unknown', issues: [文],
 *       paymentStatus: null|'scheduled'|'paid', scheduledOn, paidOn }
 * @param {{ today: string, deadline: string|null }} ctx  today は日本時間の YYYY-MM-DD
 */
export function deriveRow(raw, { today, deadline } = {}) {
  const m = raw.marks || {};
  const recv = !!m.timesheet_received;
  const conf = !!m.work_confirmed;
  const made = !!m.board_created;
  const sent = !!m.sent;
  const bp = !!m.bp_invoice_received;
  const usesVendor = raw.engagementKind === "bp";   // 売上のみ（PP）は、仕入・支払が対象外

  // 現在工程：最初に済んでいない工程
  let stage;
  if (!recv) stage = "timesheet";
  else if (!conf) stage = "work";
  else if (!made) stage = "invoice_create";
  else if (!sent) stage = "invoice_send";
  else if (usesVendor && !bp) stage = "vendor";
  // 支払：db/117 が無い（payable が undefined）ときは、記録が無いので「支払準備」で止める（完了にしない）
  else if (usesVendor && raw.payable?.paymentStatus !== "paid") stage = "payment";
  else stage = "done";
  const pay = usesVendor ? raw.payable : undefined;

  const overdue = stage === "timesheet" && !!deadline && !!today && today > deadline;

  // 要確認（人が見ないと分からないもの）。ある行は他の行を止めず、その行だけ印をつける
  const warnings = [];
  const chain = [recv, conf, made, sent];
  for (let i = 1; i < chain.length; i++) {
    if (chain[i] && !chain[i - 1]) {
      warnings.push("勤務表・稼働・請求の印が、順番どおりについていません");
      break;
    }
  }
  const files = raw.submissions || [];
  if (!recv && files.some((s) => s.kind === "timesheet")) {
    warnings.push("勤務表のファイルは届いていますが、受領の印がついていません");
  }
  // 退職済みの要員に、終了日が空のままの契約が残っていると、永遠に「勤務表待ち」で出続ける。
  // 隠すと、当月に退職した人の最後の月次を見落とす。隠さず、その行に印をつける
  if (raw.employeeStatus === "left") {
    warnings.push("退職済みの要員です。契約の終了日を確認してください");
  }
  // Phase 3：印と勤務表の状態の食い違い。手で付けた印（勤務表の行が無い）は、食い違いではない
  const sh = raw.sheet || null;
  if (sh) {
    if (sh.state === "confirmed" && !conf) warnings.push("勤務表は確定していますが、稼働確認の印がありません");
    if (conf && (sh.state === "draft" || sh.state === "returned")) {
      warnings.push("稼働確認の印はありますが、勤務表は確定していません（下書き・差し戻しのままです）");
    }
    for (const w of sh.warnings || []) warnings.push(w);
  }
  if (pay && pay.match === "mismatch" && pay.invoiceStatus === "received") {
    warnings.push(`BP請求書の金額が一致しません（${pay.issues.filter((t) => !/照合できません/.test(t)).join("・")}）`);
  }
  if (usesVendor && !raw.partnerName) {
    warnings.push(raw.employeeKind === "bp"
      ? "BP会社が登録されていません"
      : "契約はBPですが、要員がBP区分ではありません（BP会社が特定できません）");
  }

  const cols = {
    timesheet: recv ? { state: "submitted", label: "提出済" } : { state: "not_submitted", label: "未提出" },
    work: conf
      ? { state: "confirmed", label: sh ? (sh.state === "confirmed" && sh.totalMinutes != null ? `確認済 ${formatHours(sh.totalMinutes)}h` : "確認済（手動）") : "確認済" }
      : { state: "unconfirmed", label: sh ? ({ submitted: "未読取", draft: "確認待ち", returned: "差し戻し" }[sh.state] || "未確認") : "未確認" },
    salesInvoice: sent ? { state: "sent", label: "送付済" }
      : made ? { state: "created", label: "作成済" } : { state: "not_created", label: "未作成" },
    vendorInvoice: !usesVendor ? { state: "not_applicable", label: "対象外" }
      : bp ? { state: "received", label: "受領済" } : { state: "not_received", label: "未受領" },
    // 支払の記録は Phase 7。記録が無いものを「未払い」とも「済み」とも言わない
    payment: !usesVendor ? { state: "not_applicable", label: "対象外" }
      : pay === undefined ? { state: "unmanaged", label: "未管理" }
        : pay === null ? (bp ? { state: "unregistered", label: "請求額 未登録" } : { state: "waiting", label: "未着手" })
          : pay.paymentStatus === "paid" ? { state: "paid", label: `支払済 ${md(pay.paidOn)}` }
            : pay.paymentStatus === "scheduled" ? { state: "scheduled", label: `支払予定 ${md(pay.scheduledOn)}` }
              : pay.invoiceStatus === "approved" ? { state: "approved", label: "承認済・支払予定 未定" }
                : pay.match === "mismatch" ? { state: "mismatch", label: "金額不一致" } : { state: "matching", label: "照合待ち" },
  };

  const partner = raw.partnerName || "BP会社";
  const ACTIONS = {
    timesheet: {
      text: sh?.state === "returned" ? "再提出を待っています（差し戻し済み）" : overdue ? `勤務表が提出期限（${md(deadline)}）を過ぎています` : `勤務表の提出を待っています${deadline ? `（期限 ${md(deadline)}）` : ""}`,
      cta: "提出状況を見る", section: "timesheet",
    },
    work: {
      text: !sh ? "勤務表を確認して、稼働時間を確定してください"
        : sh.state === "submitted" ? "勤務表を読み取って（AI・手入力）、稼働時間を確認してください"
          : sh.state === "draft" ? `勤務表の確認待ちです${sh.unresolved ? `（入力が必要な日 ${sh.unresolved}日）` : ""}${sh.review ? `${sh.unresolved ? "・" : "（"}要確認 ${sh.review}日${sh.unresolved ? "" : "）"}` : ""}`
            : "勤務表を確認して、稼働時間を確定してください",
      cta: "勤務表を確認", section: "timesheet",
    },
    invoice_create: { text: "売上請求書を作成してください", cta: "請求の状況を見る", section: "sales" },
    invoice_send: { text: "売上請求書を送付してください", cta: "請求の状況を見る", section: "sales" },
    vendor: { text: `${partner}の請求書を受領してください`, cta: "仕入請求を見る", section: "vendor" },
    payment: {
      text: pay === undefined ? "仕入請求を確認して、支払を準備してください"
        : pay === null ? `${partner}の請求額を登録して、契約と照合してください`
          : pay.invoiceStatus === "received" ? (pay.match === "mismatch" ? "BP請求書の金額が契約と一致しません。確認して承認してください" : "BP請求書を照合して、承認してください")
            : pay.paymentStatus === "scheduled" ? `支払予定（${md(pay.scheduledOn)}）です。支払ったら、支払済にしてください`
              : "支払予定日を入れてください",
      cta: "支払を見る", section: pay === undefined ? "vendor" : "payment",
    },
  };
  const action = ACTIONS[stage] || null;

  const done = stage === "done";
  const check = warnings.length > 0;

  // 絞り込みに答える印
  const tags = [];
  if (stage === "timesheet") tags.push("timesheet");
  if (overdue) tags.push("overdue");
  if (stage === "work") tags.push("work");
  if (stage === "invoice_create" || stage === "invoice_send") tags.push("invoice");
  if (stage === "vendor") tags.push("vendor");
  if (stage === "payment") tags.push("payment");
  // 稼働を確定したのに、契約条件が決まらず精算できない行（請求に進めない）
  const settle = raw.settle || null;
  if (sh?.state === "confirmed" && settle && settle.status !== "calculated") tags.push("terms");
  if (check) tags.push("check");
  if (done) tags.push("done");

  const searchText = [
    raw.employeeName, raw.siteCompany, raw.primeCompany, raw.partnerName, raw.department,
    KIND_LABEL[raw.engagementKind],
  ].filter(Boolean).join(" ").toLowerCase();

  return {
    ...raw,
    kindLabel: KIND_LABEL[raw.engagementKind] || raw.engagementKind,
    usesVendor,
    cols,
    stage, stageLabel: STAGE_LABEL[stage], stageIndex: STAGE_INDEX[stage],
    overdue, deadline: deadline || null,
    warnings, check,
    sheetInfo: sh ? { ...sh, ...SHEET_STATE[sh.state], hours: sh.state === "confirmed" && sh.totalMinutes != null ? formatHours(sh.totalMinutes) : null } : null,
    action, done, tags, searchText,
  };
}

/** 一覧の並び：期限超過 → 未完了（上流の工程から）→ 完了。同じなら氏名順 */
export function sortRows(rows) {
  return [...rows].sort((a, b) =>
    (Number(b.overdue) - Number(a.overdue))
    || (Number(a.done) - Number(b.done))
    || (a.stageIndex - b.stageIndex)
    || String(a.employeeName || "").localeCompare(String(b.employeeName || ""), "ja"));
}

/**
 * 集計。ダッシュボードの数字・月次進捗・「今日やること」
 * 完了は PP だけ数える（BP は支払の管理が入るまで完了にならない）
 */
export function summarize(rows) {
  const total = rows.length;
  const count = (fn) => rows.filter(fn).length;
  const vendorRows = rows.filter((r) => r.usesVendor);

  const byStage = Object.fromEntries(STAGES.map((s) => [s.key, count((r) => r.stage === s.key)]));
  const overdue = count((r) => r.overdue);
  const check = count((r) => r.check);

  const cards = [
    { key: "all",       label: "対象案件",     value: total },
    { key: "timesheet", label: "勤務表待ち",   value: byStage.timesheet, alert: overdue > 0 },
    { key: "work",      label: "稼働確認待ち", value: byStage.work },
    { key: "invoice",   label: "請求未送付",   value: byStage.invoice_create + byStage.invoice_send },
    { key: "vendor",    label: "仕入請求待ち", value: byStage.vendor },
    { key: "done",      label: "完了",         value: byStage.done, of: total },
  ];

  const progress = [
    { key: "timesheet", label: "勤務表回収", done: count((r) => r.cols.timesheet.state === "submitted"), of: total },
    { key: "work",      label: "稼働確認",   done: count((r) => r.cols.work.state === "confirmed"), of: total },
    { key: "invoice",   label: "売上請求（送付）", done: count((r) => r.cols.salesInvoice.state === "sent"), of: total },
    { key: "vendor",    label: "仕入請求（受領）", done: count((r) => r.cols.vendorInvoice.state === "received"), of: vendorRows.length },
    { key: "done",      label: "月次完了",   done: byStage.done, of: total },
  ];

  // Phase 3：稼働確認待ちの内訳（勤務表の状態が分かるときだけ）。契約条件の確認は、稼働確定済みで精算できない行
  const unread = count((r) => r.stage === "work" && r.sheetInfo?.state === "submitted");
  const review = count((r) => r.stage === "work" && r.sheetInfo?.state === "draft");
  const workNote = [unread ? `未読取 ${unread}件` : null, review ? `確認待ち ${review}件` : null].filter(Boolean).join("・") || null;
  const termsCount = count((r) => r.tags.includes("terms"));

  // 期限超過は未提出の内訳（別項目にすると、重なった数字が並んで紛らわしい）
  const today = [
    { key: "timesheet", label: "勤務表未提出",   count: byStage.timesheet,
      note: overdue > 0 ? `うち期限超過 ${overdue}件` : null },
    { key: "work",      label: "稼働確認待ち",   count: byStage.work, note: workNote },
    { key: "invoice",   label: "請求未送付",     count: byStage.invoice_create + byStage.invoice_send },
    { key: "vendor",    label: "仕入請求待ち",   count: byStage.vendor },
    { key: "payment",   label: "支払待ち",       count: byStage.payment },
    { key: "terms",     label: "契約条件の確認", count: termsCount },
    { key: "check",     label: "要確認",         count: check },
  ].filter((t) => t.count > 0);

  return { total, byStage, overdue, check, cards, progress, today };
}
