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
  if(!summary&&!validId(employeeId))return fail(res,400,"invalid_query","社員IDが正しくありません");
  const register=await readMemberDocumentRegister(admin(),ctx.tenantId,{employeeId:summary?null:employeeId});
  if(register.error)return fail(res,404,"not_found","メンバーが見つかりません");
  if(summary)return json(res,200,{uploadReady:register.uploadReady,
    members:register.employees.map(e=>{
      const entry=register.byEmployee.get(e.id);
      return {...entry.summary,overview:documentOverview(entry,canSeeSalary(ctx))};
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
    types:MEMBER_DOC_TYPES,
    documents:entry.documents.filter(d=>!d.salary||canSeeSalary(ctx)).map(d=>({
      id:d.id,source:d.source,kind:d.kind,title:d.title,filename:d.filename,
      status:d.status,createdAt:d.createdAt,signed:d.signed,verified:d.verified,
      group:d.group,hasFile:!!d.storagePath,
    })),
    contracts:entry.contracts.map(c=>({id:c.id,status:c.status,
      contractType:c.contract_type,periodTo:c.period_to||null,
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
  if(!type||["offer_letter","accepted_offer"].includes(body.docKind))return {response:fail(res,400,"invalid_type","内定通知・条件承諾PDFはHRの正式手続きから登録してください")};
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
  return {
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
