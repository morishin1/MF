// Manual PR URL sharing: no X/Meta API, tokens, scheduler, or automatic publishing.
(function(){
 "use strict";
 const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
 const safeUrl=value=>{
  try{const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password?u.toString():null;}
  catch{return null;}
 };
 function render(root){
  if(!root)return;
  root.replaceChildren();
  const card=el("section","mpr-share-card");
  const title=el("div","mpr-share-head");
  title.append(el("h3","","公開したPRのリンクをシェア"),
   el("p","","PR TIMESや各サイトで公開済みのURLを入力し、媒体別の共有文を作ります。"));
  card.append(title);
  const form=el("div","mpr-share-fields");
  const linkLabel=el("label","","公開済みPRのURL");
  const link=el("input");link.type="url";link.placeholder="https://prtimes.jp/main/html/rd/p/...";
  linkLabel.append(link);
  const campaignLabel=el("label","","施策ID（任意：計測URL用）");
  const campaign=el("input");campaign.placeholder="202610_press";
  campaignLabel.append(campaign);
  form.append(linkLabel,campaignLabel);card.append(form);
  const actions=el("div","mpr-share-actions");
  const status=el("p","mpr-share-status");status.setAttribute("role","status");
  const share=channel=>{
   const url=safeUrl(link.value.trim());
   if(!url){status.textContent="https://で始まる公開済みPRのURLを入力してください。";return null;}
   const id=campaign.value.trim().toLowerCase();
   if(!id)return url;
   try{return window.MarketingOmniDashboard.buildUtm(url,channel,id,channel+"_pr");}
   catch(e){status.textContent=e.message||"施策IDを確認してください。";return null;}
  };
  const copy=async(channel,prefix)=>{
   const url=share(channel);if(!url)return;
   const body=(prefix?prefix+"\n":"")+url;
   if(!navigator.clipboard?.writeText){status.textContent="クリップボードへコピーできません。URLを選択してコピーしてください。";return;}
   try{await navigator.clipboard.writeText(body);status.textContent="共有文をコピーしました。まだ投稿されていません。";}
   catch{status.textContent="コピーできませんでした。ブラウザの権限を確認してください。";}
  };
  const x=el("button","mpr-share-button","Xでシェア");x.type="button";
  x.onclick=()=>{
   const url=share("x");if(!url)return;
   const text="プレスリリースを公開しました。";
   const u=new URL("https://x.com/intent/tweet");
   u.searchParams.set("text",text);u.searchParams.set("url",url);
   // This opens the regular composer only, NOT an API publish call.
   window.open(u.toString(),"_blank","noopener,noreferrer");
   status.textContent="Xの投稿画面を開きました。公開するにはX側で投稿してください。";
  };
  const insta=el("button","mpr-share-button","Instagram用リンクをコピー");insta.type="button";
  insta.onclick=()=>copy("instagram","");
  const instaText=el("button","mpr-share-button","Instagram紹介文をコピー");instaText.type="button";
  instaText.onclick=async()=>{
   if(!share("instagram"))return;
   try{await navigator.clipboard.writeText("プレスリリースを公開しました。詳しくはプロフィールのリンク、またはストーリーズのリンクスタンプから。");
       status.textContent="紹介文をコピーしました。ストーリーズのリンクスタンプには別途URLを貼ってください。";}
   catch{status.textContent="コピーできませんでした。";}
  };
  const fb=el("button","mpr-share-button","Facebook用リンクをコピー");fb.type="button";
  fb.onclick=()=>copy("facebook","プレスリリースを公開しました。");
  const line=el("button","mpr-share-button","LINE用リンクをコピー");line.type="button";
  line.onclick=()=>copy("line","プレスリリースのお知らせ");
  const mail=el("button","mpr-share-button","ブラストメール用リンクをコピー");mail.type="button";
  mail.onclick=()=>copy("blastmail","新しいお知らせを公開しました。詳細はこちら：");
  actions.append(x,insta,instaText,fb,line,mail);card.append(actions,status);
  card.append(el("p","mpr-share-hint","Instagramの通常投稿のキャプションにURLを書いても、多くのアカウントではタップ可能なリンクになりません。ストーリーズのリンクスタンプ、プロフィールのリンク欄から誘導します。"));
  card.append(el("p","mpr-share-hint","X・Instagram・Facebook・LINE・ブラストメールの自動投稿APIは使いません。コピーと公式画面での手動共有のみです。"));
  card.append(el("p","mpr-share-hint","計測の注意：自社GA4でアクセスを測るには自社サイトの記事・LPをリンク先にしてください。PR TIMESのURLをシェアしたアクセスは自社サイトのPVとしては計測できません。"));
  root.append(card);
 }
 window.MarketingManualShare={render};
})();
