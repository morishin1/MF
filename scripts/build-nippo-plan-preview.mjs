// Embeds the actual weekly editor and unchanged shared report/quantity helpers.
// This is a mock adapter, not a production authentication bypass.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import vm from "node:vm";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const out=resolve(process.argv[2]||"/tmp/nippo-plan-preview-20261028");
if(out===root)throw Error("Use a separate output directory");
const read=p=>readFileSync(join(root,p),"utf8"),hash=s=>createHash("sha256").update(s).digest("hex");
const helpers=["js/calendar-quantity.js","js/nippo-schedule.js"];
let html=read("work-week.html").replace(/<link[^>]*>/g,"").replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g,"$1（確認版では移動しません）");
const css=["css/app.css","css/layout.css","css/member-design.css"].map(read).join("\n");
if(/url\(|@import/i.test(css))throw Error("Inspect external CSS resources first");
html=html.replace("<style>",`<style>${css}</style><style>`);
html=html.replace("<title>週間業務カレンダー｜エイト</title>","<title>時間・内容・数字 → 日報｜実装確認版</title>");
html=html.replace("</head>",`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>
body{font-family:system-ui,sans-serif!important}.wrap.wk-shell{margin:0 auto!important}.preview-banner{padding:20px;background:#16314b;color:white;line-height:1.8}.preview-banner p{margin:4px 0;font-size:13px}.preview-banner b{font-size:19px}.np-schedule-item{border:1px solid #dce4ed;border-radius:10px;padding:16px;margin:12px 0}.np-schedule-item .t{display:flex;gap:8px;align-items:center}.np-schedule-item .task{flex:1}.np-schedule-item .muted{font-size:12px;line-height:1.7}.np-schedule-measures{display:grid;grid-template-columns:1fr 1fr;gap:12px}.np-schedule-measures label{font-size:12px;min-width:0}.np-schedule-number{display:flex;gap:6px}.np-schedule-number input{width:60%;min-width:0}.np-schedule-number input:last-child{width:40%}@media(max-width:640px){.np-schedule-measures{grid-template-columns:1fr}.np-schedule-item .t{display:block}}
</style></head>`);
html=html.replace('<body class="gw-member-ui">',`<body class="gw-member-ui"><aside class="preview-banner"><b>予定は「時間・内容・数字」の3つ → 日報は実績だけ</b><p>① 予定を変更して保存　② 下の日報へ引き継ぐ　③ 実際の時間・数字だけを記録</p><p>ログイン不要のダミー確認版。保存先はこの画面のメモリだけで、再読み込みでリセットします。本番・他の社員・AIへの接続や通知はありません。実業務情報は入力しないでください。例の10件は実際のノルマではありません。</p><p>ローカル相当の確認用デモ・未本番・数量のSQL 2列は未適用です。実ブラウザ描画・認証・DB検証は未実施です。Pの継続読取接続はこの確認版には含みません。</p></aside>`);
html=html.replace('保存しました。ほかの社員のスケジュールにも反映されます。','確認版の画面内だけに保存しました。本番・他の社員には反映されません。');
html=html.replace('AIで時間割を確認','確認版の接続状態');
html=html.replace(/<script src="\/js\/api-client\.js[^\"]*"><\/script>\s*<script src="\/js\/layout(?:-marketing)?\.js[^\"]*"><\/script>/,()=>`<script>${read("scripts/nippo-plan-preview-mock.js")}</script>`);
html=html.replace(/<script src="\/js\/calendar-quantity\.js[^\"]*"><\/script>/,()=>`<script>${read(helpers[0])}</script>`);
html=html.replace("</body>",`<section class="wrap wk-shell"><div class="wk-editor"><h2 id="preview-report-date">日報への引継ぎ（確認用）</h2><p>内容や目標を入力し直さず、選んだ日の予定を引き継ぎます。空欄は未計測であり0ではありません。</p><button class="btn btn-primary" onclick="previewReportOpen()">選んだ日の予定を日報へ引き継ぐ</button><p id="preview-report-status" role="status"></p><div id="preview-report-rows"></div><button id="preview-report-save" class="btn btn-primary" hidden onclick="previewReportSave()">実績を画面内に記録</button><p class="muted">システム実績：未接続・未確認。自己申告とは分けて表示します。出典はありません。予定枠と実作業時間は異なります。品質・割込み・難易度は必要時にPが確認します。</p></div></section><script>${read(helpers[1])}</script><script>${read("scripts/nippo-plan-preview-report.js")}</script></body>`);
if(/<(?:script|link)[^>]*(?:src|href)=|\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(|\b(?:localStorage|sessionStorage|indexedDB)\b/.test(html))throw Error("Unexpected external resource/network/storage in preview");
for(const path of helpers)if(!html.includes(read(path)))throw Error("Shared helper changed in preview");
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
mkdirSync(out,{recursive:true});writeFileSync(join(out,"index.html"),html);
writeFileSync(join(out,"manifest.json"),JSON.stringify({kind:"synthetic-memory-only-preview",entry:"index.html",network:"CSP connect-src none",persistence:"none",browserVerified:false,productionSource:"work-week.html",sourceSha256:hash(read("work-week.html")),helpers:helpers.map(source=>({source,sha256:hash(read(source))})),htmlSha256:hash(html)},null,2)+"\n");
console.log(join(out,"index.html"));
