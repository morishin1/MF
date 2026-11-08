// Safe-to-use *search hints* from a cloud company analysis.
// This never confers verified status, publishes, or scores an ENGER proposal.
export function cloudDemandHintSkills(cloud,normalizeSkills,nowMs=Date.now()){
 const observed=Date.parse(cloud?.processed_at||"");
 if(!cloud||cloud.status!=="completed"||!Number.isFinite(observed)||
   observed>nowMs+60000||nowMs-observed>90*86400000)return [];
 const validSources=new Set((Array.isArray(cloud.sources)?cloud.sources:[])
   .filter(s=>s?.source_kind==="official_site").map(s=>{
     try {const u=new URL(s.url);return u.protocol==="https:"?u.href:null;} catch{return null;}
   }).filter(Boolean));
 const result=[];
 for(const h of (Array.isArray(cloud.match_signals?.demand_hypotheses)?
   cloud.match_signals.demand_hypotheses:[]).slice(0,5)){
   if(h?.status!=="hypothesis")continue;
   let href;try {const url=new URL(h?.source_url);href=url.protocol==="https:"?url.href:null;}catch{continue;}
   if(!href||!validSources.has(href))continue;
   const at=Date.parse(h?.checked_at||"");
   if(!Number.isFinite(at)||Math.abs(at-observed)>4*86400000)continue;
   const normalized=normalizeSkills(Array.isArray(h.skills)?h.skills:[]);
   for(const skill of Array.isArray(normalized)?normalized:[]){
     if(typeof skill!=="string"||!skill.trim())continue;
     if(!result.includes(skill))result.push(skill);
     if(result.length>=4)return result;
   }
 }
 return result;
}