import http from "node:http";
import { startAudit, readAudit } from "./audit.mjs";
import { operations, buildQuery } from "./explorer.mjs";
import {
  managementState,
  previewManagement,
  applyManagement,
} from "./management.mjs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { resources, redact, apiError } from "./resources.mjs";

const sessionLifetime = 30 * 60 * 1000;
const maxBytes = 2 * 1024 * 1024;
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const files = {
  "/demo.js": ["demo.js", "text/javascript"],
  "/logs-ui.js": ["logs-ui.js", "text/javascript"],
  "/configuration-ui.js": ["configuration-ui.js", "text/javascript"],
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/audit-ui.js": ["audit-ui.js", "text/javascript"],
  "/explorer-ui.js": ["explorer-ui.js", "text/javascript"],
  "/reports.js": ["reports.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
};

export function createApp({
  irisUrl = "http://127.0.0.1:52785",
  origin = "http://127.0.0.1:8787",
  fetcher = fetch,
} = {}) {
  const target = new URL(irisUrl);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== "/"
  )
    throw new Error(
      "IRIS_URL must be an HTTP(S) origin without embedded credentials.",
    );
  if (
    target.protocol === "http:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  )
    throw new Error("Remote IRIS connections require HTTPS.");
  const sessions = new Map();
  const failures = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.expires < now) sessions.delete(id);
    for (const [id, f] of failures) if (f.until < now) failures.delete(id);
  }, 60000).unref();

  const reply = (res, status, data, headers = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify(data));
  };
  async function body(req) {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 16000)
        throw Object.assign(new Error("Request too large"), { status: 413 });
    }
    try {
      return JSON.parse(raw || "{}");
    } catch {
      throw Object.assign(new Error("Invalid JSON"), { status: 400 });
    }
  }
  async function upstream(
    credentials,
    path,
    method = "GET",
    data,
    base = "/api/admin",
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetcher(new URL(base + path, target), {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              credentials.username + ":" + credentials.password,
            ).toString("base64"),
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
        if (bytes > maxBytes) {
          await reader.cancel();
          return {
            ok: false,
            status: 502,
            error: "IRIS response is too large; narrow the query.",
          };
        }
        chunks.push(value);
      }
      let decoded;
      try {
        decoded = JSON.parse(Buffer.concat(chunks).toString());
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
    } catch {
      return { ok: false, status: 503, error: apiError(503) };
    } finally {
      clearTimeout(timeout);
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      // Blocks foreign browser origins and DNS rebinding against a local admin tool.
      if (req.headers.host !== new URL(origin).host)
        return reply(res, 403, { error: "Unexpected host." });
      if (req.headers.origin && req.headers.origin !== origin)
        return reply(res, 403, { error: "Unexpected origin." });
      const url = new URL(req.url, origin);
      if (files[url.pathname] && req.method === "GET") {
        const [name, mime] = files[url.pathname];
        res.writeHead(200, {
          "Content-Type": mime + "; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(await readFile(resolve(publicDir, name)));
        return;
      }
      if (!url.pathname.startsWith("/api/"))
        return reply(res, 404, { error: "Not found." });
      if (
        req.method !== "GET" &&
        (!req.headers["content-type"]?.startsWith("application/json") ||
          req.headers.origin !== origin)
      )
        return reply(res, 403, {
          error: "Same-origin JSON requests required.",
        });
      const sid = req.headers.cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("relay_session="))
        ?.slice(14);
      const session = sessions.get(sid);
      if (url.pathname === "/api/login" && req.method === "POST") {
        const key = req.socket.remoteAddress;
        const throttle = failures.get(key);
        if (throttle?.until > Date.now() && throttle.count >= 5)
          return reply(res, 429, {
            error: "Too many failed sign-ins. Try again in five minutes.",
          });
        const credentials = await body(req);
        if (
          typeof credentials.username !== "string" ||
          typeof credentials.password !== "string" ||
          !credentials.username ||
          !credentials.password ||
          credentials.username.includes(":")
        )
          return reply(res, 400, {
            error: "Enter your IRIS username and password.",
          });
        const info = await upstream(credentials, "/info");
        if (!info.ok) {
          if (info.status === 401)
            failures.set(key, {
              count: (throttle?.until > Date.now() ? throttle.count : 0) + 1,
              until: Date.now() + 300000,
            });
          return reply(res, info.status, { error: info.error });
        }
        const check = await upstream(credentials, "/v2/tasks?maxRows=1");
        if (check.status === 404)
          return reply(res, 409, {
            error:
              "This IRIS instance does not expose API v2. Use a compatible IRIS 2026.2 instance.",
          });
        if (check.status === 503)
          return reply(res, 503, { error: check.error });
        failures.delete(key);
        if (sid) sessions.delete(sid);
        const id = randomBytes(32).toString("hex");
        const csrf = randomBytes(24).toString("hex");
        sessions.set(id, {
          credentials: {
            username: credentials.username,
            password: credentials.password,
          },
          info: info.data,
          csrf,
          expires: Date.now() + sessionLifetime,
          plans: new Map(),
        });
        return reply(
          res,
          200,
          { info: info.data, csrf, resources, server: target.origin },
          {
            "Set-Cookie": `relay_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${origin.startsWith("https:") ? "; Secure" : ""}`,
          },
        );
      }
      if (!session || session.expires < Date.now()) {
        if (sid) sessions.delete(sid);
        return reply(res, 401, { error: "Sign in to your IRIS instance." });
      }
      if (req.method !== "GET" && req.headers["x-relay-csrf"] !== session.csrf)
        return reply(res, 403, { error: "Invalid request token." });
      if (url.pathname === "/api/session" && req.method === "GET")
        return reply(res, 200, {
          info: session.info,
          csrf: session.csrf,
          resources,
          server: target.origin,
        });
      if (url.pathname === "/api/logout" && req.method === "POST") {
        sessions.delete(sid);
        return reply(
          res,
          200,
          { ok: true },
          {
            "Set-Cookie":
              "relay_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          },
        );
      }
      if (
        ["/api/logs/sources", "/api/logs/page"].includes(url.pathname) &&
        req.method === "GET"
      ) {
        const source = url.searchParams.get("source") || "runtime",
          cursor = url.searchParams.get("cursor") || "";
        if (
          !/^(runtime|console|system-monitor|alerts)(\.[1-3])?$/.test(source) ||
          cursor.length > 1024 ||
          !/^[A-Za-z0-9_=-]*$/.test(cursor)
        )
          return reply(res, 400, { error: "Invalid log source or cursor." });
        const list = url.pathname.endsWith("sources");
        const result = await upstream(
          session.credentials,
          list
            ? "/log-sources"
            : "/logs?" + new URLSearchParams({ source, cursor }),
          "GET",
          undefined,
          "/api/relay",
        );
        if (!result.ok)
          return reply(res, result.status, { error: result.error });
        if (result.data.error)
          return reply(res, 409, { error: result.data.error });
        return reply(
          res,
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
      if (url.pathname === "/api/audit/query" && req.method === "POST")
        return reply(
          res,
          202,
          await startAudit(session, await body(req), upstream),
        );
      if (url.pathname === "/api/audit/result" && req.method === "GET")
        return reply(
          res,
          200,
          await readAudit(session, url.searchParams.get("id"), upstream),
        );
      if (url.pathname === "/api/explorer/catalog" && req.method === "GET")
        return reply(res, 200, { operations, server: target.origin });
      if (url.pathname === "/api/explorer/run" && req.method === "POST") {
        const input = await body(req);
        const query = buildQuery(input.operation, input.parameters);
        const started = performance.now();
        const result = await upstream(session.credentials, query.path);
        return reply(res, result.ok ? 200 : result.status, {
          ...result,
          ...query,
          resource: "explorer",
          observedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started),
        });
      }
      if (url.pathname === "/api/manage/details" && req.method === "GET") {
        const state = await managementState(
          session,
          url.searchParams.get("kind"),
          url.searchParams.get("name"),
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
        return reply(res, 200, visible);
      }
      if (url.pathname === "/api/manage/preview" && req.method === "POST")
        return reply(
          res,
          200,
          await previewManagement(
            session,
            await body(req),
            upstream,
            target.origin,
          ),
        );
      if (url.pathname === "/api/manage/apply" && req.method === "POST")
        return reply(
          res,
          200,
          await applyManagement(session, (await body(req)).token, upstream),
        );
      if (url.pathname === "/api/tasks/preview" && req.method === "POST") {
        const { taskId, action } = await body(req);
        if (
          !Number.isSafeInteger(taskId) ||
          taskId < 1 ||
          !["suspend", "resume"].includes(action)
        )
          return reply(res, 400, {
            error: "Choose a valid task and supported action.",
          });
        const tasks = await upstream(session.credentials, "/v2/tasks");
        if (!tasks.ok) return reply(res, tasks.status, { error: tasks.error });
        const task = Array.isArray(tasks.data)
          ? tasks.data.find((t) => t.Id === taskId)
          : null;
        if (!task) return reply(res, 404, { error: "Task not found." });
        if (task.Type !== "User")
          return reply(res, 403, {
            error:
              "Relay only changes user-defined tasks. System tasks are protected.",
          });
        const detail = await upstream(
          session.credentials,
          `/v2/task/info?id=${taskId}`,
        );
        if (!detail.ok)
          return reply(res, detail.status, { error: detail.error });
        if (typeof detail.data.Suspended !== "boolean")
          return reply(res, 502, {
            error: "Task suspension state could not be verified.",
          });
        task.Suspended = detail.data.Suspended;
        const desired = action === "suspend";
        if (task.Suspended === desired)
          return reply(res, 409, {
            error: "This task is already in the requested state.",
          });
        // One outstanding plan per session, expiring in two minutes.
        session.plans.clear();
        const token = randomBytes(24).toString("hex");
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
        return reply(res, 200, { ...plan, server: target.origin });
      }
      if (url.pathname === "/api/tasks/apply" && req.method === "POST") {
        const { token } = await body(req),
          plan = session.plans.get(token);
        if (!plan || plan.kind || plan.expires < Date.now())
          return reply(res, 409, {
            error:
              "Review this change again; the preview expired or was already used.",
          });
        session.plans.delete(token);
        const before = await upstream(session.credentials, "/v2/tasks");
        if (!before.ok)
          return reply(res, before.status, { error: before.error });
        const task = Array.isArray(before.data)
          ? before.data.find((t) => t.Id === plan.taskId)
          : null;
        const detail = await upstream(
          session.credentials,
          `/v2/task/info?id=${plan.taskId}`,
        );
        if (!detail.ok)
          return reply(res, detail.status, { error: detail.error });
        if (
          !task ||
          task.Type !== "User" ||
          task.Name !== plan.name ||
          detail.data.Suspended !== plan.before
        )
          return reply(res, 409, {
            error:
              "Task state changed since the preview. Refresh and review again.",
          });
        const result = await upstream(
          session.credentials,
          `/v2/task/${plan.action}?id=${plan.taskId}`,
          "POST",
          plan.action === "suspend" ? { LeaveInQueue: true } : undefined,
        );
        if (!result.ok)
          return reply(res, result.status, {
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
        return reply(res, 200, {
          accepted: true,
          verified: observed?.Suspended === plan.desired,
          task: observed ?? null,
          observedAt: new Date().toISOString(),
        });
      }
      if (url.pathname.startsWith("/api/resource/") && req.method === "GET") {
        const id = url.pathname.slice("/api/resource/".length),
          resource = resources[id];
        if (!Object.hasOwn(resources, id))
          return reply(res, 404, { error: "Unknown resource." });
        if (resource.virtual)
          return reply(res, 400, {
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
          if (result.data.error)
            return reply(res, 409, { error: result.data.error });
          const { rows, ...metadata } = result.data;
          if (!Array.isArray(rows))
            return reply(res, 502, {
              error: "Runtime log response is invalid.",
            });
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
        return reply(res, result.ok ? 200 : result.status, {
          ...result,
          resource: id,
          observedAt: new Date().toISOString(),
          limit: resource.table ? resource.limit || 100 : null,
        });
      }
      return reply(res, 404, { error: "Not found." });
    } catch (e) {
      reply(res, e.status ?? 500, {
        error: e.status ? e.message : "An internal error occurred.",
      });
    }
  });
  server.on("close", () => {
    clearInterval(cleanup);
    sessions.clear();
  });
  return server;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 8787),
    origin = `http://127.0.0.1:${port}`;
  createApp({ irisUrl: process.env.IRIS_URL, origin }).listen(
    port,
    "127.0.0.1",
    () => console.log(`IRIS Relay: ${origin}`),
  );
}
