// Locks the sample FieldCam Splunk export so the scored event types stay in the search.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const spl = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/splunk-search.spl"),
  "utf8",
);

function statusClause(event: string): string | undefined {
  const status = spl.slice(spl.indexOf("| eval Status=case("));
  const match = status.match(new RegExp(`Event="${event}", "([^"]+)"`));
  return match?.[1];
}

test("search targets the demo FieldCam index", () => {
  assert.match(spl, /^index=fieldcam_demo/m);
  assert.match(spl, /sourcetype=fieldcam_log/);
  assert.match(spl, /agency="demo"/);
});

test("scored event types are exported", () => {
  for (const eventType of ["recording", "upload", "livestream", "pov_state", "locationtime", "mobile"]) {
    assert.match(spl, new RegExp(`"${eventType}"`));
  }
});

test("recording and livestream starts stay started so only the stop scores", () => {
  assert.equal(statusClause("RecordingStarted"), "started");
  assert.equal(statusClause("LivestreamStarted"), "started");
  assert.equal(statusClause("RecordingStopped"), "success");
  assert.equal(statusClause("LivestreamStopped"), "success");
});
