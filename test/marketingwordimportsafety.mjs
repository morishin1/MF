// Synthetic documents / DOM only. No credentials, network, customer files or writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deflateRawSync} from 'node:zlib';
import vm from 'node:vm';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
let count=0;
const check=async(name,fn)=>{await fn();count++;console.log('ok',name);};
class Element {
 constructor(tag){Object.assign(this,{tag,children:[],attrs:{},textContent:'',className:'',value:'',files:[],style:{}});}
 append(...xs){this.children.push(...xs);}
 replaceChildren(...xs){this.children=[...xs];}
 setAttribute(k,v){this.attrs[k]=v;}
}
const walk=e=>[e,...e.children.flatMap(x=>typeof x==='string'?[]:walk(x))];
const pending={fields:{title:'取込タイトル',summary:'取込概要'},filename:'synthetic.docx',chars:20,warnings:[],raw:'合成原稿'};
function ui(){
 const draft={title:'既存タイトル',summary:''},root=new Element('section'),parses=[];
 let applies=0,allow=true,override=false,confirmed=false;
 const ctx={console,document:{createElement:t=>new Element(t)}};ctx.window=ctx;
 ctx.confirm=()=>confirmed;
 ctx.MarketingWordImport={fieldLabels:{title:'タイトル',summary:'概要'},parseFile:()=>new Promise((resolve,reject)=>parses.push({resolve,reject}))};
 vm.createContext(ctx);vm.runInContext(read('js/marketing-word-import-ui.js'),ctx);
 const api=ctx.MarketingWordImportUI;
 const opts={getDraft:()=>draft,canApply:()=>allow,hasOverride:()=>override,apply:entries=>{applies++;Object.assign(draft,entries);api.mount(root,opts);return true;}};
 api.mount(root,opts);
 const picker=()=>walk(root).find(e=>e.type==='file');
 const apply=()=>walk(root).find(e=>e.tag==='button'&&e.textContent==='選択した項目を入力欄に反映する');
 const choose=()=>{const p=picker();p.files=[{name:'synthetic.docx'}];return p.onchange();};
 const load=async()=>{const task=choose();parses.shift().resolve(pending);await task;};
 const field=key=>walk(root).find(e=>e.className==='mpr-import-field'&&walk(e).some(c=>c.textContent===({title:'タイトル',summary:'概要'})[key]));
 return {api,root,draft,parses,load,choose,picker,apply,field,applies:()=>applies,allow:v=>allow=v,override:v=>override=v,confirm:v=>confirmed=v};
}
await check('successful apply removes review UI and repeated stale click is harmless',async()=>{
 const x=ui();await x.load();const stale=x.apply();stale.onclick();
 assert.equal(x.applies(),1);assert.equal(x.draft.title,'既存タイトル');assert.equal(x.draft.summary,'取込概要');
 assert.equal(x.api.snapshot().ready,false);assert.equal(x.apply(),undefined);
 stale.onclick();assert.equal(x.applies(),1);
});
await check('edits made after extraction are retained until explicitly reselected',async()=>{
 const x=ui();await x.load();x.draft.summary='読取後に書いた概要';x.apply().onclick();
 assert.equal(x.draft.summary,'読取後に書いた概要');assert.equal(x.applies(),0);
 const checkbox=walk(x.field('summary')).find(e=>e.type==='checkbox');assert.equal(checkbox.checked,false);
 checkbox.checked=true;checkbox.onchange();x.apply().onclick();assert.equal(x.draft.summary,'取込概要');assert.equal(x.applies(),1);
});
await check('clear during parsing unlocks new draft and ignores late result',async()=>{
 const x=ui();const old=x.choose();x.api.clear();assert.equal(x.api.snapshot().busy,false);assert.equal(x.picker().disabled,false);
 x.parses.shift().resolve(pending);await old;assert.equal(x.api.snapshot().ready,false);
 await x.load();assert.equal(x.api.snapshot().ready,true);
});
await check('choosing another file cancels a pending read and can recover from failure',async()=>{
 const x=ui();await x.load();const old=x.choose();
 walk(x.root).find(e=>e.tag==='button'&&e.textContent==='選び直す').onclick();
 assert.equal(x.api.snapshot().busy,false);x.parses.shift().resolve(pending);await old;assert.equal(x.api.snapshot().ready,false);
 const next=x.choose();x.parses.shift().reject(Error('合成読取エラー'));await next;
 assert.equal(x.api.snapshot().busy,false);await x.load();assert.equal(x.api.snapshot().ready,true);
});
await check('manual full-text override requires confirmation; locked draft cannot apply',async()=>{
 const x=ui();await x.load();x.override(true);x.apply().onclick();assert.equal(x.applies(),0);
 x.confirm(true);x.allow(false);x.apply().onclick();assert.equal(x.applies(),0);
 x.allow(true);x.apply().onclick();assert.equal(x.applies(),1);
});
await check('untrusted filenames and extracted text are rendered as text, not markup',async()=>{
 const x=ui();const loading=x.choose();x.parses.shift().resolve({...pending,filename:'<img src=x onerror=alert(1)>.docx',raw:'<script>alert(1)</script>'});await loading;
 assert.ok(walk(x.root).some(e=>e.textContent.includes('<script>alert(1)</script>')));
 assert.ok(!walk(x.root).some(e=>e.tag==='script'||e.tag==='img'||e.innerHTML));
});
function zip(raw,{method=8,declared=raw.length}={}){
 const name=Buffer.from('word/document.xml'),compressed=method===0?raw:deflateRawSync(raw),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(method,8);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(declared,22);local.writeUInt16LE(name.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt16LE(method,10);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(declared,24);central.writeUInt16LE(name.length,28);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+compressed.length,16);
 return Buffer.concat([local,name,compressed,central,name,end]);
}
const file=(buffer,name='synthetic.docx')=>({name,size:buffer.length,arrayBuffer:async()=>Uint8Array.from(buffer).buffer});
let xmlCalls=0;
class XmlParser {parseFromString(){xmlCalls++;return {getElementsByTagName:()=>[],getElementsByTagNameNS:()=>[{childNodes:[{namespaceURI:'http://schemas.openxmlformats.org/wordprocessingml/2006/main',localName:'t',textContent:'合成タイトル'}]}]};}}
function parser(extra={}){
 const ctx={console,Date,TextDecoder,Blob,Response,DecompressionStream,DOMParser:XmlParser,...extra};ctx.window=ctx;
 vm.createContext(ctx);vm.runInContext(read('js/marketing-word-import.js'),ctx);return ctx.MarketingWordImport;
}
const api=parser();const MAX=2*1024*1024;
await check('normal stored and deflated synthetic DOCX remain readable',async()=>{
 for(const method of [0,8])assert.equal((await api.parseFile(file(zip(Buffer.from('<document/>'),{method})))).fields.title,'合成タイトル');
});
await check('oversized declared XML is rejected before parsing',async()=>{
 const before=xmlCalls;await assert.rejects(()=>api.parseFile(file(zip(Buffer.from('x'),{declared:MAX+1}))));assert.equal(xmlCalls,before);
});
await check('stored forged size cannot bypass the XML cap',async()=>{
 const before=xmlCalls;await assert.rejects(()=>api.parseFile(file(zip(Buffer.alloc(MAX+1,32),{method:0,declared:1}))));assert.equal(xmlCalls,before);
});
await check('forged deflated length is rejected before XML parsing',async()=>{
 const before=xmlCalls;await assert.rejects(()=>api.parseFile(file(zip(Buffer.alloc(1000,32),{declared:1}))));assert.equal(xmlCalls,before);
});
await check('decompression stops while reading, not after materializing an oversized stream',async()=>{
 let pulls=0,cancelled=false;
 class Expander {constructor(){this.writable=new WritableStream();this.readable=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(65536));if(pulls===100)c.close();},cancel(){cancelled=true;}});}}
 const guarded=parser({DecompressionStream:Expander});const before=xmlCalls;
 await assert.rejects(()=>guarded.parseFile(file(zip(Buffer.from('x'),{declared:MAX}))));
 assert.ok(pulls<40,'read must stop near 2MB, not consume all 100 chunks');assert.equal(cancelled,true);assert.equal(xmlCalls,before);
});
await check('DTD / entity documents are rejected before XML parser and old .doc is clearly rejected',async()=>{
 const before=xmlCalls;
 await assert.rejects(()=>api.parseFile(file(zip(Buffer.from('<!DOCTYPE w:document [<!ENTITY x SYSTEM "https://example.invalid/private">]><w:document/>')))));
 assert.equal(xmlCalls,before);await assert.rejects(()=>api.parseFile(file(Buffer.from('old word'), 'legacy.doc')),/\.docx/);
});
console.log(`Marketing Word import safety: ${count} checks passed (synthetic only)`);
