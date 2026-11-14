// 面談の質問はクリックで記録。選択肢は職務と希望に関する事実確認に限定する。
(function(root){
"use strict";
const steps=[
 [
  {id:"motivation",label:"応募のきっかけ",type:"select",options:["事業に興味がある","仕事内容に興味がある","働き方に興味がある","知人から紹介された","その他"]},
  {id:"ask",label:"今日確認したいこと（複数選択可）",type:"multi",options:["仕事内容","働き方","成長機会","報酬・条件","会社・事業"]}
 ],
 [
  {id:"interest",label:"興味を持った事業（複数選択可）",type:"multi",options:["ENGER","無限道場","AIまち","EIGHT SPACE","AI・DX開発"]},
  {id:"appeal",label:"魅力を感じた点",type:"select",options:["学びから仕事へのつながり","社会・地域への貢献","新しい事業への挑戦","経験を生かせそう","もう少し聞いて考えたい"]}
 ],
 [
  {id:"experience",label:"経験したこと（複数選択可）",type:"multi",options:["営業・提案","企画・広報","開発・制作","事務・運営","教育・地域活動"]},
  {id:"strength",label:"本人が話した強み（複数選択可）",type:"multi",options:["課題を見つける","行動・改善を続ける","人と話す・伝える","専門スキル","チームで進める"]},
  {id:"hope",label:"これから挑戦したいこと",type:"select",options:["経験をさらに深めたい","新しい仕事に挑戦したい","副業や業務委託で関わりたい","相談して決めたい"]}
 ],
 [
  {id:"job",label:"提案した仕事（複数選択可）",type:"multi",options:["企業への提案・営業","AI・DX企画","広報・SNS","開発・制作","顧客サポート","地域連携"]},
  {id:"goal",label:"最初の成果目標の認識",type:"select",options:["理解・合意できた","調整が必要","まだ説明していない"]},
  {id:"fit",label:"仕事内容についての本人の反応",type:"select",options:["取り組めそう","支援があれば取り組めそう","詳しい内容を確認したい","今回は難しい"]}
 ],
 [
  {id:"contract",label:"希望する契約形態",type:"select",options:["正社員","有期雇用・パート","業務委託","副業","相談して決めたい"]},
  {id:"workstyle",label:"希望する働き方（複数選択可）",type:"multi",options:["原宿への出社","一部リモート","フルリモート","勤務曜日・時間を相談"]},
  {id:"trial",label:"2週間トライアルの確認",type:"select",options:["条件を説明した","契約条件の確認が必要","今回は対象外"]}
 ],
 [
  {id:"next",label:"次のステップ",type:"select",options:["次回面談を調整","社長面談へ進む","2週間トライアルを検討","条件を提示する","社内で検討する"]},
  {id:"contact",label:"連絡方法",type:"select",options:["メール","電話","その他（メモに記録）"]},
  {id:"deadline",label:"回答予定",type:"select",options:["1〜2営業日","3〜5営業日","1週間以内","日程を調整中"]}
 ]
];
function normalize(input){
  if(!input||typeof input!=="object"||Array.isArray(input))return {};
  const output={};
  for(const step of steps)for(const q of step){
    const value=input[q.id];
    if(q.type==="select"){
      if(typeof value==="string"&&q.options.includes(value))output[q.id]=value;
    }else if(Array.isArray(value)){
      const picked=[...new Set(value.filter(x=>typeof x==="string"&&q.options.includes(x)))].slice(0,4);
      if(picked.length)output[q.id]=picked;
    }
  }
  if(typeof input.__material==="string"&&input.__material.length<100)output.__material=input.__material;
  return output;
}
root.HRInterviewChoices={steps,normalize};
})(typeof window==="undefined"?globalThis:window);
