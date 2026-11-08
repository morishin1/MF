// Salesに保存済みの商談からGoogleカレンダーの「予定作成」画面を作る。
// Google側の「保存」は本人が実行する。APIトークンやパスワードはURLに含めない。
export const DEFAULT_TIMEZONE="Asia/Tokyo";
export const ALLOWED_MINUTES=[30,45,60,90];
export const isValidIsoTime=value=>typeof value==="string"&&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&
  Number.isFinite(Date.parse(value));

export function normalizeMeetingUrl(value){
 const raw=String(value||"").trim();
 if(!raw)return null;
 if(raw.length>1200)return false;
 try{
  const parsed=new URL(raw);
  if(parsed.protocol!=="https:"||!parsed.hostname||parsed.username||parsed.password)return false;
  return parsed.href;
 }catch{return false;}
}
export function validateMeetingCalendarInput(body,now=Date.now()){
 const start=body?.scheduledAt,duration=Number(body?.durationMin||30);
 if(!isValidIsoTime(start))return {error:"bad_date",hint:"商談日時を正しく入力してください。"};
 const timestamp=Date.parse(start);
 if(timestamp<now-300000)return {error:"past_date",hint:"商談日時は現在以降にしてください。"};
 if(timestamp>now+365*86400000)return {error:"too_far",hint:"商談日時は1年以内で指定してください。"};
 if(!ALLOWED_MINUTES.includes(duration))return {error:"bad_duration",hint:"所要時間を選択してください。"};
 const meetingUrl=normalizeMeetingUrl(body?.meetingUrl);
 if(meetingUrl===false)return {error:"bad_url",hint:"商談URLは https:// で始まるURLにしてください。"};
 return {value:{scheduledAt:new Date(timestamp).toISOString(),meetingUrl,durationMin:duration}};
}
const googleIso=iso=>new Date(iso).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
export function googleCalendarEventUrl({companyName,scheduledAt,durationMin=30,meetingUrl,companyMeetingUrl}){
 const start=new Date(scheduledAt);
 if(!Number.isFinite(start.getTime())||!ALLOWED_MINUTES.includes(durationMin))return null;
 const finish=new Date(start.getTime()+durationMin*60000);
 const name=String(companyName||"企業").trim().slice(0,100);
 const lines=[
  "株式会社エイトとの商談",
  meetingUrl ? "オンライン商談URL: "+meetingUrl : "オンライン商談URL: 未設定（必要ならGoogleカレンダーでMeetを追加）",
  companyMeetingUrl ? "企業向け商談ページ（ログイン必須）: "+companyMeetingUrl : "",
 ].filter(Boolean);
 const values=[
  ["action","TEMPLATE"],
  ["text","【エイト商談】"+name],
  ["dates",googleIso(start)+"/"+googleIso(finish)],
  ["stz",DEFAULT_TIMEZONE],
  ["etz",DEFAULT_TIMEZONE],
  ["details",lines.join("\n")],
 ];
 if(meetingUrl)values.push(["location",meetingUrl]);
 return "https://calendar.google.com/calendar/r/eventedit?"+
  values.map(([key,value])=>encodeURIComponent(key)+"="+encodeURIComponent(value)).join("&");
}
