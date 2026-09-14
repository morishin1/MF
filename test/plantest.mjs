import assert from "node:assert/strict";
import { planFromNippo } from "../lib/actions.js";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };
const nippo = { id: "n1", user_id: "u1", work_date: "2026-09-09", tomorrow_plan: "C社見積を出す" };

ok("本人が決めたことは、そのまま「やること」になる", () => {
  const rows = planFromNippo({ nippo, evaluation: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "self");
  assert.equal(rows[0].status, undefined);      // 既定の open
  assert.equal(rows[0].priority, 1);
});

ok("AIが出したものは proposed（採用するまで画面に出ない）", () => {
  const rows = planFromNippo({
    nippo,
    evaluation: { id: "e1", tomorrow_advice: "先方に電話する", improvement_points: ["数字を添える", "先に結論"] },
  });
  const ai = rows.filter((r) => r.source === "ai");
  assert.equal(ai.length, 3);
  for (const r of ai) assert.equal(r.status, "proposed", `${r.title} が proposed でない`);
});

ok("本人ぶんは、AIと混ざっても open のまま", () => {
  const rows = planFromNippo({
    nippo, evaluation: { id: "e1", tomorrow_advice: "先方に電話する", improvement_points: [] },
  });
  assert.equal(rows.find((r) => r.source === "self").status, undefined);
});

ok("改善点は2件まで（並べすぎると全部やらなくなる）", () => {
  const rows = planFromNippo({
    nippo, evaluation: { id: "e1", improvement_points: ["a", "b", "c", "d"] },
  });
  assert.equal(rows.filter((r) => r.source === "ai").length, 2);
});

ok("同じ題は1回だけ", () => {
  const rows = planFromNippo({
    nippo, evaluation: { id: "e1", tomorrow_advice: "C社見積を出す", improvement_points: [] },
  });
  assert.equal(rows.length, 1);
});

console.log(`\n${n} 件 すべて通りました`);
