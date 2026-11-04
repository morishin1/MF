// 企業DBから「アポを取るために確認すべき会社」を選ぶ純粋関数。
// これは成約予測ではなく次の行動順。取引停止先・面談設定済み・成約は除外する。
// 企業の正はSales側gw_sales_companies。ENGER名寄せ未確認の会社は自動で追加しない。

const norm = value => String(value ?? "").normalize("NFKC")
  .toLocaleLowerCase("ja-JP").replace(/[\s　・･.,．()（）\-―]/g, "").trim();
const dateMs = value => { const n=Date.parse(value ?? ""); return Number.isFinite(n) ? n : null; };
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEETING_STATUS=new Set(["scheduled","scheduling","done"]);
const PROPOSAL_REPLIES=new Set(["meeting_adjust","reply_wait","considering","reproposal"]);

export function selectAppointmentTargets({
  companies=[], proposals=[], meetings=[], legacyStops=[], now=new Date(), limit=50,
}={}) {
  const oldStopNames=new Set(legacyStops.map(r=>norm(r.name_normalized)).filter(Boolean));
  const oldStopIds=new Set(legacyStops.map(r=>String(r.matched_company_id || "").toLowerCase()).filter(Boolean));
  const meetingBlocked=new Set(meetings.filter(m=>MEETING_STATUS.has(m.status)).map(m=>m.company_id));
  const proposalFor=new Map();
  const proposalBlocked=new Set();
  for (const p of proposals) {
    if (!p.company_id) continue; // ID未確定のENGER提案を社名だけで流用しない
    if (p.contact_stop || p.status==="stopped") proposalBlocked.add(p.company_id);
    const entry=proposalFor.get(p.company_id) || { active:0, latest:null };
    if (PROPOSAL_REPLIES.has(p.status)) {
      entry.active++;
      const at=dateMs(p.sent_at || p.updated_at);
      if (at !== null && (entry.latest === null || at > entry.latest)) entry.latest=at;
    }
    proposalFor.set(p.company_id,entry);
  }
  const nowMs=now.getTime();
  const jstToday=new Date(nowMs+9*3600000).toISOString().slice(0,10);
  const candidates=[];
  let skippedByStop=0;
  for(const c of companies) {
    if(!UUID.test(c.id || ""))continue;
    if(c.hidden_at || c.ng_reason || ["excluded","won","lost","meeting","proposal"].includes(c.status))continue;
    if(meetingBlocked.has(c.id))continue;
    if(proposalBlocked.has(c.id) || oldStopIds.has(String(c.enger_company_id||"").toLowerCase())
       || oldStopNames.has(norm(c.name))) {skippedByStop++;continue;}
    const clicks=Number(c.click_count||0);
    const lastClick=dateMs(c.last_click_at);
    const followed=dateMs(c.followed_at);
    const sent=dateMs(c.last_sent_at);
    const proposal=proposalFor.get(c.id);
    const followDue=c.next_action_on && c.next_action_on <= jstToday;
    const hasPhone=Boolean(String(c.phone||"").trim());
    const hasWebsite=Boolean(String(c.site_url||c.form_url||c.domain||"").trim());
    let category=null, priority=99, reason="", nextAction="";
    // 確認済みの返信とクリックは「アポが取れた」ではなく、面談打診の優先根拠。
    if(c.status==="replied") {
      category="反応あり";priority=1;reason="返信記録あり";nextAction="返信内容を確認し、面談候補日を打診";
    }else if((c.status==="clicked"||clicks>0) && (lastClick===null || followed===null || lastClick>followed)) {
      category="反応あり";priority=2;reason="クリック後の対応を確認";nextAction="関心を確認し、必要なら面談を打診";
    }else if(proposal?.active>0){
      category="提案フォロー";priority=3;reason="提案に返答待ち・面談調整の記録";nextAction="提案状況を確認して面談へ";
    }else if(followDue && c.status!=="untouched"){
      category="期限到来";priority=4;reason="NEXT対応期限到来";nextAction="予定した連絡・フォローを実施";
    }else if(c.status==="attacked"&&sent!==null && nowMs-sent>=3*86400000 && nowMs-sent<=45*86400000){
      category="追客";priority=5;reason="初回アタック後3日以上";nextAction="前回連絡の結果を確認し、追客";
    }else if(c.status==="untouched"&&hasWebsite){
      category="新規調査";priority=6;reason="未アタック・企業Web情報あり";nextAction="連絡先・営業可否・発注ニーズを確認";
    }
    if(!category)continue;
    candidates.push({
      companyId:c.id, name:c.name||"会社名未登録",
      category,priority,reason,nextAction,
      ownerId:c.owner_id||null, status:c.status||null,
      region:c.region||null, industry:c.industry||null,
      hasPhone, hasWebsite, lastSentAt:c.last_sent_at||null,
      lastClickAt:c.last_click_at||null,
      nextActionOn:c.next_action_on||null,
      proposalFollowups:proposal?.active||0,
    });
  }
  candidates.sort((a,b)=>a.priority-b.priority ||
    (b.nextActionOn||"").localeCompare(a.nextActionOn||"") ||
    Number(b.hasPhone)-Number(a.hasPhone) ||
    (b.lastClickAt||"").localeCompare(a.lastClickAt||"") ||
    a.name.localeCompare(b.name,"ja") ||
    a.companyId.localeCompare(b.companyId));
  const groups=Object.fromEntries(["反応あり","提案フォロー","期限到来","追客","新規調査"].map(k=>[k,0]));
  for(const c of candidates)groups[c.category]=(groups[c.category]||0)+1;
  const cap=Math.max(1,Math.min(100,Number.isFinite(Number(limit))?Math.floor(Number(limit)):50));
  return {total:candidates.length,groups,skippedByStop,rows:candidates.slice(0,cap),generatedAt:now.toISOString(),
    note:"アポイント取得確率ではなく、行動の優先順位。連絡先や発注意思は必ず確認してください。"};
}
