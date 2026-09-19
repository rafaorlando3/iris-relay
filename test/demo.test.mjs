import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoAPI } from "../public/demo.js";
test("offline walkthrough never claims live verification and rejects unsupported destinations", async () => {
  const api = createDemoAPI();
  const s = await api("/api/session");
  assert.equal(s.demo, true);
  assert.match(s.server, /No IRIS/);
  const p = await api("/api/tasks/preview", "POST", {
    taskId: 1000,
    action: "resume",
  });
  const result = await api("/api/tasks/apply", "POST", { token: p.token });
  assert.equal(result.simulated, true);
  assert.equal(result.verified, false);
  const tasks = await api("/api/resource/tasks");
  assert.equal(tasks.data[0].Suspended, false);
  await assert.rejects(api("/api/tasks/apply", "POST", { token: p.token }));
  await assert.rejects(api("/api/arbitrary"));
});
