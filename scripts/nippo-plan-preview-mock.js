// Synthetic in-memory adapter only: never imports auth, API client or storage.
(function (root) {
  const clone = x => JSON.parse(JSON.stringify(x));
  const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  const today = new Date(), day = today.getFullYear()+"-"+String(today.getMonth()+1).padStart(2,"0")+"-"+String(today.getDate()).padStart(2,"0");
  let next = 3;
  const rows = [
    {id:"00000000-0000-4000-8000-000000000001", title:"サンプル：資料の確認",starts_at:day+"T09:00:00+09:00",ends_at:day+"T10:00:00+09:00",planned_quantity:10,planned_quantity_unit:"件"},
    {id:"00000000-0000-4000-8000-000000000002", title:"サンプル：打ち合わせ",starts_at:day+"T10:00:00+09:00",ends_at:day+"T10:30:00+09:00",planned_quantity:null,planned_quantity_unit:null}
  ].map(row=>({...row,source:"self",category:"work",visibility:"shared",all_day:false,location:null}));
  function write(fields, id) {
    const previous=rows.find(r=>r.id===id);
    const event={...previous,id,source:"self",category:fields.category||"work",visibility:"shared",all_day:false,
      title:fields.title,starts_at:fields.startsAt,ends_at:fields.endsAt,location:fields.location||null};
    if(Object.hasOwn(fields,"plannedQuantity"))event.planned_quantity=fields.plannedQuantity;
    if(Object.hasOwn(fields,"plannedQuantityUnit"))event.planned_quantity_unit=fields.plannedQuantityUnit;
    if(previous)rows[rows.indexOf(previous)]=event;else rows.push(event);
    return {event:clone(event)};
  }
  root.KPLayout={esc,init:async()=>({demo:true})};
  root.API={
    schedule:async(from,to)=>({events:clone(rows.filter(r=>Date.parse(r.starts_at)<Date.parse(to)&&Date.parse(r.ends_at)>Date.parse(from))),eventsStatus:"available",quantityAvailable:true}),
    createEvent:async fields=>write(fields,"00000000-0000-4000-8000-"+String(next++).padStart(12,"0")),
    updateEvent:async fields=>write(fields,fields.id),
    deleteEvent:async id=>{const i=rows.findIndex(r=>r.id===id);if(i>=0)rows.splice(i,1);return {ok:true};},
    api:async()=>({ai:false,summary:"確認版です。実際のAI・認証・業務データには接続していません。",metrics:{totalMinutes:0,overlaps:0}})
  };
  root.PreviewPlans={read:()=>clone(rows)};
})(window);
