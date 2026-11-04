// Shared, side-effect-free helpers. The workbench is a preview: no transport or writes.
export const DEFAULT_TEMPLATES = [
 {id:'intro',name:'初回のご挨拶',subject:'人材・開発のご支援について｜株式会社エイト',body:'{{company}}\n{{contact}}\n\n突然のご連絡失礼いたします。株式会社エイトの{{sender}}です。\nIT人材のご紹介や、システム開発・業務改善のご支援を行っております。\n現在、人材の確保や開発体制についてお困りのことはございますでしょうか。\nご関心がございましたら、ご状況をお聞かせいただけますと幸いです。\n\n株式会社エイト\n{{sender}}'},
 {id:'revive',name:'過去のご縁から再連絡',subject:'近況のお伺い｜株式会社エイト',body:'{{company}}\n{{contact}}\n\nお世話になっております。株式会社エイトの{{sender}}です。\n以前のご接点を踏まえ、現在のご状況をお伺いしたくご連絡いたしました。\n人材や開発体制、業務のデジタル化など、今お困りのことはございますでしょうか。\n必要に応じて、お力になれる内容をご案内できればと考えております。\n\n株式会社エイト\n{{sender}}'},
 {id:'talent',name:'ENGER・IT人材のご紹介',subject:'IT人材のご支援について｜ENGER',body:'{{company}}\n{{contact}}\n\n株式会社エイトの{{sender}}と申します。\nIT人材サービス「ENGER」を通じて、開発・運用などの人材のご紹介を行っております。\n現在募集中の職種・必要なスキル・開始時期などがございましたら、お聞かせいただけますでしょうか。\n条件を伺ったうえで、ご提案できる人材を確認いたします。\n\nhttps://enger.jp/business\n株式会社エイト\n{{sender}}'},
 {id:'dx',name:'AI・DXの課題ヒアリング',subject:'業務改善・AI活用のご相談｜株式会社エイト',body:'{{company}}\n{{contact}}\n\n株式会社エイトの{{sender}}と申します。\n社内の情報整理や問い合わせ対応など、日々の業務で時間がかかっていることはございますでしょうか。\n弊社では、業務の整理からAI活用・システム開発までご支援しております。\nご関心がございましたら、現在の課題をお聞かせいただけますと幸いです。\n\n株式会社エイト\n{{sender}}'},
];
export function fillTemplate(template, values){
 const replace=s=>String(s||'').replace(/\{\{\s*(company|contact|sender|service|url)\s*\}\}/g,(_,k)=>values[k]||'');
 return {subject:replace(template.subject),body:replace(template.body)};
}
export function safeWebsite(value){try{const u=new URL(String(value||''));return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
export function phoneLink(value){const v=String(value||'').trim();if(!/^[+\d\s().-]{5,30}$/.test(v))return null;const n=v.replace(/[\s().-]/g,'');return /^\+?\d{5,20}$/.test(n)?'tel:'+n:null;}
export function validEmail(value){return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(String(value||'').trim());}
export function previewProblem({channel,to,subject,body,sender,result,blocked,identified}){
 if(!identified)return '企業IDを確認してから操作してください。';
 if(blocked&&channel!=='memo')return '連絡停止・注意のため、営業操作はできません。';
 if(channel==='email'||channel==='form'){
  if(channel==='email'&&!validEmail(to))return '宛先メールアドレスを確認してください。';
  if(!sender?.trim())return '送る人の名前を入力してください。';
  if(!subject?.trim()||/[\r\n]/.test(subject))return '件名を1行で入力してください。';
  if(!body?.trim())return '本文を入力してください。';
  if(/\{\{[^}]+\}\}/.test(subject+body))return 'テンプレートの差し込み項目を入力してください。';
 }
 if(channel!=='email'&&!result)return '対応結果を選んでください。';
 return '';
}
export function mergeHistory(touchpoints=[],timeline=[],previews=[]){
 return [...touchpoints.map(t=>({id:'enger:'+t.id,at:t.occurredAt,label:t.summary||t.kind||'接点',detail:t.detail||'',actor:t.createdBy||'',source:'ENGER',nextAction:t.nextAction,nextDate:t.nextDue})),
 ...timeline.filter(t=>!t.planned).map((t,i)=>({id:'sales:'+i,at:t.at,label:t.label||t.kind,detail:t.detail||'',source:'Sales'})),
 ...previews.map(t=>({...t,source:'確認用・未保存'}))].sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
}

export function mailtoLink({to,subject,body}){
 if(!validEmail(to)||/[\r\n]/.test(String(subject||'')))return null;
 return 'mailto:'+encodeURIComponent(to.trim())+'?subject='+encodeURIComponent(subject||'')+'&body='+encodeURIComponent(body||'');
}
