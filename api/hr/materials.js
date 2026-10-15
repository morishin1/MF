// /api/hr/materials — 採用HRで共通利用する面談資料（db/136）
// GET    一覧 / ?id=<material> 1件
// POST   create / upload / attach / open
// PATCH  update / set_active
//
// PDF は private bucket "hr" の <tenant>/materials/<uuid>.pdf。
// URL は https のみ。候補者へ共有できるのは URL かつ shareExternal=true の資料だけ。
import crypto from "node:crypto";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const SQL = "db/136_hr_materials.sql";
const BUCKET = "hr";
const MAX_PDF = 20 * 1024 * 1024;
const CATS = new Set(["company","recruiting","mugendojo","service","regional","ai_dx","other"]);
const KINDS = new Set(["url","file"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = "id,tenant_id,name,category,kind,url,storage_path,filename,mime_type,size_bytes,description,sort_order,is_active,share_external,default_for_casual,created_at,updated_at";

const clean = (s, max) => {
  const v = String(s ?? "").trim();
  return v ? v.slice(0, max) : null;
};
const httpsUrl = (s) => /^https:\/\/[^\s]+$/i.test(String(s || ""));
const view = (r) => ({
  id:r.id, name:r.name, category:r.category, kind:r.kind, url:r.url,
  filename:r.filename, mimeType:r.mime_type, sizeBytes:r.size_bytes,
  description:r.description, sortOrder:r.sort_order, active:r.is_active !== false,
  shareExternal:Boolean(r.share_external), defaultForCasual:Boolean(r.default_for_casual),
  createdAt:r.created_at, updatedAt:r.updated_at,
});

function dbError(res, e) {
  const msg = String(e?.message || e || "");
  if (/gw_hr_materials|gw_hr_interview_materials|relation .* does not exist/i.test(msg)) {
    return json(res, 503, { error:"not_ready", hint:`資料機能を使うには ${SQL} を Supabase に流してください` });
  }
  return json(res, 500, { error:"db_error", detail:msg });
}

export default async function handler(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res,403,{error:"no_membership"});
  if (!canRecruit(ctx)) return json(res,403,{error:"forbidden"});
  res.setHeader("Cache-Control","no-store");
  try {
    if (req.method === "GET") return list(req,res,ctx);
    if (req.method === "POST") return createOrFile(req,res,ctx,user);
    if (req.method === "PATCH") return update(req,res,ctx,user);
    return methodNotAllowed(res,["GET","POST","PATCH"]);
  } catch (e) { return dbError(res,e); }
}

async function list(req,res,ctx) {
  const sb=admin();
  const id=new URL(req.url,"http://localhost").searchParams.get("id");
  let q=sb.from("gw_hr_materials").select(FIELDS).eq("tenant_id",ctx.tenantId);
  if (id) {
    if (!UUID.test(id)) return json(res,400,{error:"invalid_id"});
    const {data,error}=await q.eq("id",id).maybeSingle();
    if (error) throw error;
    if (!data) return json(res,404,{error:"not_found"});
    return json(res,200,{material:view(data)});
  }
  const {data,error}=await q.order("sort_order").order("created_at");
  if (error) throw error;
  return json(res,200,{
    materials:(data||[]).map(view),
    categories:[
      ["company","会社案内"],["recruiting","採用資料"],["mugendojo","無限道場"],
      ["service","サービス"],["regional","地方創生"],["ai_dx","AI・DX"],["other","その他"],
    ].map(([key,label])=>({key,label})),
    limits:{maxPdfBytes:MAX_PDF,accept:"application/pdf"}
  });
}

async function createOrFile(req,res,ctx,user) {
  const body=await readJson(req); const sb=admin();
  if (body?.action === "upload") {
    const filename=clean(body.filename,200);
    const size=Number(body.sizeBytes||0);
    if (!filename || !/\.pdf$/i.test(filename) || String(body.mimeType||"")!=="application/pdf")
      return json(res,400,{error:"invalid_file",hint:"PDFファイルを選んでください"});
    if (!(size>0 && size<=MAX_PDF)) return json(res,400,{error:"invalid_file",hint:"PDFは20MB以内にしてください"});
    const path=`${ctx.tenantId}/materials/${crypto.randomUUID()}.pdf`;
    const {data,error}=await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return json(res,500,{error:"sign_failed",detail:error.message});
    return json(res,200,{path,uploadUrl:data.signedUrl,token:data.token});
  }
  if (body?.action === "attach") {
    const path=String(body.path||"");
    const prefix=`${ctx.tenantId}/materials/`;
    if (!path.startsWith(prefix) || !/^[\w-]+\.pdf$/.test(path.slice(prefix.length))) return json(res,403,{error:"forbidden"});
    const dl=await sb.storage.from(BUCKET).download(path);
    if (dl.error || !dl.data) return json(res,400,{error:"no_file",hint:"アップロードしたPDFを確認できませんでした"});
    const bytes=Buffer.from(await dl.data.arrayBuffer());
    if (bytes.length>MAX_PDF || bytes.slice(0,5).toString("ascii")!=="%PDF-") {
      await sb.storage.from(BUCKET).remove([path]);
      return json(res,400,{error:"invalid_file",hint:"正しいPDFファイルを選んでください"});
    }
    const base=normalize(body,{forceKind:"file"});
    if (base.error) { await sb.storage.from(BUCKET).remove([path]); return json(res,400,base); }
    const row={...base.value,tenant_id:ctx.tenantId,kind:"file",url:null,storage_path:path,
      filename:clean(body.filename,200)||"material.pdf",mime_type:"application/pdf",size_bytes:bytes.length,
      created_by:user.id,updated_by:user.id};
    const {data,error}=await sb.from("gw_hr_materials").insert(row).select(FIELDS).single();
    if (error) { await sb.storage.from(BUCKET).remove([path]); throw error; }
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.material_create",target:`hr_material:${data.id}`,detail:{kind:"file",category:data.category}});
    return json(res,200,{material:view(data)});
  }
  if (body?.action === "open") {
    if (!UUID.test(String(body.id||""))) return json(res,400,{error:"invalid_id"});
    const {data:r,error}=await sb.from("gw_hr_materials").select(FIELDS).eq("tenant_id",ctx.tenantId).eq("id",body.id).maybeSingle();
    if (error) throw error; if (!r) return json(res,404,{error:"not_found"});
    if (r.kind==="url") return json(res,200,{url:r.url,kind:"url"});
    const {data,error:se}=await sb.storage.from(BUCKET).createSignedUrl(r.storage_path,300);
    if (se) return json(res,404,{error:"file_missing",detail:se.message});
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.material_view",target:`hr_material:${r.id}`});
    return json(res,200,{url:data.signedUrl,kind:"file",filename:r.filename,expiresIn:300});
  }
  const n=normalize(body,{forceKind:"url"}); if (n.error) return json(res,400,n);
  const row={...n.value,tenant_id:ctx.tenantId,kind:"url",storage_path:null,filename:null,mime_type:null,size_bytes:null,
    created_by:user.id,updated_by:user.id};
  const {data,error}=await sb.from("gw_hr_materials").insert(row).select(FIELDS).single();
  if (error) throw error;
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.material_create",target:`hr_material:${data.id}`,detail:{kind:"url",category:data.category}});
  return json(res,200,{material:view(data)});
}

async function update(req,res,ctx,user) {
  const body=await readJson(req); const sb=admin();
  if (!UUID.test(String(body?.id||""))) return json(res,400,{error:"invalid_id"});
  const {data:old,error:oe}=await sb.from("gw_hr_materials").select(FIELDS).eq("tenant_id",ctx.tenantId).eq("id",body.id).maybeSingle();
  if (oe) throw oe; if (!old) return json(res,404,{error:"not_found"});
  if (body.action==="set_active") {
    const active=Boolean(body.active);
    const {data,error}=await sb.from("gw_hr_materials").update({is_active:active,updated_by:user.id,updated_at:new Date().toISOString()})
      .eq("tenant_id",ctx.tenantId).eq("id",old.id).select(FIELDS).single();
    if (error) throw error;
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.material_active",target:`hr_material:${old.id}`,detail:{active}});
    return json(res,200,{material:view(data)});
  }
  if (body.action!=="update") return json(res,400,{error:"invalid_action"});
  const n=normalize(body,{forceKind:old.kind,partial:true}); if (n.error) return json(res,400,n);
  if (old.kind==="file") delete n.value.url;
  const {data,error}=await sb.from("gw_hr_materials").update({...n.value,updated_by:user.id,updated_at:new Date().toISOString()})
    .eq("tenant_id",ctx.tenantId).eq("id",old.id).select(FIELDS).single();
  if (error) throw error;
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.material_update",target:`hr_material:${old.id}`,detail:{fields:Object.keys(n.value)}});
  return json(res,200,{material:view(data)});
}

function normalize(body,{forceKind,partial=false}={}) {
  const value={};
  const has=(k)=>body?.[k]!==undefined;
  if (!partial || has("name")) {
    const name=clean(body?.name,160); if (!name) return {error:"invalid_body",hint:"資料名を入力してください"}; value.name=name;
  }
  if (!partial || has("category")) {
    const c=String(body?.category||"other"); if (!CATS.has(c)) return {error:"invalid_body",hint:"カテゴリが正しくありません"}; value.category=c;
  }
  if (!partial || has("description")) value.description=clean(body?.description,1000);
  if (!partial || has("sortOrder")) {
    const n=Number(body?.sortOrder ?? 100); value.sort_order=Number.isFinite(n)?Math.trunc(n):100;
  }
  if (!partial || has("shareExternal")) value.share_external=Boolean(body?.shareExternal);
  if (!partial || has("defaultForCasual")) value.default_for_casual=Boolean(body?.defaultForCasual);
  if (!partial || has("url")) {
    const url=clean(body?.url,1000);
    if (forceKind==="url") {
      if (!url || !httpsUrl(url)) return {error:"invalid_body",hint:"URLは https:// で始まるURLを入力してください"};
      value.url=url;
    }
  }
  if (forceKind==="file" && value.share_external) return {error:"invalid_body",hint:"PDF資料は候補者向け外部共有に設定できません"};
  return {value};
}
