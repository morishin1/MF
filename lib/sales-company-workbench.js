import {safeWebsite,validEmail,phoneLink} from './sales-contact-preview.js';
export const COMPANY_FIELDS={
 name:{label:'企業名',max:200,required:true},contactName:{label:'担当窓口',max:100},contactEmail:{label:'メール',max:254,type:'email'},phone:{label:'電話',max:30,type:'tel'},address:{label:'所在地',max:500},industry:{label:'業種',max:100},website:{label:'ホームページ',max:500,type:'url'},formUrl:{label:'問い合わせフォーム',max:500,type:'url'},
 status:{label:'登録状態',options:['新規','休眠','打ち合わせ済','既存','主要','拡大中','その他']},note:{label:'登録メモ',max:2000,type:'textarea'},isFavorite:{label:'企業評価',options:['未設定','注力企業'],type:'boolean'},isEndClient:{label:'エンド企業',options:['未確認','登録あり'],type:'boolean'}
};
export const ACTION_RESULTS={
 phone:['電話対応：通話できた','電話対応：不在・つながらない','電話対応：折り返し待ち','電話対応：資料送付を依頼された','電話対応：商談・面談を調整','電話対応：連絡不要と言われた'],
 form:['フォーム送信完了（本人確認）','フォーム：問い合わせ先を調査中','フォーム：送信できなかった','フォーム：営業連絡を受け付けていない'],
 memo:['メール送信済み（外部送信・本人記録）','フォーム送信済み（外部送信・本人記録）','電話対応済み（本人記録）','情報を更新','連絡先を調査','次回対応を設定','その他']
};
export function profilePatch(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==1)throw Error('編集する項目を1つ指定してください。');
 const [key]=Object.keys(raw),f=COMPANY_FIELDS[key];if(!f)throw Error('この項目は編集できません。');
 let value=raw[key];if(f.type==='boolean'){if(typeof value!=='boolean')throw Error('選択内容を確認してください。');return{[key]:value};}
 if(value===null&&!f.required)return{[key]:null};
 if(typeof value!=='string')throw Error('入力内容を確認してください。');value=value.trim();
 if(value.length>(f.max||100)||f.required&&!value)throw Error('文字数・必須項目を確認してください。');
 if(value&&f.options&&!f.options.includes(value))throw Error('候補から選択してください。');
 if(value&&f.type==='email'&&!validEmail(value))throw Error('メールアドレスを確認してください。');
 if(value&&f.type==='tel'&&!phoneLink(value))throw Error('電話番号を確認してください。');
 if(value&&f.type==='url'&&!safeWebsite(value))throw Error('http または https のURLを入力してください。');
 return{[key]:value||null};
}
export function planInput(raw={},partial=false){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('次回対応を確認してください。');
 const out={};for(const [key,max] of [['owner',80],['nextDate',10],['nextAction',200]]){
  if(partial&&!(key in raw))continue;
  if(raw[key]!=null&&typeof raw[key]!=='string')throw Error('次回対応を確認してください。');
  const v=(raw[key]||'').trim();if(v.length>max)throw Error('次回対応の入力が長すぎます。');
  if(key==='nextDate'&&v&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v))throw Error('次回予定の日付を確認してください。');
  out[key]=v;
 }return out;
}
export function activityInput(raw){
 const channel=raw.channel,result=raw.result;if(!ACTION_RESULTS[channel]?.includes(result))throw Error('実際の対応に合う結果を選んでください。');
 const note=String(raw.note||'').trim(),body=String(raw.body||'').trim(),subject=String(raw.subject||'').trim();
 if(note.length>2000||body.length>20000||subject.length>300)throw Error('入力が長すぎます。');
 if(channel==='memo'&&!note)throw Error('送信先や対応内容をメモに入力してください。');
 if(channel==='form'&&result.startsWith('フォーム送信完了')&&!body)throw Error('送信した本文を入力してください。');
 return{channel,result,note,body:channel==='form'?body:'',subject:channel==='form'?subject:'',plan:planInput(raw.plan)};
}
