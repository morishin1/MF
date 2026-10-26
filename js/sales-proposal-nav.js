// Salesの「提案」タブをダッシュボードの隣にする。
// 既存共通 sales-layout.js は長期キャッシュ対象のため変更せず、レンダリング後に並び替える。
(function(){
"use strict";
const old=window.SalesLayout?.init;
if(typeof old!=="function")return;
window.SalesLayout.init=async function(options){
 const ctx=await old.call(window.SalesLayout,options);
 if(!ctx)return ctx;
 const nav=document.querySelector(".sl-nav");
 const dash=nav?.querySelector('a[href="/sales/"]');
 const proposal=nav?.querySelector('a[href="/sales/proposals.html"]');
 if(dash&&proposal)dash.after(proposal);
 return ctx;
};
})();
