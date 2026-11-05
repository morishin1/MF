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
console.log("PASS: home Google events are own-only, read-only, deduplicated and link to consent setup");
