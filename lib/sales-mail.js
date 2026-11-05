// Sales uses its own SMTP credentials. Never falls back to the recruiting account.
import {createHash} from 'node:crypto';
import {isEmail,addressOf} from './mail/index.js';
import * as smtp from './mail/smtp.js';
export function salesMailConfig(env=process.env){
 const from=String(env.SALES_MAIL_FROM||'').trim(),fromAddress=addressOf(from);
 const smtpEnv={SMTP_HOST:env.SALES_SMTP_HOST,SMTP_PORT:env.SALES_SMTP_PORT||'465',SMTP_SECURE:'1',SMTP_USER:env.SALES_SMTP_USER,SMTP_PASS:env.SALES_SMTP_PASS};
 const ready=smtp.ready(smtpEnv);
 const configured=Boolean(fromAddress&&!/[\r\n]/.test(from)&&ready.ok&&String(env.SALES_MAIL_ENABLED)==='1');
 return {configured,from,fromAddress,replyTo:fromAddress,
  hint:configured?'送信結果は企業の履歴に自動保存されます。':'営業メールの送信接続が未設定です。文面の作成・雛形の編集は利用できます。',smtpEnv};
}
export function mailInput(body){
 const to=String(body.to||'').trim(),subject=String(body.subject||'').trim(),text=String(body.text||'').trim();
 if(!isEmail(to)||to.length>254)throw Error('宛先のメールアドレスを確認してください。');
 if(!subject||subject.length>300||/[\r\n]/.test(subject))throw Error('件名を1行・300文字以内で入力してください。');
 if(!text||text.length>20000)throw Error('本文を20,000文字以内で入力してください。');
 if(/{{[^}]*}}/.test(subject+text))throw Error('差し込み項目をすべて入力してください。');
 return {to,subject,text};
}
export function mailFingerprint(id,msg){return createHash('sha256').update(JSON.stringify([id,msg.to.toLowerCase(),msg.subject,msg.text])).digest('hex');}
export async function deliverSalesMail(msg,cfg){
 if(!cfg.configured)return {status:'not_sent',providerMessageId:null};
 try{const result=await smtp.send({from:cfg.from,to:msg.to,subject:msg.subject,text:msg.text,replyTo:cfg.replyTo},{env:cfg.smtpEnv});
  return {status:'accepted',providerMessageId:result?.id||null};
 }catch{return {status:'unknown',providerMessageId:null};}
}
export const MAIL_COLUMNS='id,company_id,request_key,fingerprint,to_email,from_email,subject,body_text,actor_name,actor_id,status,provider_message_id,created_at,finished_at';
