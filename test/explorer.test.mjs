import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuery, operations } from "../explorer.mjs";

test("explorer exposes only fixed GET operations and caps result counts", () => {
  assert.ok(Object.keys(operations).length >= 20);
  for (const op of Object.values(operations)) {
    assert.equal(op.method, "GET");
    assert.match(op.path, /^\/v2\//);
  }
  assert.equal(buildQuery("tasks").path, "/v2/tasks?maxRows=100");
  assert.equal(buildQuery("tasks", { maxRows: 5 }).limit, 5);
  for (const maxRows of [0, 101, -1, "NaN", "1.5", null, [], {}])
    assert.throws(() => buildQuery("tasks", { maxRows }), { status: 400 });
});
test("explorer rejects arbitrary destinations, write methods and undeclared parameters", () => {
  for (const id of [
    "__proto__",
    "https://evil.example",
    "../task/delete",
    "constructor",
  ])
    assert.throws(() => buildQuery(id), { status: 400 });
  for (const key of ["url", "method", "Authorization", "redirect"])
    assert.throws(() => buildQuery("tasks", { [key]: "bad" }), { status: 400 });
  assert.throws(() => buildQuery("tasks", []), { status: 400 });
  assert.throws(() => buildQuery("tasks", null), { status: 400 });
});
test("required parameters stay in encoded query values and cannot change the path", () => {
  assert.throws(() => buildQuery("webapp"), { status: 400 });
  assert.throws(() => buildQuery("webapp", { name: "\n" }), { status: 400 });
  const q = buildQuery("webapp", { name: "/api/example?name=x&method=DELETE" });
  const u = new URL("https://iris.example" + q.path);
  assert.equal(u.pathname, "/v2/web-app");
  assert.equal(u.searchParams.size, 1);
  assert.equal(u.searchParams.get("name"), "/api/example?name=x&method=DELETE");
  assert.equal(
    buildQuery("oauthDefinition", { serverId: 1 }).path,
    "/v2/security/oauth2/client/server-definition?serverId=1",
  );
});
