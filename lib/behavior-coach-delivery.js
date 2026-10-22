// 日報コーチ：Slack への送信アダプタ。既定で無効。実送信は代表の承認と、別の本番承認（設定）がそろったときだけ。
//
// ■ 送り先は3種類（どれも config の値。コードに ID を書かない）
//   ・代表向け報告 … 代表とこの bot の 1:1 DM（gw_coach_config.owner_dm_channel_id。preflight で代表1人との DM と確認したもの）
//   ・チーム向け助言 … 承認済みの日報チャンネル（gw_coach_config.team_channel_id）。個人の情報は入れない（assertTeamSafe）
//   ・本人向け助言 … 照合済みの限定グループ（gw_coach_recipients：代表＋本人＋P）。代表の個別承認の後だけ
//
// ■ 送る条件（全部そろわなければ送らない）
//   1. DB：gw_coach_config.enabled と delivery_enabled が true（既定 false）
//   2. 環境変数：NIPPO_COACH_SEND_ENABLED=1、NIPPO_COACH_SLACK_BOT_TOKEN、NIPPO_COACH_SLACK_TEAM_ID（PR159 の SLACK_AI_* とは別）
//   3. Slack の preflight（slackPreflight）が ok で、その後 Slack の設定が変わっていない
//   4. 代表の承認が、いまの本文・宛先・世代（と本人向けは根拠の版）に一致する（変わっていたら承認は失効）
//   5. 送る前に attempt を DB に記録できた（同時に2回押しても1回だけ）
// ■ 結果が分からないとき（timeout・通信断・Slack のエラー）は delivery_unknown にして、自動では送り直さない。
//   Slack 側で届いたか人が確かめるまで、そのままにする（受信確認の画面は未実装）。
import { randomUUID } from "node:crypto";
import { digest, rpc, readCoachSources, verifiedRoute, requireValue } from "./behavior-coach.js";
import { outboxTarget, assertTeamSafe } from "./behavior-coach-morning.js";

/** 環境変数（PR159 の Slack 秘書とは別の名前。値はコード・文書に書かない） */
export function coachDeliveryEnv(env = process.env) {
  return {
    sendEnabled: env.NIPPO_COACH_SEND_ENABLED === "1",
    token: env.NIPPO_COACH_SLACK_BOT_TOKEN || null,
    teamId: env.NIPPO_COACH_SLACK_TEAM_ID || null,
  };
}

/** PR159 の slackPost と同じ作法（書式なし・展開なし・12秒で打ち切り） */
export async function coachSlackPost({ token, channel, text, fetchImpl = fetch }) {
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text, mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("slack_http_" + response.status);
  const json = await response.json();
  if (!json.ok || !json.ts) throw new Error("slack_" + (json.error || "send_failed"));
  return json;
}

/** Slack の設定のうち、preflight の結果を縛るもの。どれか1つ変われば preflight はやり直し */
export const slackConfigHash = (config) => digest({ team: config?.slack_team_id || null, bot: config?.slack_bot_user_id || null,
  channel: config?.team_channel_id || null, owner: config?.owner_slack_user_id || null, dm: config?.owner_dm_channel_id || null,
  gwOwner: config?.owner_user_id || null });

/** 送れない理由（送れるなら null）。送信の前に、どの経路でも必ず通す */
export function deliveryBlock(config, denv) {
  if (config?.enabled !== true || config?.delivery_enabled !== true) return "coach_delivery_disabled";
  if (!denv?.sendEnabled) return "coach_send_env_off";
  if (!denv.token || !denv.teamId) return "coach_slack_not_configured";
  if (config.slack_team_id !== denv.teamId) return "slack_team_mismatch";
  const pf = config.slack_preflight;
  if (!pf || pf.ok !== true || pf.configHash !== slackConfigHash(config)) return "slack_preflight_required";
  return null;
}

/**
 * 読み取りだけの Slack クライアント（auth.test / conversations.info / users.info）。書き込み系のメソッドは持たない。
 * テストでは偽物を渡す（本物の Slack は呼ばない）。
 */
export function createSlackReadClient({ token, fetchImpl = fetch }) {
  const call = async (method, params = {}) => {
    const q = new URLSearchParams(params).toString();
    const r = await fetchImpl(`https://slack.com/api/${method}${q ? "?" + q : ""}`, { method: "GET", headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error("slack_http_" + r.status);
    return r.json();
  };
  return {
    authTest: () => call("auth.test"),
    conversationsInfo: (channel) => call("conversations.info", { channel }),
    usersInfo: (user) => call("users.info", { user }),
  };
}

/**
 * 送信を有効にする前の確認（読み取りだけ。メッセージは送らない、DM も開かない）。
 *   1. auth.test：workspace（team）が設定と同じ、bot の user ID が設定と同じ
 *   2. 日報チャンネル：bot がメンバー、アーカイブされていない、DM ではない
 *   3. 代表の Slack ユーザー：同じ workspace、削除・bot でない、メールが GW の代表（owner_user_id の社員）と一致
 *   4. 代表 DM：この bot から見える 1:1（is_im）で、相手が代表だけ
 * 1つでも落ちれば ok:false。送信は deliveryBlock で止まったまま。
 * @param {{config:object, client:object, ownerEmail:string|null, now?:()=>Date}} p
 */
export async function slackPreflight({ config, client, ownerEmail, now = () => new Date() }) {
  const checks = [];
  const add = (name, ok, code = null) => { checks.push({ name, ok: !!ok, code: ok ? null : code }); return !!ok; };
  const need = ["slack_team_id", "slack_bot_user_id", "team_channel_id", "owner_slack_user_id", "owner_dm_channel_id", "owner_user_id"];
  const missing = need.filter((k) => !config?.[k]);
  if (add("settings", !missing.length, "slack_settings_missing:" + missing.join(","))) {
    const safe = async (fn) => { try { return await fn(); } catch { return { ok: false, error: "unreachable" }; } };
    const auth = await safe(() => client.authTest());
    add("workspace", auth.ok && auth.team_id === config.slack_team_id, "team_mismatch");
    add("bot_identity", auth.ok && auth.user_id === config.slack_bot_user_id, "bot_mismatch");
    const ch = await safe(() => client.conversationsInfo(config.team_channel_id));
    const c = ch.channel || {};
    add("daily_channel_member", ch.ok && c.id === config.team_channel_id && c.is_member === true && !c.is_archived && !c.is_im, "bot_not_in_channel");
    const u = await safe(() => client.usersInfo(config.owner_slack_user_id));
    const user = u.user || {};
    add("owner_user", u.ok && user.id === config.owner_slack_user_id && user.team_id === config.slack_team_id && !user.deleted && !user.is_bot, "owner_user_invalid");
    const slackEmail = String(user.profile?.email || "").trim().toLowerCase();
    add("owner_gw_mapping", !!slackEmail && !!ownerEmail && slackEmail === String(ownerEmail).trim().toLowerCase(), "owner_mapping_unverified");
    const dm = await safe(() => client.conversationsInfo(config.owner_dm_channel_id));
    const d = dm.channel || {};
    add("owner_dm", dm.ok && d.id === config.owner_dm_channel_id && d.is_im === true && d.user === config.owner_slack_user_id, "dm_not_owner_1to1");
  }
  return { ok: checks.every((x) => x.ok), checks, configHash: slackConfigHash(config), checkedAt: now().toISOString() };
}

/** attempt を記録してから送る。失敗・timeout は unknown（再送しない） */
async function attemptAndSend(sb, { attempt, complete, channel, text, denv, fetchImpl }) {
  const token = randomUUID();
  if (!await rpc(sb, attempt.name, { ...attempt.args, [attempt.tokenArg]: token })) return { status: "not_attempted" };
  try {
    const r = await coachSlackPost({ token: denv.token, channel, text, fetchImpl });
    await rpc(sb, complete, { p_id: attempt.args.p_id, [complete === "gw_coach_outbox_complete" ? "p_token" : "p_claim_token"]: token, p_sent: true, p_message_id: r.ts });
    return { status: "sent" };
  } catch {
    try { await rpc(sb, complete, { p_id: attempt.args.p_id, [complete === "gw_coach_outbox_complete" ? "p_token" : "p_claim_token"]: token, p_sent: false, p_message_id: null }); } catch { /* attempted のまま残る。それも再送しない */ }
    return { status: "delivery_unknown" };
  }
}

/** 代表向け報告・チーム向け助言（gw_coach_outbox の1行）を送る */
export async function deliverOutbox(sb, row, { config, denv, names = [], fetchImpl = fetch }) {
  const blocked = deliveryBlock(config, denv);
  if (blocked) return { status: "blocked", error: blocked };
  requireValue(row && row.state === "approved" && row.approval, "not_approved");
  const target = outboxTarget(row.kind, config);
  requireValue(target && target.teamId === denv.teamId, "recipient_unverified");
  if (target.kind === "owner_dm") requireValue(target.userId === config.owner_slack_user_id, "recipient_changed");
  requireValue(digest(target) === row.target_hash && row.approval.target_hash === row.target_hash, "recipient_changed");
  requireValue(digest(row.body) === row.body_hash && row.approval.body_hash === row.body_hash && Number(row.approval.generation) === Number(row.generation), "draft_changed_or_not_sendable");
  if (row.kind === "team_advice") assertTeamSafe(row.body, names);
  return attemptAndSend(sb, {
    attempt: { name: "gw_coach_outbox_attempt", args: { p_id: row.id, p_generation: row.generation }, tokenArg: "p_token" },
    complete: "gw_coach_outbox_complete",
    channel: target.channelId, text: row.body, denv, fetchImpl,
  });
}

/** 本人向け助言（gw_coach_reviews の1行）を、承認済みの限定グループへ送る */
export async function deliverReview(sb, row, { config, denv, fetchImpl = fetch }) {
  const blocked = deliveryBlock(config, denv);
  if (blocked) return { status: "blocked", error: blocked };
  requireValue(row && row.state === "approved" && row.approval && row.draft, "not_approved");
  requireValue(row.approval.text === row.draft.text && row.approval.draftId === row.draft.id, "draft_changed_or_not_sendable");
  // 送る直前に、根拠（日報・予定・在籍）と宛先全員を読み直す。変わっていれば送らない
  const sources = await readCoachSources(sb, row);
  requireValue(sources.active === true && sources.sourceHash === row.approval.sourceHash, "source_changed");
  const { data: route, error } = await sb.from("gw_coach_recipients").select("*").eq("tenant_id", row.tenant_id).eq("employee_id", row.employee_id).maybeSingle();
  if (error) throw new Error("recipient_unverified");
  const target = verifiedRoute(route, row);
  requireValue(target.teamId === denv.teamId && digest(target) === row.draft.targetHash && digest(row.approval.target) === row.draft.targetHash, "recipient_changed");
  return attemptAndSend(sb, {
    attempt: { name: "gw_coach_attempt", args: { p_id: row.id, p_generation: row.generation }, tokenArg: "p_claim_token" },
    complete: "gw_coach_complete_attempt",
    channel: target.conversationId, text: row.approval.text, denv, fetchImpl,
  });
}
