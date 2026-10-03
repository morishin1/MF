// 外部LPから来たリードを、採用HRの応募者（gw_hr_applicants）として受け付ける。
// いまの送り手は無限道場（mugendojo.jp・eight-its/lms）だけ。api/hr/leads.js から使う。
//
// ■ 新しいCRMは作らない（db/118）
//   リードは採用候補者と同じ表に入れて、lead_category で分ける。面談・タイムライン・
//   TimeRex 連携・通知は既存のものをそのまま使う。
//
// ■ ブラウザからは呼ばせない（サーバー間だけ）
//   mugendojo.jp のサーバー → このAPI。HMAC-SHA256 の署名と時刻で確かめる。
//   ブラウザに秘密鍵は置けないので、ブラウザから直接送られたものは必ず 401 になる。
//
//   ヘッダー
//     x-lead-timestamp  送った時刻（UNIX秒）。前後5分を超えたら受け付けない（使い回し対策）
//     x-lead-signature  "v1=" + hex( HMAC-SHA256( MUGENDOJO_LEAD_SECRET, `${timestamp}.${canonicalJson(body)}` ) )
//
//   署名するのは「生の本文」ではなく canonicalJson(body)（キーを並べ替えた JSON）。
//   Vercel は本文を先に読んで req.body にしてしまうことがあり、生のバイト列を
//   確実には取れない。送り手と受け手が同じ並べ方をすれば、途中で空白や順番が
//   変わっても同じ文字列になる。並べ方は下の canonicalJson がただ1つの正
//   （lms 側の src/lib/hr-lead-client.ts も同じ実装。docs/hr-leads-api.md）。
//
// ■ 重複（同じ人が何度送っても行を増やさない）
//   tenant + lead_category=mugendojo + 小文字にしたメール で1人。見つかれば
//   新しく作らず、最新の流入・興味・診断・最終接触日時を足して更新する。
//   同じ送信ID（submission_id）の再送は、何も変えずに同じ応募者を返す（冪等）。
//   採用の応募者に同じメールがあっても統合しない（別の行を作り、タイムラインに注記する）。

import crypto from "node:crypto";
import { dbSetupHint } from "./http.js";
import { notify } from "./notify.js";
import { LEAD_CATEGORY_LABEL } from "./hr-lead-flow.js";

export { LEAD_CATEGORY_LABEL };
export const LEAD_CATEGORIES = ["recruitment", "mugendojo", "internship", "other"];

// ---- 一覧・詳細で読む列（db/118） -------------------------------------------------
//
// db/118 を流す前の環境でも、採用HRの一覧・詳細を止めない。リードの列を足して読み、
// 「列が無い」で失敗したら足さずに読み直す（画面はリードの欄を出さないだけ）。
export const LEAD_FIELDS = "lead_category, utm_source, utm_medium, utm_campaign, attribution, "
  + "lead_profile, last_contacted_at, lead_next_action";

export const isMissingColumn = (e) => String(e?.code || "") === "42703"
  || /column .* does not exist/i.test(String(e?.message || ""));

/**
 * @param {(fields:string, withLead:boolean)=>PromiseLike<{data:any,error:any}>} run
 *   列（と、リードの列を含むか）を受け取ってクエリを返す。withLead=false のときは lead_category で絞れない
 * @returns {Promise<{data:any,error:any,leadReady:boolean}>}
 */
export async function selectWithLeadFields(run, fields) {
  const first = await run(`${fields}, ${LEAD_FIELDS}`, true);
  if (!first.error) return { ...first, leadReady: true };
  if (!isMissingColumn(first.error)) return { ...first, leadReady: false };
  const again = await run(fields, false);
  return { ...again, leadReady: false };
}

/** 無限道場リードの最初の状態。予約を待っている（TimeRex の予約で interview_scheduled へ進む） */
export const MUGENDOJO_INITIAL = { stage: "applied", status: "scheduling" };
export const MUGENDOJO_SOURCE = "無限道場LP";
export const MUGENDOJO_JOB_TITLE = "無限道場 カジュアル面談";

// 署名の時刻のずれをどこまで許すか（秒）
export const SIGNATURE_TOLERANCE_SEC = 300;
// 同じ人からの送信：10分にこの回数まで
export const PER_LEAD_LIMIT = { windowMin: 10, max: 5 };
// テナント全体の新規リード：10分にこの件数まで（LP が荒らされたときの歯止め）
export const NEW_LEAD_LIMIT = { windowMin: 10, max: 60 };
// 再送の判定に覚えておく送信IDの数
const KEEP_SUBMISSION_IDS = 20;

// ---- 署名 ----------------------------------------------------------------------

/** キーを並べ替えた JSON。署名の対象（送り手と受け手で同じでなければならない） */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
}

export function signLeadRequest(secret, timestamp, body) {
  const mac = crypto.createHmac("sha256", secret).update(`${timestamp}.${canonicalJson(body)}`, "utf8").digest("hex");
  return `v1=${mac}`;
}

/**
 * @returns {{ok:true}|{ok:false,status:number,error:string}}
 */
export function verifyLeadSignature(headers, body, { secret, now = Date.now(), toleranceSec = SIGNATURE_TOLERANCE_SEC } = {}) {
  if (!secret) return { ok: false, status: 503, error: "not_configured" };
  const h = headers || {};
  const ts = String(h["x-lead-timestamp"] || "").trim();
  const sig = String(h["x-lead-signature"] || "").trim();
  if (!/^\d{9,11}$/.test(ts) || !sig) return { ok: false, status: 401, error: "unauthorized" };

  const expected = Buffer.from(signLeadRequest(secret, ts, body));
  const given = Buffer.from(sig);
  const match = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (!match) return { ok: false, status: 401, error: "unauthorized" };
  // 署名が正しくても、古い（または未来の）ものは受け付けない（盗み見た要求の使い回し対策）
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > toleranceSec) {
    return { ok: false, status: 401, error: "timestamp_out_of_range" };
  }
  return { ok: true };
}

// ---- 入力 ----------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (s, max) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t ? t.slice(0, max) : null; };
const text = (s, max) => { const t = String(s ?? "").trim(); return t ? t.slice(0, max) : null; };
const url = (s) => { const t = str(s, 500); return t && /^https?:\/\//i.test(t) ? t : null; };

/** メールを1つの形にそろえる（前後の空白を落とし、小文字にする）。形が違えば null */
export function normalizeEmail(s) {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t || t.length > 200 || !EMAIL_RE.test(t)) return null;
  return t;
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

/**
 * LP から来た本文を検証して、保存する形にする。
 * @returns {{value:object}|{error:string,detail:string,field?:string}}
 */
export function normalizeLeadPayload(body, { now = new Date() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "invalid_body", detail: "本文が JSON のオブジェクトではありません" };
  }
  const submissionId = str(body.submission_id, 80);
  if (!submissionId || !/^[A-Za-z0-9_.:-]{8,80}$/.test(submissionId)) {
    return { error: "invalid_body", field: "submission_id", detail: "submission_id（送信ごとの一意なID）が必要です" };
  }
  const name = str(body.name, 100);
  if (!name) return { error: "invalid_body", field: "name", detail: "氏名は必須です" };
  if (body.email == null || String(body.email).trim() === "") {
    return { error: "invalid_body", field: "email", detail: "メールアドレスは必須です" };
  }
  const email = normalizeEmail(body.email);
  if (!email) return { error: "invalid_body", field: "email", detail: "メールアドレスの形式が正しくありません" };

  const phone = str(body.phone, 40);
  if (phone && !/^[0-9+\-() ]{6,40}$/.test(phone)) {
    return { error: "invalid_body", field: "phone", detail: "電話番号の形式が正しくありません" };
  }

  const interests = Array.isArray(body.interests)
    ? [...new Set(body.interests.map((x) => str(x, 60)).filter(Boolean))].slice(0, 10)
    : (str(body.interests, 60) ? [str(body.interests, 60)] : []);

  const firstAt = body.first_touch_at ? new Date(body.first_touch_at) : null;
  // 読めない日時・明らかな未来は捨てる（受け付けた時刻で代わりにする）
  const firstTouchAt = firstAt && !Number.isNaN(firstAt.getTime()) && firstAt.getTime() <= now.getTime() + 60_000
    ? firstAt.toISOString() : null;

  const touch = {
    source_url: url(body.source_url),
    landing_page: url(body.landing_page),
    referrer: url(body.referrer),
    ...Object.fromEntries(UTM_KEYS.map((k) => [k, str(body[k], 200)])),
  };

  return {
    value: {
      submissionId, name, email, phone,
      leadType: str(body.lead_type, 40) || "mugendojo_casual",
      profile: {
        prefecture: str(body.prefecture, 20),
        occupation: str(body.occupation, 100),
        ai_experience: str(body.ai_experience, 100),
        it_experience: str(body.it_experience, 100),
        interests,
        challenge_text: text(body.challenge_text, 1000),
        diagnosis_type: str(body.diagnosis_type, 40),
        diagnosis_label: str(body.diagnosis_label, 100),
      },
      touch,
      firstTouchAt,
    },
  };
}

// ---- 保存 ----------------------------------------------------------------------

/** 空でない値だけで上書きする（前に入っていた値を、空で消さない）。興味は足し合わせる */
export function mergeProfile(prev, next) {
  const out = { ...(prev || {}) };
  for (const [k, v] of Object.entries(next || {})) {
    if (k === "interests") continue;
    if (v != null && v !== "") out[k] = v;
  }
  const a = Array.isArray(prev?.interests) ? prev.interests : [];
  const b = Array.isArray(next?.interests) ? next.interests : [];
  out.interests = [...new Set([...a, ...b])].slice(0, 20);
  return out;
}

const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));

/** タイムラインの補足に出す流入の1行（個人情報は入れない） */
export function touchSummary(touch) {
  const t = touch || {};
  const utm = [t.utm_source, t.utm_medium, t.utm_campaign].filter(Boolean).join(" / ");
  if (utm) return `流入: ${utm}`;
  if (t.referrer) {
    try { return `流入: ${new URL(t.referrer).hostname}`; } catch { /* そのまま下へ */ }
  }
  return "流入: 直接（UTM・参照元なし）";
}

const isUniqueViolation = (e) => String(e?.code || "") === "23505";

/** LIKE の特殊文字を、文字そのものとして扱う */
const likeLiteral = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * リード1件を受け付ける（作る・更新する・再送なら何もしない）。
 * @param sb admin()（service_role）
 * @returns {Promise<{applicantId:string,result:"created"|"updated"|"replayed",applicant:object}
 *                   |{error:string,status:number,detail?:string,message?:string}>}
 */
export async function intakeLead(sb, tenantId, lead, { category = "mugendojo", now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const touch = { ...compact(lead.touch), at: nowIso };

  const existing = await findLead(sb, tenantId, category, lead.email);
  if (existing.error) return existing;

  if (existing.row) return updateLead(sb, tenantId, existing.row, lead, touch, { now, category });

  // テナント全体の新規リードの勢いを見る（LP が荒らされたときの歯止め）
  const since = new Date(now.getTime() - NEW_LEAD_LIMIT.windowMin * 60_000).toISOString();
  const { count, error: cerr } = await sb.from("gw_hr_applicants").select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId).eq("lead_category", category).gte("created_at", since);
  if (cerr) return dbError(cerr);
  if ((count || 0) >= NEW_LEAD_LIMIT.max) return { error: "rate_limited", status: 429 };

  const first = { ...touch, at: lead.firstTouchAt || nowIso };
  const row = {
    tenant_id: tenantId,
    name: lead.name, email: lead.email, phone: lead.phone,
    source: MUGENDOJO_SOURCE, job_title: MUGENDOJO_JOB_TITLE,
    ...MUGENDOJO_INITIAL,
    lead_category: category,
    utm_source: lead.touch.utm_source || null,
    utm_medium: lead.touch.utm_medium || null,
    utm_campaign: lead.touch.utm_campaign || null,
    attribution: {
      lead_type: lead.leadType, source_type: category,
      first, last: touch, submission_ids: [lead.submissionId], touches: 1,
    },
    lead_profile: mergeProfile({}, lead.profile),
    last_contacted_at: nowIso,
    recruiter_id: null,
    created_at: nowIso, updated_at: nowIso,
  };
  const { data: made, error } = await sb.from("gw_hr_applicants").insert(row).select("*").single();
  if (error) {
    // 同時に2回送られて、もう一方が先に作った（無限道場の一意索引）。その行を更新する側へ回る
    if (isUniqueViolation(error)) {
      const again = await findLead(sb, tenantId, category, lead.email);
      if (again.row) return updateLead(sb, tenantId, again.row, lead, touch, { now, category });
    }
    return dbError(error);
  }

  await sb.from("gw_hr_timeline").insert({
    tenant_id: tenantId, applicant_id: made.id, event_key: "applied",
    label: `${MUGENDOJO_SOURCE}からカジュアル面談の申込`, detail: touchSummary(touch),
  });

  // 採用の応募者に同じメールの人がいても、統合しない。気づけるように残すだけ
  const { data: sameEmail } = await sb.from("gw_hr_applicants").select("*")
    .eq("tenant_id", tenantId).ilike("email", likeLiteral(lead.email));
  const others = (sameEmail || []).filter((a) => a.id !== made.id && (a.lead_category || "recruitment") !== category);
  if (others.length) {
    await sb.from("gw_hr_timeline").insert({
      tenant_id: tenantId, applicant_id: made.id, event_key: "lead_same_email",
      label: "同じメールアドレスの応募者が別にいます（統合していません）",
      detail: others.map((a) => LEAD_CATEGORY_LABEL[a.lead_category || "recruitment"] || "採用").join("・"),
    });
  }

  await notifyNewLead(sb, tenantId, made, { category, resubmitted: false });
  return { applicantId: made.id, result: "created", applicant: made };
}

async function findLead(sb, tenantId, category, email) {
  const { data, error } = await sb.from("gw_hr_applicants").select("*")
    // HR の画面でメールを大文字まじりに直されていても同じ人として見つける（一意索引も lower(email)）
    .eq("tenant_id", tenantId).eq("lead_category", category).ilike("email", likeLiteral(email)).limit(1);
  if (error) return dbError(error);
  return { row: (data || [])[0] || null };
}

async function updateLead(sb, tenantId, prev, lead, touch, { now, category }) {
  const attr = prev.attribution && typeof prev.attribution === "object" ? prev.attribution : {};
  const seen = Array.isArray(attr.submission_ids) ? attr.submission_ids : [];
  // 同じ送信の再送（LMS の再送・通信の切れたあとのやり直し）。何も変えない
  if (seen.includes(lead.submissionId)) {
    return { applicantId: prev.id, result: "replayed", applicant: prev };
  }

  // 同じ人からの送信が多すぎないか（10分に5回まで）
  const since = new Date(now.getTime() - PER_LEAD_LIMIT.windowMin * 60_000).toISOString();
  const { count, error: cerr } = await sb.from("gw_hr_timeline").select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId).eq("applicant_id", prev.id)
    .in("event_key", ["applied", "lead_resubmitted"]).gte("occurred_at", since);
  if (cerr) return dbError(cerr);
  if ((count || 0) >= PER_LEAD_LIMIT.max) return { error: "rate_limited", status: 429 };

  const nowIso = now.toISOString();
  const patch = {
    // 名前・電話は、空なら埋める。電話は新しく入っていれば最新にする（名前は HR が直していることがあるので変えない）
    name: prev.name || lead.name,
    phone: lead.phone || prev.phone || null,
    utm_source: prev.utm_source || lead.touch.utm_source || null,
    utm_medium: prev.utm_medium || lead.touch.utm_medium || null,
    utm_campaign: prev.utm_campaign || lead.touch.utm_campaign || null,
    attribution: {
      ...attr,
      lead_type: lead.leadType || attr.lead_type,
      first: attr.first || { ...touch, at: lead.firstTouchAt || touch.at },
      last: touch,
      submission_ids: [...seen, lead.submissionId].slice(-KEEP_SUBMISSION_IDS),
      touches: (Number(attr.touches) || seen.length || 0) + 1,
    },
    lead_profile: mergeProfile(prev.lead_profile, lead.profile),
    last_contacted_at: nowIso,
    updated_at: nowIso,
  };
  const { data, error } = await sb.from("gw_hr_applicants").update(patch)
    .eq("id", prev.id).eq("tenant_id", tenantId).select("*").single();
  if (error) return dbError(error);

  const closed = ["done", "passed", "declined", "accepted"].includes(prev.status);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: tenantId, applicant_id: prev.id, event_key: "lead_resubmitted",
    label: `${MUGENDOJO_SOURCE}から再送信${closed ? "（状態は変えていません）" : ""}`,
    detail: touchSummary(touch),
  });
  await notifyNewLead(sb, tenantId, data, { category, resubmitted: true });
  return { applicantId: prev.id, result: "updated", applicant: data };
}

function dbError(error) {
  const hint = dbSetupHint(error, "db/118_hr_leads.sql")
    || (String(error?.code || "") === "42703" ? "必要な列がまだありません。管理者に db/118_hr_leads.sql の実行を依頼してください" : null);
  if (hint) return { error: "not_ready", status: 503, message: hint };
  return { error: "db_failed", status: 500, detail: error?.message || String(error) };
}

// ---- 通知 ----------------------------------------------------------------------

// 設定が無いときに知らせる役割（採用HRの担当。責任者 manager までは広げない）
const FALLBACK_ROLES = ["owner", "hr", "recruiter"];

/**
 * 新しいリードの通知先（社員ID）。
 *   1. gw_hr_lead_watchers に、その lead_category の担当が設定されていれば、その人たち
 *   2. 設定が無い（または表が無い）なら、採用HRの担当（経営者・人事・採用担当）
 *   どちらでも、応募者の担当（recruiter_id）がいれば足す。
 * 退職者（gw_employees.status = left）には送らない。
 */
export async function leadRecipients(sb, tenantId, category, { recruiterId = null } = {}) {
  const ids = new Set();
  const { data: watchers, error: werr } = await sb.from("gw_hr_lead_watchers").select("employee_id")
    .eq("tenant_id", tenantId).eq("lead_category", category);
  if (!werr) for (const w of watchers || []) ids.add(w.employee_id);
  if (!ids.size) {
    const { data: grants } = await sb.from("gw_role_grants").select("employee_id")
      .eq("tenant_id", tenantId).in("role", FALLBACK_ROLES);
    for (const g of grants || []) ids.add(g.employee_id);
  }
  if (recruiterId) ids.add(recruiterId);
  if (!ids.size) return [];
  const { data: active } = await sb.from("gw_employees").select("id")
    .eq("tenant_id", tenantId).in("id", [...ids]).neq("status", "left");
  return (active || []).map((e) => e.id);
}

export const NEW_LEAD_TITLE = {
  mugendojo: "無限道場の新しいカジュアル面談リードが入りました",
};

async function notifyNewLead(sb, tenantId, applicant, { category, resubmitted }) {
  const targets = await leadRecipients(sb, tenantId, category, { recruiterId: applicant.recruiter_id });
  const title = resubmitted
    ? `${LEAD_CATEGORY_LABEL[category] || "リード"}のリードから再度申込がありました`
    : NEW_LEAD_TITLE[category] || `${LEAD_CATEGORY_LABEL[category] || ""}の新しいリードが入りました`;
  await notify(targets.map((employeeId) => ({
    tenantId, employeeId, kind: "hr", title,
    body: [applicant.name, touchSummary(applicant.attribution?.last)].filter(Boolean).join("\n"),
    link: `/hr/applicants.html?category=${encodeURIComponent(category)}&id=${encodeURIComponent(applicant.id)}`,
    // 1リード1件。再送では同じ通知を最新にして未読へ戻す（積み上げない）
    dedupeKey: `hr_lead:${applicant.id}`,
  })));
  return targets;
}
