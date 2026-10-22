// All-member weekly/daily calendar. Only sanitized data returned by /api/schedule/team.
(function(){
"use strict";
const state={query:"",department:"",person:""};
let members=[],redraw=()=>{};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const jstDay=s=>new Date(new Date(s).getTime()+9*3600000).toISOString().slice(0,10);
const hm=s=>new Date(new Date(s).getTime()+9*3600000).toISOString().slice(11,16);
const time=e=>e.allDay?"終日":hm(e.startsAt)+"–"+hm(e.endsAt);
const tone=id=>"ct-tone-"+(Math.max(0,members.findIndex(x=>x.id===id))%6);
function visible(){
  const q=state.query.toLocaleLowerCase("ja-JP");
  return members.filter(p=>(!state.department||p.department===state.department)&&
    (!state.person||p.id===state.person)&&(!q||(p.name||"").toLocaleLowerCase("ja-JP").includes(q)));
}
function keep(e){return visible().some(p=>p.id===e.employeeId);}
function sync(people,render,scope){
 members=people||[];redraw=render;
 const root=document.getElementById("cal-team-tools"),note=document.getElementById("cal-team-caption");
 root.hidden=scope!=="team";note.hidden=scope!=="team";
 if(scope!=="team")return;
 if(!root.dataset.ready){
   root.innerHTML='<label>メンバー検索<input id="ct-search" type="search" placeholder="氏名で検索"></label>'+
   '<label>部署<select id="ct-department"></select></label><label>表示する人<select id="ct-person"></select></label>';
   root.querySelector("#ct-search").addEventListener("input",e=>{state.query=e.target.value;redraw();});
   root.querySelector("#ct-department").addEventListener("change",e=>{state.department=e.target.value;redraw();});
   root.querySelector("#ct-person").addEventListener("change",e=>{state.person=e.target.value;redraw();});
   root.dataset.ready="1";
 }
 const deps=[...new Set(members.map(p=>p.department).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"ja"));
 if(state.department&&!deps.includes(state.department))state.department="";
 if(state.person&&!members.some(p=>p.id===state.person))state.person="";
 const dep=root.querySelector("#ct-department"),person=root.querySelector("#ct-person");
 dep.innerHTML='<option value="">すべての部署</option>'+deps.map(d=>'<option value="'+esc(d)+'">'+esc(d)+'</option>').join("");
 person.innerHTML='<option value="">全員を表示</option>'+members.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name||"社員")+'</option>').join("");
 dep.value=state.department;person.value=state.person;root.querySelector("#ct-search").value=state.query;
 note.textContent="表示："+visible().length+"名／"+members.length+"名。時間と件名をカレンダー上で比較できます。予定を押すと詳細へ。『予定なし』は休暇・休日を意味しません（私用・本文メモは非公開）。";
}
function eventsOf(day,p,list,slot){
 return list.filter(e=>e.employeeId===p.id&&jstDay(e.startsAt)===day).filter(e=>{
  if(!slot)return true;
  const hour=e.allDay?0:Number(hm(e.startsAt).slice(0,2));
  return slot==="am"?hour<12:slot==="pm"?hour>=12&&hour<18:hour>=18;
 }).sort((a,b)=>a.startsAt.localeCompare(b.startsAt));
}
function cell(day,p,list,slot){
 const rows=eventsOf(day,p,list,slot),max=slot?6:3;
 const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 let html='<div class="ct-cell'+(day===today?" today":"")+'">';
 for(const e of rows.slice(0,max)){
  html+='<button type="button" class="ct-event '+tone(p.id)+'" data-ct-date="'+esc(day)+'" data-ct-person="'+esc(p.id)+'" data-ct-event="'+esc(e.id)+'" title="'+esc(time(e)+" "+e.title+(e.location?" ／ "+e.location:""))+'">'+
    '<b>'+esc(time(e))+'</b><span>'+esc(e.title||"業務予定")+'</span>'+(e.location?'<small>場所：'+esc(e.location)+'</small>':"")+'</button>';
 }
 if(rows.length>max)html+='<button type="button" class="ct-more" data-ct-date="'+esc(day)+'" data-ct-person="'+esc(p.id)+'">+'+(rows.length-max)+'件を見る</button>';
 if(!rows.length)html+='<button type="button" class="ct-empty" data-ct-date="'+esc(day)+'" data-ct-person="'+esc(p.id)+'">予定なし</button>';
 return html+'</div>';
}
function render(mode,opt){
 const selected=visible(),dates=opt.dates||[],parts=[["am","午前 ～12時"],["pm","午後 12～18時"],["evening","夕方以降 18時～"]];
 if(!selected.length){opt.root.innerHTML='<p class="muted">該当するメンバーはいません。絞り込みを変更してください。</p>';return;}
 let html='<div class="ct-scroll"><div class="ct-board '+(mode==="week"?"ct-week":"ct-day")+'" role="table" aria-label="メンバー別業務予定">'+
   '<div class="ct-head">メンバー</div>'+
   (mode==="week"?dates.map(d=>'<div class="ct-head">'+esc(opt.dayLabel(d))+'</div>'):parts.map(p=>'<div class="ct-head">'+p[1]+'</div>')).join("");
 for(const p of selected){
  html+='<div class="ct-person-name"><b>'+esc(p.name||"社員")+'</b><small>'+esc(p.department||"部署未設定")+'</small></div>';
  html+=(mode==="week"?dates.map(d=>cell(d,p,opt.events)):parts.map(part=>cell(opt.day,p,opt.events,part[0]))).join("");
 }
 opt.root.innerHTML=html+'</div></div>';
 opt.root.querySelectorAll("[data-ct-date]").forEach(b=>b.addEventListener("click",()=>opt.open(b.dataset.ctDate,b.dataset.ctPerson,b.dataset.ctEvent||null)));
}
window.CalendarTeamBoard={sync,keep,render};
})();