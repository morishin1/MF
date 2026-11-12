// Pure, side-effect-free Word output for the HR trial-period labor conditions notice.
// Based on the headings of the submitted Word template. All legal/employment terms
// are supplied by the authorized HR reviewer; no example wage, date, or insurance
// setting from the template becomes an applicant's condition by default.
import crypto from "node:crypto";

export const FIELDS = Object.freeze([
  ["startDate","入社日"],["term","契約期間・更新条件"],["employment","雇用形態"],
  ["location","就業場所と変更範囲"],["duties","業務の内容と変更範囲"],
  ["hours","就業時間・休憩・所定外労働"],["holidays","休日"],["leave","休暇"],
  ["pay","賃金（基本給・手当・割増賃金率）"],["payment","賃金締切日・支払日・方法"],
  ["salaryReview","賃金改定"],["bonus","賞与"],["retirementPay","退職金"],
  ["discipline","懲戒"],["termination","退職に関する事項"],
  ["insurance","社会保険・雇用保険・労災保険"],["contacts","雇用管理改善相談窓口"],
  ["safety","安全衛生・義務"],["other","その他・就業規則の確認方法"],
]);
const MAX=1600;
export function validateNotice(values,{complete=false}={}){
  if(!values||typeof values!=="object"||Array.isArray(values))throw Error("invalid_notice");
  if(Object.keys(values).some(k=>!FIELDS.some(f=>f[0]===k)))throw Error("unknown_notice_field");
  const cleaned={};
  for(const [key] of FIELDS){
    const v=values[key]??"";
    if(typeof v!=="string"||v.length>MAX||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v))throw Error("invalid_"+key);
    cleaned[key]=v.replace(/\r\n/g,"\n").trim();
    if(complete&&!cleaned[key])throw Error("required_"+key);
  }
  return cleaned;
}
export function previewRows(values){
  const v=validateNotice(values,{complete:false});
  return FIELDS.map(([key,label])=>({key,label,value:v[key],complete:Boolean(v[key])}));
}
export function hash(v){return crypto.createHash("sha256").update(v).digest("hex");}
export function safeFilename(v){return String(v||"候補者").replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,"_").slice(0,65);}
const esc=s=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
function run(s,{bold=false,size=22}={}){
  const t=String(s??"").split("\n").map(esc);
  return '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Yu Gothic" w:hAnsi="Arial"/>'+(bold?'<w:b/>':'')+'<w:sz w:val="'+size+'"/></w:rPr>'+t.map((x,i)=>(i?'<w:br/>':'')+'<w:t xml:space="preserve">'+x+'</w:t>').join("")+'</w:r>';
}
function p(s,opts={}){
  return '<w:p><w:pPr><w:spacing w:after="100"/>'+(opts.center?'<w:jc w:val="center"/>':'')+'</w:pPr>'+run(s,opts)+'</w:p>';
}
function cell(s,{label=false}={}){
  return '<w:tc><w:tcPr><w:tcW w:w="'+(label?2400:6650)+'" w:type="dxa"/><w:shd w:fill="'+(label?'F5F6F8':'FFFFFF')+'"/></w:tcPr>'+p(s,{bold:label,size:label?21:20})+'</w:tc>';
}
function crc32(bytes){
  let c=0xffffffff;
  for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}
  return(c^0xffffffff)>>>0;
}
function zip(entries){
  const parts=[],directory=[];let offset=0;
  for(const [path,body] of entries){
    const name=Buffer.from(path,"utf8"),v=Buffer.isBuffer(body)?body:Buffer.from(body,"utf8"),crc=crc32(v);
    const h=Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);
    h.writeUInt32LE(crc,14);h.writeUInt32LE(v.length,18);h.writeUInt32LE(v.length,22);h.writeUInt16LE(name.length,26);
    parts.push(h,name,v);
    const d=Buffer.alloc(46);d.writeUInt32LE(0x02014b50,0);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);
    d.writeUInt32LE(crc,16);d.writeUInt32LE(v.length,20);d.writeUInt32LE(v.length,24);d.writeUInt16LE(name.length,28);d.writeUInt32LE(offset,42);
    directory.push(d,name);offset+=h.length+name.length+v.length;
  }
  const tail=Buffer.alloc(22);tail.writeUInt32LE(0x06054b50,0);tail.writeUInt16LE(entries.length,8);
  tail.writeUInt16LE(entries.length,10);tail.writeUInt32LE(directory.reduce((n,b)=>n+b.length,0),12);
  tail.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,...directory,tail]);
}
export function createTrialDocx({applicantName,companyName,issuedOn,values}={}){
  const v=validateNotice(values,{complete:true});
  const name=String(applicantName||"").trim(),company=String(companyName||"").trim();
  if(!name||name.length>150||!company||company.length>160||!/\d{4}-\d{2}-\d{2}/.test(String(issuedOn||"")))throw Error("invalid_identity");
  const rows=FIELDS.map(([key,label])=>'<w:tr>'+cell(label,{label:true})+cell(v[key])+'</w:tr>').join("");
  const document='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+
    p("トライアル期間用 労働条件通知書",{center:true,bold:true,size:30})+
    p("発行日："+String(issuedOn))+
    p(name+" 様")+p(company)+
    '<w:tbl><w:tblPr><w:tblW w:w="9050" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="5"/><w:left w:val="single" w:sz="5"/><w:bottom w:val="single" w:sz="5"/><w:right w:val="single" w:sz="5"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="6650"/></w:tblGrid>'+rows+'</w:tbl>'+
    p("※雇用条件は、確認・承認された各欄の記載を優先します。署名・受領がないことを同意とは扱いません。",{size:18})+
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1280" w:right="1280" w:bottom="1280" w:left="1280"/></w:sectPr>'+
    '</w:body></w:document>';
  const types='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
    '<Default Extension="xml" ContentType="application/xml"/>'+
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'+
    '</Types>';
  const rel='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'+
    '</Relationships>';
  const bytes=zip([["[Content_Types].xml",types],["_rels/.rels",rel],["word/document.xml",document]]);
  if(bytes.length>5*1024*1024)throw Error("docx_too_large");
  return {bytes,sha256:hash(bytes),filename:"トライアル労働条件通知書_"+safeFilename(name)+".docx"};
}
