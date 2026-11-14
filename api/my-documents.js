// 本人の書類だけ。管理用の書類台帳APIや、クライアント指定employeeIdは利用しない。
import {json,methodNotAllowed} from '../lib/http.js';
import {requireUser} from '../lib/auth.js';
import {gwContext} from '../lib/gw.js';
import {admin} from '../lib/supabase.js';
import {requireMfa} from '../lib/mfa.js';
export function createHandler(deps={}){const D={requireUser,gwContext,admin,requireMfa,...deps};return async(req,res)=>{
 res.setHeader('Cache-Control','private,no-store');
 const user=await D.requireUser(req,res);if(!user)return;
 if(req.method!=='GET')return methodNotAllowed(res,['GET']);
 const ctx=await D.gwContext(user.id);if(!await D.requireMfa(req,res,ctx,user))return;
 if(!ctx.employee||!ctx.tenantId)return json(res,200,{employee:false,received:[],uploads:[],checklist:[],checklistState:'unconfigured',notReady:[]});
 try{
  const sb=D.admin(),base=(table,cols)=>sb.from(table).select(cols).eq('tenant_id',ctx.tenantId).eq('employee_id',ctx.employee.id),missing=[];
  const read=async(q,key)=>{const r=await q;if(r.error){missing.push(key);return [];}return r.data||[];};
  const [procedures,manual,notices,contracts]=await Promise.all([
   read(base('gw_procedures','id,kind,created_at').order('created_at',{ascending:false}).limit(100),'手続き'),
   read(base('gw_member_documents','id,doc_kind,filename,mime_type,storage_path,status,created_at,uploaded_by,deleted_at').eq('uploaded_by',user.id).is('deleted_at',null).limit(300),'アップロード書類'),
   read(base('gw_labor_notices','id,filename,version,published_at,confirmed_at,storage_path').not('published_at','is',null).order('version',{ascending:false}).limit(100),'労働条件通知書'),
   read(base('gw_contracts','id,contract_type,status,file_path,filename,confirmed_at,created_at').neq('status','draft').limit(100),'契約の控え'),
  ]);
  const pids=procedures.map(p=>p.id),scope=(table,cols)=>sb.from(table).select(cols).eq('tenant_id',ctx.tenantId).in('procedure_id',pids);
  const [items,files]=pids.length?await Promise.all([
   read(scope('gw_procedure_items','id,procedure_id,item_key,title,owner,required,status,submitted_at,due_on').limit(1000),'提出状況'),
   read(scope('gw_procedure_files','id,procedure_id,item_id,filename,mime_type,storage_path,uploaded_by,created_at').order('created_at',{ascending:false}).limit(1000),'提出ファイル'),
  ]):[[],[]];
  const notes=pids.length?await scope('gw_procedure_items','id,advisor_review_note').limit(1000):{data:[]};
  if(notes.error)missing.push('確認結果');
  if(items.length>=1000||files.length>=1000)missing.push('提出状況');
  const reviewNotes=new Map((notes.data||[]).map(i=>[i.id,i.advisor_review_note||null]));
  const safe=i=>i?.item_key!=='doc_mynumber'&&!/マイナンバー|個人番号/.test(i?.title||'');
  const filed=f=>{const i=items.find(i=>i.id===f.item_id);return i&&safe(i)&&(['submitted','done'].includes(i.status)||Boolean(reviewNotes.get(i.id)))&&(!i.submitted_at||String(f.created_at)<=String(i.submitted_at));};
  const uploads=files.filter(f=>f.uploaded_by===user.id&&filed(f)).map(f=>({id:f.id,itemId:f.item_id,source:'procedure',title:items.find(i=>i.id===f.item_id)?.title||'提出書類',filename:f.filename,status:items.find(i=>i.id===f.item_id)?.status==='done'?'確認済み':'確認待ち',createdAt:f.created_at,mimeType:f.mime_type,path:f.storage_path,bucket:'hr'}));
  uploads.push(...manual.map(d=>({id:d.id,source:'manual',title:d.filename,filename:d.filename,status:d.status==='verified'?'確認済み':'確認待ち',createdAt:d.created_at,mimeType:d.mime_type,path:d.storage_path,bucket:'hr'})));
  const active=new Set([procedures.find(p=>p.kind==='onboarding')?.id]);
  if(ctx.employee.status==='leaving')active.add(procedures.find(p=>p.kind==='offboarding')?.id);
  const checklist=items.filter(i=>active.has(i.procedure_id)&&i.owner==='employee'&&i.item_key?.startsWith('doc_')&&safe(i)).map(i=>{
   const note=reviewNotes.get(i.id),returned=!['done','submitted','na'].includes(i.status)&&Boolean(note);
   return {id:i.id,title:i.title,required:i.required===true,status:i.status==='na'?'対象外':i.status==='done'?'確認済み':i.status==='submitted'?'確認待ち':returned?'要再提出':'未提出',statusKey:i.status,reviewNote:returned?String(note):null,submittedAt:i.submitted_at||null,dueOn:i.due_on,canUpload:!['done','na'].includes(i.status),href:'/onboarding/'};
  });
  const received=notices.filter(d=>d.storage_path).map(d=>({id:d.id,source:'notice',title:'労働条件通知書',filename:d.filename,status:d.confirmed_at?'受領確認済み':'公開中',createdAt:d.published_at,version:d.version,path:d.storage_path,bucket:'hr',mimeType:'application/pdf'}));
  received.push(...contracts.filter(d=>d.file_path).map(d=>({id:d.id,source:'contract',title:d.contract_type||'契約書の控え',filename:d.filename||'契約書.pdf',status:'契約書の控え',createdAt:d.created_at,path:d.file_path,bucket:'hr',mimeType:'application/pdf'})));
  const q=new URL(req.url,'http://localhost').searchParams;
  if(q.get('file')==='1'){
   const d=[...uploads,...received].find(d=>d.id===q.get('id')&&d.source===q.get('source'));
   if(!d||!d.path?.startsWith(ctx.tenantId+'/'))return json(res,404,{error:'not_found'});
   const r=await sb.storage.from(d.bucket).createSignedUrl(d.path,60,q.get('download')==='1'?{download:d.filename}:undefined);
   return json(res,r.error?404:200,r.error?{error:'file_missing'}:{url:r.data.signedUrl,filename:d.filename,mimeType:d.mimeType});
  }
  const publicRow=({path,bucket,...row})=>row;
  const checklistState=missing.some(k=>['手続き','提出状況','提出ファイル','確認結果'].includes(k))?'unavailable':checklist.length?'ready':'unconfigured';
  return json(res,200,{employee:true,uploads:uploads.map(publicRow),received:received.map(publicRow),checklist,checklistState,notReady:missing});
 }catch{return json(res,503,{error:'documents_unavailable',hint:'書類を取得できません。再読み込みしてください。'});}
};}
export default createHandler();
