// CEO-only ENGER Sales enterprise master CSV.
// GET ?permission=1 -> JSON permission check for the UI.
// GET ?scope=all|filtered&bucket=existing|revive|new&q=...&priority=A&siSes=1&sort=name&direction=asc
// Exports ALL filtered rows (not just current 50), with current verified ENGER contact fields.
// Never auto-send emails or import unverified legacy contact data.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell,isOwner} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {gwLog} from "../../lib/gw-audit.js";
import {renderEngerCompanyCsv,enterpriseBucketLabel} from "../../lib/sales-enger-csv.js";

const ALLOWED_BUCKETS=new Set(["existing","revive","new"]);
const ALLOWED_SORTS=new Set(["name","effective_priority","status","industry","prefecture",
 "historical_activity_count","historical_contact_date","created_at","si_ses_candidate","relationship_status"]);
const MAX_ROWS=10000;
const PAGE_SIZE=500;
const VIEW="dx2_sales_company_directory_for_tenant";
const VIEW_FIELDS=[
 "id","name","bucket","status","industry","prefecture","website","effective_priority","source_priority",
 "historical_activity_count","historical_contact_date","meeting_done","meeting_done_at",
 "classification_basis","si_ses_candidate","needs_contact_review","relationship_status",
 "relationship_evidence","directory_hidden_at","data_source","created_at"
].join(",");
const CONTACT_FIELDS="id,address,phone,contact_email,contact_name,last_contacted_at";
const dateJst=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10).replace(/-/g,"");
const cleanSearch=value=>String(value||"").trim().slice(0,80).replace(/[%_\\*()[\],]/g,"");

export function buildEngerExportFilters(input) {
 const scope=String(input.get("scope")||"filtered");
 const bucket=String(input.get("bucket")||"revive");
 const priority=String(input.get("priority")||"");
 const sort=String(input.get("sort")||"effective_priority");
 const direction=String(input.get("direction")||"asc");
 const siSes=String(input.get("siSes")||"");
 const includeHidden=String(input.get("includeHidden")||"");
 if(!["all","filtered"].includes(scope) ||
    !ALLOWED_BUCKETS.has(bucket) ||
    (priority&&!["A","B","C","D"].includes(priority)) ||
    !ALLOWED_SORTS.has(sort) ||
    !["asc","desc"].includes(direction) ||
    !["","0","1"].includes(siSes) ||
    !["","0","1"].includes(includeHidden))return null;
 return {scope,bucket,priority,sort,direction,siSes:siSes==="1",
   includeHidden:scope==="all"||includeHidden==="1",
   q:cleanSearch(input.get("q"))};
}

export default async function handler(req,res) {
 const user=await requireUser(req,res);if(!user)return;
 if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
 res.setHeader("Cache-Control","private, no-store");
 const ctx=await gwContext(user.id);
 // owner is the sole business-export principal; GW managers and sales members may not export all.
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx)||!isOwner(ctx))
   return json(res,403,{error:"owner_only",hint:"ENGER企業DBの全件CSVは経営者ロールのみダウンロードできます。"});
 const sp=new URL(req.url||"/","http://localhost").searchParams;
 if(sp.get("permission")==="1")return json(res,200,{allowed:true,role:"owner"});
 const filters=buildEngerExportFilters(sp);
 if(!filters)return json(res,400,{error:"invalid_filters",hint:"出力条件が正しくありません。"});
 const db=admin();
 const makeQuery=(fields,options={})=>{
   let query=db.schema("enger").from(VIEW).select(fields,options).eq("tenant_id",ctx.tenantId);
   if(filters.scope==="filtered"){
     query=query.eq("bucket",filters.bucket);
     if(filters.q)query=query.ilike("name",`%${filters.q}%`);
     if(filters.siSes)query=query.eq("si_ses_candidate",true);
     if(filters.priority)query=query.eq("effective_priority",filters.priority);
   }
   if(!filters.includeHidden)query=query.is("directory_hidden_at",null);
   return query;
 };
 try {
  const count=await makeQuery("id",{count:"exact",head:true});
  if(count.error||count.count==null)
    return json(res,503,{error:"count_unavailable",hint:"企業の件数を確認できません。CSVを作成しません。"});
  if(count.count>MAX_ROWS)
    return json(res,413,{error:"export_limit",hint:`出力上限${MAX_ROWS}社を超えています。条件で絞り込んでください。`});
  const all=[];
  for(let from=0;from<count.count;from+=PAGE_SIZE){
    // This repeats source filters on every page; partial results are never sent to the user.
    const segment=await makeQuery(VIEW_FIELDS)
      .order(filters.sort,{ascending:filters.direction==="asc",nullsFirst:false})
      .order("name",{ascending:true}).order("id",{ascending:true})
      .range(from,Math.min(from+PAGE_SIZE,count.count)-1);
    if(segment.error||!segment.data||segment.data.length!==Math.min(PAGE_SIZE,count.count-from))
      return json(res,503,{error:"directory_export_incomplete",hint:"企業一覧の取得結果に欠損があるためCSVを作成しません。"});
    const ids=segment.data.map(r=>r.id);
    // Fetch contacts only for verified company IDs, never from unverified legacy input.
    const details=await db.schema("enger").from("companies").select(CONTACT_FIELDS)
      .in("id",ids).is("deleted_at",null);
    if(details.error||!details.data||details.data.length!==ids.length)
      return json(res,503,{error:"directory_export_contacts_incomplete",
       hint:"連絡先の照合が完了しなかったためCSVを作成しません。"});
    const byId=new Map(details.data.map(r=>[r.id,r]));
    for(const row of segment.data){
      const contact=byId.get(row.id);
      if(!contact)return json(res,503,{error:"directory_export_missing_company"});
      all.push({
       id:row.id,name:row.name,bucketLabel:enterpriseBucketLabel(row.bucket),
       status:row.status,industry:row.industry,prefecture:row.prefecture,
       address:contact.address,website:row.website,phone:contact.phone,
       email:contact.contact_email,contactName:contact.contact_name,
       priority:row.effective_priority,oldPriority:row.source_priority,
       oldActivities:row.historical_activity_count,oldLastDate:row.historical_contact_date,
       lastContacted:contact.last_contacted_at,
       meetingDone:row.meeting_done?"記録あり（契約とは別）":"未確認",
       meetingAt:row.meeting_done_at,relationshipStatus:row.relationship_status,
       relationshipEvidence:row.relationship_evidence,
       classificationBasis:row.classification_basis,
       siSesCandidate:row.si_ses_candidate?"業種からの候補":"未判定",
       needsContactReview:row.needs_contact_review?"連絡許可を要確認":"未確認",
       excluded:row.directory_hidden_at?"除外済み":"",
       dataSource:row.data_source,registeredAt:row.created_at,
      });
    }
  }
  if(all.length!==count.count)
    return json(res,503,{error:"directory_export_count_mismatch",hint:"件数に不一致があります。CSVを作成しません。"});
  const filename=`enger_companies_${filters.scope==="all"?"all":filters.bucket}_${dateJst()}.csv`;
  const csv=renderEngerCompanyCsv(all);
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"sales.enger_company_export",
    target:"enger_company:export",detail:{
      count:all.length,scope:filters.scope,bucket:filters.scope==="filtered"?filters.bucket:null,
      sort:filters.sort,direction:filters.direction,includeHidden:filters.includeHidden,
      priority:filters.scope==="filtered"?filters.priority:null,siSes:filters.siSes}});
  res.statusCode=200;
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="${filename}"`);
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Cache-Control","private, no-store");
  // Streaming avoids the non-streamed Vercel response size limit for 7,000+ rows.
  for(let offset=0;offset<csv.length;offset+=60000)res.write(csv.slice(offset,offset+60000));
  res.end();
 }catch(err) {
   return json(res,503,{error:"directory_export_failed",
     hint:"ENGER企業DBの出力に失敗しました。データの状態を確認してください。"});
 }
}
