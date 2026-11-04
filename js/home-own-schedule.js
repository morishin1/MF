// ホーム下段「自分の予定」: 業務予定だけ表示し、複数選択して一括更新する。
// 既存のタスク・入社手続き・Google個人予定は混在させない。権限はサーバ側で本人に固定。
(function(){
  "use strict";
  const el=id=>document.getElementById(id);
  const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const dateKey=d=>{
    const parts=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(d));
    const v=k=>parts.find(p=>p.type===k)?.value;
    return v("year")+"-"+v("month")+"-"+v("day");
  };
  const plusDays=(ymd,n)=>{
    const d=new Date(ymd+"T12:00:00+09:00");
    d.setUTCDate(d.getUTCDate()+n);
    return d.toISOString().slice(0,10);
  };
  const weekBounds=today=>{
    const dow=new Date(today+"T12:00:00+09:00").getUTCDay(); // JST昼の UTC 日付は同じ
    const monday=plusDays(today,-((dow+6)%7));
    return [monday,plusDays(monday,6)];
  };
  const timeLabel=iso=>new Date(iso).toLocaleTimeString("ja-JP",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit"});
  const dateLabel=ymd=>ymd.slice(5).replace("-","/");
  const categoryLabel={work:"業務",meeting:"会議",visit:"訪問",other:"その他"};
  const statusLabel={todo:"未着手",doing:"対応中",done:"対応済み"};
  let items=[],view="week",selected=new Set(),visibleIds=[],saving=false,employeeName="自分",ready=false;
  let loadSerial=0;

  function shown(kind, today){
    const [monday,sunday]=weekBounds(today);
    if(kind==="today")return items.filter(e=>dateKey(e.starts_at)===today);
    if(kind==="week")return items.filter(e=>{
      const day=dateKey(e.starts_at);
      return day>=monday&&day<=sunday;
    });
    if(kind==="open")return items.filter(e=>e.work_status!=="done");
    return items;
  }
  function syncToolbar(){
    const found=[...selected].filter(id=>items.some(e=>String(e.id)===id));
    if(found.length!==selected.size)selected=new Set(found);
    const toolbar=el("home-event-bulk");
    toolbar.hidden=!found.length;
    el("home-event-selected-count").textContent=String(found.length);
    const selectAll=el("home-event-select-all");
    selectAll.disabled=saving||!visibleIds.length;
    selectAll.checked=!!visibleIds.length&&visibleIds.every(id=>selected.has(id));
    selectAll.indeterminate=visibleIds.some(id=>selected.has(id))&&!selectAll.checked;
    for(const node of toolbar.querySelectorAll("button,select"))node.disabled=saving;
    for(const node of document.querySelectorAll(".home-event-picker"))node.disabled=saving;
    el("home-event-add").disabled=saving;
    el("home-event-reload").disabled=saving;
  }
  function render(){
    const today=dateKey(new Date());
    for(const key of ["today","week","open","all"]){
      const n=document.querySelector('[data-own-count="'+key+'"]');
      if(n)n.textContent=String(shown(key,today).length);
    }
    for(const button of document.querySelectorAll("[data-own-view]")){
      const on=button.dataset.ownView===view;
      button.classList.toggle("on",on);
      button.setAttribute("aria-pressed",String(on));
      button.disabled=saving;
    }
    const rows=shown(view,today).slice().sort((a,b)=>String(a.starts_at).localeCompare(String(b.starts_at))).slice(0,50);
    visibleIds=rows.map(e=>String(e.id));
    if(!rows.length){
      el("home-event-rows").innerHTML='<tr><td colspan="6" class="home-task-empty">'+
        "この期間の業務予定はありません。上のカレンダーから予定を登録できます。"+'</td></tr>';
      syncToolbar();
      return;
    }
    el("home-event-rows").innerHTML=rows.map(e=>{
      const id=String(e.id);
      const status=statusLabel[e.work_status]||statusLabel.todo;
      const statClass=["done","doing"].includes(e.work_status)?e.work_status:"todo";
      const day=dateKey(e.starts_at);
      const selectedClass=selected.has(id)?" is-selected":"";
      const times=e.all_day?"終日":timeLabel(e.starts_at)+"〜"+timeLabel(e.ends_at);
      return '<tr data-event-id="'+esc(id)+'" class="'+selectedClass+'">'+
        '<td><input type="checkbox" class="home-event-picker"'+(selected.has(id)?" checked":"")+
        ' aria-label="選択: '+esc(e.title)+'"></td>'+
        '<td class="home-task-name"><a href="calendar.html?date='+encodeURIComponent(day)+'">'+esc(e.title)+'</a></td>'+
        '<td>'+esc(dateLabel(day))+' '+esc(times)+'</td>'+
        '<td>'+esc(categoryLabel[e.category]||"業務")+'</td>'+
        '<td>'+esc(employeeName)+'</td>'+
        '<td><span class="ht-pill '+statClass+'">'+status+'</span></td></tr>';
    }).join("");
    syncToolbar();
  }
  function message(text,isError=false){
    const node=el("home-event-message");
    node.textContent=text||"";
    node.style.color=isError?"#b3261e":"#247347";
  }
  async function load(){
    if(!ready||saving)return;
    const seq=++loadSerial;
    const today=dateKey(new Date());
    const from=plusDays(today,-30)+"T00:00:00+09:00";
    const to=plusDays(today,91)+"T00:00:00+09:00";
    el("home-event-range").textContent="（表示範囲：前30日〜今後90日）";
    try{
      const q="?view=home&from="+encodeURIComponent(from)+"&to="+encodeURIComponent(to);
      const data=await API.api("/api/schedule"+q);
      if(seq!==loadSerial)return;
      items=(data.items||[]).filter(e=>e.source==="self");
      const ids=new Set(items.map(e=>String(e.id)));
      selected=new Set([...selected].filter(id=>ids.has(id)));
      render();
      message(data.truncated?"予定が500件を超えています。表示期間を分けて確認してください。":"",!!data.truncated);
    }catch(e){
      if(seq!==loadSerial)return;
      items=[];selected.clear();visibleIds=[];
      el("home-event-rows").innerHTML='<tr><td colspan="6" class="home-task-empty">業務予定を取得できませんでした。上のカレンダーから確認してください。</td></tr>';
      syncToolbar();
      message(e.hint||"予定を取得できませんでした",true);
    }
  }
  async function update(status){
    if(saving||!selected.size||!["todo","doing","done"].includes(status))return;
    const ids=[...selected];
    saving=true;
    syncToolbar();
    message("");
    try{
      // APIは tenant_id・employee_id・source=self を固定し、本人の予定のみを1回で更新する。
      const data=await API.api("/api/schedule",{method:"POST",body:{action:"bulk_work_status",ids,status}});
      if(!data.ok||data.count!==ids.length)throw new Error("更新件数が一致しませんでした");
      selected.clear();
      // 入力結果を即時に表示。再取得できない場合は変更前の状態と取り違えないよう通知する。
      const byId=new Map((data.items||[]).map(e=>[String(e.id),e]));
      for(const item of items){
        const after=byId.get(String(item.id));
        if(after){item.work_status=after.work_status;item.completed_at=after.completed_at;}
      }
      render();
      message(ids.length+"件の予定を"+statusLabel[status]+"に更新しました。");
    }catch(e){
      // 失敗した場合は選択を維持して再操作できるようにする。
      message(e.hint||e.message||"更新できませんでした",true);
    }finally{
      saving=false;
      syncToolbar();
    }
  }
  function init(ctx){
    employeeName=ctx?.me?.gw?.employee?.display_name||"自分";
    if(!ctx?.me?.gw?.employee?.id){
      el("home-event-rows").innerHTML='<tr><td colspan="6" class="home-task-empty">社員名簿への登録後、本人の予定が表示されます。</td></tr>';
      el("home-event-add").disabled=true;
      return;
    }
    ready=true;
    document.querySelectorAll("[data-own-view]").forEach(button=>button.addEventListener("click",()=>{
      if(saving)return;
      view=button.dataset.ownView;
      selected.clear();
      render();
    }));
    el("home-event-rows").addEventListener("change",ev=>{
      if(!ev.target.matches(".home-event-picker")||saving)return;
      const row=ev.target.closest("tr[data-event-id]");
      if(!row)return;
      const id=row.dataset.eventId;
      if(ev.target.checked)selected.add(id);else selected.delete(id);
      row.classList.toggle("is-selected",ev.target.checked);
      syncToolbar();
    });
    el("home-event-select-all").addEventListener("change",ev=>{
      if(saving)return;
      for(const id of visibleIds){if(ev.target.checked)selected.add(id);else selected.delete(id);}
      render();
    });
    el("home-event-bulk-apply").addEventListener("click",()=>update(el("home-event-bulk-status").value));
    el("home-event-bulk-done").addEventListener("click",()=>update("done"));
    el("home-event-bulk-clear").addEventListener("click",()=>{
      if(saving)return;
      selected.clear();
      message("");
      render();
    });
    el("home-event-reload").addEventListener("click",load);
    el("home-event-add").addEventListener("click",()=>{
      const frame=el("home-calendar-frame");
      try{
        if(typeof frame?.contentWindow?.newEvent==="function"){
          frame.scrollIntoView({behavior:"smooth",block:"start"});
          frame.contentWindow.newEvent();
          return;
        }
      }catch{/* iframeがまだ読み込み中なら専用のカレンダーへ */}
      location.href="calendar.html";
    });
    // ホームのカレンダーから予定を登録・編集したとき、一覧にも反映する。
    window.addEventListener("message",ev=>{
      if(ev.origin!==location.origin||ev.source!==el("home-calendar-frame")?.contentWindow)return;
      if(ev.data?.type==="gw:calendar-saved")load();
    });
    load();
  }
  window.HomeSchedule={init};
})();
