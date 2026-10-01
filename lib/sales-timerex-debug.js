// Sales 用 TimeRex Webhook の DEBUG 受信（/api/sales/timerex/webhook）。
//
// ■ 目的
//   営業の初回商談カレンダー（TIMEREX_SALES_MEETING_URL）から届く Webhook の「形」を、
//   実データで確かめる。ここでは DB に一切書かない（gw_sales_meetings も触らない）。
//   確かめたいこと：webhook の種類・event.id・calendar_url_path・start_datetime・
//   google_meet_meeting の構造・form の field_type 一覧・予約URLに付けた
//   sales_company_id / sales_meeting_id が返ってくるか・日程変更の old/new event id・キャンセルの種類
//
// ■ ログに出すもの・出さないもの
//   出す：キー名・型・有無。値は、個人情報を含まない識別子だけ（webhook_type・event.id・
//         calendar_url_path・old/new event id・form の field_type。英数字と記号の短い値に限る）
//   出さない：payload 全文・ヘッダー・氏名・メールアドレス・電話番号・会社名・備考・
//             Meet URL・日程変更/取消 URL・日時の値・sales_company_id / sales_meeting_id の値・Secret
//   sales_company_id / sales_meeting_id は「どこに（キーのパス）」「UUID の形か」だけを出す
//
// ■ 採用HRとは別
//   採用HRの TimeRex（lib/hr-timerex.js・api/hr/timerex/webhook.js・TIMEREX_WEBHOOK_SECRET）は使わない。
//   予約枠の読み方（URL の最後の部分）だけ、副作用の無い calendarKey() を借りる。

import crypto from "node:crypto";
import { calendarKey } from "./hr-timerex-calendars.js";

export const AUTH_HEADER = "x-timerex-authorization";   // TimeRex 標準の固定ヘッダー（HR で実機確認済み）
const SALES_KEYS = ["sales_company_id", "sales_meeting_id"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEPTH = 5;

/** ログに出してよい識別子（英数字と記号の短い値）。それ以外は "(redacted)" */
export const safeId = (v) => {
  if (v == null || v === "") return null;
  const s = String(v).slice(0, 80);
  return /^[A-Za-z0-9_.:-]+$/.test(s) ? s : "(redacted)";
};

/** Sales 用の Secret（TIMEREX_SALES_WEBHOOK_SECRET）と、ヘッダーの値を定数時間で比べる */
export function verifySalesSecret(headers, env = process.env) {
  const configured = env.TIMEREX_SALES_WEBHOOK_SECRET || "";
  if (!configured) return { ok: false, status: 503, error: "not_configured" };
  const given = headers && headers[AUTH_HEADER];
  if (!given || typeof given !== "string") return { ok: false, status: 401, error: "unauthorized" };
  const a = Buffer.from(given);
  const b = Buffer.from(configured);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * 値の「形」だけ（キー名と型）。文字列は中身を出さず、空かどうかと、URL・日時らしいかだけ
 */
export function shapeOf(v, depth = 0) {
  const t = typeOf(v);
  if (t === "string") {
    if (!v) return "string(empty)";
    if (/^https?:\/\//i.test(v)) return "string(url)";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return /([+-]\d{2}:?\d{2}|Z)$/.test(v) ? "string(datetime+offset)" : "string(datetime)";
    return "string";
  }
  if (t === "array") {
    if (depth >= MAX_DEPTH) return `array(${v.length})`;
    return { type: "array", length: v.length, item: v.length ? shapeOf(v[0], depth + 1) : null };
  }
  if (t === "object") {
    if (depth >= MAX_DEPTH) return "object";
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf(v[k], depth + 1)]));
  }
  return t;
}

/**
 * sales_company_id / sales_meeting_id が payload のどこかに返ってきているか。
 * キーとして（…sales_meeting_id: "…"）でも、URL などの文字列の中（?sales_meeting_id=…）でも探す。
 * 値は出さない。見つかった場所（パス）・どちらの名前か・UUID の形か・どう入っていたか（key / query）だけ
 */
export function findSalesParams(body) {
  const found = [];
  const walk = (v, path, depth) => {
    if (depth > 8 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        if (SALES_KEYS.includes(k)) found.push({ path: p, name: k, via: "key", uuid: UUID_RE.test(String(x ?? "")) });
        walk(x, p, depth + 1);
      }
      return;
    }
    if (typeof v === "string") {
      for (const name of SALES_KEYS) {
        const m = new RegExp(`[?&#]${name}=([^&#\\s]*)`).exec(v);
        if (m) found.push({ path, name, via: "query", uuid: UUID_RE.test(decodeURIComponent(m[1])) });
      }
    }
  };
  walk(body, "", 0);
  return found;
}

/**
 * DEBUG 用のまとめ（そのまま console に出してよいものだけ）
 * @returns {object}
 */
export function salesDebugSummary(body, env = process.env) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const ev = b.event && typeof b.event === "object" && !Array.isArray(b.event) ? b.event : {};
  const calendarPath = b.calendar_url_path ?? ev.calendar_url_path ?? null;
  const salesKey = calendarKey(env.TIMEREX_SALES_MEETING_URL);
  const form = Array.isArray(ev.form) ? ev.form : null;
  return {
    webhook_type: safeId(b.webhook_type),
    event_id: safeId(ev.id),
    calendar_url_path: safeId(calendarPath),
    calendar_url_path_at: b.calendar_url_path != null ? "body" : ev.calendar_url_path != null ? "event" : null,
    // TIMEREX_SALES_MEETING_URL の予約枠と同じか（営業の初回商談カレンダーからか）
    matches_sales_calendar: Boolean(salesKey && calendarKey(calendarPath) === salesKey),
    sales_calendar_configured: Boolean(salesKey),
    start_datetime: ev.start_datetime == null ? null : shapeOf(ev.start_datetime),
    local_start_datetime: ev.local_start_datetime == null ? null : shapeOf(ev.local_start_datetime),
    google_meet_meeting: ev.google_meet_meeting == null ? null : shapeOf(ev.google_meet_meeting),
    form_field_types: form ? form.map((f) => safeId(f && f.field_type)) : null,
    form_value_types: form ? form.map((f) => (f && "value" in f ? shapeOf(f.value) : "missing")) : null,
    is_changed: typeof ev.is_changed === "boolean" ? ev.is_changed : ev.is_changed == null ? null : typeOf(ev.is_changed),
    old_event_id: safeId(ev.old_event_id),
    new_event_id: safeId(ev.new_event_id),
    // 予約URLに付けた sales_company_id / sales_meeting_id が、どこかに返ってきているか
    sales_params: findSalesParams(b),
    // 全体の形（キーと型だけ）。キャンセルの payload の違いもここで見る
    top_level_keys: Object.keys(b).sort(),
    event_keys: Object.keys(ev).sort(),
    shape: shapeOf(b),
  };
}
