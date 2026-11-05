// Slackからグループウェアの本人タスクへ。文字列・署名・メッセージ判定は副作用なし。
import {createHmac,timingSafeEqual} from "node:crypto";

export function verifySlackSignature({secret,body,timestamp,signature,now=Date.now()}) {
  if(!secret||typeof body!=="string"||!/^\d{10}$/.test(String(timestamp||"")))return false;
  const age=Math.abs(now/1000-Number(timestamp));
  if(!Number.isFinite(age)||age>300)return false;
  const expected="v0="+createHmac("sha256",secret).update("v0:"+timestamp+":"+body).digest("hex");
  const lhs=Buffer.from(expected),rhs=Buffer.from(String(signature||""));
  return lhs.length===rhs.length&&timingSafeEqual(lhs,rhs);
}

export function slackRequestTask(event,{targetUserId,channels,workspaceId}={}) {
  if(!event||event.type!=="message"||event.subtype||event.bot_id||!event.user)return null;
  if(!targetUserId||!Array.isArray(channels)||!channels.length||!/^[UW][A-Z0-9]+$/.test(targetUserId))return null;
  const channel=String(event.channel||"");
  const ts=String(event.ts||"");
  if(!channels.includes(channel)||!/^[CGD][A-Z0-9]+$/.test(channel)||!/^\d{10,12}\.\d{6}$/.test(ts))return null;
  if(event.user===targetUserId)return null;
  const text=String(event.text||"");
  if(!new RegExp("<@"+targetUserId+"(?:\\|[^>]*)?>").test(text))return null;
  if(!/(ご?確認|ご?対応|ご?判断|ご?返信|回答|修正|依頼|お願い|承認|決裁|レビュー|調査|見積|チェック)/.test(text))return null;
  const cleaned=text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g,"")
    .replace(/<([^|<>]+)\|([^<>]+)>/g,"$2").replace(/<([^<>]+)>/g,"$1")
    .replace(/\s+/g," ").trim();
  if(!cleaned)return null;
  const title=cleaned.slice(0,170);
  const link="https://app.slack.com/archives/"+channel+"/p"+ts.replace(".","");
  const key="slack:"+String(workspaceId||"")+":"+channel+":"+ts;
  return {title,link,key,priority:/(至急|緊急|急ぎ|本日中|今日中)/.test(text)?"high":"normal"};
}
