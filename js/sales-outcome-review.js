(async function() {
  const $=id=>document.getElementById(id), root=$('or-content'), status=$('or-status');
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const params=new URLSearchParams(location.search), query=new URLSearchParams();
  for(const k of ['company','proposal']) if(params.get(k)) query.set(k,params.get(k));
  const endpoint='/api/sales/proposals/outcome-review', href=(key,val)=>'/sales/outcome-review.html?'+new URLSearchParams({[key]:val});
  const baseDate=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
  const localTime=v=>v?new Date(Date.parse(v)+9*3600000).toISOString().slice(0,16):'';
  const display=v=>v?localTime(v).replace('T',' '):'日時未定';
  const gradeNames={A:'A 重点取引',B:'B 通常取引',C:'C 条件を確認して個別提案',D:'D 新規の個別提案を停止'};
  const roleNames={proposal:'提案担当',closing:'クロージング担当'};
  const challenge={normal:'標準',hard:'難しい',unknown:'未確認'};
  const reasons={unknown:'理由未確認',skill:'スキル・経験',terms:'単価・働き方などの条件',timing:'時期',filled:'枠の充足',intent:'人材の意向',process:'選考・連絡方法',other:'その他'};
  const meetingNames={planned:'商談準備中',scheduled:'日時確定',done:'実施済み'};
  const channels={client:'案件側の企業担当者',candidate:'人材本人',relay:'所属会社・仲介担当者',internal:'社内の履歴'};
  const pct=v=>v==null?'—':(v*100).toLocaleString('ja-JP',{maximumFractionDigits:1})+'%';
  let state;
  const record=(kind,key)=>state.records?.find(r=>r.kind===kind && r.entity_key===key);
  const text=(key,label,v='',type='text',required=true)=>'<label>'+esc(label)+'<input type="'+type+'" name="'+key+'" value="'+esc(v)+'"'+(required?' required':'')+'></label>';
  const area=(key,label,v='',required=true)=>'<label>'+esc(label)+'<textarea maxlength="700" name="'+key+'"'+(required?' required':'')+'>'+esc(v)+'</textarea></label>';
  const select=(key,label,options,value)=>'<label>'+esc(label)+'<select name="'+key+'" required>'+Object.entries(options).map(([k,n])=>
    '<option value="'+esc(k)+'"'+(String(value)===k?' selected':'')+'>'+esc(n)+'</option>').join('')+'</select></label>';
  const owners=()=>Object.fromEntries([['','担当者を選択'],...state.employees.map(e=>[e.id,e.name])]);
  const proof=(v,channel='')=>select('channel','誰に確認したか',{'':'確認先を選択',...channels},v.channel||channel)+
    text('observed','確認日',v.observed||baseDate,'date')+area('quote','相手の発言・メールの記載、または照合した記録',v.quote);
  function panel(kind,key,title,fields,{open=false,hint='',button='記録を保存'}={}) {
    const rev=record(kind,key)?.revision||0;
    return '<details class="or-panel"'+(open?' open':'')+'><summary>'+esc(title)+'</summary>'+(hint?'<p>'+esc(hint)+'</p>':'')+
      '<form data-kind="'+kind+'" data-key="'+esc(key)+'" data-rev="'+rev+'"><div class="or-fields">'+fields+'</div>'+
      '<button type="submit">'+esc(button)+'</button><p role="alert"></p></form></details>';
  }
  function proposalPicker() {
    return '<details class="or-panel"><summary>提案別の進捗・見送り理由（'+state.proposals.length+'件）</summary>'+
      state.proposals.map(p=>'<p><a href="'+esc(href('proposal',p.id))+'">'+esc(p.title)+' ／ '+esc(p.talent)+'</a><br><small>'+
      esc([p.stage,p.side,p.reason,p.detail].filter(Boolean).join(' ／ '))+'</small></p>').join('')+'</details>';
  }
  function companyView() {
    const c=state.company,key=c.key, meeting=record('meeting',key)?.payload||{}, terms=record('terms',key), t=terms?.payload||{};
    $('or-title').textContent=c.name+'の改善商談';
    const signal=state.signal;
    let html='<section><h2>商談で確認する提案</h2><p>直近90日のうち送信から14日以上経った提案は <b>'+signal.sent+'</b> 件。見送り '+signal.lost+'件、進行中 '+signal.open+'件、見送りの詳細・原因側に未確認 '+signal.unknownReason+'件です。</p>';
    if(signal.suggested) html+='<p class="or-current">提案が3件以上あり、直近90日の送信分に合格・稼働の記録がありません。企業と選考基準をすり合わせる候補です。</p>';
    if (meeting.status) html+='<p class="or-current"><b>'+esc(meeting.status==='canceled'?'日程取消・再調整':meetingNames[meeting.status])+'</b>　'+esc(display(meeting.meetingAt))+
      '（日本時間）<br>議題：'+esc(meeting.agenda)+'<br>確認できた原因：'+esc(meeting.cause || '未確認')+'<br>次の改善策：'+esc(meeting.action || '商談で決定')+
      '<br>次回確認：'+esc(meeting.nextDate)+'</p>';
    if (state.followup) html+='<p>商談後の提案 '+state.followup.sent+'件 ／ 面談実施 '+state.followup.held+'件 ／ 合格 '+state.followup.passed+'件</p>';
    html+='<div class="or-actions">'+(c.engerId?'<a href="/sales/company-meeting.html?'+new URLSearchParams({companyId:c.engerId})+'">企業と共有する商談画面を開く</a>':'')+
      (c.engerId?'<a href="/sales/company-segments.html?'+new URLSearchParams({companyId:c.engerId,meeting:'info'})+'">企業情報・日程調整を開く</a>':'')+'</div></section>'+proposalPicker();
    html+=panel('meeting',key,'改善商談の準備・実施記録',select('status','商談の状況',meetingNames,meeting.status||'planned')+
      select('ownerId','商談担当',owners(),meeting.ownerId||state.me)+text('meetingAt','商談日時（日本時間）',localTime(meeting.meetingAt),'datetime-local',false)+
      area('agenda','企業に確認する議題',meeting.agenda || '見送った提案の具体的な理由と、次に面談したい人材の条件を確認する。')+
      area('cause','企業の回答・確認した原因',meeting.cause,false)+area('action','次の提案で変えること',meeting.action,false)+text('nextDate','改善の確認日',meeting.nextDate,'date'),{open:true});
    html+='<section><h2>現在の取引条件</h2><p>'+esc(t.grade?gradeNames[t.grade]+' ／ '+t.condition+' ／ 見直し日 '+t.nextDate:'個別の取引条件は未設定です。')+'</p></section>';
    if(state.allowTerms && c.verified) {
      const refs='<div><b>根拠にする提案</b><div class="or-refs">'+state.proposals.filter(p=>p.verified).map(p=>'<label><input type="checkbox" name="refs" value="'+esc(p.id)+'"'+(t.refs?.includes(p.id)?' checked':'')+'> '+esc(p.title)+' ／ '+esc(p.talent)+' ／ '+esc(p.reason)+'</label>').join('')+'</div></div>';
      html+=panel('terms',key,'取引条件を確定・見直し',select('grade','取引区分',gradeNames,t.grade||'B')+area('condition','次の取引に適用する条件',t.condition)+text('nextDate','見直し日',t.nextDate,'date')+proof(t,'client')+refs,
        {hint:'Cは企業と確認した案件のみ個別提案できます。Dは改善商談後も案件側の具体的な見送りが続いた場合に、新規の個別提案を停止します。'});
      if(t.grade==='C' && state.jobs.length) {
        html+='<section><h2>案件ごとの条件確認</h2>'+state.jobs.map(j=>{
          const rr=record('clearance',j.id),v=rr?.payload?.termsRevision===terms.revision?rr.payload:{};
          return panel('clearance',j.id,j.title+' ／ '+(v.until?'確認済み '+v.until+'まで':'確認待ち'),
            proof(v,'client')+text('until','確認の有効期限',v.until||t.nextDate,'date'));
        }).join('')+'</section>';
      }
    } else if(state.allowTerms && !c.verified) html+='<p>取引条件を確定するには、企業管理で提案と企業IDの紐付けを確認してください。 <a href="/sales/company-segments.html">企業管理を開く</a></p>';
    return html;
  }
  function proposalView() {
    const p=state.proposal, id=p.id, aff=record('affiliation',id)?.payload||{}, fb=record('feedback',id)?.payload||{};
    const same=v=>(v.cycle||null)===(p.cycle||null)?v:{};
    $('or-title').textContent=p.jobTitle+' ／ '+p.talent;
    const a=same(aff),f=same(fb);
    let html='<p><a href="'+esc(href('company',state.company.key))+'">'+esc(state.company.name)+'の改善商談へ</a></p>'+
      '<section><h2>提案の進捗</h2>'+window.SalesProposalFlow.html(p.flow)+'<a href="https://dx.enger.jp/proposals/'+esc(id)+'">ENGERの提案・回答を開く</a></section>';
    html+=panel('affiliation',id,'所属確認を記録',select('status','所属会社への確認結果',{waiting:'回答待ち',available:'提案可を確認',unavailable:'提案不可を確認'},a.status||'waiting')+proof(a,'relay'),{open:true});
    if(p.lost) html+=panel('feedback',id,'見送りの根拠を記録',select('side','どちら側の事情か',{unknown:'確認中',job:'案件側',candidate:'人材側',external:'外部要因'},f.side)+
      select('category','確認した原因',reasons,f.category)+proof(f));
    if(state.allowRank) for(const role of Object.keys(roleNames)) {
      if(role==='closing'?!p.canReviewClosing:!p.canReviewProposal) continue;
      const v=same(record(role,id)?.payload||{});
      let fields=select('ownerId',role==='proposal'?'初回送信時の提案担当':'面談実施時の正式なクロージング担当',owners(),v.ownerId||(role==='proposal'?p.owner:''))+
        select('delivery','送信区分',{unknown:'未確認',individual:'個別提案',blast:'一斉送信'},p.blast===true?'blast':p.blast===false?'individual':v.delivery)+
        select('grade','担当時点の取引区分',{unknown:'未確認',...gradeNames},v.grade)+select('difficulty','担当時点の案件難易度',{unknown:'未確認',normal:'標準',hard:'難しい'},v.difficulty)+
        select('cause','未達だった場合の原因',{unknown:'未確認・該当なし',role:'担当者が改善できる要因',external:'確認済みの外部要因'},v.cause);
      if(role==='closing') fields+=text('handoffAt','正式な引継ぎ日時（日本時間）',localTime(v.handoffAt),'datetime-local')+text('heldAt','実際の面談日時（日本時間）',localTime(v.heldAt),'datetime-local');
      html+=panel(role,id,roleNames[role]+'の評価根拠',fields+proof(v),{hint:'当時の担当と比較条件を裏付ける記録を入力してください。成功件数は提案元の面談・合格記録から集計します。'});
    }
    return html;
  }
  function staffView() {
    $('or-title').textContent='担当別の面談率・合格率';
    let html='<p>直近90日の個別提案を対象とし、送信・面談実施から14日間は観察期間とします。</p>';
    for(const role of Object.keys(roleNames)) {
      const cv=state.coverage[role],rows=state.results.filter(r=>r.role===role);
      html+='<section><h2>'+roleNames[role]+'の'+(role==='proposal'?'面談率':'合格率')+'</h2><p>担当・比較条件を照合できた案件 <b>'+cv.linked+' / '+cv.total+'件</b></p>';
      const headers=['担当','比較条件','対象','成功','外部要因','結果待ち','原因未確認','実績率','調整後','順位'];
      if(rows.length) html+='<table><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+
        [r.name,[r.service,r.grade,challenge[r.difficulty]].join(' ／ '),r.total,r.success,r.external,r.pending,r.unknown,pct(r.raw),pct(r.adjusted)+'（対象 '+r.adjustedN+'件）',r.rank==null?'集計中':r.rank+'位'].map((value,i)=>'<td data-label="'+headers[i]+'">'+esc(value)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
      if(!rows.length) html+='<p class="or-current">担当に帰属できる個別案件はまだありません。</p>';
      html+='</section>';
    }
    return html+'<details class="or-panel"><summary>率と順位の計算方法</summary><p>提案担当は実施面談数、クロージング担当は企業から合格を確認した件数を成功として数えます。実績率の分母は結果が判明した件数です。調整後の率では、根拠がある外部要因と原因未確認の案件を分母から除きます。</p><p>同じ役割・サービス・取引区分・案件難易度で2人以上が比較でき、調整後の対象が提案20件／クロージング10件以上、結果・原因の確認率と担当・比較条件の照合率がそれぞれ90%以上に達すると順位を表示します。同率は同順位です。</p></details>'+
      '<p><a href="/sales/proposals.html">企業別の提案履歴から評価根拠を確認する</a></p>';
  }
  async function load(message='') {
    status.textContent='記録を確認中…';
    state=await API.api(endpoint+(query.size?'?'+query:''));
    root.innerHTML=state.proposal?proposalView():state.company?companyView():staffView();
    status.textContent=message;
  }
  root.addEventListener('submit',async event=>{
    event.preventDefault(); const form=event.target, btn=form.querySelector('button[type=submit]');
    if(!btn || btn.disabled) return;
    btn.disabled=true;const err=form.querySelector('[role=alert]');err.textContent='';
    try {
      const fd=new FormData(form),data=Object.fromEntries(fd),kind=form.dataset.kind;
      for(const k of ['heldAt','handoffAt','meetingAt']) if(data[k]) data[k]=new Date(data[k]+':00+09:00').toISOString();
      if(kind==='terms') data.refs=fd.getAll('refs');
      if(kind==='clearance'){data.company=state.company.key;data.termsRevision=record('terms',data.company).revision;}
      const contents=JSON.stringify(data);
      if(form._contents!==contents){form._request=crypto.randomUUID();form._contents=contents;}
      await API.api(endpoint,{method:'POST',body:{kind,entity:form.dataset.key,revision:Number(form.dataset.rev),requestId:form._request,data}});
      await load('記録を保存しました。');
    } catch(e){err.textContent=e.message || '保存できませんでした。';}
    finally {btn.disabled=false;}
  });
  try { if(await SalesLayout.init({active:'proposals'})) await load(); }
  catch(e){status.textContent=e.message || '読み込みに失敗しました。';const b=document.createElement('button');b.textContent='再読み込み';b.onclick=()=>location.reload();root.append(b);}
})();
