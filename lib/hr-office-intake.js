// 採用HR → Office の早期引き渡し（新フロー。db/143・docs/hr-office-handoff.md「早期引き渡し（新フロー）」）
//
//   社長面談 → 社長本人が合格を判断（gw_hr_ceo_decisions。判断者・日時・応募者ID）
//   → 採用担当が条件ヒアリング（候補者の希望。gw_hr_hearings・給与は gw_hr_hearing_pay）
//   → 人事担当が内容を確認 → ［Officeへ引き渡す］（gw_hr_office_intakes。一度だけ）→ HR では「Officeへ移動済み」
//
// ■ これは承諾・正式契約・社員登録ではない
//   既存の gw_hr_offers.handoff_at（db/133。承諾・正式契約のあとの引き渡し）・accepted_at・formal_signed_at・
//   社員登録のガード（api/hr/applicants/advance.js）は使わない・変えない。
//
// ■ 新フローの対象（自動では移さない）
//   最新の社長判断（gw_hr_ceo_decisions）が合格で、オファーの版（gw_hr_offers）が1つも無い応募者だけ。
//   それ以外（既存の「内定」・オファーの版がある人）は旧フロー（HR で契約手続き）のまま。DB の trigger も同じ条件。
//
// ■ 機能フラグ（既定 OFF）
//   環境変数 HR_OFFICE_INTAKE=1 のときだけ、一覧・詳細に新フローを出し、新しい書き込み（ヒアリング・引き渡し）を受け付ける。
//   Office 側（PR B：受領・契約業務）ができるまで本番では ON にしない。
//
// このファイルは定義と判定（純粋な関数）と、読むだけの関数。書き込みは lib/hr-office-intake-ops.js。
import { OFFER_TYPE_KEYS, offerTypeLabel, formalRequiredOf } from "./hr-offer-types.js";
import { usesOfficial, contractStateOf } from "./hr-contract.js";

export const INTAKE_FLAG = "HR_OFFICE_INTAKE";
export const INTAKE_SQL = "db/143_hr_office_intake.sql";
/** 新フローを使うか（既定 OFF）。PR B（Office 側）ができるまで本番では ON にしない */
export const intakeEnabled = () => process.env[INTAKE_FLAG] === "1";

export const UNRESOLVED_LABEL = "未確定／Officeで確認";
export const PASS_LABEL = "社長合格／条件ヒアリング待ち";

/**
 * 条件ヒアリングの項目（画面もここを使う）。required は引き渡す前に「値」か「未確定／Officeで確認」のどちらかが要る。
 * 推測値は入れない：未確定にした項目は値を空にする（両方が入っていたら断る）。
 * desired_pay（希望報酬・給与）は別の表（gw_hr_hearing_pay）。給与を見られる人だけが入力・閲覧する
 */
export const HEARING_FIELDS = [
  { key: "offer_type", label: "採用区分", kind: "offerType", required: true },
  { key: "job_title", label: "職種", kind: "text", max: 200, required: true },
  { key: "duties", label: "予定業務", kind: "textarea", max: 2000, required: true },
  { key: "desired_join_date", label: "希望入社日", kind: "date", required: true },
  { key: "work_location", label: "勤務地", kind: "text", max: 200, required: true },
  { key: "remote_policy", label: "リモート", kind: "text", max: 200, required: true, placeholder: "例：週2日リモート" },
  { key: "weekly_days", label: "週の勤務日数", kind: "number", min: 0.5, maxValue: 7, unit: "日", required: true },
  { key: "weekly_hours", label: "週の勤務時間", kind: "number", min: 1, maxValue: 80, unit: "時間", required: true },
  { key: "contract_period", label: "契約期間", kind: "text", max: 200, required: true, placeholder: "例：期間の定めなし／6か月更新" },
  { key: "desired_pay", label: "希望報酬・給与（候補者希望）", kind: "pay", required: true, salary: true },
  { key: "allowances_note", label: "手当など", kind: "textarea", max: 1000, required: false },
  { key: "other_note", label: "その他（働き方の希望など）", kind: "textarea", max: 2000, required: false },
];
const FIELD = Object.fromEntries(HEARING_FIELDS.map((f) => [f.key, f]));
const VALUE_KEYS = HEARING_FIELDS.filter((f) => f.kind !== "pay").map((f) => f.key);
export const REQUIRED_KEYS = HEARING_FIELDS.filter((f) => f.required).map((f) => f.key);
export const fieldLabel = (key) => FIELD[key]?.label || key;
export const WAGE_TYPES = ["月給", "年俸", "月額", "時給", "日額", "案件単価", "成果報酬"];

/** Office 側の状態（db/143 の CHECK と同じ9つ。PR B が進める） */
export const OFFICE_STATUSES = [
  { key: "not_started", label: "未着手" },
  { key: "organizing", label: "条件整理中" },
  { key: "attorney_requested", label: "社労士依頼中" },
  { key: "awaiting_official_pdf", label: "正式PDF受領待ち" },
  { key: "awaiting_consent", label: "本人承諾待ち" },
  { key: "contracting", label: "契約手続き中" },
  { key: "preparing_join", label: "入社準備中" },
  { key: "completed", label: "完了" },
  { key: "withdrawn", label: "辞退・不成立" },
];
export const OFFICE_STATUS_KEYS = OFFICE_STATUSES.map((s) => s.key);
export const officeStatusLabel = (k) => OFFICE_STATUSES.find((s) => s.key === k)?.label || k || null;

/** 画面へ渡す定義（関数を含めない） */
export const INTAKE_PUBLIC = {
  fields: HEARING_FIELDS.map(({ key, label, kind, required, max, min, maxValue, unit, placeholder, salary }) => ({
    key, label, kind, required, max: max ?? null, min: min ?? null, maxValue: maxValue ?? null, unit: unit ?? null,
    placeholder: placeholder ?? null, salary: Boolean(salary),
  })),
  wageTypes: WAGE_TYPES,
  officeStatuses: OFFICE_STATUSES,
  unresolvedLabel: UNRESOLVED_LABEL,
};

// ---- 入力の形を整える（推測値を作らない） ------------------------------------------------
const str = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 実在する日付か（2026-02-30 は断る）。年月日を UTC で組み直して同じになるか
const validDate = (s) => {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/**
 * ヒアリングの入力（body.hearing＝{項目: 値}、body.unresolved＝[項目]）を、保存する形にする。
 * 値と「未確定」が両方ある項目・知らない項目・形の違う値は断る（推測値・自動の補完はしない）。
 * @returns {{error:string, detail:string} | {value:object, unresolved:string[]}}
 */
export function normalizeHearing(hearing, unresolved) {
  const input = hearing && typeof hearing === "object" ? hearing : {};
  const unk = Object.keys(input).filter((k) => !VALUE_KEYS.includes(k));
  if (unk.length) return { error: "invalid_body", detail: `知らない項目です：${unk.join(", ")}` };
  const list = Array.isArray(unresolved) ? [...new Set(unresolved.map(String))] : [];
  const bad = list.filter((k) => !FIELD[k]);
  if (bad.length) return { error: "invalid_body", detail: `未確定にできない項目です：${bad.join(", ")}` };
  const value = {};
  for (const key of VALUE_KEYS) {
    const f = FIELD[key];
    const raw = input[key];
    let v = null;
    if (f.kind === "offerType") {
      v = str(raw, 40);
      if (v && !OFFER_TYPE_KEYS.includes(v)) return { error: "invalid_body", detail: `採用区分は ${OFFER_TYPE_KEYS.join("/")} のいずれかです` };
    } else if (f.kind === "date") {
      v = str(raw, 10);
      if (v && !validDate(v)) return { error: "invalid_body", detail: `${f.label}の日付を確認してください` };
    } else if (f.kind === "number") {
      if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < f.min || n > f.maxValue) {
          return { error: "invalid_body", detail: `${f.label}は ${f.min}〜${f.maxValue}${f.unit} で入力してください` };
        }
        v = Math.round(n * 10) / 10;
      }
    } else {
      v = str(raw, f.max);
    }
    if (v !== null && list.includes(key)) {
      return { error: "invalid_body", detail: `「${f.label}」に値と「${UNRESOLVED_LABEL}」の両方が入っています。どちらか一方にしてください` };
    }
    value[key] = v;
  }
  return { value, unresolved: list };
}

/**
 * ヒアリングの給与（候補者希望・社内承認済み）。approved は経営者（canDecideSalary）だけが入力できる。
 * @returns {{error:string, detail:string, status?:number} | {value:object}}
 */
export function normalizeHearingPay(pay, { unresolved = [], canApprove = false } = {}) {
  const input = pay && typeof pay === "object" ? pay : {};
  const amount = (v, label) => {
    if (v === undefined || v === null || String(v).trim() === "") return { v: null };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100000000) return { error: `${label}は 0〜1億 の整数（円）で入力してください` };
    return { v: n };
  };
  const d = amount(input.desired_amount, "希望額");
  if (d.error) return { error: "invalid_body", detail: d.error };
  const a = amount(input.approved_amount, "社内承認済みの額");
  if (a.error) return { error: "invalid_body", detail: a.error };
  const value = {
    desired_wage_type: str(input.desired_wage_type, 20),
    desired_amount: d.v,
    desired_note: str(input.desired_note, 1000),
  };
  if (value.desired_amount !== null && unresolved.includes("desired_pay")) {
    return { error: "invalid_body", detail: `「希望報酬・給与」に値と「${UNRESOLVED_LABEL}」の両方が入っています。どちらか一方にしてください` };
  }
  const wantsApprove = a.v !== null || str(input.approved_wage_type, 20) !== null;
  if (wantsApprove) {
    if (!canApprove) return { error: "forbidden", status: 403, detail: "社内承認済みの額を決められるのは経営者だけです" };
    if (a.v === null) return { error: "invalid_body", detail: "社内承認済みの額を入力してください" };
    value.approved_wage_type = str(input.approved_wage_type, 20);
    value.approved_amount = a.v;
  }
  return { value, approve: wantsApprove };
}

/**
 * 引き渡す前に足りない項目（値も「未確定」も無い必須項目）。給与は「入っているか」だけを見る（値は見ない）
 * @param {object|null} hearing gw_hr_hearings の行
 * @param {boolean} payEntered 候補者希望の額が入っているか
 */
export function hearingMissing(hearing, payEntered) {
  if (!hearing) return [...REQUIRED_KEYS];
  const un = Array.isArray(hearing.unresolved) ? hearing.unresolved : [];
  return REQUIRED_KEYS.filter((k) => {
    if (un.includes(k)) return false;
    if (k === "desired_pay") return !payEntered;
    return hearing[k] === null || hearing[k] === undefined || hearing[k] === "";
  });
}

// ---- 状態の判定（HR と、PR B の Office で同じ関数を使う） ------------------------------------
/**
 * 応募者1人の新フローの事実から、いまの段階を決める。旧フローの人は null（何も変えない）。
 *   phase: awaiting_hearing（合格・ヒアリングなし）／hearing（記録中・不足・未確認・例外の承認待ち）／
 *          ready（引き渡せる）／handed_off（Office へ移動済み）／withdrawn（Office で辞退・不成立）
 * @param {{decision?:object|null, hasOffer?:boolean, hearing?:object|null, payEntered?:boolean, intake?:object|null}} f
 */
export function intakeStateOf(f) {
  const intake = f?.intake && !f.intake.returned_at ? f.intake : null;
  if (intake) {
    // Office の状態は、事実（版・依頼・正式PDF・承諾・締結・社員登録）から officeStatusOf が決めたもの（HR と Office で同じ）。
    // 事実を読んでいないとき（f.officeStatus が無い）だけ、保存してある office_status を使う
    const status = f.officeStatus?.key || intake.office_status;
    const withdrawn = status === "withdrawn";
    return {
      phase: withdrawn ? "withdrawn" : "handed_off", newFlow: true,
      intakeId: intake.id, officeStatus: status, officeStatusLabel: officeStatusLabel(status),
      handedAt: intake.handed_at, handedBy: intake.handed_by, officeAssigneeId: intake.office_assignee_id || null,
      unresolved: Array.isArray(intake.unresolved_items) ? intake.unresolved_items : [], missing: [],
    };
  }
  const d = f?.decision;
  if (!d || d.decision !== "pass" || f?.hasOffer) return null;
  const h = f?.hearing && !f.hearing.locked_at ? f.hearing : null;
  const base = { newFlow: true, decisionId: d.id, decidedAt: d.decided_at, decidedBy: d.decided_by, hearingId: h?.id || null };
  if (!h) return { ...base, phase: "awaiting_hearing", missing: [...REQUIRED_KEYS], unresolved: [], confirmed: false, exceptionApproved: false };
  const missing = hearingMissing(h, Boolean(f?.payEntered));
  const unresolved = Array.isArray(h.unresolved) ? h.unresolved : [];
  const confirmed = Boolean(h.confirmed_at);
  const exceptionApproved = Boolean(h.exception_approved_at);
  const ready = !missing.length && confirmed && (!unresolved.length || exceptionApproved) && h.offer_type !== "training";
  return { ...base, phase: ready ? "ready" : "hearing", missing, unresolved, confirmed, exceptionApproved, offerType: h.offer_type || null };
}

/** 一覧の状態の言い方（新フローの人だけ。旧フローの「内定」等は書き換えない） */
export function intakeStatusLabel(s) {
  if (!s) return null;
  if (s.phase === "awaiting_hearing" || s.phase === "hearing") return PASS_LABEL;
  if (s.phase === "ready") return "社長合格／Officeへ引き渡し待ち";
  if (s.phase === "handed_off") return `Officeへ移動済み（${s.officeStatusLabel || "未着手"}）`;
  if (s.phase === "withdrawn") return "辞退・不成立（Office）";
  return null;
}

/** NEXT ACTION（ボタンは1つ）。新フローの人だけ。旧フローは null（lib/hr.js nextActionOf がこれまでどおり決める） */
export function intakeNextAction(s) {
  if (!s) return null;
  if (s.phase === "awaiting_hearing") {
    return { label: "社長合格です。採用条件のヒアリングを記録してください", cta: "条件ヒアリングを記録", action: "hearing" };
  }
  if (s.phase === "hearing") {
    if (s.offerType === "training") {
      return { label: "育成枠は Office へ引き渡しません。採用区分を確認してください", cta: "条件ヒアリングを開く", action: "hearing" };
    }
    if (s.missing.length) {
      return { label: `条件ヒアリング不足：${s.missing.map(fieldLabel).join("・")}`, cta: "条件ヒアリングを続ける", action: "hearing" };
    }
    if (s.unresolved.length && !s.exceptionApproved) {
      return { label: `未確定の項目（${s.unresolved.map(fieldLabel).join("・")}）があります。管理者の承認と理由が要ります`, cta: "条件ヒアリングを開く", action: "hearing" };
    }
    return { label: "ヒアリングの内容を確認してください", cta: "内容を確認する", action: "hearing" };
  }
  if (s.phase === "ready") return { label: "条件ヒアリングが確認済みです。Office へ引き渡せます", cta: "Officeへ引き渡す", action: "officeHandoff" };
  if (s.phase === "handed_off") return { label: `Office で手続き中：${s.officeStatusLabel || "未着手"}`, cta: null, action: null };
  if (s.phase === "withdrawn") return { label: "Office で辞退・不成立になりました", cta: null, action: null };
  return null;
}

// ---- 読む（表が無い環境＝db/143 未適用では ready=false。一覧・詳細はこれまでどおり） ----------------
const isMissingTable = (e) => {
  const code = String(e?.code || "");
  return code === "PGRST205" || code === "42P01" || /schema cache|does not exist/i.test(String(e?.message || ""));
};
export { isMissingTable };
const chunks = (ids, n = 100) => {
  const out = [];
  for (let i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n));
  return out;
};
async function readIn(sb, table, cols, tenantId, ids) {
  const rows = [];
  for (const part of chunks(ids)) {
    const { data, error } = await sb.from(table).select(cols).eq("tenant_id", tenantId).in("applicant_id", part);
    if (error) return { error };
    rows.push(...(data || []));
  }
  return { rows };
}
const latestBy = (rows, key, at) => {
  const m = new Map();
  for (const r of rows) {
    const cur = m.get(r[key]);
    if (!cur || String(r[at]) > String(cur[at]) || (String(r[at]) === String(cur[at]) && String(r.created_at || "") > String(cur.created_at || ""))) m.set(r[key], r);
  }
  return m;
};

/**
 * 応募者ごとの新フローの事実（applicant_id → intakeStateOf の結果。旧フローの人は入らない）。
 * service role（admin）で読む：給与は「入っているか」だけを見て、値は返さない。
 * @returns {Promise<{ready:boolean, byId:Map<string, object>, raw:Map<string, object>}>}
 */
export async function readIntakeFacts(ab, tenantId, applicantIds) {
  const byId = new Map();
  const raw = new Map();
  const ids = [...new Set((applicantIds || []).filter(Boolean))];
  if (!ids.length) return { ready: true, byId, raw };
  const dec = await readIn(ab, "gw_hr_ceo_decisions", "id, applicant_id, decision, decided_by, decided_at, created_at", tenantId, ids);
  if (dec.error) return { ready: false, byId, raw, error: isMissingTable(dec.error) ? null : dec.error };
  const latest = latestBy(dec.rows, "applicant_id", "decided_at");
  const intakesR = await readIn(ab, "gw_hr_office_intakes",
    "id, applicant_id, office_status, handed_at, handed_by, office_assignee_id, unresolved_items, returned_at, exception_reason, client_request_id, received_at, closed_at", tenantId, ids);
  if (intakesR.error) return { ready: false, byId, raw, error: isMissingTable(intakesR.error) ? null : intakesR.error };
  const activeIntake = new Map();
  for (const i of intakesR.rows) if (!i.returned_at) activeIntake.set(i.applicant_id, i);
  // 合格（最新）の人だけ、オファーの版の有無・ヒアリングを読む（多くの応募者は読まない）
  const passIds = ids.filter((id) => latest.get(id)?.decision === "pass" && !activeIntake.has(id));
  let offers = [];
  let hearings = [];
  let pays = [];
  if (passIds.length) {
    const o = await readIn(ab, "gw_hr_offers", "id, applicant_id", tenantId, passIds);
    if (o.error) return { ready: false, byId, raw, error: o.error };
    offers = o.rows;
    const h = await readIn(ab, "gw_hr_hearings", "*", tenantId, passIds);
    if (h.error) return { ready: false, byId, raw, error: isMissingTable(h.error) ? null : h.error };
    hearings = h.rows.filter((x) => !x.locked_at);
    const hids = hearings.map((x) => x.id);
    for (const part of chunks(hids)) {
      const { data, error } = await ab.from("gw_hr_hearing_pay").select("hearing_id, desired_amount").in("hearing_id", part);
      if (error) return { ready: false, byId, raw, error: isMissingTable(error) ? null : error };
      pays.push(...(data || []));
    }
  }
  // Office で手続き中の人：いまの Office の状態を事実から決める（HR の一覧・詳細も Office と同じ状態を出す）
  const officeStatus = new Map();
  if (activeIntake.size) {
    const of = await readOfficeFacts(ab, tenantId, [...activeIntake.values()]);
    if (of.error) return { ready: false, byId, raw, error: of.error };
    for (const [aid, x] of of.byApplicant) officeStatus.set(aid, officeStatusOf({ intake: activeIntake.get(aid), ...x }));
  }
  const hasOffer = new Set(offers.map((o) => o.applicant_id));
  const hearingOf = new Map(hearings.map((h) => [h.applicant_id, h]));
  const payEntered = new Set(pays.filter((p) => p.desired_amount !== null && p.desired_amount !== undefined).map((p) => p.hearing_id));
  for (const id of ids) {
    const f = {
      decision: latest.get(id) || null, hasOffer: hasOffer.has(id), hearing: hearingOf.get(id) || null,
      payEntered: hearingOf.has(id) && payEntered.has(hearingOf.get(id).id), intake: activeIntake.get(id) || null,
      officeStatus: officeStatus.get(id) || null,
    };
    const s = intakeStateOf(f);
    if (s) { byId.set(id, s); raw.set(id, f); }
  }
  return { ready: true, byId, raw };
}

/**
 * Office へ引き渡し済み（差し戻していない引き渡しがある）応募者の ID。表が無ければ空。
 * 状態の変更・一括操作・オファーの作成を止めるのに使う（フラグに関係なく。引き渡しの記録があれば守る）
 */
export async function activeIntakeIds(ab, tenantId, ids) {
  const out = new Set();
  const r = await readIn(ab, "gw_hr_office_intakes", "applicant_id, returned_at", tenantId, [...new Set(ids)]);
  if (r.error) {
    if (isMissingTable(r.error)) return out;
    throw r.error;
  }
  for (const i of r.rows) if (!i.returned_at) out.add(i.applicant_id);
  return out;
}

/**
 * 1人の有効な引き渡し（差し戻していないもの）。無ければ null。表が無ければ null（db/143 未適用）。それ以外の失敗は投げる
 * （社員登録のガード〔api/hr/applicants/advance.js〕・Office の API が使う。分からないときは進めない）
 */
export async function activeIntakeOf(ab, tenantId, applicantId) {
  if (!applicantId) return null;
  const { data, error } = await ab.from("gw_hr_office_intakes").select("*")
    .eq("tenant_id", tenantId).eq("applicant_id", applicantId);
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return (data || []).find((i) => !i.returned_at) || null;
}

/** 引き渡しで Office へ写す内容（給与の値は入れない。給与は「候補者希望あり／未確定」だけ） */
export function hearingSnapshot(h, payEntered) {
  const out = {};
  for (const k of VALUE_KEYS) out[k] = h?.[k] ?? null;
  out.offer_type_label = offerTypeLabel(h?.offer_type) || null;
  out.desired_pay = (h?.unresolved || []).includes("desired_pay") ? "unresolved" : payEntered ? "entered" : null;
  out.unresolved = Array.isArray(h?.unresolved) ? h.unresolved : [];
  return out;
}

// ---- Office の状態（9つ）を事実から決める（HR と Office で同じ関数。画面ごとに二重に持たない） ------------------------
//
//   保存してある office_status は「事実から決められない手動の段階」の補助だけ：受領（received_at）・辞退／不成立（withdrawn）・完了（completed）。
//   それ以外は、採用条件の版（gw_hr_offers）・社労士への依頼・正式PDF（db/139）・本人の承諾・締結・引き渡し（handoff_at）・社員登録から決める。
//   Office の API は、操作のたびに決めた値を office_status へ写す（一覧の絞り込み・DB の索引のため。表示はいつもこの関数）。
//
//   未着手 … 受領前／条件整理中 … 受領した〜会社の採用条件を確定する前／社労士依頼中 … 条件を確定し、社労士へ依頼する・依頼の差し戻し後
//   正式PDF受領待ち … 依頼済み〜正式PDFの受領・照合・承認・LegalSign の登録〜本人へ案内する前／本人承諾待ち … 本人へ案内した〜同意の前
//   契約手続き中 … 本人が同意した〜締結の確認・［社員登録へ進める準備］の前／入社準備中 … 社員登録・入社書類・アカウント・端末・オリエンテーション
//   完了 … Office が［入社完了］を記録（社員登録のあとだけ）／辞退・不成立 … Office が理由つきで記録（本人が回答ページで辞退したときも）

const STEP_OF_CONTRACT = {
  conditions: "organizing", request_pending: "attorney_requested", returned: "attorney_requested",
  requested: "awaiting_official_pdf", review_pending: "awaiting_official_pdf", guide_prep: "awaiting_official_pdf", approved: "awaiting_official_pdf",
  guided: "awaiting_consent", expired: "awaiting_consent", signed_before_consent: "awaiting_consent",
  consented: "contracting", formal_waiting: "contracting", signed: "contracting",
  handed_off: "preparing_join", declined: "withdrawn",
};
const PRE_CONFIRM = ["offer_draft_pending", "offer_review_pending"];

/** いま有効な版（無効化していない最新の版）。lib/hr.js activeOffer と同じ（循環して読み込まないよう、ここにも置く） */
export const currentOfferOf = (offers) => (offers || []).filter((o) => !o.revoked_at)
  .sort((a, b) => Number(b.version) - Number(a.version))[0] || null;

const NEXT = {
  receive: { label: "HRからの引き継ぎを受け取り、担当を決めてください", cta: "受領して着手", action: "receive" },
  createOffer: { label: "会社の採用条件（本人へ提示する正式な条件）を作ってください", cta: "採用条件を作る", action: "createOffer" },
  confirmOffer: { label: "採用条件を確定してください（給与・報酬を決めるのは経営者）", cta: "採用条件を確定", action: "confirmOffer" },
  request: { label: "社労士へ書類の作成を依頼し、［依頼済みにする］を押してください", cta: "社労士へ依頼する", action: "contract", step: "markRequested" },
  wait_pdf: { label: "社労士から正式PDFが届いたら、受け取ってください", cta: "正式PDFを受け取る", action: "contract", step: "attach" },
  review: { label: "受け取った正式PDFを条件と照合して承認してください（給与を見られる人）", cta: "照合して承認", action: "contract", step: "approve" },
  legalsign: { label: "LegalSign に承認した正式PDFを登録してください（例外ルートも選べます）", cta: "LegalSign の登録を記録", action: "contract", step: "legalsign" },
  guide: { label: "本人専用URLを発行して本人へ案内し、［送付済みにする］を押してください", cta: "本人専用URLを発行", action: "issueLink" },
  markSent: { label: "本人専用URLを本人へ送ったら、［送付済みにする］を押してください", cta: "送付済みにする", action: "markSent" },
  consent: { label: "本人の条件同意を待っています", cta: null, action: null },
  signed: { label: "LegalSign（または例外ルート）の締結を確かめて記録してください", cta: "締結を記録", action: "contract", step: "signed" },
  formalHandoff: { label: "本人の同意と締結を確かめて、社員登録へ進める準備をしてください", cta: "社員登録へ進める準備", action: "formalHandoff" },
  register: { label: "社員登録（入社手続き）へ進めてください", cta: "社員登録へ", action: "register" },
  onboarding: { label: "入社書類・アカウント・端末・オリエンテーションを進め、終わったら入社完了にしてください", cta: "入社完了にする", action: "complete" },
  declined: { label: "本人が辞退しました。辞退・不成立として記録してください", cta: "辞退・不成立を記録", action: "withdraw" },
  done: { label: "入社まで完了しました", cta: null, action: null },
  withdrawn: { label: "辞退・不成立として記録済みです（履歴は残ります）", cta: null, action: null },
};

/**
 * Office の状態・次にやること（ボタンは1つ）・期限。HR（readIntakeFacts）と Office（api/hr/office-intakes.js）が同じ関数を使う。
 * @param {{intake:object, applicant?:object|null, offers?:object[], docs?:object[], requests?:object[]}} f
 * @returns {{key:string, label:string, step:string|null, next:object, deadline:string|null}|null}
 */
export function officeStatusOf({ intake, applicant = null, offers = [], docs = [], requests = [] } = {}) {
  if (!intake) return null;
  const desired = intake.hearing_snapshot?.desired_join_date || null;
  const out = (key, next, step = null, deadline = desired) => ({ key, label: officeStatusLabel(key), step, next, deadline: deadline || null });
  if (intake.office_status === "withdrawn" || intake.closed_at) return out("withdrawn", NEXT.withdrawn, null, null);
  if (intake.office_status === "completed") return out("completed", NEXT.done, null, null);
  if (applicant?.employee_id || applicant?.status === "done") return out("preparing_join", NEXT.onboarding, "registered");
  const offer = currentOfferOf(offers);
  if (!offer) return intake.received_at ? out("organizing", NEXT.createOffer, "no_offer") : out("not_started", NEXT.receive);
  if (offer.handoff_at) return out("preparing_join", NEXT.register, "handed_off");
  if (offer.declined_at || applicant?.status === "declined") return out("withdrawn", NEXT.declined, "declined", null);
  const status = applicant?.status || null;
  if (usesOfficial(offer)) {
    const st = contractStateOf({
      offer, status, docs: docs.filter((d) => d.offer_id === offer.id), requests: requests.filter((r) => r.offer_id === offer.id),
    });
    const key = STEP_OF_CONTRACT[st] || "organizing";
    const next = {
      conditions: NEXT.confirmOffer,
      request_pending: NEXT.request, returned: NEXT.request, requested: NEXT.wait_pdf, review_pending: NEXT.review,
      guide_prep: NEXT.legalsign, approved: offer.sent_at ? NEXT.markSent : NEXT.guide,
      guided: offer.formal_signed_at || formalRequiredOf(offer) === false ? NEXT.consent : NEXT.signed,
      expired: { label: "回答期限を過ぎました。本人へ確認してください（辞退なら記録します）", cta: "辞退・不成立を記録", action: "withdraw" },
      signed_before_consent: NEXT.consent,
      consented: NEXT.formalHandoff, signed: NEXT.formalHandoff, formal_waiting: NEXT.signed,
    }[st] || NEXT.confirmOffer;
    return out(key, next, st, ["guided", "expired", "signed_before_consent"].includes(st) ? offer.respond_by || null : desired);
  }
  // 正式PDFの流れでない版（HR の条件通知書で送る版）
  if (!offer.sent_at) {
    if (PRE_CONFIRM.includes(status)) return out("organizing", NEXT.confirmOffer, "conditions");
    return out("awaiting_official_pdf", NEXT.guide, "send_pending");
  }
  if (!offer.accepted_at) return out("awaiting_consent", NEXT.consent, "guided", offer.respond_by || null);
  if (formalRequiredOf(offer) !== false && !offer.formal_signed_at) return out("contracting", NEXT.signed, "formal_waiting");
  return out("contracting", NEXT.formalHandoff, "consented");
}

/**
 * Office の状態を決めるための事実（引き渡しのある応募者ぶん）。service role で読む（認可のあと）。
 * 表が無い（db/139 未適用）ときは、依頼・正式PDFを空として扱う（版と承諾だけで決める）
 * @returns {Promise<{byApplicant: Map<string, {applicant, offers, docs, requests}>, error?: object}>}
 */
export async function readOfficeFacts(ab, tenantId, intakes) {
  const byApplicant = new Map();
  const ids = [...new Set((intakes || []).map((i) => i.applicant_id).filter(Boolean))];
  if (!ids.length) return { byApplicant };
  const ap = await readApplicantsIn(ab, tenantId, ids);
  if (ap.error) return { byApplicant, error: ap.error };
  const of = await readIn(ab, "gw_hr_offers", "*", tenantId, ids);
  if (of.error) return { byApplicant, error: of.error };
  let docs = [], requests = [];
  const d = await readIn(ab, "gw_hr_offer_official_docs", "id, applicant_id, offer_id, status, file_sha256, reviewed_at, revision", tenantId, ids);
  if (!d.error) docs = d.rows; else if (!isMissingTable(d.error)) return { byApplicant, error: d.error };
  const r = await readIn(ab, "gw_hr_attorney_requests", "id, applicant_id, offer_id, requested_at", tenantId, ids);
  if (!r.error) requests = r.rows; else if (!isMissingTable(r.error)) return { byApplicant, error: r.error };
  for (const id of ids) {
    byApplicant.set(id, {
      applicant: ap.rows.find((a) => a.id === id) || null,
      offers: of.rows.filter((o) => o.applicant_id === id),
      docs: docs.filter((x) => x.applicant_id === id),
      requests: requests.filter((x) => x.applicant_id === id),
    });
  }
  return { byApplicant };
}
async function readApplicantsIn(ab, tenantId, ids) {
  const rows = [];
  for (const part of chunks(ids)) {
    const { data, error } = await ab.from("gw_hr_applicants").select("id, status, employee_id").eq("tenant_id", tenantId).in("id", part);
    if (error) return { error };
    rows.push(...(data || []));
  }
  return { rows };
}
