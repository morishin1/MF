// Marketing PR TIMES draft composer. Uses the EXACT 8sp SpaceRelease formatting rules.
// Confirmation-only: temporary browser state; no publish, API write or persistence.
(function(){
"use strict";
const R=window.SpaceRelease;
if(!R)throw Error("SpaceRelease formatter must load before composer");
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
const STEPS=["PR TIMES原稿を作る","公開先別に調整","原稿をプレビュー","コピー・公開確認","結果を分析"];
const CAPTIONS=["事実を入力して草案化","サイト・SNS・メール","全文と媒体別の確認","各媒体で手動公開","PV・流入・問い合わせ"];
const h=(tag,c,text)=>{const x=document.createElement(tag);if(c)x.className=c;if(text!==undefined)x.textContent=String(text);return x;};
const trim=v=>String(v==null?"":v).trim();
const empty=()=>({
 kind:"service",title:"",subtitle:"",summary:"",background:"",features:[{title:"",body:""}],
 event_on:"",event_end_on:"",event_start:"",event_end:"",event_allday:false,event_time_tbd:false,
 event_date:"",venue:"",venue_name:"",venue_address:"",fee_type:"",fee_amount:"",fee_tax:"incl",
 partner:"",target:"",url:"",future:"",company:"株式会社エイト",company_kana:"",
 representative:"",founded:"",location:"",business:"",company_url:"",
 contact_dept:"",contact_name:"",contact_tel:"",contact_email:"",contact_hours:"",images:[]
});
const initial=()=>({step:0,draft:empty(),selected:new Set(["corp","dojo","x","instagram","blastmail"]),active:"corp",bodies:{},reviewed:{},override:"",overrideOutdated:false,editing:false,error:""});
let state=initial(),root=null;
const textNow=()=>state.override?state.override:R.buildDraft(state.draft);
function baseText(c){
 const d=state.draft,title=trim(d.title),lead=trim(d.summary),url=trim(d.url);
 const feature=d.features.filter(f=>trim(f.title)||trim(f.body)).map(f=>[trim(f.title),trim(f.body)].filter(Boolean).join("：")).join("\n");
 if(c.id==="x")return [title?"【"+title+"】":"",lead.slice(0,68),url].filter(Boolean).join("\n");
 if(c.id==="instagram")return [title,lead,feature,url].filter(Boolean).join("\n\n");
 if(c.id==="blastmail")return [title,lead,feature,trim(d.contact_dept),url].filter(Boolean).join("\n\n");
 if(c.id==="line")return [title,lead,url].filter(Boolean).join("\n");
 return currentDraft();
}
const channelText=c=>Object.hasOwn(state.bodies,c.id)?state.bodies[c.id]:baseText(c);
function changed(){state.reviewed={};if(state.override)state.overrideOutdated=true;state.error="";}
function legalURL(s){
 if(!trim(s))return true;
 try{const u=new URL(s);return u.protocol==="https:"&&!u.username&&!u.password;}catch{return false;}
}
function valid(){
 const missing=R.missing(state.draft);
 if(missing.length){state.error="PR TIMES草案に必要な項目：" + missing.join("・");return false;}
 for(const name of ["url","company_url"]){
  if(!legalURL(state.draft[name])){state.error=(name==="url"?"詳細URL":"会社URL")+"は https:// から入力してください。";return false;}
 }
 if(state.draft.images.some(i=>!i.caption)){
  state.error="掲載する画像の説明を入力してください。";return false;
 }
 if(state.draft.fee_type==="paid"&&!(Number(state.draft.fee_amount)>0)){
   state.error="有料の場合は料金（円）を入力してください。";return false;
 }
 if(state.draft.event_end_on&&state.draft.event_on&&state.draft.event_end_on<state.draft.event_on){
   state.error="終了日は開始日以降にしてください。";return false;
 }
 if(!state.selected.size){state.error="公開先を1件以上選んでください。";return false;}
 state.error="";return true;
}
function field(label,key,opts={}){
 const wrap=h("label","mkh-pr-field");
 const title=h("span","",label);
 if(opts.required)title.append(h("b","mkh-pr-required","必須"));
 const count=h("small","mkh-pr-fieldcount");
 if(opts.max&&opts.max<=600)title.append(count);
 wrap.append(title);
 const input=h(opts.multi?"textarea":opts.select?"select":"input");
 if(opts.select){
   for(const [value,text] of opts.select){const o=h("option","",text);o.value=value;input.append(o);}
 }else if(opts.multi)input.rows=opts.rows||3;
 else input.type=opts.type||"text";
 if(opts.max)input.maxLength=opts.max;
 if(!opts.select)input.placeholder=opts.placeholder||"";
 input.value=state.draft[key]||"";
 const update=()=>{if(opts.max&&opts.max<=600)count.textContent=String(input.value.length)+"/"+opts.max+"字";};
 update();
 input.oninput=()=>{state.draft[key]=input.value;changed();update();};
 if(opts.select)input.onchange=()=>{state.draft[key]=input.value;changed();if(["kind","venue","fee_type"].includes(key))render();};
 wrap.append(input);
 if(opts.hint)wrap.append(h("small","mkh-pr-hint",opts.hint));
 return wrap;
}
function checkbox(label,key){
 const row=h("label","mkh-pr-inline");
 const check=h("input");check.type="checkbox";check.checked=!!state.draft[key];
 check.onchange=()=>{state.draft[key]=check.checked;changed();};
 row.append(check,h("span","",label));return row;
}
const note=(text,cl="mkh-pr-note")=>h("p",cl,text);
const fold=(title)=>{const d=h("details","mkh-pr-fold");d.open=true;d.append(h("summary","",title));const b=h("div","mkh-pr-fold-body");d.append(b);return [d,b];};
const split=(...nodes)=>{const row=h("div","mkh-pr-two");row.append(...nodes);return row;};
function features(box){
 const list=h("div","mkh-pr-features");
 state.draft.features.forEach((item,idx)=>{
  const row=h("div","mkh-pr-feature");
  const header=h("div","mkh-pr-feature-head");
  header.append(h("b","","ポイント "+(idx+1)));
  if(state.draft.features.length>1){
   const remove=h("button","mkh-pr-check","削除");remove.type="button";
   remove.onclick=()=>{state.draft.features.splice(idx,1);changed();render();};
   header.append(remove);
  }
  row.append(header);
  const ti=h("input");ti.type="text";ti.value=item.title||"";ti.maxLength=120;ti.placeholder="特徴の見出し";
  ti.setAttribute("aria-label","ポイント"+(idx+1)+"の見出し");
  ti.oninput=()=>{item.title=ti.value;changed();};
  const ta=h("textarea");ta.rows=2;ta.value=item.body||"";ta.placeholder="具体的な説明";
  ta.setAttribute("aria-label","ポイント"+(idx+1)+"の説明");
  ta.oninput=()=>{item.body=ta.value;changed();};
  row.append(ti,ta);list.append(row);
 });
 box.append(list);
 if(state.draft.features.length<3){
  const add=h("button","mkh-pr-check","＋ ポイントを追加");add.type="button";
  add.onclick=()=>{state.draft.features.push({title:"",body:""});changed();render();};box.append(add);
 }
 box.append(note("2〜3つの具体的な特徴があると、掲載内容が読みやすくなります。"));
}
function images(box){
 box.append(note("JPEG / PNG / WebP / GIF、1枚10MB以内。選択してもファイルはサーバへアップロードされません。PR TIMESへの掲載時に別途追加してください。"));
 const input=h("input");input.type="file";input.accept="image/jpeg,image/png,image/webp,image/gif";input.multiple=true;
 input.setAttribute("aria-label","掲載予定の画像を選択");
 input.onchange=()=>{
   const files=Array.from(input.files||[]);
   const validTypes=new Set(["image/jpeg","image/png","image/webp","image/gif"]);
   let invalid=0;
   for(const f of files){
    if(!validTypes.has(f.type)||f.size>10*1024*1024){invalid++;continue;}
    state.draft.images.push({name:f.name,caption:"",size:f.size});
   }
   changed();if(invalid)state.error=invalid+"枚の画像を追加できませんでした（形式・10MB制限）。";render();
 };box.append(input);
 state.draft.images.forEach((image,idx)=>{
  const row=h("div","mkh-pr-image-row");row.append(h("small","",image.name));
  const caption=h("input");caption.value=image.caption;caption.placeholder="画像の説明";
  caption.setAttribute("aria-label","画像"+(idx+1)+"の説明");
  caption.oninput=()=>{image.caption=caption.value;changed();};
  const remove=h("button","mkh-pr-check","削除");remove.type="button";
  remove.onclick=()=>{state.draft.images.splice(idx,1);changed();render();};
  row.append(caption,remove);box.append(row);
 });
}
function draftForFormatter(){
 return {...state.draft,images:state.draft.images.map(x=>({path:x.name,caption:x.caption}))};
}
function currentDraft(){
 return state.override?state.override:R.buildDraft(draftForFormatter());
}
function first(box){
 const [base,bb]=fold("1. 基本情報");
 bb.append(field("リリース種別","kind",{select:R.KINDS.map(k=>[k.value,k.label])}));
 bb.append(field("タイトル","title",{required:true,max:120,placeholder:"誰が、何を、いつ発表するか。30〜45字が目安",hint:"30〜45文字が目安。誇張せず事実を先に書きます。"}));
 bb.append(field("サブタイトル（任意）","subtitle",{max:120}));
 box.append(base);
 const [intro,ib]=fold("2. 概要・背景");
 ib.append(field("概要・リード文","summary",{required:true,multi:true,max:600,rows:4,hint:"いつ・誰が・何を・どうするか。200〜300字を目安に、事実だけを記入。"}));
 ib.append(field("背景・目的","background",{multi:true,rows:4,hint:"きっかけ、課題、今回取り組む理由。"}));box.append(intro);
 const [feats,fb]=fold("3. ポイント・特徴（最大3つ）");features(fb);box.append(feats);
 const kind=R.kindOf(state.draft.kind),form=R.formOf(state.draft.kind);
 const [event,eb]=fold("4. "+form.title);
 eb.append(field(form.date||"発表日","event_on",{type:"date"}));
 if(!state.draft.event_on)eb.append(field("日付未定の場合の表記","event_date",{placeholder:"例：2027年春ごろ"}));
 if(form.end)eb.append(field(form.end,"event_end_on",{type:"date"}));
 if(form.time)eb.append(split(field("開始時間","event_start",{type:"time"}),field("終了時間","event_end",{type:"time"})));
 if(form.time)eb.append(split(checkbox("終日","event_allday"),checkbox("時間未定","event_time_tbd")));
 if(form.venue){
   eb.append(field("会場","venue",{select:[["","未選択"],...R.VENUES.map(v=>[v.value,v.label])]}));
   if(state.draft.venue==="other")eb.append(field("会場名","venue_name"));
   eb.append(field("会場住所","venue_address"));
 }
 if(form.fee){
  eb.append(field(form.fee,"fee_type",{select:[["","未設定"],["free","無料"],["paid","有料"],["invite","招待制"]]}));
  if(state.draft.fee_type==="paid")eb.append(split(field("料金（円）","fee_amount",{type:"number"}),field("税区分","fee_tax",{select:[["incl","税込"],["excl","税別"]]})));
 }
 if(form.partner)eb.append(field(typeof form.partner==="string"?form.partner:"提携先","partner"));
 if(form.target)eb.append(field(typeof form.target==="string"?form.target:"対象となる方","target"));
 eb.append(field(form.url||"詳細URL","url",{type:"url",placeholder:"https://"}));
 box.append(event);
 const [future,ff]=fold("5. 今後の展開");ff.append(field("今後の予定・展望","future",{multi:true,rows:3,hint:"決定済み事項と予定を区別してください。"}));box.append(future);
 const [company,cf]=fold("6. 会社概要");
 cf.append(split(field("会社・団体名","company",{required:true}),field("フリガナ","company_kana")));
 cf.append(split(field("代表者","representative"),field("設立","founded")));
 cf.append(field("所在地","location"),field("事業内容","business"),field("会社URL","company_url",{type:"url",placeholder:"https://"}));
 box.append(company);
 const [contact,ct]=fold("7. お問い合わせ先");
 ct.append(split(field("部署","contact_dept"),field("担当者名","contact_name")));
 ct.append(split(field("電話番号","contact_tel",{type:"tel"}),field("メールアドレス","contact_email",{type:"email"})));
 ct.append(field("受付時間","contact_hours"));
 ct.append(note("電話番号またはメールアドレスのどちらかを入力してください。"));box.append(contact);
 const [im,mb]=fold("8. 掲載画像");images(mb);box.append(im);
 const summary=h("div","mkh-pr-draft-preview");
 summary.append(h("b","","PR TIMES掲載用の草案プレビュー"));
 const preview=h("pre","",currentDraft()||"入力内容に沿ってPR TIMES用の草案を生成します。");
 const refresh=h("button","mkh-pr-check","プレビューを更新");refresh.type="button";refresh.onclick=()=>{preview.textContent=currentDraft()||"入力してください。";};
 summary.append(preview,refresh);box.append(summary);
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
 right.append(h("h4","",c.label+"向け本文"),note("PR TIMES原稿を基に媒体別の文字数や見せ方を調整。変更内容は一時編集です。"));
 const editor=h("textarea");editor.value=channelText(c);editor.rows=13;
 const n=h("small","mkh-pr-counter");
 const update=()=>{n.textContent=editor.value.length+(c.max?" / "+c.max:"")+" 字";n.className="mkh-pr-counter"+(c.max&&editor.value.length>c.max?" over":"");};
 editor.oninput=()=>{state.bodies[c.id]=editor.value;state.reviewed[c.id]=false;update();};
 right.append(editor,n);update();grid.append(left,right);box.append(grid);
 box.append(note("PR TIMES向け全文をそのままSNS投稿にしないよう、各媒体向けに校正します。公開・自動投稿は未接続です。"));
}
function copyButton(text,value,status){
 const btn=h("button","mkh-pr-check",text);btn.type="button";
 btn.onclick=async()=>{
  if(!navigator.clipboard?.writeText){status.textContent="自動コピーに対応していません。内容を選択してコピーしてください。";return;}
  try{await navigator.clipboard.writeText(value());status.textContent="コピーしました（公開・送信は行っていません）。";}
  catch{status.textContent="コピーできませんでした。ブラウザの権限をご確認ください。";}
 };
 return btn;
}
function third(box){
 const draft=h("div","mkh-pr-draft-preview");
 const header=h("div","mkh-pr-preview-head");
 header.append(h("b","","PR TIMES掲載用　全文プレビュー"));
 const status=h("small","mkh-pr-note");
 const change=h("button","mkh-pr-check",state.editing?"プレビュー表示":"本文を直接編集");change.type="button";
 change.onclick=()=>{state.editing=!state.editing;render();};
 header.append(change);draft.append(header);
 if(state.overrideOutdated)draft.append(note("元の入力内容を変更したため、直接編集した本文が古い可能性があります。『入力から作り直す』で再生成できます。","mkh-pr-error"));
 if(state.editing){
  const editor=h("textarea","mkh-pr-override");editor.rows=22;editor.value=currentDraft();
  editor.oninput=()=>{state.override=editor.value;state.overrideOutdated=false;state.reviewed={};};
  draft.append(editor);
  const reset=h("button","mkh-pr-check","入力から作り直す");reset.type="button";reset.onclick=()=>{state.override="";state.overrideOutdated=false;render();};
  draft.append(reset);
 }else{
  draft.append(h("pre","",currentDraft()));
 }
 draft.append(copyButton("PR TIMES原稿をコピー",currentDraft,status));
 draft.append(copyButton("ローカルAI校正用の指示文をコピー",()=>R.buildPrompt(currentDraft()),status));
 draft.append(status);box.append(draft);
 const cards=h("div","mkh-pr-previews");
 for(const c of CHANNELS.filter(c=>state.selected.has(c.id))){
  const item=h("section","mkh-pr-preview");
  const head=h("div","mkh-pr-preview-head");
  head.append(h("b","",c.label),h("small",state.reviewed[c.id]?"mkh-pr-checked":"mkh-pr-unchecked",state.reviewed[c.id]?"確認済み":"未確認"));
  const pre=h("p","",channelText(c)||"本文は未入力です。");pre.style.whiteSpace="pre-wrap";
  const btn=h("button","mkh-pr-check",state.reviewed[c.id]?"確認を取り消す":"媒体別本文を確認した");btn.type="button";
  btn.onclick=()=>{state.reviewed[c.id]=!state.reviewed[c.id];render();};
  item.append(head,pre,btn);cards.append(item);
 }
 box.append(cards);
 box.append(note("この画面の『確認済み』は一時的な自己チェックであり、正式な承認ではありません。"));
}
function fourth(box){
 box.append(h("h4","","PR TIMES・各媒体での正式公開"));
 box.append(note("ここではPR TIMESへの入稿・公開、SNS自動投稿、ブラストメール送信を行いません。原稿をコピーし、各サービスの正規管理画面で確認してください。"));
 const buttons=h("div","mkh-pr-actions"),status=h("span","mkh-pr-note");
 buttons.append(copyButton("PR TIMES用の全文をコピー",currentDraft,status));
 buttons.append(copyButton("媒体別本文をまとめてコピー",()=>CHANNELS.filter(c=>state.selected.has(c.id)).map(c=>"【"+c.label+"】\n"+channelText(c)).join("\n\n----\n\n"),status));
 const link=h("a","mkh-pr-back","8spの正式な草案編集を開く");
 link.href="https://8sp.jp/member/release.html?id=new";link.target="_blank";link.rel="noopener noreferrer";
 buttons.append(link,status);box.append(buttons);
}
function fifth(box){
 box.append(h("h4","","公開後7日・30日の効果分析"));
 box.append(note("公開日の照合、記事別PV、SNSの流入、ブラストメール、問い合わせへの帰属は未連携です。データが接続されるまで成果は0件と表示しません。"));
 const b=h("button","mkh-pr-next","効果分析タブへ");b.type="button";
 b.onclick=()=>document.getElementById("mkt-tab-analytics")?.click();box.append(b);
}
function render(){
 if(!root)return;
 root.replaceChildren();
 const steps=h("ol","mkh-pr-stepper");
 for(let i=0;i<STEPS.length;i++){
  const li=h("li",i===state.step?"current":i<state.step?"finished":"");
  const btn=h("button");btn.type="button";btn.setAttribute("aria-current",i===state.step?"step":"false");
  btn.append(h("span","mkh-pr-step-n",i+1),h("b","",STEPS[i]),h("small","",CAPTIONS[i]));
  btn.onclick=()=>{if(i>0&&!valid()){render();return;}state.step=i;render();};
  li.append(btn);steps.append(li);
 }
 root.append(steps);
 const card=h("section","mkh-card mkh-pr-card");
 const top=h("div","mkh-cardhead"),left=h("div");
 left.append(h("h3","","0"+(state.step+1)+"　"+STEPS[state.step]),h("p","",trim(state.draft.title)||"新規PR TIMES草案"));
 top.append(left,h("small","mkh-pr-unsaved","未保存（確認用）"));card.append(top);
 const body=h("div","mkh-pr-body");
 [first,second,third,fourth,fifth][state.step](body);
 if(state.error)body.prepend(note(state.error,"mkh-pr-error"));
 card.append(body);
 const foot=h("div","mkh-pr-foot");
 const back=h("button","mkh-pr-back","戻る");back.type="button";back.disabled=state.step===0;
 back.onclick=()=>{state.step--;state.error="";render();};foot.append(back);
 if(state.step<4){
  const next=h("button","mkh-pr-next",["公開先ごとに調整","全文プレビューへ","公開方法を確認","効果分析へ"][state.step]);next.type="button";
  next.onclick=()=>{
   if(!valid()){render();return;}
   if(state.step===2){
    const selected=CHANNELS.filter(c=>state.selected.has(c.id));
    if(selected.some(c=>!state.reviewed[c.id]||(c.max&&channelText(c).length>c.max))){
       state.error="選択したすべての媒体の本文を確認し、文字数制限を満たしてください。";render();return;
    }
   }
   state.step++;state.error="";render();
  };foot.append(next);
 }
 card.append(foot);root.append(card);
 root.append(note("この画面はデザイン確認用の一時草案です。再読み込みすると消えます。正式な保存・承認・配信は行いません。"));
}
window.MarketingHandoffComposer={
 mount(node){root=node;render();},
 reset(){state=initial();render();},
 snapshot(){return {step:state.step,title:state.draft.title,kind:state.draft.kind,selected:[...state.selected]};},
 buildDraft(){return currentDraft();},
 missing(){return R.missing(state.draft);}
};
})();
