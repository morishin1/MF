// GET  /api/sales/company-portal?companyId=…   企業ポータルの利用者・保存人材・利用履歴（Sales の企業詳細「企業ポータル」）
// POST /api/sales/company-portal                発行・再招待・停止・再開・権限変更
//   { action:"invite",   companyId, email, displayName, role, sendMail }
//   { action:"reinvite", companyId, memberId, sendMail }
//   { action:"disable",  companyId, memberId, reason }
//   { action:"enable",   companyId, memberId }          … 管理側（経営者・責任者・管理者）だけ
//   { action:"role",     companyId, memberId, role }
//
// ■ 社内と社外を混ぜない
//   社員名簿・ENGER の社内メンバーのメールには発行しない。企業ポータルの利用者は enger.jp/business だけを使う。
// ■ パスワードは扱わない
//   招待リンク（7日・1回だけ）で本人が決める。平文のトークンは発行の応答で1回だけ返し、DB には sha256 だけを置く。
// ■ 企業IDはテナントの企業一覧で確かめる（他社・範囲外の企業IDでは何もできない）
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { canAccessEightEngerDirectory } from "../../lib/sales-enger-scope.js";
import { canManageProposals } from "../../lib/sales-proposals.js";
import { admin } from "../../lib/supabase.js";
import { isUuid } from "../../lib/sales.js";
import { gwLog } from "../../lib/gw-audit.js";
import { sendMail, mailConfig } from "../../lib/mail/index.js";
import {
  PORTAL_TABLES as T, ROLES, INVITE_TTL_DAYS, EVENT_LABEL, NOT_READY, isMissingTable,
  inviteInput, memberView, inviteMail, inviteUrl, loginUrl, resetUrl, sha256, newInviteToken,
} from "../../lib/sales-company-portal.js";
import { companyInScope, logPortalEvent, isInternalEmail, setPortalAuthBan, latestInvites } from "../../lib/sales-company-portal-db.js";
import { toPublicTalent } from "../../lib/enger-talent-public.js";

const MEMBER_COLS = "id,tenant_id,company_id,email,display_name,role,auth_user_id,registered_at,last_login_at,disabled_at,disabled_reason,created_at";
const DAY = 86400000;

export default async function handler(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  res.setHeader?.("Cache-Control", "private, no-store");
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST"]);
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx) || !canAccessEightEngerDirectory(ctx)) return json(res, 403, { error: "forbidden" });
  const body = req.method === "POST" ? await readJson(req) : null;
  const companyId = req.method === "GET" ? new URL(req.url || "/", "http://localhost").searchParams.get("companyId") : body?.companyId;
  if (!isUuid(companyId)) return json(res, 400, { error: "invalid_company", hint: "企業IDが正しくありません。一覧を再読み込みしてください。" });
  const db = admin();
  const scope = await companyInScope(db, ctx.tenantId, companyId);
  if (!scope.ok) return json(res, scope.status, { error: scope.error, hint: "この企業は Sales の企業一覧で確認できません。" });
  try {
    if (req.method === "GET") return await read(res, db, ctx, scope.company);
    return await act(res, db, ctx, user, scope.company, body || {});
  } catch {
    return json(res, 503, { error: "portal_unavailable", hint: "企業ポータルの情報を確認できませんでした。時間をおいて再度お試しください。" });
  }
}

async function read(res, db, ctx, company) {
  const members = await db.schema("enger").from(T.members).select(MEMBER_COLS)
    .eq("tenant_id", ctx.tenantId).eq("company_id", company.id).order("created_at", { ascending: true }).limit(100);
  if (members.error) return json(res, 503, isMissingTable(members.error) ? NOT_READY : { error: "portal_unavailable" });
  const list = members.data || [];
  const inv = await latestInvites(db, list.map((m) => m.id));
  if (inv.error) return json(res, 503, { error: "portal_unavailable" });
  const now = Date.now();

  const [saved, events] = await Promise.all([
    db.schema("enger").from(T.saved).select("candidate_id,member_id,created_at").eq("company_id", company.id).order("created_at", { ascending: false }).limit(200),
    db.schema("enger").from(T.events).select("id,member_id,actor_kind,action,target_id,detail,created_at").eq("company_id", company.id).order("created_at", { ascending: false }).limit(300),
  ]);
  if (saved.error || events.error) return json(res, 503, { error: "portal_unavailable" });
  const nameOf = new Map(list.map((m) => [m.id, m.display_name]));

  let savedTalents = [];
  const ids = [...new Set((saved.data || []).map((s) => s.candidate_id))];
  if (ids.length) {
    const c = await db.schema("enger").from("candidates").select("id,candidate_no,initials,title,skills,created_at").in("id", ids);
    if (c.error) return json(res, 503, { error: "portal_unavailable" });
    const byId = new Map((c.data || []).map((r) => [r.id, r]));
    savedTalents = (saved.data || []).filter((s) => byId.has(s.candidate_id)).map((s) => {
      const t = toPublicTalent(byId.get(s.candidate_id), { now });
      return { id: s.candidate_id, talentNo: t.talentNo, displayName: t.displayName, title: t.title, skills: t.skills.slice(0, 6), savedBy: nameOf.get(s.member_id) || "（削除された利用者）", savedAt: s.created_at };
    });
  }

  const recent = (events.data || []);
  const since = now - 30 * DAY;
  const count = (action) => recent.filter((e) => e.action === action && Date.parse(e.created_at) >= since).length;
  const mail = mailConfig("portal");
  return json(res, 200, {
    company,
    members: list.map((m) => memberView(m, inv.map.get(m.id) || null, now)),
    saved: savedTalents,
    events: recent.slice(0, 60).map((e) => ({
      id: e.id, at: e.created_at, actorKind: e.actor_kind, action: e.action, label: EVENT_LABEL[e.action] || e.action,
      member: e.member_id ? nameOf.get(e.member_id) || null : null, targetId: e.target_id, detail: summarize(e.detail),
    })),
    usage: { logins30: count("portal.login"), searches30: count("talent.search"), views30: count("talent.view"), saves30: count("talent.save") },
    usageComplete: recent.length < 300,
    canEnable: canManageProposals(ctx),
    roles: ROLES,
    mail: { configured: mail.configured, reason: mail.configured ? null : mail.reason },
    portal: { loginUrl: loginUrl(), resetUrl: resetUrl() },
  });
}

// 記録の中身は、決まった項目だけを画面に出す（自由な JSON をそのまま返さない）
function summarize(detail) {
  const d = detail && typeof detail === "object" ? detail : {};
  const out = [];
  if (d.role) out.push("権限：" + (ROLES[d.role] || d.role));
  if (d.mail) out.push("招待メール：" + ({ sent: "送信受付", skipped: "未送信（リンクを手渡し）", failed: "送信失敗" }[d.mail] || d.mail));
  if (d.reason) out.push("理由：" + String(d.reason).slice(0, 120));
  if (d.tab) out.push("表示：" + ({ all: "全人材", focus: "注力", new: "新着", saved: "保存" }[d.tab] || d.tab));
  if (d.count != null) out.push(String(d.count) + "件");
  if (d.status) out.push("状態：" + d.status);
  if (d.authBan) out.push("ログイン：" + ({ applied: "Auth も停止・再開", skipped: "ポータルだけ停止（兼用アカウント）" }[d.authBan] || d.authBan));
  return out.join(" ／ ");
}

async function loadMember(db, ctx, company, memberId) {
  if (!isUuid(memberId)) return { status: 400, error: "invalid_member" };
  const r = await db.schema("enger").from(T.members).select(MEMBER_COLS).eq("id", memberId).maybeSingle();
  if (r.error) return { status: 503, error: isMissingTable(r.error) ? "not_ready" : "portal_unavailable" };
  // 別テナント・別企業の利用者は「無い」と同じに扱う
  if (!r.data || r.data.tenant_id !== ctx.tenantId || r.data.company_id !== company.id) return { status: 404, error: "member_not_found" };
  return { member: r.data };
}

async function issueInvite(db, user, member, company, { sendMail: wantMail, senderName }) {
  const now = Date.now();
  // 開いている招待は取り消してから、新しい招待を作る（有効なリンクは常に1本だけ）
  const revoked = await db.schema("enger").from(T.invites).update({ revoked_at: new Date(now).toISOString() })
    .eq("member_id", member.id).is("used_at", null).is("revoked_at", null);
  if (revoked.error) return { error: "invite_failed" };
  const token = newInviteToken();
  const expiresAt = new Date(now + INVITE_TTL_DAYS * DAY).toISOString();
  const ins = await db.schema("enger").from(T.invites).insert({ member_id: member.id, token_hash: sha256(token), expires_at: expiresAt, created_by: user.id });
  if (ins.error) return { error: "invite_failed" };
  const url = inviteUrl(token);
  let mail = "skipped", mailError = null;
  if (wantMail) {
    const m = inviteMail({ companyName: company.name, displayName: member.display_name, url, expiresAt, senderName });
    const r = await sendMail({ purpose: "portal", to: member.email, subject: m.subject, text: m.text });
    mail = r.status; mailError = r.status === "sent" ? null : r.error;
  }
  return { url, expiresAt, mail, mailError };
}

async function act(res, db, ctx, user, company, body) {
  const actorName = ctx.employee?.display_name || null;
  const base = { companyId: company.id, actorKind: "staff", actorUserId: user.id };

  if (body.action === "invite") {
    const v = inviteInput(body);
    if (v.error) return json(res, 400, v);
    const internal = await isInternalEmail(db, v.value.email);
    if (internal === null) return json(res, 503, { error: "lookup_failed", hint: "社内アカウントかどうかを確認できませんでした。時間をおいて再度お試しください。" });
    if (internal) return json(res, 409, { error: "internal_account", hint: "社内（社員・ENGERメンバー）のメールアドレスには企業アカウントを発行できません。企業担当者のメールアドレスを入力してください。" });
    const dup = await db.schema("enger").from(T.members).select("id,company_id,tenant_id").eq("email", v.value.email).maybeSingle();
    if (dup.error) return json(res, 503, isMissingTable(dup.error) ? NOT_READY : { error: "portal_unavailable" });
    if (dup.data) {
      const same = dup.data.company_id === company.id && dup.data.tenant_id === ctx.tenantId;
      return json(res, 409, { error: "already_member", hint: same ? "このメールアドレスは発行済みです。一覧から再招待・停止を操作してください。" : "このメールアドレスは別の企業で発行済みです。企業の付け替えは管理者に相談してください。" });
    }
    const ins = await db.schema("enger").from(T.members).insert({
      tenant_id: ctx.tenantId, company_id: company.id, email: v.value.email, display_name: v.value.displayName,
      role: v.value.role, created_by: user.id,
    }).select(MEMBER_COLS).single();
    if (ins.error) {
      if (ins.error.code === "23505") return json(res, 409, { error: "already_member", hint: "このメールアドレスは発行済みです。画面を再読み込みしてください。" });
      return json(res, 503, isMissingTable(ins.error) ? NOT_READY : { error: "invite_failed" });
    }
    const inv = await issueInvite(db, user, ins.data, company, { sendMail: v.value.sendMail, senderName: actorName });
    if (inv.error) return json(res, 503, { error: "invite_failed", hint: "利用者は作成しましたが、招待リンクを作れませんでした。一覧から「再招待」を押してください。" });
    const audited = await logPortalEvent(db, { ...base, memberId: ins.data.id, action: "member.invite", detail: { role: v.value.role, mail: inv.mail } });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.portal_invite", target: `enger_company:${company.id}`, detail: { member: ins.data.id, role: v.value.role } });
    return json(res, 200, { ok: true, member: memberView(ins.data, { created_at: new Date().toISOString(), expires_at: inv.expiresAt }), inviteUrl: inv.url, expiresAt: inv.expiresAt, mail: inv.mail, mailError: inv.mailError, audited });
  }

  const found = await loadMember(db, ctx, company, body.memberId);
  if (found.error) return json(res, found.status, found.error === "not_ready" ? NOT_READY : { error: found.error });
  const m = found.member;
  const stamp = new Date().toISOString();

  if (body.action === "reinvite") {
    if (m.disabled_at) return json(res, 409, { error: "disabled", hint: "停止中のアカウントです。先に再開してください。" });
    if (m.auth_user_id) return json(res, 409, { error: "already_registered", hint: "初回設定は完了しています。パスワードを忘れた場合は、企業担当者にログイン画面の「パスワードをお忘れの方」から再設定してもらってください。", resetUrl: resetUrl() });
    const inv = await issueInvite(db, user, m, company, { sendMail: body.sendMail === true, senderName: actorName });
    if (inv.error) return json(res, 503, { error: "invite_failed" });
    const audited = await logPortalEvent(db, { ...base, memberId: m.id, action: "member.reinvite", detail: { mail: inv.mail } });
    return json(res, 200, { ok: true, inviteUrl: inv.url, expiresAt: inv.expiresAt, mail: inv.mail, mailError: inv.mailError, audited });
  }

  if (body.action === "disable") {
    if (m.disabled_at) return json(res, 200, { ok: true, unchanged: true });
    const reason = String(body.reason ?? "").trim().slice(0, 300);
    if (!reason) return json(res, 400, { error: "reason_required", hint: "停止の理由（退職・契約終了など）を入力してください。" });
    const up = await db.schema("enger").from(T.members).update({ disabled_at: stamp, disabled_by: user.id, disabled_reason: reason, updated_at: stamp }).eq("id", m.id).is("disabled_at", null);
    if (up.error) return json(res, 503, { error: "update_failed" });
    await db.schema("enger").from(T.invites).update({ revoked_at: stamp }).eq("member_id", m.id).is("used_at", null).is("revoked_at", null);
    const ban = await setPortalAuthBan(db, m.auth_user_id, true);
    const audited = await logPortalEvent(db, { ...base, memberId: m.id, action: "member.disable", detail: { reason, authBan: ban.applied ? "applied" : m.auth_user_id ? "skipped" : undefined } });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.portal_disable", target: `enger_company:${company.id}`, detail: { member: m.id, authBan: ban.applied } });
    return json(res, 200, { ok: true, authBan: ban, audited });
  }

  if (body.action === "enable") {
    if (!canManageProposals(ctx)) return json(res, 403, { error: "forbidden", hint: "停止したアカウントの再開は、経営者・責任者が行います。" });
    if (!m.disabled_at) return json(res, 200, { ok: true, unchanged: true });
    const up = await db.schema("enger").from(T.members).update({ disabled_at: null, disabled_by: null, disabled_reason: null, updated_at: stamp }).eq("id", m.id);
    if (up.error) return json(res, 503, { error: "update_failed" });
    const ban = await setPortalAuthBan(db, m.auth_user_id, false);
    const audited = await logPortalEvent(db, { ...base, memberId: m.id, action: "member.enable", detail: { authBan: ban.applied ? "applied" : m.auth_user_id ? "skipped" : undefined } });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.portal_enable", target: `enger_company:${company.id}`, detail: { member: m.id } });
    return json(res, 200, { ok: true, authBan: ban, audited, hint: m.auth_user_id ? null : "未登録のアカウントです。必要なら「再招待」で新しいリンクを発行してください。" });
  }

  if (body.action === "role") {
    if (!Object.hasOwn(ROLES, body.role)) return json(res, 400, { error: "invalid_role" });
    if (m.role === body.role) return json(res, 200, { ok: true, unchanged: true });
    const up = await db.schema("enger").from(T.members).update({ role: body.role, updated_at: stamp }).eq("id", m.id);
    if (up.error) return json(res, 503, { error: "update_failed" });
    const audited = await logPortalEvent(db, { ...base, memberId: m.id, action: "member.role", detail: { role: body.role } });
    return json(res, 200, { ok: true, audited });
  }

  return json(res, 400, { error: "invalid_action" });
}
