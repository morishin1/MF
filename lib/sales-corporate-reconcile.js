// Reconcile distinct official datasets without ever treating a failed secondary
// lookup as a failure of the primary National Tax Agency corporate record.
import {namesCompatible} from './sales-gbiz-official.js';
const validNumber=v=>/^\d{13}$/.test(String(v||''));
const str=(v,n=500)=>typeof v==='string'?v.normalize('NFKC').trim().slice(0,n):'';
const sourceOfGbiz=g=>g?.sourceVersion==='v1'?'gbiz_api_v1':'gbiz_api_v2';
const status=(result,used)=>({
  configured:Boolean(result?.configured),
  attempted:Boolean(result?.configured)||Boolean(result?.httpStatus)||Boolean(result?.error),
  verified:Boolean(used),
  httpStatus:result?.httpStatus??null,
  error:result?.error||null
});
export function reconcileCorporateOfficial(number,nta,gbiz){
  if(!validNumber(number))throw Error('invalid_corporate_number');
  // Closure reported by the legal registry cannot be overruled by stale
  // gBizINFO activity data, even if the corporate number still resolves there.
  if(nta?.error==="corporation_closed")return {
    official:null,configured:Boolean(nta.configured||gbiz?.configured),
    sourceVersion:null,fieldSources:{},
    attempts:[
      {version:"国税庁v4",httpStatus:nta.httpStatus??null,error:"corporation_closed",normalizedRecords:0},
      {version:"gBiz "+(gbiz?.sourceVersion||"v2"),httpStatus:gbiz?.httpStatus??null,
        error:gbiz?.error||null,normalizedRecords:gbiz?.rows?.length||0}
    ],
    providers:{nta:status(nta,null),gbiz:status(gbiz,null)},
    corporateNameMismatch:false,secondaryUnavailable:true,error:"corporation_closed"
  };
  const n=nta?.official?.corporateNumber===number?nta.official:null;
  const candidate=gbiz?.rows?.find(r=>r.corporateNumber===number)||null;
  const mismatch=Boolean(n&&candidate?.name&&!namesCompatible(n.name,candidate.name));
  const g=mismatch?null:candidate;
  const evidenceSources={};
  const combined={corporateNumber:number,name:'',address:'',website:'',industry:'',prefecture:'',
    employeeBand:'',capitalStock:null,businessSummary:'',establishmentDate:'',
    profileUrl:n?.profileUrl||g?.profileUrl||''};
  // Name/address always come from NTA if available.
  for(const [field,value] of Object.entries({
    name:n?.name||g?.name,address:n?.address||g?.address,
    prefecture:n?.prefecture||g?.prefecture
  })){
    if(value){combined[field]=str(value,field==='address'?500:200);evidenceSources[field]=n?'nta_v4':sourceOfGbiz(gbiz);}
  }
  // Gビズインフォ is only used to augment missing fields, and never to
  // silently override official NTA identity or staff-edited values.
  if(g){
    if(g.website){combined.website=str(g.website,500);evidenceSources.website=sourceOfGbiz(gbiz);}
    if(g.industry){combined.industry=str(g.industry,100);evidenceSources.industry=sourceOfGbiz(gbiz);}
    if(Number.isSafeInteger(g.employeeNumber)&&g.employeeNumber>=0){
      combined.employeeBand=String(g.employeeNumber)+'人';
      evidenceSources.employeeBand=sourceOfGbiz(gbiz);
    }
    if(Number.isSafeInteger(g.capitalStock)&&g.capitalStock>=0){
      combined.capitalStock=g.capitalStock;evidenceSources.capitalStock=sourceOfGbiz(gbiz);
    }
    if(g.businessSummary){combined.businessSummary=str(g.businessSummary,850);evidenceSources.businessSummary=sourceOfGbiz(gbiz);}
    if(g.establishmentDate){combined.establishmentDate=str(g.establishmentDate,20);evidenceSources.establishmentDate=sourceOfGbiz(gbiz);}
  }
  const verified=Boolean(n||g);
  const source=n&&g?'nta_gbiz_'+(gbiz.sourceVersion==='v1'?'v1':'v2'):
    n?'nta_v4':g?sourceOfGbiz(gbiz):null;
  const attempts=[{version:'国税庁v4',httpStatus:nta?.httpStatus??null,error:nta?.error||null,normalizedRecords:n?1:0},
    {version:'gBiz '+(gbiz?.sourceVersion||'v2'),httpStatus:gbiz?.httpStatus??null,error:gbiz?.error||null,normalizedRecords:gbiz?.rows?.length||0}];
  if(mismatch)attempts[1].error='company_name_mismatch';
  return {official:verified?combined:null,configured:Boolean(nta?.configured||gbiz?.configured),
    sourceVersion:source,fieldSources:evidenceSources,attempts,
    providers:{nta:status(nta,n),gbiz:status(gbiz,g)},
    corporateNameMismatch:mismatch,secondaryUnavailable:Boolean(n&&!g),
    error:verified?null:gbiz?.error||nta?.error||'no_record'};
}
