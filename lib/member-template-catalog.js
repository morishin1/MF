// Match the lifecycle document keys to the single existing "社内文書・雛形" catalog.
// The catalog does not create/sign contracts or turn someone's submission into a template.
import { LIFECYCLE_DOCUMENTS } from "./member-document-lifecycle.js";

export const TEMPLATE_RULES = Object.freeze({
  resume:{kind:"official",officialUrl:"https://kouseisaiyou.mhlw.go.jp/methods.html",officialTitle:"厚生労働省・履歴書様式例",note:"本人が記入して提出します。公正採用の観点で公式の様式例を参考にしてください。"},
  work_history:{kind:"create",note:"本人記入用の職務経歴書の雛形を使えます。"},
  skill_sheet:{kind:"create",note:"必要な職種だけスキルシートの雛形を渡してください。"},
  offer_letter:{kind:"workflow",url:"/hr/applicants.html",note:"採用HRの内定通知機能で作成・送信します。"},
  accepted_offer:{kind:"workflow",url:"/hr/applicants.html",note:"本人が承諾した結果から生成する書類です。白紙の承諾済みPDFは作りません。"},
  labor_notice:{kind:"sign",signKind:"employment",officialUrl:"https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/roudoukijunkankei.html",officialTitle:"厚生労働省・労働条件通知書様式（2026年10月以降）"},
  employment_contract:{kind:"sign",signKind:"employment",officialUrl:"https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/roudoukijunkankei.html",officialTitle:"厚生労働省・労働条件通知書様式"},
  service_contract:{kind:"create",note:"自社の業務委託条件を確定し、法務確認してから使う雛形です。"},
  nda:{kind:"sign",signKind:"pledge",note:"既存の秘密保持誓約書から署名依頼を作成します。"},
  dependents:{kind:"official",officialUrl:"https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/gensen/annai/1648_01.htm",officialTitle:"国税庁・給与所得者の扶養控除等（異動）申告書"},
  pension:{kind:"original",note:"年金手帳・基礎年金番号通知書等の本人所持原本です。会社で雛形を作るものではありません。"},
  employment_ins:{kind:"original",note:"雇用保険被保険者証等の本人所持原本です。会社で雛形を作るものではありません。"},
  previous_withholding:{kind:"original",note:"前職が発行する源泉徴収票です。会社で雛形を作るものではありません。"},
  bank:{kind:"create",note:"振込口座登録票。必要な情報だけを記入する雛形です。"},
  profile:{kind:"create",note:"入社時の基本情報届。重複する本人確認項目は避けてください。"},
  emergency:{kind:"create",note:"緊急連絡先届。本人以外の連絡先を必要最小限で管理します。"},
  consent:{kind:"create",referenceTitle:"就業規則",note:"就業規則への同意は実際の規程を確認してから取得します。"},
  contract_addendum:{kind:"create",note:"契約更新・覚書。契約条件は必ず会社・本人双方で確認してください。"},
  other:{kind:"original",note:"個別に必要となった場合にだけ書類名を決め、社内文書から雛形を選んでください。共通の雛形は不要です。"},
  resignation_notice:{kind:"create",note:"退職届。会社の退職手続きと合わせて使用します。"},
  handover_form:{kind:"create",note:"引継ぎ内容と相手・完了日を記録します。"},
  asset_return_form:{kind:"create",note:"会社貸与物の返却状況を確認します。"},
  retirement_pledge:{kind:"create",note:"退職後の守秘・貸与物返却等。既存契約と整合するよう法務確認が必要です。"},
  retire_certificate:{kind:"workflow",url:"/admin-members.html",officialUrl:"https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/roudoukijunkankei.html",officialTitle:"厚生労働省・モデル退職証明書",note:"本人の請求等に応じ、Officeの正式な退職書類発行手続きから発行してください。"},
  retire_withholding:{kind:"workflow",url:"/admin-members.html",note:"給与情報に基づく正式な源泉徴収票として発行します。白紙雛形の配布はしません。"},
  retire_separation:{kind:"workflow",url:"/admin-members.html",note:"雇用保険の手続きと連動して発行・交付する書類です。"},
  retire_insurance_loss:{kind:"workflow",url:"/admin-members.html",note:"資格喪失手続きに対応する発行書類です。"},
});
const KINDS=new Set(LIFECYCLE_DOCUMENTS.map(d=>d.key));
const KEY=/^(?:[a-z][a-z0-9_]{1,79}|custom_[a-z0-9_]{2,70})$/;
export const validTemplateKey = k => KEY.test(String(k||"")) && (KINDS.has(k)||k.startsWith("custom_"));
export const ruleFor = key => TEMPLATE_RULES[key] || {kind:"create",note:"追加で必要となった書類です。雛形がなければ社内文書で作成してください。"};
const norm=(v)=>String(v||"").trim();
export const linkedKind=(type)=>({library:"library",general:"general",sign:"sign"})[type]||null;
export const templateMarker = (note)=>/doc_key:([a-z0-9_]+)/i.exec(norm(note))?.[1]||null;
const kindOf=(x)=>x?.source_kind||x?.sourceKind;
const identity=(id)=>typeof id==="string"&&/^[0-9a-f-]{36}$/i.test(id);
const cleanLink=(r)=>({
  docKey:r.doc_key,source:r.source_kind,id:r.source_id,updatedAt:r.updated_at,
});
export async function readTemplateCatalog(sb,tenantId){
  const query=async(table,columns)=>{
    const {data,error}=await sb.from(table).select(columns).eq("tenant_id",tenantId).limit(350);
    if(error)throw new Error(table+": "+error.message);
    return data||[];
  };
  const [library,general,signs,linked]=await Promise.all([
    query("gw_library","id,title,category,file_path,file_name,mime_type,link_url,published,created_at"),
    query("gw_doc_templates","id,name,kind,note,employment_types,created_at"),
    query("gw_sign_templates","id,name,doc_kind,active,version,created_at"),
    query("gw_member_doc_template_links","doc_key,source_kind,source_id,updated_at"),
  ]);
  const libBy=new Map(library.map(x=>[x.id,x]));
  const generalBy=new Map(general.map(x=>[x.id,x]));
  const signBy=new Map(signs.map(x=>[x.id,x]));
  const manual=new Map(linked.map(x=>[x.doc_key,cleanLink(x)]));
  const fromRecord=(source,r,forced=false)=>{
    if(!r)return null;
    if(source==="library" && !r.file_path && !r.link_url)return null;
    if(source==="sign"&&!r.active)return null;
    const note=norm(r.note);
    return {source,id:r.id,title:r.name||r.title,
      status:source==="general"&&/要確認|確認前|承認前/.test(note)?"review":"linked",
      fileType:source==="library"?(r.file_name||r.mime_type||""):"",
      published:source==="library"?Boolean(r.published):false,
      reviewRequired:source==="general"&&/要確認|確認前|承認前/.test(note),
      forced};
  };
  const find=(key)=>{
    const manualRef=manual.get(key);
    if(manualRef){
      const record=manualRef.source==="library"?libBy.get(manualRef.id):
        manualRef.source==="general"?generalBy.get(manualRef.id):signBy.get(manualRef.id);
      const linkedTemplate=fromRecord(manualRef.source,record,true);
      if(linkedTemplate)return linkedTemplate;
      return {source:"missing",status:"broken",title:"紐づけ先がありません",forced:true};
    }
    const rule=ruleFor(key);
    const gen=general.find(x=>templateMarker(x.note)===key);
    const fromGeneral=fromRecord("general",gen);
    if(fromGeneral)return fromGeneral;
    if(rule.signKind){
      const sign=signs.find(x=>x.active&&x.doc_kind===rule.signKind);
      const fromSign=fromRecord("sign",sign);
      if(fromSign)return fromSign;
    }
    if(rule.kind==="workflow")return {source:"workflow",title:"既存の正式手続き",
      url:rule.url||null,officialUrl:rule.officialUrl||null,status:"workflow"};
    if(rule.officialUrl)return {source:"official",title:rule.officialTitle||"公式様式",
      url:rule.officialUrl,status:"linked",published:true};
    if(rule.kind==="original")return {source:"original",title:key==="other"?"共通の雛形なし":"本人・発行元の原本",status:"not_needed",note:rule.note||null};
    return {source:"missing",title:"雛形未登録",status:"missing"};
  };
  const choices=[
    ...library.filter(x=>x.file_path||x.link_url).map(x=>({source:"library",id:x.id,title:x.title,published:x.published,category:x.category})),
    ...general.map(x=>({source:"general",id:x.id,title:x.name,kind:x.kind})),
    ...signs.filter(x=>x.active).map(x=>({source:"sign",id:x.id,title:x.name,kind:x.doc_kind})),
  ];
  const resolve=key=>{
    const result=find(key);
    const rule=ruleFor(key);
    const related=rule.referenceTitle&&library.find(x=>x.published&&x.title===rule.referenceTitle);
    return related?{...result,reference:{title:related.title,id:related.id,url:"/doc.html?id="+encodeURIComponent(related.id)}}:result;
  };
  return {choices,resolve,manual,records:{library:libBy,general:generalBy,sign:signBy}};
}
export function templateKeyFromRule(key,manualOverride){
  return validTemplateKey(key) ? key : null;
}
