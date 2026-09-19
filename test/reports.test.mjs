import { test } from "node:test";
import assert from "node:assert/strict";
import { changesBetween, handoverMarkdown } from "../public/reports.js";
test("snapshot comparison tolerates ordering and identifies actual field changes", () => {
  const before = [
    { Id: 1, Name: "a", Suspended: false },
    { Id: 2, Name: "b" },
  ];
  assert.deepEqual(
    changesBetween(before, [
      { Name: "b", Id: 2 },
      { Suspended: false, Name: "a", Id: 1 },
    ]),
    [],
  );
  const changes = changesBetween(before, [
    { Id: 1, Name: "a", Suspended: true },
  ]);
  assert.deepEqual(
    changes.map((c) => c.kind),
    ["changed", "removed"],
  );
});
test("duplicate identities do not silently collapse records", () => {
  const changes = changesBetween(
    [
      { Id: 1, Name: "same" },
      { Id: 1, Name: "same" },
    ],
    [{ Id: 1, Name: "same" }],
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].id, "Response");
});
test("handover documents scope and keeps untrusted text inside a code fence", () => {
  const text = handoverMarkdown({
    resource: "tasks",
    serverVersion: "2026.2",
    exportedAt: "now",
    notes: "```\n<script>bad</script>\n```",
    note: "Review before sharing.",
    observation: { observedAt: "before", limit: 100, data: [] },
  });
  assert.match(text, /not a complete inventory/);
  assert.match(text, /No baseline captured/);
  assert.match(text, /````\n```/);
});
