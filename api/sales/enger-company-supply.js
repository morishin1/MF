// ENGERを正本とする「案件/人材の提供依頼→アポ→受領→本登録」の状態。
// 社名を一致させて別会社へ付け替えない。PIIや配信アドレスは扱わない。
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {admin} from "../../lib/supabase.js";
import {gwLog} from "../../lib/gw-audit.js";
import {canSupplyTransition,hasRegisteredSupply} from "../../lib/sales-supply-policy.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS=new Set(["job","talent","both"]);
const STAGES=new Set(["planned","contacted","appointment","awaiting_info","received","registered","closed"]);
const TABLE="dx2_sales_company_supply_pipeline";
const SELECT="id,company_id,request_kind,stage,next_action_on,note,job_id,candidate_id,created_at,updated_at";
const isDate=s=>!s||(/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s+"T00:00:00Z")));
const short=s=>String(s??"").trim().slice(0,2000);
const normalize=s=>String(s||"").normalize("NFKC").toLocaleLowerCase("ja-JP").replace(/[\s　]+/g,"").trim();

export default async function handler(req,res){
  const user=await requireUser(req,res);if(!user)return;
  if(!["GET","POST","PATCH"].includes(req.method))return methodNotAllowed(res,["GET","POST","PATCH"]);
  res.setHeader?.("Cache-Control","private, no-store");
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx))return json(res,403,{error:"forbidden"});
  const db=admin(),tenant=ctx.tenantId;
  const p=new URL(req.url||"/","http://localhost").searchParams;
  const body=req.method==="GET"?{}:await readJson(req);
  const companyId=req.method==="GET"?p.get("companyId"):body.companyId;
  if(!UUID.test(companyId||""))return json(res,400,{error:"company_id_required"});
  try{
    const company=await db.schema("enger").from("companies")
      .select("id,name,deleted_at").eq("id",companyId).is("deleted_at",null).maybeSingle();
    if(company.error||!company.data)return json(res,404,{error:"company_not_found"});
    if(req.method==="GET"){
      const items=await db.schema("enger").from(TABLE).select(SELECT,{count:"exact"})
        .eq("tenant_id",tenant).eq("company_id",companyId)
        .order("created_at",{ascending:false}).limit(50);
      if(items.error||items.count==null||items.count>50)
        return json(res,503,{error:"pipeline_unavailable",hint:"履歴が多すぎるか取得に失敗しました。省略せず管理者が確認してください。"});
      return json(res,200,{companyId,rows:items.data||[],count:items.count,complete:true});
    }
    if(req.method==="POST"){
      // サーバー側も画面と同じ判定。すでにやり取り中の企業への新規アタックを防止。
      const position=await db.schema("enger").from("dx2_sales_company_directory")
        .select("bucket,needs_contact_review").eq("id",companyId).maybeSingle();
      if(position.error||!position.data)
        return json(res,503,{error:"company_classification_unavailable",hint:"企業区分を確認できないため営業依頼を作成しません。"});
      if(position.data.bucket==="existing")
        return json(res,409,{error:"already_engaged",hint:"既存取引・直近面談中の企業は新規アタック対象から除外しています。"});
      if(position.data.needs_contact_review)
        return json(res,409,{error:"contact_review_required",hint:"企業に注意・旧NG情報があるため営業許可を確認してください。"});
      const kind=String(body.kind||""),stage="planned";
      if(!KINDS.has(kind))return json(res,400,{error:"invalid_kind"});
      const next=body.nextActionOn||null;
      if(!isDate(next))return json(res,400,{error:"invalid_date"});
      // 送信停止・旧NGの企業は受付依頼の実行対象として登録しない。
      const stops=await db.schema("enger").from("dx2_legacy_company_sources")
        .select("external_key,matched_company_id,name_normalized").eq("hard_suppressed",true).limit(500);
      if(stops.error||!stops.data||stops.data.length>=500)
        return json(res,503,{error:"suppression_unavailable",hint:"配信停止の照合ができないため営業依頼を作成しません。"});
      const norm=normalize(company.data.name);
      if(stops.data.some(s=>s.matched_company_id===companyId||normalize(s.name_normalized)===norm))
        return json(res,409,{error:"blocked_source",hint:"旧営業資料にNG・配信停止記録があるため、営業依頼を作成できません。"});
      const insert=await db.schema("enger").from(TABLE).insert({
        tenant_id:tenant,company_id:companyId,request_kind:kind,stage,
        next_action_on:next,note:short(body.note),created_by:user.id,updated_by:user.id,
      }).select(SELECT).single();
      if(insert.error)return json(res,503,{error:"pipeline_create_failed",hint:insert.error.message});
      await gwLog({tenantId:tenant,actorId:user.id,action:"sales.enger_supply_requested",
        target:"enger_company:"+companyId,detail:{kind,recordId:insert.data.id}});
      return json(res,200,{row:insert.data,created:true});
    }
    const id=String(body.id||"");
    if(!UUID.test(id))return json(res,400,{error:"invalid_request_id"});
    const current=await db.schema("enger").from(TABLE).select(SELECT)
      .eq("id",id).eq("tenant_id",tenant).eq("company_id",companyId).maybeSingle();
    if(current.error||!current.data)return json(res,404,{error:"request_not_found"});
    const stage=String(body.stage||"");
    if(!STAGES.has(stage))return json(res,400,{error:"invalid_stage"});
    const next=body.nextActionOn||null;
    if(!isDate(next))return json(res,400,{error:"invalid_date"});
    const kind=current.data.request_kind;
    const jobId=body.jobId||null,candidateId=body.candidateId||null;
    if((jobId&&!UUID.test(jobId))||(candidateId&&!UUID.test(candidateId)))
      return json(res,400,{error:"invalid_enger_record"});
    if(stage==="registered"&&!hasRegisteredSupply(kind,jobId,candidateId))
      return json(res,400,{error:"registration_id_required",
        hint:"ENGERに実際に登録された案件IDまたは人材IDを入力してください。"});
    if(stage!=="registered"&&(jobId||candidateId))
      return json(res,400,{error:"unconfirmed_registration",hint:"ENGERの正式登録前に案件ID・人材IDを記録できません。"});
    if(jobId){
      const job=await db.schema("enger").from("jobs").select("id").eq("id",jobId).is("deleted_at",null).maybeSingle();
      if(job.error||!job.data)return json(res,400,{error:"job_not_found",hint:"ENGERに存在する案件IDを指定してください。"});
    }
    if(candidateId){
      const talent=await db.schema("enger").from("candidates").select("id").eq("id",candidateId).is("deleted_at",null).maybeSingle();
      if(talent.error||!talent.data)return json(res,400,{error:"talent_not_found",hint:"ENGERに存在する人材IDを指定してください。"});
    }
    if(!canSupplyTransition(current.data.stage,stage))
      return json(res,409,{error:"registered_immutable",hint:"本登録済みの記録を未登録状態に戻せません。"});
    const update=await db.schema("enger").from(TABLE)
      .update({stage,next_action_on:next,note:short(body.note),
        job_id:stage==="registered"?jobId:null,
        candidate_id:stage==="registered"?candidateId:null,updated_by:user.id,updated_at:new Date().toISOString()})
      .eq("id",id).eq("tenant_id",tenant).eq("company_id",companyId)
      .eq("updated_at",current.data.updated_at).select(SELECT).maybeSingle();
    if(update.error||!update.data)return json(res,409,{error:"write_conflict",hint:"ほかの担当者が更新しました。再取得してから編集してください。"});
    await gwLog({tenantId:tenant,actorId:user.id,action:"sales.enger_supply_updated",
      target:"enger_company:"+companyId,detail:{recordId:id,stage,kind}});
    return json(res,200,{row:update.data,updated:true});
  }catch{
    return json(res,503,{error:"pipeline_unavailable",hint:"ENGER営業情報の確認ができませんでした。"});
  }
}
