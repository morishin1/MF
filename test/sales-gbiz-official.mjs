import test from "node:test";
import assert from "node:assert/strict";
import {
  corporateNumberOk,officialProfileUrl,companySearchUrl,
  normalizedName,namesCompatible,normalizeGbizResults,
  computeOfficialPatch,summarizeDiff,
} from "../lib/sales-gbiz-official.js";

test("corporate number is a 13 digit official identifier, not ENGER uuid",()=>{
  assert.equal(corporateNumberOk("4000012090001"),true);
  assert.equal(corporateNumberOk("2079996b-8d1b-468e-97e8-3804ab72909d"),false);
  assert.equal(corporateNumberOk("12345"),false);
  assert.equal(officialProfileUrl("4000012090001"),
    "https://info.gbiz.go.jp/hojin/ichiran?hojinBango=4000012090001");
});
test("gBizINFO official-site name search opens with selected business name",()=>{
  const query=new URL(companySearchUrl("3LINKS株式会社")).searchParams.get("q");
  assert.ok(query.includes('site:info.gbiz.go.jp/hojin/ichiran'));
  assert.ok(query.includes("3LINKS株式会社"));
});
test("normalization does not confuse name variants or unrelated businesses",()=>{
  assert.equal(normalizedName("株式会社3LINKS"),normalizedName("3LINKS株式会社"));
  assert.equal(namesCompatible("3LINKS株式会社","株式会社3LINKS"),true);
  assert.equal(namesCompatible("3LINKS株式会社","株式会社3LINK"),false);
});
test("official records only expose fields explicitly present in source",()=>{
  const rows=normalizeGbizResults({"hojin-infos":[{
    corporate_number:"4000012090001",name:"経済産業省",
    location:"東京都千代田区霞が関１丁目３－１",
  }]});
  assert.equal(rows.length,1);
  assert.equal(rows[0].prefecture,"東京都");
  assert.equal(rows[0].name,"経済産業省");
  assert.equal(rows[0].website,"");
});
test("verified official basics fill blanks; overwrite requires explicit consent",()=>{
  const before={name:"3LINKS株式会社",address:"",website:"https://example.jp",industry:""};
  const official={name:"株式会社3LINKS",address:"東京都渋谷区",website:"https://verified.example.jp",industry:"情報通信業"};
  assert.deepEqual(computeOfficialPatch(before,official),{address:"東京都渋谷区",industry:"情報通信業"});
  const overwriting=computeOfficialPatch(before,official,{overwrite:true});
  assert.equal(overwriting.name,"株式会社3LINKS");
  assert.equal(overwriting.website,"https://verified.example.jp");
  assert.equal(summarizeDiff(before,official).length,5);
});
