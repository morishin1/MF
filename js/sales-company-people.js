// Company ID-scoped human contacts; do not infer 名刺交換 from existing email/legacy status.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const PEOPLE_SOURCES={
 business_card:'名刺交換',inquiry:'問い合わせ',referral:'紹介',event:'イベント',meeting:'商談',other:'その他',
};
const personInfo=p=>[p.department,p.position,p.met_on?'接点日 '+p.met_on:'',p.email,p.phone].filter(Boolean).join(' ／ ');
export function createSalesCompanyPeople({onChanged=()=>{}}={}){
 let sequence=0;
 const alive=(n,root)=>n===sequence&&document.getElementById('lc-people-panel')===root;
 async function mount(companyId,contactName=''){
  const root=document.getElementById('lc-people-panel');if(!root)return;
  const n=++sequence;
  root.innerHTML='<h3>担当者・接点</h3>'+
   '<p class="lc-detail-note">誰と、どこで接点ができたかを記録します。会社の営業段階とは別に保存します。</p>'+
   (contactName?'<p class="lc-person-legacy">企業基本情報の担当窓口：'+esc(contactName)+'（接点の種類は未登録）</p>':'')+
   '<div id="lc-people-list" aria-live="polite">担当者を読み込み中…</div>'+
   '<button type="button" id="lc-person-add" disabled>担当者・名刺を登録</button>'+
   '<form id="lc-person-form" class="lc-person-form" hidden>'+
   '<label>担当者名（必須）<input name="name" maxlength="120" required placeholder="例：田中 太郎"></label>'+
   '<label>接点（必須）<select name="source" required>'+Object.entries(PEOPLE_SOURCES).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('')+'</select></label>'+
   '<label>接点日<input type="date" name="metOn"></label>'+
   '<label>部署<input name="department" maxlength="120"></label>'+
   '<label>役職<input name="position" maxlength="120"></label>'+
   '<label>メール<input type="email" name="email" maxlength="254"></label>'+
   '<label>電話<input name="phone" maxlength="80"></label>'+
   '<label class="wide">メモ<textarea name="note" rows="2" maxlength="2000" placeholder="どこで会ったか・紹介者・会話内容など"></textarea></label>'+
   '<div class="lc-person-form-actions"><button type="submit" class="lc-primary">保存</button><button type="button" id="lc-person-cancel">キャンセル</button></div></form>'+
   '<p id="lc-person-message" class="lc-detail-note" role="status"></p>';
  const list=root.querySelector('#lc-people-list'),form=root.querySelector('form'),add=root.querySelector('#lc-person-add'),message=root.querySelector('#lc-person-message');
  if(!companyId){list.textContent='企業IDの照合後に登録できます。';return;}
  let people=[];
  const draw=()=>{
   list.innerHTML=people.length?people.map(p=>'<article class="lc-person-row">'+
    '<div><strong>'+esc(p.name)+'</strong> <span class="lc-person-tag">'+esc(PEOPLE_SOURCES[p.source]||'その他')+'</span>'+
    '<small>'+esc(personInfo(p)||'接点日・連絡先未登録')+'</small>'+
    (p.note?'<small>'+esc(p.note)+'</small>':'')+'</div>'+
    '<button type="button" data-person-edit="'+esc(p.id)+'">編集</button></article>').join(''):
    '<p class="lc-detail-note">登録された担当者・名刺はありません。企業基本情報の名前・メールだけでは名刺交換と判定しません。</p>';
   list.querySelectorAll('[data-person-edit]').forEach(b=>b.onclick=()=>edit(people.find(p=>p.id===b.dataset.personEdit)));
  };
  const edit=p=>{
   form.reset();
   for(const key of ['name','source','metOn','department','position','email','phone','note']){
    const node=form.elements.namedItem(key);
    if(node)node.value=p?(p[key==='metOn'?'met_on':key]||''):(key==='source'?'business_card':'');
   }
   if(!p&&contactName&&!people.length)form.elements.namedItem('name').value=contactName;
   form.dataset.personId=p?.id||'';
   form.hidden=false;add.hidden=true;message.textContent=p?'担当者情報を編集しています。':'新しい担当者を登録します。';
   form.elements.namedItem('name').focus();
  };
  root.querySelector('#lc-person-cancel').onclick=()=>{form.hidden=true;add.hidden=false;message.textContent='';};
  add.onclick=()=>edit(null);
  form.onsubmit=async event=>{
   event.preventDefault();
   if(!alive(n,root))return;
   const payload={companyId};
   for(const key of ['name','source','metOn','department','position','email','phone','note'])payload[key]=form.elements.namedItem(key).value.trim();
   const id=form.dataset.personId,submit=form.querySelector('[type=submit]');if(id)payload.id=id;
   submit.disabled=true;message.textContent='保存中…';
   try{
    await API.api('/api/sales/company-people',{method:id?'PATCH':'POST',body:payload});
    if(!alive(n,root))return;
    form.hidden=true;add.hidden=false;message.textContent='担当者・接点を保存しました。';
    const d=await API.api('/api/sales/company-people?companyId='+encodeURIComponent(companyId));
    if(!alive(n,root))return;
    people=d.people||[];draw();void onChanged();
   }catch(e){if(alive(n,root))message.textContent=e.hint||'保存できませんでした。入力内容と接続を確認してください。';}
   finally{if(alive(n,root))submit.disabled=false;}
  };
  try{
   const d=await API.api('/api/sales/company-people?companyId='+encodeURIComponent(companyId));
   if(!alive(n,root))return;
   people=d.people||[];draw();add.disabled=false;
  }catch(e){if(alive(n,root)){list.textContent=e.hint||'担当者を取得できませんでした。';message.textContent='再取得して確認してください。';}}
 }
 return {mount,reset:()=>{sequence++;}};
}
