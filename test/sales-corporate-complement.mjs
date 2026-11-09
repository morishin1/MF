import test from "node:test";
import assert from "node:assert/strict";
import {reconcileCorporateOfficial} from "../lib/sales-corporate-reconcile.js";
import {normalizeGbizResults,computeOfficialPatch} from "../lib/sales-gbiz-official.js";
import {verifiedByNumber} from "../api/sales/company-official.js";

const number="6010401177934";
const nta={configured:true,httpStatus:200,official:{
 corporateNumber:number,name:"３ＬＩＮＫＳ株式会社",address:"東京都港区南青山２丁目２７番２８号",
 prefecture:"東京都",sourceVersion:"nta_v4",
 profileUrl:"https://www.houjin-bangou.nta.go.jp/"
}};
const gbizRaw={"hojin-infos":[{
 corporate_number:number,name:"3LINKS株式会社",location:"東京都港区南青山２丁目２７番２８号",
 company_url:"https://3links.co.jp/",industry_name:"情報通信業",
 employee_number:106,capital_stock:12000000,business_summary:"システムエンジニアリング支援"
}]};
const gbiz={configured:true,httpStatus:200,sourceVersion:"v2",
 rows:normalizeGbizResults(gbizRaw,number)};

test("NTA success STILL queries gBizINFO v2 to supplement missing fields",async()=>{
 const called=[];
 const result=await verifiedByNumber(number,{
   lookupNta:async n=>{called.push("nta:"+n);return nta;},
   request:async path=>{called.push(path);return gbiz;}
 });
 assert.ok(called.includes("/v2/hojin/"+number),"gBiz queried despite NTA success");
 assert.equal(result.sourceVersion,"nta_gbiz_v2");
 assert.equal(result.official.name,"３ＬＩＮＫＳ株式会社");
 assert.equal(result.official.address,nta.official.address);
 assert.equal(result.official.industry,"情報通信業");
 assert.equal(result.official.website,"https://3links.co.jp/");
 assert.equal(result.official.employeeBand,"106人");
 assert.equal(result.official.capitalStock,12000000);
 assert.equal(result.providers.nta.verified,true);
 assert.equal(result.providers.gbiz.verified,true);
 assert.equal(result.fieldSources.industry,"gbiz_api_v2");
 assert.equal(result.fieldSources.name,"nta_v4");
});

test("NTA works and gBizINFO fails with HTTP 401: preserve official name and address",async()=>{
 const calls=[];
 const result=await verifiedByNumber(number,{
   lookupNta:async()=>nta,
   request:async path=>{calls.push(path);return {configured:true,httpStatus:401,error:"http_401",rows:[]};}
 });
 assert.deepEqual(calls,["/v2/hojin/"+number],"never retry same unauthorized token on v1");
 assert.equal(result.sourceVersion,"nta_v4");
 assert.equal(result.official.name,nta.official.name);
 assert.equal(result.official.industry,"");
 assert.equal(result.secondaryUnavailable,true);
 assert.equal(result.providers.gbiz.error,"http_401");
});

test("No NTA result: verified matching gBiz corporate number can supply baseline",async()=>{
 const result=await verifiedByNumber(number,{
   lookupNta:async()=>({configured:true,error:"no_record",httpStatus:200,official:null}),
   request:async()=>gbiz
 });
 assert.equal(result.sourceVersion,"gbiz_api_v2");
 assert.equal(result.official.name,"3LINKS株式会社");
});

test("gBiz corporate-number mismatch or renamed legal entity cannot silently update NTA fields",()=>{
 const wrong={...gbiz,rows:[{...gbiz.rows[0],name:"別会社株式会社"}]};
 const out=reconcileCorporateOfficial(number,nta,wrong);
 assert.equal(out.official.name,nta.official.name);
 assert.equal(out.official.industry,"");
 assert.equal(out.corporateNameMismatch,true);
 const other={...gbiz,rows:[{...gbiz.rows[0],corporateNumber:"4000012090001"}]};
 const noMatch=reconcileCorporateOfficial(number,nta,other);
 assert.equal(noMatch.official.website,"");
});

test("NTA closed corporation cannot be revived by an active-looking gBiz record",()=>{
 const result=reconcileCorporateOfficial(number,{configured:true,error:"corporation_closed"},gbiz);
 assert.equal(result.official,null);
 assert.equal(result.error,"corporation_closed");
});

test("Only explicitly supplied numeric staff and capital values are used",()=>{
 const ignored=normalizeGbizResults({"hojin-infos":[{
    corporate_number:number,name:"3LINKS株式会社",
    employee_number:"非公開",capital_stock:"1兆円"
 }]},number)[0];
 assert.equal(ignored.employeeNumber,null);
 assert.equal(ignored.capitalStock,null);
 assert.equal(gbiz.rows[0].employeeNumber,106);
 assert.equal(gbiz.rows[0].capitalStock,12000000);
});

test("Supplement only missing fields, never overwrite user-edited values by default",()=>{
 const info=reconcileCorporateOfficial(number,nta,gbiz).official;
 const patch=computeOfficialPatch({
   name:"３ＬＩＮＫＳ株式会社",address:"東京都港区南青山2丁目27番28号",
   website:"https://internal.example",industry:"",employee_band:"",capital_stock:null
 },info);
 assert.equal(patch.name,undefined);
 assert.equal(patch.address,undefined);
 assert.equal(patch.website,undefined);
 assert.equal(patch.industry,"情報通信業");
 assert.equal(patch.employee_band,"106人");
 assert.equal(patch.capital_stock,12000000);
});
