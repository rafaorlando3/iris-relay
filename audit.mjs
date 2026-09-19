import { randomBytes } from "node:crypto";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const check = (r) => {
  if (!r.ok) fail(r.status, r.error);
  return r;
};
const terminal = new Set(["Finished", "Failed", "Canceled"]);
export function auditParameters(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "Invalid audit filters.");
  if (
    Object.keys(input).some(
      (k) => !["username", "begin", "end", "maxRows"].includes(k),
    )
  )
    fail(400, "Unsupported audit filter.");
  const maxRows = input.maxRows ?? 100;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100)
    fail(400, "Choose between 1 and 100 audit records.");
  const query = new URLSearchParams({
    ascending: "0",
    maxRows: String(maxRows),
  });
  for (const [key, param] of [
    ["begin", "beginDateTime"],
    ["end", "endDateTime"],
  ]) {
    const value = input[key];
    if (value === undefined || value === "") continue;
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    )
      fail(
        400,
        "Use an IRIS local date and time in YYYY-MM-DD HH:mm:ss format.",
      );
    const date = new Date(value.replace(" ", "T") + "Z");
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 19) !== value.replace(" ", "T")
    )
      fail(400, "Invalid audit date.");
    query.set(param, value);
  }
  if (input.begin && input.end && input.begin > input.end)
    fail(400, "Begin must precede end.");
  if (input.username !== undefined && input.username !== "") {
    if (
      typeof input.username !== "string" ||
      input.username.length > 128 ||
      /[\x00-\x1f\x7f]/.test(input.username)
    )
      fail(400, "Invalid user filter.");
    query.set("usernames", input.username);
  }
  return {
    path: "/v2/security/audit/records?" + query,
    limit: maxRows,
    filters: Object.fromEntries(query),
  };
}
export function asyncId(location) {
  if (
    typeof location !== "string" ||
    !location.startsWith("/") ||
    location.startsWith("//")
  )
    fail(502, "IRIS did not provide a valid query status reference.");
  const u = new URL(location, "http://local.invalid");
  if (
    !/^\/(?:[^/]+\/)?api\/admin\/v[12]\/async-result$/.test(u.pathname) ||
    u.hash ||
    u.searchParams.size !== 1 ||
    !/^\d{1,40}$/.test(u.searchParams.get("id") || "")
  )
    fail(502, "IRIS returned an unsupported query status reference.");
  return u.searchParams.get("id");
}
export async function readAudit(session, id, upstream) {
  const job = session.auditJob;
  if (!job || id !== job.id)
    fail(404, "This audit query does not belong to this session.");
  const response = check(
    await upstream(
      session.credentials,
      "/v2/async-result?" + new URLSearchParams({ id: job.irisId }),
    ),
  );
  const result = response.data;
  if (
    result.TaskName !== "POST /v2/security/audit/records" ||
    !["Queued", "Running", "Finished", "Failed", "Canceled", "Paused"].includes(
      result.State,
    )
  )
    fail(502, "Unexpected audit query result.");
  job.terminal = terminal.has(result.State);
  const output = {
    id: job.id,
    state: result.State,
    complete: result.State === "Finished",
    resource: "audit",
    observedAt: new Date().toISOString(),
    limit: job.limit,
    filters: job.filters,
  };
  if (result.State === "Finished") {
    if (!Array.isArray(result.Result))
      fail(502, "Completed audit response did not contain records.");
    const fields = [
      "SystemID",
      "AuditIndex",
      "TimeStamp",
      "UTCTimeStamp",
      "EventSource",
      "EventType",
      "Event",
      "Username",
      "Description",
      "Namespace",
      "Status",
    ];
    output.data = result.Result.slice(0, job.limit).map((row) =>
      Object.fromEntries(
        fields.filter((k) => Object.hasOwn(row, k)).map((k) => [k, row[k]]),
      ),
    );
    output.note =
      "Audit summaries only. EventData, session identifiers and network details are excluded. Free text can still contain sensitive data.";
  } else if (result.State === "Failed" || result.State === "Canceled")
    output.error =
      "IRIS " +
      result.State.toLowerCase() +
      " this audit query. No complete records are available.";
  return output;
}
export async function startAudit(session, input, upstream) {
  const query = auditParameters(input);
  if (session.auditStarting) fail(409, "An audit query is already starting.");
  session.auditStarting = true;
  try {
    if (session.auditJob && !session.auditJob.terminal) {
      const existing = await readAudit(session, session.auditJob.id, upstream);
      if (!session.auditJob.terminal) return { ...existing, reused: true };
    }
    const result = check(
      await upstream(session.credentials, query.path, "POST", {}),
    );
    if (result.status !== 202)
      fail(502, "IRIS did not acknowledge an asynchronous audit query.");
    const irisId = asyncId(result.location);
    session.auditJob = {
      id: randomBytes(24).toString("hex"),
      irisId,
      limit: query.limit,
      filters: query.filters,
      terminal: false,
    };
    return {
      id: session.auditJob.id,
      state: "Queued",
      complete: false,
      resource: "audit",
      filters: query.filters,
      limit: query.limit,
    };
  } finally {
    session.auditStarting = false;
  }
}
