// GET /api/devices/manifest
//   エージェントが6時間ごとに読む。新しい版があれば自分で入れ替える。
//
// 配布物はまだ無いので、今は「今の版のままでよい」とだけ返す。
// ここを先に用意しておくのは、後から自動更新を足すときに
// 全台へ手で入れ直すことにならないようにするため。
//
// 置き換えるときは Vercel の環境変数だけで切り替えられるようにしてある。
//   DEVICE_AGENT_VERSION / DEVICE_AGENT_URL / DEVICE_AGENT_SHA256

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireDevice } from "../../lib/device-auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const dev = await requireDevice(req, res);
  if (!dev) return;

  const version = process.env.DEVICE_AGENT_VERSION || null;
  const url = process.env.DEVICE_AGENT_URL || null;
  const sha256 = process.env.DEVICE_AGENT_SHA256 || null;

  // 3つそろっていなければ更新させない。
  // 検証できない配布物を落として実行させるほうが危ない
  const ready = Boolean(version && url && sha256);

  return json(res, 200, {
    update: ready && version !== dev.agent_version,
    version, url, sha256,
    recheckSec: 6 * 3600,
  });
}
