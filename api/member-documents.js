// Office / KEIEI members: access-controlled document list, file preview and uploads.
import crypto from "node:crypto";
import { json, readJson, methodNotAllowed } from "../lib/http.js";
import { requireUser } from "../lib/auth.js";
import { gwContext, canOfficeHr, canKeiei, canSeeSalary } from "../lib/gw.js";
import { admin } from "../lib/supabase.js";
import { gwLog } from "../lib/gw-audit.js";
import { checkDocBytes, cleanFilename } from "../lib/hr-docs.js";
import { MEMBER_DOC_TYPES, memberDocType, MEMBER_DOC_MAX_BYTES, MEMBER_DOC_MIMES, forbiddenMemberFilename } from "../lib/member-documents.js";
import { readMemberDocumentRegister } from "../lib/member-documents-read.js";
import { DISPLAY_STATES } from "../lib/member-document-display.js";
import { readTemplateCatalog,validTemplateKey,linkedKind,ruleFor } from "../lib/member-template-catalog.js";
import { requireMfa } from "../lib/mfa.js";

const BUCKET="hr", TTL=300;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTS={"application/pdf":"pdf","image/jpeg":"jpg","image/png":"png"};
const fail=(res,code,error,hint)=>json(res,code,{error,hint});
const validId=(s)=>typeof s==="string"&&UUID.test(s);

export default async function handler(req,res){
  const user=await requireUser(req,res);
  if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!(canOfficeHr(ctx)||canKeiei(ctx)))
    return fail(res,403,"forbidden","Office人事・経営者だけが書類台帳を利用できます");
  if(!(await requireMfa(req,res,ctx,user)))return;
  try{
    if(req.method==="GET")return await read(req,res,ctx,user);
    if(req.method==="POST")return await change(req,res,ctx,user);
    return methodNotAllowed(res,["GET","POST"]);
  }catch(e){
    console.error("[member-documents]",e?.message||e);
    return fail(res,500,"member_documents_failed","書類を取得できませんでした。Office担当者に連絡してください");
  }
}

async function read(req,res,ctx,user){
  const q=new URL(req.url,"http://localhost").searchParams;
  const summary=q.get("summary")==="1", employeeId=q.get("employeeId");
  if(!summary&&q.get("templates")!=="1"&&q.get("template")!=="1"&&!validId(employeeId))
    return fail(res,400,"invalid_query","社員IDが正しくありません");
  const sb=admin();
  if(q.get("template")==="1")return await resolveTemplate(req,res,ctx,user,q,sb);
  if(q.get("templates")==="1"){
    const catalog=await readTemplateCatalog(sb,ctx.tenantId);
    return json(res,200,{choices:catalog.choices});
  }
  const [register,catalog]=await Promise.all([
    readMemberDocumentRegister(sb,ctx.tenantId,{employeeId:summary?null:employeeId}),
    readTemplateCatalog(sb,ctx.tenantId),
  ]);
  if(register.error)return fail(res,404,"not_found","メンバーが見つかりません");
  const linkedLifecycle=life=>({
    ...life,
    buttons:(life?.buttons||[]).map(button=>({...button,template:catalog.resolve(button.key)})),
  });
  if(summary)return json(res,200,{uploadReady:register.uploadReady,displayReady:register.displayReady,
    members:register.employees.map(e=>{
      const entry=register.byEmployee.get(e.id);
      return {...entry.summary,overview:documentOverview(entry,canSeeSalary(ctx)),
        lifecycle:publicLifecycle(linkedLifecycle(entry.lifecycle),canSeeSalary(ctx))};
    })});
  const entry=register.byEmployee.get(employeeId);
  if(!entry)return fail(res,404,"not_found","メンバーが見つかりません");
  if(q.get("file")==="1"){
    const d=entry.documents.find(x=>x.source===q.get("source")&&x.id===q.get("docId")&&x.storagePath);
    if(!d)return fail(res,404,"not_found","書類が見つかりません");
    if(d.salary&&!canSeeSalary(ctx))return fail(res,403,"salary_forbidden","給与・報酬の書類を閲覧する権限がありません");
    const download=q.get("download")==="1";
    const {data,error}=await admin().storage.from(BUCKET)
      .createSignedUrl(d.storagePath,TTL,download?{download:d.filename}:undefined);
    if(error||!data?.signedUrl)return fail(res,404,"file_missing","ファイルを開けません。原本の保存状態を確認してください");
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,
      action:download?"member_document.download":"member_document.view",
      target:"employee:"+employeeId,detail:{source:d.source,documentId:d.id}});
    return json(res,200,{url:data.signedUrl,filename:d.filename,expiresIn:TTL});
  }
  return json(res,200,{
    employee:entry.employee,summary:entry.summary,uploadReady:register.uploadReady,
    lifecycle:publicLifecycle(linkedLifecycle(entry.lifecycle),canSeeSalary(ctx)),
    types:MEMBER_DOC_TYPES,
    documents:entry.documents.filter(d=>!d.salary||canSeeSalary(ctx)).map(d=>({
      id:d.id,source:d.source,kind:d.kind,title:d.title,filename:d.filename,
      status:d.status,createdAt:d.createdAt,signed:d.signed,verified:d.verified,
      group:d.group,hasFile:!!d.storagePath,
    })),
    contracts:entry.contracts.map(c=>({id:c.id,status:c.status,
      contractType:c.contract_type,periodFrom:c.period_from||null,periodTo:c.period_to||null,
      hasFile:!!c.file_path,confirmed:!!c.confirmed_at})),
  });
}

async function member(sb,ctx,id){
  const {data,error}=await sb.from("gw_employees").select("id").eq("id",id)
    .eq("tenant_id",ctx.tenantId).maybeSingle();
  if(error)throw error;
  return data;
}
function uploadArgs(body,ctx,res){
  const type=memberDocType(body?.docKind);
  if(!type||["offer_letter","accepted_offer"].includes(body.docKind)||String(body.docKind).startsWith("retire_"))
    return {response:fail(res,400,"invalid_type","内定・退職の正式書類はそれぞれの専用手続きから登録してください")};
  if(type.salary&&!canSeeSalary(ctx))
    return {response:fail(res,403,"salary_forbidden","契約書は給与閲覧権限を持つ担当者が登録してください")};
  if(forbiddenMemberFilename(body.filename))
    return {response:fail(res,400,"sensitive_document","マイナンバー等の機微情報はこの画面に登録できません")};
  if(!MEMBER_DOC_MIMES.includes(body.mimeType))
    return {response:fail(res,400,"unsupported_file","PDF・JPG・PNG形式だけ登録できます")};
  const size=Number(body.sizeBytes);
  if(!Number.isInteger(size)||size<1||size>MEMBER_DOC_MAX_BYTES)
    return {response:fail(res,400,"file_size","10MB以下のファイルを選んでください")};
  return {type,size};
}

async function change(req,res,ctx,user){
  const body=await readJson(req);
  const id=body?.employeeId;
  if(!validId(id))return fail(res,400,"invalid_body","対象メンバーを選んでください");
  const sb=admin();
  if(!(await member(sb,ctx,id)))return fail(res,404,"not_found","メンバーが見つかりません");
  if(body.action==="templateLink" || body.action==="templateUnlink")
    return changeTemplateLink(res,sb,ctx,user,id,body);
  if(body.action==="display")return changeDisplayState(res,sb,ctx,user,id,body);
  if(body.action==="verify")return verify(res,sb,ctx,user,id,body);
  if(!["prepare","attach"].includes(body.action))return fail(res,400,"invalid_action","操作が正しくありません");
  const checked=uploadArgs(body,ctx,res);
  if(checked.response)return checked.response;
  if(body.action==="prepare"){
    const path=ctx.tenantId+"/members/"+id+"/"+crypto.randomUUID()+"."+EXTS[body.mimeType];
    const {data,error}=await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if(error||!data?.signedUrl)return fail(res,500,"sign_failed","アップロード先を準備できません");
    return json(res,200,{path,uploadUrl:data.signedUrl,token:data.token});
  }
  const path=String(body.path||"");
  const prefix=ctx.tenantId+"/members/"+id+"/";
  const remainder=path.startsWith(prefix)?path.slice(prefix.length):"";
  if(!/^[0-9a-f-]{36}\.(pdf|jpg|png)$/i.test(remainder))
    return fail(res,403,"invalid_path","対象メンバーの保存場所が正しくありません");
  const {data:file,error:readErr}=await sb.storage.from(BUCKET).download(path);
  if(readErr||!file)return fail(res,400,"file_missing","アップロードしたファイルが見つかりません");
  const bytes=Buffer.from(await file.arrayBuffer());
  const actual=checkDocBytes(bytes);
  if(!actual.ok||actual.mime!==body.mimeType||bytes.length!==checked.size)
    return fail(res,400,"file_mismatch","ファイルの種類・サイズが一致しません");
  const {data,error}=await sb.from("gw_member_documents").insert({
    tenant_id:ctx.tenantId,employee_id:id,doc_kind:checked.type.key,
    filename:cleanFilename(body.filename),storage_path:path,mime_type:actual.mime,
    size_bytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex"),
    status:"received",uploaded_by:user.id,
  }).select("id").single();
  if(error){
    if(/PGRST205|42P01|does not exist|schema cache/i.test(error.code+" "+error.message))
      return fail(res,503,"not_ready","db/163_member_document_register.sql が未適用です");
    if(error.code==="23505")return fail(res,409,"already_uploaded","ファイルは登録済みです");
    throw error;
  }
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"member_document.upload",
    target:"employee:"+id,detail:{documentId:data.id,kind:checked.type.key}});
  return json(res,200,{ok:true,documentId:data.id});
}
async function verify(res,sb,ctx,user,id,body){
  if(!validId(body.documentId))return fail(res,400,"invalid_body","書類を選んでください");
  const {data:d,error:e}=await sb.from("gw_member_documents")
    .select("id,status,doc_kind").eq("id",body.documentId).eq("employee_id",id)
    .eq("tenant_id",ctx.tenantId).is("deleted_at",null).maybeSingle();
  if(e)throw e;
  if(!d)return fail(res,404,"not_found","書類が見つかりません");
  if(memberDocType(d.doc_kind)?.salary&&!canSeeSalary(ctx))
    return fail(res,403,"salary_forbidden","書類を確認する権限がありません");
  if(d.status==="verified")return json(res,200,{ok:true,already:true});
  const {data:updated,error}=await sb.from("gw_member_documents")
    .update({status:"verified",verified_by:user.id,verified_at:new Date().toISOString()})
    .eq("id",d.id).eq("employee_id",id).eq("tenant_id",ctx.tenantId)
    .eq("status","received").select("id").maybeSingle();
  if(error)throw error;
  if(!updated)return fail(res,409,"conflict","別の担当者が更新しました。再読み込みしてください");
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"member_document.verify",
    target:"employee:"+id,detail:{documentId:d.id,kind:d.doc_kind}});
  return json(res,200,{ok:true});
}


// A single authorized summary request supplies preview pointers for the rows.
// Storage paths, salary terms and signed URLs never reach the summary response.
export function documentOverview(entry, salaryAllowed=false) {
  const docs=(entry.documents||[]).filter(d=>Boolean(d.storagePath));
  const best=kinds=>docs.filter(d=>kinds.includes(d.kind)).sort((a,b)=>
    Number(Boolean(b.signed))-Number(Boolean(a.signed)) ||
    String(b.createdAt||"").localeCompare(String(a.createdAt||"")))[0]||null;
  const cell=kinds=>{
    const d=best(kinds);
    if(!d)return {status:"台帳未登録",hasFile:false,preview:null};
    const restricted=Boolean(d.salary&&!salaryAllowed);
    return {
      status:restricted?"登録済（閲覧権限が必要）":d.signed?"電子署名済":d.verified?"確認済":d.status||"登録済",
      hasFile:true,restricted,
      preview:restricted?null:{source:d.source,id:d.id,title:d.title||"",filename:d.filename||""},
    };
  };
  const submitted=docs.filter(d=>d.group==="submitted"
    && (d.source==="procedure"||d.source==="manual")
    && !["resume","work_history","skill_sheet"].includes(d.kind))
    .sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  const pending=submitted.filter(d=>!d.verified).length;
  const first=submitted[0];
  const terms=(entry.contracts||[]).slice().sort((a,b)=>
    Number(b.status==="active")-Number(a.status==="active") ||
    String(b.created_at||"").localeCompare(String(a.created_at||"")))[0]||null;
  return {
    terms:terms?{contractType:terms.contract_type||null,periodFrom:terms.period_from||null,
      periodTo:terms.period_to||null,status:terms.status||null}:null,
    contract:cell(["employment_contract","service_contract"]),
    offer:cell(["offer_letter"]),
    acceptance:cell(["accepted_offer"]),
    notice:cell(["labor_notice"]),
    resume:cell(["resume"]),
    workHistory:cell(["work_history"]),
    submitted:{
      status:submitted.length?"受領 "+submitted.length+"件"+(pending?"／確認待ち "+pending+"件":""):"台帳未登録",
      count:submitted.length,hasFile:submitted.length>0,
      preview:first?{source:first.source,id:first.id,title:first.title||"",filename:first.filename||""}:null,
    },
  };
}


// Do not leak sensitive file titles or preview identifiers in row summaries.
export function publicLifecycle(lifecycle, salaryAllowed) {
  return {
    phases:lifecycle?.phases||[],
    buttons:(lifecycle?.buttons||[]).map(button=>{
      const restricted=Boolean(memberDocType(button.uploadKind||button.key)?.salary&&!salaryAllowed);
      return {...button,restricted,latestFile:restricted?null:button.latestFile,
        uploadKind:restricted?null:button.uploadKind};
    }),
  };
}


// Display-only classification: mutually exclusive working / inactive / hidden.
// Never modify gw_employees.status or account/timecard authorization.
async function changeDisplayState(res,sb,ctx,user,employeeId,body){
  const state=String(body?.displayState||"");
  if(!DISPLAY_STATES.includes(state))
    return fail(res,400,"invalid_display_state","稼働・非稼働・非表示から選んでください");
  const {data,error}=await sb.from("gw_member_document_display")
    .upsert({
      tenant_id:ctx.tenantId,employee_id:employeeId,display_state:state,
      updated_by:user.id,updated_at:new Date().toISOString(),
    },{onConflict:"tenant_id,employee_id"})
    .select("employee_id,display_state").single();
  if(error){
    if(/PGRST205|42P01|does not exist|schema cache|not found/i.test(error.code+" "+error.message))
      return fail(res,503,"not_ready","表示区分のDB設定が未完了です（db/164_member_document_display.sql）");
    throw error;
  }
  await gwLog({
    tenantId:ctx.tenantId,actorId:user.id,action:"member_document.display",
    target:"employee:"+employeeId,detail:{displayState:state},
  });
  return json(res,200,{ok:true,employeeId:data.employee_id,displayState:data.display_state});
}


// A template master is separate from a person's submitted/signed file.
async function resolveTemplate(req,res,ctx,user,q,sb) {
  const key=q.get("docKey");
  if(!validTemplateKey(key))return fail(res,400,"invalid_doc_key","書類が正しくありません");
  const catalog=await readTemplateCatalog(sb,ctx.tenantId);
  const template=catalog.resolve(key);
  if(template.source==="general"){
    const {data,error}=await sb.from("gw_doc_templates")
      .select("id,name,body,note").eq("id",template.id)
      .eq("tenant_id",ctx.tenantId).maybeSingle();
    if(error||!data)return fail(res,404,"template_not_found","雛形を開けません");
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,
      action:"member_document.template_view",target:"template:"+data.id,detail:{docKey:key,source:"general"}});
    return json(res,200,{...template,body:data.body});
  }
  if(template.source==="library"){
    const doc=catalog.records.library.get(template.id);
    if(!doc)return fail(res,404,"template_not_found","社内文書が見つかりません");
    const out={...template,shareUrl:doc.published?"/doc.html?id="+encodeURIComponent(doc.id):null};
    if(doc.link_url){
      const u=String(doc.link_url);
      if(!/^https:\/\//i.test(u))return fail(res,400,"unsafe_url","登録されたリンクが安全ではありません");
      out.url=u;
    }else if(doc.file_path){
      const path=String(doc.file_path);
      if(!path.startsWith(ctx.tenantId+"/"))return fail(res,403,"path_forbidden","社内文書の保存先が正しくありません");
      const {data,error}=await sb.storage.from("library").createSignedUrl(path,600);
      if(error||!data?.signedUrl)return fail(res,404,"file_unavailable","雛形ファイルを取得できません");
      out.url=data.signedUrl;
    }
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,
      action:"member_document.template_view",target:"template:"+doc.id,detail:{docKey:key,source:"library"}});
    return json(res,200,out);
  }
  if(template.source==="sign"){
    return json(res,200,{...template,
      url:"/admin-esign.html?tab=send&employeeId="+encodeURIComponent(q.get("employeeId")||"")+
        "&templateId="+encodeURIComponent(template.id),
      note:"電子契約の雛形です。対象者・条件を確認してから署名依頼してください。"});
  }
  if(template.source==="official"||template.source==="workflow"){
    const rule=ruleFor(key);
    return json(res,200,{...template,note:rule.note||null});
  }
  return json(res,200,{...template,note:ruleFor(key).note||"社内文書で雛形を作成・紐づけしてください。"});
}

async function changeTemplateLink(res,sb,ctx,user,employeeId,body) {
  const key=String(body.docKey||"");
  if(!validTemplateKey(key))return fail(res,400,"invalid_doc_key","書類の種類を選んでください");
  if(body.action==="templateUnlink"){
    const {error}=await sb.from("gw_member_doc_template_links").delete()
      .eq("tenant_id",ctx.tenantId).eq("doc_key",key);
    if(error)throw error;
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"member_document.template_unlink",
      target:"member_doc_template:"+key,detail:{employeeId}});
    return json(res,200,{ok:true,docKey:key});
  }
  const kind=linkedKind(body.sourceKind),id=String(body.sourceId||"");
  if(!kind||!validId(id))return fail(res,400,"invalid_template","紐づける社内文書・雛形を選んでください");
  const table=kind==="library"?"gw_library":kind==="general"?"gw_doc_templates":"gw_sign_templates";
  const {data,error}=await sb.from(table).select("id").eq("tenant_id",ctx.tenantId)
    .eq("id",id).maybeSingle();
  if(error)throw error;
  if(!data)return fail(res,404,"template_not_found","紐づける雛形が見つかりません");
  const {error:upErr}=await sb.from("gw_member_doc_template_links").upsert({
    tenant_id:ctx.tenantId,doc_key:key,source_kind:kind,source_id:id,
    updated_by:user.id,updated_at:new Date().toISOString(),
  },{onConflict:"tenant_id,doc_key"});
  if(upErr)throw upErr;
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"member_document.template_link",
    target:"member_doc_template:"+key,detail:{source:kind,sourceId:id,employeeId}});
  return json(res,200,{ok:true,docKey:key,source:kind,id});
}
