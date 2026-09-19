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
