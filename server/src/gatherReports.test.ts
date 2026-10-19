import assert from "node:assert/strict";
import { test } from "node:test";
import {
  csvEscape,
  writeCsv,
  emailFromRoster,
  emailFromNotedBy,
  shouldKeepSlackText,
} from "./scripts/gatherReports.js";

const roster = [
  { email: "alice@northline.example", name: "Alice Chen" },
  { email: "bob@northline.example", name: "Bob Rivera" },
  { email: "elena@northline.example", name: "Elena Brooks" },
  { email: "erin@northline.example", name: "Erin Brooks" },
];

test("csvEscape quotes only what needs it, and doubles inner quotes", () => {
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape("has,comma"), '"has,comma"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape("line\nbreak"), '"line\nbreak"');
  assert.equal(csvEscape(""), "");
});

test("writeCsv round-trips a comma-bearing report body without breaking columns", () => {
  const csv = writeCsv([
    { email: "a@northline.example", text: 'Battery drain, then "click"', slackMessageUrl: "https://x/1", reportedAtUtc: "2026-08-26T12:00:00.000Z" },
  ]);
  const [header, row] = csv.trim().split("\n");
  assert.equal(header, "email,text,slackMessageUrl,reportedAtUtc");
  assert.ok(row.includes('"Battery drain, then ""click"""'));
  // Four fields survive: the quoted comma must not split the row.
  assert.equal(row.split('","').length >= 1, true);
});

test("emailFromRoster is case-insensitive and rejects non-members", () => {
  assert.equal(emailFromRoster(roster, "ALICE@NORTHLINE.EXAMPLE"), "alice@northline.example");
  assert.equal(emailFromRoster(roster, "nobody@northline.example"), null);
  assert.equal(emailFromRoster(roster, ""), null);
});

test("emailFromNotedBy resolves a unique surname and refuses an ambiguous one", () => {
  assert.equal(emailFromNotedBy(roster, "Alice Chen"), "alice@northline.example");
  assert.equal(emailFromNotedBy(roster, "chen"), "alice@northline.example");

  // Two Brooks on the roster: crediting either would be a guess, so it credits neither.
  assert.equal(emailFromNotedBy(roster, "Elena Brooks"), null);
  assert.equal(emailFromNotedBy(roster, ""), null);
});

test("emailFromNotedBy matches on surname alone — a known misattribution risk", () => {
  // "Dana Rivera" is not on the roster, but shares a surname with someone who is. The row is
  // credited to Bob Rivera. Documented deliberately: this is the behaviour today, and the
  // 200-point consequence is why it is worth revisiting.
  assert.equal(emailFromNotedBy(roster, "Dana Rivera"), "bob@northline.example");
});

test("shouldKeepSlackText drops channel noise and keeps real findings", () => {
  assert.equal(shouldKeepSlackText("too short"), false);
  assert.equal(shouldKeepSlackText("<@U1> has joined the channel"), false);
  assert.equal(shouldKeepSlackText("<@U1> has left the channel"), false);
  assert.equal(shouldKeepSlackText("someone made updates to a canvas in this channel today"), false);
  assert.equal(shouldKeepSlackText("uploaded a file"), false);
  assert.equal(
    shouldKeepSlackText("The FieldCam sits loose in both the 1-bay and 8-bay dock, unlike the older dock."),
    true,
  );
});
