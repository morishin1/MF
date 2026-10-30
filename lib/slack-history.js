// Non-confidential, channel-only receipts. Private DMs never enter this history.
import crypto from 'node:crypto';
import {canRecruit,canSell,canOffice,canOfficeHr,canOfficeFinance,isOwner} from './gw.js';
export const CHANNELS=Object.freeze({hr:'C0CCSBTDB1S',sales:'C0CCQHQN3SM',office:'C0CCLMUQZ7G'});
export const SOURCES=Object.freeze({hr:'hr-mailbox',sales:'sales-mailbox',office:'office-gw'});
export const TABLE='gw_slack_notification_history';
export const FIELDS='id,department,summary,sent_at,slack_permalink,coverage_status,coverage_note,period_start,period_end,target_date,slot,revision';
export const canRead=(ctx,dept)=>dept==='hr'?canRecruit(ctx):dept==='sales'?canSell(ctx):dept==='office'?(canOffice(ctx)||canOfficeHr(ctx)||canOfficeFinance(ctx)):false;
export const canRecord=(ctx,dept)=>isOwner(ctx)&&canRead(ctx,dept);
const invalid=()=>({error:'invalid_receipt'});
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
export function normalizeReceipt(b,now=Date.now()){
 if(!b||typeof b!=='object'||Array.isArray(b))return invalid();
 const allowed=['department','summary','sentAt','slackPermalink','slackTs','coverageStatus','coverageNote','periodStart','periodEnd','targetDate','slot','revision','source','sourceIds','confirmedSent','confirmedNonConfidential'];
 if(Object.keys(b).some(k=>!allowed.includes(k)))return invalid();
 const dept=b.department,channel=CHANNELS[dept];
 if(!channel||b.source!==SOURCES[dept]||b.confirmedSent!==true||b.confirmedNonConfidential!==true)return invalid();
 if(typeof b.summary!=='string'||!b.summary.trim()||b.summary.length>2000||typeof b.coverageNote!=='string'||b.coverageNote.length>500)return invalid();
 if(!['complete','partial','unavailable'].includes(b.coverageStatus)||b.coverageStatus!=='complete'&&!b.coverageNote.trim())return invalid();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(b.targetDate||'')||!stamp(b.targetDate)||stamp(b.targetDate).slice(0,10)!==b.targetDate||!['08','12','17'].includes(b.slot)||!Number.isSafeInteger(b.revision)||b.revision<1)return invalid();
 if([b.periodStart,b.periodEnd,b.sentAt].some(v=>typeof v!=='string'||!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(v)))return invalid();
 const start=stamp(b.periodStart),end=stamp(b.periodEnd),sent=stamp(b.sentAt);
 if(!start||!end||!sent||start>=end||end>sent||Date.parse(sent)>now+60000)return invalid();
 if(!/^\d{10}\.\d{6}$/.test(b.slackTs||'')||Math.abs(Number(b.slackTs)*1000-Date.parse(sent))>1000)return invalid();
 const permalink=`https://8grp.slack.com/archives/${channel}/p${b.slackTs.replace('.','')}`;
 if(b.slackPermalink!==permalink)return invalid();
 if(!Array.isArray(b.sourceIds)||b.sourceIds.length>500||b.sourceIds.some(x=>typeof x!=='string'||!/^[A-Za-z0-9._:@/-]{1,200}$/.test(x)))return invalid();
 const sourceIds=[...new Set(b.sourceIds)].sort();
 const row={department:dept,summary:b.summary.trim(),sent_at:sent,slack_permalink:permalink,slack_channel:channel,slack_ts:b.slackTs,coverage_status:b.coverageStatus,coverage_note:b.coverageNote.trim(),period_start:start,period_end:end,target_date:b.targetDate,slot:b.slot,revision:b.revision,source:SOURCES[dept],source_ids:sourceIds};
 return {row:{...row,receipt_hash:crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex')}};
}
