// Word→PR mapper: deterministic, no AI/web calls or database mutation.
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const code=read("js/marketing-word-import.js");
const page=read("marketing/index.html");
const composer=read("js/marketing-handoff-composer.js");
const ctx={console,Date};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx);
const api=ctx.MarketingWordImport;
let count=0;const check=(cond,msg)=>{assert.ok(cond,msg);count++;};
const raw=[
 "株式会社エイト、地域向けAI実践講座を開始",
 "概要：企業と住民がAIを学び、仕事のアイデアを形にする講座を提供します。",
 "背景・目的",
 "地域でAIを実際に使う機会が不足していました。",
 "特徴",
 "実践形式：受講者が自分でプロトタイプを制作する",
 "地域と連携：地域の課題に基づく学習",
 "今後の展望：実践結果を地域の活動へつなげます。",
 "開催日：2026年11月14日",
 "会場名：原宿",
 "会社概要",
 "会社名：株式会社エイト",
 "所在地：東京都渋谷区",
 "お問い合わせ先",
 "Email：info@example.com",
 "電話番号：03-1234-5678"
].join("\n");
const m=api.parseText(raw);
check(m.fields.title==="株式会社エイト、地域向けAI実践講座を開始","title extracted");
check(m.fields.summary.includes("企業と住民"),"lead extracted");
check(m.fields.background.includes("地域でAI"),"background extracted");
check(m.fields.features.length===2&&m.fields.features[0].title==="実践形式","features extracted");
check(m.fields.future.includes("実践結果"),"future extracted");
check(m.fields.event_on==="2026-11-14","date converted explicitly");
check(m.fields.venue_name==="原宿","venue");
check(m.fields.company==="株式会社エイト","company");
check(m.fields.contact_email==="info@example.com","email");
check(m.fields.contact_tel==="03-1234-5678","telephone");
check(!Object.hasOwn(m.fields,"representative"),"no fictional representative");
check(api.parseText("タイトル：短い発表\n概要：新しい製品").fields.title==="短い発表","explicit title over fallback");
check(!Object.hasOwn(api.parseText("開催日：2026年2月31日").fields,"event_on"),"invalid date not guessed");
check(api.parseText("タイトル：ニュース\n概要："+("長".repeat(650))).warnings.length===1,"long field not silently clipped");
check(!/fetch\(|XMLHttpRequest|sendBeacon|\.post\(|API\.api|localStorage|sessionStorage/.test(code),"extractor contains no network or save hooks");
check(page.indexOf("marketing-word-import.js")<page.indexOf("marketing-handoff-composer.js"),"Word extractor loads before editor");
check(page.includes("marketing-word-import-ui.js")&&page.includes("marketing-word-import.css"),"review UI and styles wired");
check(composer.includes("applyImported(fields)")&&composer.includes("window.MarketingWordImportUI?.mount"),"import marks draft unsaved and edits existing form");
console.log("Marketing local Word mapper: "+count+" checks passed");
