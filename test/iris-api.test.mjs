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

// A small IRIS stand-in: one user task, one custom web application, the log API, and
// /api/relay/account as measured on IRIS 2026.2 (see relayAccount).
function fakeIris(overrides = {}, options = {}) {
  const calls = [];
  const state = {
    password: "right-password",
    mustChange: false,
    invalidLogins: 0,
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
    const basicOk = auth === "Basic " + btoa("operator:" + state.password);
    if (u.pathname === "/api/relay/account") return relayAccount(init, state, basicOk, options);
    if (!basicOk || state.mustChange) {
      if (auth) state.invalidLogins++;
      return new Response("", { status: 401 });
    }
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

// IRIS 2026.2, Relay.Api /account: a Basic sign-in counts every refusal (also a correct
// but expired password) and says why; the IRIS login form fields change the password
// after checking the old one first, then the password rules, and do not count a wrong
// old password. options.namespace "USER": IRIS answers a refused sign-in with 404 there.
function relayAccount(init, state, basicOk, options) {
  const refuse = (body) =>
    options.namespace === "USER" ? new Response("Not Found", { status: 404 }) : json(body, 401);
  const denied = { reason: "denied", error: "Access denied." };
  if (init.method === "POST" && !init.headers?.Authorization) {
    const form = new URLSearchParams(init.body);
    if (form.get("IRISUsername") !== "operator" || form.get("IRISOldPassword") !== state.password)
      return refuse(denied);
    if (form.get("IRISPassword").length < 8)
      return refuse({
        reason: "password-rejected",
        error: "IRIS did not accept the new password.",
        detail: "ERROR #845: Password does not match length or pattern requirements",
      });
    state.password = form.get("IRISPassword");
    state.mustChange = false;
    state.invalidLogins = 0;
    return json({ username: "operator" });
  }
  if (!basicOk) {
    state.invalidLogins++;
    return refuse(denied);
  }
  if (state.mustChange) {
    state.invalidLogins++;
    return refuse({ reason: "password-change-required", error: "IRIS requires a password change for this account." });
  }
  return json({ username: "operator" });
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
      "http://localhost:52773/api/relay/account",
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

test("an expired password: detected at sign-in, changed by IRIS after a counted check, new one signs in", async () => {
  const iris = fakeIris();
  iris.state.mustChange = true;
  const api = createIrisAPI({ fetcher: iris.fetcher, location: LOCAL });
  await assert.rejects(
    api("/api/login", "POST", { username: "operator", password: "right-password" }),
    (e) => e.status === 401 && e.reason === "password-change-required" && /requires a new password/.test(e.message),
  );
  // One IRIS login attempt, never a second one on /api/admin.
  assert.deepEqual(iris.calls.map((c) => c.url.pathname), ["/api/relay/account"]);
  assert.equal(iris.state.invalidLogins, 1);
  assert.equal(api.signedIn(), false);
  const change = (oldPassword, newPassword) =>
    api("/api/password", "POST", { username: "operator", oldPassword, newPassword });
  // A wrong current password is refused by the counted HTTP Basic check; no form is sent.
  const sent = iris.calls.length;
  await assert.rejects(change("wrong-password", "new-password-1"), (e) => e.status === 401 && /refused the current password/.test(e.message));
  assert.equal(iris.state.invalidLogins, 2);
  assert.ok(!iris.calls.slice(sent).some((c) => c.init.method === "POST"));
  // IRIS password rules: the IRIS text is shown as it is, and nothing changes.
  await assert.rejects(
    change("right-password", "short"),
    (e) => e.status === 422 && e.message === "IRIS did not accept the new password: ERROR #845: Password does not match length or pattern requirements",
  );
  assert.equal(iris.state.password, "right-password");
  await assert.rejects(change("right-password", "right-password"), (e) => e.status === 400 && /different/.test(e.message));
  const before = iris.calls.length;
  const session = await change("right-password", "new-password-1");
  assert.equal(session.passwordChanged, true);
  assert.equal(session.info.username, "operator");
  assert.equal(api.signedIn(), true);
  assert.equal(iris.state.password, "new-password-1");
  const form = iris.calls.slice(before).find((c) => c.init.method === "POST");
  assert.equal(form.url.href, "http://localhost:52773/api/relay/account");
  assert.equal(form.init.headers.Authorization, undefined);
  assert.equal(form.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(form.init.body)), {
    IRISUsername: "operator",
    IRISOldPassword: "right-password",
    IRISPassword: "new-password-1",
  });
  for (const { url, init } of iris.calls) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.doesNotMatch(url.href, /password-1|right-password/);
  }
  // The session runs on the new password; the old one is gone.
  const last = iris.calls.at(-1).init.headers.Authorization;
  assert.equal(last, "Basic " + btoa("operator:new-password-1"));
  await api("/api/logout", "POST", {});
  await assert.rejects(api("/api/login", "POST", { username: "operator", password: "right-password" }), { status: 401 });
  await api("/api/login", "POST", { username: "operator", password: "new-password-1" });
});

test("password change: only when IRIS requires it, for the named account, over an allowed transport, throttled", async () => {
  const iris = fakeIris();
  const api = createIrisAPI({ fetcher: iris.fetcher, location: LOCAL });
  await assert.rejects(
    api("/api/password", "POST", { username: "operator", oldPassword: "right-password", newPassword: "new-password-1" }),
    (e) => e.status === 409 && /does not require/.test(e.message),
  );
  assert.ok(!iris.calls.some((c) => c.init.method === "POST"), "no change for an account that IRIS does not ask to change");
  assert.equal(iris.state.password, "right-password");
  const calls = iris.calls.length;
  for (const bad of [{}, { username: "a:b", oldPassword: "x", newPassword: "y" }, { username: "operator", oldPassword: "x", newPassword: "" },
    { username: "operator", oldPassword: "x", newPassword: "y".repeat(256) }])
    await assert.rejects(api("/api/password", "POST", bad), { status: 400 });
  assert.equal(iris.calls.length, calls);
  // IRIS confirms a different account than the one named: never reported as done.
  const other = fakeIris({ "/api/relay/account": (u, init) =>
    init.method === "POST" ? json({ username: "SomeoneElse" }) : json({ reason: "password-change-required" }, 401) });
  const otherApi = createIrisAPI({ fetcher: other.fetcher, location: LOCAL });
  await assert.rejects(
    otherApi("/api/password", "POST", { username: "operator", oldPassword: "right-password", newPassword: "new-password-1" }),
    (e) => e.status === 502 && /did not confirm the account/.test(e.message),
  );
  assert.equal(otherApi.signedIn(), false);
  let sentRemote = 0;
  const remote = createIrisAPI({ fetcher: async () => (sentRemote++, ok({})), location: page("http://iris.example/relay/index.html") });
  await assert.rejects(
    remote("/api/password", "POST", { username: "operator", oldPassword: "right-password", newPassword: "new-password-1" }),
    (e) => e.status === 403 && /Sign-in blocked/.test(e.message),
  );
  assert.equal(sentRemote, 0);
  iris.state.mustChange = true;
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      api("/api/password", "POST", { username: "operator", oldPassword: "guess-" + i, newPassword: "new-password-1" }),
      { status: 401 },
    );
  const count = iris.calls.length;
  await assert.rejects(
    api("/api/password", "POST", { username: "operator", oldPassword: "right-password", newPassword: "new-password-1" }),
    { status: 429 },
  );
  assert.equal(iris.calls.length, count);
  assert.equal(iris.state.invalidLogins, 5);
});

test("outside %SYS IRIS does not say why a sign-in failed: the page offers the change and IRIS decides", async () => {
  const iris = fakeIris({}, { namespace: "USER" });
  iris.state.mustChange = true;
  const api = createIrisAPI({ fetcher: iris.fetcher, location: LOCAL });
  await assert.rejects(
    api("/api/login", "POST", { username: "operator", password: "right-password" }),
    (e) => e.status === 401 && e.reason === "unknown" && e.portal === "http://localhost:52773/csp/sys/UtilHome.csp",
  );
  assert.deepEqual(iris.calls.map((c) => c.url.pathname), ["/api/relay/account"]);
  await assert.rejects(
    api("/api/password", "POST", { username: "operator", oldPassword: "wrong-password", newPassword: "new-password-1" }),
    (e) => e.status === 422 && e.reason === "unknown" && /does not tell this page which/.test(e.message),
  );
  assert.equal(iris.state.password, "right-password");
  const session = await api("/api/password", "POST", { username: "operator", oldPassword: "right-password", newPassword: "new-password-1" });
  assert.equal(session.passwordChanged, true);
  assert.equal(iris.state.password, "new-password-1");
});
