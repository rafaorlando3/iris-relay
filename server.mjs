import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { resources } from "./resources.mjs";
import { createUpstream, route, signIn, validCredentials } from "./routes.mjs";
export { DEMO_TARGETS, DEMO_TASK } from "./routes.mjs";

const sessionLifetime = 30 * 60 * 1000;
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

const MAX_SESSIONS = 500;

// RELAY_PUBLIC_ORIGIN: the https origin a reverse proxy serves Relay on (demo hosting).
export function publicOrigin(value) {
  if (!value) return null;
  const u = new URL(value);
  if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash || u.username || u.password)
    throw new Error("RELAY_PUBLIC_ORIGIN must be an https origin such as https://relay-demo.example.");
  return u.origin;
}

export function createApp({
  irisUrl = "http://127.0.0.1:52785",
  origin = "http://127.0.0.1:8787",
  fetcher = fetch,
  demo = null,
  trustProxy = false,
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
  // Behind a reverse proxy every request comes from 127.0.0.1; use the address
  // the proxy appended last (the one it saw), never a client-supplied first entry.
  const clientKey = (req) =>
    (trustProxy &&
      req.headers["x-forwarded-for"]?.split(",").at(-1).trim()) ||
    req.socket.remoteAddress;
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
  // One IRIS request as the operator (shared with the IRIS-served UI, see routes.mjs).
  const upstream = createUpstream({ fetcher, target });

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
      if (url.pathname === "/api/config" && req.method === "GET")
        return reply(
          res,
          200,
          demo
            ? {
                demo: true,
                username: demo.username,
                password: demo.password,
                resetMinutes: demo.resetMinutes,
              }
            : { demo: false },
        );
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
        const key = clientKey(req);
        const throttle = failures.get(key);
        if (throttle?.until > Date.now() && throttle.count >= 5)
          return reply(res, 429, {
            error: "Too many failed sign-ins. Try again in five minutes.",
          });
        const credentials = await body(req);
        if (!validCredentials(credentials))
          return reply(res, 400, {
            error: "Enter your IRIS username and password.",
          });
        if (demo && credentials.username !== demo.username)
          return reply(res, 403, {
            error: `This public demo only accepts the shared account ${demo.username}.`,
          });
        const signed = await signIn(credentials, upstream);
        if (signed.status !== 200) {
          if (signed.status === 401)
            failures.set(key, {
              count: (throttle?.until > Date.now() ? throttle.count : 0) + 1,
              until: Date.now() + 300000,
            });
          return reply(res, signed.status, { error: signed.error });
        }
        failures.delete(key);
        if (sid) sessions.delete(sid);
        const id = randomBytes(32).toString("hex");
        const csrf = randomBytes(24).toString("hex");
        // Bound memory: drop the oldest sessions first (Map keeps insertion order).
        while (sessions.size >= MAX_SESSIONS)
          sessions.delete(sessions.keys().next().value);
        sessions.set(id, {
          credentials: {
            username: credentials.username,
            password: credentials.password,
          },
          info: signed.info,
          csrf,
          expires: Date.now() + sessionLifetime,
          plans: new Map(),
        });
        return reply(
          res,
          200,
          { info: signed.info, csrf, resources, server: target.origin },
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
      const handled = await route(
        {
          method: req.method,
          pathname: url.pathname,
          searchParams: url.searchParams,
          readBody: () => body(req),
        },
        { session, upstream, server: target.origin, demo },
      );
      if (handled) return reply(res, handled.status, handled.data);
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
    origin = publicOrigin(process.env.RELAY_PUBLIC_ORIGIN) || `http://127.0.0.1:${port}`,
    // Loopback by default. The compose file sets 0.0.0.0 inside the container,
    // where Docker publishes the port only on the host's 127.0.0.1.
    host = process.env.RELAY_LISTEN_HOST || "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(host)) {
    console.error("RELAY_LISTEN_HOST must be 127.0.0.1 or 0.0.0.0.");
    process.exit(1);
  }
  const demo =
    process.env.RELAY_DEMO === "1"
      ? {
          username: process.env.RELAY_DEMO_USER || "RelayDemoOperator",
          password: process.env.RELAY_DEMO_PASSWORD,
          resetMinutes: Number(process.env.RELAY_DEMO_RESET_MINUTES || 60),
        }
      : null;
  if (demo && !demo.password) {
    console.error("RELAY_DEMO=1 needs RELAY_DEMO_PASSWORD (the shared demo password shown on the sign-in page).");
    process.exit(1);
  }
  createApp({
    irisUrl: process.env.IRIS_URL,
    origin,
    demo,
    trustProxy: process.env.RELAY_TRUST_PROXY === "1",
  }).listen(port, host, () =>
    console.log(`IRIS Relay: ${origin}${demo ? " (public demo mode)" : ""}`),
  );
}
