// Sales proposal page: surface company-portal offers in the existing proposal workspace.
// This is NOT a second offer-management workflow; statuses use the shared Sales API.
(function(){
 const host=document.getElementById('pp-company-offers');if(!host)return;
 const h=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(cls)e.className=cls;return e;};
 const time=s=>{if(!s)return '日時未登録';try{return new Date(s).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});}catch{return '日時未登録';}};
 const statuses={new:'未対応',contacting:'連絡中',meeting:'面談調整',negotiating:'条件交渉',won:'成約確認待ち',lost:'見送り'};
 async function load(){
  try{
   const result=await API.api('/api/sales/company-offers');
   const rows=Array.isArray(result?.offers)?result.offers:[];
   const open=rows.filter(x=>!['won','lost'].includes(x.status));
   if(!open.length){host.hidden=true;host.replaceChildren();return;}
   host.replaceChildren();host.hidden=false;
   const top=h('div',null,'pp-company-offer-head');
   top.append(h('strong','企業からのオファー '+open.length+'件'),h('small','未対応・対応中のオファーを提案管理で確認します。成約確定は別途記録が必要です。'));
   const refresh=h('button','更新');refresh.type='button';refresh.addEventListener('click',()=>void load());top.append(refresh);host.append(top);
   const list=h('div',null,'pp-company-offer-items');
   for(const offer of open.slice(0,12)){
     const item=h('div',null,'pp-company-offer-item');
     const intro=h('div',null,'pp-company-offer-info');
     intro.append(h('strong',(offer.companyName||'企業名未登録')+' ／ '+(offer.title||'案件・人材')));
     intro.append(h('small',time(offer.createdAt)+' ／ '+(offer.memberName||'企業担当者')+' ／ '+(offer.statusLabel||statuses[offer.status]||offer.status)));
     const actions=h('div',null,'pp-company-offer-actions');
     const link=h('a','企業詳細');link.href='/sales/company-segments.html?companyId='+encodeURIComponent(offer.companyId);actions.append(link);
     const select=h('select');select.setAttribute('aria-label','対応状態');
     for(const [value,label] of Object.entries(statuses)){const opt=h('option',label);opt.value=value;select.append(opt);}
     select.value=offer.status||'new';
     const save=h('button','保存');save.type='button';save.disabled=true;
     select.onchange=()=>{save.disabled=select.value===offer.status;};
     save.onclick=async()=>{
       if(!confirm('オファーの対応状態を「'+statuses[select.value]+'」に変更しますか？'))return;
       save.disabled=true;
       try{
         await API.api('/api/sales/company-offers',{method:'PATCH',body:{
           companyId:offer.companyId,offerId:offer.id,status:select.value,
           expectedStatus:offer.status,confirmed:true
         }});
         await load();
       }catch(e){
         save.disabled=false;const status=h('small',e?.hint||'更新できませんでした。');item.append(status);
       }
     };
     actions.append(select,save);item.append(intro,actions);list.append(item);
   }
   host.append(list);
  }catch{host.hidden=true;host.replaceChildren();}
 }
 setTimeout(()=>{void load();},700);
 document.addEventListener('sales:offer-changed',()=>{void load();});
})();
