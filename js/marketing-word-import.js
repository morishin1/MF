// Private, local-only Word (.docx) / text import for PR TIMES editor.
// No uploads, external libraries, AI API, or network calls.
(function(root,factory){
 "use strict";
 const api=factory();
 if(typeof module==="object"&&module.exports)module.exports=api;
 else root.MarketingWordImport=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
 "use strict";
 const WORD_NS="http://schemas.openxmlformats.org/wordprocessingml/2006/main";
 const MAX_BYTES=8*1024*1024,MAX_XML=2*1024*1024,MAX_TEXT=80000;
 const LEN={title:120,subtitle:120,summary:600,background:6000,future:5000,
  company:200,representative:200,location:600,contact_name:200,contact_dept:200,
  contact_email:250,contact_tel:100,url:1800,company_url:1800,
  event_on:20,event_date:150,venue_name:200,venue_address:500,target:500,partner:600};
 const FIELD_LABELS={title:"タイトル",subtitle:"サブタイトル",summary:"概要・リード文",
  background:"背景・目的",future:"今後の展開",company:"会社・団体名",
  representative:"代表者",location:"所在地",contact_dept:"問い合わせ部署",
  contact_name:"問い合わせ担当",contact_email:"問い合わせメール",
  contact_tel:"問い合わせ電話",url:"詳細URL",company_url:"会社URL",
  event_on:"開催・開始日",event_date:"時期（文字列）",venue_name:"会場名",
  venue_address:"会場住所",target:"対象者",partner:"提携先",features:"特徴・ポイント"};
 const LABEL_RULES=[
  [/^(?:タイトル|見出し|リリースタイトル)$/,"title"],
  [/^(?:サブタイトル|副題)$/,"subtitle"],
  [/^(?:概要|リード文|発表概要|リリース概要|要約|はじめに)$/,"summary"],
  [/^(?:背景|背景・目的|目的|取り組みの背景)$/,"background"],
  [/^(?:特徴|特長|ポイント|主な特徴|注目ポイント|取り組みの特徴|主なポイント|イベントの見どころ)$/,"features"],
  [/^(?:今後|今後の展望|今後の展開|今後の予定)$/,"future"],
  [/^(?:会社概要|企業概要|団体概要)$/,"companySection"],
  [/^(?:お問い合わせ|問い合わせ先|本件に関するお問い合わせ|連絡先)$/,"contactSection"],
  [/^(?:開催概要|開催情報|実施概要|実施情報|イベント概要)$/,"eventSection"]
 ];
 const INLINE=[
  [/^(?:会社名|社名|団体名|運営会社|主催会社)$/,"company"],
  [/^(?:代表者|代表取締役)$/,"representative"],
  [/^(?:本社所在地|所在地|住所)$/,"location"],
  [/^(?:問い合わせ担当者|お問い合わせ担当|担当者)$/,"contact_name"],
  [/^(?:問い合わせ部署|担当部署|広報担当部署)$/,"contact_dept"],
  [/^(?:メールアドレス|E-?mail|問い合わせメール)$/i,"contact_email"],
  [/^(?:電話番号|TEL|問い合わせ電話)$/i,"contact_tel"],
  [/^(?:詳細URL|申し込みURL|申込URL|申込先|関連リンク|詳細ページ)$/,"url"],
  [/^(?:会社URL|公式サイト|コーポレートサイト)$/,"company_url"],
  [/^(?:開催日|開催日時|開始日|発表日|提供開始日)$/,"event_on"],
  [/^(?:会場名|開催場所|会場)$/,"venue_name"],
  [/^(?:会場住所)$/,"venue_address"],
  [/^(?:対象者|対象|参加対象)$/,"target"],
  [/^(?:提携先|協力先)$/,"partner"]
 ];
 const normalize=s=>String(s||"").replace(/\r/g,"").replace(/\u00a0/g," ").replace(/[\t ]+/g," ").trim();
 const label=s=>normalize(s).replace(/^[■●◆◇【［\[\(（＃#\d\s.\-]+/,"")
   .replace(/[】］\]）)\s]+$/,"").replace(/[・\s]+/g,"・");
 const mapLabel=k=>{
  const a=label(k);
  for(const [regex,key] of INLINE)if(regex.test(a))return key;
  for(const [regex,key] of LABEL_RULES)if(regex.test(a))return key;
  return null;
 };
 function dayFromText(s){
  const t=normalize(s),m=t.match(/(?:^|[^0-9])((?:20|19)\d{2})\s*[年\/-]\s*(\d{1,2})\s*[月\/-]\s*(\d{1,2})/);
  if(!m)return null;
  const [y,mon,day]=[Number(m[1]),Number(m[2]),Number(m[3])];
  const iso=`${String(y)}-${String(mon).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  const d=new Date(iso+"T12:00:00Z");
  return d.getUTCFullYear()===y&&d.getUTCMonth()+1===mon&&d.getUTCDate()===day?iso:null;
 }
 function parseText(source,opts={}){
  const lines=String(source||"").replace(/\r\n?/g,"\n").split("\n")
    .map(normalize).filter(Boolean).slice(0,2200);
  const picked={},groups={},initial=[],unmapped=[];
  let active=null;let firstHeading=null;
  const put=(key,val)=>{if(!val)return;if(!groups[key])groups[key]=[];groups[key].push(val);};
  for(let i=0;i<lines.length;i++){
   const raw=lines[i];
   const cleaned=raw.replace(/^[\s#■●◆▶◇【]+/,"").replace(/[】]+$/,"").trim();
   const inline=cleaned.match(/^([^:：]{1,30})\s*[:：]\s*(.+)$/);
   if(inline){
    const key=mapLabel(inline[1]);
    if(key){
     if(key==="event_on"){const date=dayFromText(inline[2]);if(date)picked.event_on=date;else picked.event_date=inline[2].slice(0,LEN.event_date);}
     else if(!key.endsWith("Section"))put(key,inline[2]);
     active=key;continue;
    }
   }
   const section=mapLabel(cleaned);
   if(section){active=section;firstHeading??=section;continue;}
   if(active){
    const asDate=active==="event_on"?dayFromText(raw):null;
    if(asDate)picked.event_on=asDate;
    else put(active==="event_on"?"event_date":active,raw);
   }else initial.push(raw);
  }
  const clamp=(key,value)=>{
   const max=LEN[key]||0;
   if(!max||!value)return;
   const content=normalize(value);
   if(content.length<=max)picked[key]=content;
   else {
    // No silent truncation: overflow remains visible in the raw preview.
    unmapped.push(FIELD_LABELS[key]+"が入力欄の上限を超えています（"+content.length+"字）");
   }
  };
  for(const [key,items] of Object.entries(groups)){
   if(key==="features"||key.endsWith("Section")||key==="event_on")continue;
   if(key==="event_date"&&picked.event_on)continue;
   clamp(key,items.join(["title","subtitle","company","contact_email","contact_tel"].includes(key)?" ":"\n"));
  }
  const title=initial[0]||null;
  if(!picked.title&&title&&title.length<=LEN.title&&title.length>3)clamp("title",title);
  if(!picked.summary){
   const from=initial.slice(picked.title===title?1:0);
   if(from.length)clamp("summary",from.slice(0,3).join("\n"));
  }
  const features=[];
  const linesFor=groups.features||[];
  for(const line of linesFor){
   if(features.length>=3){unmapped.push("4件目以降の特徴は元原稿で確認してください");break;}
   const cut=line.match(/^(?:(?:\d+[.．)）]\s*)|(?:特徴\d+[：:]\s*))?([^：:]{1,70})[：:]\s*(.+)$/);
   if(cut)features.push({title:normalize(cut[1]).slice(0,120),body:normalize(cut[2]).slice(0,3000)});
   else features.push({title:line.slice(0,120),body:""});
  }
  if(features.length)picked.features=features;
  // Under company/contact sections: extract strictly-labeled values only, avoid guessing people.
  for(const [section,keyPrefix] of [["companySection","company"],["contactSection","contact"]]){
   for(const line of groups[section]||[]){
    const m=line.match(/^([^:：]{1,35})[:：]\s*(.+)$/);
    const target=m?mapLabel(m[1]):null;
    if(target&&!target.endsWith("Section")&&!picked[target]&&target!=="features")clamp(target,m[2]);
   }
  }
  if(!picked.contact_email){
   const section=(groups.contactSection||[]).join(" ");
   const m=section.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
   if(m)clamp("contact_email",m[0]);
  }
  if(!picked.contact_tel){
   const section=(groups.contactSection||[]).join(" ");
   const m=section.match(/(?:TEL|電話)\s*[:：]?\s*(0\d[\d()\- ]{7,16}\d)/i);
   if(m)clamp("contact_tel",m[1]);
  }
  if(!picked.title&&opts.title)clamp("title",opts.title);
  return {fields:picked,raw:lines.join("\n"),warnings:unmapped,fieldLabels:FIELD_LABELS};
 }
 const u16=(v,i)=>v.getUint16(i,true),u32=(v,i)=>v.getUint32(i,true);
 async function unzipDocument(bytes){
  const b=new Uint8Array(bytes),v=new DataView(bytes),n=b.length;
  if(n<26||n>MAX_BYTES)throw Error("Wordファイルのサイズは8MB以内にしてください。");
  let eocd=-1;
  for(let i=n-22;i>=Math.max(0,n-65557);i--){if(u32(v,i)===0x06054b50){eocd=i;break;}}
  if(eocd<0)throw Error("Word（.docx）ファイルとして読み取れません。");
  const count=u16(v,eocd+10),offset=u32(v,eocd+16);
  if(count===0xffff||offset===0xffffffff||count>2000)throw Error("このWordファイル形式には対応していません。");
  let pos=offset,record=null;
  for(let i=0;i<count;i++){
   if(pos+46>n||u32(v,pos)!==0x02014b50)throw Error("Wordの内部構造を読み取れません。");
   const method=u16(v,pos+10),flags=u16(v,pos+8),compressed=u32(v,pos+20),uncompressed=u32(v,pos+24);
   const len=u16(v,pos+28),extra=u16(v,pos+30),comment=u16(v,pos+32),local=u32(v,pos+42);
   if(pos+46+len+extra+comment>n)throw Error("Wordの内部構造が不正です。");
   const name=new TextDecoder().decode(b.subarray(pos+46,pos+46+len));
   if(name==="word/document.xml"){record={method,flags,compressed,uncompressed,local};break;}
   pos+=46+len+extra+comment;
  }
  if(!record)throw Error("Word本文（word/document.xml）が見つかりません。");
  if(record.flags&1||![0,8].includes(record.method)||record.uncompressed>MAX_XML||record.compressed>MAX_BYTES)throw Error("このWordファイルは安全に読み取れません。");
  const start=record.local;
  if(start+30>n||u32(v,start)!==0x04034b50)throw Error("Wordの本文ヘッダーが不正です。");
  const dataAt=start+30+u16(v,start+26)+u16(v,start+28);
  if(dataAt+record.compressed>n)throw Error("Word本文が途中で切れています。");
  const zipped=b.subarray(dataAt,dataAt+record.compressed);
  if(record.method===0){
   if(zipped.byteLength>MAX_XML||zipped.byteLength!==record.uncompressed)throw Error("Wordの本文サイズが不正です。");
   return new TextDecoder().decode(zipped);
  }
  if(typeof DecompressionStream!=="function")throw Error("このブラウザはWord展開に未対応です。Chromeの最新版をご利用ください。");
  const stream=new Blob([zipped]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  // ZIP size metadata is untrusted. Cap decompression as chunks arrive, before
  // buffering the entire expanded file (including a forged central-directory size).
  const reader=stream.getReader(),chunks=[];
  let total=0;
  try{
   while(true){
    const {done,value}=await reader.read();if(done)break;
    total+=value.byteLength;
    if(total>MAX_XML||total>record.uncompressed){await reader.cancel();throw Error("Wordの本文が大きすぎるか、サイズが不正です。");}
    chunks.push(value);
   }
  }finally{reader.releaseLock();}
  if(total!==record.uncompressed)throw Error("Wordの本文サイズが不正です。");
  const out=new Uint8Array(total);let at=0;
  for(const chunk of chunks){out.set(chunk,at);at+=chunk.byteLength;}
  return new TextDecoder().decode(out);
 }
 function textFromXml(xmlText){
  // Do not allow document type/entity declarations or external XML entities.
  if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xmlText))throw Error("外部参照や実体宣言を含むWord本文には対応していません。");
  if(typeof DOMParser!=="function")throw Error("Word解析に必要な機能が利用できません。");
  const doc=new DOMParser().parseFromString(xmlText,"application/xml");
  if(doc.getElementsByTagName("parsererror").length)throw Error("Word本文のXMLを解析できません。");
  const ps=Array.from(doc.getElementsByTagNameNS(WORD_NS,"p"));
  const lines=[];
  for(const p of ps){
   let text="";
   const collect=(node)=>{
    for(const child of Array.from(node.childNodes||[])){
     if(child.namespaceURI===WORD_NS&&child.localName==="t"){text+=child.textContent||"";continue;}
     if(child.namespaceURI===WORD_NS&&child.localName==="tab"){text+=" ";continue;}
     if(child.namespaceURI===WORD_NS&&["br","cr"].includes(child.localName)){text+="\n";continue;}
     // Deleted revisions / field instruction content are not public PR text.
     if(child.namespaceURI===WORD_NS&&["del","instrText"].includes(child.localName))continue;
     collect(child);
    }
   };
   collect(p);
   lines.push(...text.split("\n").map(normalize).filter(Boolean));
  }
  const full=lines.join("\n");
  if(!full)throw Error("本文を読み取れませんでした。画像のみのWordには対応していません。");
  if(full.length>MAX_TEXT)throw Error("Wordの文章が長すぎます。8万文字以内にしてください。");
  return full;
 }
 async function parseFile(file){
  if(!file||typeof file.arrayBuffer!=="function")throw Error("Wordファイルを選択してください。");
  if(file.size>MAX_BYTES)throw Error("ファイルサイズは8MB以内にしてください。");
  const name=String(file.name||"");
  if(/\.doc$/i.test(name))throw Error("旧形式の.docには対応していません。.docxに保存し直してください。");
  if(!/\.(docx|txt|md)$/i.test(name))throw Error("対応形式はWord（.docx）、テキスト（.txt/.md）です。");
  const buffer=await file.arrayBuffer();
  const text=/\.docx$/i.test(name)?textFromXml(await unzipDocument(buffer)):
    new TextDecoder("utf-8",{fatal:true}).decode(buffer);
  const result=parseText(text,{title:name.replace(/\.(docx|txt|md)$/i,"")});
  if(!result.raw)throw Error("読み取れる文章がありません。");
  return {...result,filename:name,chars:text.length};
 }
 return {parseFile,parseText,textFromXml,fieldLabels:FIELD_LABELS};
});
