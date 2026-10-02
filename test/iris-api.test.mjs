// Browser backend of the IRIS-served UI (iris-api.mjs), run in Node with a fake
// fetch that plays the IRIS server. No browser and no IRIS needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createUpstream } from "../routes.mjs";
import {
  createIrisAPI,
  transportAllowed,
  SESSION_LIFETIME_MS,
} from "../iris-api.mjs";

const page = (href) => {
  const u = new URL(href);
  return { origin: u.origin, protocol: u.protocol, hostname: u.hostname };
};
const LOCAL = page("http://localhost:52773/relay/index.html");
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const ok = (result) => json({ status: { errors: [] }, result });

// A small IRIS stand-in: one user task, one custom web application, the log API.
function fakeIris(overrides = {}) {
  const calls = [];
  const state = {
    password: "right-password",
    suspended: false,
    app: { Name: "/relay-demo", NameSpace: "USER", Enabled: false, AutheEnabled: 32 },
    writes: [],
  };
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const custom = overrides[u.pathname];
    if (custom) return custom(u, init, state);
    const auth = init.headers?.Authorization || "";
    if (auth !== "Basic " + btoa("operator:" + state.password))
      return new Response("", { status: 401 });
    const p = u.pathname.replace(/^\/api\/admin/, "");
    if (p === "/info") return ok({ apiVersion: 2, username: "operator", serverVersion: "IRIS 2026.2 (test double)" });
    if (p === "/v2/tasks")
      return ok([
        { Id: 1, Name: "System", Type: "System", Suspended: false },
        { Id: 1000, Name: "Relay demonstration task", Type: "User", Suspended: false },
      ]);
    if (p === "/v2/task/info") return ok({ Type: "User", Suspended: state.suspended });
    if (p === "/v2/task/suspend" && init.method === "POST") {
      state.writes.push(p);
      state.suspended = true;
      return ok({});
    }
    if (p === "/v2/web-app") {
      if (init.method === "PUT") {
        state.writes.push(JSON.parse(init.body));
        Object.assign(state.app, JSON.parse(init.body));
      }
      return ok(structuredClone(state.app));
    }
    if (p === "/v2/web-apps")
      return ok([{ Name: "/relay-demo", IsSystemApp: false, Type: "CSP" }]);
    if (p === "/v2/security/users")
      return ok([{ Name: "Example", Password: "should-not-leave", Nested: { access_token: "t" } }]);
    if (u.pathname === "/api/relay/log-sources")
      return json({ sources: [{ id: "runtime", name: "messages.log", available: true, bytes: 10 }] });
    if (u.pathname === "/api/relay/logs")
      return json({ observedAt: "2026-10-02T12:00:00Z", rows: [{ Message: "line" }], nextCursor: null });
    return new Response("", { status: 404 });
  };
  return { fetcher, calls, state };
}

async function signedIn(options = {}) {
  const iris = fakeIris(options.overrides);
  const api = createIrisAPI({ fetcher: iris.fetcher, location: LOCAL, ...options.api });
  const session = await api("/api/login", "POST", {
    username: "operator",
    password: "right-password",
  });
  return { api, iris, session };
}

test("credentials are sent only over HTTPS or to a loopback page origin", async () => {
  for (const href of [
    "https://iris.example/relay/index.html",
    "http://localhost:52773/relay/index.html",
    "http://127.0.0.1:52773/relay/index.html",
    "http://127.10.0.3/relay/index.html",
    "http://[::1]:52773/relay/index.html",
  ])
    assert.equal(transportAllowed(page(href)), true, href);
  for (const href of [
    "http://iris.example/relay/index.html",
    "http://192.168.1.20:52773/relay/index.html",
    "http://localhost.example/relay/index.html",
    "http://127.0.0.1.example/relay/index.html",
    "file:///relay/index.html",
  ]) {
    assert.equal(transportAllowed(page(href)), false, href);
    let called = 0;
    const api = createIrisAPI({ fetcher: async () => (called++, ok({})), location: page(href) });
    await assert.rejects(
      api("/api/login", "POST", { username: "operator", password: "right-password" }),
      (e) => e.status === 403 && /Sign-in blocked/.test(e.message),
    );
    assert.equal(called, 0, href);
  }
});

test("sign-in calls IRIS on the same origin with Basic auth, no cookies and no redirects", async () => {
  const { session, iris } = await signedIn();
  assert.equal(session.server, "http://localhost:52773");
  assert.equal(session.info.username, "operator");
  assert.ok(session.resources.tasks);
  assert.equal(session.csrf, undefined);
  assert.deepEqual(
    iris.calls.map((c) => c.url.href),
    [
      "http://localhost:52773/api/admin/info",
      "http://localhost:52773/api/admin/v2/tasks?maxRows=1",
    ],
  );
  for (const { url, init } of iris.calls) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    assert.doesNotMatch(url.href, /right-password/);
  }
});

test("wrong passwords fail visibly and five of them pause sign-in without calling IRIS", async () => {
  const iris = fakeIris();
  const api = createIrisAPI({ fetcher: iris.fetcher, location: LOCAL });
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      api("/api/login", "POST", { username: "operator", password: "wrong" }),
      { status: 401 },
    );
  const before = iris.calls.length;
  await assert.rejects(
    api("/api/login", "POST", { username: "operator", password: "right-password" }),
    { status: 429 },
  );
  assert.equal(iris.calls.length, before);
  for (const bad of [{}, { username: "a:b", password: "x" }, { username: "a", password: "" }])
    await assert.rejects(api("/api/login", "POST", bad), { status: 429 });
  const fresh = createIrisAPI({ fetcher: iris.fetcher, location: LOCAL });
  await assert.rejects(fresh("/api/login", "POST", { username: "a:b", password: "x" }), { status: 400 });
  await assert.rejects(fresh("/api/session"), { status: 401 });
});

test("an IRIS without API v2 does not become a misleading session", async () => {
  const iris = fakeIris({
    "/api/admin/v2/tasks": () => new Response("", { status: 404 }),
  });
  const api = createIrisAPI({ fetcher: iris.fetcher, location: LOCAL });
  await assert.rejects(
    api("/api/login", "POST", { username: "operator", password: "right-password" }),
    (e) => e.status === 409 && /API v2/.test(e.message),
  );
  assert.equal(api.signedIn(), false);
});

test("task change: review first, re-check, apply once, read back; system tasks protected", async () => {
  const { api, iris } = await signedIn();
  await assert.rejects(api("/api/tasks/preview", "POST", { taskId: 1, action: "suspend" }), { status: 403 });
  const plan = await api("/api/tasks/preview", "POST", { taskId: 1000, action: "suspend" });
  assert.equal(plan.server, "http://localhost:52773");
  assert.equal(iris.state.writes.length, 0);
  plan.before = "tampered in the page";
  const applied = await api("/api/tasks/apply", "POST", { token: plan.token });
  assert.equal(applied.verified, true);
  assert.equal(applied.task.Suspended, true);
  assert.deepEqual(iris.state.writes, ["/v2/task/suspend"]);
  const suspend = iris.calls.find((c) => c.url.pathname.endsWith("/task/suspend"));
  assert.deepEqual(JSON.parse(suspend.init.body), { LeaveInQueue: true });
  await assert.rejects(api("/api/tasks/apply", "POST", { token: plan.token }), { status: 409 });
  assert.equal(iris.state.writes.length, 1);
  const tasks = await api("/api/resource/tasks");
  assert.equal(tasks.data[1].Suspended, true);
  assert.equal(tasks.data[1].StateSource, "Task details");
});

test("a task changed by someone else after the review is refused without a write", async () => {
  const { api, iris } = await signedIn();
  iris.state.suspended = false;
  const plan = await api("/api/tasks/preview", "POST", { taskId: 1000, action: "suspend" });
  iris.state.suspended = true;
  await assert.rejects(api("/api/tasks/apply", "POST", { token: plan.token }), { status: 409 });
  assert.equal(iris.state.writes.length, 0);
});

test("management change sends only the reviewed field, verifies it and refuses drift", async () => {
  const { api, iris } = await signedIn();
  const details = await api("/api/manage/details?" + new URLSearchParams({ kind: "webapps", name: "/relay-demo" }));
  assert.equal(details.editable, true);
  assert.equal(details.path, undefined);
  const plan = await api("/api/manage/preview", "POST", { kind: "webapps", name: "/relay-demo", enabled: true });
  assert.deepEqual(plan.before, { Enabled: false });
  assert.deepEqual(plan.desired, { Enabled: true });
  const done = await api("/api/manage/apply", "POST", { token: plan.token });
  assert.equal(done.verified, true);
  assert.deepEqual(iris.state.writes, [{ Enabled: true }]);
  await assert.rejects(api("/api/manage/apply", "POST", { token: plan.token }), { status: 409 });
  const second = await api("/api/manage/preview", "POST", { kind: "webapps", name: "/relay-demo", enabled: false });
  iris.state.app.AutheEnabled = 64; // another operator changed the application meanwhile
  await assert.rejects(api("/api/manage/apply", "POST", { token: second.token }), { status: 409 });
  assert.equal(iris.state.writes.length, 1);
  for (const name of ["/api/admin", "/api/relay", "/csp/sys", "/relay", "/relay/"])
    await assert.rejects(api("/api/manage/preview", "POST", { kind: "webapps", name, enabled: false }), { status: 403 });
});

test("sign-out drops the credentials, cancels requests in flight and sends nothing more", async () => {
  let release;
  const { api, iris } = await signedIn({
    overrides: {
      "/api/relay/log-index": (u, init) =>
        new Promise((resolve, reject) => {
          release = resolve;
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    },
  });
  const pending = api("/api/logs/index", "POST", {});
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(release, "the index request reached the fake IRIS");
  await api("/api/logout", "POST", {});
  await assert.rejects(pending, { status: 401 });
  const count = iris.calls.length;
  await assert.rejects(api("/api/resource/tasks"), { status: 401 });
  await assert.rejects(api("/api/session"), { status: 401 });
  assert.equal(iris.calls.length, count);
  assert.equal(api.signedIn(), false);
});

test("a change interrupted by sign-out never reaches IRIS", async () => {
  let applying = false;
  const ctx = await signedIn({
    overrides: {
      // Sign out while the apply step re-reads the configuration, just before the PUT.
      "/api/admin/v2/web-apps": async () => {
        if (applying) await ctx.api("/api/logout", "POST", {});
        return ok([{ Name: "/relay-demo", IsSystemApp: false, Type: "CSP" }]);
      },
    },
  });
  const plan = await ctx.api("/api/manage/preview", "POST", { kind: "webapps", name: "/relay-demo", enabled: true });
  applying = true;
  await assert.rejects(ctx.api("/api/manage/apply", "POST", { token: plan.token }), { status: 401 });
  assert.equal(ctx.iris.state.writes.length, 0);
  assert.ok(!ctx.iris.calls.some((c) => c.init.method === "PUT"));
});

test("the session ends after 30 minutes and the page is told why", async () => {
  let clock = Date.now();
  const ended = [];
  const { api } = await signedIn({ api: { now: () => clock, onSessionEnd: (r) => ended.push(r) } });
  assert.equal((await api("/api/session")).info.username, "operator");
  clock += SESSION_LIFETIME_MS + 1;
  await assert.rejects(api("/api/resource/tasks"), { status: 401 });
  assert.equal(ended.length, 1);
  assert.match(ended[0], /expired/);
  assert.equal(api.signedIn(), false);
});

test("responses are size-limited, redacted and copied; IRIS errors fail visibly", async () => {
  const huge = "x".repeat(2 * 1024 * 1024 + 10);
  const { api } = await signedIn({
    overrides: {
      "/api/admin/v2/processes": () => ok([{ Text: huge }]),
      "/api/admin/v2/devices": () => json({ status: { errors: [{ error: "secret detail" }] } }),
      "/api/admin/v2/journal/files": () => new Response("not json", { status: 200 }),
    },
  });
  await assert.rejects(api("/api/resource/processes"), (e) => e.status === 502 && /too large/.test(e.message));
  await assert.rejects(api("/api/resource/devices"), (e) => e.status === 502 && !/secret detail/.test(e.message));
  await assert.rejects(api("/api/resource/journals"), (e) => e.status === 502 && /unexpected response/.test(e.message));
  const users = await api("/api/resource/users");
  assert.equal(users.data[0].Password, "[REDACTED]");
  assert.equal(users.data[0].Nested.access_token, "[REDACTED]");
  users.data[0].Name = "changed by the page";
  assert.equal((await api("/api/resource/users")).data[0].Name, "Example");

});

test("a request IRIS does not answer in time fails with the reason", async () => {
  const hanging = (url, init) =>
    new Promise((_, reject) =>
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
    );
  const upstream = createUpstream({ fetcher: hanging, target: "http://localhost:52773", describeFailures: true });
  const started = Date.now();
  const result = await upstream({ username: "operator", password: "p" }, "/v2/tasks", "GET", undefined, "/api/admin", 1000);
  assert.equal(result.status, 503);
  assert.match(result.error, /did not answer within 1 second\./);
  assert.ok(Date.now() - started >= 900);
  const quiet = createUpstream({ fetcher: hanging, target: "http://localhost:52773" });
  assert.equal(
    (await quiet({ username: "operator", password: "p" }, "/v2/tasks", "GET", undefined, "/api/admin", 50)).error,
    "IRIS is unavailable. Check the local instance.",
  );
});

test("only allowlisted routes, explorer operations and log IDs reach IRIS", async () => {
  const { api, iris } = await signedIn();
  const before = iris.calls.length;
  for (const [path, method, data] of [
    ["/api/resource/__proto__", "GET"],
    ["/api/resource/logs", "GET"],
    ["/api/explorer/run", "POST", { operation: "https://evil.example" }],
    ["/api/explorer/run", "POST", { operation: "tasks", parameters: { maxRows: 101 } }],
    ["/api/explorer/run", "POST", { operation: "tasks", parameters: { method: "DELETE" } }],
    ["/api/logs/page?source=runtime.old_../x", "GET"],
    ["/api/logs/search?q=", "GET"],
    ["/api/arbitrary", "GET"],
    ["https://evil.example/api/resource/tasks", "GET"],
    ["//evil.example/api/resource/tasks", "GET"],
    ["/api/manage/preview", "POST", { kind: "users", name: "x", roles: ["r".repeat(17000)] }],
  ])
    await assert.rejects(api(path, method, data), (e) => [400, 404, 413].includes(e.status), path);
  assert.equal(iris.calls.length, before);
  const run = await api("/api/explorer/run", "POST", { operation: "tasks", parameters: { maxRows: 5 } });
  assert.equal(run.status, 200);
  assert.equal(iris.calls.at(-1).url.href, "http://localhost:52773/api/admin/v2/tasks?maxRows=5");
  const page = await api("/api/logs/page?source=runtime");
  assert.equal(page.data[0].Message, "line");
  assert.equal(iris.calls.at(-1).url.href, "http://localhost:52773/api/relay/logs?source=runtime&cursor=");
  assert.ok(iris.calls.every((c) => c.url.origin === "http://localhost:52773"));
});

test("the browser backend keeps no state in storage or cookies", () => {
  for (const file of ["iris-api.mjs", "routes.mjs", "public/app.js"]) {
    const source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/, file);
  }
});
