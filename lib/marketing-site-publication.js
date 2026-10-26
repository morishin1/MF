// Text-only PR publication to the existing 8grp news pipeline. No arbitrary URL fetches.
import {createHash} from 'node:crypto';
import '../js/marketing-space-release-draft.js';
import {sanitizeHtml, plain, urlOf, jstToday} from './site-news.js';
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLUG=/^press-mkt-[0-9a-f]{32}$/;
export const hashContent=(title,summary,body)=>createHash('sha256').update(JSON.stringify([title,summary,body])).digest('hex');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const exposure=[
 '8grp.co.jpの記事ページ、ニュース一覧、トップページの新着欄に一般公開されます。',
 'タイトル・概要・本文・会社情報・問い合わせ先（電話・メール・担当者名を含む）が公開対象です。',
 '画像本体は公開されません。本文中の画像説明は文字として公開されます。',
 '既存の定時同期で配信します。毎朝8時（日本時間）予定で、同期失敗時は反映が遅れます。',
 '既存サイト同期の設定によってはSlack通知も送られます。SNS・PR TIMESへの自動投稿は行いません。'
];
export function buildPublication(row){
 const d=row?.payload?.draft;
 if(!UUID.test(row?.id||'')||!d||typeof d.title!=='string'||typeof d.summary!=='string')throw Error('invalid_saved_pr');
 const title=plain(d.title,120),summary=plain(d.summary,600);
 const bodyText=row.payload.body_override||globalThis.SpaceRelease.buildDraft({...d,images:(d.images||[]).map(i=>({path:i.name,caption:i.caption}))});
 if(!title||!summary||typeof bodyText!=='string'||!bodyText.trim()||bodyText.length>60000)throw Error('invalid_saved_pr');
 // Input is text, never author-supplied HTML. Escaping happens BEFORE allowlist sanitation.
 const bodyHtml=sanitizeHtml(bodyText.trim().split(/\n{2,}/).map(p=>'<p>'+escape(p).replace(/\n/g,'<br>')+'</p>').join('\n'));
 const slug='press-mkt-'+row.id.replace(/-/g,'').toLowerCase();
 return {title,summary,bodyText,bodyHtml,hash:hashContent(title,summary,bodyHtml),slug,publicUrl:urlOf(slug),exposure};
}
export function sourceMatches(p,a){
 return !!a&&a.id===p.article_id&&a.slug===p.slug&&a.status==='published'
  &&typeof a.published_on==='string'&&a.published_on.slice(0,10)<=jstToday()&&a.published_on.length>=10
  &&a.title===p.title&&a.summary===p.summary&&a.body_html===p.body_html
  &&hashContent(a.title,a.summary,a.body_html)===p.content_hash;
}
export function publicHtmlMatches(html,p){
 if(typeof html!=='string'||!SLUG.test(p.slug))return false;
 // The existing news-sync template emits these exact elements; no browser or remote scripts execute.
 const canonical=html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']\s*\/?\s*>/i);
 const heading=html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i);
 const noindex=/<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i.test(html);
 // Python html.escape (the existing site generator) uses &#x27; for apostrophes.
 const siteEscape=s=>escape(s).replace(/&#39;/g,'&#x27;');
 const body=html.match(/<div\s+class=["']rn-body["']\s*>\s*([\s\S]*?)\s*<\/div>/i);
 return !noindex&&canonical?.[1]===urlOf(p.slug)&&heading?.[1].trim()===siteEscape(p.title)
  &&heading?.[2].trim()===siteEscape(p.summary)
  &&body?.[1].trim()===p.body_html.trim();
}
export async function inspectPublicPage(p,fetcher=fetch){
 if(!SLUG.test(p.slug))return {result:'invalid_target'};
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{
  const response=await fetcher(urlOf(p.slug),{redirect:'manual',signal:controller.signal,headers:{Accept:'text/html','Cache-Control':'no-cache'}});
  if(response.status!==200)return {result:response.status===404?'pending':'unavailable'};
  if(!/^text\/html\b/i.test(response.headers.get('content-type')||''))return {result:'content_mismatch'};
  if(Number(response.headers.get('content-length')||0)>2*1024*1024)return {result:'too_large'};
  if(!response.body?.getReader)return {result:'unavailable'};
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();return {result:'too_large'};}chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock();}
  const html=Buffer.concat(chunks).toString('utf8');
  return {result:publicHtmlMatches(html,p)?'verified':'content_mismatch'};
 }catch{return {result:'unavailable'};}finally{clearTimeout(timer);controller.abort();}
}
