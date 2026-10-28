// Preview-only wiring around the unchanged production NippoSchedule helpers.
(function (root) {
  const reports=new Map();let activeDay=null;
  const node=id=>document.getElementById(id),esc=KPLayout.esc;
  function collect() {
    if(!activeDay)return;
    const originals=reports.get(activeDay)||[];
    const rows=[...node("preview-report-rows").children].map((div,i)=>{
      const row={...originals[i]};
      for(const [key,max] of [["actual_minutes",1440],["actual",1e9]]){
        const raw=div.querySelector('[data-k="'+key+'"]').value;
        const value=raw===""?null:Number(raw);
        if(value!==null&&(!Number.isFinite(value)||value<0||value>max))throw Error("実績の数字を確認してください。空欄のままでも保存できます。");
        row[key]=value;
      }
      row.unit=div.querySelector('[data-k="unit"]').value;
      row.measurement_note=div.querySelector('[data-k="measurement_note"]').value;
      return row;
    });
    reports.set(activeDay,rows);
  }
  root.previewReportOpen=function(){
    try{
      if(dirty){node("preview-report-status").textContent="先に上の予定を保存してください。内容を再入力する必要はありません。";return;}
      collect();activeDay=selected;
      const from=Date.parse(activeDay+"T00:00:00+09:00"),to=from+86400000;
      const items=PreviewPlans.read().filter(e=>Date.parse(e.starts_at)<to&&Date.parse(e.ends_at)>from).map(e=>({
        task:e.title,schedule_event_id:e.id,planned_starts_at:e.starts_at,planned_ends_at:e.ends_at,planned_all_day:e.all_day,
        target:e.planned_quantity??null,unit:e.planned_quantity_unit||""
      }));
      const result=NippoSchedule.inherit(reports.get(activeDay)||[],{status:"available",items,quantityAvailable:true});
      reports.set(activeDay,result.items);
      node("preview-report-date").textContent=activeDay+" の日報（確認用）";
      node("preview-report-rows").innerHTML=result.items.map(r=>'<div class="np-schedule-item">'+NippoSchedule.rowHtml(r,esc)+'</div>').join("");
      node("preview-report-status").textContent=NippoSchedule.notice(result);
      node("preview-report-save").hidden=false;
    }catch(e){node("preview-report-status").textContent=e.message;}
  };
  root.previewReportSave=function(){
    try{collect();node("preview-report-status").textContent="この画面内だけに記録しました。予定を引き継ぎ直しても、入力済みの実績や保存時点の予定は上書きしません。本番には保存されません。";}
    catch(e){node("preview-report-status").textContent=e.message;}
  };
})(window);
