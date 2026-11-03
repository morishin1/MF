// Sales dashboard chart primitives. Aggregates are from authenticated, tenant-scoped API.
(() => {
 const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const val=v=>Number.isFinite(Number(v))?Math.max(0,Number(v)):0;
 const fmt=v=>val(v).toLocaleString("ja-JP",{maximumFractionDigits:1});
 const palette=["#24466d","#4286ad","#5eaa94","#d8a54b","#8b8caf","#acbacd"];
 const empty='<p class="sv-empty">対象期間の記録がありません</p>';
 function bars(rows=[],{title="比較",unit="件",maxRows=8}={}){
  if(!Array.isArray(rows)||!rows.length)return empty;
  const safe=rows.slice(0,maxRows).map(r=>({label:String(r.label??"未確認"),value:val(r.value),detail:r.detail==null?"":String(r.detail)}));
  const max=Math.max(1,...safe.map(r=>r.value));
  return '<div class="sv-bars" role="img" aria-label="'+esc(title)+'">'+safe.map(r=>
   '<div class="sv-bar-row"><span class="sv-bar-label" title="'+esc(r.label)+'">'+esc(r.label)+'</span>'+
   '<span class="sv-bar-track"><i class="sv-bar-fill" style="width:'+(100*r.value/max).toFixed(2)+'%"></i></span>'+
   '<strong class="sv-bar-count">'+esc(fmt(r.value))+esc(unit)+'</strong>'+
   (r.detail?'<small class="sv-bar-detail">'+esc(r.detail)+'</small>':"")+'</div>').join("")+'</div>';
 }
 function donut(rows=[],{title="内訳",centerLabel="終了",maxSlices=5}={}){
  const safe=(Array.isArray(rows)?rows:[]).map(r=>({label:String(r.label??"未分類"),value:val(r.value)}))
   .filter(r=>r.value>0).sort((a,b)=>b.value-a.value);
  if(!safe.length)return empty;
  const sections=safe.slice(0,maxSlices);
  if(safe.length>maxSlices)sections.push({label:"その他",value:safe.slice(maxSlices).reduce((s,r)=>s+r.value,0)});
  const total=sections.reduce((s,r)=>s+r.value,0);let current=0;
  const stops=sections.map((r,i)=>{const start=current;current+=100*r.value/total;
   return palette[i%palette.length]+" "+start.toFixed(2)+"% "+current.toFixed(2)+"%";});
  return '<div class="sv-donut"><div class="sv-ring" style="background:conic-gradient('+stops.join(",")+
   ')" role="img" aria-label="'+esc(title)+': '+esc(fmt(total))+'件"><div class="sv-ring-middle"><strong>'+esc(fmt(total))+
   '</strong><small>'+esc(centerLabel)+'</small></div></div><div class="sv-legend">'+sections.map((r,i)=>
    '<div class="sv-legend-row"><i style="background:'+palette[i%palette.length]+'"></i><span>'+esc(r.label)+'</span>'+
    '<strong>'+esc(fmt(r.value))+'件 / '+(100*r.value/total).toFixed(1)+'%</strong></div>').join("")+'</div></div>';
 }
 function line(rows=[],{title="日別の営業実績"}={}){
  if(!Array.isArray(rows)||!rows.length)return empty;
  const safe=rows.map(r=>({date:String(r.date||""),sent:val(r.sent),meetings:val(r.meetings)}));
  const width=580,height=172,left=18,right=12,top=11,bottom=25;
  const max=Math.max(1,...safe.map(r=>Math.max(r.sent,r.meetings)));
  const x=i=>left+(width-left-right)*(safe.length===1?.5:i/(safe.length-1));
  const y=n=>top+(height-top-bottom)*(1-n/max);
  const points=key=>safe.map((r,i)=>x(i).toFixed(2)+","+y(r[key]).toFixed(2)).join(" ");
  const grids=[0,.5,1].map(frac=>'<line x1="'+left+'" y1="'+y(max*frac).toFixed(2)+
   '" x2="'+(width-right)+'" y2="'+y(max*frac).toFixed(2)+'" stroke="#e5eaf1"/>').join("");
  const anchors=[0,Math.floor((safe.length-1)/2),safe.length-1].filter((n,i,a)=>a.indexOf(n)===i);
  const labels=anchors.map(i=>'<text x="'+x(i).toFixed(2)+'" y="'+(height-3)+'" text-anchor="'+
   (i===0?"start":i===safe.length-1?"end":"middle")+'" font-size="10" fill="#67788c">'+
   esc(safe[i].date.slice(5).replace("-","/"))+'</text>').join("");
  return '<div class="sv-line" role="img" aria-label="'+esc(title)+': 送信'+
   esc(fmt(safe.reduce((s,r)=>s+r.sent,0)))+'件、面談実施'+esc(fmt(safe.reduce((s,r)=>s+r.meetings,0)))+
   '件"><svg viewBox="0 0 '+width+' '+height+'" aria-hidden="true">'+grids+
   '<polyline points="'+points("sent")+'" fill="none" stroke="#24466d" stroke-width="3" stroke-linejoin="round"/>'+
   '<polyline points="'+points("meetings")+'" fill="none" stroke="#5eaa94" stroke-width="3" stroke-linejoin="round"/>'+
   labels+'</svg><div class="sv-key"><span><i style="background:#24466d"></i>提案送信</span>'+
   '<span><i style="background:#5eaa94"></i>面談実施</span></div></div>';
 }
 window.SalesVisuals={bars,donut,line};
})();