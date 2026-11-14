/* Curated answers, explicit staff questions, and read-only legacy history. */
(() => {
  const $=id=>document.getElementById(id),esc=KPLayout.esc;
  const labels={new:'受付済み',in_progress:'対応中',waiting_user:'回答の確認待ち',resolved:'解決済み',closed:'終了'};
  const date=s=>s?new Date(s).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
  let categories=[],searchSeq=0,dialogSeq=0,busy=false,legacyLoaded=false;
  const error=e=>e.hint||e.message||'読み込めませんでした。時間をおいてお試しください。';
  const open=title=>{dialogSeq++;$('qa-dialog-title').textContent=title;$('qa-dialog-error').textContent='';$('qa-dialog-body').innerHTML='読み込み中…';if(!$('qa-dialog').open)$('qa-dialog').showModal();return dialogSeq;};
  function lock(value){busy=value;$('qa-close').disabled=value;}
  $('qa-close').onclick=()=>{if(!busy){dialogSeq++;$('qa-dialog').close();}};
  $('qa-dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();else dialogSeq++;});
  const bubbles=messages=>messages.map(m=>`<div class="qa-bubble"><small>${m.role==='assistant'?'過去のAI回答':m.sender_type==='admin'?'担当者':'自分'} · ${esc(date(m.created_at))}</small><div class="qa-text">${esc(m.content||'')}</div></div>`).join('');
  async function search(){
    const n=++searchSeq;$('qa-message').textContent='検索中…';
    try{const d=await API.api('/api/questions?'+new URLSearchParams({q:$('qa-query').value.trim(),category:$('qa-category').value}));if(n!==searchSeq)return;
      categories=d.categories||[];
      if($('qa-category').options.length===1)for(const c of categories)$('qa-category').add(new Option(c.label,c.code));
      $('qa-manage').hidden=!d.canManage;
      $('qa-results').innerHTML=(d.questions||[]).map(q=>`<details class="qa-answer"><summary>${esc(q.title)}</summary><p class="qa-text">${esc(q.answer)}</p>${q.sourceUrl?`<a href="${esc(q.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(q.sourceLabel||'関連する資料を開く')} ↗</a>`:''}</details>`).join('');
      $('qa-message').textContent=d.questions?.length?`${d.questions.length}件のQ&A`:'該当するQ&Aはありません。「担当者に質問する」から確認できます。';
    }catch(e){if(n===searchSeq){$('qa-message').textContent=error(e);$('qa-results').replaceChildren();}}
  }
  async function inquiries(){
    try{const d=await API.api('/api/ai/inquiries?scope=mine');if(d.notReady)throw Error('質問の受付は準備中です。');
      $('qa-inquiries').innerHTML=(d.inquiries||[]).map(q=>`<button type="button" class="qa-row" data-inquiry="${esc(q.id)}"><span>${esc(q.subject)}<br><small>${esc(date(q.updated_at||q.created_at))}</small></span><span>${esc(labels[q.status]||'確認中')} ›</span></button>`).join('')||'<p class="qa-muted">まだ質問はありません。</p>';
      $('qa-inquiries').querySelectorAll('[data-inquiry]').forEach(b=>b.onclick=()=>inquiry(b.dataset.inquiry));
    }catch(e){$('qa-inquiries').textContent=error(e);}
  }
  function ask(){
    open('担当者に質問する');$('qa-dialog-body').innerHTML=`<form id="qa-ask-form"><p class="qa-muted">質問と回答は、この画面で確認できます。</p><label for="qa-topic">カテゴリ</label><select id="qa-topic">${categories.map(c=>`<option value="${esc(c.code)}">${esc(c.label)}</option>`).join('')}</select><label for="qa-note">質問したいこと</label><textarea id="qa-note" maxlength="4000" required placeholder="状況と、確認したいことを入力してください。"></textarea><footer><button class="btn btn-primary" type="submit">この内容で質問する</button></footer></form>`;
    $('qa-note').value=$('qa-query').value.trim();$('qa-note').focus();
    $('qa-ask-form').onsubmit=async e=>{e.preventDefault();const note=$('qa-note').value.trim();if(!note||busy)return;const b=e.submitter;lock(true);b.disabled=true;$('qa-dialog-error').textContent='';
      try{const d=await API.createAiInquiry(null,note,$('qa-topic').value||'other');if(d.notReady||!d.inquiry?.id)throw Error('質問を受け付けられませんでした。時間をおいてお試しください。');$('qa-dialog').close();dialogSeq++;$('qa-message').textContent='質問を受け付けました。回答は「自分の質問・回答」で確認できます。';await inquiries();}
      catch(err){$('qa-dialog-error').textContent=error(err);}finally{lock(false);b.disabled=false;}
    };
  }
  async function inquiry(id){
    const n=open('質問・回答');try{const d=await API.getAiInquiry(id);if(n!==dialogSeq)return;if(d.notReady||!d.inquiry)throw Error('質問を読み込めませんでした。');
      $('qa-dialog-title').textContent=d.inquiry.subject;$('qa-dialog-body').innerHTML=`<p class="qa-muted">${esc(labels[d.inquiry.status]||'確認中')}</p>${bubbles(d.messages||[])}<form id="qa-reply-form"><label for="qa-reply">追加で伝える</label><textarea id="qa-reply" maxlength="4000" required></textarea><footer><button class="btn btn-primary" type="submit">返信する</button></footer></form>`;
      $('qa-reply-form').onsubmit=async e=>{e.preventDefault();const text=$('qa-reply').value.trim();if(!text||busy)return;const b=e.submitter;lock(true);b.disabled=true;
        try{const result=await API.replyAiInquiry(id,text);if(result.notReady||!result.message?.id)throw Error('返信を保存できませんでした。');lock(false);await inquiry(id);await inquiries();}
        catch(err){$('qa-dialog-error').textContent=error(err);}finally{lock(false);b.disabled=false;}
      };
    }catch(e){if(n===dialogSeq)$('qa-dialog-body').textContent=error(e);}
  }
  $('qa-search').onsubmit=e=>{e.preventDefault();search();};$('qa-category').onchange=search;$('qa-ask').onclick=ask;
  $('qa-legacy').addEventListener('toggle',async()=>{if(!$('qa-legacy').open||legacyLoaded)return;legacyLoaded=true;
    try{const d=await API.listAiThreads();if(d.notReady)throw Error('過去の相談を読み込めませんでした。');$('qa-legacy-list').innerHTML=(d.threads||[]).map(t=>`<button class="qa-row" type="button" data-thread="${esc(t.id)}">${esc(t.title||'過去の相談')} ›</button>`).join('')||'<p class="qa-muted">過去のAI相談はありません。</p>';
      $('qa-legacy-list').querySelectorAll('[data-thread]').forEach(b=>b.onclick=async()=>{const n=open('過去のAI相談');try{const t=await API.getAiThread(b.dataset.thread);if(n===dialogSeq){if(t.notReady)throw Error('相談を読み込めませんでした。');$('qa-dialog-body').innerHTML=bubbles(t.messages||[]);}}catch(e){if(n===dialogSeq)$('qa-dialog-body').textContent=error(e);}});
    }catch(e){legacyLoaded=false;$('qa-legacy-list').textContent=error(e);}
  });
  KPLayout.init({ active: "messages", roles: ["member", "admin", "owner"] }).then(ctx=>{if(ctx?.me?.gw?.employee){search();inquiries();}else if(ctx){$('qa-results').textContent='社員登録を確認してください。';$('qa-inquiries').textContent='';$('qa-ask').disabled=true;}});
})();
