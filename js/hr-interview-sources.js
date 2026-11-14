// 面談用の表示資料URL。URL入力は https のみ許可し、iframe の src に使う前に検証する。
(function(root){
"use strict";
const VISION_URL="https://8grp.co.jp/recruit/vision/";
const DEFAULT={id:"vision",name:"採用ビジョン（標準）",url:VISION_URL,kind:"url",active:true,shareExternal:true};
const BUILTIN={id:"seven",name:"会社紹介 7ページ",kind:"builtin",url:null,active:true,shareExternal:true};
function safeUrl(raw){
 if(typeof raw!=="string"||raw.length>1000||/[\u0000-\u001f\s]/.test(raw))return "";
 try{
  const u=new URL(raw);
  if(u.protocol!=="https:"||!u.hostname||u.username||u.password)return "";
  const host=u.hostname.toLowerCase();
  if(["gw.8grp.co.jp","mf.8grp.co.jp","localhost","127.0.0.1","[::1]"].includes(host)||
    host.endsWith(".localhost")||host.endsWith(".internal")||host.endsWith(".local")||
    /^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host))return "";
  return u.href;
 }catch{return "";}
}
function embedUrl(raw){
 const href=safeUrl(raw);if(!href)return "";
 const u=new URL(href);
 // Google Slidesの編集URLは、スライド本体を表示する埋込URLに変換する。
 const slide=u.hostname==="docs.google.com"?u.pathname.match(/^\/presentation\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/):null;
 if(slide)return "https://docs.google.com/presentation/d/"+slide[1]+"/embed?start=false&loop=false&delayms=3000";
 const drive=u.hostname==="drive.google.com"?u.pathname.match(/^\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/):null;
 if(drive)return "https://drive.google.com/file/d/"+drive[1]+"/preview";
 return href;
}
function fromMaterial(row){
 if(!row||row.active===false||row.kind!=="url"||row.shareExternal!==true)return null;
 const url=safeUrl(row.url);
 if(!url||typeof row.id!=="string"||!row.id)return null;
 return {id:row.id,name:String(row.name||"追加資料").slice(0,160),kind:"url",url,active:true,shareExternal:true};
}
root.HRInterviewSources={DEFAULT,BUILTIN,VISION_URL,safeUrl,embedUrl,fromMaterial};
})(typeof window==="undefined"?globalThis:window);
