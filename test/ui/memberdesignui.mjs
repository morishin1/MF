// HR/Sales共通デザインを使うメンバー画面のPC/スマホ実表示テスト。
import {launch, BASE} from "../_browser.mjs";
const br=await launch();
let bad=0;
const check=(ok,name)=>{console.log((ok?"  ok ":"  NG ")+name);if(!ok)bad++;};
async function verify(path,width,height){
  const page=await br.newPage({viewport:{width,height},timezoneId:"Asia/Tokyo"});
  await page.addInitScript(()=>{
    localStorage.setItem("kp_session",JSON.stringify({access_token:"x",email:"member@example.com"}));
    localStorage.setItem("kp_layout",JSON.stringify({appRole:"member",name:"テスト社員",shows:{},stage:null}));
  });
  await page.route("**/api/**",route=>{
    const url=new URL(route.request().url());
    const send=o=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(o)});
    if(url.pathname==="/api/me")return send({
      email:"member@example.com",appRole:"member",isAdmin:false,access:{},shows:{},
      gw:{tenantId:"t1",roles:[],isAdmin:false,stage:null,
        employee:{id:"e1",display_name:"テスト社員",status:"active"}}
    });
    if(url.pathname==="/api/notifications")return send({notifications:[],unread:0});
    if(url.pathname==="/api/badges")return send({badges:{}});
    return send({});
  });
  await page.goto(BASE+"/"+path);
  await page.waitForTimeout(900);
  const m=await page.evaluate(()=>{
    const body=document.body,wrapper=document.querySelector(".wrap"),
      top=document.querySelector(".topbar"),sidebar=document.querySelector(".kp-sidebar.member"),
      tab=document.querySelector(".kp-tabbar"),
      icon=document.querySelector(".kp-sidebar .material-symbols-outlined, .kp-tabbar .material-symbols-outlined");
    const rect=x=>x?.getBoundingClientRect();
    const b=rect(wrapper),s=rect(sidebar);
    const computedIcon=icon?getComputedStyle(icon):null;
    return {font:getComputedStyle(body).fontFamily,
      iconFont:computedIcon?.fontFamily||"",
      iconWidth:icon?rect(icon)?.width:0,css:!!document.querySelector('link[href*="member-design.css"]'),
      top:!!top,wrap:!!wrapper,sidebar:!!sidebar,tab:!!tab,
      sidebarShown:!!sidebar&&getComputedStyle(sidebar).display!=="none",
      tabShown:!!tab&&getComputedStyle(tab).display!=="none",
      wrapLeft:b?.left,wrapRight:b?.right,sidebarRight:s?.right,
      viewport:window.innerWidth,scrollWidth:document.documentElement.scrollWidth
    };
  });
  const label=path+" "+width+"px";
  check(m.css&&m.font.includes("Zen Kaku Gothic New"),label+"：HR/Sales共通書体");
  check(m.iconFont.includes("Material Symbols Rounded")&&m.iconWidth<=32,
    label+"：アイコン名がレイアウトを押し広げない");
  check(m.top&&m.wrap,label+"：共通ヘッダーと本文枠");
  if(width>860){
    check(m.sidebarShown,label+"：PCサイドメニュー");
    check(m.wrapLeft>=m.sidebarRight-1,label+"：本文がサイドメニューに重ならない");
  }else{
    check(!m.sidebarShown&&m.tabShown,label+"：スマホは下部タブ");
    check(m.wrapLeft>=0,label+"：スマホ本文の位置");
  }
  check(m.wrapRight<=m.viewport+2,label+"：本文はみ出しなし");
  await page.close();
}
try{
  for(const path of ["menu.html","home.html","nippo.html"]){
    await verify(path,1440,900);
    await verify(path,390,844);
  }
}finally{await br.close();}
console.log(bad?bad+"項目 NG":"メンバー共通UI 3画面×PC/スマホの表示テストすべて通過");
process.exit(bad?1:0);
