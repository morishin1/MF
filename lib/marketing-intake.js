// GW inquiry handling record. Original mail/form stays in its original system.
// Phone is a manually entered original; no recording, telephony, imports or sends.
export const INTAKE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INTAKE_SOURCE_BIZ = { hr_lead: "mugen", mugen_course: "mugen", space_inquiry: "space", site_contact: "site" };
export const INTAKE_BIZ = ["mugen", "space", "site"];
export function intakeFailure(error, status = 400) { return Object.assign(new Error(error), { intakeError: error, status }); }
const fail = (code) => { throw intakeFailure(code); };
const text = (v, max, required = false) => {
  if (v == null && !required) return "";
  if (typeof v !== "string" || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) fail("invalid_text");
  const s = v.trim(); if (required && !s) fail("required_text"); return s;
};
const emailAddress = (v, required = false) => {
  const s = text(v, 254, required).toLowerCase();
  if (!s) return null;
  if (!/^[a-z0-9_%+\-]+(?:\.[a-z0-9_%+\-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s) || s.split('@')[0].length > 64) fail("invalid_email");
  return s;
};
const timestamp = (v) => {
  const m = typeof v === "string" && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(Z|([+-])(\d\d):(\d\d))$/.exec(v);
  if (!m) fail("invalid_datetime");
  const [year, month, day, hour, minute, second] = m.slice(1,7).map(x => Number(x || 0));
  const offsetHour=Number(m[9] || 0), offsetMinute=Number(m[10] || 0);
  if (year<1900 || month<1 || month>12 || day<1 || day>new Date(Date.UTC(year,month,0)).getUTCDate()
      || hour>23 || minute>59 || second>59 || offsetHour>14 || offsetMinute>59 || (offsetHour===14 && offsetMinute!==0)
      || !Number.isFinite(Date.parse(v))) fail("invalid_datetime");
  return new Date(v).toISOString();
};
const uuid = (v) => { if (typeof v !== "string" || !INTAKE_UUID.test(v)) fail("invalid_id"); return v.toLowerCase(); };
export function normalizeIntakeInput(body, action = "create", defaultOwner) {
  if (!body || Array.isArray(body) || typeof body !== "object") fail("invalid_body");
  const allowed = action === "create"
    ? ["action", "requestId", "channel", "biz", "sourceType", "sourceId", "name", "contact", "email", "emailPending", "subject", "callbackWish", "receivedAt", "ownerEmployeeId", "nextAction", "dueAt"]
    : ["action", "id", "version", "requestId", "ownerEmployeeId", "nextAction", "dueAt", "state", "result", "note", "email", "emailPending"];
  if (Object.keys(body).some(k => !allowed.includes(k))) fail("unexpected_field");
  if (Object.hasOwn(body,"emailPending") && typeof body.emailPending !== "boolean") fail("invalid_email_pending");
  const contactUpdate = { ...(Object.hasOwn(body,"email") ? {email:emailAddress(body.email)} : {}),
    ...(Object.hasOwn(body,"emailPending") ? {emailPending:body.emailPending} : {}) };
  const base = { requestId: uuid(body.requestId), ownerEmployeeId: uuid(body.ownerEmployeeId || defaultOwner),
    nextAction: text(body.nextAction, 1000, true), dueAt: timestamp(body.dueAt) };
  if (action === "update") {
    if (!Number.isSafeInteger(body.version) || body.version < 1) fail("invalid_version");
    if (!["open", "done"].includes(body.state)) fail("invalid_state");
    return { ...base, ...contactUpdate, id: uuid(body.id), version: body.version, state: body.state,
      result: text(body.result, 2000, body.state === "done"), note: text(body.note, 2000) };
  }
  if (!["phone", "email", "form"].includes(body.channel) || !INTAKE_BIZ.includes(body.biz)) fail("invalid_channel_or_business");
  const out = { ...base, channel: body.channel, biz: body.biz };
  if (body.channel === "phone") {
    if (body.sourceType || body.sourceId) fail("phone_has_source");
    const email=emailAddress(body.email), emailPending=body.emailPending === true;
    validateIntakeContact({channel:"phone",biz:body.biz,phone_email:email,email_pending:emailPending,state:"open"});
    return { ...out, sourceType: null, sourceId: null, name: text(body.name, 100, true), contact: text(body.contact, 254, true), email, emailPending,
      subject: text(body.subject, 2000, true), callbackWish: text(body.callbackWish, 500), receivedAt: timestamp(body.receivedAt) };
  }
  if (Object.hasOwn(body, "email") || Object.hasOwn(body, "emailPending")) fail("original_must_not_be_copied");
  if (["name", "contact", "subject", "callbackWish", "receivedAt"].some(k => body[k] != null && body[k] !== "")) fail("original_must_not_be_copied");
  const sourceType = body.sourceType;
  if (!(Object.hasOwn(INTAKE_SOURCE_BIZ, sourceType) || (body.channel === "email" && sourceType === "hr_mail"))) fail("invalid_source");
  if (sourceType !== "hr_mail" && INTAKE_SOURCE_BIZ[sourceType] !== body.biz) fail("source_business_mismatch");
  return { ...out, sourceType, sourceId: uuid(body.sourceId), name: null, contact: null, email: null, emailPending: false, subject: null, callbackWish: null, receivedAt: null };
}
export function validateIntakeContact(row, patch = {}) {
  const hasEmail=Object.hasOwn(patch,"email"), hasPending=Object.hasOwn(patch,"emailPending");
  if(row.channel!=="phone") { if(hasEmail || hasPending) fail("original_must_not_be_copied"); return; }
  const email=hasEmail ? patch.email : row.phone_email;
  const pending=hasPending ? patch.emailPending : row.email_pending === true;
  if(pending && (row.biz!=="space" || email)) fail("invalid_email_pending");
  if(row.biz==="space" && !email && !pending) fail("email_or_pending_required");
  if(pending && (patch.state || row.state)==="done") fail("email_pending_cannot_complete");
}
export function canEditIntake(ctx, userId, row) {
  return Boolean(ctx.roles?.includes("owner") || row.created_by === userId || row.owner_employee_id === ctx.employee?.id);
}
export function shapeIntake(row, names = new Map(), { detail = false, canEdit = false } = {}) {
  return { id: row.id, channel: row.channel, biz: row.biz, sourceType: row.source_type, sourceId: row.source_id, emailPending: row.email_pending === true,
    ...(detail ? { name: row.phone_name, contact: row.phone_contact, email: row.phone_email, subject: row.phone_subject, callbackWish: row.callback_wish } : {}),
    receivedAt: row.received_at, receivedBy: row.received_by, ownerEmployeeId: row.owner_employee_id,
    ownerName: names.get(row.owner_employee_id) || "担当者", nextAction: row.next_action, dueAt: row.due_at,
    state: row.state, result: row.result, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, canEdit };
}
