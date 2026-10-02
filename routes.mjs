// The Relay API surface (/api/logs, /api/audit, /api/explorer, /api/manage,
// /api/tasks, /api/resource), shared by the Node server (server.mjs) and by the
// browser backend that IRIS serves from the IPM package (iris-api.mjs).
// It runs unchanged in Node.js 22 and in browsers: no Node built-ins.
import { startAudit, readAudit } from "./audit.mjs";
import { operations, buildQuery } from "./explorer.mjs";
import {
  managementState,
  previewManagement,
  applyManagement,
} from "./management.mjs";
import { redact, apiError, resources } from "./resources.mjs";
import { randomHex } from "./random.mjs";

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Public demo: only the shared demo account may sign in, and only the disposable
// Relay demonstration objects created by scripts/bootstrap.py can be changed.
export const DEMO_TARGETS = {
  webapps: ["/relay-demo"],
  users: ["RelayDemoUser"],
  collections: ["RelayDemo"],
  certificates: ["RelayDemoCertificate"],
  oauthResources: ["RelayDemoOAuth"],
  oauthSettings: ["RelayDemoOAuth"],
  tls: ["RelayDemoTLS"],
  rolePolicy: ["RelayDemoRole"],
};
export const DEMO_TASK = "Relay demonstration task";

function base64(text) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const validCredentials = (c) =>
  !!c &&
  typeof c.username === "string" &&
  typeof c.password === "string" &&
  !!c.username &&
  !!c.password &&
  !c.username.includes(":");

// One IRIS request as the operator: HTTP Basic, no redirects, a timeout, a 2 MiB
// response cap, IRIS status errors treated as failures and credential-like fields
// redacted. `signal` (browser) cancels everything when the operator signs out;
// `init` adds fetch options such as credentials: "omit".
export function createUpstream({
  fetcher,
  target,
  init = {},
  signal = null,
  describeFailures = false,
}) {
  return async function upstream(
    credentials,
    path,
    method = "GET",
    data,
    base = "/api/admin",
    timeoutMs = 10000,
  ) {
    const signedOut = {
      ok: false,
      status: 401,
      error: "Signed out. The request was cancelled.",
    };
    if (signal?.aborted) return signedOut;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await fetcher(new URL(base + path, target), {
        ...init,
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: "Basic " + base64(credentials.username + ":" + credentials.password),
          Accept: "application/json",
          ...(data ? { "Content-Type": "application/json" } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          ok: false,
          status: response.status,
          error: apiError(response.status),
        };
      }
      const reader = response.body.getReader();
      let bytes = 0,
        chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return {
            ok: false,
            status: 502,
            error: "IRIS response is too large; narrow the query.",
          };
        }
        chunks.push(value);
      }
      const all = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      let decoded;
      try {
        decoded = JSON.parse(new TextDecoder().decode(all));
      } catch {
        return {
          ok: false,
          status: 502,
          error: "IRIS returned an unexpected response format.",
        };
      }
      const errors = decoded.status?.errors ?? decoded.status?.Errors ?? [];
      if (errors.length)
        return {
          ok: false,
          status: 502,
          error: "IRIS reported an application error. Review the IRIS logs.",
        };
      return {
        ok: true,
        status: response.status,
        data: redact(decoded.result ?? decoded),
        ...(response.status === 202
          ? { location: response.headers.get("location") }
          : {}),
      };
    } catch (error) {
      if (signal?.aborted) return signedOut;
      if (!describeFailures) return { ok: false, status: 503, error: apiError(503) };
      return {
        ok: false,
        status: 503,
        error: timedOut
          ? `IRIS did not answer within ${Math.round(timeoutMs / 1000)} second${Math.round(timeoutMs / 1000) === 1 ? "" : "s"}. Check the instance and try again.`
          : apiError(503) + " (" + (error?.message || String(error)) + ")",
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  };
}

// Sign-in check: the account must reach /api/admin and the instance must expose API v2.
export async function signIn(credentials, upstream) {
  const info = await upstream(credentials, "/info");
  if (!info.ok) return { status: info.status, error: info.error };
  const check = await upstream(credentials, "/v2/tasks?maxRows=1");
  if (check.status === 404)
    return {
      status: 409,
      error:
        "This IRIS instance does not expose API v2. Use a compatible IRIS 2026.2 instance.",
    };
  if (check.status === 503) return { status: 503, error: check.error };
  return { status: 200, info: info.data };
}

// Authenticated API routes. Returns { status, data }, or null for an unknown route.
// Validation failures in the logic modules are thrown as errors with a status.
export async function route(
  { method, pathname, searchParams, readBody },
  { session, upstream, server, demo = null },
) {
  const reply = (status, data) => ({ status, data });
  const demoRefusal = (kind, name) =>
    demo && !(DEMO_TARGETS[kind] || []).includes(name)
      ? "In the public demo only the Relay demonstration objects can be changed."
      : null;
  if (
    ["/api/logs/sources", "/api/logs/page"].includes(pathname) &&
    method === "GET"
  ) {
    const source = searchParams.get("source") || "runtime",
      cursor = searchParams.get("cursor") || "";
    if (
      !(
        /^(runtime|console|system-monitor|alerts)(\.[1-3])?$/.test(source) ||
        /^(runtime|console)\.old_[0-9A-Za-z_-]{1,48}$/.test(source)
      ) ||
      cursor.length > 1024 ||
      !/^[A-Za-z0-9_=-]*$/.test(cursor)
    )
      return reply(400, { error: "Invalid log source or cursor." });
    const list = pathname.endsWith("sources");
    const result = await upstream(
      session.credentials,
      list ? "/log-sources" : "/logs?" + new URLSearchParams({ source, cursor }),
      "GET",
      undefined,
      "/api/relay",
    );
    if (!result.ok) return reply(result.status, { error: result.error });
    if (result.data.error) return reply(409, { error: result.data.error });
    return reply(
      200,
      list
        ? result.data
        : {
            resource: "logs",
            observedAt: result.data.observedAt,
            limit: 150,
            data: result.data.rows,
            metadata: { ...result.data, rows: undefined },
          },
    );
  }
  if (pathname === "/api/logs/search" && method === "GET") {
    const q = (searchParams.get("q") || "").trim(),
      limit = Number(searchParams.get("limit") || 20);
    if (!q || q.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 50)
      return reply(400, {
        error: "Enter a search text of 1 to 200 characters and a limit from 1 to 50.",
      });
    const result = await upstream(
      session.credentials,
      "/log-search?" + new URLSearchParams({ q, limit: String(limit) }),
      "GET",
      undefined,
      "/api/relay",
    );
    if (!result.ok) return reply(result.status, { error: result.error });
    if (result.data.error) return reply(409, { error: result.data.error });
    return reply(200, result.data);
  }
  if (pathname === "/api/logs/index" && method === "POST") {
    // Indexing reads up to 20,000 lines inside IRIS; allow it more time than a view.
    const result = await upstream(
      session.credentials,
      "/log-index",
      "POST",
      {},
      "/api/relay",
      120000,
    );
    if (!result.ok) return reply(result.status, { error: result.error });
    if (result.data.error) return reply(409, { error: result.data.error });
    return reply(200, result.data);
  }
  if (pathname === "/api/audit/query" && method === "POST")
    return reply(202, await startAudit(session, await readBody(), upstream));
  if (pathname === "/api/audit/result" && method === "GET")
    return reply(200, await readAudit(session, searchParams.get("id"), upstream));
  if (pathname === "/api/explorer/catalog" && method === "GET")
    return reply(200, { operations, server });
  if (pathname === "/api/explorer/run" && method === "POST") {
    const input = await readBody();
    const query = buildQuery(input.operation, input.parameters);
    const started = performance.now();
    const result = await upstream(session.credentials, query.path);
    return reply(result.ok ? 200 : result.status, {
      ...result,
      ...query,
      resource: "explorer",
      observedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
    });
  }
  if (pathname === "/api/manage/details" && method === "GET") {
    const state = await managementState(
      session,
      searchParams.get("kind"),
      searchParams.get("name"),
      upstream,
    );
    const { path, ...visible } = state;
    if (state.kind === "rolePolicy")
      visible.owners = await upstream(
        session.credentials,
        "/v2/security/role/owners?" +
          new URLSearchParams({ name: state.name, maxRows: "100" }),
      );
    if (state.kind === "certificates")
      visible.certificate = await upstream(
        session.credentials,
        "/v2/security/x509-credential/certificate?" +
          new URLSearchParams({ alias: state.name }),
      );
    if (state.kind === "collections")
      visible.inventory = await upstream(
        session.credentials,
        "/v2/wallet/secrets?" +
          new URLSearchParams({ collection: state.name, maxRows: "100" }),
      );
    return reply(200, visible);
  }
  if (pathname === "/api/manage/preview" && method === "POST") {
    const input = await readBody();
    const refusal = demoRefusal(input?.kind, input?.name);
    if (refusal) return reply(403, { error: refusal });
    return reply(200, await previewManagement(session, input, upstream, server));
  }
  if (pathname === "/api/manage/apply" && method === "POST")
    return reply(
      200,
      await applyManagement(session, (await readBody()).token, upstream),
    );
  if (pathname === "/api/tasks/preview" && method === "POST") {
    const { taskId, action } = await readBody();
    if (
      !Number.isSafeInteger(taskId) ||
      taskId < 1 ||
      !["suspend", "resume"].includes(action)
    )
      return reply(400, { error: "Choose a valid task and supported action." });
    const tasks = await upstream(session.credentials, "/v2/tasks");
    if (!tasks.ok) return reply(tasks.status, { error: tasks.error });
    const task = Array.isArray(tasks.data)
      ? tasks.data.find((t) => t.Id === taskId)
      : null;
    if (!task) return reply(404, { error: "Task not found." });
    if (task.Type !== "User")
      return reply(403, {
        error: "Relay only changes user-defined tasks. System tasks are protected.",
      });
    if (demo && task.Name !== DEMO_TASK)
      return reply(403, {
        error:
          "In the public demo only the Relay demonstration objects can be changed.",
      });
    const detail = await upstream(
      session.credentials,
      `/v2/task/info?id=${taskId}`,
    );
    if (!detail.ok) return reply(detail.status, { error: detail.error });
    if (typeof detail.data.Suspended !== "boolean")
      return reply(502, { error: "Task suspension state could not be verified." });
    task.Suspended = detail.data.Suspended;
    const desired = action === "suspend";
    if (task.Suspended === desired)
      return reply(409, { error: "This task is already in the requested state." });
    // One outstanding plan per session, expiring in two minutes.
    session.plans.clear();
    const token = randomHex(24);
    const plan = {
      token,
      taskId,
      action,
      name: task.Name,
      before: task.Suspended,
      desired,
      expires: Date.now() + 120000,
    };
    session.plans.set(token, plan);
    return reply(200, { ...plan, server });
  }
  if (pathname === "/api/tasks/apply" && method === "POST") {
    const { token } = await readBody(),
      plan = session.plans.get(token);
    if (!plan || plan.kind || plan.expires < Date.now())
      return reply(409, {
        error: "Review this change again; the preview expired or was already used.",
      });
    session.plans.delete(token);
    const before = await upstream(session.credentials, "/v2/tasks");
    if (!before.ok) return reply(before.status, { error: before.error });
    const task = Array.isArray(before.data)
      ? before.data.find((t) => t.Id === plan.taskId)
      : null;
    const detail = await upstream(
      session.credentials,
      `/v2/task/info?id=${plan.taskId}`,
    );
    if (!detail.ok) return reply(detail.status, { error: detail.error });
    if (
      !task ||
      task.Type !== "User" ||
      task.Name !== plan.name ||
      detail.data.Suspended !== plan.before
    )
      return reply(409, {
        error: "Task state changed since the preview. Refresh and review again.",
      });
    const result = await upstream(
      session.credentials,
      `/v2/task/${plan.action}?id=${plan.taskId}`,
      "POST",
      plan.action === "suspend" ? { LeaveInQueue: true } : undefined,
    );
    if (!result.ok)
      return reply(result.status, {
        error:
          result.error +
          " The action may have reached IRIS. Refresh before trying again.",
      });
    const after = await upstream(
      session.credentials,
      `/v2/task/info?id=${plan.taskId}`,
    );
    const observed = after.ok
      ? { Name: task.Name, Id: plan.taskId, ...after.data }
      : null;
    return reply(200, {
      accepted: true,
      verified: observed?.Suspended === plan.desired,
      task: observed ?? null,
      observedAt: new Date().toISOString(),
    });
  }
  if (pathname.startsWith("/api/resource/") && method === "GET") {
    const id = pathname.slice("/api/resource/".length),
      resource = resources[id];
    if (!Object.hasOwn(resources, id))
      return reply(404, { error: "Unknown resource." });
    if (resource.virtual)
      return reply(400, {
        error: "Use the REST explorer catalog and run endpoints.",
      });
    const params = new URLSearchParams();
    if (resource.table && !resource.base) params.set("maxRows", "100");
    const result = await upstream(
      session.credentials,
      resource.path + (params.size ? "?" + params : ""),
      "GET",
      undefined,
      resource.base,
    );
    if (id === "runtime" && result.ok) {
      if (result.data.error) return reply(409, { error: result.data.error });
      const { rows, ...metadata } = result.data;
      if (!Array.isArray(rows))
        return reply(502, { error: "Runtime log response is invalid." });
      result.data = rows;
      result.metadata = metadata;
    }
    if (id === "tasks" && result.ok && Array.isArray(result.data)) {
      // IRIS 2026.2 list can lag behind task/info after suspension.
      for (const task of result.data.filter((t) => t.Type === "User")) {
        const detail = await upstream(
          session.credentials,
          `/v2/task/info?id=${task.Id}`,
        );
        task.Suspended =
          detail.ok && typeof detail.data.Suspended === "boolean"
            ? detail.data.Suspended
            : null;
        task.StateSource = detail.ok ? "Task details" : "Unavailable";
      }
    }
    return reply(result.ok ? 200 : result.status, {
      ...result,
      resource: id,
      observedAt: new Date().toISOString(),
      limit: resource.table ? resource.limit || 100 : null,
    });
  }
  return null;
}
