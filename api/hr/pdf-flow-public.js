// Bearer link stays in fragment and POST body, never query/access logs.
import {json,readJson} from '../../lib/http.js';
import {admin} from '../../lib/supabase.js';
import {ipOf,uaOf} from '../../lib/sign-audit.js';
import * as R from '../../lib/hr-pdf-flow.js';
export function createHandler(deps={}){const D={admin,...deps};return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
 const no=()=>json(res,404,{error:'invalid_link',hint:'この案内は開けません。送信者へお問い合わせください。'});
 try{
 if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});if(!R.enabled())return no();const b=await readJson(req);if(!R.TOKEN.test(b.token||''))return no();
 const sb=D.admin(),h=R.hash(b.token),dr=await sb.from(R.TABLES.docs).select('*').eq('token_hash',h).maybeSingle();const d=dr.data;if(dr.error||!d||d.revoked_at||d.superseded_at||d.delivery_state!=='sent')return no();
 const fr=await sb.from(R.TABLES.flows).select('*').eq('tenant_id',d.tenant_id).eq('id',d.flow_id).maybeSingle(),f=fr.data;
 if(fr.error||!f||f.phase==='cancelled'||(f.phase==='declined'&&d.response_action!=='decline')||d.id!==(d.kind==='offer'?f.offer_doc_id:f.terms_doc_id))return no();
 const expired=!d.expires_at||Date.parse(d.expires_at)<=Date.now();
 if(b.action==='read')return json(res,200,{applicantName:d.recipient_name,document:R.documentView(d),agreementText:R.AGREEMENT[d.response_mode],canRespond:!expired&&!d.responded_at,expired,response:d.response_action});
 if(b.action==='file'){
  const r=await sb.storage.from(R.BUCKET).download(d.path);if(r.error)return no();const bytes=Buffer.from(await r.data.arrayBuffer());if(!R.checkPdf(bytes)||R.hash(bytes)!==d.sha256)return no();
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(d.filename)}`);res.statusCode=200;return res.end(bytes);
 }
 if(!['view','accept','confirm','decline'].includes(b.action))return json(res,400,{error:'invalid_action'});
 if(b.action!=='view'&&(b.documentId!==d.id||b.sha256!==d.sha256||b.agreed!==true))return json(res,400,{error:'confirmation_required'});
 if(b.action==='decline'&&(d.kind!=='offer'||f.accepted_at))return json(res,409,{error:'cannot_decline_terms'});
 if(b.reason!=null&&(typeof b.reason!=='string'||b.reason.length>1000))return json(res,400,{error:'invalid_reason'});
 const r=await sb.rpc('gw_hr_pdf_respond',{p_token:h,p_action:b.action,p_document:d.id,p_sha256:d.sha256,p_evidence:{name:d.recipient_name,email:d.recipient_email,text:b.action==='decline'?'内定を辞退します。':R.AGREEMENT[d.response_mode],ip:ipOf(req),ua:uaOf(req),reason:b.action==='decline'?String(b.reason||'').trim():null}});
 if(r.error)return json(res,409,{error:'response_unavailable',hint:'回答期限・最新の版を確認してください。'});return json(res,200,{ok:true,...r.data});
 }catch{return no();}
};}
export default createHandler();
