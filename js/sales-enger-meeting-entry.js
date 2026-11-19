// No session/password/publication writes on page load or retry.
(() => {
  const status=document.getElementById('entry-status');
  if(!status)return;
  const actions=document.getElementById('entry-actions'),confirm=document.getElementById('entry-confirm');
  const retry=document.getElementById('entry-retry');
  const params=new URLSearchParams(location.search);
  let busy=false,linkCompany=null;
  const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  function destination(raw,companyId){
    const url=new URL(raw);
    if(url.origin!=='https://enger.jp'||url.pathname!=='/business/agent-meeting'||
       url.username||url.password||url.hash||url.searchParams.get('companyId')!==companyId||
       [...url.searchParams.keys()].some(k=>!['companyId','sessionId'].includes(k)||url.searchParams.getAll(k).length!==1)||
       (url.searchParams.has('sessionId')&&!uuid.test(url.searchParams.get('sessionId'))))throw Error('商談URLを確認できませんでした。');
    return url.href;
  }
  async function load(){
    if(busy)return;busy=true;linkCompany=null;confirm.hidden=true;actions.hidden=true;
    status.textContent='企業と保存済み商談を確認しています…';
    try{
      const result=await API.api('/api/sales/enger-meeting-entry?'+params);
      if(!result.ok||!uuid.test(result.companyId||''))throw Error('商談の照合結果を確認できませんでした。');
      const url=destination(result.url,result.companyId);
      status.textContent=result.companyName+'のENGER商談を'+(result.session?'再開します。':'開きます。');
      location.replace(url);
    }catch(error){
      status.textContent=error?.hint||error?.message||'商談画面を確認できませんでした。';
      if(error?.code==='sales_link_confirmation_required'&&uuid.test(error.body?.companyId||'')){
        linkCompany=error.body.companyId;confirm.hidden=false;
      }
      actions.hidden=false;
    }finally{busy=false;}
  }
  retry.onclick=()=>void load();
  confirm.onclick=async()=>{
    if(busy||!linkCompany)return;
    busy=true;confirm.disabled=true;retry.disabled=true;
    try{
      const result=await API.api('/api/sales/enger-company-action',{method:'POST',body:{id:linkCompany}});
      if(!uuid.test(result.companyId||''))throw Error('連携結果を確認できませんでした。');
      busy=false;await load();
    }catch(error){status.textContent=error?.hint||error?.message||'連携結果は未確認です。再確認してください。';}
    finally{busy=false;confirm.disabled=false;retry.disabled=false;}
  };
  SalesLayout.init({active:'companies'}).then(ctx=>{if(ctx)void load();});
})();
