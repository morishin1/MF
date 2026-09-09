// GET /api/devices/config
//   エージェントが起動時と6時間ごとに読む。
//
// ■ 本人が告知を読むまで collect:false
//   notified_at が null のあいだ、エージェントは何も送らない。
//   就業規則への明記と本人への周知が済んでいない状態で入れても、
//   データは溜まらない。これは建前ではなく、仕組みでそうしてある。
//
// ■ カテゴリ表はここから配る
//   URL→カテゴリの変換は端末の中でやる。サーバに送ってから落とすと、
//   送信経路とログに一度は全文が乗る。だから表のほうを配る。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { requireDevice } from "../../lib/device-auth.js";
import { DEFAULT_SITES } from "../../lib/devices.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const dev = await requireDevice(req, res);
  if (!dev) return;

  const sb = admin();

  if (!dev.notified_at || dev.status !== "active") {
    // 止まっている理由まで返す。エージェントのログを読む人が分かるように
    return json(res, 200, {
      collect: false,
      reason: dev.status !== "active" ? "suspended" : "not_notified",
      message: dev.status !== "active"
        ? "この端末は停止中です"
        : "使う方が告知を確認するまで、記録は取りません",
      recheckSec: 3600,
    });
  }

  const { data: p } = await sb
    .from("gw_device_policies")
    .select("blocked_software, site_categories, night_from, night_to, idle_after_min, "
          + "send_interval_sec, usb_alert, night_alert")
    .eq("tenant_id", dev.tenant_id)
    .maybeSingle();

  // ポリシーの行がまだ無くても動く。既定値で回す
  return json(res, 200, {
    collect: true,
    sendIntervalSec: p?.send_interval_sec ?? 300,
    idleAfterMin: p?.idle_after_min ?? 5,
    nightFrom: p?.night_from ?? "22:00",
    nightTo: p?.night_to ?? "05:00",
    // 端末側で URL をこれに当てて、カテゴリだけ送る
    siteCategories: { ...DEFAULT_SITES, ...(p?.site_categories || {}) },
    // 判定はサーバでやる。端末に渡すのは、送るものを決めるためだけ
    watchInstalls: true,
    watchUsb: p?.usb_alert !== false,
    // 取ってはいけないもの。エージェント側の実装でも二重に止める
    never: ["keystrokes", "clipboard", "screenshots", "window_titles", "full_urls", "file_contents"],
    recheckSec: 6 * 3600,
  });
}
