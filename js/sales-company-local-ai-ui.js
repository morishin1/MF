// Compact local AI round-trip inside Sales / 商談準備.
// No LLM API usage. Only local file download, paste, explicit preview+save.
export function renderLocalAIControls(host,companyId,{onFilters}={}) {
  if(!host)return;
  host.innerHTML = [
    '<section class="lp-brief-card"><header class="lp-brief-head"><div>',
    '<h4>ローカルAIでマッチング条件を整える</h4>',
    '<small>企業の元データ→MD→ローカルAI→JSON貼付→確認→DB登録</small>',
    '</div></header>',
    '<div class="lp-local-actions">',
    '<button type="button" class="lc-primary" id="lp-ai-export">1. 分析用MDをダウンロード</button>',
    '</div>',
    '<label class="lp-local-label" for="lp-ai-result">2. ローカルAIが返したJSONを貼り付け</label>',
    '<textarea id="lp-ai-result" rows="6" maxlength="60000" placeholder="ローカルAIのJSONをここへ貼り付けます"></textarea>',
    '<div class="lp-local-actions">',
    '<button type="button" id="lp-ai-preview">3. マッチング項目へ分解</button>',
    '<button type="button" id="lp-ai-save" class="lc-primary" disabled>内容を確認してDB登録</button>',
    '</div>',
    '<p id="lp-ai-status" class="lc-detail-note" role="status" aria-live="polite">',
    '企業情報・受領履歴を根拠として、ENGERの職種・スキル・単価・勤務条件等に整理します。AI推定は未確認として保存。</p>',
    '<div id="lp-ai-preview-content" class="lp-local-preview"></div>',
    '</section>'
  ].join("");
  const by=id=>host.querySelector("#"+id);
  let issuedHash=null;
  let previewedText=null;
  let previewedResult=null;
  let working=false;
  const report=t=>{by("lp-ai-status").textContent=t;};
  const lock=v=>{working=v;by("lp-ai-export").disabled=v;by("lp-ai-preview").disabled=v;by("lp-ai-save").disabled=v||!previewedResult;};
  const simple=(tag,value)=>{const n=document.createElement(tag);n.textContent=String(value??"");return n;};
  const visibleText=(v)=>v===null||v===undefined||v===""?"未確認":String(v);
  function draw(mapped) {
    const area=by("lp-ai-preview-content");area.replaceChildren();
    for(const [i,r] of mapped.entries()) {
      const card=document.createElement("div");card.className="lp-local-field-card";
      const inp=r.job_match_input || r.candidate_match_ref;
      card.append(simple("strong",(i+1)+". "+(r.direction==="talent"?"求める人材（ENGERの案件条件）":"保有人材に合う案件（実在人材ID）")));
      if(r.job_match_input) {
        const j=r.job_match_input;
        card.append(simple("small","職種："+visibleText(j.title)));
        card.append(simple("small","スキル："+(j.skills||[]).join("・")));
        card.append(simple("small","単価（万円/月）："+visibleText(j.salary_min)+"〜"+visibleText(j.salary_max)));
        card.append(simple("small","勤務形態："+visibleText(j.remote_type)+" ／ 勤務地："+visibleText(j.work_location)));
        card.append(simple("small","開始日："+visibleText(j.start_date)+" ／ 必要経験："+visibleText(j.required_experience_years)));
      } else {
        card.append(simple("small","照合人材ID："+visibleText(inp?.candidateId)));
        if(!inp)card.append(simple("small","※実在の人材ID未登録。ENGERの案件マッチングには送れません。"));
      }
      card.append(simple("small","状態：AI仮説（未確認） ／ 根拠："+(r.evidence_refs||[]).join("・")));
      area.append(card);
    }
  }
  by("lp-ai-export").addEventListener("click",async()=>{
    lock(true);report("企業情報をMDにまとめています…");
    try {
      const r=await API.api("/api/sales/company-local-ai?"+new URLSearchParams({companyId}));
      if(!r.markdown||!r.sourceHash)throw Error("MDを作成できません。");
      issuedHash=r.sourceHash;
      previewedResult=null;previewedText=null;
      by("lp-ai-preview-content").replaceChildren();
      const file=new Blob([r.markdown],{type:"text/markdown;charset=utf-8"});
      const url=URL.createObjectURL(file);
      const a=document.createElement("a");a.href=url;a.download="ENGER-company-"+companyId.slice(0,8)+"-AI.md";
      document.body.append(a);a.click();a.remove();
      URL.revokeObjectURL(url);
      report("MDをダウンロードしました。ローカルAIへ渡し、JSON形式の結果を貼り付けてください。");
    } catch(e){report(e?.hint||"MDの取得に失敗しました。");}
    finally{lock(false);}
  });
  by("lp-ai-result").addEventListener("input",()=>{
    previewedResult=null;previewedText=null;by("lp-ai-save").disabled=true;
    by("lp-ai-preview-content").replaceChildren();
  });
  by("lp-ai-preview").addEventListener("click",async()=>{
    const text=by("lp-ai-result").value.trim();
    if(!text){report("分析結果のJSONを貼り付けてください。");return;}
    lock(true);report("企業ID・元データ・各マッチング項目を確認中…");
    try {
      const r=await API.api("/api/sales/company-local-ai",{method:"POST",body:{
        action:"preview",companyId,text,
      }});
      if(!r?.ok||!Array.isArray(r.mapped))throw Error("分解結果を確認できませんでした。");
      previewedResult=r;previewedText=text;draw(r.mapped);
      const selected=r.mapped.find(x=>x.job_match_input?.skills?.length);
      onFilters?.(selected?.job_match_input||null);
      report("マッチング項目に分解しました。根拠と条件を確認したうえで登録してください。");
    } catch(e){previewedResult=null;report(e?.hint||"JSONを検証できませんでした。出力形式を確認してください。");}
    finally{lock(false);}
  });
  by("lp-ai-save").addEventListener("click",async()=>{
    if(!previewedResult||!previewedText||working)return;
    lock(true);report("確認済みのAI分析プロフィールを保存中…");
    try {
      const r=await API.api("/api/sales/company-local-ai",{method:"POST",body:{
        action:"save",companyId,text:previewedText,confirmed:true,
      }});
      if(!r?.saved)throw Error("保存結果を確認できません。");
      report("保存しました。ENGERマッチング用の仮説プロフィールを登録しました。正式案件・人材の自動登録やオファーは行いません。");
      const link=document.createElement("a");
      link.href="https://dx.enger.jp/companies/"+encodeURIComponent(companyId)+"/local-ai";
      link.textContent="ENGERでマッチング候補を確認";
      link.target="_blank";link.rel="noopener noreferrer";
      link.className="lc-primary-link";
      by("lp-ai-preview-content").prepend(link);
    }catch(e){report(e?.hint||"DB保存に失敗しました。");}
    finally{lock(false);}
  });
}
