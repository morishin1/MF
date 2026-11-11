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
// ■ 発行済みパスワードは取得・保存せず、一時パスワードを発行時の一度だけ表示する
//   招待リンク（7日・1回だけ）で本人が決める。平文のトークンは発行の応答で1回だけ返し、DB には sha256 だけを置く。
// ■ 企業IDはテナントの企業一覧で確かめる（他社・範囲外の企業IDでは何もできない）
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { canAccessEightEngerDirectory } from "../../lib/sales-enger-scope.js";
import { canManageProposals } from "../../lib/sales-proposals.js";
import { admin } from "../../lib/supabase.js";
import { isUuid, safeUrl, domainOf } from "../../lib/sales.js";
import { gwLog } from "../../lib/gw-audit.js";
import { sendMail, mailConfig } from "../../lib/mail/index.js";
import {
  PORTAL_TABLES as T, ROLES, INVITE_TTL_DAYS, EVENT_LABEL, NOT_READY, isMissingTable,
  inviteInput, memberView, inviteMail, inviteUrl, loginUrl, resetUrl, portalBaseUrl, sha256, newInviteToken, newTemporaryPassword,
} from "../../lib/sales-company-portal.js";
import { companyInScope, logPortalEvent, isInternalEmail, setPortalAuthBan, latestInvites } from "../../lib/sales-company-portal-db.js";
import { toPublicTalent } from "../../lib/enger-talent-public.js";
import {formatCompanyNumber} from "../../lib/sales-company-number.js";
import {meetingPreviewDemoAllowed,meetingPreviewDemoEmail,MEETING_DEMO_HOURS,newMeetingPreviewPassword} from "../../lib/sales-company-demo-preview.js";

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

// 企業ポータル案内の送信前に連絡停止・注意指定を再検証する。
async function outreachPolicy(db, ctx, company) {
  const [directory, source, links] = await Promise.all([
    db.schema("enger").from("dx2_sales_company_directory_for_tenant")
      .select("id,needs_contact_review,directory_hidden_at").eq("tenant_id",ctx.tenantId)
      .eq("id",company.id).maybeSingle(),
    db.schema("enger").from("companies").select("contact_name,contact_email,caution,website")
      .eq("id",company.id).is("deleted_at",null).maybeSingle(),
    db.from("gw_sales_company_links").select("company_id").eq("tenant_id",ctx.tenantId)
      .eq("source_system","enger").eq("source_company_id",company.id).limit(2),
  ]);
  const fail=reason=>({allowed:false,reason,name:source.data?.contact_name||"",email:source.data?.contact_email||""});
  if(directory.error||source.error||links.error||!directory.data||!source.data)return fail("連絡可否の検証ができません");
  if(directory.data.needs_contact_review||directory.data.directory_hidden_at||source.data.caution)
    return fail("連絡注意・非表示・確認待ち企業です");
  if((links.data||[]).length>1)return fail("企業IDの紐づけが重複しています");
  if((links.data||[]).length===1){
    const c=await db.from("gw_sales_companies").select("hidden_at,ng_reason")
      .eq("tenant_id",ctx.tenantId).eq("id",links.data[0].company_id).maybeSingle();
    if(c.error||!c.data)return fail("営業情報の確認ができません");
    if(c.data.hidden_at||c.data.ng_reason)return fail("営業禁止・連絡停止企業です");
  }
  const domain=safeUrl(source.data.website)?domainOf(source.data.website):null;
  if(domain){
    const same=await db.from("gw_sales_companies").select("hidden_at,ng_reason")
      .eq("tenant_id",ctx.tenantId).eq("domain",domain);
    if(same.error)return fail("ドメイン単位の連絡停止を確認できません");
    if((same.data||[]).some(c=>c.hidden_at||c.ng_reason))return fail("関連企業に連絡停止・営業禁止指定があります");
  }
  const name=String(source.data.contact_name||"").trim();
  const email=String(source.data.contact_email||"").trim().toLowerCase();
  if(!name||!email)return fail("企業基本情報の担当者名・メールが未登録です");
  return {allowed:true,reason:null,name,email};
}

async function read(res, db, ctx, company) {
  const members = await db.schema("enger").from(T.members).select(MEMBER_COLS)
    .eq("tenant_id", ctx.tenantId).eq("company_id", company.id).order("created_at", { ascending: true }).limit(100);
  if (members.error) return json(res, 503, isMissingTable(members.error) ? NOT_READY : { error: "portal_unavailable" });
  const list = members.data || [];
  const inv = await latestInvites(db, list.map((m) => m.id));
  if (inv.error) return json(res, 503, { error: "portal_unavailable" });
  const now = Date.now();

  const [saved, events, loginEvents] = await Promise.all([
    db.schema("enger").from(T.saved).select("candidate_id,member_id,created_at").eq("company_id", company.id).order("created_at", { ascending: false }).limit(200),
    db.schema("enger").from(T.events).select("id,member_id,actor_kind,action,target_id,detail,created_at").eq("company_id", company.id).order("created_at", { ascending: false }).limit(300),
    db.schema("enger").from(T.events).select("id,member_id,created_at")
      .eq("company_id",company.id).eq("action","portal.login")
      .order("created_at",{ascending:false}).limit(100),
  ]);
  if (saved.error || events.error || loginEvents.error) return json(res, 503, { error: "portal_unavailable" });
  const numberRow=await db.schema("enger").from("companies")
    .select("company_no,contact_name,contact_email").eq("id",company.id).maybeSingle();
  if(numberRow.error||!numberRow.data)return json(res,503,{error:"company_number_unavailable"});
  const displayId=formatCompanyNumber(numberRow.data.company_no);
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
  const outreach = await outreachPolicy(db, ctx, company);
  return json(res, 200, {
    company,
    members: list.map((m) => memberView(m, inv.map.get(m.id) || null, now)),
    saved: savedTalents,
    events: recent.slice(0, 60).map((e) => ({
      id: e.id, at: e.created_at, actorKind: e.actor_kind, action: e.action, label: EVENT_LABEL[e.action] || e.action,
      member: e.member_id ? nameOf.get(e.member_id) || null : null, targetId: e.target_id, detail: summarize(e.detail),
    })),
    loginHistory: (loginEvents.data||[]).filter(e=>nameOf.has(e.member_id)).map(e=>({
      id:e.id,at:e.created_at,member:nameOf.get(e.member_id)||null,
      email:list.find(m=>m.id===e.member_id)?.email||null,
    })),
    usage: { logins30: count("portal.login"), searches30: count("talent.search"), views30: count("talent.view"), saves30: count("talent.save") },
    usageComplete: recent.length < 300,
    canEnable: canManageProposals(ctx), // stopping/re-enabling stays manager restricted
    canIssue: true, // Sales scope and company ID were already verified
    // A missing external contact never prevents the staff meeting. It only
    // defers issuance of a real corporate login until identity is verified.
    contactReady: !inviteInput({displayName:numberRow.data.contact_name,
      email:numberRow.data.contact_email,role:"admin"}).error,
    contact: {name:outreach.name,email:outreach.email},
    contactAllowed:outreach.allowed,
    contactReason:outreach.reason,
    previewDemoAllowed: meetingPreviewDemoAllowed(),
    roles: ROLES,
    mail: { configured: mail.configured, reason: mail.configured ? null : mail.reason },
    portal: { loginUrl: loginUrl(), resetUrl: resetUrl(), displayId },
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
  if(["invite","reinvite","login_link"].includes(body.action)) {
    const policy=await outreachPolicy(db,ctx,company);
    if(!policy.allowed)return json(res,409,{error:"contact_blocked",hint:policy.reason});
    if(body.outreach===true){
      if(body.confirmed!==true)return json(res,400,{error:"confirmation_required"});
      if(body.action!=="login_link"&&body.sendMail!==true)return json(res,400,{error:"mail_required"});
      if(body.action==="invite"&&String(body.email||"").trim().toLowerCase()!==policy.email)
        return json(res,409,{error:"recipient_changed",hint:"企業基本情報の送信先が変更されました。再確認してください。"});
    }
  }

  // 商談ボタンから初回だけ自動発行。入力は企業基本情報の保存済みの担当者情報だけ。
  // 既存アカウントを再発行・上書きしない。パスワードを返すのは新規発行時の一度だけ。
  // Explicitly rotate only a preview demo password (never a real company account).
  // Existing passwords are not reset by simply opening the meeting modal.
  if(body.action==="rotate_meeting_demo_password"){
    if(!meetingPreviewDemoAllowed())
      return json(res,403,{error:"not_allowed"});
    if(body.confirmed!==true)return json(res,400,{error:"confirmation_required"});
    const demoEmail=meetingPreviewDemoEmail(company.id);
    const memberships=await db.schema("enger").from(T.members)
      .select("id,auth_user_id,email,disabled_at")
      .eq("tenant_id",ctx.tenantId).eq("company_id",company.id).limit(3);
    if(memberships.error)return json(res,503,{error:"member_read_failed"});
    const members=memberships.data||[];
    if(members.length!==1||!members[0].auth_user_id||members[0].disabled_at||
       members[0].email.toLowerCase()!==demoEmail)
      return json(res,409,{error:"not_demo_member",
        hint:"再発行できるのはこの企業のプレビュー専用アカウントだけです。"});
    const {data:found,error:readError}=await db.auth.admin.getUserById(members[0].auth_user_id);
    const authUser=found?.user;
    const meta=authUser?.app_metadata||{};
    if(readError||!authUser||authUser.email?.toLowerCase()!==demoEmail ||
       !Array.isArray(meta.apps)||meta.apps.length!==1||meta.apps[0]!=="business_preview"||
       meta.meeting_demo_company_id!==company.id||meta.meeting_demo_scope!=="preview")
      return json(res,409,{error:"not_demo_user"});
    const temporaryPassword=newMeetingPreviewPassword();
    const expiresAt=new Date(Date.now()+MEETING_DEMO_HOURS*3600000).toISOString();
    const updated=await db.auth.admin.updateUserById(authUser.id,{
      password:temporaryPassword,app_metadata:{
        ...meta,apps:["business_preview"],meeting_demo_scope:"preview",
        meeting_demo_company_id:company.id,meeting_demo_expires_at:expiresAt,
      },
    });
    if(updated.error)return json(res,503,{error:"password_rotate_failed",
      hint:"テスト用パスワードを変更できませんでした。"});
    await logPortalEvent(db,{...base,memberId:members[0].id,action:"member.temp_password",
      detail:{method:"preview_rotate",passwordStored:false,expiresAt}});
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,
      action:"sales.portal_preview_demo_rotated",target:"enger_company:"+company.id,
      detail:{memberId:members[0].id,previewOnly:true,expiresAt}});
    return json(res,200,{ok:true,oneTime:true,previewOnly:true,expiresAt,
      temporaryPassword,loginUrl:loginUrl(),
      hint:"8文字のテスト用パスワードに変更しました。旧パスワードは使えません。"});
  }

  if(body.action==="ensure_meeting_account"){
    // Every Sales-authorized member may issue a company login for a company in scope.
    // Handler already checked canSell and companyInScope; no manager grant required.
    if(body.confirmed!==true)return json(res,400,{error:"confirmation_required"});
    const rows=await db.schema("enger").from(T.members)
      .select("id,auth_user_id,disabled_at,email")
      .eq("tenant_id",ctx.tenantId).eq("company_id",company.id)
      .limit(3);
    if(rows.error)return json(res,503,{error:"member_lookup_failed",
      hint:"企業アカウントの状態を確認できませんでした。"});
    if(rows.data?.length){
      const existing=rows.data.filter(m=>m.auth_user_id&&!m.disabled_at);
      return json(res,200,{ok:true,existing:true,
        state:existing.length?"active":"needs_review",
        hint:existing.length?"既存アカウントをそのまま利用します。パスワードは変更していません。":
          "招待待ち・停止中のアカウントが存在します。企業アカウントの状態を確認してください。"});
    }
    const directory=await db.schema("enger").from("dx2_sales_company_directory_for_tenant")
      .select("id,needs_contact_review,directory_hidden_at")
      .eq("tenant_id",ctx.tenantId).eq("id",company.id).maybeSingle();
    if(directory.error||!directory.data)return json(res,503,{error:"directory_unavailable",
      hint:"企業の連絡可否を確認できません。"});
    if(directory.data.needs_contact_review||directory.data.directory_hidden_at)
      return json(res,409,{error:"contact_review_required",
        hint:"連絡注意・非表示の企業です。連絡可否の確認が必要です。"});
    const baseInfo=await db.schema("enger").from("companies")
      .select("id,contact_name,contact_email,deleted_at,caution")
      .eq("id",company.id).is("deleted_at",null).maybeSingle();
    if(baseInfo.error||!baseInfo.data)return json(res,503,{error:"company_info_unavailable",
      hint:"企業基本情報を取得できませんでした。"});
    if(baseInfo.data.caution)return json(res,409,{error:"company_caution",
      hint:"連絡注意の企業です。連絡可否の確認が必要です。"});
    const name=String(baseInfo.data.contact_name||"").trim();
    const email=String(baseInfo.data.contact_email||"").trim().toLowerCase();
    if(!name||!email){
      // Preview only: no contact is available, but an internal Sales manager
      // may still test the enterprise meeting by company number + password.
      // Store a dedicated business_preview app marker, NOT a real business role.
      // Production ENGER will reject this marker even if a demo password leaks.
      if(!meetingPreviewDemoAllowed())return json(res,409,{error:"contact_missing",
        hint:"正式な企業ログインの発行には企業基本情報の担当者名とメールが必要です。"});
      const demoEmail=meetingPreviewDemoEmail(company.id);
      if(!demoEmail)return json(res,400,{error:"invalid_demo_company"});
      const demoPassword=newMeetingPreviewPassword();
      const expiresAt=new Date(Date.now()+MEETING_DEMO_HOURS*3600000).toISOString();
      const created=await db.auth.admin.createUser({
        email:demoEmail,password:demoPassword,email_confirm:true,
        app_metadata:{
          apps:["business_preview"],meeting_demo_scope:"preview",
          meeting_demo_expires_at:expiresAt,meeting_demo_company_id:company.id,
        },
        user_metadata:{display_name:"商談テスト用"},
      });
      const demoUser=created?.data?.user;
      if(created.error||!demoUser?.id)return json(res,409,{
        error:"demo_user_unavailable",
        hint:"テストアカウントを作成できません。既存の登録状況を管理者が確認してください。",
      });
      const added=await db.schema("enger").from(T.members).insert({
        tenant_id:ctx.tenantId,company_id:company.id,email:demoEmail,
        display_name:"商談テスト用",role:"member",
        auth_user_id:demoUser.id,registered_at:new Date().toISOString(),created_by:user.id,
      }).select(MEMBER_COLS).single();
      if(added.error){
        await db.auth.admin.deleteUser(demoUser.id);
        return json(res,503,{error:"demo_membership_failed",
          hint:"テストアカウントを企業に紐付けできませんでした。管理者にご連絡ください。"});
      }
      await logPortalEvent(db,{...base,memberId:added.data.id,
        action:"member.temp_password",detail:{method:"preview_demo",passwordStored:false,expiresAt}});
      await gwLog({tenantId:ctx.tenantId,actorId:user.id,
        action:"sales.portal_preview_demo_issued",target:"enger_company:"+company.id,
        detail:{memberId:added.data.id,expiresAt,previewOnly:true}});
      return json(res,200,{
        ok:true,oneTime:true,previewOnly:true,expiresAt,
        member:memberView(added.data,null),temporaryPassword:demoPassword,
        loginUrl:loginUrl(),companyId:company.id,
        hint:"社内確認用・24時間有効です。本番ENGERではログインできません。実際の企業へ共有しないでください。",
      });
    }
    const validated=inviteInput({displayName:name,email,role:"admin"});
    if(validated.error)return json(res,409,{error:"contact_invalid",
      hint:"企業基本情報の担当者名・メールの形式を確認して保存してください。"});
    // 既存の管理者権限検証・社内ユーザー遮断・重複検査・一度だけの生成・監査を再利用。
    return act(res,db,ctx,user,company,{
      action:"issue_account",confirmed:true,displayName:name,email,role:"admin",
    });
  }

  if(body.action==="issue_account"){
    // Allowed for scoped Sales members; internal/staff email, duplicate-account and
    // company membership checks below continue to prevent account takeover.
    if(body.confirmed!==true)return json(res,400,{error:"confirmation_required"});
    const v=inviteInput(body);
    if(v.error)return json(res,400,v);
    const internal=await isInternalEmail(db,v.value.email);
    if(internal===null)return json(res,503,{error:"lookup_failed",hint:"社内ユーザーの確認に失敗しました。"});
    if(internal)return json(res,409,{error:"internal_account",
      hint:"社内アカウントに企業専用パスワードを発行できません。"});
    const existing=await db.schema("enger").from(T.members).select("id,tenant_id,company_id")
      .eq("email",v.value.email).limit(1);
    if(existing.error)return json(res,503,{error:"account_check_failed"});
    if(existing.data?.length)return json(res,409,{error:"already_registered",
      hint:"このログインIDは発行済みです。既存担当者のパスワード再発行を利用してください。"});
    const temporaryPassword=newTemporaryPassword();
    const created=await db.auth.admin.createUser({
      email:v.value.email,password:temporaryPassword,email_confirm:true,
      app_metadata:{apps:["business"]},
      user_metadata:{display_name:v.value.displayName},
    });
    const authUser=created?.data?.user;
    if(created.error||!authUser?.id){
      return json(res,409,{error:"auth_duplicate_or_unavailable",
        hint:"このメールはすでに別のサービスで利用されているか、アカウントを作成できません。既存アカウントを上書きしません。"});
    }
    const portalOnly=Array.isArray(authUser.app_metadata?.apps)&&
      authUser.app_metadata.apps.length===1&&authUser.app_metadata.apps[0]==="business";
    if(!portalOnly){
      const fixed=await db.auth.admin.updateUserById(authUser.id,{app_metadata:{apps:["business"]}});
      if(fixed.error){
        await db.auth.admin.deleteUser(authUser.id);
        return json(res,503,{error:"auth_setup_failed",hint:"企業専用権限を設定できませんでした。"});
      }
    }
    const stamp=new Date().toISOString();
    const inserted=await db.schema("enger").from(T.members).insert({
      tenant_id:ctx.tenantId,company_id:company.id,email:v.value.email,
      display_name:v.value.displayName,role:v.value.role,
      auth_user_id:authUser.id,registered_at:stamp,created_by:user.id,
    }).select(MEMBER_COLS).single();
    if(inserted.error){
      await db.auth.admin.deleteUser(authUser.id);
      return json(res,503,{error:"account_registry_failed",
        hint:"利用者台帳に登録できませんでした。登録状況を確認してください。"});
    }
    await logPortalEvent(db,{...base,memberId:inserted.data.id,
      action:"member.temp_password",detail:{method:"sales_initial_issue",passwordStored:false}});
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"sales.portal_account_issued",
      target:"enger_company:"+company.id,detail:{member:inserted.data.id,role:v.value.role}});
    return json(res,200,{ok:true,member:memberView(inserted.data,null),email:v.value.email,
      temporaryPassword,oneTime:true,loginUrl:loginUrl(),
      hint:"8文字の初回パスワードを一度だけ表示します。安全な方法で企業担当者へ共有してください。"});
  }

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

  // 初回設定後はSalesからワンクリックでログイン用メールを再送可能。
  // 管理画面に認証トークンを返さず、登録済みメールへの配送のみ（権限・企業IDチェック済み）。
  if (body.action === "login_link") {
    if (m.disabled_at || !m.auth_user_id) {
      return json(res, 409, { error: "not_registered", hint: "停止中または初回設定前です。初回は招待リンクをご利用ください。" });
    }
    const config = mailConfig("portal");
    if (!config.configured) return json(res, 503, { error: "mail_unavailable", hint: config.reason });
    const auth = await db.auth.admin.getUserById(m.auth_user_id);
    const au = auth.data?.user;
    if (auth.error || !au || au.email?.toLowerCase() !== m.email ||
        !Array.isArray(au.app_metadata?.apps) || !au.app_metadata.apps.includes("business")) {
      return json(res, 409, { error: "auth_mismatch", hint: "企業アカウントの認証情報が一致しません。担当者を確認してください。" });
    }
    const cutoff = new Date(Date.now() - 90_000).toISOString();
    const recent = await db.schema("enger").from(T.events).select("id").eq("member_id", m.id)
      .eq("action", "portal.link_sent").gte("created_at", cutoff).limit(1);
    if (recent.error) return json(res, 503, { error: "rate_check_failed" });
    if ((recent.data || []).length) return json(res, 429, { error: "rate_limited", hint: "ログインリンクは直前に送信済みです。しばらくしてから再送してください。" });
    const token = await db.auth.admin.generateLink({ type: "magiclink", email: m.email });
    const hash = token.data?.properties?.hashed_token;
    if (token.error || token.data?.user?.id !== m.auth_user_id || !/^[a-zA-Z0-9_-]{20,256}$/.test(String(hash || ""))) {
      return json(res, 503, { error: "login_link_failed", hint: "認証リンクを生成できませんでした。" });
    }
    const url = portalBaseUrl() + "/business/confirm?token_hash=" + encodeURIComponent(hash);
    const mail = await sendMail({
      purpose: "portal", to: m.email, subject: "【ENGER business】企業ポータルのログイン用リンク",
      text: [m.display_name + " 様", "", "企業ポータルのログイン用リンクです。", "下のリンクから「ログインする」を押してください。", "", url, "", "このリンクは1回限り有効です。心当たりがなければ破棄してください。", "ENGER business"].join("\n"),
    });
    if (mail.status !== "sent") return json(res, 503, { error: "mail_failed", hint: "メール送信に失敗しました。送信設定をご確認ください。" });
    await logPortalEvent(db, { ...base, memberId: m.id, action: "portal.link_sent", detail: { via: "sales" } });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.portal_login_link", target: `enger_company:${company.id}`, detail: { member: m.id } });
    return json(res, 200, { ok: true, mail: "sent" });
  }

  // Any scoped Sales member can reset an activated, business-only account.
  // Never disclose or retrieve a stored password; rate limit and confirm rotation.
  if (body.action === "generate_password") {
    // Scoped Sales members can rotate a verified business-only account password.
    // Existing anti-replay/rate-limit checks remain mandatory.
    if(body.confirmed!==true)return json(res,400,{
      error:"confirmation_required",hint:"現在のパスワードを変更することを確認してください。",
    });
    if(m.disabled_at||!m.auth_user_id)return json(res,409,{
      error:"not_activated",hint:"まず初回招待リンクから企業担当者本人に利用を開始してもらってください。",
    });
    const auth=await db.auth.admin.getUserById(m.auth_user_id);
    const authUser=auth.data?.user;
    const apps=authUser?.app_metadata?.apps;
    if(auth.error||!authUser||String(authUser.email||"").toLowerCase()!==m.email||
      !Array.isArray(apps)||apps.length!==1||apps[0]!=="business") {
      return json(res,409,{error:"auth_mismatch",
        hint:"この認証アカウントは他サービスと兼用か、企業IDと不一致です。パスワードを変更できません。",
      });
    }
    const since=new Date(Date.now()-10*60*1000).toISOString();
    const recent=await db.schema("enger").from(T.events).select("id")
      .eq("company_id",company.id).eq("member_id",m.id)
      .eq("action","member.temp_password").gte("created_at",since).limit(1);
    if(recent.error)return json(res,503,{error:"history_unavailable"});
    if(recent.data?.length)return json(res,429,{
      error:"rate_limited",hint:"パスワードは直前に再発行済みです。10分以上空けて操作してください。",
    });
    const temporaryPassword=newTemporaryPassword();
    const updated=await db.auth.admin.updateUserById(m.auth_user_id,{password:temporaryPassword});
    if(updated.error||updated.data?.user?.id!==m.auth_user_id) {
      return json(res,503,{error:"password_update_failed",hint:"パスワードを設定できませんでした。"});
    }
    await logPortalEvent(db,{...base,memberId:m.id,action:"member.temp_password",
      detail:{method:"sales_admin",passwordStored:false}});
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"sales.portal_temp_password",
      target:`enger_company:${company.id}`,detail:{member:m.id}});
    return json(res,200,{ok:true,memberId:m.id,email:m.email,temporaryPassword,
      oneTime:true,loginUrl:loginUrl(),
      hint:"パスワードはこの画面に一度だけ表示します。安全に担当者へ伝え、初回ログイン後に変更してもらってください。",
    });
  }

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
