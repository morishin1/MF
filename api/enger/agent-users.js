// ENGERエージェントのログインと担当企業をグループウェアで管理する。
// HR/Officeの契約書確認と分離し、営業企業の閲覧権限は明示的に付与する。
// 社内Sales権限、企業business権限、その他アプリ権限は付与しない。
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canManageHr} from "../../lib/gw.js";
import {requireMfa} from "../../lib/mfa.js";
import {admin} from "../../lib/supabase.js";
import {randomPassword} from "../../lib/accounts.js";
import {gwLog} from "../../lib/gw-audit.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEPT="ENGERエージェント";
const EMPLOYEES="gw_employees";
const MAX_COMPANIES=20;
const fail=(res,status,error,hint)=>json(res,status,{error,hint});
const clean=(v,max)=>typeof v==="string"?v.trim().slice(0,max):"";
const validCompanies=x=>Array.isArray(x)&&x.length<=MAX_COMPANIES&&
  x.every(v=>typeof v==="string"&&UUID.test(v))&&new Set(x).size===x.length;
const dbError=(res,error)=>fail(res,503,"agent_data_unavailable",
  "ENGERの権限・企業情報を確認できません。操作は完了していません。");

async function membershipFor(sb,userId){
  const r=await sb.schema("enger").from("organization_memberships")
    .select("id,user_id,membership_type,role,status,organization_id,partner_organization_id").eq("user_id",userId).limit(2);
  if(r.error)throw r.error;
  if(r.data.length>1)throw new Error("ambiguous_membership");
  return r.data[0]||null;
}
async function safeDirectory(sb,tenantId,ids){
  if(!ids.length)return [];
  const r=await sb.schema("enger").from("dx2_sales_company_directory_for_tenant")
    .select("id,name,needs_contact_review,directory_hidden_at")
    .eq("tenant_id",tenantId).in("id",ids).limit(MAX_COMPANIES+1);
  if(r.error)throw r.error;
  if(r.data?.length!==ids.length||
    r.data.some(x=>x.needs_contact_review||x.directory_hidden_at))
    return null;
  return r.data;
}
async function requireEmployee(sb,tenantId,employeeId){
  const r=await sb.from(EMPLOYEES)
    .select("id,tenant_id,user_id,display_name,email,department,employment_type,status,left_on")
    .eq("tenant_id",tenantId).eq("id",employeeId).maybeSingle();
  if(r.error)throw r.error;
  return r.data;
}

async function list(req,res,sb,ctx){
  const url=new URL(req.url||"/","http://localhost");
  const query=clean(url.searchParams.get("companyQuery"),60);
  if(query){
    if(query.length<2)return fail(res,400,"short_query","会社名を2文字以上入力してください。");
    const safe=query.replace(/[\\%_]/g,"");
    const c=await sb.schema("enger").from("dx2_sales_company_directory_for_tenant")
      .select("id,name").eq("tenant_id",ctx.tenantId)
      .is("directory_hidden_at",null).eq("needs_contact_review",false)
      .ilike("name","%"+safe+"%").order("name").limit(15);
    if(c.error)return dbError(res,c.error);
    return json(res,200,{companies:c.data||[]});
  }
  const e=await sb.from(EMPLOYEES)
    .select("id,user_id,display_name,email,department,employment_type,status,left_on")
    .eq("tenant_id",ctx.tenantId).eq("department",DEPT)
    .order("created_at",{ascending:false}).limit(200);
  if(e.error)return dbError(res,e.error);
  const employees=e.data||[],userIds=employees.map(x=>x.user_id).filter(x=>UUID.test(x||""));
  if(!userIds.length)return json(res,200,{agents:[],canManage:true});
  const m=await sb.schema("enger").from("organization_memberships")
    .select("id,user_id,membership_type,status").in("user_id",userIds).limit(200);
  if(m.error)return dbError(res,m.error);
  const mids=(m.data||[]).map(x=>x.id).filter(Boolean);
  let access=[],scopes=[];
  if(mids.length){
    const [a,s]=await Promise.all([
      sb.schema("enger").from("member_product_access")
        .select("membership_id,can_view").in("membership_id",mids).eq("product","partner_sales"),
      sb.schema("enger").from("member_data_scope")
        .select("membership_id,scope_type,scope_id").in("membership_id",mids)
    ]);
    if(a.error||s.error)return dbError(res,a.error||s.error);
    access=a.data||[];scopes=s.data||[];
  }
  const byUser=new Map((m.data||[]).map(x=>[x.user_id,x]));
  // Show names of currently assigned companies instead of raw UUIDs.
  const currentCompanyIds=[...new Set(scopes.filter(s=>s.scope_type==="company"&&UUID.test(s.scope_id||""))
    .map(s=>s.scope_id))].slice(0,250);
  let companyNames={};
  if(currentCompanyIds.length){
    const directory=await sb.schema("enger").from("dx2_sales_company_directory_for_tenant")
      .select("id,name").eq("tenant_id",ctx.tenantId)
      .in("id",currentCompanyIds).limit(250);
    if(directory.error)return dbError(res,directory.error);
    companyNames=Object.fromEntries((directory.data||[]).map(d=>[d.id,d.name]));
  }
  return json(res,200,{canManage:true,companyNames,agents:employees.map(e=>{
    const mm=byUser.get(e.user_id);
    const grant=access.find(x=>x.membership_id===mm?.id);
    return {
      employeeId:e.id,name:e.display_name,email:e.email,
      employmentType:e.employment_type,hasLogin:Boolean(e.user_id),
      enabled:e.status==="active"&&!e.left_on&&mm?.membership_type==="external"&&
        mm?.status==="active"&&grant?.can_view===true,
      companyIds:scopes.filter(x=>x.membership_id===mm?.id&&x.scope_type==="company")
        .map(x=>x.scope_id),status:e.status,hasConflict:Boolean(mm&&mm.membership_type!=="external")
    };
  })});
}
async function create(req,res,sb,ctx,user){
  const body=await readJson(req);
  const name=clean(body?.name,120),email=clean(body?.email,254).toLowerCase();
  if(!name||!EMAIL.test(email)||body?.confirm!==true)
    return fail(res,400,"invalid_body","氏名・メールアドレス・確認チェックが必要です。");
  if(!["業務委託","アルバイト"].includes(body?.employmentType))
    return fail(res,400,"invalid_employment_type","業務委託またはアルバイトを選択してください。");
  const exists=await sb.from(EMPLOYEES).select("id").eq("tenant_id",ctx.tenantId)
    .ilike("email",email).limit(1);
  if(exists.error)return dbError(res,exists.error);
  if(exists.data?.length)return fail(res,409,"already_registered",
    "同じメールのメンバーが登録されています。既存メンバーのアカウントを確認してください。");
  // 新規アカウントはその他業務アプリへ権限を与えない。
  const password=randomPassword(12);
  const made=await sb.auth.admin.createUser({
    email,password,email_confirm:true,
    app_metadata:{apps:["partner_sales"]}, // route marker only; actual access is checked in DB
    user_metadata:{name}
  });
  if(made.error||!UUID.test(made.data?.user?.id||"")){
    return fail(res,409,"account_create_failed",
      "ログイン作成に失敗しました。同じメールの既存アカウントがある場合は管理者へご相談ください。");
  }
  const userId=made.data.user.id;
  const row=await sb.from(EMPLOYEES).insert({
    tenant_id:ctx.tenantId,user_id:userId,display_name:name,email,
    department:DEPT,employment_type:body.employmentType,status:"active"
  }).select("id").single();
  if(row.error){
    // 新規作成したAuthだけを削除。既存アカウントには絶対に触らない。
    await sb.auth.admin.deleteUser(userId).catch(()=>{});
    return dbError(res,row.error);
  }
  // 初期状態ではENGERへの権限を付けない。契約確認後に担当企業を明示登録。
  const membership=await sb.schema("enger").from("organization_memberships").insert({
    user_id:userId,membership_type:"external",role:"member",status:"inactive"
  }).select("id").single();
  if(membership.error){
    // 社員記録は残すがENGER認可は無い。手動で管理者が確認できるようにする。
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"enger.agent_create_partial",
      target:"employee:"+row.data.id,detail:{reason:"membership_failed"}});
    return fail(res,503,"membership_setup_incomplete",
      "ログインは作成しましたが、ENGERの利用設定を完了できませんでした。管理者にご連絡ください。");
  }
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"enger.agent_create",
    target:"employee:"+row.data.id,detail:{employmentType:body.employmentType,enabled:false}});
  return json(res,200,{ok:true,employeeId:row.data.id,enabled:false,
    // メモ・DB・監査ログには保存しない。表示は今回の応答で一回限り。
    initialPassword:password,loginUrl:"https://enger.jp/business/login",
    note:"初回パスワードはこの画面で一度だけ表示されます。ENGER権限は未設定です。"});
}
async function change(req,res,sb,ctx,user){
  const body=await readJson(req);
  if(body?.action==="update_name"){
    const employeeId=body?.employeeId,displayName=clean(body?.displayName,120);
    if(!UUID.test(employeeId||"")||!displayName||/[\u0000-\u001f]/.test(displayName))
      return fail(res,400,"invalid_body","対象と氏名を確認してください。");
    const emp=await requireEmployee(sb,ctx.tenantId,employeeId);
    if(!emp||emp.department!==DEPT||!UUID.test(emp.user_id||""))
      return fail(res,404,"agent_not_found","対象のエージェントを確認できません。");
    const change=await sb.from(EMPLOYEES).update({display_name:displayName})
      .eq("tenant_id",ctx.tenantId).eq("id",employeeId);
    if(change.error)return dbError(res,change.error);
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,
      action:"enger.agent_profile_update",target:"employee:"+employeeId,
      detail:{field:"display_name"}});
    return json(res,200,{ok:true,employeeId,displayName});
  }
  const employeeId=body?.employeeId,enable=body?.enabled,ids=body?.companyIds;
  const displayName=clean(body?.displayName,120);
  if(!UUID.test(employeeId||"")||typeof enable!=="boolean"||!validCompanies(ids)||
     !displayName||/[\u0000-\u001f]/.test(displayName))
    return fail(res,400,"invalid_request","対象・氏名・状態・担当企業の指定を確認してください。");
  if(enable&&(!ids.length||body?.contractConfirmed!==true||body?.ndaConfirmed!==true))
    return fail(res,400,"contract_required",
      "ENGER利用開始には担当企業の割当と契約書・秘密保持の確認が必要です。");
  let emp,member,dir;
  try{
    emp=await requireEmployee(sb,ctx.tenantId,employeeId);
    if(!emp||emp.department!==DEPT||!UUID.test(emp.user_id||"")||
      !["業務委託","アルバイト"].includes(emp.employment_type))
      return fail(res,404,"agent_not_found","対象のエージェントを確認できません。");
    // Disabling access must remain possible after departure or an NG-company change.
    if(enable&&(emp.status!=="active"||emp.left_on))
      return fail(res,409,"inactive_employee","在籍状態を確認してから操作してください。");
    member=await membershipFor(sb,emp.user_id);
    // Repair only an agent account created by this manager that stopped after
    // Auth/employee insertion; never alter an existing internal/other-org user.
    if(!member){
      const created=await sb.schema("enger").from("organization_memberships").insert({
        user_id:emp.user_id,membership_type:"external",role:"member",status:"inactive"
      }).select("id,user_id,membership_type,role,status,organization_id,partner_organization_id").single();
      if(created.error)return dbError(res,created.error);
      member=created.data;
    }
    if(member.membership_type!=="external"||
      member.organization_id||member.partner_organization_id||member.role!=="member")
      return fail(res,409,"membership_conflict","既存の他事業・社内権限とは統合できません。管理者へ確認してください。");
    // A stopped account must not retain stale companies, and revocation must
    // succeed even if a company became hidden/blocked after the last grant.
    if(enable){
      dir=await safeDirectory(sb,ctx.tenantId,ids);
      if(dir===null)return fail(res,409,"company_not_assignable",
        "担当企業の一部が存在しないか、連絡注意・非表示です。");
    }
  }catch(e){return dbError(res,e);}
  const updatedEmployee=await sb.from(EMPLOYEES)
    .update({display_name:displayName})
    .eq("tenant_id",ctx.tenantId).eq("id",employeeId);
  if(updatedEmployee.error)return dbError(res,updatedEmployee.error);
  const mem=sb.schema("enger").from("member_product_access");
  // 先にアクセスを止め、割当の再構築中に古い企業を閲覧させない。
  const disable=await mem.upsert({
    membership_id:member.id,product:"partner_sales",
    can_view:false,can_create:false,can_edit:false,can_approve:false,can_export:false,can_manage:false
  },{onConflict:"membership_id,product"});
  if(disable.error)return dbError(res,disable.error);
  const scope=sb.schema("enger").from("member_data_scope");
  // 企業別スコープだけ変更し、他サービスで使うデータ範囲には触れない。
  const deleted=await scope.delete().eq("membership_id",member.id).eq("scope_type","company");
  if(deleted.error)return dbError(res,deleted.error);
  const assignedCompanyIds=enable?ids:[];
  if(assignedCompanyIds.length){
    const inserted=await sb.schema("enger").from("member_data_scope").insert(
      assignedCompanyIds.map(id=>({membership_id:member.id,scope_type:"company",scope_id:id}))
    );
    if(inserted.error)return dbError(res,inserted.error);
  }
  const status=await sb.schema("enger").from("organization_memberships")
    .update({status:enable?"active":"inactive"}).eq("id",member.id).eq("user_id",emp.user_id);
  if(status.error)return dbError(res,status.error);
  if(enable){
    const activated=await sb.schema("enger").from("member_product_access")
      .update({can_view:true})
      .eq("membership_id",member.id).eq("product","partner_sales");
    if(activated.error)return dbError(res,activated.error);
  }
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,
    action:enable?"enger.agent_activate":"enger.agent_disable",
    target:"employee:"+employeeId,
    detail:{companyCount:assignedCompanyIds.length,contractConfirmed:enable,ndaConfirmed:enable,nameUpdated:true}});
  return json(res,200,{ok:true,employeeId,enabled:enable,companyIds:assignedCompanyIds});
}
export default async function handler(req,res){
  res.setHeader("Cache-Control","private, no-store");
  if(!["GET","POST","PATCH"].includes(req.method))
    return methodNotAllowed(res,["GET","POST","PATCH"]);
  const user=await requireUser(req,res);if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canManageHr(ctx))
    return fail(res,403,"forbidden","人事・管理者の権限が必要です。");
  if(!(await requireMfa(req,res,ctx,user)))return;
  const sb=admin();
  try{
    if(req.method==="GET")return await list(req,res,sb,ctx);
    if(req.method==="POST")return await create(req,res,sb,ctx,user);
    return await change(req,res,sb,ctx,user);
  }catch(e){return dbError(res,e);}
}
