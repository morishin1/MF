// 経営ハブ（/keiei ホーム）の集計。DB には触れない純粋関数だけを置く。
//
// ■ /keiei は「見る → 気付く → 判断する → 元システムへ行く」ための画面
//   ここで業務を終わらせない。数字と警告を出し、押したら元のシステム（HR・経費精算・会計 …）へ送る。
//   元データは各システムが持つ。ここに写しを保存しない（毎回、元を数える）。
//
// ■ 4ブロック
//   ① 今日の確認   … 経営者が今日、判断・対応する必要があるもの（0件なら小さく1行）
//   ② 人・組織     … 経営判断に必要な人数の概要だけ（給与金額は出さない）
//   ③ お金         … Board（売上・請求・入金）は未接続。社内の3数字だけ
//   ④ リスク・未処理 … 放置すると困るもの。重要度の高い順
//
// ■ 同じ事実を、2つのブロックに出さない
//   すべての事実は「項目（item）」になり、block が today なら ①、risk なら ④ に出る。
//   1つの事実は、どちらか1つだけ。（例: 契約更新は14日以内なら ①、15〜45日なら ④）
//
// ■ 読めなかった元データを、0件・問題なしにしない
//   facts の値が null ＝ 読めなかった。その判定は出さず、unreadable に名前を並べる
//   （画面は「一部を読み込めませんでした」と出す。何も出ないことを、安全と読ませない）。
import { doneCount, STAGES } from "./billing-progress.js";
import { LONG_DAYS, blockerDays } from "./blockers.js";
import { CLOSED_STATUSES, isOverdue } from "./hr.js";
import { prevMonth } from "./closing.js";

export const SEVERITY = { HIGH: "high", MID: "mid", LOW: "low" };
export const SEVERITY_LABEL = { high: "重要", mid: "注意", low: "確認" };
const RANK = { high: 0, mid: 1, low: 2 };

// ---- しきい値（ここ1か所。変えるときは docs/keiei-hub.md も直す） ----------------
/** 契約更新: この日数以内なら ①今日の確認、これより先〜45日以内は ④リスク */
export const RENEWAL_TODAY_DAYS = 14;
export const RENEWAL_WATCH_DAYS = 45;
/** 入社日が、この日数以内（過ぎている場合を含む）で準備が終わっていなければ ④。7日以内は「重要」 */
export const JOIN_NEAR_DAYS = 14;
export const JOIN_URGENT_DAYS = 7;
/** 前月の月次締めは、当月のこの日までに済ませたい。過ぎたら「重要」（それまでは「注意」） */
export const CLOSING_DUE_DAY = 5;
/** 請求進捗: 当月の行は、この日を過ぎても5段階が終わっていなければ滞留とみなす（前月以前の行は常に） */
export const BILLING_STALE_DAY = 10;
/** 請求進捗を見る月数（当月を含む） */
export const BILLING_LOOKBACK = 3;

/** 元システムへの遷移先。相対パスは、そのシステムの画面。# は /keiei の中 */
export const LINKS = {
  expenses: "/admin-expenses.html",
  requests: "/admin-requests.html",
  ceoReview: "/hr/ceo-review.html",
  hrApplicants: "/hr/applicants.html",
  members: "/admin-members.html",
  blockers: "/admin-nippo.html",
  closing: "/admin-closing.html",
  monthStart: "/admin-month-start.html",
  accounting: "/admin.html",
  onboarding: "#onboarding",
  security: "#security",
  payAudit: "#pay-audit",
};

/** 選考中の段階（内定・入社予定は含めない） */
const RECRUITING_STAGES = ["applied", "casual_interview", "ceo_recommend", "ceo_interview"];
/** 内定として数えない終わり方（承諾済みは、本採用へ進める前なので内定に含める） */
const OFFER_ENDED = ["declined", "passed", "done"];

const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const yen = (n) => `${Math.round(Number(n) || 0).toLocaleString("ja-JP")}円`;
const ymText = (m) => `${String(m).slice(0, 4)}年${Number(String(m).slice(5, 7))}月`;
const names = (list, max = 3) => {
  const n = list.map((x) => x.name).filter(Boolean);
  return n.slice(0, max).join("・") + (n.length > max ? ` ほか${n.length - max}人` : "");
};

/** severity の高い順。同じなら、出した順（安定） */
const bySeverity = (list) => list.map((x, i) => [x, i]).sort((a, b) => RANK[a[0].severity] - RANK[b[0].severity] || a[1] - b[1]).map(([x]) => x);

// ---- 経営者（ホームのリスクと、設定・セキュリティで同じ判定を使う）-----------
// 二段階認証は任意のセキュリティ設定（2026-10-01）。未登録は、リスクにも警告にもしない。
// owners[].mfa は「登録済みか」の参考表示にだけ使う

/**
 * @param {Array<{name:string, active:boolean, canLogin:boolean, mfa:"enrolled"|"none"|"unknown"}>} owners
 * @returns {{risks:Array, loginable:number}}
 */
export function securityRisks(owners) {
  const active = (owners || []).filter((o) => o.active);
  const loginable = active.filter((o) => o.canLogin);
  const risks = [];
  if (loginable.length === 1) {
    risks.push({ key: "owner_single", severity: SEVERITY.HIGH, label: "経営者が1人だけです",
      detail: "その1人がログインできなくなると、画面からは復旧できません。経営者を2人以上にしてください" });
  }
  return { risks, loginable: loginable.length };
}

// ---- ホーム -------------------------------------------------------------------

/**
 * @param {{today:string, facts:object}} src
 *   facts の各値。null は「読めなかった」
 *   people      {total, proper, bp}
 *   expenses    {ownerWaiting:{count,amount}, pending:{count,amount}, payable:{count,amount}}
 *   requests    経営者（代表）の承認待ちの稟議の件数
 *   applicants  [{stage, status, decision_due_on}]
 *   onboarding  {inProgress, company, rows:[{name, joinOn, daysToStart, complete}]}
 *   blockers    [{escalation_level, blocked_since}]（止まっているものだけ）
 *   renewals    [{period_to, renewal_status}]
 *   closing     {closed:boolean}（前月の月次締め）
 *   billing     [{billing_month, ...5段階の印}]
 *   journals    確認待ち（承認前）の仕訳の件数
 *   owners      [{name, active, canLogin, mfa}]
 */
export function buildHub({ today, facts }) {
  const f = facts || {};
  const month = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const prev = prevMonth(month);
  const unreadable = [];
  const items = [];
  const put = (i) => items.push(i);
  const lost = (label) => { if (!unreadable.includes(label)) unreadable.push(label); };

  // ---- 経費・稟議（代表の承認待ち）
  if (f.expenses) {
    const w = f.expenses.ownerWaiting;
    if (w.count > 0) {
      put({ key: "expense_approval", block: "today", severity: SEVERITY.HIGH, label: "経費の承認（代表）",
        detail: `${w.count}件が代表の承認待ちです（計 ${yen(w.amount)}）`, count: w.count,
        href: LINKS.expenses, linkLabel: "経費精算で承認する" });
    }
  } else lost("経費");
  if (f.requests != null) {
    if (f.requests > 0) {
      put({ key: "request_approval", block: "today", severity: SEVERITY.HIGH, label: "稟議の承認（代表）",
        detail: `${f.requests}件が代表の承認待ちです`, count: f.requests,
        href: LINKS.requests, linkLabel: "休暇・稟議の承認で開く" });
    }
  } else lost("稟議");

  // ---- 採用（社長判断待ち・対応期限超過）と人数
  let recruiting = null;
  let offers = null;
  if (f.applicants) {
    const a = f.applicants;
    recruiting = a.filter((x) => RECRUITING_STAGES.includes(x.stage) && !CLOSED_STATUSES.includes(x.status)).length;
    offers = a.filter((x) => x.stage === "offer" && !OFFER_ENDED.includes(x.status)).length;
    const ceo = a.filter((x) => x.status === "ceo_decision_pending").length;
    if (ceo > 0) {
      put({ key: "ceo_decision", block: "today", severity: SEVERITY.HIGH, label: "採用の社長判断",
        detail: `${ceo}人が社長判断待ちです`, count: ceo, href: LINKS.ceoReview, linkLabel: "CEO REVIEWで判断する" });
    }
    const late = a.filter((x) => isOverdue(x, today)).length;
    if (late > 0) {
      put({ key: "recruit_overdue", block: "risk", severity: SEVERITY.MID, label: "採用の対応期限を過ぎています",
        detail: `${late}人の対応期限が過ぎたままです`, count: late, href: LINKS.hrApplicants, linkLabel: "応募者一覧で確認する" });
    }
  } else lost("採用");

  // ---- 入社準備
  let joining = null;
  let onbOpen = null;
  if (f.onboarding) {
    const ob = f.onboarding;
    joining = ob.rows.filter((r) => r.joinOn && r.daysToStart != null && r.daysToStart >= 0).length;
    onbOpen = ob.inProgress;
    if (ob.company > 0) {
      put({ key: "onboarding_company", block: "today", severity: SEVERITY.HIGH, label: "入社準備（会社の対応）",
        detail: `${ob.company}人が会社の対応待ちです`, count: ob.company, href: LINKS.onboarding, linkLabel: "入社準備を開く" });
    }
    const near = ob.rows.filter((r) => !r.complete && r.daysToStart != null && r.daysToStart <= JOIN_NEAR_DAYS);
    if (near.length) {
      const urgent = near.some((r) => r.daysToStart <= JOIN_URGENT_DAYS);
      put({ key: "join_near", block: "risk", severity: urgent ? SEVERITY.HIGH : SEVERITY.MID,
        label: "入社日が近いのに、準備が終わっていません",
        detail: `${near.length}人（${names(near)}）。入社日が${JOIN_NEAR_DAYS}日以内、または過ぎています`, count: near.length,
        href: LINKS.onboarding, linkLabel: "入社準備を開く" });
    }
  } else lost("入社準備");

  // ---- 止まっている仕事（Blocker）
  if (f.blockers) {
    const open = f.blockers.map((b) => ({ ...b, days: blockerDays(b, today) }));
    const esc = open.filter((b) => b.escalation_level >= 2);
    if (esc.length) {
      put({ key: "blocker_owner", block: "today", severity: SEVERITY.HIGH, label: "経営判断待ちの止まっている仕事",
        detail: `${esc.length}件（最長${Math.max(...esc.map((b) => b.days))}日）が経営者に上がっています`, count: esc.length,
        href: LINKS.blockers, linkLabel: "日報・Blockerで確認する" });
    }
    const long = open.filter((b) => b.escalation_level < 2 && b.days > LONG_DAYS);
    if (long.length) {
      put({ key: "blocker_long", block: "risk", severity: SEVERITY.MID, label: "長く止まっている仕事があります",
        detail: `${long.length}件が${LONG_DAYS}日を超えて止まっています（最長${Math.max(...long.map((b) => b.days))}日）`, count: long.length,
        href: LINKS.blockers, linkLabel: "日報・Blockerで確認する" });
    }
  } else lost("止まっている仕事");

  // ---- 契約更新（終了予定・更新手続き済みは、対応が要らないので数えない）
  if (f.renewals) {
    const due = f.renewals.filter((c) => c.period_to && c.renewal_status !== "renewed" && c.renewal_status !== "ending")
      .map((c) => ({ ...c, left: days(today, c.period_to) })).filter((c) => c.left >= 0 && c.left <= RENEWAL_WATCH_DAYS);
    const soon = due.filter((c) => c.left <= RENEWAL_TODAY_DAYS);
    const later = due.filter((c) => c.left > RENEWAL_TODAY_DAYS);
    if (soon.length) {
      put({ key: "renewal_soon", block: "today", severity: SEVERITY.HIGH, label: "契約更新の期限が近い",
        detail: `${soon.length}件の現場契約が${RENEWAL_TODAY_DAYS}日以内に終わります（更新が未了）`, count: soon.length,
        href: LINKS.members, linkLabel: "メンバー管理（現場契約）で確認する" });
    }
    if (later.length) {
      put({ key: "renewal_watch", block: "risk", severity: SEVERITY.LOW, label: "契約更新の期限が近づいています",
        detail: `${later.length}件が${RENEWAL_TODAY_DAYS + 1}〜${RENEWAL_WATCH_DAYS}日以内に終わります（更新が未了）`, count: later.length,
        href: LINKS.members, linkLabel: "メンバー管理（現場契約）で確認する" });
    }
  } else lost("現場契約");

  // ---- 月末月初（前月の月次締め・請求進捗）
  if (f.closing) {
    if (!f.closing.closed) {
      put({ key: "closing", block: "today", severity: day > CLOSING_DUE_DAY ? SEVERITY.HIGH : SEVERITY.MID,
        label: `${ymText(prev)}の月次締め`,
        detail: day > CLOSING_DUE_DAY ? `${CLOSING_DUE_DAY}日を過ぎても、まだ締まっていません` : "まだ締まっていません（月初の作業です）",
        href: LINKS.closing, linkLabel: "月次締めを開く" });
    }
  } else lost("月次締め");
  if (f.billing) {
    const stale = f.billing.filter((r) => doneCount(r) < STAGES.length && (r.billing_month < month || day > BILLING_STALE_DAY)).length;
    if (stale > 0) {
      put({ key: "billing_stale", block: "risk", severity: SEVERITY.MID, label: "請求の進み具合が止まっています",
        detail: `${stale}件が、5段階（勤務表受領〜BP請求書受領）を終えていません`, count: stale,
        href: LINKS.monthStart, linkLabel: "月初作業管理で確認する" });
    }
  } else lost("請求進捗");

  // ---- 経営者・二段階認証
  if (f.owners) {
    const sec = securityRisks(f.owners);
    for (const r of sec.risks) put({ ...r, block: "risk", href: LINKS.security, linkLabel: "経営設定・セキュリティを開く" });
  } else lost("経営者の一覧");

  // ---- ③ お金（Board は未接続。社内の3数字だけ）
  const e = f.expenses;
  const money = {
    board: { status: "unlinked", message: "売上・請求は Board 連携後に表示します" },
    internal: [
      { key: "expense_pending", label: "経費 承認待ち", value: e ? e.pending.count : null, suffix: "件",
        sub: e ? (e.pending.count ? `計 ${yen(e.pending.amount)}` : "") : null, href: LINKS.expenses, linkLabel: "経費精算を開く" },
      { key: "payable", label: "立替 支払待ち", value: e ? e.payable.count : null, suffix: "件",
        sub: e ? (e.payable.count ? `計 ${yen(e.payable.amount)}（承認済み・未払い）` : "") : null, href: LINKS.expenses, linkLabel: "経費精算を開く" },
      { key: "journals", label: "会計 確認待ち", value: f.journals ?? null, suffix: "件",
        sub: f.journals == null ? null : "仕訳（承認前）", href: LINKS.accounting, linkLabel: "会計を開く" },
    ],
  };
  if (f.journals == null) lost("会計（仕訳）");

  const p = f.people;
  if (!p) lost("社員名簿");
  const people = {
    tiles: [
      { key: "headcount", label: "在籍", value: p ? p.total : null, suffix: "人", sub: p ? `プロパー ${p.proper}・BP ${p.bp}` : null,
        href: LINKS.members, linkLabel: "メンバー管理を開く" },
      { key: "joining", label: "入社予定", value: joining, suffix: "人", sub: "入社日が今日以降", href: LINKS.onboarding, linkLabel: "入社準備を開く" },
      { key: "recruiting", label: "採用選考中", value: recruiting, suffix: "人", sub: "見送り・辞退を除く", href: LINKS.hrApplicants, linkLabel: "応募者一覧を開く" },
      { key: "offers", label: "内定", value: offers, suffix: "人", sub: "承諾済み・本採用前を含む", href: LINKS.hrApplicants, linkLabel: "応募者一覧を開く" },
      { key: "onboarding_open", label: "入社準備 未完了", value: onbOpen, suffix: "人", sub: "6ステップが済んでいない人", href: LINKS.onboarding, linkLabel: "入社準備を開く" },
    ],
  };

  const attention = bySeverity(items.filter((i) => i.block === "today"));
  const risks = bySeverity(items.filter((i) => i.block === "risk"));
  return {
    today, month, attention, people, money, risks, unreadable,
    // 見出しの1行に使う。未読込の判定が含まれていない件数であることに注意（unreadable を別に出す）
    summary: { attention: attention.length, risks: risks.length, high: [...attention, ...risks].filter((i) => i.severity === SEVERITY.HIGH).length },
  };
}

// ---- 経営設定・セキュリティ ------------------------------------------------------

export const OWNER_EVENT_LABEL = {
  "owner.grant": "経営者に追加",
  "owner.revoke": "経営者から外した",
  "mfa.reset_denied": "経営者の二段階認証リセットを断った",
};
export const OWNER_EVENTS = Object.keys(OWNER_EVENT_LABEL);

/**
 * @param {{owners:Array, events:Array<{ts,action,actor_id,target,detail}>, people:Array<{id,user_id,display_name}>}} src
 */
export function buildSecurity({ owners, events, people, today }) {
  const byUser = new Map((people || []).filter((p) => p.user_id).map((p) => [p.user_id, p.display_name]));
  const byId = new Map((people || []).map((p) => [p.id, p.display_name]));
  const sec = securityRisks(owners);
  const history = (events || []).map((ev) => {
    const targetId = String(ev.target || "").startsWith("employee:") ? ev.target.slice(9) : null;
    return {
      at: ev.ts, action: ev.action, label: OWNER_EVENT_LABEL[ev.action] || ev.action,
      actor: byUser.get(ev.actor_id) || null,
      target: (targetId && byId.get(targetId)) || ev.detail?.name || null,
    };
  });
  return {
    today, owners, loginableCount: sec.loginable, warnings: sec.risks,
    history,
    links: { payAudit: LINKS.payAudit },
  };
}
