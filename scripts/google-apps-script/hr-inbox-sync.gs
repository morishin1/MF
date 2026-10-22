/**
 * Gmail -> EIGHT HR 新着受付
 * 利用者が所有するGoogle Apps Scriptで動かす。定期トリガーは約9/13/17時 JST。
 * Gmailを自動分類/返信しない。全てHR側の「新着候補」に留める。
 */
const HR_DEST="saiyou@8grp.co.jp";
const HR_MAX_THREADS=30;
const HR_MAX_MESSAGES=30;
const HR_BATCH=10;

function mailAddress_(raw){
  const text=String(raw||"").trim();
  const angle=text.match(/<([^<>]+)>\s*$/);
  const address=(angle?angle[1]:text).toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)?address:"";
}
function isTarget_(msg){
  const to=[msg.getTo(),msg.getCc(),msg.getHeader("Delivered-To")]
    .map(v=>String(v||"").toLowerCase()).join(",");
  return /(^|[^a-z0-9._%+\-])saiyou@8grp\.co\.jp(?=$|[^a-z0-9._%+\-])/i.test(to);
}
function inboxHeaders_(msg){
  // Gmailから返されるメッセージIDを正本にする。件名・差出人の一致では重複判定しない。
  return {
    id:String(msg.getId()),
    recipient:HR_DEST,
    receivedAt:msg.getDate().toISOString(),
    subject:String(msg.getSubject()||"").slice(0,300),
    sender:mailAddress_(msg.getFrom()),
    replyTo:mailAddress_(msg.getReplyTo()),
    text:String(msg.getPlainBody()||"").slice(0,5000)
  };
}
function hex_(bytes){
  return bytes.map(b=>("0"+(b&255).toString(16)).slice(-2)).join("");
}
function sendChunk_(url,secret,messages){
  const payload=JSON.stringify({messages});
  const stamp=String(Math.floor(Date.now()/1000));
  const signature=hex_(Utilities.computeHmacSha256Signature(
    stamp+"."+payload,secret,Utilities.Charset.UTF_8));
  const response=UrlFetchApp.fetch(url,{
    method:"post",contentType:"text/plain; charset=utf-8",
    payload,
    headers:{"X-Eight-Timestamp":stamp,"X-Eight-Signature":signature},
    muteHttpExceptions:true,followRedirects:false
  });
  if(response.getResponseCode()!==200){
    // 本文・secret・送信元はログに出さない。次回に安全に再送できる。
    throw new Error("HR取込APIが応答しました。HTTP "+response.getResponseCode()+
      "。設定・接続・SQLを確認してください。");
  }
  const data=JSON.parse(response.getContentText());
  if(data.ok!==true)throw new Error("HRの取込を完了できませんでした。");
  return {inserted:Number(data.inserted||0),duplicates:Number(data.duplicates||0)};
}
function syncRecruitmentInbox(){
  const props=PropertiesService.getScriptProperties();
  const enabled=props.getProperty("HR_INBOX_DRY_RUN")!=="0";
  const url=String(props.getProperty("HR_INBOX_INGEST_URL")||"");
  const secret=String(props.getProperty("HR_INBOX_SYNC_SECRET")||"");
  if(!/^https:\/\/gw\.8grp\.co\.jp\/api\/hr\/inbox-ingest$/.test(url)||
    secret.length<32)throw new Error("Apps Scriptの接続先URLまたは認証キーを設定してください。");
  const days=Math.max(1,Math.min(7,Number(props.getProperty("HR_INBOX_LOOKBACK_DAYS")||"3")||3));
  const query="to:"+HR_DEST+" newer_than:"+days+"d -in:spam -in:trash -in:sent";
  const threads=GmailApp.search(query,0,HR_MAX_THREADS);
  let candidates=[];
  for(const thread of threads){
    for(const msg of thread.getMessages()){
      if(!isTarget_(msg))continue;
      const date=msg.getDate().getTime();
      if(date<Date.now()-days*86400000||date>Date.now()+600000)continue;
      candidates.push(msg);
    }
  }
  // 重複取得を避け、保留分を先に処理。定期実行毎のAPIは最大3回。
  const seen={};
  candidates=candidates.filter(m=>{
    const id=String(m.getId());if(seen[id])return false;seen[id]=true;return true;
  }).sort((a,b)=>a.getDate()-b.getDate()).slice(0,HR_MAX_MESSAGES);
  if(enabled){
    Logger.log("採用メール取込 DRY RUN：候補 "+candidates.length+"件、送信0件。"+
      "HR_INBOX_DRY_RUN=0 で初めて保存を有効化します。");
    return {dryRun:true,candidates:candidates.length,sent:0};
  }
  let inserted=0,duplicates=0;
  for(let i=0;i<candidates.length;i+=HR_BATCH){
    const chunk=candidates.slice(i,i+HR_BATCH).map(inboxHeaders_);
    const res=sendChunk_(url,secret,chunk);
    inserted+=res.inserted;duplicates+=res.duplicates;
  }
  Logger.log("採用メール取込：新規 "+inserted+"件、重複 "+duplicates+"件（個人情報なし）。");
  return {inserted,duplicates,processed:candidates.length};
}
function installRecruitmentMailTriggers(){
  // 自分が追加したトリガーだけを削除し、再インストールを安全にする。
  ScriptApp.getProjectTriggers().forEach(t=>{
    if(t.getHandlerFunction()==="syncRecruitmentInbox")ScriptApp.deleteTrigger(t);
  });
  [9,13,17].forEach(hour=>{
    ScriptApp.newTrigger("syncRecruitmentInbox").timeBased()
      .atHour(hour).nearMinute(0).everyDays(1).inTimezone("Asia/Tokyo").create();
  });
  Logger.log("採用メール監視トリガーをJSTで3本設定しました。時刻は各時刻の前後15分程度です。");
}
function removeRecruitmentMailTriggers(){
  ScriptApp.getProjectTriggers().forEach(t=>{
    if(t.getHandlerFunction()==="syncRecruitmentInbox")ScriptApp.deleteTrigger(t);
  });
  Logger.log("採用メール監視トリガーを停止しました。");
}
