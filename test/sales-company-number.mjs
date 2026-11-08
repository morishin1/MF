import test from "node:test";
import assert from "node:assert/strict";
import {formatCompanyNumber,companyNumberSearchTerm} from "../lib/sales-company-number.js";

test("Existing company numbers render as stable five digits",()=>{
 assert.equal(formatCompanyNumber(311),"00311");
 assert.equal(formatCompanyNumber("2349"),"02349");
 assert.equal(formatCompanyNumber(12926),"12926");
});
test("Leading zeros are display-only and don't change the persistent company UUID",()=>{
 assert.equal(companyNumberSearchTerm("00311"),"311");
 assert.equal(companyNumberSearchTerm("311"),"311");
 assert.equal(formatCompanyNumber("2079996b-8d1b-468e-97e8-3804ab72909d"),"");
});
test("Invalid or unassigned numbers are not guessed",()=>{
 for(const x of [null,undefined,"",0,-1,"abc",1.4])assert.equal(formatCompanyNumber(x),"");
 assert.equal(formatCompanyNumber(100000),"100000");
});
