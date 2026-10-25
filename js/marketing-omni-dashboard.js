// Marketing KPI hub. Display only independently measured, access-controlled observations.
// Until a source-backed metrics endpoint is approved and connected, never infer PV, CTR,
// or conversion counts from content drafts, public URLs, pending inquiries or posted_at.
//
// 2026-10-25 P0（docs/marketing-dashboard-p0.md）：並べ方だけを変えた。
//   上から「期間・事業 → 6つのKPI → サイト別の更新状況｜今週やること → 媒体別 → 記事別 → 詳細（折りたたみ）」。
//   描画先は部品ごとに分ける（render は互換のため、1つの要素にまとめて描くこともできる）。
//   この部品は読むだけ：通信・保存・ブラウザ保存はしない。開く先（詳細・タブ）は呼び出し側の onOpen が決める。
(function () {
  "use strict";
  const PERIODS = [7, 30, 90];
  // 事業の絞り込み。EC は保留中なので選べない（読まない・出さない）
  // 原本につながっている事業だけ（AIまちは未接続なので出さない。サイト別の更新状況には「未接続」と出る）
  const BIZ = [["", "すべて"], ["site", "自社サイト"], ["mugen", "無限道場"], ["space", "EIGHT SPACE"]];
  const CHANNELS = [
    {key:"website",name:"Webサイト",detail:"GA4・記事別PV",goal:"PV・流入・問い合わせ",kind:"web"},
    {key:"x",name:"X",detail:"投稿・エンゲージメント",goal:"表示・反応・流入",kind:"sns"},
    {key:"instagram",name:"Instagram",detail:"投稿・リーチ",goal:"リーチ・保存・流入",kind:"sns"},
    {key:"facebook",name:"Facebook",detail:"投稿・反応",goal:"反応・流入",kind:"sns"},
    {key:"line",name:"LINE公式",detail:"配信・クリック",goal:"配信・クリック・流入",kind:"sns"},
    {key:"youtube",name:"YouTube",detail:"動画・視聴",goal:"再生・流入",kind:"video"},
    {key:"blastmail",name:"ブラストメール",detail:"メルマガ配信",goal:"到達・開封・クリック・流入",kind:"email"}
  ];
  // open：カードを押したときに開く根拠。publications は制作予定の一覧、inquiries は問い合わせの一覧、ほかは計測の接続状況
  const KPIS = [
    {key:"publications",label:"発信数",sub:"公開・配信を確認した件数",why:"公開URLと公開日時の照合が未接続のため未計測（下書き・公開予定は数えません）",open:"production"},
    {key:"pageviews",label:"Web PV",sub:"GA4・対象サイト",why:"GA4の読み取り権限と計測プロパティが未接続のため未計測",open:"connections"},
    {key:"socialSessions",label:"SNS流入",sub:"SNS経由のWebセッション",why:"GA4の流入元・UTMが未接続のため未計測（SNS内の表示回数とは別の数字です）",open:"connections"},
    {key:"emailClicks",label:"メールクリック",sub:"ブラストメール",why:"ブラストメールの配信・クリック結果が未接続のため未計測",open:"connections"},
    {key:"inquiries",label:"有効問い合わせ",sub:"重複・無効を除く",why:"重複・無効の除外と期間の集計が未接続のため未計測（問い合わせの原本は一覧で見られます）",open:"work"},
    {key:"won",label:"商談・成約",sub:"施策に結びついた分",why:"Salesの商談・成約と施策の結びつけが未接続のため未計測",open:"connections"}
  ];
  const SOURCE = {
    website:["utm_source=website","utm_medium=owned"],
    x:["utm_source=x","utm_medium=social"],
    instagram:["utm_source=instagram","utm_medium=social"],
    facebook:["utm_source=facebook","utm_medium=social"],
    line:["utm_source=line","utm_medium=social"],
    youtube:["utm_source=youtube","utm_medium=video"],
    blastmail:["utm_source=blastmail","utm_medium=email"]
  };
  const suffix = {
    website:"WebサイトのGA4読み取り権限と計測プロパティが未接続",
    x:"投稿別レポート・投稿URLとキャンペーン紐付けが未接続",
    instagram:"ビジネス／クリエイターアカウントのインサイト連携が未接続",
    facebook:"ページインサイト・投稿別計測が未接続",
    line:"LINE配信レポートの接続と定義確認が未完了",
    youtube:"チャンネルの分析データ・動画ID連携が未接続",
    blastmail:"配信履歴・クリック結果のAPI／集計CSV連携が未接続"
  };

  function utmUrl(destination, channel, campaign, content) {
    if (typeof destination !== "string" || destination.length>2048) throw Error("リンク先URLを入力してください。");
    if (!Object.hasOwn(SOURCE,channel)) throw Error("配信媒体を選択してください。");
    let url;
    try { url=new URL(destination); } catch { throw Error("https:// から始まる有効なURLを入力してください。"); }
    if (url.protocol!=="https:" || url.username || url.password) throw Error("認証情報を含まないhttps://のURLを指定してください。");
    if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(campaign)) throw Error("施策名は英数字・ハイフン・下線の2〜80文字で入力してください。");
    if(content && !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(content)) throw Error("投稿識別子は英数字・ハイフン・下線で入力してください。");
    const [source,medium]=SOURCE[channel];
    url.searchParams.set("utm_source",source.split("=")[1]);
    url.searchParams.set("utm_medium",medium.split("=")[1]);
    url.searchParams.set("utm_campaign",campaign);
    if(content)url.searchParams.set("utm_content",content);
    else url.searchParams.delete("utm_content");
    return url.toString();
  }
  function elm(tag,klass,txt){const e=document.createElement(tag);if(klass)e.className=klass;if(txt!==undefined)e.textContent=txt;return e;}
  function option(value,label){const e=elm("option","",label);e.value=value;return e;}
  // 状態の札。色だけでなく文字でも出す（未接続・未計測＝灰、確認待ち＝黄、取得済み＝緑、取得失敗＝赤）
  function badge(label,tone){const b=elm("span","om-badge t-"+(tone||"muted"),label);return b;}
  const state = {days:30, biz:""};
  const noop=()=>{};

  // ---- 期間・事業と6つのKPI ----------------------------------------------------------------
  function renderKpis(root, input, onChange, onOpen) {
    root.replaceChildren();
    const bar=elm("div","om-filters");
    const period=elm("label","om-filter","期間");
    const select=elm("select");select.setAttribute("aria-label","集計期間");
    for(const n of PERIODS) select.append(option(String(n),"過去"+n+"日"));
    select.value=String(state.days);
    select.onchange=()=>{state.days=Number(select.value);(onChange||noop)({days:state.days,biz:state.biz});renderKpis(root,input,onChange,onOpen);};
    period.append(select);
    const biz=elm("label","om-filter","事業");
    const bsel=elm("select");bsel.setAttribute("aria-label","事業");
    for(const [k,l] of BIZ) bsel.append(option(k,l));
    const ec=option("ec","8EC（保留中）");ec.disabled=true;bsel.append(ec);
    bsel.value=state.biz;
    bsel.onchange=()=>{state.biz=bsel.value;(onChange||noop)({days:state.days,biz:state.biz});renderKpis(root,input,onChange,onOpen);};
    biz.append(bsel);
    bar.append(period,biz,elm("span","om-legend","—：未計測（0件ではありません）"));
    root.append(bar);
    const metrics=elm("div","om-kpis");metrics.setAttribute("data-role","kpis");
    for(const k of KPIS){
      const card=elm("button","om-kpi");card.type="button";
      card.dataset.kpi=k.key;card.dataset.open=k.open;
      card.title=k.why;card.setAttribute("aria-label",k.label+"：未計測。"+k.why);
      const row=elm("div","om-kpi-row");
      row.append(elm("strong","om-kpi-value","—"),badge("未計測","muted"));
      card.append(elm("div","om-kpi-title",k.label),row,elm("p","om-kpi-sub",k.sub));
      card.onclick=()=>(onOpen||noop)(k.open,{kpi:k.key,days:state.days,biz:state.biz});
      metrics.append(card);
    }
    root.append(metrics);
  }

  // ---- 今週やること（計測が未接続なので、自動判定ではなく「設定に必要なこと」） ------------------------
  function renderTasks(root, onOpen) {
    root.replaceChildren();
    const head=elm("div","om-panel-top");
    head.append(elm("h2","om-h","今週やること"),badge("設定に必要なこと","attention"));
    root.append(head);
    const list=elm("ol","om-tasks");
    const tasks=[
      ["GA4の連携を確認","計測状況","connections"],
      ["配信リンク（UTM）を作成","リンクを作る","utm"],
      ["公開結果を確認（公開後7日）","発信管理","publishing"]
    ];
    for(const [title,action,target] of tasks){
      const li=elm("li");
      const btn=target==="publishing"?elm("a","of-btn sec om-task-btn",action):elm("button","of-btn sec om-task-btn",action);
      if(target==="publishing")btn.href="publishing.html";else{btn.type="button";btn.onclick=()=>target==="utm"?openUtm(root):(onOpen||noop)(target,{});}
      li.append(elm("span","om-task-title",title),btn);
      list.append(li);
    }
    root.append(list);
    root.append(elm("p","om-note","計測が未接続のため、件数や期限は出していません。"));
    root.append(utmForm());
  }
  function openUtm(root){
    const d=(root.querySelector?root.querySelector("#om-utm"):null);
    if(d){d.open=true;d.querySelector("input")?.focus?.();}
  }
  function utmForm(){
    const u=elm("details","om-utm");u.id="om-utm";
    u.append(elm("summary","","計測リンク（UTM）を作る"));
    const form=elm("form","om-utm-form");form.noValidate=true;
    const urlField=elm("label","","リンク先URL");
    const url=elm("input");url.type="url";url.placeholder="https://8grp.co.jp/lp/";url.required=true;url.name="url";urlField.append(url);
    const channelField=elm("label","","配信媒体");const channel=elm("select");channel.name="channel";
    CHANNELS.forEach(c=>channel.append(option(c.key,c.name)));channel.value="blastmail";channelField.append(channel);
    const campaignField=elm("label","","施策ID（英数字）");const campaign=elm("input");
    campaign.name="campaign";campaign.placeholder="202610-ai-course";campaign.required=true;campaignField.append(campaign);
    const contentField=elm("label","","投稿ID（任意）");const variant=elm("input");
    variant.name="variant";variant.placeholder="mail-01";contentField.append(variant);
    const create=elm("button","of-btn","計測リンクを生成");create.type="submit";
    const error=elm("p","om-error");error.setAttribute("role","status");
    const result=elm("output","om-link");result.setAttribute("aria-label","生成した計測リンク");
    const copy=elm("button","of-btn sec","コピー");copy.type="button";copy.hidden=true;
    form.append(urlField,channelField,campaignField,contentField,create,error,result,copy);
    form.onsubmit=e=>{
      e.preventDefault();error.textContent="";result.textContent="";copy.hidden=true;
      try { result.textContent=utmUrl(url.value.trim(),channel.value,campaign.value.trim().toLowerCase(),variant.value.trim().toLowerCase());copy.hidden=false; }
      catch(e) {error.textContent=e.message;}
    };
    copy.onclick=async()=>{
      if(!result.textContent)return;
      try{if(!navigator.clipboard?.writeText)throw Error("unsupported");await navigator.clipboard.writeText(result.textContent);error.textContent="コピーしました。";}
      catch{error.textContent="自動コピーが使えません。生成したURLを選択してコピーしてください。";}
    };
    u.append(form,elm("p","om-note","作るだけです。保存・送信はしません。"));
    return u;
  }

  // ---- 媒体別の成果（数値はすべて未計測。異なる媒体の指標は足さない） ---------------------------------
  function renderChannels(root, onOpen) {
    root.replaceChildren();
    const head=elm("div","om-panel-top");
    head.append(elm("h2","om-h","媒体別の成果"),badge("7媒体 計測接続待ち","muted"));
    root.append(head);
    const table=elm("div","om-scroll");
    const t=elm("table","om-table");const thead=elm("thead"),headRow=elm("tr");
    ["媒体","反応・クリック","サイト流入","問い合わせ"].forEach(x=>headRow.append(elm("th","",x)));
    thead.append(headRow);t.append(thead);
    const body=elm("tbody");
    for(const c of CHANNELS){
      const row=elm("tr");row.dataset.channel=c.key;
      const first=elm("td");
      const name=elm("button","om-ch","");name.type="button";name.title=suffix[c.key];
      name.append(elm("b","",c.name),elm("small","",c.detail));
      name.onclick=()=>(onOpen||noop)("connections",{channel:c.key});
      first.append(name);row.append(first);
      for(let i=0;i<3;i++){const cell=elm("td","om-notmeasured","—");cell.title=suffix[c.key];row.append(cell);}
      body.append(row);
    }
    t.append(body);table.append(t);root.append(table);
    root.append(elm("p","om-note","SNSの表示・反応とサイト流入は別の数字です。メールはクリックと問い合わせを優先して見ます。"));
  }

  // ---- 記事別の伸び（計測連携まで、空のグラフは出さない） ------------------------------------------------
  function renderArticles(root, onOpen) {
    root.replaceChildren();
    const head=elm("div","om-panel-top");
    head.append(elm("h2","om-h","記事別の伸び"),badge("未計測","muted"));
    const more=elm("button","of-btn sec om-task-btn","計測状況");more.type="button";more.onclick=()=>(onOpen||noop)("connections",{});
    head.append(more);
    root.append(head);
    root.append(elm("p","om-note","TOP記事・公開後7日／30日の比較は、記事IDとPVの計測を接続してから表示します。"));
  }

  // ---- 計測サービスの接続状況（詳細の中） ----------------------------------------------------------------
  function renderConnections(root) {
    root.replaceChildren();
    const sourceDetails=elm("details","om-connections");
    sourceDetails.id="om-connections";
    sourceDetails.append(elm("summary","","計測サービスの接続状況"));
    const boxes=elm("div","om-connection-grid");
    for(const c of CHANNELS){
      const card=elm("div","om-connection");card.dataset.channel=c.key;
      card.append(elm("b","",c.name),elm("span","",c.goal),elm("p","",suffix[c.key]));
      boxes.append(card);
    }
    sourceDetails.append(boxes);
    const defs=elm("dl","om-defs");
    for(const k of KPIS){defs.append(elm("dt","",k.label),elm("dd","",k.why));}
    sourceDetails.append(defs);
    sourceDetails.append(elm("p","om-note","ログイン情報・APIトークン・個人のメールアドレスをこの画面に入力させません。各サービスの権限を確かめて、読み取り専用で接続します。"));
    root.append(sourceDetails);
  }

  /**
   * 描く。roots は部品ごとの描画先 { kpis, tasks, channels, articles, connections }。
   * 1つの要素を渡したときは、その中にすべてを順に描く（互換・テスト用）
   */
  function render(roots, input, opts) {
    const o=opts||{};
    if(o.days&&PERIODS.includes(Number(o.days)))state.days=Number(o.days);
    if(typeof o.biz==="string"&&BIZ.some(([k])=>k===o.biz))state.biz=o.biz;
    let r=roots;
    if(!roots||typeof roots.replaceChildren==="function"){
      const one=roots;one.replaceChildren();
      r={};for(const k of ["kpis","tasks","channels","articles","connections"]){r[k]=elm("section","om-part");r[k].dataset.part=k;}
      one.append(r.kpis,r.tasks,r.channels,r.articles,r.connections);
    }
    if(r.kpis)renderKpis(r.kpis,input,o.onChange,o.onOpen);
    if(r.tasks)renderTasks(r.tasks,o.onOpen);
    if(r.channels)renderChannels(r.channels,o.onOpen);
    if(r.articles)renderArticles(r.articles,o.onOpen);
    if(r.connections)renderConnections(r.connections);
  }
  window.MarketingOmniDashboard={render,buildUtm:utmUrl,channels:CHANNELS.map(c=>c.key),kpis:KPIS.map(k=>k.key),
    periods:PERIODS.slice(),bizKeys:BIZ.map(([k])=>k),kpiOpen:Object.fromEntries(KPIS.map(k=>[k.key,k.open]))};
})();
