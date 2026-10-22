// Gmailの取込専用メッセージ認証。シークレットは環境変数から読み、ログに出さない。
import { createHmac, timingSafeEqual } from "node:crypto";
export const signature=(secret,timestamp,body)=>
  createHmac("sha256",secret).update(String(timestamp)+"."+body,"utf8").digest("hex");
export function verifySignature({secret,timestamp,body,signatureHex,now=Date.now()}){
  if(typeof secret!=="string"||secret.length<32)return false;
  if(!/^\d{10}$/.test(String(timestamp||"")))return false;
  const ms=Number(timestamp)*1000;
  if(!Number.isSafeInteger(ms)||Math.abs(now-ms)>5*60*1000)return false;
  if(typeof body!=="string"||body.length>120000)return false;
  if(!/^[a-f0-9]{64}$/i.test(String(signatureHex||"")))return false;
  const expected=Buffer.from(signature(secret,timestamp,body),"hex");
  const received=Buffer.from(signatureHex,"hex");
  return received.length===expected.length&&timingSafeEqual(received,expected);
}
