// Handoff-inspired PR working copy. Browser-only; real persistence/approval/publication
// remains at the existing authorized 8sp editor. Never makes network or write calls.
(function(){
"use strict";
const CHANNELS=[
  {id:"corp",label:"コーポレート",kind:"サイト"},
  {id:"dojo",label:"無限道場",kind:"サイト"},
  {id:"space",label:"EIGHT SPACE",kind:"サイト"},
  {id:"machi",label:"AIまち",kind:"サイト"},
  {id:"x",label:"X",kind:"SNS",max:140},
  {id:"instagram",label:"Instagram",kind:"SNS",max:2200},
  {id:"facebook",label:"Facebook",kind:"SNS"},
  {id:"line",label:"LINE公式",kind:"SNS"},
  {id:"blastmail",label:"ブラストメール",kind:"メール"}
];
const STEPS=["PR原稿を作成","公開先ごとに調整","プレビュー・確認","公開・履歴を記録","アクセスを分析"];
const captions=["タイトル・背景・特徴","文章・配信リンク","媒体ごとに内容確認","既存の公開画面で実施","公開後の成果を比較"];
const h=(tag,c,text)=>{const x=document.createElement(tag);if(c)x.className=c;if(text!==undefined)x.textContent=String(text);return x;};
const txt=v=>String(v||"").trim();
const initial=()=>({step:0,draft:{title:"",lead:"",background:"",features:"",contact:"",url:""},selected:new Set(["corp","dojo","x","instagram","blastmail"]),active:"corp",bodies:{},reviewed:{},error:""});
let state=initial(),root=null;
function baseText(c){
 const d=state.draft;
 const title=txt(d.title),lead=txt(d.lead),url=txt(d.url),features=txt(d.features),background=txt(d.background);
 if(c.id==="x")return [title?"【"+title+"】":"",lead.slice(0,70),url].filter(Boolean).join("\n");
 if(c.id==="instagram")return [title,lead,features,url].filter(Boolean).join("\n\n");
 if(c.id==="blastmail")return [title,lead,features,txt(d.contact),url].filter(Boolean).join("\n\n");
 if(c.id==="line")return [title,lead,url].filter(Boolean).join("\n");
 return [title,lead,background?"■ 背景\n"+background:"",features?"■ 特徴\n"+features:"",url?"詳細："+url:""].filter(Boolean).join("\n\n");
}
const copyOf=c=>Object.hasOwn(state.bodies,c.id)?state.bodies[c.id]:baseText(c);
function valid(){
 if(!txt(state.draft.title)){state.error="PRのタイトルを入力してください。";return false;}
 if(txt(state.draft.url)){
   let url;try{url=new URL(state.draft.url);}catch{state.error="誘導先URLは https:// から入力してください。";return false;}
   if(url.protocol!=="https:"||url.username||url.password){state.error="安全なhttps://のURLを入力してください。";return false;}
 }
 if(!state.selected.size){state.error="公開先を1つ以上選んでください。";return false;}
 state.error="";return true;
}
function field(label,key,multiline=false,placeholder=""){
 const x=h("label","mkh-pr-field");x.append(h("span","",label));
 const input=h(multiline?"textarea":"input");
 if(!multiline)input.type="text";else input.rows=key==="background"||key==="features"?4:3;
 input.value=state.draft[key];input.placeholder=placeholder;
 input.oninput=()=>{state.draft[key]=input.value;state.reviewed={};state.error="";};
 x.append(input);return x;
}
const note=(s,c="mkh-pr-note")=>h("p",c,s);
function first(box){
 box.append(field("タイトル（必須）","title",false,"何を発表するのかを簡潔に"));
 box.append(field("概要・リード文","lead",true,"120文字程度の概要"));
 const row=h("div","mkh-pr-two");row.append(field("背景","background",true),field("特徴","features",true));box.append(row);
 const row2=h("div","mkh-pr-two");row2.append(field("問い合わせ先","contact"),field("誘導先URL","url",false,"https://8grp.co.jp/"));box.append(row2);
 box.append(note("これは一時的な下書きです。画像の登録・正式保存は既存の8spリリース編集画面を利用してください。"));
}
function second(box){
 const grid=h("div","mkh-pr-split"),left=h("div","mkh-pr-mediums"),right=h("div","mkh-pr-editor");
 left.append(h("h4","","公開先"));
 for(const c of CHANNELS){
   const line=h("div","mkh-pr-media"+(state.active===c.id?" active":""));
   const check=h("input");check.type="checkbox";check.checked=state.selected.has(c.id);check.setAttribute("aria-label",c.label+"を公開先にする");
   check.onchange=()=>{check.checked?state.selected.add(c.id):state.selected.delete(c.id);state.reviewed={};render();};
   const choose=h("button","",c.label);choose.type="button";choose.onclick=()=>{state.active=c.id;render();};
   line.append(check,choose,h("small","",c.kind));left.append(line);
 }
 const c=CHANNELS.find(c=>c.id===state.active)||CHANNELS[0];
 right.append(h("h4","",c.label+"向け本文"),note("元のPRからテンプレートで展開。内容は手動で編集できます。"));
 const input=h("textarea");input.value=copyOf(c);input.rows=13;
 const n=h("small","mkh-pr-counter");
 const update=()=>{n.textContent=input.value.length+(c.max?" / "+c.max:"")+" 字";n.className="mkh-pr-counter"+(c.max&&input.value.length>c.max?" over":"");};
 input.oninput=()=>{state.bodies[c.id]=input.value;state.reviewed[c.id]=false;update();};
 right.append(input,n);update();grid.append(left,right);box.append(grid);
 box.append(note("公開操作は未接続です。配信リンクには拡散タブで計測用UTMを設定してください。"));
}
function third(box){
 const cards=h("div","mkh-pr-previews");
 for(const c of CHANNELS.filter(c=>state.selected.has(c.id))){
   const item=h("div","mkh-pr-preview");
   const top=h("div","mkh-pr-preview-head");
   top.append(h("b","",c.label),h("small",state.reviewed[c.id]?"mkh-pr-checked":"mkh-pr-unchecked",state.reviewed[c.id]?"確認済み":"未確認"));
   const body=h("p","",copyOf(c)||"本文は未入力です。");body.style.whiteSpace="pre-wrap";
   const btn=h("button","mkh-pr-check",state.reviewed[c.id]?"確認を取り消す":"内容を確認した");btn.type="button";
   btn.onclick=()=>{state.reviewed[c.id]=!state.reviewed[c.id];render();};
   item.append(top,body,btn);cards.append(item);
 }
 box.append(cards);
 box.append(note("確認状態はこの端末内の一時表示です。承認者への依頼・承認記録は送信されません。"));
}
function fourth(box){
 box.append(h("h4","","公開先ごとの実際の配信について"));
 box.append(note("このプレビューからSNSや各サイト、ブラストメールへは送信しません。権限のある各媒体で投稿し、公開URLと日時を確認してください。"));
 const row=h("div","mkh-pr-actions");
 const copy=h("button","mkh-pr-next","本文をまとめてコピー");copy.type="button";
 const status=h("span","mkh-pr-note");
 copy.onclick=async()=>{
   const body=CHANNELS.filter(c=>state.selected.has(c.id)).map(c=>"【"+c.label+"】\n"+copyOf(c)).join("\n\n----\n\n");
   if(!navigator.clipboard?.writeText){status.textContent="自動コピーが使えません。本文を選択してコピーしてください。";return;}
   try{await navigator.clipboard.writeText(body);status.textContent="コピーしました（まだ投稿されていません）。";}
   catch{status.textContent="コピーできませんでした。ブラウザの許可をご確認ください。";}
 };
 const link=h("a","mkh-pr-back","8spで正式なPR草案を編集");
 link.href="https://8sp.jp/member/release.html?id=new";link.target="_blank";link.rel="noopener noreferrer";
 row.append(copy,link,status);box.append(row);
}
function fifth(box){
 box.append(h("h4","","公開後7日・30日の成果"));
 box.append(note("記事別PV・SNS反応・ブラストメールの配信結果・問い合わせへの帰属は未連携です。計測が有効になるまで結果を0件と表示しません。"));
 const b=h("button","mkh-pr-next","効果分析タブへ");b.type="button";
 b.onclick=()=>document.querySelector('#mkt-tab-analytics')?.click();box.append(b);
}
function render(){
 if(!root)return;
 root.replaceChildren();
 const steps=h("ol","mkh-pr-stepper");
 for(let i=0;i<STEPS.length;i++){
  const li=h("li",i===state.step?"current":i<state.step?"finished":"");
  const button=h("button");button.type="button";button.setAttribute("aria-current",i===state.step?"step":"false");
  button.append(h("span","mkh-pr-step-n",i+1),h("b","",STEPS[i]),h("small","",captions[i]));
  button.onclick=()=>{if(i>0&&!valid()){render();return;}state.step=i;render();};
  li.append(button);steps.append(li);
 }
 root.append(steps);
 const section=h("section","mkh-card mkh-pr-card");
 const heading=h("div","mkh-cardhead");const left=h("div");
 left.append(h("h3","","0"+(state.step+1)+"　"+STEPS[state.step]),h("p","",state.draft.title||"新規PR"));
 heading.append(left,h("small","mkh-pr-unsaved","未保存（確認用）"));section.append(heading);
 const body=h("div","mkh-pr-body");
 [first,second,third,fourth,fifth][state.step](body);
 if(state.error)body.prepend(note(state.error,"mkh-pr-error"));
 section.append(body);
 const footer=h("div","mkh-pr-foot");
 const back=h("button","mkh-pr-back","戻る");back.type="button";back.disabled=state.step===0;
 back.onclick=()=>{state.step--;state.error="";render();};footer.append(back);
 if(state.step<4){
   const next=h("button","mkh-pr-next",["公開先ごとに調整","プレビューへ","公開方法を確認","効果分析へ"][state.step]);next.type="button";
   next.onclick=()=>{
     if(!valid()){render();return;}
     if(state.step===2){
       const selected=CHANNELS.filter(c=>state.selected.has(c.id));
       if(selected.some(c=>!state.reviewed[c.id]||(c.max&&copyOf(c).length>c.max))){
          state.error="すべての公開先の内容を確認し、文字数制限を満たしてください。";render();return;
       }
     }
     state.step++;state.error="";render();
   };footer.append(next);
 }
 section.append(footer);root.append(section);
 root.append(note("ブラウザ内の一時下書きです。再読み込みすると消えます。保存・承認・公開・メール配信は行いません。"));
}
window.MarketingHandoffComposer={mount(node){root=node;render();},reset(){state=initial();render();},snapshot(){return {step:state.step,title:state.draft.title,selected:[...state.selected]};}};
})();