// dx.enger → /sales 提案管理の受け口（api/sales/proposals/intake.js・status.js から使う）。
//
// ■ サーバー間だけ（ブラウザからは呼ばせない）
//   dx.enger（agent.enger.jp）のサーバーが HMAC-SHA256 で署名して送る。鍵は ENGER_SALES_SECRET（両方に同じ値）。
//   署名する文字列の先頭に用途を付けて、ほかの口（HR リード "…"・自治体LP "sales."）の署名と混ざらないようにする。
//     起票 … "proposal.${timestamp}.${canonicalJson(body)}"
//     状態 … "proposal-status.${timestamp}.${canonicalJson(body)}"
//   ヘッダー：x-gw-timestamp（UNIX 秒・前後5分まで）／ x-gw-signature（"v1=" + hex）
//   canonicalJson は lib/hr-leads.js のものを使う（キーを並べ替えた JSON。dx.enger 側も同じ並べ方）。
//
// ■ 冪等（同じものが何度届いても増えない）
//   ・同じ event_id は1回だけ処理する（gw_sales_proposal_sync_log の一意索引）。2回目以降は replayed
//   ・同じ dx.enger の提案（source_proposal_id）は1件だけ（gw_sales_proposals の一意索引）。
//     提案メールを送り直したときは、同じ提案に「提案送信（再送）」の記録を足すだけ（タスクは増やさない）
//   ・最初の電話のタスクは提案ごとに1つ（source_event = auto:first_call の一意索引）
//
// ■ 下書きは起票しない
//   dx.enger が送るのは「企業向けの提案メールを送った」とき（proposal.sent）だけ。
//   proposal.sent でない・送信日時の無いイベントでは、提案を作らない。
//
// ■ 名寄せ
//   営業担当：dx.enger の CL担当（closer）のメール → 社員名簿のメール（小文字で一致・在籍中・同じテナント）。
//            メールで決まらなければ、表示名（空白を除いて一致）がちょうど1人のときだけ。決まらなければ未割当（要確認）
//   企業    ：dx.enger の企業ID → gw_sales_company_links（人が確定した紐付け）。無ければサイトのドメインが
//            ちょうど1社一致したときだけ紐付ける。**社名だけでは紐付けない**（未紐付けで出し、人が決める）
//
// ■ 個人情報
//   人材は氏名を受け取らない（イニシャルだけ）。監査ログ・連携の記録・コンソールにメール・氏名を出さない。

import crypto from "node:crypto";
import { canonicalJson, normalizeEmail, SIGNATURE_TOLERANCE_SEC } from "./hr-leads.js";
import { domainOf } from "./sales.js";
import { settingsOf, firstTasks, STATUS_LABEL, isClosed } from "./sales-proposals.js";
import { dateTime as jst } from "./jst.js";

export const INTAKE_PURPOSE = "proposal";
export const STATUS_PURPOSE = "proposal-status";
export const EVENT_TYPES = ["proposal.sent", "proposal.updated"];
export const BATCH_MAX = 50;
export const STATUS_IDS_MAX = 100;

// ---- 署名 ----------------------------------------------------------------------

export function signGwRequest(secret, purpose, timestamp, body) {
  return `v1=${crypto.createHmac("sha256", secret).update(`${purpose}.${timestamp}.${canonicalJson(body)}`, "utf8").digest("hex")}`;
}

/** @returns {{ok:true}|{ok:false,status:number,error:string}} */
export function verifyGwSignature(headers, body, purpose, { secret, now = Date.now(), toleranceSec = SIGNATURE_TOLERANCE_SEC } = {}) {
  if (!secret) return { ok: false, status: 503, error: "not_configured" };
  const h = headers || {};
  const ts = String(h["x-gw-timestamp"] || "").trim();
  const sig = String(h["x-gw-signature"] || "").trim();
  if (!/^\d{9,11}$/.test(ts) || !sig) return { ok: false, status: 401, error: "unauthorized" };
  const expected = Buffer.from(signGwRequest(secret, purpose, ts, body));
  const given = Buffer.from(sig);
  if (!(expected.length === given.length && crypto.timingSafeEqual(expected, given))) return { ok: false, status: 401, error: "unauthorized" };
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > toleranceSec) return { ok: false, status: 401, error: "timestamp_out_of_range" };
  return { ok: true };
}

// ---- 入力 ----------------------------------------------------------------------

const str = (s, max) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t ? t.slice(0, max) : null; };
const url = (s) => { const t = str(s, 500); return t && /^https?:\/\//i.test(t) ? t : null; };
const phone = (s) => { const t = str(s, 40); return t && /^[0-9０-９+＋()（）\-－‐ ]{6,40}$/.test(t) ? t : null; };
const when = (s) => { if (!s) return null; const d = new Date(String(s)); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * 届いた1件を確かめる。
 * @returns {{value:object}|{error:string, field:string}}
 */
export function normalizeEvent(e, { now = new Date() } = {}) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return { error: "invalid_body", field: "event" };
  const eventId = str(e.event_id, 120);
  if (!eventId || !/^[A-Za-z0-9_.:-]{8,120}$/.test(eventId)) return { error: "invalid_body", field: "event_id" };
  if (!EVENT_TYPES.includes(e.event_type)) return { error: "invalid_body", field: "event_type" };
  const p = e.proposal;
  if (!p || typeof p !== "object") return { error: "invalid_body", field: "proposal" };
  const id = str(p.id, 100);
  if (!id || !ID_RE.test(id)) return { error: "invalid_body", field: "proposal.id" };
  const sentAt = when(p.sent_at);
  // 送信日時の無い提案（下書き）は起票しない。明らかな未来も受け付けない
  if (e.event_type === "proposal.sent" && (!sentAt || sentAt > new Date(now.getTime() + 10 * 60000).toISOString())) {
    return { error: "invalid_body", field: "proposal.sent_at" };
  }
  const company = p.company && typeof p.company === "object" ? p.company : {};
  const companyName = str(company.name, 200);
  if (!companyName) return { error: "invalid_body", field: "proposal.company.name" };
  const jobTitle = str(p.job_title, 200);
  const initials = str(p.talent_initials, 20);
  const person = (o) => (o && typeof o === "object" ? { name: str(o.name, 100), email: normalizeEmail(o.email) } : { name: null, email: null });
  const contact = p.contact && typeof p.contact === "object" ? p.contact : {};
  const companyId = str(company.id, 100);
  return {
    value: {
      eventId, eventType: e.event_type, occurredAt: when(e.occurred_at) || now.toISOString(),
      proposal: {
        id, code: str(p.code, 50), url: url(p.url), stage: str(p.stage, 40), sentAt,
        service: str(p.service, 100) || "ENGER",
        jobTitle, initials,
        title: [jobTitle, initials].filter(Boolean).join(" / ") || "ENGER の提案",
        company: { id: companyId && ID_RE.test(companyId) ? companyId : null, name: companyName, website: url(company.website), phone: phone(company.phone) },
        contact: { name: str(contact.name, 100), email: normalizeEmail(contact.email), phone: phone(contact.phone) },
        matchingOwner: person(p.matching_owner),
        salesOwner: person(p.sales_owner),
      },
    },
  };
}

/** 本文（1件 or { events: [...] }）→ イベントの配列。@returns {{events:object[]}|{error,field}} */
export function readEvents(body, opts) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body", field: "body" };
  const list = Array.isArray(body.events) ? body.events : [body];
  if (!list.length || list.length > BATCH_MAX) return { error: "invalid_body", field: "events" };
  return { events: list.map((e) => normalizeEvent(e, opts)) };
}

// ---- 名寄せ --------------------------------------------------------------------

const nameKey = (s) => String(s || "").replace(/[\s　]+/g, "").toLowerCase();

/** 営業担当を社員名簿から決める。@returns {{id:string|null, method:"email"|"name"|null}} */
export function matchOwner(employees, person) {
  const live = (employees || []).filter((e) => e.status !== "left");
  if (person?.email) {
    const hit = live.filter((e) => normalizeEmail(e.email) === person.email);
    if (hit.length === 1) return { id: hit[0].id, method: "email" };
  }
  if (person?.name) {
    const k = nameKey(person.name);
    const hit = k ? live.filter((e) => nameKey(e.display_name) === k) : [];
    if (hit.length === 1) return { id: hit[0].id, method: "name" };
  }
  return { id: null, method: null };
}

async function resolveCompany(sb, tenantId, company) {
  if (company.id) {
    const { data: link } = await sb.from("gw_sales_company_links").select("company_id")
      .eq("tenant_id", tenantId).eq("source_system", "enger").eq("source_company_id", company.id).maybeSingle();
    if (link?.company_id) return { companyId: link.company_id, method: "link" };
  }
  const domain = company.website ? domainOf(company.website) : null;
  if (domain) {
    const { data: hits } = await sb.from("gw_sales_companies").select("id").eq("tenant_id", tenantId).eq("domain", domain).limit(2);
    if ((hits || []).length === 1) {
      // ドメインで決まった紐付けは、dx.enger の企業IDがあれば覚えておく（次からは同じ会社に入る）
      if (company.id) {
        await sb.from("gw_sales_company_links").insert({
          tenant_id: tenantId, source_system: "enger", source_company_id: company.id, company_id: hits[0].id, method: "domain",
        });
      }
      return { companyId: hits[0].id, method: "domain" };
    }
  }
  return { companyId: null, method: null };
}

// ---- 受け付け ------------------------------------------------------------------

/** 営業担当がいなければ、管理側（経営者・マネージャー）に知らせる */
export async function managersOf(sb, tenantId) {
  const { data: grants } = await sb.from("gw_role_grants").select("employee_id, role").eq("tenant_id", tenantId).in("role", ["owner", "manager"]);
  const ids = [...new Set((grants || []).map((g) => g.employee_id))];
  if (!ids.length) return [];
  const { data: emps } = await sb.from("gw_employees").select("id, status").in("id", ids);
  return (emps || []).filter((e) => e.status !== "left").map((e) => e.id);
}

async function writeLog(sb, tenantId, v, { proposalId, status, message, existing }) {
  const nowIso = new Date().toISOString();
  if (existing) {
    await sb.from("gw_sales_proposal_sync_log").update({
      status, message: message || null, proposal_id: proposalId || existing.proposal_id || null,
      attempts: (existing.attempts || 1) + 1, updated_at: nowIso,
    }).eq("id", existing.id);
    return;
  }
  const { error } = await sb.from("gw_sales_proposal_sync_log").insert({
    tenant_id: tenantId, direction: "inbound", source_system: "enger", event_id: v.eventId, event_type: v.eventType,
    source_proposal_id: v.proposal.id, proposal_id: proposalId || null, status, message: message || null,
  });
  // 同じイベントが同時に2つ届いた：もう片方が書いた（処理も片方で済んでいる）
  if (error && error.code !== "23505") throw error;
}

const isDup = (e) => e && (e.code === "23505" || /duplicate key/i.test(String(e.message || "")));

/**
 * 1件を受け付ける。
 * @returns {Promise<{result:"created"|"updated"|"replayed"|"skipped", proposalId:string|null, warnings:string[],
 *   notify?:{employeeIds:string[], title:string, body:string, link:string, dedupeKey:string}}
 *   |{error:string,status:number,detail?:string}>}
 */
export async function intakeEvent(sb, tenantId, v, { employees = null, settingsRow = null, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const { data: seen, error: e0 } = await sb.from("gw_sales_proposal_sync_log").select("id, status, proposal_id, attempts")
    .eq("tenant_id", tenantId).eq("source_system", "enger").eq("event_id", v.eventId).maybeSingle();
  if (e0) return { error: "db_query_failed", status: e0.code === "PGRST205" || e0.code === "42P01" ? 503 : 500, detail: e0.message };
  if (seen && seen.status !== "error") {
    await sb.from("gw_sales_proposal_sync_log").update({ attempts: (seen.attempts || 1) + 1, updated_at: nowIso }).eq("id", seen.id);
    return { result: "replayed", proposalId: seen.proposal_id || null, warnings: [] };
  }

  const p = v.proposal;
  const settings = settingsOf(settingsRow);
  const warnings = [];
  let emps = employees;
  if (!emps) {
    const { data } = await sb.from("gw_employees").select("id, display_name, email, status").eq("tenant_id", tenantId).limit(2000);
    emps = data || [];
  }

  const { data: found, error: e1 } = await sb.from("gw_sales_proposals").select("*")
    .eq("tenant_id", tenantId).eq("source_system", "enger").eq("source_proposal_id", p.id).maybeSingle();
  if (e1) return { error: "db_query_failed", status: 500, detail: e1.message };

  try {
    if (!found) {
      if (v.eventType !== "proposal.sent") {
        // まだ送っていない提案の更新は起票しない（下書きはフォローの対象にしない）
        await writeLog(sb, tenantId, v, { status: "ok", message: "not_sent_yet", existing: seen });
        return { result: "skipped", proposalId: null, warnings: [] };
      }
      const owner = matchOwner(emps, p.salesOwner);
      if (!owner.id) warnings.push("owner_unmatched");
      const co = await resolveCompany(sb, tenantId, p.company);
      const row = {
        tenant_id: tenantId, source_system: "enger", source_proposal_id: p.id, source_code: p.code, source_url: p.url,
        source_company_id: p.company.id, source_stage: p.stage, company_id: co.companyId, company_name: p.company.name,
        service: p.service, title: p.title, job_title: p.jobTitle, talent_initials: p.initials,
        contact_name: p.contact.name, contact_email: p.contact.email, contact_phone: p.contact.phone || p.company.phone,
        matching_owner_name: p.matchingOwner.name, matching_owner_email: p.matchingOwner.email,
        sales_owner_id: owner.id, sent_at: p.sentAt, status: "call_wait", synced_at: nowIso,
      };
      let { data: made, error: e2 } = await sb.from("gw_sales_proposals").insert(row).select("*").single();
      if (e2 && isDup(e2)) {
        // 同じ提案が同時に届いた：もう片方が作ったものを使う（ここでは何も足さない）
        const again = await sb.from("gw_sales_proposals").select("id").eq("tenant_id", tenantId)
          .eq("source_system", "enger").eq("source_proposal_id", p.id).maybeSingle();
        await writeLog(sb, tenantId, v, { proposalId: again.data?.id, status: "ok", message: "concurrent", existing: seen });
        return { result: "replayed", proposalId: again.data?.id || null, warnings: [] };
      }
      if (e2) throw e2;

      const { data: act, error: e3 } = await sb.from("gw_sales_proposal_activities").insert({
        tenant_id: tenantId, proposal_id: made.id, company_id: made.company_id, kind: "sent", channel: "email",
        result: "sent", evidence: "system", occurred_at: p.sentAt, source_event: v.eventId,
        detail: { via: "enger", ownerMatch: owner.method, companyMatch: co.method },
      }).select("id").single();
      if (e3 && !isDup(e3)) throw e3;
      for (const t of firstTasks(made, settings)) {
        const { error } = await sb.from("gw_sales_proposal_tasks").insert({ tenant_id: tenantId, proposal_id: made.id, ...t });
        if (error && !isDup(error)) throw error;
      }
      await writeLog(sb, tenantId, v, { proposalId: made.id, status: warnings.length ? "warning" : "ok", message: warnings.join(",") || null, existing: seen });

      const due = firstTasks(made, settings)[0]?.due_at;
      const link = `/sales/proposals.html?id=${made.id}`;
      const notifyTo = owner.id ? [owner.id] : await managersOf(sb, tenantId);
      return {
        result: "created", proposalId: made.id, warnings, activityId: act?.id || null,
        notify: {
          employeeIds: notifyTo,
          title: owner.id ? `提案が届きました：${made.company_name}（初回電話 ${jst(due)} まで）` : `担当未割当の提案：${made.company_name}`,
          body: owner.id
            ? `dx.enger で提案を送りました。「${made.title}」\n提案管理から電話の結果を記録してください。`
            : `dx.enger で送った提案の営業担当が決まっていません。提案管理で担当を割り当ててください。\n「${made.title}」`,
          link, dedupeKey: `sales_proposal:${made.id}`,
        },
      };
    }

    // ---- すでにある提案：写しを最新にする（人が入れた窓口・担当・企業は上書きしない） ----
    const patch = {
      synced_at: nowIso, company_name: p.company.name, title: p.title, job_title: p.jobTitle, talent_initials: p.initials,
      source_stage: p.stage, matching_owner_name: p.matchingOwner.name, matching_owner_email: p.matchingOwner.email,
    };
    if (p.url) patch.source_url = p.url;
    if (p.code) patch.source_code = p.code;
    if (!found.source_company_id && p.company.id) patch.source_company_id = p.company.id;
    if (!found.contact_email && p.contact.email) patch.contact_email = p.contact.email;
    if (!found.contact_name && p.contact.name) patch.contact_name = p.contact.name;
    if (!found.contact_phone && (p.contact.phone || p.company.phone)) patch.contact_phone = p.contact.phone || p.company.phone;
    if (!found.sales_owner_id && !isClosed(found.status)) {
      const owner = matchOwner(emps, p.salesOwner);
      if (owner.id) patch.sales_owner_id = owner.id;
    }
    if (!found.company_id) {
      const co = await resolveCompany(sb, tenantId, { ...p.company, id: p.company.id || found.source_company_id });
      if (co.companyId) patch.company_id = co.companyId;
    }
    const { error: e4 } = await sb.from("gw_sales_proposals").update(patch).eq("id", found.id).eq("tenant_id", tenantId);
    if (e4) throw e4;
    if (patch.sales_owner_id) {
      // 担当が決まったので、開いている（担当未定の）タスクを担当に寄せる
      await sb.from("gw_sales_proposal_tasks").update({ assignee_id: patch.sales_owner_id })
        .eq("proposal_id", found.id).eq("status", "open").is("assignee_id", null);
    }

    if (v.eventType === "proposal.sent") {
      const { error } = await sb.from("gw_sales_proposal_activities").insert({
        tenant_id: tenantId, proposal_id: found.id, company_id: patch.company_id || found.company_id, kind: "sent", channel: "email",
        result: "resent", evidence: "system", occurred_at: p.sentAt || v.occurredAt, source_event: v.eventId,
        note: "dx.enger で提案メールを送り直しました", detail: { via: "enger" },
      });
      if (error && !isDup(error)) throw error;
    } else if (p.stage && p.stage !== found.source_stage) {
      const { error } = await sb.from("gw_sales_proposal_activities").insert({
        tenant_id: tenantId, proposal_id: found.id, company_id: found.company_id, kind: "sync", occurred_at: v.occurredAt,
        source_event: v.eventId, note: `dx.enger のステージ：${found.source_stage || "—"} → ${p.stage}`,
        detail: { from: found.source_stage || null, to: p.stage },
      });
      if (error && !isDup(error)) throw error;
    }
    if (!found.sales_owner_id && !patch.sales_owner_id && !isClosed(found.status)) warnings.push("owner_unmatched");
    await writeLog(sb, tenantId, v, { proposalId: found.id, status: warnings.length ? "warning" : "ok", message: warnings.join(",") || null, existing: seen });
    return { result: "updated", proposalId: found.id, warnings };
  } catch (e) {
    // 失敗は記録して（連携エラー一覧に出す）、dx.enger には 500 を返す（向こうが再送する）
    try {
      await writeLog(sb, tenantId, v, { proposalId: found?.id, status: "error", message: String(e?.code || "db_failed").slice(0, 60), existing: seen });
    } catch { /* 記録できなくても、元のエラーを返す */ }
    return { error: "db_failed", status: 500, detail: e?.message || String(e) };
  }
}

// ---- 状態（dx.enger の提案詳細に出す） -----------------------------------------------

/** 状態を返す提案IDの一覧を確かめる */
export function readStatusQuery(body) {
  const ids = Array.isArray(body?.source_proposal_ids) ? body.source_proposal_ids : null;
  if (!ids || !ids.length || ids.length > STATUS_IDS_MAX) return { error: "invalid_body", field: "source_proposal_ids" };
  const clean = [...new Set(ids.map((x) => str(x, 100)).filter((x) => x && ID_RE.test(x)))];
  if (!clean.length) return { error: "invalid_body", field: "source_proposal_ids" };
  return { ids: clean };
}

/** dx.enger に返す1件（フォローに必要なことだけ。窓口の連絡先は返さない） */
export function statusItem(row, { nameOf = () => null, base = "" } = {}) {
  return {
    source_proposal_id: row.sourceProposalId,
    status: row.status, status_label: STATUS_LABEL[row.status] || row.status,
    close_reason: row.closeReason || null, close_reason_label: row.closeReasonLabel || null,
    closed: row.closed, contact_stop: row.contactStop,
    sales_owner_name: row.salesOwnerName || nameOf(row.salesOwnerId) || null,
    last_call: row.call ? { at: row.call.lastAt, result_label: row.call.label, count: row.call.count } : null,
    last_mail_at: row.mail?.lastAt || null,
    replied_at: row.repliedAt,
    meeting_at: row.meetingAt,
    next_task: row.next ? { title: row.next.title, due_at: row.next.dueAt, overdue: row.next.overdue } : null,
    overdue: row.overdue,
    reproposal_requested: row.status === "reproposal",
    url: base ? `${base}/sales/proposals.html?id=${row.id}` : null,
    updated_at: row.updatedAt,
  };
}
