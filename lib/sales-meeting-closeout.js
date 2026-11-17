// ENGER 30-minute Sales meeting closeout policy. Do not persist temporary passwords.
import {randomInt} from "node:crypto";
const upper="ABCDEFGHJKLMNPQRSTUVWXYZ",lower="abcdefghjkmnpqrstuvwxyz",digits="23456789",symbols="!@";
export const OUTCOMES=Object.freeze({
 offer:"オファーあり",reproposal:"再提案",considering:"継続検討",declined:"見送り"
});
export function newMeetingPassword(){
 const selected=[upper[randomInt(upper.length)],lower[randomInt(lower.length)],
  digits[randomInt(digits.length)],symbols[randomInt(symbols.length)]];
 const all=upper+lower+digits+symbols;
 while(selected.length<8)selected.push(all[randomInt(all.length)]);
 for(let i=selected.length-1;i>0;i--){const j=randomInt(i+1);[selected[i],selected[j]]=[selected[j],selected[i]];}
 return selected.join("");
}
export const emailOk=s=>typeof s==="string"&&s.length<=254&&
 /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(s);
export function closeoutInput(b){
 const email=String(b?.email||"").trim().toLowerCase();
 const name=String(b?.contactName||"").trim().slice(0,100);
 const outcome=String(b?.outcome||"");
 const nextAction=String(b?.nextAction||"").trim().slice(0,500);
 const nextDue=b?.nextDue?String(b.nextDue):null;
 if(!emailOk(email))return {error:"invalid_email",hint:"ご案内先のメールアドレスを入力してください。"};
 if(!Object.hasOwn(OUTCOMES,outcome))return {error:"invalid_outcome",hint:"商談結果を選択してください。"};
 if(!nextAction)return {error:"next_action_required",hint:"Salesに引き継ぐ次回アクションを入力してください。"};
 if(nextDue&&!/^\d{4}-\d{2}-\d{2}$/.test(nextDue))
  return {error:"invalid_next_due",hint:"次回対応日を確認してください。"};
 return {value:{email,name,outcome,nextAction,nextDue}};
}
export function proposalMail({companyName,companyId,companyNo,recipientName,portalUrl,password,itemsCount,action}){
 const salutation=recipientName?recipientName+" 様":"ご担当者様";
 const out=["件名：ENGER｜ご提案内容のご案内",
  companyName+" "+salutation,"","本日はお打ち合わせありがとうございました。",
  "ご紹介した人材・案件を、以下の企業専用ページからご確認いただけます。",
  "また、御社の案件や所属人材の情報もご登録いただけます。","",
  "企業専用ページ："+portalUrl,
  "ログインID："+companyNo,
  ...(password?["仮パスワード："+password,
    "仮パスワードは初回ログイン後に変更してください。"]:["登録済みのパスワードでログインしてください。"]),
  "","ご提案した候補："+itemsCount+"件",
  "次回のご案内："+action,
  "","※登録した案件・人材はENGER担当者が確認するまで他社へ公開されません。",
  "※心当たりがない場合は本メールを破棄してください。","株式会社エイト／ENGER"];
 return {subject:"ENGER｜ご提案内容のご案内",text:out.slice(1).join("\n")};
}


// v1 sends exactly the edited subject and body that the Sales member confirmed.
// Account instructions stay visible in that same body; never append an unseen secret.
export function editedProposalMail(input,canonical){
 const subject=String(input?.mailSubject||'').trim();
 const text=String(input?.mailText||'').replace(/\r\n/g,'\n').trim();
 if(!subject||subject.length>200||/[\r\n\u0000-\u001f\u007f]/.test(subject))
  return {error:'invalid_mail_subject',hint:'件名を200文字以内で入力してください。'};
 if(!text||text.length>12000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
  return {error:'invalid_mail_text',hint:'お礼文を12000文字以内で入力してください。'};
 if(!text.includes(canonical.portalUrl)||!text.includes('ログインID：'+canonical.loginId))
  return {error:'login_guidance_required',hint:'本文の企業専用ページURLとログインIDを残してください。'};
 return {value:{subject,text}};
}
