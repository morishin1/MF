// HR新着メール：取り込み/重複/テナント隔離/応募者リンク/未読と未対応/登録＋紐づけをモックDBで検証。
// 実DB・Gmail・メール送信には一切つながない（架空データのみ）。
import assert from "node:assert/strict";
import {mock} from "node:test";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {createMemDb} from "./_memdb.mjs";
const root=dirname(dirname(fileURLToPath(import.meta.url))),at=p=>join(root,p);
const read=p=>readFileSync(at(p),"utf8");
const sql=read("db/147_hr_inbound_mail.sql"),page=read("hr/inbox.html");
const reads=read("db/proposal_hr_inbox_reads.sql");
assert.match(sql,/unique\(tenant_id,provider,provider_message_id\)/);
assert.match(sql,/enable row level security/);
assert.match(sql,/gw_is_recruiting\(tenant_id\)/);
assert.match(sql,/check \(\(status='linked'\)=\(applicant_id is not null\)\)/);
assert.match(reads,/primary key \(mail_id, user_id\)/,"既読は人×メールで1行");
assert.match(reads,/user_id = auth\.uid\(\) and public\.gw_is_recruiting\(tenant_id\)/,"読めるのは自分の既読だけ");
assert.match(reads,/revoke all on public\.gw_hr_inbound_mail_reads from anon, authenticated/,"画面から直接書かせない");
assert.match(reads,/tenant mismatch/,"別テナントのメールに既読を作らせない");
assert.doesNotMatch(page,/eval\s*\(/);
assert.ok(!/innerHTML\s*=\s*(currentMail|m)\.body_text\s*[;,)]/.test(page)&&/innerHTML=currentMail\.body_text\?view\.html:/.test(page),"本文はlinkify（エスケープ済み）を通してから表示する");
const script=page.match(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/)?.[0].replace(/<script>|<\/script>/g,"");
assert.ok(script);
new Script(script);

const T1="11111111-1111-4111-8111-111111111111",T2="22222222-2222-4222-8222-222222222222";
const U1="12345678-1234-4234-8234-000000000003",U2="12345678-1234-4234-8234-000000000009";
const stamp=(()=>{let n=0;return()=>new Date(Date.UTC(2026,9,24,0,0,n++)).toISOString();})();
const mem=createMemDb({
 schema:{
  gw_hr_inbound_mail:{unique:[["tenant_id","provider","provider_message_id"]],
   defaults:()=>({status:"new",applicant_id:null,spot_talent_id:null,deleted_at:null,created_at:stamp(),updated_at:stamp()}),
   check:r=>((r.status==="linked")!==([r.applicant_id,r.spot_talent_id].filter(Boolean).length===1))?"link_guard":null},
  gw_hr_inbound_mail_reads:{unique:[["mail_id","user_id"]],noId:true},
  gw_hr_applicants:{defaults:()=>({stage:"applied",status:"todo",created_at:stamp(),updated_at:stamp()})},
  gw_hr_timeline:{defaults:()=>({occurred_at:stamp()})},
 },
});
const db=mem.admin();
const rowsOf=async(t,f={})=>{let q=db.from(t).select("*");for(const[k,v]of Object.entries(f))q=q.eq(k,v);return (await q).data||[];};
await db.from("gw_hr_applicants").insert({id:"12345678-1234-4234-8234-000000000001",tenant_id:T1,name:"架空 既存",email:"kizon@example.com",job_title:"営業",source:"Wantedly"});
await db.from("gw_hr_applicants").insert({id:"12345678-1234-4234-8234-0000000000aa",tenant_id:T2,name:"他社の人",email:"other@example.com",job_title:"営業",source:"Green"});
await db.from("gw_employees").insert({id:"e1",tenant_id:T1,user_id:U1,display_name:"採用担当A",status:"active"});

let role="recruiter",me=U1,tenant=T1;const audit=[];
mock.module(at("lib/supabase.js"),{namedExports:{admin:()=>db,userClient:()=>db}});
mock.module(at("lib/auth.js"),{namedExports:{requireUser:async()=>({id:me}),getMemberships:async()=>[]}});
mock.module(at("lib/gw.js"),{namedExports:{gwContext:async()=>({tenantId:tenant,roles:[role],employee:{id:"e1"}}),
 canRecruit:c=>c.roles.includes("recruiter"),canSeeSalary:()=>false}});
mock.module(at("lib/gw-audit.js"),{namedExports:{gwLog:async(e)=>{audit.push(e);}}});
mock.module(at("lib/notify.js"),{namedExports:{notify:async()=>({created:0})}});
const {default:handler,registeredMark}=await import(at("api/hr/inbox.js"));
const fakeRes=()=>({statusCode:0,body:null,headers:{},setHeader(k,v){this.headers[k]=v;},end(x){this.body=JSON.parse(x);}});
async function act(body,method="POST",url="/api/hr/inbox"){
 const res=fakeRes();
 await handler({method,url,body},res);
 return res;
}
let pass=0;const ok=(c,m)=>{assert.ok(c,m);pass++;};
const entry={action:"import",provider:"manual",providerMessageId:"abc123",recipient:"saiyou@8grp.co.jp",
 receivedAt:"2026-10-23T09:00:00+09:00",subject:"【Wantedly】架空 太郎さんから応募がありました",senderAddress:"no-reply@wantedly.com",
 candidateName:"架空 太郎",source:"Wantedly",bodyText:"氏名：架空 太郎\nメールアドレス：taro@example.com\n詳細 https://www.wantedly.com/x"};
let r=await act({...entry,provider:"gmail"});
ok(r.statusCode===409&&r.body.error==="source_not_connected","Gmail未接続時に送信元を偽装できない");
r=await act(entry);ok(r.statusCode===201,JSON.stringify(r.body));
const mailId=r.body.mail.id;
r=await act(entry);ok(r.statusCode===200&&r.body.duplicate===true,"同じ受信IDは二重作成しない");
ok((await rowsOf("gw_hr_inbound_mail")).length===1,"1件のみ");
r=await act({...entry,providerMessageId:"bad-recipient",recipient:"external@example.com"});
ok(r.statusCode===400,"採用窓口以外の宛先は拒否");

// ---- 一覧：本文は含めない・未読/未対応は別 ----
r=await act({},"GET");
ok(r.statusCode===200&&r.body.newCount===1&&r.body.openCount===1,"新着1・未対応1");
ok(!("body_text" in r.body.mails[0]),"一覧に本文を載せない（開いたときに取る）");
ok(r.body.mails[0].read===false&&r.body.unreadCount===1&&r.body.readsReady===true,"自分は未読");
r=await act({},"GET","/api/hr/inbox?count=1");
ok(r.body.openCount===1&&r.body.unreadCount===1&&r.body.newCount===1,"件数APIも同じ");
// 詳細を取っただけでは既読にしない（表示できたあとに画面が read を送る）
r=await act({},"GET","/api/hr/inbox?id="+mailId);
ok(r.statusCode===200&&r.body.mail.body_text.includes("taro@example.com"),"詳細は本文を返す");
ok(r.body.mail.read===false,"詳細の取得だけでは既読にしない");
r=await act({action:"read",id:mailId});ok(r.statusCode===200&&r.body.ok===true,"既読を記録");
r=await act({action:"read",id:mailId});ok(r.statusCode===200&&r.body.ok===true,"既読の二重記録は無害");
ok((await rowsOf("gw_hr_inbound_mail_reads")).length===1,"既読は1行だけ");
r=await act({},"GET","/api/hr/inbox?count=1");
ok(r.body.unreadCount===0&&r.body.openCount===1,"既読でも未対応のまま（開いただけで対応済みにしない）");
ok((await rowsOf("gw_hr_inbound_mail"))[0].status==="new","既読は状態を変えない");
me=U2;r=await act({},"GET","/api/hr/inbox?count=1");
ok(r.body.unreadCount===1,"既読は人ごと（別の担当者には未読）");
me=U1;
// 既読の表が未適用：未読は null（0件にしない）、画面の操作は止めない
mem.state.missing="gw_hr_inbound_mail_reads";
r=await act({},"GET","/api/hr/inbox?count=1");
ok(r.statusCode===200&&r.body.unreadCount===null&&r.body.readsReady===false&&r.body.openCount===1,"既読表なし→未読は確認できない");
r=await act({action:"read",id:mailId});ok(r.statusCode===200&&r.body.ok===false&&r.body.readsReady===false,"既読表なしでも落ちない");
mem.state.missing=null;

// ---- 状態：確認中／対応終了（理由必須）／未対応に戻す ----
r=await act({action:"review",id:mailId,status:"ignored",note:""});
ok(r.statusCode===400&&r.body.error==="reason_required","対応終了は理由必須");
r=await act({action:"review",id:mailId,status:"review",note:"確認します"});ok(r.statusCode===200,"確認中にできる");
r=await act({},"GET","/api/hr/inbox?count=1");ok(r.body.openCount===1&&r.body.newCount===0,"確認中も未対応に数える");
r=await act({action:"review",id:mailId,status:"ignored",note:"営業メールのため"});ok(r.statusCode===200,"理由つきで対応終了");
r=await act({},"GET","/api/hr/inbox?count=1");ok(r.body.openCount===0,"対応終了は未対応から外れる");
ok(audit.some(a=>a.action==="hr.inbound_review"&&a.detail.from==="review"&&a.detail.status==="ignored"),"変更前後を監査ログに残す");
r=await act({action:"review",id:mailId,status:"new",note:""});ok(r.statusCode===200,"未対応に戻せる");
r=await act({},"GET","/api/hr/inbox?count=1");ok(r.body.openCount===1,"戻すと未対応に入る");

// ---- 登録＋紐づけ ----
let cur=(await rowsOf("gw_hr_inbound_mail"))[0];
const applicant={name:"架空 太郎",email:"taro@example.com",jobTitle:"営業",source:"Wantedly"};
r=await act({action:"register",id:mailId,applicant});
ok(r.statusCode===400&&r.body.error==="expect_required","画面の版なしでは登録しない");
r=await act({action:"register",id:mailId,expectUpdatedAt:"2000-01-01T00:00:00.000Z",applicant});
ok(r.statusCode===409&&r.body.error==="stale_record","古い画面からは登録しない（同時操作）");
ok((await rowsOf("gw_hr_applicants",{tenant_id:T1})).length===1,"止めたときは応募者を作らない");
// 既存と同じメール → 重複候補で止まる（画面で見せていない）
r=await act({action:"register",id:mailId,expectUpdatedAt:cur.updated_at,applicant:{...applicant,email:"KIZON@example.com"}});
ok(r.statusCode===409&&r.body.error==="duplicate_candidates"&&r.body.candidates.length===1,"同じメールの応募者がいれば止める");
ok(!r.body.candidates.some(c=>c.email==="other@example.com"),"他テナントの応募者を候補に出さない");
ok((await rowsOf("gw_hr_inbound_mail"))[0].status==="new","止めたときはメールを処理済みにしない");
// 必須欠け → 応募者は作らず、メールもそのまま
r=await act({action:"register",id:mailId,expectUpdatedAt:cur.updated_at,applicant:{...applicant,source:""}});
ok(r.statusCode===400&&r.body.mailUnchanged===true,"入力エラーはメールを変えない");
cur=(await rowsOf("gw_hr_inbound_mail"))[0];
ok(cur.status==="new"&&cur.applicant_id===null,"メールは未対応のまま");
ok(r.body.updatedAt===cur.updated_at,"再試行用に新しい版を返す");
// 正常（表記が違っても同じ時刻なら受け付ける：DB は +00:00、前回の応答は Z で返ることがある）
r=await act({action:"register",id:mailId,expectUpdatedAt:cur.updated_at.replace("Z","+00:00"),applicant});
ok(r.statusCode===200&&r.body.created===true,JSON.stringify(r.body));
const newId=r.body.applicantId;
cur=(await rowsOf("gw_hr_inbound_mail"))[0];
ok(cur.status==="linked"&&cur.applicant_id===newId,"登録できたときだけ登録済み");
const tl=await rowsOf("gw_hr_timeline",{applicant_id:newId});
ok(tl.length===1&&tl[0].detail===registeredMark(mailId),"応募タイムラインに受付IDの目印");
ok(audit.some(a=>a.action==="hr.inbound_link"&&a.detail.created===true),"登録＋紐づけを監査ログに残す");
// 二重クリック相当：同じ版で再送 → 登録済みなので変更不可（応募者は増えない）
r=await act({action:"register",id:mailId,expectUpdatedAt:cur.updated_at,applicant});
ok(r.statusCode===409&&r.body.error==="already_linked","紐づけ済みは再登録しない");
ok((await rowsOf("gw_hr_applicants",{tenant_id:T1})).length===2,"応募者は1人だけ増えた");

// ---- 登録だけ成功して紐づけに失敗 → 再試行で二重登録しない ----
await act({...entry,providerMessageId:"m2",subject:"別の応募"});
const m2=(await rowsOf("gw_hr_inbound_mail",{provider_message_id:"m2"}))[0];
// 前回の登録で作られた応募者（目印つき）だけがある状態を作る
await db.from("gw_hr_applicants").insert({id:"12345678-1234-4234-8234-0000000000bb",tenant_id:T1,name:"架空 次郎",job_title:"事務",source:"Green"});
await db.from("gw_hr_timeline").insert({tenant_id:T1,applicant_id:"12345678-1234-4234-8234-0000000000bb",event_key:"applied",label:"応募",detail:registeredMark(m2.id)});
r=await act({action:"register",id:m2.id,expectUpdatedAt:m2.updated_at,applicant:{name:"架空 次郎",jobTitle:"事務",source:"Green"}});
ok(r.statusCode===200&&r.body.created===false&&r.body.applicantId==="12345678-1234-4234-8234-0000000000bb","前回作った応募者に紐づけ直す");
ok((await rowsOf("gw_hr_applicants",{tenant_id:T1})).length===3,"再試行で応募者を増やさない");

// ---- 同時に2人が登録：先に札を取った1人だけが進む ----
await act({...entry,providerMessageId:"m3",subject:"同時操作"});
const m3=(await rowsOf("gw_hr_inbound_mail",{provider_message_id:"m3"}))[0];
const body3={action:"register",id:m3.id,expectUpdatedAt:m3.updated_at,applicant:{name:"架空 三郎",jobTitle:"営業",source:"Indeed"}};
const [a,b]=await Promise.all([act(body3),act(body3)]);
ok([a.statusCode,b.statusCode].sort().join()==="200,409","同時の2回目は止まる");
ok((await rowsOf("gw_hr_applicants",{tenant_id:T1})).filter(x=>x.name==="架空 三郎").length===1,"同時操作でも1人だけ");

// ---- 紐づけ ----
await act({...entry,providerMessageId:"m4",subject:"既存の人"});
const m4=(await rowsOf("gw_hr_inbound_mail",{provider_message_id:"m4"}))[0];
r=await act({action:"link",id:m4.id,applicantId:"12345678-1234-4234-8234-0000000000aa"});
ok(r.statusCode===404,"他テナントの応募者へリンクしない");
r=await act({action:"link",id:m4.id,applicantId:"12345678-1234-4234-8234-000000000001"});
ok(r.statusCode===200&&r.body.created===false,"既存の応募者に紐づけ");
r=await act({action:"review",id:m4.id,status:"ignored",note:"誤登録"});
ok(r.statusCode===409,"紐づけ済みは編集禁止");

// ---- 権限・テナント ----
tenant=T2;r=await act({},"GET","/api/hr/inbox?id="+mailId);ok(r.statusCode===404,"他テナントのメールは見えない");
r=await act({action:"read",id:mailId});ok(r.statusCode===404,"他テナントのメールに既読を付けられない");
tenant=T1;
role="sales";r=await act({},"GET");ok(r.statusCode===403,"採用権限以外は読み取り拒否");
r=await act({},"GET","/api/hr/inbox?count=1");ok(r.statusCode===403,"件数も採用権限のみ");
console.log(`HR新着受付API：取込・未読/未対応・状態・登録＋紐づけ・同時操作・権限 ${pass}ケース PASS`);
