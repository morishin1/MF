// Xserver向けSMTP送信部品（lib/mail/smtp.js）の設定・MIME・窓口接続を確認する。
// 実SMTPには接続せず、smtpSendImpl を差し込む。
import assert from "node:assert/strict";
import { mailConfig, sendMail } from "../lib/mail/index.js";
import { ready, config, buildMessage } from "../lib/mail/smtp.js";

let pass=0, fail=0;
const ok=async(name,fn)=>{try{await fn();pass++;console.log("  ok",name)}catch(e){fail++;console.log("  NG",name,"\n     ",e.message)}};

const ENV={
  MAIL_PROVIDER:"smtp",
  MAIL_SEND_ENABLED:"1",
  HR_ONBOARDING_FROM:"エイト 人事 <hr@example.com>",
  HR_RECRUITING_FROM:"株式会社エイト <support@example.com>",
  MAIL_REPLY_TO:"reply@example.com",
  SMTP_HOST:"mail.example.com",
  SMTP_PORT:"465",
  SMTP_SECURE:"1",
  SMTP_USER:"support@example.com",
  SMTP_PASS:"p",
};
const MSG={purpose:"recruiting",to:"candidate@example.com",subject:"【弊社】育成プログラムのご案内",text:"ご確認ください。\nhttps://gw.example.com/x"};

console.log("— SMTP設定 —");

await ok("必要な設定がそろえば configured",()=>{
  assert.equal(ready(ENV).ok,true);
  const c=mailConfig("recruiting",ENV);
  assert.equal(c.configured,true);
  assert.equal(c.provider,"smtp");
  assert.equal(c.from,"株式会社エイト <support@example.com>");
});

await ok("port未指定は465。secureは既定でTLS",()=>{
  const c=config({...ENV,SMTP_PORT:"",SMTP_SECURE:""});
  assert.equal(c.port,465);
  assert.equal(c.secure,true);
});

await ok("SMTPの不足項目を具体的に案内する",()=>{
  const cases=[
    [{...ENV,SMTP_HOST:""},/SMTP_HOST/],
    [{...ENV,SMTP_PORT:"abc"},/SMTP_PORT/],
    [{...ENV,SMTP_SECURE:"0"},/SMTP_SECURE=1/],
    [{...ENV,SMTP_USER:""},/SMTP_USER/],
    [{...ENV,SMTP_PASS:""},/SMTP_PASS/],
  ];
  for(const [env,re] of cases){
    const r=ready(env); assert.equal(r.ok,false); assert.match(r.reason,re);
    const c=mailConfig("recruiting",env); assert.equal(c.configured,false); assert.match(c.reason,re);
  }
});

console.log("— mail/index.js との接続 —");

await ok("MAIL_PROVIDER=smtp ならSMTP部品へ1回だけ渡す",async()=>{
  const calls=[];
  const r=await sendMail(MSG,{env:ENV,smtpSendImpl:async(c,m)=>{calls.push({c,m});return{id:"queue-123"}}});
  assert.equal(r.status,"sent");
  assert.equal(r.provider,"smtp");
  assert.equal(r.providerMessageId,"queue-123");
  assert.equal(calls.length,1);
  assert.equal(calls[0].c.host,"mail.example.com");
  assert.equal(calls[0].c.port,465);
  assert.equal(calls[0].c.user,"support@example.com");
  assert.equal(calls[0].m.from,"株式会社エイト <support@example.com>");
  assert.equal(calls[0].m.replyTo,"reply@example.com");
});

await ok("SMTP失敗も例外を外へ投げず failed にする",async()=>{
  const r=await sendMail(MSG,{env:ENV,smtpSendImpl:async()=>{throw new Error("SMTP AUTH で失敗しました（535）")}});
  assert.equal(r.status,"failed");
  assert.match(r.error,/535/);
});

console.log("— MIME —");

await ok("日本語件名・本文をSMTP用メッセージにする",()=>{
  const {raw}=buildMessage({
    from:"株式会社エイト <support@example.com>",to:"candidate@example.com",subject:"【弊社】ご案内",text:"1行目\n2行目",replyTo:"reply@example.com"
  },{messageId:"<fixed@example.com>"});
  assert.match(raw,/From: =\?UTF-8\?B\?/);
  assert.match(raw,/Subject: =\?UTF-8\?B\?/);
  assert.match(raw,/Message-ID: <fixed@example\.com>/);
  assert.match(raw,/Reply-To: <reply@example\.com>/);
  assert.match(raw,/Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(raw,/Content-Transfer-Encoding: base64/);
  assert.match(raw,new RegExp(Buffer.from("1行目\r\n2行目","utf8").toString("base64")));
});

await ok("PDF添付はmultipart + base64にする",()=>{
  const pdf=new Uint8Array(Buffer.from("%PDF-1.7 test"));
  const {raw}=buildMessage({
    from:"hr@example.com",to:"candidate@example.com",subject:"通知",text:"添付をご確認ください",
    attachments:[{filename:"条件通知書.pdf",content:pdf,contentType:"application/pdf"}]
  },{messageId:"<fixed@example.com>"});
  assert.match(raw,/multipart\/mixed/);
  assert.match(raw,/Content-Type: application\/pdf/);
  assert.match(raw,/Content-Transfer-Encoding: base64/);
  assert.match(raw,new RegExp(Buffer.from(pdf).toString("base64")));
});

console.log(`\n合計 ${pass+fail} 件中 ${pass} 件 通過`);
process.exit(fail?1:0);
