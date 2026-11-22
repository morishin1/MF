// Synthetic, read-only responses for layout acceptance checks. No real records.
export const companyId = 'cccccccc-0000-4000-8000-00000000000a';
export const session = {access_token:'layout-test-only', email:'layout@example.invalid', expires_at:4102444800};
export function salesDesignFixture(path) {
  const company = {id:companyId,name:'表示確認株式会社',corporateNumber:'1234567890123',website:'https://example.invalid/',address:'東京都渋谷区',contactName:'表示確認担当',contactEmail:'layout@example.invalid',phone:'03-0000-0000'};
  const row = {id:companyId,companyId,name:company.name,proposals:[],candidateIds:[],statusLabel:'フォロー中',reason:'表示確認',confirmed:true,contactKnown:true,email:true,phone:true,hasContact:true};
  switch(path) {
    case '/api/public-config': return {supabaseUrl:'https://example.invalid',supabaseAnonKey:'fixture'};
    case '/api/me': return {email:session.email,appRole:'admin',isAdmin:true,gw:{employee:{id:'e1',display_name:'表示確認'},roles:['sales','owner'],apps:['sales'],isAdmin:true,tenantId:'t1'}};
    case '/api/sales/dashboard-analysis': {
      const metrics={matchingCount:12,unsubmittedMatchedCount:0,proposalSentCount:12,meetingEventCount:2,meetingCohortCount:2,conversionRate:16.7,closedCount:1,wonCohortCount:1,byOwner:[],blastCompanies:[],lossReasons:[],byCompany:[],roleRows:{proposal:[],cs:[],closing:[]},sentRecords:[],dailyTrend:[{date:'2026-11-18',sent:5,meetings:1},{date:'2026-11-19',sent:7,meetings:1}],sentByHour:[]};
      return {period:{from:'2026-11-16',to:'2026-11-19'},previousPeriod:{from:'2026-11-09',to:'2026-11-15'},metrics,previousMetrics:metrics,insights:{issues:[],improvements:[],actions:[]}};
    }
    case '/api/sales/enger-progress': return {rows:[],metrics:[{key:'sentOn',label:'提案送信',ids:[],rate:null}],employees:[],won:0,forecast:0,today:'2026-11-19',offerAccess:true};
    case '/api/sales/offer-alerts': return {pendingCount:0,offers:[]};
    case '/api/sales/company-lifecycle': return {complete:true,rows:[row],counts:{current:1,total:1},selectedCount:1,observedAt:'2026-11-17T00:00:00Z'};
    case '/api/sales/enger-company-detail': return {company,evidence:{touchpoints:[],proposalCount:0}};
    case '/api/sales/company-workbench': return {company,history:[],activities:[],complete:true};
    case '/api/sales/company-people': return {people:[],contacts:[],rows:[]};
    case '/api/sales/company-ai-summary': return {summary:'業務システム開発とIT人材支援を行う企業の表示確認データです。',company};
    case '/api/sales/company-workflow-status': return {
      companyId,analysis:{source:'cloud',summary:'業務システム開発とIT人材支援の表示確認。',hasCorporateNumber:true,hasWebsite:true},
      steps:{info:{state:'done',label:'基本情報登録済み'},analysis:{state:'done',label:'AI分析済み'},proposal:{state:'done',label:'商談用候補 2件'}},
      proposal:{publishedCount:2,portalAccounts:0,ready:true,staffMeetingUrl:'/sales/company-meeting.html?companyId='+companyId},
      single:{eligible:true,canRun:true,status:'completed',salesCompanyId:companyId},pilot:{eligible:true,selected:true,canRun:true,status:'completed'}
    };
    case '/api/sales/company-meeting-brief': return {company,source:{},suggestions:{basis:'表示確認データ',skills:['Java'],verified:false,
      talents:[{id:'dddddddd-0000-4000-8000-000000000001',talentNo:'P-000001',title:'Javaエンジニア',skills:['Java','AWS'],matchedSkills:['Java'],availability:'即日'}],
      jobs:[{id:'eeeeeeee-0000-4000-8000-000000000001',jobNo:'J-000001',title:'業務システム開発',skills:['Java'],matchedSkills:['Java']}]
    }};
    case '/api/sales/company-talents': return {rows:[],total:0,page:1,pages:1,options:{}};
    case '/api/sales/company-shortlist': return {items:[],rows:[],canShare:true};
    case '/api/sales/company-portal': return {company,members:[],saved:[],events:[],usage:{},mail:{configured:false},portal:{}};
    case '/api/sales/company-offers': return {offers:[],statusLabels:{}};
    case '/api/sales/company-progress': return {proposals:[],prep:{counts:{}},portalOffers:{available:false}};
    case '/api/sales/company-meeting-screen': return {companyName:company.name,displayId:'00001',items:[],summary:'表示確認データ'};
    case '/api/sales/company-submissions': return {rows:[],items:[],total:0};
    case '/api/sales/proposals': return {proposals:[],companyQualifications:[],labels:{filters:[]},counts:{},today:{},members:[],manager:false};
    case '/api/sales/proposals/daily-review': return {day:'2026-11-22',today:'2026-11-22',firstDay:'2026-11-20',roles:{sales:true,enger:false},reasons:{},rows:[],meeting:null,canConfirm:{sales:false,enger:false}};
    case '/api/sales/proposals/contract-requests': return {ready:true,rows:[]};
    case '/api/sales/templates': return {templates:[]};
    default: return {rows:[],companies:[],proposals:[],approaches:[],templates:[],campaigns:[],leads:[],members:[],events:[],items:[],total:0,complete:true};
  }
}
