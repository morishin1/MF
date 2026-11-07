import test from "node:test";
import assert from "node:assert/strict";
import {
 normalizedBusinessName,companySearchKeyword,verifiedMailDomain,
 exactCompanyMatch,exactEmailDomain,candidateEvidence,historicalRow,
} from "../lib/sales-company-history-lookup.js";

const company={name:"3LINKS株式会社",contact_email:"sales@3links.co.jp",website:""};
test("company name variants normalize without matching unrelated companies",()=>{
 assert.equal(normalizedBusinessName("株式会社３ＬＩＮＫＳ"),"3links");
 assert.equal(companySearchKeyword("3LINKS株式会社"),"3links");
 assert.equal(exactCompanyMatch("3LINKS株式会社","株式会社3LINKS"),true);
 assert.equal(exactCompanyMatch("3LINKS株式会社","株式会社3LINKS商事"),false);
 assert.equal(companySearchKeyword("株式会社A"),"");
});
test("only enterprise-controlled non-free-mail sender domains are accepted",()=>{
 assert.equal(verifiedMailDomain(company),"3links.co.jp");
 assert.equal(verifiedMailDomain({contact_email:"user@gmail.com",website:""}),"");
 assert.equal(exactEmailDomain("3links.co.jp","contact@3links.co.jp"),true);
 assert.equal(exactEmailDomain("3links.co.jp","contact@3links.co.jp.evil.test"),false);
});
test("jobs and talent records remain suggestions until staff links them",()=>{
 assert.equal(candidateEvidence("job",{client_name:"株式会社3LINKS",contact_email:null},company,"3links.co.jp"),"company_name");
 assert.equal(candidateEvidence("talent",{company:"別会社",contact_email:"owner@3links.co.jp"},company,"3links.co.jp"),"sender_domain");
 assert.equal(candidateEvidence("proposal",{company:"3LINKS株式会社"},company,"3links.co.jp"),"historical_proposal");
 assert.equal(candidateEvidence("job",{client_name:"別会社",contact_email:"someone@gmail.com"},company,"3links.co.jp"),null);
 const row=historicalRow("job",{id:"abc",job_no:421,title:"株式会社秘密会社",role_label:"Javaエンジニア",created_at:"2026-09-01",is_closed:true,deleted_at:null,contact_email:"secret@3links.co.jp"},"sender_domain");
 assert.equal(row.linked,false);
 assert.equal(row.status,"終了");
 assert.equal(JSON.stringify(row).includes("secret@"),false);
 assert.equal(JSON.stringify(row).includes("株式会社秘密会社"),false);
});
