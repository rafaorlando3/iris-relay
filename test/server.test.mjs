import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
import { redact } from "../resources.mjs";

let nextPort = 18787;
async function setup(t, fetcher) {
  const port = nextPort++,
    url = "http://127.0.0.1:" + port;
  const server = createApp({ origin: url, fetcher });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return {
    url,
    login: () =>
      fetch(url + "/api/login", {
        method: "POST",
        headers: { Origin: url, "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "tester",
          password: "test-only-password",
        }),
      }),
  };
}
const ok = (data) =>
  new Response(JSON.stringify({ status: { errors: [] }, result: data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("private resources require login and do not contact IRIS", async (t) => {
  let called = 0;
  const { url } = await setup(t, async () => {
    called++;
    return ok({});
  });
  const r = await fetch(url + "/api/resource/tasks");
  assert.equal(r.status, 401);
  assert.equal(called, 0);
});
test("cross-origin sign-in is rejected before touching credentials", async (t) => {
  let called = 0;
  const { url } = await setup(t, async () => {
    called++;
    return ok({});
  });
  const r = await fetch(url + "/api/login", {
    method: "POST",
    headers: {
      Origin: "https://untrusted.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
  assert.equal(called, 0);
});
test("old API version cannot become a misleading connected session", async (t) => {
  const { login } = await setup(t, async (u) =>
    u.pathname.endsWith("/info")
      ? ok({ apiVersion: 1 })
      : new Response("", { status: 404 }),
  );
  const r = await login();
  assert.equal(r.status, 409);
  assert.equal(r.headers.get("set-cookie"), null);
});
test("permissions and unreachable data are not reported as empty arrays", async (t) => {
  const { url, login } = await setup(t, async (u) =>
    u.pathname.endsWith("/info")
      ? ok({ apiVersion: 2 })
      : new Response("", { status: 403 }),
  );
  const r = await login();
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const denied = await fetch(url + "/api/resource/roles", {
    headers: { Cookie: cookie },
  });
  assert.equal(denied.status, 403);
  const v = await denied.json();
  assert.equal(v.ok, false);
  assert.equal(v.data, undefined);
});
test("allowlist prevents arbitrary paths; logout invalidates session and requires CSRF", async (t) => {
  const { url, login } = await setup(t, async () => ok({ apiVersion: 2 }));
  const r = await login();
  const { csrf } = await r.json(),
    cookie = r.headers.get("set-cookie").split(";")[0];
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  const unknown = await fetch(url + "/api/resource/__proto__", {
    headers: { Cookie: cookie },
  });
  assert.equal(unknown.status, 404);
  const headers = {
    Cookie: cookie,
    Origin: url,
    "Content-Type": "application/json",
  };
  assert.equal(
    (await fetch(url + "/api/logout", { method: "POST", headers, body: "{}" }))
      .status,
    403,
  );
  assert.equal(
    (
      await fetch(url + "/api/logout", {
        method: "POST",
        headers: { ...headers, "X-Relay-CSRF": csrf },
        body: "{}",
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(url + "/api/session", { headers: { Cookie: cookie } })).status,
    401,
  );
});
test("nested credential fields are removed from browser and exports", () => {
  assert.deepEqual(redact({ HasPrivateKey: false }), { HasPrivateKey: false });
  assert.deepEqual(redact({ HasPrivateKey: "sensitive" }), {
    HasPrivateKey: "[REDACTED]",
  });
  assert.deepEqual(
    redact({
      Name: "entry",
      items: [
        {
          password: "secret",
          access_token: "token",
          PrivateKey: "key",
          Name: "normal",
        },
      ],
    }),
    {
      Name: "entry",
      items: [
        {
          password: "[REDACTED]",
          access_token: "[REDACTED]",
          PrivateKey: "[REDACTED]",
          Name: "normal",
        },
      ],
    },
  );
});
test("IRIS status errors inside HTTP 200 fail visibly", async (t) => {
  const { login } = await setup(
    t,
    async () =>
      new Response(
        JSON.stringify({ status: { errors: ["sensitive upstream error"] } }),
        { status: 200 },
      ),
  );
  const r = await login();
  assert.equal(r.status, 502);
  assert.doesNotMatch(await r.text(), /sensitive upstream/);
});
test("redirecting and unreachable upstream produces explicit failure", async (t) => {
  const { login } = await setup(t, async () => {
    throw new Error("connection refused");
  });
  const r = await login();
  assert.equal(r.status, 503);
});

test("task changes use authoritative detail, reject replay and protect system tasks", async (t) => {
  let suspended = false,
    writes = 0;
  const fake = async (u, options) => {
    if (u.pathname.endsWith("/info") && !u.pathname.includes("/task/"))
      return ok({ apiVersion: 2 });
    if (u.pathname.endsWith("/tasks"))
      return ok([
        { Id: 1, Name: "System", Type: "System", Suspended: false },
        { Id: 1000, Name: "Smoke", Type: "User", Suspended: false },
      ]);
    if (u.pathname.endsWith("/task/info"))
      return ok({ Type: "User", Suspended: suspended });
    if (options.method === "POST") {
      writes++;
      suspended = true;
      return ok({});
    }
    return new Response("", { status: 404 });
  };
  const { url, login } = await setup(t, fake),
    l = await login(),
    cookie = l.headers.get("set-cookie").split(";")[0],
    { csrf } = await l.json();
  const send = (path, data) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: url,
        "Content-Type": "application/json",
        "X-Relay-CSRF": csrf,
      },
      body: JSON.stringify(data),
    });
  assert.equal(
    (await send("/api/tasks/preview", { taskId: 1, action: "suspend" })).status,
    403,
  );
  const p = await send("/api/tasks/preview", {
    taskId: 1000,
    action: "suspend",
  });
  assert.equal(p.status, 200);
  const plan = await p.json();
  assert.equal(writes, 0);
  const a = await send("/api/tasks/apply", { token: plan.token });
  assert.equal((await a.json()).verified, true);
  assert.equal(writes, 1);
  assert.equal(
    (await send("/api/tasks/apply", { token: plan.token })).status,
    409,
  );
  assert.equal(writes, 1);
  const r = await fetch(url + "/api/resource/tasks", {
    headers: { Cookie: cookie },
  });
  assert.equal((await r.json()).data[1].Suspended, true);
});

test("preview cannot overwrite a task changed by another operator", async (t) => {
  let suspended = false,
    writes = 0;
  const { url, login } = await setup(t, async (u, options) => {
    if (options.method === "POST") writes++;
    if (u.pathname.endsWith("/tasks"))
      return ok([{ Id: 1000, Name: "Smoke", Type: "User", Suspended: false }]);
    if (u.pathname.endsWith("/task/info")) return ok({ Suspended: suspended });
    return ok({ apiVersion: 2 });
  });
  const l = await login(),
    cookie = l.headers.get("set-cookie").split(";")[0],
    { csrf } = await l.json();
  const send = (path, data) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: url,
        "Content-Type": "application/json",
        "X-Relay-CSRF": csrf,
      },
      body: JSON.stringify(data),
    });
  const p = await send("/api/tasks/preview", {
      taskId: 1000,
      action: "suspend",
    }),
    plan = await p.json();
  suspended = true;
  assert.equal(
    (await send("/api/tasks/apply", { token: plan.token })).status,
    409,
  );
  assert.equal(writes, 0);
});

test("archived log IDs are forwarded as IDs; paths and other names are refused", async (t) => {
  const seen = [];
  const { url, login } = await setup(t, async (u) => {
    if (u.pathname.startsWith("/api/relay/")) {
      seen.push(u.pathname + u.search);
      return new Response(
        JSON.stringify({
          source: "messages.old_20260928_1",
          observedAt: "2026-09-28T15:40:00Z",
          rows: [{ Message: "archived line" }],
          nextCursor: null,
        }),
        { status: 200 },
      );
    }
    return ok({ apiVersion: 2 });
  });
  const l = await login(),
    cookie = l.headers.get("set-cookie").split(";")[0];
  const get = (q) =>
    fetch(url + "/api/logs/page?" + q, { headers: { Cookie: cookie } });
  const good = await get("source=runtime.old_20260928_1");
  assert.equal(good.status, 200);
  assert.equal((await good.json()).data[0].Message, "archived line");
  assert.match(seen.at(-1), /source=runtime\.old_20260928_1/);
  const before = seen.length;
  for (const bad of [
    "runtime.old_../x",
    "runtime.old_a%2Fb",
    "runtime.old_",
    "alerts.old_20260928",
    "messages.old_20260928",
    "runtime.old_" + "a".repeat(49),
    "runtime.old_a.gz",
  ]) {
    const r = await get("source=" + bad);
    assert.equal(r.status, 400, bad);
  }
  assert.equal(seen.length, before);
});

test("log similarity search validates input, forwards IDs only, and index refresh needs the CSRF token", async (t) => {
  const seen = [];
  const { url, login } = await setup(t, async (u, options) => {
    if (u.pathname.startsWith("/api/relay/")) {
      seen.push(options.method + " " + u.pathname + u.search);
      if (u.pathname.endsWith("/log-index"))
        return new Response(JSON.stringify({ indexedLines: 3, totalLines: 3, files: 1, unchangedFiles: 0, problems: [] }), { status: 200 });
      if (u.searchParams.get("q") === "empty index")
        return new Response(JSON.stringify({ error: "The log index is empty. Refresh the index first." }), { status: 200 });
      return new Response(JSON.stringify({ query: u.searchParams.get("q"), candidates: 200, rows: [{ Score: 0.5, Message: "License limit exceeded", Occurrences: 3, Files: ["messages.old_20260927"] }] }), { status: 200 });
    }
    return ok({ apiVersion: 2 });
  });
  const l = await login(),
    cookie = l.headers.get("set-cookie").split(";")[0],
    { csrf } = await l.json();
  const get = (q) => fetch(url + "/api/logs/search?" + q, { headers: { Cookie: cookie } });
  const good = await get("q=" + encodeURIComponent("licence limit") + "&limit=5");
  assert.equal(good.status, 200);
  assert.equal((await good.json()).rows[0].Occurrences, 3);
  assert.match(seen.at(-1), /^GET \/api\/relay\/log-search\?q=licence\+limit&limit=5$/);
  const before = seen.length;
  for (const bad of ["q=", "q=" + "x".repeat(201), "q=a&limit=0", "q=a&limit=51", "q=a&limit=2.5"])
    assert.equal((await get(bad)).status, 400, bad);
  assert.equal(seen.length, before);
  assert.equal((await get("q=empty+index")).status, 409);
  const post = (headers) =>
    fetch(url + "/api/logs/index", {
      method: "POST",
      headers: { Cookie: cookie, Origin: url, "Content-Type": "application/json", ...headers },
      body: "{}",
    });
  assert.equal((await post({})).status, 403);
  assert.equal(seen.filter((s) => s.startsWith("POST")).length, 0);
  const indexed = await post({ "X-Relay-CSRF": csrf });
  assert.equal(indexed.status, 200);
  assert.equal((await indexed.json()).totalLines, 3);
  assert.equal(seen.filter((s) => s === "POST /api/relay/log-index").length, 1);
});

async function demoSetup(t, fetcher, extra = {}) {
  const port = nextPort++,
    url = "http://127.0.0.1:" + port;
  const server = createApp({
    origin: url,
    fetcher,
    demo: { username: "RelayDemoOperator", password: "public-demo", resetMinutes: 60 },
    ...extra,
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const login = (username = "RelayDemoOperator", headers = {}) =>
    fetch(url + "/api/login", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ username, password: "public-demo" }),
    });
  return { url, login };
}

test("public demo: config is public, only the demo account signs in, only demo objects change", async (t) => {
  const calls = [];
  const { url, login } = await demoSetup(t, async (u, options) => {
    calls.push((options.method || "GET") + " " + u.pathname + u.search);
    if (u.pathname.endsWith("/v2/tasks"))
      return ok([
        { Id: 1000, Name: "Relay demonstration task", Type: "User", Suspended: false },
        { Id: 1001, Name: "Someone else's task", Type: "User", Suspended: false },
      ]);
    return ok({ apiVersion: 2 });
  });
  const config = await (await fetch(url + "/api/config")).json();
  assert.deepEqual(config, { demo: true, username: "RelayDemoOperator", password: "public-demo", resetMinutes: 60 });
  const before = calls.length;
  assert.equal((await login("RelayLab")).status, 403);
  assert.equal(calls.length, before, "a non-demo account must not reach IRIS");
  const l = await login();
  assert.equal(l.status, 200);
  const cookie = l.headers.get("set-cookie").split(";")[0],
    { csrf } = await l.json();
  const post = (path, data) =>
    fetch(url + path, {
      method: "POST",
      headers: { Cookie: cookie, Origin: url, "Content-Type": "application/json", "X-Relay-CSRF": csrf },
      body: JSON.stringify(data),
    });
  const quiet = calls.length;
  for (const [kind, name] of [
    ["users", "_SYSTEM"], ["users", "RelayDemoOperator"], ["webapps", "/csp/sys"],
    ["tls", "%SuperServer"], ["rolePolicy", "%Developer"], ["collections", "Other"],
    ["certificates", "Other"], ["oauthResources", "Other"], ["oauthSettings", "Other"], ["unknown", "x"],
  ]) {
    const r = await post("/api/manage/preview", { kind, name, enabled: true });
    assert.equal(r.status, 403, kind + " " + name);
    assert.match((await r.json()).error, /demonstration objects/);
  }
  assert.equal(calls.length, quiet, "refused demo targets must not reach IRIS");
  const other = await post("/api/tasks/preview", { taskId: 1001, action: "suspend" });
  assert.equal(other.status, 403);
  assert.ok(!calls.some((c) => c.includes("task/info?id=1001")));
});

test("sessions are bounded and proxy-forwarded addresses get their own sign-in throttle", async (t) => {
  let unauthorized = true;
  const { url, login } = await demoSetup(
    t,
    async (u) => (unauthorized && u.pathname.endsWith("/info") ? new Response("", { status: 401 }) : ok({ apiVersion: 2 })),
    { trustProxy: true },
  );
  for (let i = 0; i < 5; i++)
    assert.equal((await login("RelayDemoOperator", { "X-Forwarded-For": "203.0.113.7" })).status, 401);
  assert.equal((await login("RelayDemoOperator", { "X-Forwarded-For": "203.0.113.7" })).status, 429);
  unauthorized = false;
  // A different visitor behind the same proxy is not locked out; a spoofed first entry does not help the first one.
  assert.equal((await login("RelayDemoOperator", { "X-Forwarded-For": "198.51.100.9" })).status, 200);
  assert.equal((await login("RelayDemoOperator", { "X-Forwarded-For": "198.51.100.9, 203.0.113.7" })).status, 429);
  const cookies = [];
  for (let i = 0; i < 502; i++)
    cookies.push((await login("RelayDemoOperator", { "X-Forwarded-For": "192.0.2." + (i % 250) })).headers.get("set-cookie").split(";")[0]);
  const status = async (c) => (await fetch(url + "/api/session", { headers: { Cookie: c } })).status;
  assert.equal(await status(cookies[0]), 401, "oldest session evicted");
  assert.equal(await status(cookies.at(-1)), 200);
});

// IRIS 2026.2 as measured for Relay.Api /account (see test/iris-api.test.mjs relayAccount).
function expiredIris(state, { extension = true } = {}) {
  return async (u, init = {}) => {
    state.calls.push(`${init.method || "GET"} ${u.pathname}`);
    const auth = init.headers?.Authorization || "";
    const basicOk = auth === "Basic " + btoa("tester:" + state.password);
    if (u.pathname === "/api/relay/account") {
      if (!extension) return new Response("Not Found", { status: 404 });
      const refuse = (body) => new Response(JSON.stringify(body), { status: 401, headers: { "Content-Type": "application/json" } });
      if (init.method === "POST") {
        const form = new URLSearchParams(init.body);
        if (auth || form.get("IRISUsername") !== "tester" || form.get("IRISOldPassword") !== state.password)
          return refuse({ reason: "denied" });
        if (form.get("IRISPassword").length < 8)
          return refuse({ reason: "password-rejected", detail: "ERROR #845: Password does not match length or pattern requirements" });
        state.password = form.get("IRISPassword");
        state.mustChange = false;
        return new Response(JSON.stringify({ username: "Tester" }), { status: 200 });
      }
      if (!basicOk) return (state.invalidLogins++, refuse({ reason: "denied" }));
      if (state.mustChange) return (state.invalidLogins++, refuse({ reason: "password-change-required" }));
      return new Response(JSON.stringify({ username: "Tester" }), { status: 200 });
    }
    if (!basicOk || state.mustChange) return (state.invalidLogins++, new Response("", { status: 401 }));
    return ok({ apiVersion: 2, username: "Tester" });
  };
}

test("expired password: the server says why, IRIS changes it after a counted check, and the new one signs in", async (t) => {
  const state = { password: "test-only-password", mustChange: true, invalidLogins: 0, calls: [] };
  const { url, login } = await setup(t, expiredIris(state));
  const r = await login();
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("set-cookie"), null);
  assert.equal((await r.json()).reason, "password-change-required");
  assert.deepEqual(state.calls, ["GET /api/relay/account"], "one IRIS login attempt, no retry on /api/admin");
  const change = (data, headers = {}) =>
    fetch(url + "/api/password", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ username: "tester", ...data }),
    });
  const sent = state.calls.length;
  assert.equal((await change({ oldPassword: "test-only-password", newPassword: "fresh-password-1" }, { Origin: "https://untrusted.example" })).status, 403);
  assert.equal(state.calls.length, sent, "a cross-origin change never reaches IRIS");
  const wrong = await change({ oldPassword: "guess", newPassword: "fresh-password-1" });
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).error, /refused the current password/);
  assert.equal(state.invalidLogins, 2, "IRIS counted the wrong current password");
  assert.ok(!state.calls.includes("POST /api/relay/account"));
  const rejected = await change({ oldPassword: "test-only-password", newPassword: "short" });
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).error, "IRIS did not accept the new password: ERROR #845: Password does not match length or pattern requirements");
  assert.equal(state.password, "test-only-password");
  const done = await change({ oldPassword: "test-only-password", newPassword: "fresh-password-1" });
  assert.equal(done.status, 200);
  const body = await done.json();
  assert.equal(body.passwordChanged, true);
  assert.equal(state.password, "fresh-password-1");
  const cookie = done.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(url + "/api/session", { headers: { Cookie: cookie } })).status, 200);
  // The old password stops working; a change for an account IRIS does not ask to change is refused.
  assert.equal((await login()).status, 401);
  const again = await change({ oldPassword: "fresh-password-1", newPassword: "fresh-password-2" });
  assert.equal(again.status, 409);
  assert.equal(state.password, "fresh-password-1");
});

test("public demo never changes passwords; without the extension Relay points to the Management Portal", async (t) => {
  const calls = [];
  const { url } = await demoSetup(t, async (u) => (calls.push(u.pathname), ok({ apiVersion: 2 })));
  const demo = await fetch(url + "/api/password", {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "RelayDemoOperator", oldPassword: "public-demo", newPassword: "taken-over-1" }),
  });
  assert.equal(demo.status, 403);
  assert.equal(calls.length, 0);
  const state = { password: "test-only-password", mustChange: true, invalidLogins: 0, calls: [] };
  const { url: plain, login } = await setup(t, expiredIris(state, { extension: false }));
  const r = await login();
  assert.equal(r.status, 401);
  const refused = await r.json();
  assert.equal(refused.reason, "no-extension");
  assert.equal(refused.portal, "http://127.0.0.1:52785/csp/sys/UtilHome.csp");
  const change = await fetch(plain + "/api/password", {
    method: "POST",
    headers: { Origin: plain, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "tester", oldPassword: "test-only-password", newPassword: "fresh-password-1" }),
  });
  assert.equal(change.status, 501);
  assert.match((await change.json()).error, /Management Portal/);
  assert.ok(!state.calls.some((c) => c.startsWith("POST")));
  assert.equal(state.password, "test-only-password");
});
