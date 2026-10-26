// Real publication controller in a synthetic DOM with delayed fake API responses.
// No browser, production data, external fetches, credentials or publications.
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const source=read("js/marketing-site-publication-ui.js");
class Element {
 constructor(tag){Object.assign(this,{tag,children:[],attrs:{},textContent:"",className:"",value:"",disabled:false,checked:false});}
 append(...xs){this.children.push(...xs);}
 replaceChildren(...xs){this.children=[...xs];}
 setAttribute(k,v){this.attrs[k]=v;}
 set innerHTML(_){throw Error("Unsafe HTML insertion");}
}
const walk=e=>[e,...e.children.flatMap(x=>typeof x==="string"?[]:walk(x))];
const text=e=>walk(e).map(x=>x.textContent).join(" ");
const tick=()=>new Promise(setImmediate);
const copy=x=>JSON.parse(JSON.stringify(x));
const A="00000000-0000-4000-8000-000000000001",B="00000000-0000-4000-8000-000000000002";
const url=id=>"https://8grp.co.jp/news/press-mkt-"+id.replace(/-/g,"")+"/";
const result=(id=A,more={})=>({id,version:4,ready:true,canPublish:true,reason:null,preview:{title:"<script>TEST</script>",summary:"公開概要",bodyText:"問い合わせ：press@example.com",bodyHtml:"<img src=x onerror=bad()>",hash:"approved-hash",publicUrl:url(id),exposure:["氏名・連絡先が公開されます"]},publication:null,...more});
let n=0;const check=(name,fn)=>{fn();console.log("ok",++n,name);};
function harness(){
 const calls=[],pending=[];
 const context={document:{createElement:t=>new Element(t)},URL,console};context.window=context;
 context.API={api:(path,options)=>{calls.push({path,options:options&&copy(options)});return new Promise((resolve,reject)=>pending.push({resolve,reject}));}};
 vm.createContext(context);vm.runInContext(source,context);
 const root=new Element("section"),mount=id=>context.MarketingSitePublication.mount(root,{id,version:4});
 const find=(label,tag="button")=>walk(root).find(x=>x.tag===tag&&x.textContent===label);
 const consent=()=>walk(root).find(x=>x.tag==="input"&&x.type==="checkbox");
 return {root,calls,pending,mount,find,consent};
}
const publishLabel="確認した内容で自社サイトへ公開を依頼";
const h=harness();h.mount(A);
check("mount only reads registered PR and never publishes",()=>{assert.equal(h.calls.length,1);assert.equal(h.calls[0].options,undefined);assert.ok(h.calls[0].path.endsWith("?id="+A));});
h.pending.shift().resolve(result());await tick();
check("preview is text-only and explains public exposure and absent image upload",()=>{assert.match(text(h.root),/<script>TEST<\/script>/);assert.match(text(h.root),/press@example.com/);assert.match(text(h.root),/氏名・電話番号・メールアドレス/);assert.match(text(h.root),/画像本体はアップロードされません/);assert.doesNotMatch(text(h.root),/onerror/);});
const initialPublish=h.find(publishLabel);
initialPublish.onclick();
check("explicit consent is required before publish",()=>{assert.equal(initialPublish.disabled,true);assert.equal(h.calls.length,1);});
h.consent().checked=true;h.consent().onchange();const request=initialPublish.onclick();initialPublish.onclick();
check("publish sends immutable preview identity and repeated click is suppressed",()=>{assert.equal(h.calls.length,2);assert.deepEqual(h.calls[1].options.body,{action:"publish",id:A,version:4,previewHash:"approved-hash",confirmed:true});assert.ok(walk(h.root).filter(x=>x.tag==="button"||x.tag==="input").every(x=>x.disabled));});
h.pending.shift().resolve(result(A,{publication:{state:"pending",url:url(A),requestedAt:"2026-10-26T10:00:00Z"}}));await request;
check("database acceptance is shown only as awaiting scheduled sync",()=>{assert.match(text(h.root),/サイト反映待ち（毎朝8時JSTの定時同期）/);assert.doesNotMatch(text(h.root),/公開ページの内容一致を確認済み/);assert.equal(h.find(publishLabel),undefined);assert.equal(h.calls.length,2);});
const verify=h.find("公開ページの反映を確認").onclick();
check("verification is another explicit operation",()=>assert.deepEqual(h.calls[2].options.body,{action:"verify",id:A}));
h.pending.shift().resolve(result(A,{publication:{state:"verified",url:url(A),verifiedAt:"2026-10-26T10:01:00Z",checkedAt:"2026-10-26T10:01:00Z"}}));await verify;
check("verified publication displays safe URL and verification time",()=>{assert.match(text(h.root),/公開ページの内容一致を確認済み/);const a=walk(h.root).find(x=>x.tag==="a");assert.equal(a.href,url(A));assert.equal(a.rel,"noopener noreferrer");});
const changed=h.find("公開ページの反映を確認").onclick();h.pending.shift().resolve(result(A,{publication:{state:"changed",url:url(A),lastCheck:"content_mismatch"}}));await changed;
check("changed remote content is not treated as successful publication",()=>{assert.match(text(h.root),/公開設定または公開ページに変更/);assert.doesNotMatch(text(h.root),/公開ページの内容一致を確認済み/);assert.match(text(h.root),/公開ページの内容が一致しません/);assert.doesNotMatch(text(h.root),/content_mismatch/);});
const fail=harness();fail.mount(A);fail.pending.shift().resolve(result());await tick();fail.consent().checked=true;fail.consent().onchange();const failed=fail.find(publishLabel).onclick();fail.pending.shift().reject(Error("unknown transport result"));await failed;
check("uncertain publication does not offer an immediate blind retry",()=>{assert.match(text(fail.root),/同じ公開操作を繰り返さず/);assert.equal(fail.find(publishLabel).disabled,true);});
const refresh=fail.find("公開状態を再取得").onclick();fail.pending.shift().resolve(result(A,{publication:{state:"pending",url:url(A)}}));await refresh;
check("reloading unknown result discovers the existing publication without duplicate post",()=>{assert.equal(fail.find(publishLabel),undefined);assert.equal(fail.calls.filter(x=>x.options).length,1);});
const unavailable=harness();unavailable.mount(A);unavailable.pending.shift().resolve(result(A,{ready:false,canPublish:false,reason:"公開先テナント設定が未準備"}));await tick();
check("unprepared endpoint displays exact stop reason and no publish button",()=>{assert.match(text(unavailable.root),/公開先テナント設定が未準備/);assert.equal(unavailable.find(publishLabel),undefined);});
const denied=harness();denied.mount(A);denied.pending.shift().resolve(result(A,{canPublish:false,reason:"公開権限がありません"}));await tick();
check("lack of publication permission never yields a publish control",()=>{assert.equal(denied.find(publishLabel),undefined);assert.match(text(denied.root),/公開権限がありません/);});
const badUrl=harness();badUrl.mount(A);const invalid=result();invalid.preview.publicUrl="https://evil.example/news/";badUrl.pending.shift().resolve(invalid);await tick();badUrl.consent().checked=true;badUrl.consent().onchange();
check("unexpected public destinations cannot be published or linked",()=>{assert.equal(badUrl.find(publishLabel).disabled,true);assert.equal(walk(badUrl.root).filter(x=>x.tag==="a").length,0);});
const switching=harness(),dispose=switching.mount(A);dispose();switching.mount(B);switching.pending.shift().resolve(result(A));await tick();
check("late read of another draft cannot replace current publication state",()=>assert.doesNotMatch(text(switching.root),/press@example.com/));
switching.pending.shift().resolve(result(B));await tick();
check("new draft gets its own preview identity",()=>assert.match(text(switching.root),new RegExp(url(B))));
const leaving=harness(),destroy=leaving.mount(A);leaving.pending.shift().resolve(result());await tick();leaving.consent().checked=true;leaving.consent().onchange();const staleButton=leaving.find(publishLabel),pendingPublish=staleButton.onclick();destroy();leaving.mount(B);leaving.pending.shift().resolve(result(A,{publication:{state:"verified",url:url(A)}}));await pendingPublish;staleButton.onclick();
check("switching during publish ignores old response and inactive handlers",()=>{assert.doesNotMatch(text(leaving.root),/公開ページの内容一致を確認済み/);assert.equal(leaving.calls.filter(x=>x.options).length,1);});
leaving.pending.shift().resolve(result(B));await tick();
const wrong=harness();wrong.mount(A);wrong.pending.shift().resolve(result(B));await tick();
check("mismatched response id is rejected instead of authorizing publication",()=>{assert.equal(wrong.find(publishLabel),undefined);assert.match(text(wrong.root),/取得できません/);});
const bad=harness();bad.mount("not-a-uuid");
check("invalid references issue no API request",()=>assert.equal(bad.calls.length,0));
const html=read("marketing/index.html"),composer=read("js/marketing-handoff-composer.js");
check("publication bundle precedes composer and controller is disposed on composer render",()=>{assert.ok(html.indexOf("marketing-site-publication-ui.js")<html.indexOf("marketing-handoff-composer.js"));assert.match(composer,/if\(disposePublication\)\{disposePublication\(\);disposePublication=null;\}/);assert.match(composer,/MarketingSitePublication\.mount\(publication,\{id:state.id,version:state.version\}\)/);});
check("composer integrates publication only in completion, not save or register",()=>{const complete=composer.slice(composer.indexOf("function complete(){"),composer.indexOf("function render(){"));assert.match(complete,/MarketingSitePublication/);assert.equal((composer.match(/MarketingSitePublication\.mount/g)||[]).length,1);});
const unknown=harness();unknown.mount(A);unknown.pending.shift().resolve(result(A,{publication:{state:"pending",url:url(A),lastCheck:"toString"}}));await tick();
check("unknown verification codes use a safe Japanese fallback",()=>{assert.match(text(unknown.root),/確認結果：確認できません/);assert.doesNotMatch(text(unknown.root),/function|toString/);});
// Exercise the real composer: opening registered records and starting a new draft.
const mounted=[],disposed=[];
const composition={document:{createElement:t=>new Element(t)},navigator:{},URL,console};composition.window=composition;
composition.API={api:async()=>({ready:true,items:[]})};
composition.MarketingSitePublication={mount:(node,ref)=>{mounted.push(ref.id);return()=>disposed.push(ref.id);}};
vm.createContext(composition);vm.runInContext(read("js/marketing-space-release-draft.js"),composition);
vm.runInContext(composer.replace("snapshot(){return", "__review:{state,openSaved,render},snapshot(){return"),composition);
const composerRoot=new Element("section"),app=composition.MarketingHandoffComposer;app.mount(composerRoot);await tick();
const registered=id=>({id,version:4,status:"registered",registeredAt:"2026-10-26T10:00:00Z",payload:{draft:{title:"PR",summary:"概要",features:[],images:[]},body_override:"原稿本文"}});
app.__review.openSaved(registered(A));
check("reopened registered PR enters completion and mounts publication status",()=>{assert.equal(app.snapshot().stage,"complete");assert.deepEqual(mounted,[A]);assert.match(text(composerRoot),/この社内本登録だけでは/);assert.doesNotMatch(text(composerRoot),/サイト公開、SNS投稿、ブラストメール送信はまだ行っていません/);});
app.__review.openSaved(registered(B));
check("switching registered PR disposes the old publication controller first",()=>{assert.deepEqual(disposed,[A]);assert.deepEqual(mounted,[A,B]);});
walk(composerRoot).find(x=>x.tag==="button"&&x.textContent==="新しいPRを作成").onclick();
check("starting a new PR disposes publication and returns to edit without publishing",()=>{assert.deepEqual(disposed,[A,B]);assert.equal(app.snapshot().stage,"edit");assert.equal(app.snapshot().id,null);assert.deepEqual(mounted,[A,B]);});
console.log(`Marketing site publication UI: ${n} synthetic DOM checks passed (not a browser or live publication)`);
