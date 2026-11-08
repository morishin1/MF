import {randomInt} from "node:crypto";
// Preview-only corporate ID + password demo. Never mint a real business identity
// from an unverified company email. The generated address is system-controlled,
// cannot receive invitations, and is intentionally rejected by production ENGER.
export function meetingPreviewDemoAllowed(env=process.env){
  if(env.VERCEL_ENV!=="preview"||env.ENGER_PORTAL_DEMO_ENABLED!=="true")return false;
  const base=String(env.ENGER_PORTAL_BASE_URL||"");
  try{
    const u=new URL(base);
    return u.protocol==="https:" &&
      /^enger(?:-lp)?-[a-z0-9-]+\.vercel\.app$/i.test(u.hostname) &&
      u.pathname==="/" && !u.username && !u.password;
  }catch{return false;}
}
export function meetingPreviewDemoEmail(companyId){
  if(typeof companyId!=="string"||
     !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId))
    return null;
  return "company-demo+"+companyId.replaceAll("-","").toLowerCase()+"@gw.8grp.co.jp";
}
export const MEETING_DEMO_HOURS=24;


/** Eight high-entropy characters; INTERNAL PREVIEW ONLY. Not used for real business users. */
export function newMeetingPreviewPassword(){
 const upper="ABCDEFGHJKLMNPQRSTUVWXYZ";
 const lower="abcdefghjkmnpqrstuvwxyz";
 const digits="23456789";
 const marks="!@";
 const chars=[upper[randomInt(upper.length)],lower[randomInt(lower.length)],
              digits[randomInt(digits.length)],marks[randomInt(marks.length)]];
 const alphabet=upper+lower+digits+marks;
 while(chars.length<8)chars.push(alphabet[randomInt(alphabet.length)]);
 for(let i=chars.length-1;i>0;i--){
  const j=randomInt(i+1);const tmp=chars[i];chars[i]=chars[j];chars[j]=tmp;
 }
 return chars.join("");
}
