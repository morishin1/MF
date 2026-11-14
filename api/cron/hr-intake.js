import crypto from 'node:crypto';
import { admin } from '../../lib/supabase.js';
import { json,methodNotAllowed } from '../../lib/http.js';
import { processIntake } from '../../lib/hr-intake.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return methodNotAllowed(res,['GET']);
 const secret=process.env.CRON_SECRET||'',provided=String(req.headers.authorization||'');
 const expected='Bearer '+secret;
 if(!secret||Buffer.byteLength(provided)!==Buffer.byteLength(expected)||!crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return json(res,401,{error:'unauthorized'});
 const tenant=process.env.HR_INBOX_TENANT_ID;
 if(process.env.HR_INBOX_PROCESS_ENABLED!=='1'||!/^[a-f0-9-]{36}$/i.test(tenant||''))return json(res,200,{disabled:true});
 const sb=admin();
 // A service-only RPC returns only unclaimed emails; old reviewed/linked records are never replayed.
 const {data:rows,error}=await sb.rpc('gw_hr_intake_pending',{p_tenant:tenant});
 if(error)return json(res,503,{error:'intake_not_ready'});
 let processed=0,failed=0;
 for(const row of rows||[]){try{await processIntake(sb,tenant,row.id,{automated:true});processed++;}catch{failed++;}}
 return json(res,200,{processed,failed});
}
