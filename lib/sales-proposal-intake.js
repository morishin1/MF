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
// ■ いつ何が届くか（db/140。docs/sales-proposals.md）
//   proposal.matched … dx.enger の提案管理でマッチングが確定した（案件×人材の組を登録した）。
//                      → 起票して「マッチング済み・提案待ち」・営業担当に「提案準備」のタスク・ベルと Slack で即時に知らせる
//   proposal.sent    … dx.enger から企業へ提案を送った（企業向けの提案メール・送った提案として手で連携）。
//                      → 提案待ちなら「電話待ち」へ進め、送った時刻から30分以内の電話のタスク（提案準備は完了）
//                      → まだ無い提案なら、その場で起票して電話待ち（マッチング確定の連携より前の提案・届く順の入れ替わり）
//   proposal.updated … ステージの更新・担当の補完。まだ無い提案は起票しない
//   マッチング確定と提案送信は別の事実。まだ企業へ提案していない段階で、30分の電話の期限を始めない。
//
// ■ 冪等（同じものが何度届いても増えない）
//   ・同じ event_id は1回だけ処理する（gw_sales_proposal_sync_log の一意索引）。2回目以降は replayed
//   ・同じ dx.enger の提案（source_proposal_id）は1件だけ（gw_sales_proposals の一意索引）。
//     提案メールを送り直したときは、同じ提案に「提案送信（再送）」の記録を足すだけ（タスクは増やさない）
//   ・提案準備・最初の電話のタスクは提案ごとに1つ（source_event = auto:prepare・auto:first_call の一意索引）
//   ・Slack は提案ごとに1回（gw_sales_proposals.slack_notified_at を先に入れた1件だけが送る。lib/sales-proposal-slack.js）
//
// ■ 下書きは起票しない
//   dx.enger が送るのは、マッチングを確定したとき（提案管理への登録）と、企業へ提案を送ったときだけ。
//   メールの下書き・候補の表示・AI 診断では何も届かない。確定日時・送信日時の無いイベントは 400。
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
import {
  settingsOf, firstTasks, matchedTasks, planFollowUp, STATUS_LABEL, isClosed, TASK_FIELDS,
} from "./sales-proposals.js";
import { dateTime as jst } from "./jst.js";

export const INTAKE_PURPOSE = "proposal";
export const STATUS_PURPOSE = "proposal-status";
export const EVENT_TYPES = ["proposal.matched", "proposal.sent", "proposal.updated"];
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
  const matchedAt = when(p.matched_at);
  const future = (iso) => iso > new Date(now.getTime() + 10 * 60000).toISOString();
  // 送信日時の無い提案（下書き）は起票しない。明らかな未来も受け付けない
  if (e.event_type === "proposal.sent" && (!sentAt || future(sentAt))) {
    return { error: "invalid_body", field: "proposal.sent_at" };
  }
  // マッチング確定は、確定の日時が要る（まだ企業へ送っていないので sent_at は無くてよい）
  if (e.event_type === "proposal.matched" && (!matchedAt || future(matchedAt))) {
    return { error: "invalid_body", field: "proposal.matched_at" };
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
        matchedAt: matchedAt && !future(matchedAt) ? matchedAt : null,
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

/** ENGER CLの氏名・メールの組を、個人情報を保存せず比較する識別子にする。 */
export function clOwnerKey(person) {
  const name = nameKey(person?.name);
  const email = normalizeEmail(person?.email) || "";
  return crypto.createHash("sha256").update(JSON.stringify([email, name]), "utf8").digest("hex");
}

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
export async function intakeEvent(sb, tenantId, v, { employees = null, settingsRow = null, now = new Date(), retried = false } = {}) {
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
      if (v.eventType === "proposal.updated") {
        // まだ無い提案の更新は起票しない（マッチング確定・提案送信の連携で起票する）
        await writeLog(sb, tenantId, v, { status: "ok", message: "not_sent_yet", existing: seen });
        return { result: "skipped", proposalId: null, warnings: [] };
      }
      const matched = v.eventType === "proposal.matched";
      const owner = matchOwner(emps, p.salesOwner);
      if (!owner.id) warnings.push("owner_unmatched");
      const co = await resolveCompany(sb, tenantId, p.company);
      const row = {
        tenant_id: tenantId, source_system: "enger", source_proposal_id: p.id, source_code: p.code, source_url: p.url,
        source_company_id: p.company.id, source_stage: p.stage, company_id: co.companyId, company_name: p.company.name,
        service: p.service, title: p.title, job_title: p.jobTitle, talent_initials: p.initials,
        contact_name: p.contact.name, contact_email: p.contact.email, contact_phone: p.contact.phone || p.company.phone,
        matching_owner_name: p.matchingOwner.name, matching_owner_email: p.matchingOwner.email,
        sales_owner_id: owner.id, synced_at: nowIso,
        enger_cl_key: clOwnerKey(p.salesOwner), enger_cl_synced_at: v.occurredAt,
        // マッチング確定：提案待ち（送信日時は空）。提案送信が先に届いた：電話待ち
        matched_at: p.matchedAt, sent_at: matched ? null : p.sentAt, status: matched ? "proposal_wait" : "call_wait",
        handoff_stage: matched ? "proposal" : "cs",
      };
      let { data: made, error: e2 } = await sb.from("gw_sales_proposals").insert(row).select("*").single();
      if (e2 && isDup(e2)) {
        // 同じ提案の別のイベント（確定と送信など）が同時に届き、もう片方が先に作った：
        // このイベントは「もうある提案」として1回だけ処理し直す（送信なら電話待ちへ進める。黙って捨てない）
        if (!retried) return intakeEvent(sb, tenantId, v, { employees: emps, settingsRow, now, retried: true });
        const again = await sb.from("gw_sales_proposals").select("id").eq("tenant_id", tenantId)
          .eq("source_system", "enger").eq("source_proposal_id", p.id).maybeSingle();
        await writeLog(sb, tenantId, v, { proposalId: again.data?.id, status: "ok", message: "concurrent", existing: seen });
        return { result: "replayed", proposalId: again.data?.id || null, warnings: [] };
      }
      if (e2) throw e2;

      const { data: act, error: e3 } = await sb.from("gw_sales_proposal_activities").insert(matched
        ? {
          tenant_id: tenantId, proposal_id: made.id, company_id: made.company_id, kind: "matched", result: "matched",
          evidence: "system", occurred_at: p.matchedAt, source_event: v.eventId,
          detail: { via: "enger", ownerMatch: owner.method, companyMatch: co.method },
        }
        : {
          tenant_id: tenantId, proposal_id: made.id, company_id: made.company_id, kind: "sent", channel: "email",
          result: "sent", evidence: "system", occurred_at: p.sentAt, source_event: v.eventId,
          detail: { via: "enger", ownerMatch: owner.method, companyMatch: co.method },
        }).select("id").single();
      if (e3 && !isDup(e3)) throw e3;
      const first = matched ? matchedTasks(made, settings) : firstTasks(made, settings);
      for (const t of first) {
        const { error } = await sb.from("gw_sales_proposal_tasks").insert({ tenant_id: tenantId, proposal_id: made.id, ...t });
        if (error && !isDup(error)) throw error;
      }
      await writeLog(sb, tenantId, v, { proposalId: made.id, status: warnings.length ? "warning" : "ok", message: warnings.join(",") || null, existing: seen });

      const due = first[0]?.due_at || null;
      const link = `/sales/proposals.html?id=${made.id}`;
      const notifyTo = owner.id ? [owner.id] : await managersOf(sb, tenantId);
      return {
        result: "created", proposalId: made.id, warnings, activityId: act?.id || null,
        notify: {
          employeeIds: notifyTo,
          title: matched
            ? (owner.id ? `マッチング確定：${made.company_name}（提案準備 ${jst(due)} まで）` : `担当未割当のマッチング：${made.company_name}`)
            : (owner.id ? `提案が届きました：${made.company_name}（初回電話 ${jst(due)} まで）` : `担当未割当の提案：${made.company_name}`),
          body: matched
            ? (owner.id
              ? `dx.enger でマッチングが確定しました。「${made.title}」\n内容を確認して企業へ提案してください（企業へ提案を送ると、30分以内の電話のタスクに進みます）。`
              : `dx.enger で確定したマッチングの営業担当が決まっていません。提案管理で担当を割り当ててください。\n「${made.title}」`)
            : (owner.id
              ? `dx.enger で提案を送りました。「${made.title}」\n提案管理から電話の結果を記録してください。`
              : `dx.enger で送った提案の営業担当が決まっていません。提案管理で担当を割り当ててください。\n「${made.title}」`),
          link, dedupeKey: `sales_proposal:${made.id}`,
        },
        // Slack（提案ごとに1回。api/sales/proposals/intake.js が lib/sales-proposal-slack.js で送る）
        slack: { kind: matched ? "matched" : "sent", proposal: made, due },
      };
    }

    // ---- すでにある提案：ENGERのCL変更イベントだけが営業担当を自動更新する ----
    // 担当・未完了タスク・履歴をDB側の1トランザクションで更新する。
    // 手動でSalesの担当を変えた後、ENGERのCLに変更が無ければ上書きしない。
    let ownerChange = null;
    if (v.eventType === "proposal.updated") {
      const matchedOwner = matchOwner(emps, p.salesOwner);
      const { data: result, error: syncError } = await sb.rpc("gw_sales_apply_enger_cl_owner", {
        p_tenant: tenantId,
        p_proposal: found.id,
        p_cl_key: clOwnerKey(p.salesOwner),
        p_event_at: v.occurredAt,
        p_new_owner: matchedOwner.id,
      });
      if (syncError) throw syncError;
      ownerChange = result || { state: "same" };
      if (ownerChange.state === "stale") {
        await writeLog(sb, tenantId, v, { proposalId: found.id, status: "ok", message: "stale_owner_event", existing: seen });
        return { result: "skipped", proposalId: found.id, warnings: [] };
      }
      if (ownerChange.state === "protected") warnings.push("owner_handoff_protected");
      if (ownerChange.state === "closed") warnings.push("owner_closed");
      if (ownerChange.state === "changed" && !matchedOwner.id && p.salesOwner.name)
        warnings.push("owner_unmatched");
    }

    // ---- すでにある提案：写しを最新にする（人が入れた窓口・企業は上書きしない） ----
    const patch = {
      synced_at: nowIso, company_name: p.company.name, title: p.title, job_title: p.jobTitle, talent_initials: p.initials,
      source_stage: p.stage, matching_owner_name: p.matchingOwner.name, matching_owner_email: p.matchingOwner.email,
    };
    if (p.url) patch.source_url = p.url;
    if (p.code) patch.source_code = p.code;
    // マッチング確定の日時は、空のときだけ入れる（届く順が入れ替わっても、入ったあとは変えない）
    if (!found.matched_at && p.matchedAt) patch.matched_at = p.matchedAt;
    if (!found.source_company_id && p.company.id) patch.source_company_id = p.company.id;
    if (!found.contact_email && p.contact.email) patch.contact_email = p.contact.email;
    if (!found.contact_name && p.contact.name) patch.contact_name = p.contact.name;
    if (!found.contact_phone && (p.contact.phone || p.company.phone)) patch.contact_phone = p.contact.phone || p.company.phone;
    if (v.eventType !== "proposal.updated" && !found.sales_owner_id && !isClosed(found.status)) {
      const owner = matchOwner(emps, p.salesOwner);
      if (owner.id) patch.sales_owner_id = owner.id;
    }
    if (!found.company_id) {
      const co = await resolveCompany(sb, tenantId, { ...p.company, id: p.company.id || found.source_company_id });
      if (co.companyId) patch.company_id = co.companyId;
    }
    // 提案待ちの提案に「企業へ送った」が届いた：電話待ちへ進め、送った時刻から30分以内の電話（提案準備は完了）
    const firstSend = v.eventType === "proposal.sent" && !found.sent_at;
    let transition = null;
    if (firstSend) {
      transition = await recordFirstSend(sb, tenantId, found, v, { patch, settings, nowIso });
      Object.assign(patch, transition.plan.patch);
      if (isClosed(found.status)) warnings.push("closed_before_sent");
    }

    // タスク（提案準備の完了・電話）を先に書き、提案の状態はそのあと。途中で失敗して dx.enger が送り直しても、
    // 提案はまだ「送っていない」ままなので同じ道を通り、記録・タスクは一意索引で1つのまま埋まる
    if (transition) await applyPlan(sb, tenantId, found.id, transition, nowIso);
    const { error: e4 } = await sb.from("gw_sales_proposals").update(patch).eq("id", found.id).eq("tenant_id", tenantId);
    if (e4) throw e4;
    if (patch.sales_owner_id) {
      // 担当が決まったので、開いている（担当未定の）タスクを担当に寄せる
      await sb.from("gw_sales_proposal_tasks").update({ assignee_id: patch.sales_owner_id })
        .eq("proposal_id", found.id).eq("status", "open").is("assignee_id", null);
    }

    if (v.eventType === "proposal.matched") {
      // マッチング確定が後から届いた（または送り直し）：記録だけ。タスクは作らない（同じイベントは一意索引で1回）
      const { error } = await sb.from("gw_sales_proposal_activities").insert({
        tenant_id: tenantId, proposal_id: found.id, company_id: patch.company_id || found.company_id, kind: "matched", result: "matched",
        evidence: "system", occurred_at: p.matchedAt || v.occurredAt, source_event: v.eventId, detail: { via: "enger" },
      });
      if (error && !isDup(error)) throw error;
    } else if (v.eventType === "proposal.sent" && !firstSend) {
      const { error } = await sb.from("gw_sales_proposal_activities").insert({
        tenant_id: tenantId, proposal_id: found.id, company_id: patch.company_id || found.company_id, kind: "sent", channel: "email",
        result: "resent", evidence: "system", occurred_at: p.sentAt || v.occurredAt, source_event: v.eventId,
        note: "dx.enger で提案メールを送り直しました", detail: { via: "enger" },
      });
      if (error && !isDup(error)) throw error;
    } else if (v.eventType === "proposal.updated" && p.stage && p.stage !== found.source_stage) {
      const { error } = await sb.from("gw_sales_proposal_activities").insert({
        tenant_id: tenantId, proposal_id: found.id, company_id: found.company_id, kind: "sync", occurred_at: v.occurredAt,
        source_event: v.eventId, note: `dx.enger のステージ：${found.source_stage || "—"} → ${p.stage}`,
        detail: { from: found.source_stage || null, to: p.stage },
      });
      if (error && !isDup(error)) throw error;
    }
    if (!found.sales_owner_id && !patch.sales_owner_id && !isClosed(found.status) && !ownerChange) warnings.push("owner_unmatched");
    await writeLog(sb, tenantId, v, { proposalId: found.id, status: warnings.length ? "warning" : "ok", message: warnings.join(",") || null, existing: seen });
    const ownerId = ownerChange?.state === "changed" ? (ownerChange.to || null) : (patch.sales_owner_id || found.sales_owner_id || null);
    const callDue = transition?.created.find((t) => t.kind === "call")?.due_at || null;
    return {
      result: "updated", proposalId: found.id, warnings,
      ...(ownerChange?.state === "changed" ? {
        ownerChanged: {
          from: ownerChange.from || null, to: ownerChange.to || null,
          movedTasks: ownerChange.movedTasks || 0,
          companyName: found.company_name, title: found.title,
        },
        notify: {
          employeeIds: ownerId ? [ownerId] : await managersOf(sb, tenantId),
          title: ownerId ? `営業担当になりました：${found.company_name}` : `ENGERのCL担当が未割当になりました：${found.company_name}`,
          body: ownerId
            ? `ENGERでCL担当が変更されました。「${found.title}」の対応予定を確認してください。`
            : `ENGERでCL担当が解除された、または社員名簿と一致しません。「${found.title}」の担当を確認してください。`,
          link: `/sales/proposals.html?id=${found.id}`,
          dedupeKey: `sales_proposal_cl_change:${v.eventId}`,
        },
      } : {}),
      // 提案待ち → 電話待ち：営業担当に「30分以内に電話」を知らせる（担当未定なら管理側）
      ...(callDue ? {
        notify: {
          employeeIds: ownerId ? [ownerId] : await managersOf(sb, tenantId),
          title: `企業へ提案しました：${found.company_name}（初回電話 ${jst(callDue)} まで）`,
          body: `「${found.title}」\n提案から${settings.firstCallMinutes}分以内に電話し、提案管理で結果を記録してください。`,
          link: `/sales/proposals.html?id=${found.id}`, dedupeKey: `sales_proposal_call:${found.id}`,
        },
      } : {}),
    };
  } catch (e) {
    // 失敗は記録して（連携エラー一覧に出す）、dx.enger には 500 を返す（向こうが再送する）
    try {
      await writeLog(sb, tenantId, v, { proposalId: found?.id, status: "error", message: String(e?.code || "db_failed").slice(0, 60), existing: seen });
    } catch { /* 記録できなくても、元のエラーを返す */ }
    return { error: "db_failed", status: 500, detail: e?.message || String(e) };
  }
}

/**
 * 提案待ちの提案に、最初の「企業へ送った」を記録して、状態とタスクの変化を決める（書くのは呼び出し側）。
 * 記録は同じイベントで1回だけ（source_event の一意索引）。前の試行で記録だけ残っていたら、それを使う
 */
async function recordFirstSend(sb, tenantId, found, v, { patch, settings, nowIso }) {
  const p = v.proposal;
  const row = {
    tenant_id: tenantId, proposal_id: found.id, company_id: patch.company_id || found.company_id, kind: "sent", channel: "email",
    result: "sent", evidence: "system", occurred_at: p.sentAt, source_event: v.eventId, detail: { via: "enger" },
  };
  let { data: activity, error } = await sb.from("gw_sales_proposal_activities").insert(row).select("*").single();
  if (error && isDup(error)) {
    ({ data: activity, error } = await sb.from("gw_sales_proposal_activities").select("*")
      .eq("proposal_id", found.id).eq("source_event", v.eventId).maybeSingle());
  }
  if (error || !activity) throw error || new Error("activity_missing");
  const { data: tasks, error: e1 } = await sb.from("gw_sales_proposal_tasks").select(TASK_FIELDS).eq("proposal_id", found.id).limit(500);
  if (e1) throw e1;
  const plan = planFollowUp({ proposal: { ...found, ...patch }, activity, tasks: tasks || [], now: nowIso, settings });
  return { activity, plan, created: [] };
}

/** recordFirstSend の結果を書く：片付くタスクを完了（記録とひも付け）・新しいタスクを足す */
async function applyPlan(sb, tenantId, proposalId, t, nowIso) {
  if (t.plan.complete.length) {
    const { error } = await sb.from("gw_sales_proposal_tasks")
      .update({ status: "done", done_at: nowIso, done_activity_id: t.activity.id })
      .in("id", t.plan.complete).eq("proposal_id", proposalId).eq("status", "open");
    if (error) throw error;
  }
  for (const c of t.plan.cancel) {
    const { error } = await sb.from("gw_sales_proposal_tasks").update({ status: "canceled", cancel_reason: c.reason })
      .eq("id", c.id).eq("proposal_id", proposalId).eq("status", "open");
    if (error) throw error;
  }
  for (const c of t.plan.create) {
    const { data, error } = await sb.from("gw_sales_proposal_tasks").insert({ tenant_id: tenantId, proposal_id: proposalId, ...c })
      .select(TASK_FIELDS).single();
    if (error && isDup(error)) continue;
    if (error) throw error;
    t.created.push(data);
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
    // マッチング確定・企業へ提案を送った日時（提案待ちの間は sent_at が null）
    matched_at: row.matchedAt || null, sent_at: row.sentAt || null,
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
