export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
export function rows(data) {
  return Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? Object.entries(data).map(([Property, Value]) => ({ Property, Value }))
      : [{ Value: data }];
}
export function changesBetween(before, after) {
  const a = rows(before),
    b = rows(after);
  const key = ["Id", "Name", "name", "Pid", "Property"].find(
    (k) =>
      [...a, ...b].length &&
      [...a, ...b].every((r) => r && r[k] !== undefined) &&
      new Set(a.map((r) => r[k])).size === a.length &&
      new Set(b.map((r) => r[k])).size === b.length,
  );
  if (!key)
    return JSON.stringify(stable(a)) === JSON.stringify(stable(b))
      ? []
      : [{ id: "Response", kind: "changed", before: a, after: b }];
  const prior = new Map(a.map((r) => [String(r[key]), r])),
    next = new Map(b.map((r) => [String(r[key]), r]));
  return [...new Set([...prior.keys(), ...next.keys()])].flatMap((id) => {
    const before = prior.get(id),
      after = next.get(id);
    if (JSON.stringify(stable(before)) === JSON.stringify(stable(after)))
      return [];
    return [
      {
        id,
        kind: !prior.has(id) ? "added" : !next.has(id) ? "removed" : "changed",
        before: before ?? null,
        after: after ?? null,
      },
    ];
  });
}
function block(value) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const longest = Math.max(
    2,
    ...Array.from(text.matchAll(/`+/g), (m) => m[0].length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}
export function handoverMarkdown(bundle) {
  const { observation, baseline, notes } = bundle;
  const changes = baseline
    ? changesBetween(baseline.data, observation.data)
    : null;
  const lines = [
    "# IRIS Relay handover",
    "",
    `Observed: ${observation.observedAt}`,
    `Exported: ${bundle.exportedAt}`,
    `Section: ${bundle.resource}`,
    `IRIS: ${bundle.serverVersion}`,
    "",
    `Records in response: ${rows(observation.data).length}`,
    observation.limit
      ? `Response limit: ${observation.limit} rows. This is not a complete inventory.`
      : "Scope: returned response only.",
    "",
    "## Operator notes",
    "",
    notes ? block(notes) : "No notes supplied.",
    "",
    "## Changes since baseline",
    "",
    baseline ? `Baseline: ${baseline.observedAt}` : "No baseline captured.",
  ];
  if (changes)
    lines.push(
      "",
      `${changes.length} changed record(s) in the returned responses. Removed means absent from the response, not proof of deletion.`,
      ...changes.flatMap((c) => ["", block(c)]),
    );
  lines.push(
    "",
    "## Session changes (last 100 accepted operations)",
    "",
    block(bundle.activity || []),
    "",
    "## Current observation",
    "",
    block(observation),
    "",
    "## Handling",
    "",
    bundle.note,
  );
  return lines.join("\n");
}
