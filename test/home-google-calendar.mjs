import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const calendar = readFileSync(new URL("../calendar.html", import.meta.url), "utf8");
const schedule = readFileSync(new URL("../api/schedule/index.js", import.meta.url), "utf8");
const home = readFileSync(new URL("../home.html", import.meta.url), "utf8");

assert.match(calendar, /d\.external\?\.events\|\|\[\]/, "Google personal events are read from authenticated own schedule API");
assert.match(calendar, /const syncedIds=new Set/, "Avoid duplicate Google events already pushed from GW");
assert.match(calendar, /!syncedIds\.has\(String\(e\.id\)\)/, "Google ID de-duplication");
assert.match(calendar, /source:"google",category:"google"/, "Google events have separate read-only source");
assert.match(calendar, /own:e\.source==="self"/, "Only GW self-created events have edit permission");
assert.match(calendar, /copyable:e\.source==="self"&&/, "Google events cannot be duplicated as GW events");
assert.match(calendar, /el\("cal-google-shortcut"\)\.hidden=scope!=="mine"/, "Hide personal Google settings in team view");
assert.match(calendar, /href="\/schedule\.html#gcal"/, "Google consent configuration page remains reachable");
assert.match(calendar, /el\("cal-google-state"\)\.textContent=/, "Connected/missing/error state is visible");
assert.match(schedule, /fetchExternalEvents\(ctx\.employee\.id/, "Google events fetched for authenticated employee only");
assert.match(home, /calendar\.html\?embed=home/, "Home embeds this calendar");

assert.match(home, /calendar\.html\?embed=home&amp;scope=team&amp;view=week/, "Home opens the embedded calendar with all members and one week");
assert.match(calendar, /view=isHomeEmbed&&calendarParams\.get\("view"\)==="week"\?"week":"month"/, "Week is the default only when home explicitly requests it");
assert.match(calendar, /scope=isHomeEmbed&&calendarParams\.get\("scope"\)==="team"\?"team":"mine"/, "Team view is the default only when home explicitly requests it");
assert.match(calendar, /初回データ取得より先に、ホーム指定の「全員・週」をボタンへ反映する。\n  header\(\);/, "Selected controls reflect the home defaults immediately");

assert.match(home, /Math\.min\(h,2600\)/, "Long multi-member weeks get a usable iframe height instead of staying at 720px");
console.log("PASS: home calendar defaults to team/week; Google events remain private and read-only");
