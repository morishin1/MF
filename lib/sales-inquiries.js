// 無限道場の自治体向けLP（mugendojo.jp/lp）からの問い合わせを、EIGHT SALES（/sales）の営業リードとして受け付ける。
//
// ■ 入れ先（新しい表・列は作らない）
//   gw_sales_companies … 自治体（会社）。同じテナントに同じ名前の会社があればそれに足す。無ければ作る
//                        ステータスは「返信あり」（相手から反応があった＝/sales/leads に出る）。後ろへは戻さない
//   gw_sales_events    … 出来事「LP問い合わせ」（event_key = lp_inquiry、channel = form）。
//                        種別・部署・担当者・連絡先・地域・時期・予算・相談内容と、どこから来たか（source・source_detail・inquiry_type）、送信IDを本文に残す
//   通知              … 会社の担当者、いなければ経営者（owner）。Slack（設定があれば）
// ■ 再送
//   同じ送信ID（submission_id）は2回目以降なにもしない（result: replayed）
// ■ 署名
//   HR リード（lib/hr-leads.js）と同じ鍵 MUGENDOJO_LEAD_SECRET。署名する文字列の先頭に "sales." を付けて、HR の口と分ける。
import crypto from "node:crypto";
import { canonicalJson, normalizeEmail, SIGNATURE_TOLERANCE_SEC } from "./hr-leads.js";
import { parsePrefecture } from "./sales-master.js";
import { statusRank, CLOSED_STATUSES, todayJst } from "./sales.js";

export const INQUIRY_TYPES = { consult: "自治体向け導入相談", doc: "事業資料の請求", biz: "地域企業のDX相談" };
export const INQUIRY_SOURCES = { mugendojo_lp: ["local_gov"] };
export const INQUIRY_EVENT_KEY = "lp_inquiry";
const WHEN = ["今年度中", "来年度", "未定・情報収集中"];
const BUDGET = ["予算化済み", "予算要求を検討中", "未定"];

export function signSalesInquiry(secret, timestamp, body) {
  return `v1=${crypto.createHmac("sha256", secret).update(`sales.${timestamp}.${canonicalJson(body)}`, "utf8").digest("hex")}`;
}

/** @returns {{ok:true}|{ok:false,status:number,error:string}} */
export function verifySalesSignature(headers, body, { secret, now = Date.now(), toleranceSec = SIGNATURE_TOLERANCE_SEC } = {}) {
  if (!secret) return { ok: false, status: 503, error: "not_configured" };
  const h = headers || {};
  const ts = String(h["x-lead-timestamp"] || "").trim();
  const sig = String(h["x-lead-signature"] || "").trim();
  if (!/^\d{9,11}$/.test(ts) || !sig) return { ok: false, status: 401, error: "unauthorized" };
  const expected = Buffer.from(signSalesInquiry(secret, ts, body));
  const given = Buffer.from(sig);
  if (!(expected.length === given.length && crypto.timingSafeEqual(expected, given))) return { ok: false, status: 401, error: "unauthorized" };
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > toleranceSec) return { ok: false, status: 401, error: "timestamp_out_of_range" };
  return { ok: true };
}

const str = (s, max) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t ? t.slice(0, max) : null; };
const text = (s, max) => { const t = String(s ?? "").trim(); return t ? t.slice(0, max) : null; };

/** 届いた本文を確かめる。@returns {{value:object}|{error:string, field:string}} */
export function normalizeInquiry(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "invalid_body", field: "body" };
  const submissionId = str(b.submission_id, 80);
  if (!submissionId || !/^[A-Za-z0-9_.:-]{8,80}$/.test(submissionId)) return { error: "invalid_body", field: "submission_id" };
  const source = str(b.source, 40), detail = str(b.source_detail, 40);
  if (!source || !INQUIRY_SOURCES[source] || !INQUIRY_SOURCES[source].includes(detail)) return { error: "invalid_body", field: "source" };
  const type = str(b.inquiry_type, 20);
  if (!INQUIRY_TYPES[type]) return { error: "invalid_body", field: "inquiry_type" };
  const org = str(b.org, 100);
  if (!org) return { error: "invalid_body", field: "org" };
  const name = str(b.name, 60);
  if (!name) return { error: "invalid_body", field: "name" };
  const email = normalizeEmail(b.email);
  if (!email) return { error: "invalid_body", field: "email" };
  const dept = str(b.dept, 100);
  if (type !== "biz" && !dept) return { error: "invalid_body", field: "dept" };
  if (b.privacy_agreed !== true) return { error: "invalid_body", field: "privacy_agreed" };
  const tel = str(b.tel, 20);
  if (tel && !/^[0-9０-９+＋()（）\-－‐ ]{1,20}$/.test(tel)) return { error: "invalid_body", field: "tel" };
  return {
    value: {
      submissionId, source, sourceDetail: detail, type, typeLabel: INQUIRY_TYPES[type], org, dept, name, email, tel,
      area: str(b.area, 100),
      timing: WHEN.includes(b.timing) ? b.timing : null,
      budget: BUDGET.includes(b.budget) ? b.budget : null,
      message: text(b.message, 2000),
      pageUrl: (() => { const u = str(b.page_url, 500); return u && /^https?:\/\//i.test(u) ? u : null; })(),
      utm: Object.fromEntries(["utm_source", "utm_medium", "utm_campaign"].map((k) => [k, str(b[k], 100)]).filter(([, v]) => v)),
    },
  };
}

/** 出来事の本文（画面の営業履歴に出る。送信IDで再送を見分ける） */
export function inquiryDetail(v) {
  return [
    `お問い合わせ種別：${v.typeLabel}`,
    `${v.type === "biz" ? "会社名" : "自治体名"}：${v.org}`,
    `部署名：${v.dept || "（未入力）"}`,
    `担当者名：${v.name}`,
    `メール：${v.email}`,
    `電話：${v.tel || "（未入力）"}`,
    `対象地域：${v.area || "（未入力）"}`,
    v.type === "consult" ? `想定時期／予算：${[v.timing, v.budget].filter(Boolean).join("／") || "（未選択）"}` : null,
    `相談内容：${v.message || "（未入力）"}`,
    `経路：source=${v.source} source_detail=${v.sourceDetail} inquiry_type=${v.type}`,
    Object.keys(v.utm).length ? `UTM：${Object.entries(v.utm).map(([k, x]) => `${k}=${x}`).join(" ")}` : null,
    `送信ID：${v.submissionId}`,
  ].filter(Boolean).join("\n").slice(0, 2000);
}

const esc = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * 受け付けて保存する。
 * @returns {Promise<{result:"created"|"updated"|"replayed", companyId:string, notifyTo:string[], companyName:string}|{error:string,status:number,detail?:string}>}
 */
export async function intakeInquiry(sb, tenantId, v, { now = new Date() } = {}) {
  // 1. 同じ送信IDは何もしない
  const { data: seen, error: e0 } = await sb.from("gw_sales_events").select("id, company_id")
    .eq("tenant_id", tenantId).eq("event_key", INQUIRY_EVENT_KEY).ilike("detail", `%送信ID：${esc(v.submissionId)}%`).limit(1);
  if (e0) return { error: "db_query_failed", status: 500, detail: e0.message };
  if (seen && seen.length) return { result: "replayed", companyId: seen[0].company_id, notifyTo: [], companyName: v.org };

  // 2. 会社（自治体）：同じ名前があれば、それに足す
  const nowIso = now.toISOString();
  const { data: found, error: e1 } = await sb.from("gw_sales_companies")
    .select("id, name, status, owner_id, emails, ng_reason, note").eq("tenant_id", tenantId).ilike("name", esc(v.org)).limit(1);
  if (e1) return { error: "db_query_failed", status: 500, detail: e1.message };
  const next = { next_action: `LP問い合わせ（${v.typeLabel}）に返信`, next_action_on: todayJst(now) };
  let company = found && found[0];
  let result = "updated";
  if (company) {
    const patch = { updated_at: nowIso, last_contact_at: nowIso };
    const emails = Array.isArray(company.emails) ? company.emails : [];
    if (!emails.includes(v.email)) patch.emails = [...emails, v.email].slice(0, 20);
    // 営業禁止・成約・失注・対象外の会社は、ステータスと NEXT を動かさない（記録と通知だけ）
    if (!company.ng_reason && !CLOSED_STATUSES.includes(company.status)) {
      if (statusRank(company.status) < statusRank("replied")) patch.status = "replied";
      Object.assign(patch, next);
    }
    const { error } = await sb.from("gw_sales_companies").update(patch).eq("id", company.id);
    if (error) return { error: "db_update_failed", status: 500, detail: error.message };
  } else {
    const pref = parsePrefecture(v.area || "");
    const row = {
      tenant_id: tenantId, name: v.org, status: "replied",
      region: pref?.prefecture || null, address: v.area || null, phone: v.tel || null, emails: [v.email],
      service: v.type === "biz" ? "AI / DX" : "地方創生",
      note: `無限道場 自治体向けLPからの問い合わせで登録（${v.typeLabel}）`,
      last_contact_at: nowIso, created_at: nowIso, updated_at: nowIso, ...next,
    };
    const { data: made, error } = await sb.from("gw_sales_companies").insert(row).select("id, name, status, owner_id").single();
    if (error || !made) return { error: "db_insert_failed", status: 500, detail: error?.message };
    company = made;
    result = "created";
  }

  // 3. 出来事「LP問い合わせ」
  const { error: e2 } = await sb.from("gw_sales_events").insert({
    tenant_id: tenantId, company_id: company.id, event_key: INQUIRY_EVENT_KEY, label: `LP問い合わせ（${v.typeLabel}）`,
    detail: inquiryDetail(v), occurred_at: nowIso, channel: "form", employee_id: null, created_by: null,
  });
  if (e2) return { error: "db_insert_failed", status: 500, detail: e2.message };

  // 4. 通知の宛先：会社の担当者、いなければ経営者（在籍中だけ）
  let notifyTo = company.owner_id ? [company.owner_id] : [];
  if (!notifyTo.length) {
    const { data: owners } = await sb.from("gw_role_grants").select("employee_id").eq("tenant_id", tenantId).eq("role", "owner");
    const ids = [...new Set((owners || []).map((o) => o.employee_id))];
    if (ids.length) {
      const { data: emps } = await sb.from("gw_employees").select("id, status").in("id", ids);
      notifyTo = (emps || []).filter((e) => e.status !== "left").map((e) => e.id);
    }
  }
  return { result, companyId: company.id, notifyTo, companyName: company.name };
}
