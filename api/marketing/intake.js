// Local review candidate. No sends, notifications, grants, read marks or original updates.
import { requireUser } from "../../lib/auth.js";
import { gwContext, accessOf, canRecruit } from "../../lib/gw.js";
import { admin, userClient } from "../../lib/supabase.js";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { isLeftEmployee } from "../../lib/left-gate.js";
import { probe, spaceDetail, spaceDetailView, courseOne, courseDetailView, contactOne, contactDetailView } from "../../lib/marketing-sources.js";
import { INTAKE_UUID, normalizeIntakeInput, canEditIntake, shapeIntake, intakeFailure, validateIntakeContact } from "../../lib/marketing-intake.js";

const TABLE = "gw_marketing_intake";
const META = "id,tenant_id,channel,biz,source_type,source_id,email_pending,received_at,received_by,owner_employee_id,next_action,due_at,state,result,version,created_by,created_at,updated_at";
const DETAIL = `${META},phone_name,phone_contact,phone_email,phone_subject,callback_wish`;
const active = e => e && ["active", "leaving"].includes(e.status) && !isLeftEmployee(e);
const missing = e => ["42P01", "PGRST205", "PGRST202", "42883", "42703"].includes(String(e?.code));
const failDb = e => { throw intakeFailure(missing(e) ? "intake_not_ready" : "intake_unavailable", missing(e) ? 503 : 500); };
const need = (condition, code = "forbidden", status = 403) => { if (!condition) throw intakeFailure(code, status); };

async function bizAccess(sb, ctx, biz) {
  if (biz === "mugen") return { state: canRecruit(ctx) ? "ok" : "forbidden" };
  if (biz === "space") return probe(sb, "space_is_staff");
  if (biz === "site") return probe(sb, "zimu_is_admin");
  return { state: "forbidden" };
}
function checkAccess(a) { need(a.state === "ok", a.state === "forbidden" ? "source_forbidden" : "source_unavailable", a.state === "forbidden" ? 403 : 503); }

// Re-check original authorization and existence for EVERY read and mutation.
// Metadata never grants access to an original and never changes its state.
async function originalOf(sb, sbAdmin, ctx, row, detail = true) {
  // Course access remains LMS staff, not HR access merely because business=mugen.
  if (row.source_type !== "mugen_course") checkAccess(await bizAccess(sb, ctx, row.biz));
  if (row.channel === "phone") return null;
  const id = row.source_id, source = row.source_type;
  let r, view, url;
  if (source === "hr_mail") {
    need(canRecruit(ctx), "source_forbidden");
    const q = await sbAdmin.from("gw_hr_inbound_mail").select(detail ? "id,subject,body_text,sender_address,received_at,recipient" : "id,recipient")
      .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
    if (q.error) throw intakeFailure("source_unavailable",503);
    need(q.data && q.data.recipient === "saiyou@8grp.co.jp", "source_not_found", 404);
    return { key: `hr_mail:${id}`, url: "/hr/inbox.html", label: "採用窓口メール（手動関連付け）",
      body: q.data.body_text || "", from: q.data.sender_address || "", subject: q.data.subject || "", receivedAt: q.data.received_at };
  }
  if (source === "hr_lead") {
    need(canRecruit(ctx), "source_forbidden");
    const q = await sb.from("gw_hr_applicants").select(detail ? "id,name,email,lead_profile,source,job_title,created_at" : "id")
      .eq("tenant_id", ctx.tenantId).eq("lead_category", "mugendojo").eq("id", id).maybeSingle();
    if (q.error) throw intakeFailure("source_unavailable",503); need(q.data, "source_not_found", 404);
    return { key: `hr_lead:${id}`, url: `/hr/applicants.html?category=mugendojo&id=${id}`, label: "無限道場 原本受付",
      body: q.data.lead_profile?.challenge_text || "", from: q.data.name || "", subject: q.data.job_title || q.data.source || "", receivedAt: q.data.created_at };
  }
  if (!detail) {
    let q;
    if (source === "space_inquiry") q=sb.from("rental_records").select("id").eq("id",id);
    else if (source === "mugen_course") { checkAccess(await probe(sb,"is_lms_staff")); q=sb.schema("lms").from("course_applications").select("id").eq("id",id); }
    else if (source === "site_contact") q=sb.from("contact_submissions").select("id").eq("id",id).eq("source","8grp_lp");
    else throw intakeFailure("invalid_source",400);
    const found=await q.maybeSingle();
    if(found.error) throw intakeFailure("source_unavailable",503);
    need(found.data,"source_not_found",404); return {key:`${source}:${id}`};
  }
  if (source === "space_inquiry") { r = await spaceDetail(sb, id); if (r.status === 200) view = spaceDetailView(r); url = "https://8sp.jp/member/admin.html"; }
  else if (source === "mugen_course") { r = await courseOne(sb, id); if (r.status === 200) view = courseDetailView(r.row); url = "https://mugendojo.jp/mgn/admin/applications"; }
  else if (source === "site_contact") { r = await contactOne(sb, id, { sources: ["8grp_lp"] }); if (r.status === 200) view = contactDetailView(r.row); url = "https://8ec.jp/admin/contact/"; }
  else throw intakeFailure("invalid_source", 400);
  need(r.status === 200, r.status === 403 ? "source_forbidden" : r.status === 404 ? "source_not_found" : "source_unavailable", [403,404].includes(r.status) ? r.status : 503);
  return { key: `${source}:${id}`, url, label: "原本受付（自動取込ではありません）", body: view.body?.text || "",
    from: view.contact?.find(([key]) => ["お名前", "氏名", "申込者"].includes(key))?.[1] || "", subject: view.body?.label || "", receivedAt: r.row.created_at };
}
async function employeesOf(sb, ctx) {
  const r = await sb.from("gw_employees").select("id,display_name,status,left_on")
    .eq("tenant_id", ctx.tenantId).in("status", ["active", "leaving"]).limit(500);
  if (r.error) failDb(r.error);
  const ids = (r.data || []).filter(active).map(e => e.id);
  if (!ids.length) return [];
  const [grants, roles] = await Promise.all([
    sb.from("gw_app_grants").select("employee_id,app_key").eq("tenant_id", ctx.tenantId).eq("app_key", "marketing").in("employee_id", ids),
    sb.from("gw_role_grants").select("employee_id,role").eq("tenant_id", ctx.tenantId).eq("role", "owner").in("employee_id", ids),
  ]);
  // A grant-store error must not imply privileges. Owners may still operate before grant SQL is applied.
  if (roles.error) failDb(roles.error);
  if (grants.error && !missing(grants.error)) failDb(grants.error);
  const allowed = new Set([...(roles.data || []), ...(grants.error ? [] : grants.data || [])].map(g => g.employee_id));
  return (r.data || []).filter(e => active(e) && allowed.has(e.id)).map(e => ({ id: e.id, name: e.display_name || "担当者" }));
}
async function one(sb, ctx, id) {
  const r = await sb.from(TABLE).select(DETAIL).eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
  if (r.error) failDb(r.error); need(r.data, "not_found", 404); return r.data;
}
export default async function handler(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  res.setHeader?.("Cache-Control", "private,no-store");
  try {
    const ctx = await gwContext(user.id);
    need(ctx.tenantId && active(ctx.employee) && ctx.employee.tenant_id === ctx.tenantId && accessOf(ctx).marketing);
    const sa = admin(), sb = userClient(req);
    if (req.method === "GET") {
      const id = new URL(req.url, "http://localhost").searchParams.get("id");
      if (id) {
        need(INTAKE_UUID.test(id), "invalid_id", 400);
        const row = await one(sa, ctx, id); const original = await originalOf(sb, sa, ctx, row);
        const ev = await sa.from("gw_marketing_intake_events").select("id,kind,actor_id,created_at,detail")
          .eq("tenant_id", ctx.tenantId).eq("intake_id", id).order("created_at", { ascending: false }).limit(201);
        if (ev.error) failDb(ev.error);
        const employees = await employeesOf(sa, ctx), names = new Map(employees.map(e => [e.id, e.name]));
        const events=(ev.data || []).slice(0,200).reverse();
        const actorIds=[...new Set([row.received_by,...events.map(e=>e.actor_id)].filter(Boolean))];
        const actors=actorIds.length ? await sa.from("gw_employees").select("user_id,display_name")
          .eq("tenant_id",ctx.tenantId).in("user_id",actorIds) : {data:[]};
        if(actors.error) failDb(actors.error);
        const actorNames=new Map((actors.data||[]).map(e=>[e.user_id,e.display_name]));
        return json(res, 200, { item: { ...shapeIntake(row, names, { detail: true, canEdit: canEditIntake(ctx, user.id, row) }),
            receivedByName:actorNames.get(row.received_by)||null }, original, eventsCapped:(ev.data||[]).length>200,
          events: events.map(e => ({ id: e.id, kind: e.kind, actorId: e.actor_id, actorName:actorNames.get(e.actor_id)||null, at: e.created_at, detail: e.detail })) });
      }
      const sources = await Promise.all(["mugen","space","site"].map(async biz => ({ biz, ...(await bizAccess(sb,ctx,biz)) })));
      const q = await sa.from(TABLE).select(META).eq("tenant_id",ctx.tenantId).order("created_at",{ascending:false}).limit(301);
      if(q.error) failDb(q.error);
      const rows=[];
      for(const row of (q.data||[]).slice(0,300)) { try { await originalOf(sb,sa,ctx,row,false); rows.push(row); } catch(e) { if(!e.intakeError || ![403,404].includes(e.status)) throw e; } }
      const employees=await employeesOf(sa,ctx), names=new Map(employees.map(e=>[e.id,e.name]));
      return json(res,200,{items:rows.map(row=>shapeIntake(row,names,{canEdit:canEditIntake(ctx,user.id,row)})),employees,sources,
        capabilities:{createPhone:sources.some(s=>s.state==="ok"),assignmentSourceAccess:"not_verified_for_other_people"},capped:(q.data||[]).length>300});
    }
    if(!["POST","PATCH"].includes(req.method))return methodNotAllowed(res,["GET","POST","PATCH"]);
    const b=await readJson(req), action=req.method==="POST"?"create":"update";
    need(!b?.action || b.action===action,"invalid_action",400);
    const input=normalizeIntakeInput(b,action,ctx.employee.id);
    let current;
    if(action==="update") { current=await one(sa,ctx,input.id); await originalOf(sb,sa,ctx,current); need(canEditIntake(ctx,user.id,current)); validateIntakeContact(current,input); }
    else { const original=await originalOf(sb,sa,ctx,{channel:input.channel,biz:input.biz,source_type:input.sourceType,source_id:input.sourceId});
      if(original) { input.receivedAt=original.receivedAt || null;
        const old=await sa.from(TABLE).select("id,biz").eq("tenant_id",ctx.tenantId).eq("source_type",input.sourceType).eq("source_id",input.sourceId).maybeSingle();
        if(old.error) failDb(old.error); need(!old.data || old.data.biz===input.biz,"source_business_conflict",409);
      } }
    const employees=await employeesOf(sa,ctx); need(employees.some(e=>e.id===input.ownerEmployeeId),"invalid_owner",400);
    const q=await sa.rpc("gw_marketing_intake_mutate",{p_tenant:ctx.tenantId,p_actor:user.id,p_employee:ctx.employee.id,p_action:action,
      p_request_id:input.requestId,p_id:input.id||null,p_expected_version:input.version||null,p_payload:input});
    if(q.error) failDb(q.error);
    const result=q.data;
    need(result?.ok, result?.error||"intake_unavailable", result?.status||503);
    // Replays may refer to an existing source row: re-check that row before returning it.
    await originalOf(sb,sa,ctx,result.item);
    return json(res,200,{ok:true,item:shapeIntake(result.item,new Map(employees.map(e=>[e.id,e.name])),{detail:true,canEdit:canEditIntake(ctx,user.id,result.item)}),duplicate:result.duplicate===true,assignmentSourceAccessVerified:input.ownerEmployeeId===ctx.employee.id});
  } catch(e) { return json(res,e.intakeError?e.status:500,{error:e.intakeError||"intake_unavailable"}); }
}
