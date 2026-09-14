// 画面写真の置き場所。
//
// 落ちたときに何が出ていたのかを見るためのもので、判定には使わない。
// 作業用の一時領域を指したままだと、CI では
// 「そんなフォルダはありません」でテストごと落ちる。
// 実際にそれで5本落ちた（手元にはフォルダがあるので気づけない）
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(process.env.RUNNER_TEMP || tmpdir(), "eight-shots");
try { mkdirSync(DIR, { recursive: true }); } catch { /* あっても困らない */ }

export const shotPath = (name) => join(DIR, name);
