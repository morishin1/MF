import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {
  cleanSearchName,parseNtaMeetingNameXml,searchMeetingCompanies,lookupMeetingCompanyNumber,safeMeetingWebsite
} from '../lib/sales-meeting-company-research.js';
const read=(p)=>readFileSync(new URL(p,import.meta.url),'utf8');
const html=read('../sales/index.html'),js=read('../js/sales-meeting-launcher.js'),
  css=read('../css/sales-dashboard-issue.css'),api=read('../api/sales/meeting-company.js'),
  sql=read('../db/173_sales_meeting_quick_company.sql');
const XML='<?xml version="1.0" encoding="UTF-8"?><corporations><count>2</count>'
  +'<corporation><corporateNumber>6010401177934</corporateNumber><name>3LINKS株式会社</name><prefectureName>東京都</prefectureName><cityName>港区</cityName><streetNumber>北青山</streetNumber><latest>1</latest></corporation>'
  +'<corporation><corporateNumber>6010401177935</corporateNumber><name>旧株式会社</name><prefectureName>東京都</prefectureName><cityName>千代田区</cityName><streetNumber>丸の内</streetNumber><closeDate>2023-01-01</closeDate><latest>1</latest></corporation></corporations>';

test('meeting launcher first asks existing or new, preserving existing list',()=>{
  for(const id of ['db-meeting-existing-choice','db-meeting-new-choice','db-meeting-existing-panel',
    'db-meeting-new-panel','db-meeting-new-search','db-meeting-new-confirm','db-meeting-new-register'])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(html,/企業情報 → AI分析 → マッチング・提案/);
  assert.match(js,/chooseMode\("existing"\)/);
  assert.match(js,/chooseMode\("new"\)/);
  assert.match(js,/\/api\/sales\/company-lifecycle\?/);
  assert.match(js,/\/api\/sales\/meeting-company\?/);
  assert.match(js,/window\.location\.assign\("\/sales\/company-segments\.html\?/);
  assert.match(css,/\.db-meeting-choice\[aria-pressed=true\]/);
  assert.doesNotThrow(()=>new Script(js));
});
test('NTA company-name XML parser limits results and skips closed entities',()=>{
  const results=parseNtaMeetingNameXml(XML);
  assert.equal(results.length,1);
  assert.equal(results[0].corporateNumber,'6010401177934');
  assert.equal(results[0].name,'3LINKS株式会社');
  assert.equal(results[0].prefecture,'東京都');
  assert.equal(parseNtaMeetingNameXml('<!DOCTYPE x>'+XML).length,0);
});
test('NTA name search and number lookup keep credentials in server request',async()=>{
  const calls=[];
  const fetcher=async(url)=>{
    calls.push(new URL(url));
    return {ok:true,status:200,headers:{get:()=>null},text:async()=>XML};
  };
  const env={HOUJIN_BANGOU_APP_ID:'1234567890123'};
  const names=await searchMeetingCompanies('3LINKS株式会社',{env,fetcher});
  assert.equal(names.source,'nta_v4');
  assert.equal(names.rows.length,1);
  assert.equal(calls[0].pathname,'/4/name');
  assert.equal(calls[0].searchParams.get('type'),'12');
  const number=await lookupMeetingCompanyNumber('6010401177934',{env,fetcher});
  assert.equal(number.verified,true);
  assert.equal(number.official.name,'3LINKS株式会社');
  assert.equal(calls[1].pathname,'/4/num');
});
test('query and official websites are strictly validated',()=>{
  assert.equal(cleanSearchName('株式会社'),null);
  assert.equal(cleanSearchName('3LINKS株式会社'),'3LINKS');
  assert.equal(safeMeetingWebsite('https://example.co.jp/'),'https://example.co.jp/');
  for(const url of ['http://example.co.jp','https://localhost/','https://127.0.0.1/',
    'https://secret@example.co.jp/','https://example.co.jp:444/','https://intranet.local/'])
    assert.equal(safeMeetingWebsite(url),null,url);
});
test('server rechecks official corporate identity and tenant before atomic registration',()=>{
  assert.match(api,/requireUser\(req,res\)/);
  assert.match(api,/canSell\(ctx\)/);
  assert.match(api,/canAccessEightEngerDirectory\(ctx\)/);
  assert.match(api,/lookupMeetingCompanyNumber\(body\.corporateNumber\)/);
  assert.match(api,/namesCompatible\(c\.name,body\.expectedName/);
  assert.match(api,/db\.rpc\('gw_sales_register_meeting_company'/);
  assert.match(api,/precheck\.existingCompanyId/);
  assert.match(api,/mode==='name'/);
  assert.match(api,/mode==='number'/);
});
test('SQL transaction creates ENGER, Sales, link and audit only once',()=>{
  assert.match(sql,/security invoker/i);
  assert.match(sql,/pg_advisory_xact_lock/i);
  assert.match(sql,/insert into enger\.companies/i);
  assert.match(sql,/insert into public\.gw_sales_companies/i);
  assert.match(sql,/insert into public\.gw_sales_company_links/i);
  assert.match(sql,/insert into public\.gw_sales_company_activity/i);
  assert.match(sql,/from enger\.companies where corporate_number=p_corporate_number/);
  assert.match(sql,/revoke all on function/i);
  assert.match(sql,/to service_role/i);
});
