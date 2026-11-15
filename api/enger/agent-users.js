// ENGER営業エージェントの「役割」と担当企業をグループウェアのメンバー管理から設定する。
//
// ■ 1人1アカウント
//   本人のログインは gw_employees.user_id（Supabase Auth）ただ1つ。既存メンバーへ役割を
//   付けるときは Auth を新しく作らない（action:"grant_role"）。名簿にいない人だけ、
//   名簿＋Auth を一緒に作る（POST）。パスワードの再発行は名簿共通の
//   /api/employees/account（GW・無限道場・タイムカード共通）を使い、ここでは扱わない。
//
// ■ 役割は雇用区分・部署と独立
//   正本は enger.organization_memberships / member_product_access(product='partner_sales') /
//   member_data_scope(scope_type='company')。判定は lib/enger-agent-role.js。
//   department='ENGERエージェント'（PR #363 の仮識別）は、旧方式の人を一覧に拾うためだけに読む。
//
// ■ 社内Sales（GWの /sales）や企業business権限、その他アプリ権限は付与しない。
//   「ENGER社内営業」は GW のアプリ利用権限 sales（gw_app_grants）で付与する。
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canManageHr} from "../../lib/gw.js";
import {requireMfa} from "../../lib/mfa.js";
import {admin} from "../../lib/supabase.js";
import {randomPassword} from "../../lib/accounts.js";
import {gwLog} from "../../lib/gw-audit.js";
import {
  AGENT_PRODUCT,LEGACY_AGENT_DEPARTMENT,MEMBERSHIP_COLUMNS,CLOSED_ACCESS,
  isAgentMembership,membershipFor,loadAgentRoles,isEngerInternalUser
} from "../../lib/enger-agent-role.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPLOYEES="gw_employees";
const MAX_COMPANIES=20;
// 雇用区分は役割と独立。DBのCHECK（db/005）にある値のうち、役員以外を受け付ける。
const AGENT_EMPLOYMENT_TYPES=["正社員","契約社員","パート","アルバイト","業務委託","その他"];
// ENGER側にエージェント用ホームがまだ無い（enger.jp/business/login は partner_sales を拒否する）。
// 「ログインできます」と案内しないため、URLは返さない。
const LOGIN_STATUS="ENGERのエージェント用ホームは未公開です。役割と担当企業の設定までを行えます。";
const fail=(res,status,error,hint)=>json(res,status,{error,hint});
const clean=(v,max)=>typeof v==="string"?v.trim().slice(0,max):"";
const validCompanies=x=>Array.isArray(x)&&x.length<=MAX_COMPANIES&&
  x.every(v=>typeof v==="string"&&UUID.test(v))&&new Set(x).size===x.length;
const dbError=(res)=>fail(res,503,"agent_data_unavailable",
  "ENGERの権限・企業情報を確認できません。操作は完了していません。");

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
/** その人がGW形式のエージェント役割を持っているか（所属＋partner_sales の行） */
async function agentRoleOf(sb,userId){
  const member=await membershipFor(sb,userId);
  if(!isAgentMembership(member))return {member,role:false};
  const a=await sb.schema("enger").from("member_product_access")
    .select("membership_id").eq("membership_id",member.id).eq("product",AGENT_PRODUCT).limit(1);
  if(a.error)throw a.error;
  return {member,role:Boolean(a.data?.length)};
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
    if(c.error)return dbError(res);
    return json(res,200,{companies:c.data||[]});
  }
  // テナントの名簿（ログインのある人）から、役割の正本で絞る。
  const e=await sb.from(EMPLOYEES)
    .select("id,user_id,display_name,email,department,employment_type,status,left_on")
    .eq("tenant_id",ctx.tenantId).not("user_id","is",null)
    .order("created_at",{ascending:false}).limit(500);
  if(e.error)return dbError(res);
  const employees=e.data||[];
  const roles=await loadAgentRoles(sb,employees.map(x=>x.user_id));
  const agents=employees.filter(x=>roles.get(x.user_id)?.role||x.department===LEGACY_AGENT_DEPARTMENT);
  const currentCompanyIds=[...new Set(agents.flatMap(x=>roles.get(x.user_id)?.companyIds||[])
    .filter(id=>UUID.test(id||"")))].slice(0,250);
  let companyNames={};
  if(currentCompanyIds.length){
    const directory=await sb.schema("enger").from("dx2_sales_company_directory_for_tenant")
      .select("id,name").eq("tenant_id",ctx.tenantId)
      .in("id",currentCompanyIds).limit(250);
    if(directory.error)return dbError(res);
    companyNames=Object.fromEntries((directory.data||[]).map(d=>[d.id,d.name]));
  }
  return json(res,200,{canManage:true,companyNames,loginStatus:LOGIN_STATUS,agents:agents.map(x=>{
    const r=roles.get(x.user_id);
    return {
      employeeId:x.id,name:x.display_name,email:x.email,
      employmentType:x.employment_type,hasLogin:Boolean(x.user_id),
      roleAssigned:Boolean(r?.role),
      // 旧方式（部署名だけで役割を表していた）で、まだ正本に役割が無い人
      legacyOnly:!r?.role&&x.department===LEGACY_AGENT_DEPARTMENT,
      enabled:Boolean(r?.role)&&x.status==="active"&&!x.left_on&&
        r.membership.status==="active"&&r.access?.can_view===true,
      // 担当企業は、このテナントの企業名簿で確認できたものだけ返す（他テナントのIDを出さない）
      companyIds:(r?.companyIds||[]).filter(id=>Object.prototype.hasOwnProperty.call(companyNames,id)),
      status:x.status,hasConflict:Boolean(r?.conflict)
    };
  })});
}

/** 名簿にいない人だけ：名簿＋Auth を作り、役割を「付与・停止中」で付ける */
async function create(req,res,sb,ctx,user){
  const body=await readJson(req);
  const name=clean(body?.name,120),email=clean(body?.email,254).toLowerCase();
  const department=clean(body?.department,80)||null;
  if(!name||!EMAIL.test(email)||body?.confirm!==true)
    return fail(res,400,"invalid_body","氏名・メールアドレス・確認チェックが必要です。");
  if(!AGENT_EMPLOYMENT_TYPES.includes(body?.employmentType))
    return fail(res,400,"invalid_employment_type","雇用・契約区分をHR/Officeの契約と同じ値で選択してください。");
  if(department===LEGACY_AGENT_DEPARTMENT)
    return fail(res,400,"invalid_department","部署には実際の所属部署を入力してください。役割は部署で表しません。");
  const exists=await sb.from(EMPLOYEES).select("id").eq("tenant_id",ctx.tenantId)
    .ilike("email",email).limit(1);
  if(exists.error)return dbError(res);
  if(exists.data?.length)return fail(res,409,"already_registered",
    "このメールのメンバーは登録済みです。新しいログインは作らず、メンバー詳細の「ENGER営業の役割」から役割を付与してください。");
  try{
    if(await isEngerInternalUser(sb,email))return fail(res,409,"enger_internal_user",
      "このメールはENGERの社内メンバーとして登録済みです。外部エージェントとしては登録できません。");
  }catch{return dbError(res);}
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
    department,employment_type:body.employmentType,status:"active"
  }).select("id").single();
  if(row.error){
    // 新規作成したAuthだけを削除。既存アカウントには絶対に触らない。
    await sb.auth.admin.deleteUser(userId).catch(()=>{});
    return dbError(res);
  }
  const granted=await grantRole(sb,userId);
  if(!granted.ok){
    // 名簿とログインは残す（重複発行しない）。管理者は詳細の「役割を付与」で再実行できる。
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"enger.agent_create_partial",
      target:"employee:"+row.data.id,detail:{reason:granted.error}});
    return json(res,200,{ok:true,partial:true,employeeId:row.data.id,enabled:false,
      initialPassword:password,
      note:"名簿とログインは作成しましたが、ENGER営業の役割を付与できませんでした。メンバー詳細から役割の付与をやり直してください。"});
  }
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"enger.agent_create",
    target:"employee:"+row.data.id,detail:{employmentType:body.employmentType,enabled:false}});
  return json(res,200,{ok:true,employeeId:row.data.id,enabled:false,
    // メモ・DB・監査ログには保存しない。表示は今回の応答で一回限り。
    initialPassword:password,loginStatus:LOGIN_STATUS,
    note:"初回パスワードはこの画面で一度だけ表示されます。ENGERの企業閲覧は未設定（停止中）です。"});
}

/** 所属が無ければ外部所属（停止中）を作り、partner_sales を全部OFFで付ける。冪等。 */
async function grantRole(sb,userId){
  let member;
  try{member=await membershipFor(sb,userId);}catch{return {ok:false,error:"membership_read_failed"};}
  if(member&&!isAgentMembership(member))return {ok:false,error:"membership_conflict"};
  if(!member){
    const created=await sb.schema("enger").from("organization_memberships").insert({
      user_id:userId,membership_type:"external",role:"member",status:"inactive"
    }).select(MEMBERSHIP_COLUMNS).single();
    if(created.error)return {ok:false,error:"membership_insert_failed"};
    member=created.data;
  }
  // 既に行があれば何も変えない（有効化済みの人を付け直しで止めたり開いたりしない）
  const access=await sb.schema("enger").from("member_product_access").upsert({
    membership_id:member.id,product:AGENT_PRODUCT,...CLOSED_ACCESS
  },{onConflict:"membership_id,product",ignoreDuplicates:true});
  if(access.error)return {ok:false,error:"access_insert_failed"};
  return {ok:true,member};
}

async function grantExisting(res,sb,ctx,user,body){
  const employeeId=body?.employeeId;
  if(!UUID.test(employeeId||"")||body?.confirm!==true)
    return fail(res,400,"invalid_request","対象者と役割付与の確認が必要です。");
  let emp;
  try{emp=await requireEmployee(sb,ctx.tenantId,employeeId);}catch{return dbError(res);}
  if(!emp)return fail(res,404,"employee_not_found","対象のメンバーを確認できません。");
  if(!UUID.test(emp.user_id||""))return fail(res,409,"login_required",
    "このメンバーにはログインがありません。先に「ログイン・パスワード」でログインを作成してください。");
  if(emp.status!=="active"||emp.left_on)
    return fail(res,409,"inactive_employee","在籍中のメンバーにだけ役割を付与できます。");
  if(emp.employment_type==="役員")
    return fail(res,409,"officer_excluded","役員にはエージェント役割を付与しません。社内営業はSalesの利用権限で設定してください。");
  try{
    if(await isEngerInternalUser(sb,emp.email))return fail(res,409,"enger_internal_user",
      "このメンバーはENGERの社内メンバーです。社内営業として扱い、外部エージェントの役割は付けません。");
  }catch{return dbError(res);}
  const granted=await grantRole(sb,emp.user_id);
  if(!granted.ok){
    if(granted.error==="membership_conflict")return fail(res,409,"membership_conflict",
      "ENGERに別の所属（社内・取引先など）があるため、エージェント役割は付与できません。");
    return dbError(res);
  }
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"enger.agent_role_grant",
    target:"employee:"+employeeId,detail:{employmentType:emp.employment_type,authCreated:false,enabled:false}});
  return json(res,200,{ok:true,employeeId,roleAssigned:true,enabled:false});
}

async function change(req,res,sb,ctx,user){
  const body=await readJson(req);
  if(body?.action==="grant_role")return grantExisting(res,sb,ctx,user,body);
  if(body?.action==="reset_password")
    return fail(res,410,"use_member_account",
      "パスワードはメンバー詳細の「ログイン・パスワード」から再発行してください（GW共通のログインです）。");
  if(body?.action==="update_name"){
    const employeeId=body?.employeeId,displayName=clean(body?.displayName,120);
    if(!UUID.test(employeeId||"")||!displayName||/[\u0000-\u001f]/.test(displayName))
      return fail(res,400,"invalid_body","対象と氏名を確認してください。");
    let emp,role;
    try{
      emp=await requireEmployee(sb,ctx.tenantId,employeeId);
      role=emp&&UUID.test(emp.user_id||"")?await agentRoleOf(sb,emp.user_id):{role:false};
    }catch{return dbError(res);}
    if(!emp||!role.role)return fail(res,404,"agent_not_found","対象のエージェントを確認できません。");
    const changed=await sb.from(EMPLOYEES).update({display_name:displayName})
      .eq("tenant_id",ctx.tenantId).eq("id",employeeId);
    if(changed.error)return dbError(res);
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,
      action:"enger.agent_profile_update",target:"employee:"+employeeId,
      detail:{field:"display_name"}});
    return json(res,200,{ok:true,employeeId,displayName});
  }
  const employeeId=body?.employeeId,enable=body?.enabled,ids=body?.companyIds;
  if(!UUID.test(employeeId||"")||typeof enable!=="boolean"||!validCompanies(ids))
    return fail(res,400,"invalid_request","対象・状態・担当企業の指定を確認してください。");
  if(enable&&(!ids.length||body?.contractConfirmed!==true||body?.ndaConfirmed!==true))
    return fail(res,400,"contract_required",
      "ENGER利用開始には担当企業の割当と契約書・秘密保持の確認が必要です。");
  let emp,member;
  try{
    emp=await requireEmployee(sb,ctx.tenantId,employeeId);
    if(!emp||!UUID.test(emp.user_id||""))
      return fail(res,404,"agent_not_found","対象のエージェントを確認できません。");
    // Disabling access must remain possible after departure or an NG-company change.
    if(enable&&(emp.status!=="active"||emp.left_on))
      return fail(res,409,"inactive_employee","在籍状態を確認してから操作してください。");
    const role=await agentRoleOf(sb,emp.user_id);
    member=role.member;
    if(member&&!isAgentMembership(member))
      return fail(res,409,"membership_conflict","既存の他事業・社内権限とは統合できません。管理者へ確認してください。");
    if(!role.role){
      // 役割の無い人は「停止」なら何もすることが無い。開くことはできない。
      if(!enable)return json(res,200,{ok:true,employeeId,enabled:false,companyIds:[]});
      return fail(res,409,"role_not_assigned","先にENGER営業エージェントの役割を付与してください。");
    }
    if(enable){
      if(await isEngerInternalUser(sb,emp.email))return fail(res,409,"enger_internal_user",
        "ENGERの社内メンバーには外部エージェントの閲覧権限を付けません。");
      const dir=await safeDirectory(sb,ctx.tenantId,ids);
      if(dir===null)return fail(res,409,"company_not_assignable",
        "担当企業の一部が存在しないか、連絡注意・非表示・別テナントです。");
    }
  }catch{return dbError(res);}
  const mem=sb.schema("enger").from("member_product_access");
  // 先にアクセスを止め、割当の再構築中に古い企業を閲覧させない。
  const disable=await mem.update({...CLOSED_ACCESS})
    .eq("membership_id",member.id).eq("product",AGENT_PRODUCT);
  if(disable.error)return dbError(res);
  const scope=sb.schema("enger").from("member_data_scope");
  // 企業別スコープだけ変更し、他サービスで使うデータ範囲には触れない。
  const deleted=await scope.delete().eq("membership_id",member.id).eq("scope_type","company");
  if(deleted.error)return dbError(res);
  const assignedCompanyIds=enable?ids:[];
  if(assignedCompanyIds.length){
    const inserted=await sb.schema("enger").from("member_data_scope").insert(
      assignedCompanyIds.map(id=>({membership_id:member.id,scope_type:"company",scope_id:id}))
    );
    if(inserted.error)return dbError(res);
  }
  const status=await sb.schema("enger").from("organization_memberships")
    .update({status:enable?"active":"inactive"}).eq("id",member.id).eq("user_id",emp.user_id);
  if(status.error)return dbError(res);
  if(enable){
    const activated=await sb.schema("enger").from("member_product_access")
      .update({can_view:true})
      .eq("membership_id",member.id).eq("product",AGENT_PRODUCT);
    if(activated.error)return dbError(res);
  }
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,
    action:enable?"enger.agent_activate":"enger.agent_disable",
    target:"employee:"+employeeId,
    detail:{companyCount:assignedCompanyIds.length,contractConfirmed:enable,ndaConfirmed:enable}});
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
  }catch{return dbError(res);}
}
