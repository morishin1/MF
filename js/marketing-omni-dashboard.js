// Marketing KPI hub. Display only independently measured, access-controlled observations.
// Until a source-backed metrics endpoint is approved and connected, never infer PV, CTR,
// or conversion counts from content drafts, public URLs, pending inquiries or posted_at.
(function () {
  "use strict";
  const PERIODS = [7, 30, 90];
  const CHANNELS = [
    {key:"website",name:"Webサイト",detail:"GA4・記事別PV",goal:"PV・流入・問い合わせ",kind:"web"},
    {key:"x",name:"X",detail:"投稿・エンゲージメント",goal:"表示・反応・流入",kind:"sns"},
    {key:"instagram",name:"Instagram",detail:"投稿・リーチ",goal:"リーチ・保存・流入",kind:"sns"},
    {key:"facebook",name:"Facebook",detail:"投稿・反応",goal:"反応・流入",kind:"sns"},
    {key:"line",name:"LINE公式",detail:"配信・クリック",goal:"配信・クリック・流入",kind:"sns"},
    {key:"youtube",name:"YouTube",detail:"動画・視聴",goal:"再生・流入",kind:"video"},
    {key:"blastmail",name:"ブラストメール",detail:"メルマガ配信",goal:"到達・開封・クリック・流入",kind:"email"}
  ];
  const KPIS = [
    {key:"publications",label:"発信数",sub:"記事・SNS投稿・配信"},
    {key:"pageviews",label:"WebサイトPV",sub:"対象サイトの合計"},
    {key:"socialSessions",label:"SNSからの流入",sub:"GA4の流入元"},
    {key:"emailClicks",label:"メールのクリック",sub:"ブラストメール"},
    {key:"inquiries",label:"有効問い合わせ",sub:"重複・無効を除く"},
    {key:"won",label:"商談・成約",sub:"Sales連携"}
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
  const escape = s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function elm(tag,klass,txt){const e=document.createElement(tag);if(klass)e.className=klass;if(txt!==undefined)e.textContent=txt;return e;}
  function option(value,label){const e=elm("option","",label);e.value=value;return e;}
  const state = {days:30};
  function make(root, input) {
    root.replaceChildren();
    const top=elm("div","om-top");
    const headline=elm("div");
    headline.append(elm("h2","","マーケティングの成果"),elm("p","om-sub","発信から問い合わせ・商談まで。効果が見えたら、次の改善へ。"));
    const period=elm("label","om-period","対象期間");
    const select=elm("select");select.setAttribute("aria-label","集計期間");
    for(const n of PERIODS) select.append(option(String(n),"過去"+n+"日"));
    select.value=String(state.days);
    // Metrics are not connected yet; changing the period only changes the selection.
    // index.html moves the UTM/connection nodes to Distribution. Rebuilding here
    // would recreate them with duplicate IDs and a second, blank UTM form.
    select.onchange=()=>{state.days=Number(select.value);};
    period.append(select);top.append(headline,period);root.append(top);

    const metrics=elm("div","om-kpis");
    KPIS.forEach(k=>{
      const card=elm("section","om-kpi");
      card.append(elm("div","om-kpi-title",k.label),elm("strong","om-kpi-value","—"),elm("div","om-kpi-state","未計測"),elm("p","om-kpi-sub",k.sub));
      metrics.append(card);
    });
    root.append(metrics);
    root.append(elm("p","om-disclaimer","数字が未計測のため、0件・増減率・達成率は表示していません。媒体をまたいだ集計は同じ計測期間・定義・重複除外の条件が揃ったものだけ表示します。"));

    const lower=elm("div","om-grid");
    const channels=elm("section","om-panel");
    const h=elm("div","om-panel-top");
    h.append(elm("h3","","媒体別の成果"),elm("span","om-muted","7媒体の計測接続待ち"));
    channels.append(h);
    const table=elm("div","om-scroll");
    const t=elm("table","om-table");const thead=elm("thead"),headRow=elm("tr");
    ["媒体","反応・クリック","サイト流入","問い合わせ"].forEach(x=>headRow.append(elm("th","",x)));
    thead.append(headRow);t.append(thead);
    const body=elm("tbody");
    for(const c of CHANNELS){
      const row=elm("tr");
      const first=elm("td");
      first.append(elm("b","",c.name),elm("small","",c.detail));
      row.append(first);
      for(let i=0;i<3;i++){const cell=elm("td","om-notmeasured","—");cell.title=suffix[c.key];row.append(cell);}
      body.append(row);
    }
    t.append(body);table.append(t);channels.append(table);
    channels.append(elm("p","om-note","SNSの表示・リーチ・反応とWebサイトへの流入は別指標。ブラストメールはクリック・到達を中心に確認します。"));
    lower.append(channels);

    const work=elm("section","om-panel");
    work.append(elm("h3","","今週、改善すること"));
    const tasks=elm("ol","om-tasks");
    [
      ["計測する","GA4の対象サイトと、SNS・ブラストメールの管理アカウントを確認"],
      ["リンクを統一","PR・SNS・メルマガからのURLにUTMを付ける"],
      ["公開後に見る","7日後の流入・問い合わせを比較して、次の原稿へ反映"]
    ].forEach(([title,detail])=>{const li=elm("li");li.append(elm("b","",title),elm("span","",detail));tasks.append(li);});
    work.append(tasks);
    const u=elm("details","om-utm");u.id="om-utm";
    const trigger=elm("summary","","計測リンク（UTM）を作る");u.append(trigger);
    const form=elm("form","om-utm-form");form.noValidate=true;
    const urlField=elm("label","","リンク先URL");
    const url=elm("input");url.type="url";url.placeholder="https://8grp.co.jp/lp/";url.required=true;url.name="url";urlField.append(url);
    const channelField=elm("label","","配信媒体");const channel=elm("select");channel.name="channel";
    CHANNELS.forEach(c=>channel.append(option(c.key,c.name)));channel.value="blastmail";channelField.append(channel);
    const campaignField=elm("label","","施策ID（英数字）");const campaign=elm("input");
    campaign.name="campaign";campaign.placeholder="202610-ai-course";campaign.required=true;campaignField.append(campaign);
    const contentField=elm("label","","投稿ID（任意）");const variant=elm("input");
    variant.name="variant";variant.placeholder="mail-01";contentField.append(variant);
    const create=elm("button","om-action","計測リンクを生成");create.type="submit";
    const error=elm("p","om-error");error.setAttribute("role","status");
    const result=elm("output","om-link");result.setAttribute("aria-label","生成した計測リンク");
    const copy=elm("button","om-copy","コピー");copy.type="button";copy.hidden=true;
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
    u.append(form);
    work.append(u);
    lower.append(work);root.append(lower);

    const sourceDetails=elm("details","om-connections");
    sourceDetails.id="om-connections";
    sourceDetails.append(elm("summary","","計測サービスの接続状況を見る"));
    const boxes=elm("div","om-connection-grid");
    for(const c of CHANNELS){
      const card=elm("div","om-connection");
      card.append(elm("b","",c.name),elm("span","",c.goal),elm("p","",suffix[c.key]));
      boxes.append(card);
    }
    sourceDetails.append(boxes);
    sourceDetails.append(elm("p","om-note","現段階は画面案です。ログイン情報・APIトークン・個人別メールアドレスをこの画面に入力させないでください。各サービスの権限を確認して読み取り専用で接続します。"));
    root.append(sourceDetails);
    const sourceNote=elm("p","om-note","原稿・問い合わせの既存画面は下の「詳細（既存の制作・対応管理）」から確認できます。現時点で実計測は未接続です。");
    root.append(sourceNote);
  }
  window.MarketingOmniDashboard={render:make,buildUtm:utmUrl,channels:CHANNELS.map(c=>c.key),kpis:KPIS.map(k=>k.key)};
})();
