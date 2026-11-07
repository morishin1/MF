// Provenance-only channel labels; never infer that LINE connected = LINE message received.
export function sourceChannel(row) {
 const explicit=String(row?.source_channel??row?.ingest_channel??"").trim().toLowerCase();
 if(["line","lineworks","line_works"].includes(explicit))return "LINE";
 if(["mail","email","gmail"].includes(explicit))return "メール";
 const signup=String(row?.signup_source??"").trim().toLowerCase();
 if(signup==="line")return "LINE登録";
 if(row?.source_mail_at||row?.source_mail_url||row?.source_mail_subject)return "メール";
 return "不明";
}
export function channelLabel(v) {
 return ["メール","LINE","LINE登録"].includes(v)?v:"不明";
}
