/** Stable visible company number; the underlying UUID remains the sole relational key. */
export function formatCompanyNumber(value) {
 if(value===null||value===undefined||value==="")return "";
 const n=Number(value);
 if(!Number.isSafeInteger(n)||n<=0)return "";
 return String(n).padStart(5,"0");
}
export function companyNumberSearchTerm(value) {
 const raw=String(value??"").trim();
 if(!/^[0-9]{1,12}$/.test(raw))return "";
 const n=Number(raw);
 return Number.isSafeInteger(n)&&n>0?String(n):"";
}
