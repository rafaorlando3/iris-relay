import { test } from "node:test";
import assert from "node:assert/strict";
import { auditParameters, asyncId, startAudit, readAudit } from "../audit.mjs";
const validLocation = "/api/admin/v1/async-result?id=12345";
test("audit query bounds and calendar dates are validated", () => {
  assert.equal(auditParameters({ maxRows: 10 }).limit, 10);
  for (const input of [
    { maxRows: 101 },
    { maxRows: 0 },
    { maxRows: "10" },
    { begin: "2026-02-30 00:00:00" },
    { begin: "2026-09-19 12:00:00", end: "2026-09-18 12:00:00" },
    { url: "https://example.com" },
  ])
    assert.throws(() => auditParameters(input), { status: 400 });
  const u = new URL(
    auditParameters({ username: "example&maxRows=999" }).path,
    "https://local.invalid",
  );
  assert.equal(u.searchParams.get("maxRows"), "100");
  assert.equal(u.searchParams.get("usernames"), "example&maxRows=999");
});
test("async reference never acts as an arbitrary URL or path", () => {
  assert.equal(asyncId(validLocation), "12345");
  for (const location of [
    "https://evil.test/api/admin/v1/async-result?id=1",
    "//evil.test/api/admin/v1/async-result?id=1",
    "/api/admin/v2/task/delete?id=1",
    validLocation + "&url=x",
    "/api/admin/v1/async-result?id=abc",
    null,
  ])
    assert.throws(() => asyncId(location), { status: 502 });
});
test("queued results stay incomplete, final summaries exclude event payload and identifiers", async () => {
  const session = { credentials: {} };
  let state = "Running";
  let posts = 0;
  const upstream = async (c, path, method) => {
    if (method === "POST") {
      posts++;
      return { ok: true, status: 202, location: validLocation, data: {} };
    }
    assert.equal(path, "/v2/async-result?id=12345");
    return {
      ok: true,
      data: {
        TaskName: "POST /v2/security/audit/records",
        State: state,
        Result: [
          {
            AuditIndex: 1,
            Event: "Login",
            EventData: "private",
            SessionID: "secret",
            ClientIPAddress: "private",
          },
        ],
      },
    };
  };
  const initial = await startAudit(session, { maxRows: 10 }, upstream);
  assert.equal(initial.complete, false);
  assert.equal(initial.data, undefined);
  const pending = await readAudit(session, initial.id, upstream);
  assert.equal(pending.complete, false);
  assert.equal(pending.data, undefined);
  const reused = await startAudit(session, {}, upstream);
  assert.equal(reused.reused, true);
  assert.equal(posts, 1);
  await assert.rejects(readAudit({ credentials: {} }, initial.id, upstream), {
    status: 404,
  });
  state = "Finished";
  const result = await readAudit(session, initial.id, upstream);
  assert.equal(result.complete, true);
  assert.deepEqual(result.data, [{ AuditIndex: 1, Event: "Login" }]);
});
test("failed audit and wrong task identity never masquerade as empty successful logs", async () => {
  const session = {
    credentials: {},
    auditJob: { id: "opaque", irisId: "1", limit: 100 },
  };
  const result = await readAudit(session, "opaque", async () => ({
    ok: true,
    data: {
      TaskName: "POST /v2/security/audit/records",
      State: "Failed",
      FailureReason: "internal secret",
    },
  }));
  assert.equal(result.complete, false);
  assert.equal(result.data, undefined);
  assert.doesNotMatch(result.error, /internal secret/);
  await assert.rejects(
    readAudit(session, "opaque", async () => ({
      ok: true,
      data: { TaskName: "POST /v2/task/delete", State: "Finished", Result: [] },
    })),
    { status: 502 },
  );
});
test("concurrent starts create only one IRIS job and denied requests retain no fake result", async () => {
  const session = { credentials: {} };
  let release;
  const wait = new Promise((r) => (release = r));
  const first = startAudit(session, {}, async () => {
    await wait;
    return { ok: true, status: 202, location: validLocation };
  });
  await assert.rejects(
    startAudit(session, {}, async () => {
      throw Error("must not run");
    }),
    { status: 409 },
  );
  release();
  await first;
  const denied = { credentials: {} };
  await assert.rejects(
    startAudit(denied, {}, async () => ({
      ok: false,
      status: 403,
      error: "Denied",
    })),
    { status: 403 },
  );
  assert.equal(denied.auditJob, undefined);
  assert.equal(denied.auditStarting, false);
});
