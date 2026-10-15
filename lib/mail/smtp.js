// Xserver等のSMTPサーバーからメールを送る部品。
// lib/mail/index.js から MAIL_PROVIDER=smtp のときだけ呼ばれる。
// 外部ライブラリは使わず、Node.js の TLS ソケットで SMTPS(465) + AUTH LOGIN を行う。
//
// 環境変数:
//   SMTP_HOST      例: svXXXX.xserver.jp（Xserverの「サーバー情報 / メールソフト設定」に表示されるホスト名）
//   SMTP_PORT      省略時 465
//   SMTP_SECURE    "1" のみ対応（SMTPS / implicit TLS）
//   SMTP_USER      例: support_eigyo@8grp.co.jp
//   SMTP_PASS      メールアカウントのパスワード
//
// 587/STARTTLS は意図的に未対応。Xserverでは465を使い、Vercel→SMTPを常時TLSにする。
import tls from "node:tls";
import crypto from "node:crypto";

export const name = "smtp";
const TIMEOUT_MS = 15000;

const clean = (v) => String(v ?? "").trim();
const b64 = (v) => Buffer.from(String(v), "utf8").toString("base64");
const headerB64 = (v) => `=?UTF-8?B?${Buffer.from(String(v), "utf8").toString("base64")}?=`;
const wrap76 = (s) => String(s).match(/.{1,76}/g)?.join("\r\n") || "";
const crlf = (s) => String(s ?? "").replace(/\r?\n/g, "\r\n");
const addressOf = (from) => {
  const s = clean(from);
  const m = s.match(/<([^<>]+)>\s*$/);
  return clean(m ? m[1] : s);
};

export function config(env = process.env) {
  const host = clean(env.SMTP_HOST);
  const portRaw = clean(env.SMTP_PORT) || "465";
  const port = Number(portRaw);
  const secure = clean(env.SMTP_SECURE || "1") === "1";
  const user = clean(env.SMTP_USER);
  const pass = String(env.SMTP_PASS || "");
  return { host, port, secure, user, pass };
}

export function ready(env = process.env) {
  const c = config(env);
  if (!c.host) return { ok:false, reason:"SMTP_HOST が設定されていません" };
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return { ok:false, reason:"SMTP_PORT の値が正しくありません" };
  if (!c.secure) return { ok:false, reason:"SMTP_SECURE=1 にしてください（465/TLSで送信します）" };
  if (!c.user) return { ok:false, reason:"SMTP_USER が設定されていません" };
  if (!c.pass) return { ok:false, reason:"SMTP_PASS が設定されていません" };
  return { ok:true };
}

function encodeFrom(from) {
  const s = clean(from);
  const m = s.match(/^(.+?)\s*<([^<>]+)>$/);
  if (!m) return `<${s}>`;
  const label = clean(m[1]).replace(/^["']|["']$/g, "");
  return `${headerB64(label)} <${clean(m[2])}>`;
}

export function buildMessage(m, { messageId } = {}) {
  const id = messageId || `<${crypto.randomUUID()}@eight-mail.local>`;
  const subject = headerB64(m.subject);
  const headers = [
    `From: ${encodeFrom(m.from)}`,
    `To: <${clean(m.to)}>`,
    `Subject: ${subject}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    "Date: " + new Date().toUTCString(),
  ];
  if (m.replyTo) headers.push(`Reply-To: <${clean(m.replyTo)}>`);

  const attachments = Array.isArray(m.attachments) ? m.attachments : [];
  if (!attachments.length) {
    headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
    const text64 = wrap76(Buffer.from(crlf(m.text), "utf8").toString("base64"));
    return { raw: headers.join("\r\n") + "\r\n\r\n" + text64, messageId:id };
  }

  const boundary = `eight-${crypto.randomBytes(12).toString("hex")}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(crlf(m.text), "utf8").toString("base64"))}`,
  ];
  for (const a of attachments) {
    const safeName = String(a.filename).replace(/["\r\n]/g, "_");
    const filename = headerB64(safeName);
    parts.push(
      `--${boundary}\r\nContent-Type: ${a.contentType}; name="${filename}"\r\n` +
      `Content-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      wrap76(Buffer.from(a.content).toString("base64"))
    );
  }
  parts.push(`--${boundary}--`);
  return { raw: headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n"), messageId:id };
}

function smtpError(step, r) {
  const safe = String(r?.text || "").replace(/[\r\n]+/g, " ").slice(0, 220);
  return new Error(`SMTP ${step} で失敗しました（${r?.code || "応答なし"}）${safe ? `: ${safe}` : ""}`);
}

function reader(socket) {
  let buf = "", cur = null, waiters = [], pending = [];
  const deliver = (r) => {
    const w = waiters.shift();
    if (w) w.resolve(r); else pending.push(r);
  };
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) {
      const m = line.match(/^(\d{3})([ -])(.*)$/);
      if (!m) continue;
      if (!cur) cur = { code:Number(m[1]), lines:[] };
      cur.lines.push(m[3]);
      if (m[2] === " ") {
        cur.text = cur.lines.join(" ");
        deliver(cur);
        cur = null;
      }
    }
  });
  socket.on("error", (e) => {
    while (waiters.length) waiters.shift().reject(e);
  });
  return () => pending.length
    ? Promise.resolve(pending.shift())
    : new Promise((resolve,reject)=>waiters.push({resolve,reject}));
}

async function smtpExchange({ host, port, user, pass }, m) {
  const socket = tls.connect({ host, port, servername:host, rejectUnauthorized:true });
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error("SMTPサーバーの応答がありませんでした（時間切れ）")));
  const next = reader(socket);
  const sendCmd = async (line, expect, label) => {
    socket.write(line + "\r\n");
    const r = await next();
    if (!expect.includes(r.code)) throw smtpError(label, r);
    return r;
  };
  try {
    const greet = await next();
    if (greet.code !== 220) throw smtpError("接続", greet);
    await sendCmd("EHLO gw.8grp.co.jp", [250], "EHLO");
    await sendCmd("AUTH LOGIN", [334], "AUTH");
    await sendCmd(b64(user), [334], "ユーザー認証");
    await sendCmd(b64(pass), [235], "パスワード認証");

    const envelopeFrom = addressOf(m.from);
    await sendCmd(`MAIL FROM:<${envelopeFrom}>`, [250], "MAIL FROM");
    await sendCmd(`RCPT TO:<${clean(m.to)}>`, [250,251], "RCPT TO");
    await sendCmd("DATA", [354], "DATA");

    const built = buildMessage(m);
    const payload = crlf(built.raw)
      .split("\r\n").map((line)=>line.startsWith(".") ? "."+line : line).join("\r\n");
    socket.write(payload + "\r\n.\r\n");
    const accepted = await next();
    if (accepted.code !== 250) throw smtpError("本文送信", accepted);
    try { await sendCmd("QUIT", [221], "QUIT"); } catch { /* 送信は250で確定済み。QUIT失敗で二重送信しない */ }
    const queue = accepted.text.match(/(?:queued as|id[= :]*)\s*([A-Za-z0-9._-]+)/i)?.[1] || null;
    return { id: queue || built.messageId.replace(/[<>]/g,"") };
  } finally {
    socket.end();
    socket.destroy();
  }
}

/**
 * lib/mail/index.js から呼ぶ。
 * テストでは smtpSendImpl を差し込めるが、本番では常に smtpExchange を使う。
 */
export async function send(m, { env = process.env, smtpSendImpl } = {}) {
  const c = config(env);
  const r = ready(env);
  if (!r.ok) throw new Error(r.reason);
  const impl = smtpSendImpl || smtpExchange;
  return impl(c, m);
}
