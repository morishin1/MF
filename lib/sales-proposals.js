// /sales 提案管理（db/138_sales_proposals.sql）の決まりごと。画面にもAPIにも依存しない純粋な関数だけを置く。
//
// ■ 何をするところか
//   dx.enger（マッチング・提案の正本）でマッチングが確定した提案を、/sales で「提案単位」に追いかける。
//   マッチング確定 → 「マッチング済み・提案待ち」＋営業担当の提案準備（db/140）
//   → 企業へ提案送信（T0）→ 電話（原則30分以内）→ 不通ならその営業日中にメール → 翌営業日に回答確認
//   → 3営業日後に再フォロー → 5営業日後に管理者の確認（継続・保留・クローズ）。
//   マッチング確定と提案送信は別の事実。企業へまだ提案していない段階では、30分の電話の期限を始めない。
//   どの段の期限も、営業時間・土日祝日・自社休業日（設定）に合わせて決める。
//
// ■ 守ること（docs/sales-proposals.md）
//   ・「電話した」のチェックだけで完了にしない。電話は結果・実施者・実施日時が要る（DB の CHECK でも止める）
//   ・タスクの完了は、必ず記録（行動）とひも付ける。完了・取り消しも履歴として残す
//   ・同じ提案に同じ自動タスクは作らない（source_event。DB の一意索引でも止める）
//   ・連絡停止・見送り・成約・クローズになった提案には、自動の追客を作らない
//   ・企業側の見送り・人材側の辞退・営業判断の保留は、同じ状態に潰さず理由コードで分ける
//   ・自社が電話・メールしていない無回答を、企業の不利益として扱わない（KPI の分母を分ける）

import { isBizDay } from "./holidays.js";
import { ymd as jstYmd, time as jstTime } from "./jst.js";

// ---- 状態 ---------------------------------------------------------------------

export const PROPOSAL_STATUSES = [
  // マッチング確定（db/140）。まだ企業へ提案していない。営業担当が内容を確認して提案する
  { key: "proposal_wait", label: "マッチング済み・提案待ち", open: true },
  { key: "call_wait", label: "電話待ち", open: true },
  { key: "mail_wait", label: "メール待ち", open: true },
  { key: "reply_wait", label: "回答待ち", open: true },
  { key: "meeting_adjust", label: "面談調整", open: true },
  { key: "meeting_done", label: "面談実施", open: true },
  { key: "considering", label: "継続検討", open: true },
  { key: "reproposal", label: "再提案依頼", open: true },
  { key: "won", label: "成約", open: false },
  { key: "lost", label: "見送り", open: false },
  { key: "stopped", label: "連絡停止", open: false },
  { key: "closed_no_reply", label: "クローズ（無回答）", open: false },
];
export const STATUS_KEYS = PROPOSAL_STATUSES.map((s) => s.key);
export const STATUS_LABEL = Object.fromEntries(PROPOSAL_STATUSES.map((s) => [s.key, s.label]));
export const CLOSED_STATUSES = PROPOSAL_STATUSES.filter((s) => !s.open).map((s) => s.key);
export const isClosed = (status) => CLOSED_STATUSES.includes(status);
// 電話・メールの記録で状態を動かしてよい段（面談まで進んだ提案を「回答待ち」に戻さない）
const EARLY = ["call_wait", "mail_wait", "reply_wait", "considering", "reproposal"];

export const CLOSE_REASONS = [
  { key: "client_declined", label: "企業側の見送り" },
  { key: "talent_declined", label: "人材側の辞退" },
  { key: "filled", label: "他で充足・募集終了" },
  { key: "sales_hold", label: "営業判断の保留" },
  { key: "client_considering", label: "企業が検討中" },
  { key: "other_candidate", label: "別の候補を希望" },
  { key: "no_reply", label: "無回答" },
  { key: "contact_stop", label: "連絡停止の希望" },
  { key: "other", label: "その他" },
];
export const CLOSE_REASON_LABEL = Object.fromEntries(CLOSE_REASONS.map((r) => [r.key, r.label]));
// その状態にしてよい理由コード（null を含めば理由なしでもよい）
export const REASONS_FOR = {
  won: [null],
  lost: ["client_declined", "talent_declined", "filled", "other"],
  stopped: ["contact_stop"],
  closed_no_reply: ["no_reply"],
  considering: [null, "sales_hold", "client_considering"],
  reproposal: [null, "other_candidate", "talent_declined"],
};
export const RESULT_STATUSES = Object.keys(REASONS_FOR);

// ---- 電話・返信の結果 ---------------------------------------------------------

export const CALL_RESULTS = [
  { key: "connected", label: "通話できた" },
  { key: "no_answer", label: "不通" },
  { key: "absent", label: "担当者不在" },
  { key: "callback", label: "折り返し予定", needsAt: true },
  { key: "recall", label: "再連絡希望", needsAt: true },
  { key: "do_not_contact", label: "連絡不可・連絡停止希望" },
];
export const CALL_RESULT_KEYS = CALL_RESULTS.map((r) => r.key);
export const CALL_RESULT_LABEL = Object.fromEntries(CALL_RESULTS.map((r) => [r.key, r.label]));

// 通話できた・返信があったときの中身（必須）
export const OUTCOMES = [
  { key: "meeting", label: "面談調整へ" },
  { key: "considering", label: "検討中" },
  { key: "declined", label: "見送り" },
  { key: "other_candidate", label: "別候補希望" },
];
export const OUTCOME_KEYS = OUTCOMES.map((o) => o.key);
export const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.key, o.label]));

export const MEETING_RESULTS = [
  { key: "scheduled", label: "日程確定", needsAt: true },
  { key: "done", label: "面談実施" },
  { key: "canceled", label: "面談の取りやめ" },
];
export const MEETING_RESULT_LABEL = Object.fromEntries(MEETING_RESULTS.map((r) => [r.key, r.label]));

export const DECISIONS = [
  { key: "continue", label: "フォロー継続", needsAt: true },
  { key: "hold", label: "保留（営業判断）" },
  { key: "close", label: "クローズ（無回答）" },
];
export const DECISION_LABEL = Object.fromEntries(DECISIONS.map((d) => [d.key, d.label]));

export const ACTIVITY_LABEL = {
  matched: "マッチング確定", sent: "提案送信", call: "電話", mail: "メール", reply: "企業から返信", check: "回答確認",
  meeting: "面談", result: "結果", decision: "管理者の判断", assign: "担当変更", due_change: "期限変更",
  task: "タスク", memo: "メモ", contact: "窓口の更新", link: "企業の紐付け", sync: "dx.enger から更新",
  handoff: "担当の引継ぎ", cs_decision: "CS進行判断",
};

export const TASK_KINDS = [
  { key: "prepare", label: "提案準備" },
  { key: "call", label: "電話" },
  { key: "mail", label: "メール" },
  { key: "reply_check", label: "回答確認" },
  { key: "refollow", label: "再フォロー" },
  { key: "manager_review", label: "管理者確認" },
  { key: "meeting_fix", label: "面談日程の確定" },
  { key: "meeting_result", label: "面談結果の記録" },
  { key: "manual", label: "手動タスク" },
];
export const TASK_KIND_LABEL = Object.fromEntries(TASK_KINDS.map((k) => [k.key, k.label]));

// 記録が「どのタスクを片付けたか」。電話を記録すれば、開いている電話・再フォローのタスクは完了になる
export const FULFILLS = {
  sent: ["prepare"],
  call: ["call", "refollow"],
  mail: ["mail", "refollow"],
  reply: ["call", "mail", "reply_check", "refollow", "manager_review", "meeting_fix"],
  check: ["reply_check"],
  meeting_scheduled: ["meeting_fix"],
  meeting_done: ["meeting_fix", "meeting_result"],
  meeting_canceled: ["meeting_result"],
  decision: ["manager_review"],
};

// ---- 設定 ---------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  bizStart: "09:00", bizEnd: "18:00", firstCallMinutes: 30, refollowBizDays: 3, reviewBizDays: 5, extraHolidays: [],
  // 社員ID → Slack のメンバーID（db/140）。起票の Slack 通知で営業担当をメンションする。無い人は名前だけ
  slackMembers: {},
  // 提案送信時に共有するCSチーム・クロージングチームの社員ID。空なら未設定扱い。
  csMembers: [], closingMembers: [],
};
/** Slack のメンバーID（U0123ABCD / W0123ABCD） */
export const SLACK_MEMBER_RE = /^[UW][A-Z0-9]{6,20}$/;
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)/;

/** DB の行（gw_sales_proposal_settings）→ 画面・計算で使う形。無ければ既定値 */
export function settingsOf(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  const hm = (v, d) => (HM_RE.test(String(v || "")) ? String(v).slice(0, 5) : d);
  return {
    bizStart: hm(row.biz_start, DEFAULT_SETTINGS.bizStart),
    bizEnd: hm(row.biz_end, DEFAULT_SETTINGS.bizEnd),
    firstCallMinutes: Number(row.first_call_minutes) || DEFAULT_SETTINGS.firstCallMinutes,
    refollowBizDays: Number(row.refollow_biz_days) || DEFAULT_SETTINGS.refollowBizDays,
    reviewBizDays: Number(row.review_biz_days) || DEFAULT_SETTINGS.reviewBizDays,
    extraHolidays: Array.isArray(row.extra_holidays) ? row.extra_holidays.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [],
    slackMembers: slackMembersOf(row.slack_members),
    csMembers: teamIdsOf(row.cs_members), closingMembers: teamIdsOf(row.closing_members),
  };
}

/** 設定の Slack のメンバーID（形の合うものだけ） */
function teamIdsOf(v) {
  return Array.isArray(v) ? [...new Set(v.map(String).filter(isUuid))].slice(0, 20) : [];
}
function slackMembersOf(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([k, id]) => isUuid(k) && SLACK_MEMBER_RE.test(String(id))));
}

/**
 * 画面から来た設定を確かめる。current（いまの設定。settingsOf の形）と合わせて、始業 < 終業 を見る
 * @returns {{value:object}|{error:string, field:string}}
 */
export function normalizeSettings(body = {}, current = DEFAULT_SETTINGS) {
  const v = {};
  if (body.bizStart !== undefined) {
    if (!HM_RE.test(String(body.bizStart))) return { error: "invalid_body", field: "bizStart" };
    v.biz_start = String(body.bizStart).slice(0, 5);
  }
  if (body.bizEnd !== undefined) {
    if (!HM_RE.test(String(body.bizEnd))) return { error: "invalid_body", field: "bizEnd" };
    v.biz_end = String(body.bizEnd).slice(0, 5);
  }
  const int = (k, col, lo, hi) => {
    if (body[k] === undefined) return null;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) return { error: "invalid_body", field: k };
    v[col] = n;
    return null;
  };
  for (const [k, col, lo, hi] of [["firstCallMinutes", "first_call_minutes", 5, 480], ["refollowBizDays", "refollow_biz_days", 1, 20],
    ["reviewBizDays", "review_biz_days", 1, 30]]) {
    const e = int(k, col, lo, hi);
    if (e) return e;
  }
  if (body.extraHolidays !== undefined) {
    const list = Array.isArray(body.extraHolidays) ? body.extraHolidays : String(body.extraHolidays || "").split(/[\s,、]+/);
    const days = [...new Set(list.map((d) => String(d).trim()).filter(Boolean))];
    if (days.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) {
      return { error: "invalid_body", field: "extraHolidays" };
    }
    if (days.length > 100) return { error: "invalid_body", field: "extraHolidays" };
    v.extra_holidays = days.sort();
  }
  if (body.slackMembers !== undefined) {
    // { 社員ID: "U0123ABCD" }。空の値はその人の登録を外す
    const src = body.slackMembers;
    if (!src || typeof src !== "object" || Array.isArray(src)) return { error: "invalid_body", field: "slackMembers" };
    const out = {};
    for (const [k, raw] of Object.entries(src)) {
      const id = String(raw ?? "").trim().toUpperCase();
      if (!isUuid(k)) return { error: "invalid_body", field: "slackMembers" };
      if (!id) continue;
      if (!SLACK_MEMBER_RE.test(id)) return { error: "invalid_body", field: "slackMembers", hint: "Slack のメンバーID（U から始まる英数字）を入れてください" };
      out[k] = id;
    }
    if (Object.keys(out).length > 500) return { error: "invalid_body", field: "slackMembers" };
    v.slack_members = out;
  }
  for (const [field, column] of [["csMembers", "cs_members"], ["closingMembers", "closing_members"]]) {
    if (body[field] === undefined) continue;
    const ids = body[field];
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => !isUuid(id))) {
      return { error: "invalid_body", field, hint: "Salesに登録された在籍中の社員を選んでください" };
    }
    v[column] = [...new Set(ids)];
  }
  if ((v.biz_start ?? current.bizStart) >= (v.biz_end ?? current.bizEnd)) return { error: "invalid_body", field: "bizEnd" };
  if ((v.review_biz_days ?? current.reviewBizDays) < (v.refollow_biz_days ?? current.refollowBizDays)) {
    return { error: "invalid_body", field: "reviewBizDays" };
  }
  return { value: v };
}

// ---- 営業日・営業時間（日本時間） -------------------------------------------------

const offDay = (ymd, s) => !isBizDay(new Date(`${ymd}T00:00:00Z`)) || (s.extraHolidays || []).includes(ymd);
const plusDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** その日の hh:mm（日本時間）の ISO（UTC）。日本は夏時間が無いので +09:00 固定 */
export const atJst = (ymd, hm) => new Date(`${ymd}T${hm}:00+09:00`).toISOString();
export const isBizYmd = (ymd, s = DEFAULT_SETTINGS) => !offDay(ymd, s);
/** ymd より後の最初の営業日 */
export function nextBizYmd(ymd, s = DEFAULT_SETTINGS) {
  let d = plusDays(ymd, 1);
  for (let i = 0; i < 400 && offDay(d, s); i++) d = plusDays(d, 1);
  return d;
}
/** ymd の n 営業日後（ymd 自体は数えない） */
export function addBizYmd(ymd, n, s = DEFAULT_SETTINGS) {
  let d = ymd;
  for (let i = 0; i < n; i++) d = nextBizYmd(d, s);
  return d;
}
/** いまが営業日の営業時間内か */
export function inBizHours(iso, s = DEFAULT_SETTINGS) {
  const day = jstYmd(iso), hm = jstTime(iso);
  return isBizYmd(day, s) && hm >= s.bizStart && hm < s.bizEnd;
}

/**
 * 初回電話の期限。営業時間内に送ったら送信から firstCallMinutes 分後。
 * 営業時間の前（同じ営業日の朝）ならその日の始業から、営業時間外・休日なら次の営業日の始業から数える。
 */
export function firstCallDue(sentIso, s = DEFAULT_SETTINGS) {
  const day = jstYmd(sentIso), hm = jstTime(sentIso);
  const plus = (iso) => new Date(new Date(iso).getTime() + s.firstCallMinutes * 60000).toISOString();
  if (isBizYmd(day, s) && hm >= s.bizStart && hm < s.bizEnd) return plus(sentIso);
  if (isBizYmd(day, s) && hm < s.bizStart) return plus(atJst(day, s.bizStart));
  return plus(atJst(nextBizYmd(day, s), s.bizStart));
}

/** 提案準備を始めて終業まで、これだけ無ければ次の営業日に回す（分） */
export const PREPARE_MIN_LEFT = 60;

/**
 * 提案準備の期限（マッチング確定から）。その営業日の終業まで。
 * 終業まで1時間を切ってから確定した・営業時間外・休日の確定は、次の営業日の終業まで
 */
export function prepareDue(matchedIso, s = DEFAULT_SETTINGS) {
  const day = jstYmd(matchedIso), hm = jstTime(matchedIso);
  const [eh, em] = s.bizEnd.split(":").map(Number);
  const cutoffMin = eh * 60 + em - PREPARE_MIN_LEFT;
  const [h, m] = hm.split(":").map(Number);
  if (isBizYmd(day, s) && h * 60 + m < cutoffMin) return atJst(day, s.bizEnd);
  return atJst(nextBizYmd(day, s), s.bizEnd);
}

/** その営業日の終業まで（営業時間後・休日なら次の営業日の終業） */
export function sameBizDayEnd(iso, s = DEFAULT_SETTINGS) {
  const day = jstYmd(iso), hm = jstTime(iso);
  if (isBizYmd(day, s) && hm < s.bizEnd) return atJst(day, s.bizEnd);
  return atJst(nextBizYmd(day, s), s.bizEnd);
}

/** 翌営業日の終業（回答確認） */
export const nextBizDayEnd = (iso, s = DEFAULT_SETTINGS) => atJst(nextBizYmd(jstYmd(iso), s), s.bizEnd);

/** 提案送信から n 営業日後の終業。もう過ぎていれば、いまの営業日の終業（休日なら次の営業日） */
export function milestoneDue(t0Iso, n, nowIso, s = DEFAULT_SETTINGS) {
  const due = atJst(addBizYmd(jstYmd(t0Iso), n, s), s.bizEnd);
  return due > nowIso ? due : sameBizDayEnd(nowIso, s);
}

// ---- 権限 ---------------------------------------------------------------------

/** 管理側（全件の確認・担当の割り当て・設定・連携エラー）。DB の gw_sales_is_manager と同じ。canSell を通った人について使う */
export const canManageProposals = (ctx) => Boolean(ctx?.isAdmin)
  || (ctx?.roles || []).includes("owner") || (ctx?.roles || []).includes("manager");

// ---- 自動タスクと状態（記録を足したときに何が起きるか） ----------------------------

/**
 * 記録（行動）を1つ足したときの、提案の変更・片付くタスク・新しく作るタスクを決める。
 *
 * @param {object} p
 * @param {object} p.proposal    gw_sales_proposals の行（status・sent_at・sales_owner_id・contact_stop）
 * @param {object} p.activity    足した記録（id・kind・result・outcome・next_at・occurred_at）
 * @param {object[]} p.tasks     その提案のタスクすべて（開いているもの・終わったものを含む。重複を避けるため）
 * @param {string} [p.now]       いまの ISO
 * @param {object} [p.settings]  settingsOf() の形
 * @param {string|null} [p.managerId] 管理者確認の担当（営業担当の上長）。無ければ null（管理側の一覧に出る）
 * @returns {{ patch: object, complete: string[], cancel: {id:string, reason:string}[], create: object[] }}
 *   patch    … 提案に書く列（status・close_reason・closed_at・contact_stop・meeting_at）
 *   complete … この記録で完了にするタスクID（done_activity_id = activity.id）
 *   cancel   … 取り消すタスク（提案が終わったとき）
 *   create   … 作るタスク（kind・title・due_at・assignee_id・auto・source_event）
 */
export function planFollowUp({ proposal, activity, tasks = [], now = new Date().toISOString(), settings = DEFAULT_SETTINGS, managerId = null }) {
  const s = settings;
  const a = activity;
  const at = a.occurred_at || now;
  const open = tasks.filter((t) => t.status === "open");
  const patch = {};
  const create = [];
  const owner = proposal.sales_owner_id || null;
  let status = proposal.status;

  const fulfilled = FULFILLS[a.kind === "meeting" ? `meeting_${a.result}` : a.kind] || [];
  const complete = open.filter((t) => fulfilled.includes(t.kind)).map((t) => t.id);
  const stillOpen = (kind) => open.some((t) => t.kind === kind && !complete.includes(t.id));
  const everMade = (key) => tasks.some((t) => t.source_event === key);
  const add = (kind, title, due, { key, assignee = owner } = {}) => {
    if (key && everMade(key)) return;
    create.push({ kind, title, due_at: due, assignee_id: assignee, auto: true, source_event: key || null });
  };
  const setStatus = (next, { reason, early = false } = {}) => {
    if (early && !EARLY.includes(status)) return;
    status = next;
    patch.status = next;
    if (isClosed(next)) {
      patch.close_reason = reason ?? null;
      patch.closed_at = now;
    } else {
      patch.close_reason = reason ?? null;
      patch.closed_at = null;
    }
  };

  // 中身（通話できた・返信）の扱いは共通
  const applyOutcome = (outcome) => {
    if (outcome === "meeting") {
      setStatus("meeting_adjust");
      if (!stillOpen("meeting_fix")) add("meeting_fix", "面談日程を確定する", nextBizDayEnd(at, s), { key: `auto:meeting_fix:${a.id}` });
    } else if (outcome === "considering") {
      setStatus("considering", { reason: "client_considering" });
      const due = a.next_at || atJst(addBizYmd(jstYmd(at), s.refollowBizDays, s), s.bizEnd);
      if (!stillOpen("reply_check")) add("reply_check", "検討結果を確認する", due, { key: `auto:check:${a.id}` });
    } else if (outcome === "declined") {
      setStatus("lost", { reason: "client_declined" });
    } else if (outcome === "other_candidate") {
      setStatus("reproposal", { reason: "other_candidate" });
    }
  };

  switch (a.kind) {
    case "call": {
      if (a.result === "connected") applyOutcome(a.outcome);
      else if (a.result === "no_answer" || a.result === "absent") {
        setStatus("mail_wait", { early: true });
        // 電話がつながらなかった → その営業日中にメール（同じ提案に開いているメールのタスクがあれば作らない）
        if (!stillOpen("mail")) add("mail", "不通のため確認メールを送る", sameBizDayEnd(at, s), { key: `auto:mail:${a.id}` });
      } else if (a.result === "callback") {
        setStatus("reply_wait", { early: true });
        add("call", "折り返しが無ければ電話する", a.next_at || nextBizDayEnd(at, s), { key: `auto:callback:${a.id}` });
      } else if (a.result === "recall") {
        setStatus("call_wait", { early: true });
        add("call", "先方の希望日時に再連絡する", a.next_at || nextBizDayEnd(at, s), { key: `auto:recall:${a.id}` });
      } else if (a.result === "do_not_contact") {
        setStatus("stopped", { reason: "contact_stop" });
        patch.contact_stop = true;
      }
      break;
    }
    case "mail": {
      setStatus("reply_wait", { early: true });
      if (!stillOpen("reply_check")) add("reply_check", "返信を確認する", nextBizDayEnd(at, s), { key: `auto:check:${a.id}` });
      break;
    }
    case "sent": {
      // 企業へ提案を送った（提案待ち → 電話待ち）。30分以内の電話は、確定ではなく送った時刻から数える
      if (!proposal.sent_at) { patch.sent_at = at; patch.handoff_stage = "cs"; }
      if (status === "proposal_wait") {
        setStatus("call_wait");
        add("call", `初回電話（提案から${s.firstCallMinutes}分以内）`, firstCallDue(at, s), { key: "auto:first_call" });
      }
      break;
    }
    case "reply": applyOutcome(a.outcome); break;
    case "check": {
      // 返信なし：3営業日（再フォロー）→ 5営業日（管理者確認）の順に1回ずつ。それより先は管理者が決める
      if (!everMade("auto:refollow")) {
        add("refollow", `再フォロー（${s.refollowBizDays}営業日・再電話／再メール）`, milestoneDue(proposal.sent_at, s.refollowBizDays, now, s), { key: "auto:refollow" });
      } else if (!everMade("auto:review")) {
        add("manager_review", `管理者確認（${s.reviewBizDays}営業日・継続／保留／クローズを決める）`,
          milestoneDue(proposal.sent_at, s.reviewBizDays, now, s), { key: "auto:review", assignee: managerId });
      }
      break;
    }
    case "meeting": {
      if (a.result === "scheduled") {
        setStatus("meeting_adjust");
        patch.meeting_at = a.next_at || null;
        const day = a.next_at ? jstYmd(a.next_at) : jstYmd(at);
        const end = atJst(isBizYmd(day, s) ? day : nextBizYmd(day, s), s.bizEnd);
        add("meeting_result", "面談の結果を記録する", a.next_at && end < a.next_at ? a.next_at : end, { key: `auto:meeting_result:${a.id}` });
      } else if (a.result === "done") {
        setStatus("meeting_done");
        add("manual", "成約／見送りを確定する", atJst(addBizYmd(jstYmd(at), s.reviewBizDays, s), s.bizEnd), { key: "auto:result_fix" });
      } else if (a.result === "canceled") {
        setStatus("meeting_adjust");
        patch.meeting_at = null;
        if (!stillOpen("meeting_fix")) add("meeting_fix", "面談日程を決め直す", nextBizDayEnd(at, s), { key: `auto:meeting_fix:${a.id}` });
      }
      break;
    }
    case "decision": {
      if (a.result === "continue") {
        setStatus("reply_wait");
        add("call", "再フォロー（管理者の判断：継続）", a.next_at || nextBizDayEnd(at, s), { key: `auto:continue:${a.id}` });
      } else if (a.result === "hold") setStatus("considering", { reason: "sales_hold" });
      else if (a.result === "close") setStatus("closed_no_reply", { reason: "no_reply" });
      break;
    }
    case "result": {
      setStatus(a.result, { reason: a.outcome || null });
      if (a.result === "stopped") patch.contact_stop = true;
      break;
    }
    default: break;
  }

  // 終わった提案：開いているタスクは取り消す（完了にはしない。やっていないことを完了にしない）
  let cancel = [];
  if (isClosed(status)) {
    cancel = open.filter((t) => !complete.includes(t.id))
      .map((t) => ({ id: t.id, reason: `提案が「${STATUS_LABEL[status]}」になったため` }));
    create.length = 0;
  }
  // 連絡停止の希望がある提案には、自動で連絡するタスクを作らない
  if (proposal.contact_stop || patch.contact_stop) {
    for (let i = create.length - 1; i >= 0; i--) if (["call", "mail", "refollow"].includes(create[i].kind)) create.splice(i, 1);
  }
  return { patch, complete, cancel, create };
}

/** マッチング確定で起票したときの最初のタスク（提案準備）。電話のタスクは、企業へ提案を送ってから作る */
export function matchedTasks(proposal, settings = DEFAULT_SETTINGS) {
  if (proposal.contact_stop || proposal.status !== "proposal_wait" || !proposal.matched_at) return [];
  return [{
    kind: "prepare", title: "提案準備（内容を確認して企業へ提案する）", due_at: prepareDue(proposal.matched_at, settings),
    assignee_id: proposal.sales_owner_id || null, auto: true, source_event: "auto:prepare",
  }];
}

/** 提案送信で起票したときの最初のタスク（電話）。マッチング確定の連携が先に無かった提案（db/138 のときの起票） */
export function firstTasks(proposal, settings = DEFAULT_SETTINGS) {
  if (proposal.contact_stop || isClosed(proposal.status) || !proposal.sent_at) return [];
  return [{
    kind: "call", title: `初回電話（提案から${settings.firstCallMinutes}分以内）`, due_at: firstCallDue(proposal.sent_at, settings),
    assignee_id: proposal.sales_owner_id || null, auto: true, source_event: "auto:first_call",
  }];
}

// ---- 入力の確かめ（API） ------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => UUID_RE.test(String(v || ""));
const txt = (v, max) => { const t = String(v ?? "").trim(); return t ? t.slice(0, max) : null; };
/** 日時（ISO・"2026-10-01T16:15" は日本時間）。無ければ null、読めなければ undefined */
export function readWhen(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  const d = local ? new Date(`${s}:00+09:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * 記録の入力（POST /api/sales/proposals/detail の action）を、DB に入れる形にする。
 * @returns {{value:object}|{error:string, field?:string, hint?:string}}
 */
export function normalizeActivity(action, body = {}, { now = new Date().toISOString() } = {}) {
  const occurred = readWhen(body.occurredAt);
  if (occurred === undefined) return { error: "invalid_body", field: "occurredAt", hint: "実施日時が読めません" };
  // 未来の実施日時は受け付けない（まだやっていないことを記録にしない）。5分のずれは許す
  if (occurred && occurred > new Date(Date.parse(now) + 5 * 60000).toISOString()) {
    return { error: "invalid_body", field: "occurredAt", hint: "実施日時が未来になっています" };
  }
  const nextAt = readWhen(body.nextAt);
  if (nextAt === undefined) return { error: "invalid_body", field: "nextAt", hint: "日時が読めません" };
  const note = txt(body.note, 2000);
  const base = { occurred_at: occurred || now, note, next_at: nextAt };

  if (action === "call") {
    if (!CALL_RESULT_KEYS.includes(body.result)) return { error: "invalid_body", field: "result", hint: "電話の結果を選んでください" };
    const def = CALL_RESULTS.find((r) => r.key === body.result);
    if (def.needsAt && !nextAt) return { error: "invalid_body", field: "nextAt", hint: `${def.label}の日時を入れてください` };
    if (body.result === "connected" && !OUTCOME_KEYS.includes(body.outcome)) {
      return { error: "invalid_body", field: "outcome", hint: "通話の内容（面談調整・検討中・見送り・別候補希望）を選んでください" };
    }
    return { value: { ...base, kind: "call", channel: "phone", result: body.result, outcome: body.result === "connected" ? body.outcome : null } };
  }
  if (action === "mail") {
    // いまは /sales からメールを送らないので、送った記録は「自己申告」
    return { value: { ...base, kind: "mail", channel: "email", result: "sent", evidence: "self_report" } };
  }
  if (action === "reply") {
    if (!OUTCOME_KEYS.includes(body.outcome)) return { error: "invalid_body", field: "outcome", hint: "返信の内容を選んでください" };
    const channel = ["phone", "email", "form", "line", "other"].includes(body.channel) ? body.channel : "email";
    return { value: { ...base, kind: "reply", channel, result: "replied", outcome: body.outcome } };
  }
  if (action === "check") return { value: { ...base, kind: "check", result: "no_reply" } };
  if (action === "sent") {
    // 企業へ提案を送った（dx.enger 以外で送ったとき。dx.enger から送れば自動で入る）。Sales での記録＝自己申告
    const channel = ["email", "phone", "form", "line", "meeting", "other"].includes(body.channel) ? body.channel : "email";
    return { value: { ...base, kind: "sent", channel, result: "sent", evidence: "self_report" } };
  }
  if (action === "meeting") {
    const def = MEETING_RESULTS.find((r) => r.key === body.result);
    if (!def) return { error: "invalid_body", field: "result", hint: "面談の内容を選んでください" };
    if (def.needsAt && !nextAt) return { error: "invalid_body", field: "nextAt", hint: "面談の日時を入れてください" };
    return { value: { ...base, kind: "meeting", channel: "meeting", result: body.result } };
  }
  if (action === "decision") {
    const def = DECISIONS.find((d) => d.key === body.result);
    if (!def) return { error: "invalid_body", field: "result", hint: "判断を選んでください" };
    if (def.needsAt && !nextAt) return { error: "invalid_body", field: "nextAt", hint: "次に連絡する日時を入れてください" };
    return { value: { ...base, kind: "decision", result: body.result } };
  }
  if (action === "result") {
    if (!RESULT_STATUSES.includes(body.status)) return { error: "invalid_body", field: "status", hint: "結果を選んでください" };
    const reason = body.reason || null;
    if (!REASONS_FOR[body.status].includes(reason)) {
      return { error: "invalid_body", field: "reason", hint: "理由を選んでください（企業側の見送り・人材側の辞退などを分けて記録します）" };
    }
    return { value: { ...base, kind: "result", result: body.status, outcome: reason } };
  }
  if (action === "memo") {
    if (!note) return { error: "invalid_body", field: "note", hint: "メモを入れてください" };
    return { value: { ...base, kind: "memo" } };
  }
  return { error: "unknown_action" };
}

/** 手動タスク（追加）の入力 */
export function normalizeTaskInput(body = {}) {
  const title = txt(body.title, 200);
  if (!title) return { error: "invalid_body", field: "title", hint: "タスクの内容を入れてください" };
  const due = readWhen(body.dueAt);
  if (!due) return { error: "invalid_body", field: "dueAt", hint: "期限を入れてください" };
  if (body.assigneeId != null && body.assigneeId !== "" && !isUuid(body.assigneeId)) return { error: "invalid_body", field: "assigneeId" };
  return { value: { kind: "manual", title, due_at: due, assignee_id: body.assigneeId || null, auto: false } };
}

// ---- 表示（一覧・詳細） --------------------------------------------------------

export const PROPOSAL_FIELDS = "id, tenant_id, source_system, source_proposal_id, source_code, source_url, source_company_id, source_stage, "
  + "company_id, company_name, service, title, job_title, talent_initials, contact_name, contact_email, contact_phone, "
  + "matching_owner_name, matching_owner_email, proposal_owner_id, sales_owner_id, matched_at, sent_at, status, close_reason, close_note, closed_at, "
  + "contact_stop, meeting_at, synced_at, slack_notified_at, handoff_stage, cs_owner_id, closing_owner_id, sent_shared_at, archived_at, archived_by, created_at, updated_at";
export const ACTIVITY_FIELDS = "id, proposal_id, company_id, kind, result, outcome, evidence, channel, occurred_at, employee_id, "
  + "next_at, note, detail, source_event, created_at";
export const TASK_FIELDS = "id, proposal_id, kind, title, assignee_id, due_at, status, auto, source_event, done_at, done_activity_id, "
  + "cancel_reason, created_at";

/** 記録1件の見出し（「電話：不通」「企業から返信：面談調整へ」） */
export function activityLabel(a) {
  const base = ACTIVITY_LABEL[a.kind] || a.kind;
  if (a.kind === "call") {
    const r = CALL_RESULT_LABEL[a.result] || a.result;
    return a.outcome ? `${base}：${r}（${OUTCOME_LABEL[a.outcome] || a.outcome}）` : `${base}：${r}`;
  }
  if (a.kind === "reply") return `${base}：${OUTCOME_LABEL[a.outcome] || a.outcome || "返信あり"}`;
  if (a.kind === "mail") return `${base}：送信${a.evidence === "self_report" ? "（自己申告）" : ""}`;
  if (a.kind === "sent") return `${base}${a.result === "resent" ? "（再送）" : ""}${a.evidence === "self_report" ? "（Sales で記録）" : ""}`;
  if (a.kind === "check") return `${base}：返信なし`;
  if (a.kind === "meeting") return `${base}：${MEETING_RESULT_LABEL[a.result] || a.result}`;
  if (a.kind === "decision") return `${base}：${DECISION_LABEL[a.result] || a.result}`;
  if (a.kind === "result") {
    const r = STATUS_LABEL[a.result] || a.result;
    return a.outcome ? `${base}：${r}（${CLOSE_REASON_LABEL[a.outcome] || a.outcome}）` : `${base}：${r}`;
  }
  return base;
}

/** 経過日数（提案送信からの暦日。まだ送っていなければマッチング確定から。日本時間の日付で数える） */
export function elapsedDays(sentIso, now = new Date().toISOString()) {
  if (!sentIso) return 0;
  const a = Date.parse(`${jstYmd(sentIso)}T00:00:00Z`), b = Date.parse(`${jstYmd(now)}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * 一覧の1行。記録・タスクから「電話状況」「メール状況」「次の行動」「期限超過」を作る
 * @param {object} p 提案の行
 * @param {{activities?:object[], tasks?:object[], nameOf?:Function, now?:string}} o
 */
export function shapeProposal(p, { activities = [], tasks = [], nameOf = () => null, now = new Date().toISOString() } = {}) {
  const mine = activities.filter((a) => a.proposal_id === p.id).sort((x, y) => String(x.occurred_at).localeCompare(String(y.occurred_at)));
  const calls = mine.filter((a) => a.kind === "call");
  const mails = mine.filter((a) => a.kind === "mail");
  const replies = mine.filter((a) => a.kind === "reply");
  const myTasks = tasks.filter((t) => t.proposal_id === p.id);
  const open = myTasks.filter((t) => t.status === "open").sort((x, y) => String(x.due_at).localeCompare(String(y.due_at)));
  const next = open[0] || null;
  const overdueTasks = open.filter((t) => t.due_at < now);
  const lastCall = calls[calls.length - 1] || null;
  const closed = isClosed(p.status);
  return {
    id: p.id,
    sourceSystem: p.source_system, sourceProposalId: p.source_proposal_id || null, sourceCode: p.source_code || null,
    sourceUrl: p.source_url || null, sourceStage: p.source_stage || null,
    companyId: p.company_id || null, companyName: p.company_name, sourceCompanyId: p.source_company_id || null,
    service: p.service || null, title: p.title, jobTitle: p.job_title || null, talentInitials: p.talent_initials || null,
    contactName: p.contact_name || null, contactEmail: p.contact_email || null, contactPhone: p.contact_phone || null,
    matchingOwnerName: p.matching_owner_name || (p.source_system === "manual" ? nameOf(p.sales_owner_id) : null),
    proposalOwnerId: p.proposal_owner_id || null,
    proposalOwnerName: nameOf(p.proposal_owner_id) || (!p.proposal_owner_id && (p.handoff_stage || "proposal") === "proposal" ? nameOf(p.sales_owner_id) : null),
    salesOwnerId: p.sales_owner_id || null, salesOwnerName: nameOf(p.sales_owner_id),
    handoffStage: p.handoff_stage || (p.sent_at ? "cs" : "proposal"),
    csOwnerId: p.cs_owner_id || null, csOwnerName: nameOf(p.cs_owner_id),
    closingOwnerId: p.closing_owner_id || null, closingOwnerName: nameOf(p.closing_owner_id),
    sentSharedAt: p.sent_shared_at || null,
    // 企業へ提案を送った日時（提案待ちの間は null）・マッチング確定の日時・並べ替えの起点（送信 → 確定）
    sentAt: p.sent_at || null, matchedAt: p.matched_at || null, basisAt: p.sent_at || p.matched_at || p.created_at || null,
    elapsedDays: elapsedDays(p.sent_at || p.matched_at, now), waiting: p.status === "proposal_wait",
    status: p.status, statusLabel: STATUS_LABEL[p.status] || p.status, closed,
    closeReason: p.close_reason || null, closeReasonLabel: CLOSE_REASON_LABEL[p.close_reason] || null,
    contactStop: Boolean(p.contact_stop), meetingAt: p.meeting_at || null,
    call: calls.length
      ? { count: calls.length, lastAt: lastCall.occurred_at, lastResult: lastCall.result, label: CALL_RESULT_LABEL[lastCall.result] || lastCall.result }
      : null,
    mail: mails.length ? { count: mails.length, lastAt: mails[mails.length - 1].occurred_at, selfReported: mails.some((m) => m.evidence === "self_report") } : null,
    repliedAt: replies.length ? replies[0].occurred_at : null,
    next: next ? { id: next.id, kind: next.kind, title: next.title, dueAt: next.due_at, overdue: next.due_at < now,
      assigneeId: next.assignee_id || null, assigneeName: nameOf(next.assignee_id) } : null,
    openTasks: open.length,
    overdue: !closed && overdueTasks.length > 0,
    overdueSince: overdueTasks.length ? overdueTasks[0].due_at : null,
    archived: Boolean(p.archived_at), archivedAt: p.archived_at || null,
    syncedAt: p.synced_at || null, updatedAt: p.updated_at,
  };
}

export function shapeTask(t, { nameOf = () => null, now = new Date().toISOString() } = {}) {
  return {
    id: t.id, proposalId: t.proposal_id, kind: t.kind, kindLabel: TASK_KIND_LABEL[t.kind] || t.kind, title: t.title,
    assigneeId: t.assignee_id || null, assigneeName: nameOf(t.assignee_id), dueAt: t.due_at, status: t.status, auto: Boolean(t.auto),
    overdue: t.status === "open" && t.due_at < now,
    // 期限を過ぎてから完了したもの（履歴として残す。KPI の期限内実施率に使う）
    late: t.status === "done" && t.done_at && t.done_at > t.due_at,
    doneAt: t.done_at || null, doneActivityId: t.done_activity_id || null, cancelReason: t.cancel_reason || null,
  };
}

export function shapeActivity(a, { nameOf = () => null } = {}) {
  return {
    id: a.id, kind: a.kind, label: activityLabel(a), result: a.result || null, outcome: a.outcome || null,
    evidence: a.evidence || null, channel: a.channel || null, occurredAt: a.occurred_at,
    employeeId: a.employee_id || null, employeeName: nameOf(a.employee_id), nextAt: a.next_at || null,
    note: a.note || null, detail: a.detail || null,
  };
}

// ---- 一覧の絞り込み・並べ替え --------------------------------------------------

/** 絞り込み（画面のボタンと同じ並び）。row は shapeProposal の形 */
export const FILTERS = [
  { key: "open", label: "対応中", test: (r) => !r.closed && !r.archived },
  { key: "today", label: "本日対応", test: (r, t) => !r.archived && !r.closed && r.next && r.next.dueAt <= t.todayEnd },
  { key: "overdue", label: "期限超過", test: (r) => !r.archived && r.overdue },
  // 「再提案待ち」と取り違えないよう、状態の名前（マッチング済み・提案待ち）の前半で出す
  { key: "proposal_wait", label: "マッチング済み", test: (r) => !r.archived && r.status === "proposal_wait" },
  // 電話未実施は、企業へ提案を送ったのに電話していない提案（提案待ちは数えない）
  { key: "no_call", label: "電話未実施", test: (r) => !r.archived && !r.closed && !r.call && Boolean(r.sentAt) },
  { key: "mail_wait", label: "メール待ち", test: (r) => !r.archived && r.status === "mail_wait" },
  { key: "reply_wait", label: "返信待ち", test: (r) => !r.archived && (r.status === "reply_wait" || r.status === "considering") },
  { key: "meeting", label: "面談調整", test: (r) => !r.archived && (r.status === "meeting_adjust" || r.status === "meeting_done") },
  { key: "reproposal", label: "再提案待ち", test: (r) => !r.archived && r.status === "reproposal" },
  { key: "cs", label: "CS対応", test: (r) => !r.archived && !r.closed && r.handoffStage === "cs" },
  { key: "closing", label: "クロージング", test: (r) => !r.archived && !r.closed && r.handoffStage === "closing" },
  { key: "unassigned", label: "担当未割当", test: (r) => !r.archived && !r.closed && !r.salesOwnerId, managerOnly: true },
  { key: "unlinked", label: "企業未紐付け", test: (r) => !r.archived && !r.closed && !r.companyId },
  { key: "closed", label: "完了", test: (r) => r.closed && !r.archived },
  { key: "all", label: "すべて", test: (r) => !r.archived },
  { key: "archived", label: "アーカイブ", test: (r) => r.archived },
];
export const FILTER_KEYS = FILTERS.map((f) => f.key);

/** 画面の選択肢（ラベル）。画面に値を書き写さない（API が返す） */
export const LABELS = {
  statuses: PROPOSAL_STATUSES, closeReasons: CLOSE_REASONS, reasonsFor: REASONS_FOR, callResults: CALL_RESULTS, outcomes: OUTCOMES,
  meetingResults: MEETING_RESULTS, decisions: DECISIONS, taskKinds: TASK_KINDS,
  filters: FILTERS.map(({ key, label, managerOnly }) => ({ key, label, managerOnly: Boolean(managerOnly) })),
};

export const SORTS = {
  // 期限超過を先に、次に期限が近い順（期限の無いものは最後）
  due: (a, b) => (Number(b.overdue) - Number(a.overdue))
    || String(a.next?.dueAt || "9999").localeCompare(String(b.next?.dueAt || "9999"))
    || String(a.basisAt).localeCompare(String(b.basisAt)),
  elapsed: (a, b) => String(a.basisAt).localeCompare(String(b.basisAt)),
  // 提案日（新しい順）。提案待ちは確定日で並べる
  sent: (a, b) => String(b.basisAt).localeCompare(String(a.basisAt)),
  sent_asc: (a, b) => String(a.basisAt).localeCompare(String(b.basisAt)),
  proposal_owner: (a, b) => String(a.matchingOwnerName || "").localeCompare(String(b.matchingOwnerName || ""), "ja") || String(b.basisAt).localeCompare(String(a.basisAt)),
  cs_owner: (a, b) => String(a.csOwnerName || "").localeCompare(String(b.csOwnerName || ""), "ja") || String(b.basisAt).localeCompare(String(a.basisAt)),
  closing_owner: (a, b) => String(a.closingOwnerName || "").localeCompare(String(b.closingOwnerName || ""), "ja") || String(b.basisAt).localeCompare(String(a.basisAt)),
  company: (a, b) => String(a.companyName || "").localeCompare(String(b.companyName || ""), "ja") || String(b.basisAt).localeCompare(String(a.basisAt)),
};

/** 「本日対応」の境目（日本時間の今日の終わり） */
export const todayEndIso = (now = new Date().toISOString()) => new Date(`${jstYmd(now)}T23:59:59.999+09:00`).toISOString();

export function filterRows(rows, { filter = "open", service = null, ownerId = null, now = new Date().toISOString() } = {}) {
  const f = FILTERS.find((x) => x.key === filter) || FILTERS[0];
  const t = { todayEnd: todayEndIso(now) };
  return rows.filter((r) => f.test(r, t) && (!service || r.service === service) && (!ownerId || r.salesOwnerId === ownerId));
}

export function countFilters(rows, { now = new Date().toISOString(), manager = false } = {}) {
  const t = { todayEnd: todayEndIso(now) };
  return Object.fromEntries(FILTERS.filter((f) => manager || !f.managerOnly).map((f) => [f.key, rows.filter((r) => f.test(r, t)).length]));
}

// ---- KPI（提案管理の上の数字・担当別） ------------------------------------------
//
// 定義（docs/sales-proposals.md「KPIの定義」と同じ）
//   対象の提案   … 期間内に送信した提案（手で足したものを含む）。取り消しは無い（提案は消さない）
//   電話実施率   … 対象の提案のうち、電話を1回以上記録したもの ÷ 対象の提案（連絡停止の希望が先に来たものは分母から外す）
//   期限内実施率 … 初回電話のタスクのうち、期限までに完了したもの ÷（完了＋期限を過ぎて開いているもの）。取り消しは外す
//   初回電話までの時間 … 提案送信 → 最初の電話の記録（分）。中央値
//   不通時のメール実施率 … 不通・不在のあとに作ったメールのタスクのうち、完了したもの ÷（完了＋期限を過ぎて開いているもの）
//   提案→面談率 … 面談調整以降に進んだ提案 ÷ 対象の提案
//   面談→成約率 … 成約 ÷ 面談調整以降に進んだ提案
//   担当変更：数えるのは「いまの担当」。行動（電話・メール）は実施した人（employee_id）で数える
export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}
const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const REACHED_MEETING = ["meeting_adjust", "meeting_done", "won"];

export function computeKpis(proposals, activities, tasks, { now = new Date().toISOString() } = {}) {
  const byP = new Map(proposals.map((p) => [p.id, p]));
  const acts = activities.filter((a) => byP.has(a.proposal_id));
  const tks = tasks.filter((t) => byP.has(t.proposal_id));
  const firstCall = new Map();
  for (const a of acts) {
    if (a.kind !== "call") continue;
    const cur = firstCall.get(a.proposal_id);
    if (!cur || a.occurred_at < cur) firstCall.set(a.proposal_id, a.occurred_at);
  }
  const meetingSeen = new Set(acts.filter((a) => a.kind === "meeting" || ((a.kind === "call" || a.kind === "reply") && a.outcome === "meeting"))
    .map((a) => a.proposal_id));
  const stoppedFirst = new Set(proposals.filter((p) => p.contact_stop && !firstCall.has(p.id)).map((p) => p.id));

  const calc = (ps) => {
    const ids = new Set(ps.map((p) => p.id));
    const base = ps.filter((p) => !stoppedFirst.has(p.id));
    const called = base.filter((p) => firstCall.has(p.id)).length;
    const fc = tks.filter((t) => ids.has(t.proposal_id) && t.source_event === "auto:first_call" && t.status !== "canceled");
    const fcDone = fc.filter((t) => t.status === "done");
    const fcOnTime = fcDone.filter((t) => t.done_at <= t.due_at).length;
    const fcDue = fcDone.length + fc.filter((t) => t.status === "open" && t.due_at < now).length;
    const mails = tks.filter((t) => ids.has(t.proposal_id) && t.kind === "mail" && t.auto && t.status !== "canceled");
    const mailDone = mails.filter((t) => t.status === "done").length;
    const mailDue = mailDone + mails.filter((t) => t.status === "open" && t.due_at < now).length;
    const minutes = ps.filter((p) => firstCall.has(p.id) && p.sent_at)
      .map((p) => Math.max(0, Math.round((Date.parse(firstCall.get(p.id)) - Date.parse(p.sent_at)) / 60000)));
    // マッチング確定 → 企業へ提案を送るまで（db/140。確定の日時がある提案だけ）
    const prepMinutes = ps.filter((p) => p.matched_at && p.sent_at)
      .map((p) => Math.max(0, Math.round((Date.parse(p.sent_at) - Date.parse(p.matched_at)) / 60000)));
    const reached = ps.filter((p) => REACHED_MEETING.includes(p.status) || meetingSeen.has(p.id));
    const won = ps.filter((p) => p.status === "won").length;
    const overdue = tks.filter((t) => ids.has(t.proposal_id) && t.status === "open" && t.due_at < now).length;
    return {
      proposals: ps.length,
      open: ps.filter((p) => !isClosed(p.status)).length,
      callRate: rate(called, base.length), called, callBase: base.length,
      onTimeRate: rate(fcOnTime, fcDue), onTime: fcOnTime, onTimeBase: fcDue,
      firstCallMedianMin: median(minutes), firstCallMeasured: minutes.length,
      prepareMedianMin: median(prepMinutes), prepareMeasured: prepMinutes.length,
      mailRate: rate(mailDone, mailDue), mailDone, mailBase: mailDue,
      meetingRate: rate(reached.length, ps.length), meetings: reached.length,
      wonRate: rate(won, reached.length), won,
      overdueTasks: overdue,
    };
  };

  const owners = [...new Set(proposals.map((p) => p.sales_owner_id || ""))];
  return {
    total: calc(proposals),
    byOwner: owners.map((o) => ({ ownerId: o || null, ...calc(proposals.filter((p) => (p.sales_owner_id || "") === o)) })),
  };
}

// ---- 企業の履歴へ写す（企業単位の連絡履歴） ---------------------------------------
//
// 提案の電話・メール・返信・面談は、企業（gw_sales_companies）の営業履歴にも1行写す。
// 企業の詳細を開いた人が「この会社に、いつ誰が何の連絡をしたか」を提案をまたいで見られるようにする。
// 状態の変更・メモ・期限変更は写さない（提案の中のこと）
export function companyEventOf(activity, proposal) {
  const map = { call: ["call", "phone"], mail: ["mail", "email"], reply: ["reply", activity.channel || "email"], meeting: ["meeting", null] };
  const m = map[activity.kind];
  if (!m || !proposal.company_id) return null;
  const channel = ["form", "email", "line", "phone", "other"].includes(m[1]) ? m[1] : null;
  return {
    event_key: m[0], channel,
    label: `提案フォロー：${activityLabel(activity)}`,
    detail: `提案「${proposal.title}」${proposal.service ? `（${proposal.service}）` : ""}${activity.note ? `\n${activity.note}` : ""}`.slice(0, 2000),
    occurred_at: activity.occurred_at,
  };
}
