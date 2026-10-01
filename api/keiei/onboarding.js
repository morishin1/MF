// GET  /api/keiei/onboarding?employeeId=…[&mailId=…]   … 入社案内・案内URL・メールの詳細（1人ぶん）
// POST /api/keiei/onboarding {action, employeeId, …}    … 経営者が案内を作り、渡す
//
//   save_guide     {fields}          下書きを保存する
//   issue_guide    {}                発行する（確定版を残す。版が上がり、本人は確認し直す）
//   create_invite  {days?}           案内URLを発行する（前のURLは失効。URLはこの応答にだけ出る）
//   revoke_invite  {inviteId}        案内URLを失効させる
//   preview_mail   {days?}           案内メールの文面を見る（送らない・URLは送信時に発行）
//   test_mail      {}                自分あてにテスト送信する
//   send_mail      {days?}           本人へ送る（再送も同じ。1通ごとに履歴に残る）
//
// ■ 権限（/keiei と同じ入口）
//   経営者（owner）だけ（lib/keiei-gate.js。二段階認証は要らない）。HR・人事・管理者は、案内も履歴も見られない
//   （DB も同じ: db/104 は gw_is_owner）。人事には、進み具合（6ステップの状態）だけを、既存の画面で見せる。
//
// ■ 送信は、提供元に依存しない（lib/mail/index.js）
//   送信元は環境変数 HR_ONBOARDING_FROM。未設定なら実送信せず、案内URLを画面からコピーして渡す
//   （send_mail・test_mail は 409 mail_not_configured。履歴も作らない）。
//   本文にパスワードは書かない。期限つきのURLだけ（lib/onboard-guide.js renderInviteMail）。
//   履歴に残す本文は確定版だが、URLのトークンだけは保存しない（DB にはハッシュでしか持たない）。
//   送信が成功したあとで、前のURLを失効させる（失敗したときは、すでに届いているURLを生かす）
//
// ■ 金額は載せない
//   案内にも、案内メールにも、給与・手当の金額は入れない（金額らしい表記は保存の時点で断る）

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireKeiei } from "../../lib/keiei-gate.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { sha256, newOfferToken } from "../../lib/hr.js";
import { gatherFacts } from "../../lib/onboard-advance.js";
import { findProcedure } from "../../lib/onboard-kit.js";
import { mapSix } from "../../lib/onboard-six.js";
import { sendMail, mailConfig, isEmail } from "../../lib/mail/index.js";
import {
  GUIDE_FIELDS, GUIDE_KEYS, normalizeGuideInput, buildSnapshot, guideView, missingFields, guideFact,
  inviteExpiry, inviteUrl, publicBaseUrl, renderInviteMail, INVITE_TTL_DAYS_DEFAULT,
} from "../../lib/onboard-guide.js";

const SQL = "db/104_onboarding_guide.sql";
const ACTIONS = ["save_guide", "issue_guide", "create_invite", "revoke_invite", "preview_mail", "test_mail", "send_mail"];
const GUIDE_COLS = `id, employee_id, ${GUIDE_KEYS.join(", ")}, version, issued_at, confirmed_version, confirmed_at, updated_at`;
const INVITE_COLS = "id, guide_id, expires_at, revoked_at, created_at, first_opened_at, last_opened_at, open_count";
const MAIL_COLS = "id, kind, to_email, from_email, subject, status, provider, error, guide_version, sent_by, created_at";
const URL_PLACEHOLDER = "（送信時に、この人だけの期限つきURLが入ります）";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const gate = await requireKeiei(req, res);
  if (!gate) return;
  const { user, ctx } = gate;

  try {
    const sb = admin();
    if (req.method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const employeeId = String(q.get("employeeId") || "");
      if (!employeeId) return json(res, 400, { error: "invalid_query", required: ["employeeId"] });
      const emp = await loadEmployee(sb, ctx, employeeId);
      if (!emp) return json(res, 404, { error: "not_found", hint: "この方の情報を開けません" });
      if (q.get("mailId")) return await mailBody(res, sb, ctx, emp, String(q.get("mailId")));
      return json(res, 200, await detail(sb, ctx, req, emp, user));
    }

    const body = (await readJson(req)) || {};
    const action = String(body.action || "");
    if (!ACTIONS.includes(action)) return json(res, 400, { error: "invalid_action", actions: ACTIONS });
    const employeeId = String(body.employeeId || "");
    if (!employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });
    const emp = await loadEmployee(sb, ctx, employeeId);
    if (!emp) return json(res, 404, { error: "not_found", hint: "この方の情報を開けません" });
    // 退職済み（入社が取り消された）の方には、案内を作らない・送らない。ただし、出したURLの失効はできる
    if (emp.status === "left" && action !== "revoke_invite") {
      return json(res, 409, { error: "employee_left", hint: "退職済みの方には、入社案内を作れません" });
    }

    const act = { sb, res, req, ctx, user, emp, body };
    switch (action) {
      case "save_guide": return await saveGuide(act);
      case "issue_guide": return await issueGuide(act);
      case "create_invite": return await createInvite(act);
      case "revoke_invite": return await revokeInvite(act);
      case "preview_mail": return await previewMail(act);
      case "test_mail": return await sendTest(act);
      default: return await sendReal(act);
    }
  } catch (e) {
    console.error("[keiei/onboarding]", e?.message || e);
    return json(res, 500, { error: "keiei_failed", detail: String(e?.message || e) });
  }
}

// ---- 読み出し -------------------------------------------------------------------

const soft = async (q) => { try { const { data, error } = await q; return error ? null : data; } catch { return null; } };

async function loadEmployee(sb, ctx, employeeId) {
  const { data } = await sb.from("gw_employees")
    .select("id, display_name, email, department, position, initial_role, joined_on, status")
    .eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  return data || null;
}

/** 入社案内の行。表が無いときは { missing: true } */
async function loadGuide(sb, ctx, employeeId) {
  const { data, error } = await sb.from("gw_onboarding_guides").select(GUIDE_COLS)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId).maybeSingle();
  if (error) return { row: null, missing: Boolean(dbSetupHint(error, SQL)), error };
  return { row: data || null, missing: false, error: null };
}

async function latestIssue(sb, guideId) {
  if (!guideId) return null;
  const rows = await soft(sb.from("gw_onboarding_guide_issues").select("version, snapshot, issued_at")
    .eq("guide_id", guideId).order("version", { ascending: false }).limit(1));
  return (rows || [])[0] || null;
}

const inviteStatus = (i, now = Date.now()) =>
  i.revoked_at ? "revoked" : Date.parse(i.expires_at) < now ? "expired" : "active";

async function tenantName(sb, ctx) {
  const t = await soft(sb.from("tenants").select("name").eq("id", ctx.tenantId).maybeSingle());
  return t?.name || null;
}

const sameSnapshot = (a, b) => GUIDE_KEYS.concat(["name", "joinOn", "department", "position", "role"])
  .every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));

async function detail(sb, ctx, req, emp, user) {
  const g = await loadGuide(sb, ctx, emp.id);
  const proc = await findProcedure(sb, emp.id, "onboarding").catch(() => ({ row: null }));
  const procedure = proc?.row && proc.row.status !== "cancelled" ? proc.row : null;

  let facts = null;
  if (procedure) { try { facts = await gatherFacts(sb, ctx.tenantId, procedure); } catch { facts = null; } }
  const career = (await soft(sb.from("gw_employee_careers").select("*")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).eq("is_active", true).limit(1)) || [])[0] || null;
  const six = mapSix({ facts, career, guide: guideFact(g.row), guideLinked: !g.missing, audience: "company" });

  const issue = await latestIssue(sb, g.row?.id);
  const draft = g.row || {};
  const preview = buildSnapshot({ employee: emp, procedure, draft });
  const invites = g.row ? await soft(sb.from("gw_onboarding_invites").select(INVITE_COLS)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).order("created_at", { ascending: false }).limit(20)) : [];
  const history = await mailHistory(sb, ctx, emp.id);
  const cfg = mailConfig("onboarding");

  return {
    employee: { id: emp.id, name: emp.display_name, email: emp.email || null, department: emp.department || null,
      position: emp.position || null, status: emp.status, joinOn: procedure?.target_on || emp.joined_on || null },
    procedureId: procedure?.id || null,
    six,
    guide: {
      linked: !g.missing,
      hint: g.missing ? `入社案内の表がまだ作られていません。${SQL} の実行を依頼してください` : null,
      exists: Boolean(g.row),
      fields: GUIDE_FIELDS,
      draft: Object.fromEntries(GUIDE_KEYS.map((k) => [k, draft[k] ?? null])),
      // 名簿・手続きから写す値（ここで直せない。直すのは名簿・入社手続き）
      autofill: { name: preview.name, joinOn: preview.joinOn, department: preview.department, position: preview.position, role: preview.role },
      missing: missingFields(draft, preview),
      version: g.row?.version || 0,
      issuedAt: g.row?.issued_at || null,
      issued: issue ? { version: issue.version, issuedAt: issue.issued_at, view: guideView(issue.snapshot) } : null,
      // 発行したあとに、下書きや名簿が変わったか（変わっていれば、発行し直すと版が上がる）
      dirty: issue ? !sameSnapshot(issue.snapshot, preview) : Boolean(g.row),
      confirmedVersion: g.row?.confirmed_version ?? null,
      confirmedAt: g.row?.confirmed_at || null,
    },
    invites: (invites || []).map((i) => ({
      id: i.id, createdAt: i.created_at, expiresAt: i.expires_at, revokedAt: i.revoked_at, status: inviteStatus(i),
      firstOpenedAt: i.first_opened_at, lastOpenedAt: i.last_opened_at, openCount: i.open_count || 0,
    })),
    mail: {
      // 設定の状態だけ。鍵・環境変数の値は返さない
      config: { configured: cfg.configured, provider: cfg.provider, fromAddress: cfg.fromAddress, replyTo: cfg.replyTo, reason: cfg.reason },
      canTest: cfg.configured && Boolean(ownerAddress(ctx, user)),
      to: emp.email || null,
      history,
    },
    defaults: { inviteDays: INVITE_TTL_DAYS_DEFAULT },
  };
}

async function mailHistory(sb, ctx, employeeId) {
  const rows = await soft(sb.from("gw_mail_messages").select(MAIL_COLS)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId).order("created_at", { ascending: false }).limit(30));
  const list = rows || [];
  const byUser = new Map();
  const ids = [...new Set(list.map((r) => r.sent_by).filter(Boolean))];
  if (ids.length) {
    const emps = await soft(sb.from("gw_employees").select("user_id, display_name").eq("tenant_id", ctx.tenantId).in("user_id", ids));
    for (const e of emps || []) byUser.set(e.user_id, e.display_name);
  }
  let sentBefore = 0;
  // 古い順に「初回送信 / 再送」を振る
  const labelOf = new Map();
  for (const r of [...list].reverse()) {
    if (r.kind === "test") { labelOf.set(r.id, "テスト"); continue; }
    if (r.status === "sent") { labelOf.set(r.id, sentBefore ? "再送" : "送信"); sentBefore += 1; } else labelOf.set(r.id, "送信");
  }
  return list.map((r) => ({
    id: r.id, kind: r.kind, label: labelOf.get(r.id), status: r.status, to: r.to_email, from: r.from_email, subject: r.subject,
    provider: r.provider, error: r.error, guideVersion: r.guide_version, at: r.created_at, by: byUser.get(r.sent_by) || null,
  }));
}

async function mailBody(res, sb, ctx, emp, mailId) {
  const rows = await soft(sb.from("gw_mail_messages").select("id, subject, body_text, to_email, created_at")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).eq("id", mailId).limit(1));
  const m = (rows || [])[0];
  if (!m) return json(res, 404, { error: "not_found" });
  return json(res, 200, { mail: { id: m.id, subject: m.subject, body: m.body_text, to: m.to_email, at: m.created_at } });
}

// ---- 書き込み -------------------------------------------------------------------

const notReady = (res, g) => json(res, 503, { error: "not_ready", message:
  `この機能に必要なテーブルがまだ作られていません。管理者に ${SQL} の実行を依頼してください`, detail: g?.error?.message || null });

async function saveGuide({ sb, res, req, ctx, user, emp, body }) {
  const norm = normalizeGuideInput(body.fields ?? {});
  if (norm.error) return json(res, 400, { error: norm.error, field: norm.field || null, hint: norm.hint });
  const g = await loadGuide(sb, ctx, emp.id);
  if (g.missing) return notReady(res, g);
  if (g.error) return json(res, 500, { error: "db_read_failed", detail: g.error.message });

  const now = new Date().toISOString();
  if (g.row) {
    const { error } = await sb.from("gw_onboarding_guides").update({ ...norm.value, updated_at: now }).eq("id", g.row.id).eq("tenant_id", ctx.tenantId);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  } else {
    const { error } = await sb.from("gw_onboarding_guides").insert({
      tenant_id: ctx.tenantId, employee_id: emp.id, ...norm.value, created_by: user.id, created_at: now, updated_at: now });
    if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "onboarding.guide_save", target: `employee:${emp.id}`,
    detail: { fields: Object.keys(norm.value) } });
  return json(res, 200, await detail(sb, ctx, req, emp, user));
}

async function issueGuide({ sb, res, req, ctx, user, emp }) {
  let g = await loadGuide(sb, ctx, emp.id);
  if (g.missing) return notReady(res, g);
  if (g.error) return json(res, 500, { error: "db_read_failed", detail: g.error.message });
  const now = new Date().toISOString();
  if (!g.row) {
    const { error } = await sb.from("gw_onboarding_guides").insert({ tenant_id: ctx.tenantId, employee_id: emp.id, created_by: user.id, created_at: now, updated_at: now });
    if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });
    g = await loadGuide(sb, ctx, emp.id);
  }
  const proc = await findProcedure(sb, emp.id, "onboarding").catch(() => ({ row: null }));
  const procedure = proc?.row && proc.row.status !== "cancelled" ? proc.row : null;
  const snapshot = buildSnapshot({ employee: emp, procedure, draft: g.row });

  const last = await latestIssue(sb, g.row.id);
  if (last && sameSnapshot(last.snapshot, snapshot)) {
    return json(res, 409, { error: "no_changes", hint: "前回の発行から、内容が変わっていません" });
  }
  const version = (g.row.version || 0) + 1;
  const { error: ie } = await sb.from("gw_onboarding_guide_issues").insert({
    tenant_id: ctx.tenantId, guide_id: g.row.id, employee_id: emp.id, version, snapshot, issued_by: user.id, issued_at: now });
  if (ie) return json(res, ie.code === "23505" ? 409 : 500, { error: "db_insert_failed", detail: ie.message });
  const { error: ue } = await sb.from("gw_onboarding_guides")
    .update({ version, issued_at: now, issued_by: user.id, updated_at: now }).eq("id", g.row.id).eq("tenant_id", ctx.tenantId);
  if (ue) return json(res, 500, { error: "db_update_failed", detail: ue.message });

  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "onboarding.guide_issue", target: `employee:${emp.id}`, detail: { version } });
  return json(res, 200, await detail(sb, ctx, req, emp, user));
}

/** 案内URLを作る。トークンは、ここで1回だけ平文になる（DB にはハッシュだけ） */
async function makeInvite(sb, ctx, user, emp, guide, { days, revokeOthers }) {
  const token = newOfferToken();
  const expiresAt = inviteExpiry(days);
  const { data, error } = await sb.from("gw_onboarding_invites").insert({
    tenant_id: ctx.tenantId, employee_id: emp.id, guide_id: guide.id, token_hash: sha256(token),
    expires_at: expiresAt, created_by: user.id,
  }).select("id").single();
  if (error) return { error };
  if (revokeOthers) await revokeOtherInvites(sb, ctx, emp.id, data.id);
  return { token, expiresAt, id: data.id };
}

/** exceptId 以外の、有効な案内URLを失効させる */
async function revokeOtherInvites(sb, ctx, employeeId, exceptId) {
  await sb.from("gw_onboarding_invites").update({ revoked_at: new Date().toISOString() })
    .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId).is("revoked_at", null).neq("id", exceptId);
}

/** 発行済みの案内が無いと、URLは作れない */
async function issuedGuideOrStop(sb, res, ctx, emp) {
  const g = await loadGuide(sb, ctx, emp.id);
  if (g.missing) { notReady(res, g); return null; }
  if (!g.row || !(g.row.version > 0)) {
    json(res, 409, { error: "guide_not_issued", hint: "先に入社案内を発行してください" });
    return null;
  }
  return g.row;
}

async function createInvite({ sb, res, req, ctx, user, emp, body }) {
  const guide = await issuedGuideOrStop(sb, res, ctx, emp);
  if (!guide) return;
  const inv = await makeInvite(sb, ctx, user, emp, guide, { days: body.days, revokeOthers: true });
  if (inv.error) return json(res, 500, { error: "db_insert_failed", detail: inv.error.message });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "onboarding.invite_create", target: `employee:${emp.id}`,
    detail: { inviteId: inv.id, expiresAt: inv.expiresAt, via: "copy" } });
  const out = await detail(sb, ctx, req, emp, user);
  // URL は、この応答にだけ含まれる（あとから取り出せない。必要なら発行し直す）
  return json(res, 200, { ...out, invite: { id: inv.id, url: inviteUrl(publicBaseUrl(req), inv.token), expiresAt: inv.expiresAt } });
}

async function revokeInvite({ sb, res, req, ctx, user, emp, body }) {
  const id = String(body.inviteId || "");
  if (!id) return json(res, 400, { error: "invalid_body", required: ["inviteId"] });
  const { data, error } = await sb.from("gw_onboarding_invites").update({ revoked_at: new Date().toISOString() })
    .eq("id", id).eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).is("revoked_at", null).select("id");
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!(data || []).length) return json(res, 404, { error: "not_found", hint: "有効なURLが見つかりません" });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "onboarding.invite_revoke", target: `employee:${emp.id}`, detail: { inviteId: id } });
  return json(res, 200, await detail(sb, ctx, req, emp, user));
}

// ---- メール ---------------------------------------------------------------------

const ownerAddress = (ctx, user) => {
  const a = String(user?.email || ctx?.employee?.email || "").trim();
  return isEmail(a) ? a : null;
};

async function mailParts(sb, ctx, user, emp, url, expiresAt) {
  const proc = await findProcedure(sb, emp.id, "onboarding").catch(() => ({ row: null }));
  const joinOn = proc?.row?.target_on || emp.joined_on || null;
  return renderInviteMail({ companyName: await tenantName(sb, ctx), name: emp.display_name, joinOn, url, expiresAt,
    senderName: ctx.employee?.display_name || null });
}

async function previewMail({ sb, res, ctx, user, emp, body }) {
  const guide = await issuedGuideOrStop(sb, res, ctx, emp);
  if (!guide) return;
  const cfg = mailConfig("onboarding");
  const m = await mailParts(sb, ctx, user, emp, URL_PLACEHOLDER, inviteExpiry(body.days));
  return json(res, 200, { preview: {
    to: emp.email || null, toValid: isEmail(emp.email), from: cfg.from, replyTo: cfg.replyTo,
    subject: m.subject, body: m.text, configured: cfg.configured, reason: cfg.reason,
    // 本人の画面（/onboarding/）で見える案内。メールと別に、確認用
    guideView: guideView((await latestIssue(sb, guide.id))?.snapshot),
  } });
}

const TOKEN_MARK = "〈トークンは保存しません〉";

/**
 * 履歴に1通残す。本文は確定版（送った文面そのまま）。
 * ただし、案内URLのトークンだけは、保存しない（トークンはDBにハッシュでしか持たない。
 * 履歴の本文に平文で残すと、その約束が崩れる）。どのURLだったかは、invite_id で分かる
 */
async function recordMail(sb, ctx, user, emp, { kind, inviteId, guideVersion, to, r, subject, text, token }) {
  const { error } = await sb.from("gw_mail_messages").insert({
    tenant_id: ctx.tenantId, employee_id: emp.id, purpose: "onboarding_guide", kind, invite_id: inviteId || null,
    guide_version: guideVersion, to_email: to, from_email: r.from || null, reply_to: r.replyTo || null,
    subject, body_text: token ? text.split(token).join(TOKEN_MARK) : text, provider: r.provider, status: r.status, provider_message_id: r.providerMessageId,
    error: r.error, sent_by: user.id,
  });
  if (error) console.error("[keiei/onboarding] メール履歴を残せませんでした:", error.message);
  return !error;
}

async function sendTest({ sb, res, req, ctx, user, emp }) {
  const guide = await issuedGuideOrStop(sb, res, ctx, emp);
  if (!guide) return;
  const cfg = mailConfig("onboarding");
  if (!cfg.configured) return json(res, 409, { error: "mail_not_configured", hint: notConfiguredHint(cfg) });
  const to = ownerAddress(ctx, user);
  if (!to) return json(res, 409, { error: "no_test_address", hint: "テスト送信の宛先（あなたのメールアドレス）が見つかりません" });

  // テスト用のURLは1日だけ有効。本人に渡している有効なURLは、失効させない
  const inv = await makeInvite(sb, ctx, user, emp, guide, { days: 1, revokeOthers: false });
  if (inv.error) return json(res, 500, { error: "db_insert_failed", detail: inv.error.message });
  const m = await mailParts(sb, ctx, user, emp, inviteUrl(publicBaseUrl(req), inv.token), inv.expiresAt);
  const subject = `【テスト】${m.subject}`;
  const text = `※ これは、本人へ送る前のテスト送信です（宛先: ${emp.display_name} さんではなく、あなたです）。\n\n${m.text}`;
  const r = await sendMail({ purpose: "onboarding", to, subject, text });
  await recordMail(sb, ctx, user, emp, { kind: "test", inviteId: inv.id, guideVersion: guide.version, to, r, subject, text, token: inv.token });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "onboarding.mail_test", target: `employee:${emp.id}`, detail: { status: r.status } });
  if (r.status !== "sent") return json(res, 502, { error: "mail_failed", hint: r.error || "送信できませんでした", result: { status: r.status } });
  return json(res, 200, { ...(await detail(sb, ctx, req, emp, user)), result: { status: r.status, to } });
}

async function sendReal({ sb, res, req, ctx, user, emp }) {
  const guide = await issuedGuideOrStop(sb, res, ctx, emp);
  if (!guide) return;
  const cfg = mailConfig("onboarding");
  // 未設定・停止中は、実送信も履歴も作らない。案内URLをコピーして渡す
  if (!cfg.configured) return json(res, 409, { error: "mail_not_configured", hint: notConfiguredHint(cfg) });
  if (!isEmail(emp.email)) return json(res, 409, { error: "no_recipient", hint: "本人のメールアドレスが名簿にありません（または形式が正しくありません）" });

  // 前のURLは、新しいメールが「送れた」あとで失効させる。先に失効させると、送信に失敗したとき
  // すでに届いているURLまで使えなくなり、本人は開けず、新しいURLも届いていない状態になる
  const inv = await makeInvite(sb, ctx, user, emp, guide, { days: undefined, revokeOthers: false });
  if (inv.error) return json(res, 500, { error: "db_insert_failed", detail: inv.error.message });
  const m = await mailParts(sb, ctx, user, emp, inviteUrl(publicBaseUrl(req), inv.token), inv.expiresAt);
  const r = await sendMail({ purpose: "onboarding", to: emp.email, subject: m.subject, text: m.text });
  if (r.status === "sent") await revokeOtherInvites(sb, ctx, emp.id, inv.id);
  await recordMail(sb, ctx, user, emp, { kind: "send", inviteId: inv.id, guideVersion: guide.version, to: emp.email, r, subject: m.subject, text: m.text, token: inv.token });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "onboarding.mail_send", target: `employee:${emp.id}`,
    detail: { status: r.status, provider: r.provider, inviteId: inv.id, guideVersion: guide.version } });
  if (r.status !== "sent") {
    return json(res, 502, { error: "mail_failed", hint: `${r.error || "送信できませんでした"}。案内URLをコピーして、別の方法でお渡しすることもできます`, result: { status: r.status } });
  }
  return json(res, 200, { ...(await detail(sb, ctx, req, emp, user)), result: { status: r.status, to: emp.email } });
}

const notConfiguredHint = (cfg) =>
  `メール送信は使えません（${cfg.reason || "未設定"}）。「案内URLを発行」から、URLをコピーして本人へお渡しください`;
