import test from "node:test";
import assert from "node:assert/strict";
import {parseNtaCorporateXml,lookupNtaCorporate} from "../lib/sales-nta-corporate.js";

const corporateNumber="6010401177934";
const sample=(name="３ＬＩＮＫＳ株式会社",closed="")=>[
 '<?xml version="1.0" encoding="UTF-8"?>',
 '<corporations><count>1</count><corporation><corporateNumber>',corporateNumber,'</corporateNumber>',
 '<latest>1</latest><name>',name,'</name>',
 '<prefectureName>東京都</prefectureName><cityName>港区</cityName>',
 '<streetNumber>南青山２丁目２７番２８号</streetNumber>',closed,'</corporation></corporations>',
].join("");

test("NTA v4 XML yields exactly the basic three fields and no guessed website",()=>{
 const item=parseNtaCorporateXml(sample(),corporateNumber);
 assert.equal(item.corporateNumber,corporateNumber);
 assert.equal(item.name,"３ＬＩＮＫＳ株式会社");
 assert.equal(item.address,"東京都港区南青山２丁目２７番２８号");
 assert.equal(item.prefecture,"東京都");
 assert.equal(item.website,"");
 assert.equal(item.industry,"");
 assert.equal(item.sourceVersion,"nta_v4");
 assert.equal(item.closed,false);
});
test("NTA parser rejects a different corporate number and DTDs",()=>{
 assert.equal(parseNtaCorporateXml(sample(),"4000012090001"),null);
 assert.equal(parseNtaCorporateXml('<!DOCTYPE data SYSTEM "https://example.com/">'+sample(),corporateNumber),null);
 assert.equal(parseNtaCorporateXml("<corporations></corporations>",corporateNumber),null);
});
test("NTA parser recognizes escaped XML and closed companies",()=>{
 const c=parseNtaCorporateXml(sample("A&amp;B合同会社","<closeDate>2024-01-01</closeDate>"),corporateNumber);
 assert.equal(c.name,"A&B合同会社");
 assert.equal(c.closed,true);
});
test("NTA lookup uses fixed official host and never exposes application ID",async()=>{
 const appId="Ab1Cd2Ef3Gh4J";
 const fetcher=async(url,opts)=>{
   const target=new URL(url);
   assert.equal(target.origin,"https://api.houjin-bangou.nta.go.jp");
   assert.equal(target.pathname,"/4/num");
   assert.equal(target.searchParams.get("id"),appId);
   assert.equal(target.searchParams.get("number"),corporateNumber);
   assert.equal(target.searchParams.get("type"),"12");
   assert.equal(opts.method,"GET");
   return {ok:true,status:200,headers:{get:()=>null},text:async()=>sample()};
 };
 const out=await lookupNtaCorporate(corporateNumber,{env:{HOUJIN_BANGOU_APP_ID:appId},fetcher});
 assert.equal(out.official.name,"３ＬＩＮＫＳ株式会社");
 assert.equal(out.httpStatus,200);
 assert.equal(JSON.stringify(out).includes(appId),false);
});
test("NTA lookup handles missing ID, HTTP 401 and closed corporation",async()=>{
 const notSet=await lookupNtaCorporate(corporateNumber,{env:{},fetcher:()=>{throw Error("must not fetch")}});
 assert.equal(notSet.error,"nta_app_id_missing");
 const denied=await lookupNtaCorporate(corporateNumber,{env:{HOUJIN_BANGOU_APP_ID:"Ab1Cd2Ef3Gh4J"},fetcher:async()=>({ok:false,status:401})});
 assert.equal(denied.error,"http_401");
 const closed=await lookupNtaCorporate(corporateNumber,{env:{HOUJIN_BANGOU_APP_ID:"Ab1Cd2Ef3Gh4J"},fetcher:async()=>({ok:true,status:200,headers:{get:()=>null},text:async()=>sample("Sample","<closeDate>2025-01-01</closeDate>")})});
 assert.equal(closed.error,"corporation_closed");
 assert.equal(closed.official,null);
});
