import assert from "node:assert/strict";
import { readTemplateCatalog,validTemplateKey } from "../lib/member-template-catalog.js";

const tenant="4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac";
const mock={
  gw_library:[
    {id:"lib1",tenant_id:tenant,title:"就業規則",category:"rule",published:true,file_path:tenant+"/rules.pdf"},
    {id:"lib2",tenant_id:tenant,title:"社内様式（既存）",category:"form",published:false,file_path:tenant+"/form.docx"},
  ],
  gw_doc_templates:[
    {id:"gen1",tenant_id:tenant,name:"給与振込口座届",kind:"onboarding",note:"doc_key:bank / 社内確認前",employment_types:[]},
    {id:"gen2",tenant_id:tenant,name:"社内規程等確認書",kind:"onboarding",note:"doc_key:consent / 社内確認前",employment_types:[]},
  ],
  gw_sign_templates:[
    {id:"s1",tenant_id:tenant,name:"労働条件通知書兼雇用契約書",doc_kind:"employment",active:true,version:1},
    {id:"s2",tenant_id:tenant,name:"秘密保持誓約書",doc_kind:"pledge",active:true,version:1},
  ],
  gw_member_doc_template_links:[],
};
function db(){
  return {from(table){
    return {
      select(){return this},
      eq(){return this},
      limit(){return Promise.resolve({data:mock[table],error:null})},
    };
  }};
}
const c=await readTemplateCatalog(db(),tenant,{finance:true,salary:true});
assert.equal(c.resolve("bank").source,"general");
assert.equal(c.resolve("bank").status,"review");
assert.equal(c.resolve("employment_contract").source,"sign");
assert.equal(c.resolve("nda").source,"sign");
assert.equal(c.resolve("dependents").source,"official");
assert.ok(c.resolve("dependents").url.includes("nta.go.jp"));
assert.equal(c.resolve("pension").status,"not_needed");
assert.equal(c.resolve("other").status,"not_needed");
assert.equal(c.resolve("consent").reference.title,"就業規則");
assert.equal(c.choices.length,6);
assert.ok(validTemplateKey("custom_doc_specific"));
assert.ok(!validTemplateKey("../../../malicious"));
mock.gw_member_doc_template_links=[{doc_key:"bank",source_kind:"library",source_id:"lib2",updated_at:"2026-11-08"}];
const linked=await readTemplateCatalog(db(),tenant,{finance:true,salary:true});
assert.equal(linked.resolve("bank").source,"library");
assert.equal(linked.resolve("bank").published,false);
assert.equal(linked.resolve("bank").forced,true);
mock.gw_member_doc_template_links=[{doc_key:"bank",source_kind:"library",source_id:"notfound",updated_at:"2026-11-08"}];
const broken=await readTemplateCatalog(db(),tenant,{finance:true,salary:true});
assert.equal(broken.resolve("bank").status,"broken");
const restricted=await readTemplateCatalog(db(),tenant,{finance:false,salary:false});
assert.equal(restricted.resolve("bank").source,"missing");
assert.equal(restricted.resolve("employment_contract").source,"official");
assert.equal(restricted.choices.some(x=>x.source==="library"&&!x.published),false);
assert.equal(restricted.choices.some(x=>x.source==="sign"&&x.kind==="employment"),false);
console.log("member document template catalog: 14 mappings and validations passed");
