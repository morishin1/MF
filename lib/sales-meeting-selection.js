// Explicit selection is only a filter for already-published, company-scoped rows.
// Company permission must be checked BEFORE this is called.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseMeetingSelection(value){
 if(value===null||value===undefined)return null; // legacy: all company-published items
 if(typeof value!=="string"||!value||value.length>520)return {error:"invalid_selection"};
 const parts=value.split(",");
 if(parts.length<1||parts.length>10)return {error:"selection_limit"};
 const keys=new Set();
 for(const part of parts){
  const match=/^(talent|job):(.+)$/.exec(part);
  if(!match||!UUID.test(match[2]))return {error:"invalid_selection"};
  const key=match[1]+":"+match[2].toLowerCase();
  if(keys.has(key))return {error:"duplicate_selection"};
  keys.add(key);
 }
 return {keys};
}
export function matchMeetingSelection(row,parsed){
 if(!parsed)return true;
 if(parsed.error||!row)return false;
 const id=row.item_type==="talent"?row.candidate_id:row.item_type==="job"?row.job_id:null;
 return Boolean(id&&parsed.keys.has(row.item_type+":"+String(id).toLowerCase()));
}
