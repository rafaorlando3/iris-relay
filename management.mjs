import { randomBytes } from "node:crypto";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const requireResult = (r) => {
  if (!r.ok) fail(r.status, r.error);
  return r.data;
};
const canonical = (x) =>
  JSON.stringify(
    x && typeof x === "object"
      ? Array.isArray(x)
        ? x.map((v) => JSON.parse(canonical(v)))
        : Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, JSON.parse(canonical(x[k]))]),
          )
      : x,
  );
const names = (v) =>
  Array.isArray(v) &&
  v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 256);
const normalizedRoles = (v) => [...new Set(v)].sort();
const protectedUser = (name, session) =>
  /^[%_]/.test(name) ||
  [
    "admin",
    "superuser",
    "cspsystem",
    "iam",
    "irisowner",
    "unknownuser",
    session.credentials.username,
    session.info.username,
  ].some((n) => n?.toLowerCase() === name.toLowerCase());

export async function managementState(session, kind, name, upstream) {
  if (
    ![
      "webapps",
      "users",
      "roles",
      "collections",
      "certificates",
      "oauthResources",
    ].includes(kind) ||
    typeof name !== "string" ||
    !name ||
    name.length > 256
  )
    fail(400, "Select a valid application, user or role.");
  const endpoint = {
    webapps: "/v2/web-app",
    users: "/v2/security/user",
    roles: "/v2/security/role",
    collections: "/v2/wallet/collection",
    certificates: "/v2/security/x509-credential",
    oauthResources: "/v2/security/oauth2/resource-server",
  }[kind];
  const path =
    endpoint +
    "?" +
    new URLSearchParams(kind === "certificates" ? { alias: name } : { name });
  const data = requireResult(await upstream(session.credentials, path));
  if (!data || typeof data !== "object" || Array.isArray(data))
    fail(502, "IRIS returned invalid details.");
  let editable = true,
    reason = "";
  if (kind === "webapps") {
    const apps = requireResult(
      await upstream(
        session.credentials,
        "/v2/web-apps?" + new URLSearchParams({ filter: name, maxRows: "100" }),
      ),
    );
    const app = Array.isArray(apps) ? apps.find((a) => a.Name === name) : null;
    if (
      !name.startsWith("/") ||
      /^\/(api\/(admin|relay)(\/|$)|csp\/sys(\/|$))/i.test(name) ||
      String(data.NameSpace).toUpperCase() === "%SYS" ||
      app?.IsSystemApp !== false ||
      String(app?.Type).split(",").includes("System")
    ) {
      editable = false;
      reason = "System applications and the Relay connection are protected.";
    }
    if (typeof data.Enabled !== "boolean") {
      editable = false;
      reason = "The current application state is unavailable.";
    }
  }
  if (
    kind === "users" &&
    (protectedUser(name, session) ||
      !names(data.Roles) ||
      data.Roles.some((r) => r.toLowerCase() === "%all"))
  ) {
    editable = false;
    reason =
      "Your current account, built-in accounts and full administrator accounts are protected.";
  }
  if (
    kind === "collections" &&
    (/^[%_]/.test(name) ||
      typeof data.EditResource !== "string" ||
      typeof data.UseResource !== "string")
  ) {
    editable = false;
    reason =
      "System collections or collections without a verifiable access policy are protected.";
  }
  if (
    kind === "certificates" &&
    (/^[%_]/.test(name) || !names(data.OwnerList))
  ) {
    editable = false;
    reason =
      "System credentials or credentials without a readable owner list are protected.";
  }
  if (
    kind === "oauthResources" &&
    (/^[%_]/.test(name) || typeof data.Enabled !== "boolean")
  ) {
    editable = false;
    reason =
      "System OAuth configurations or configurations without a readable state are protected.";
  }
  if (kind === "roles") {
    editable = false;
    reason =
      "Role definitions are inspected here; assign existing roles from Users.";
  }
  return { kind, name, path, data, editable, reason };
}

async function validateRoles(session, roles, upstream) {
  if (!names(roles) || roles.length > 100)
    fail(400, "Select up to 100 existing roles.");
  const result = normalizedRoles(roles);
  if (result.some((r) => ["%all", "%manager"].includes(r.toLowerCase())))
    fail(403, "Full administrator grants are not supported in Relay.");
  const definitions = [];
  for (const name of result) {
    const r = await upstream(
      session.credentials,
      "/v2/security/role?" + new URLSearchParams({ name }),
    );
    if (!r.ok) fail(r.status, r.error);
    definitions.push({ name, data: r.data });
    if (r.data.EscalationOnly === true)
      fail(400, "An escalation-only role cannot be assigned as a normal role.");
  }
  return { roles: result, fingerprint: canonical(definitions) };
}

async function validatePolicy(session, policy, upstream) {
  const desired = {},
    definitions = [];
  for (const key of ["EditResource", "UseResource"]) {
    const value = policy?.[key];
    if (
      typeof value !== "string" ||
      !/^[%A-Za-z][%A-Za-z0-9_]*:(READ|WRITE|USE)$/.test(value)
    )
      fail(400, "Use an existing resource followed by :READ, :WRITE or :USE.");
    const name = value.split(":")[0];
    const definition = requireResult(
      await upstream(
        session.credentials,
        "/v2/security/resource?" + new URLSearchParams({ name }),
      ),
    );
    if (typeof definition.PublicPermission !== "string")
      fail(502, "Resource access could not be verified.");
    if (definition.PublicPermission !== "")
      fail(
        403,
        "Resources with public permissions cannot protect a collection in Relay.",
      );
    desired[key] = value;
    definitions.push({ name, definition });
  }
  return { desired, fingerprint: canonical(definitions) };
}

async function validateOwners(session, owners, upstream) {
  if (!names(owners) || owners.length === 0 || owners.length > 25)
    fail(
      400,
      "Choose between 1 and 25 existing owners. An empty list would allow all users.",
    );
  const values = normalizedRoles(owners),
    definitions = [];
  for (const name of values) {
    if (["unknownuser", "_public"].includes(name.toLowerCase()))
      fail(403, "Anonymous accounts cannot be credential owners in Relay.");
    const user = requireResult(
      await upstream(
        session.credentials,
        "/v2/security/user?" + new URLSearchParams({ name }),
      ),
    );
    if (user.Enabled !== true)
      fail(400, "Each selected owner must be an enabled IRIS user.");
    definitions.push({ name, user });
  }
  return { values, fingerprint: canonical(definitions) };
}

export async function previewManagement(session, input, upstream, server) {
  const { kind, name } = input;
  if (
    ![
      "webapps",
      "users",
      "collections",
      "certificates",
      "oauthResources",
    ].includes(kind)
  )
    fail(400, "Unsupported change.");
  const state = await managementState(session, kind, name, upstream);
  if (!state.editable) fail(403, state.reason);
  let before, desired, payload, roleFingerprint;
  if (["webapps", "oauthResources"].includes(kind)) {
    if (typeof input.enabled !== "boolean")
      fail(400, "Choose enabled or disabled.");
    before = { Enabled: state.data.Enabled };
    desired = { Enabled: input.enabled };
  } else if (kind === "certificates") {
    before = { OwnerList: normalizedRoles(state.data.OwnerList) };
    const checked = await validateOwners(session, input.owners, upstream);
    desired = { OwnerList: checked.values };
    roleFingerprint = checked.fingerprint;
  } else if (kind === "collections") {
    before = {
      EditResource: state.data.EditResource,
      UseResource: state.data.UseResource,
    };
    const checked = await validatePolicy(session, input.policy, upstream);
    desired = checked.desired;
    roleFingerprint = checked.fingerprint;
  } else {
    before = { Roles: normalizedRoles(state.data.Roles) };
    const checked = await validateRoles(session, input.roles, upstream);
    desired = { Roles: checked.roles };
    roleFingerprint = checked.fingerprint;
  }
  if (canonical(before) === canonical(desired))
    fail(409, "There are no changes to apply.");
  payload = desired;
  const token = randomBytes(24).toString("hex");
  const plan = {
    kind,
    name,
    path: state.path,
    token,
    before,
    desired,
    payload,
    snapshot: canonical(state.data),
    roleFingerprint,
    expires: Date.now() + 120000,
  };
  session.plans.clear();
  session.plans.set(token, plan);
  return { kind, name, token, before, desired, expires: plan.expires, server };
}

export async function applyManagement(session, token, upstream) {
  const plan = session.plans.get(token);
  if (
    !plan ||
    ![
      "webapps",
      "users",
      "collections",
      "certificates",
      "oauthResources",
    ].includes(plan.kind) ||
    plan.expires < Date.now()
  )
    fail(
      409,
      "Review this change again; the preview expired or was already used.",
    );
  session.plans.delete(token);
  const state = await managementState(session, plan.kind, plan.name, upstream);
  if (!state.editable || canonical(state.data) !== plan.snapshot)
    fail(
      409,
      "The configuration changed since your preview. Refresh and review again.",
    );
  if (
    plan.kind === "users" &&
    (await validateRoles(session, plan.desired.Roles, upstream)).fingerprint !==
      plan.roleFingerprint
  )
    fail(
      409,
      "A selected role changed since your preview. Inspect it and review again.",
    );
  if (
    plan.kind === "collections" &&
    (await validatePolicy(session, plan.desired, upstream)).fingerprint !==
      plan.roleFingerprint
  )
    fail(409, "A protection resource changed since the preview. Review again.");
  if (
    plan.kind === "certificates" &&
    (await validateOwners(session, plan.desired.OwnerList, upstream))
      .fingerprint !== plan.roleFingerprint
  )
    fail(409, "A selected owner changed since the preview. Review again.");
  const result = await upstream(
    session.credentials,
    plan.path,
    "PUT",
    plan.payload,
  );
  if (!result.ok)
    fail(
      result.status,
      result.error +
        " The change may have reached IRIS. Refresh before trying again.",
    );
  const after = await upstream(session.credentials, plan.path);
  let observed = null;
  if (
    after.ok &&
    ["webapps", "oauthResources"].includes(plan.kind) &&
    typeof after.data.Enabled === "boolean"
  )
    observed = { Enabled: after.data.Enabled };
  if (after.ok && plan.kind === "users" && names(after.data.Roles))
    observed = { Roles: normalizedRoles(after.data.Roles) };
  if (
    after.ok &&
    plan.kind === "collections" &&
    typeof after.data.EditResource === "string" &&
    typeof after.data.UseResource === "string"
  )
    observed = {
      EditResource: after.data.EditResource,
      UseResource: after.data.UseResource,
    };
  if (after.ok && plan.kind === "certificates" && names(after.data.OwnerList))
    observed = { OwnerList: normalizedRoles(after.data.OwnerList) };
  return {
    accepted: true,
    verified:
      observed !== null && canonical(observed) === canonical(plan.desired),
    kind: plan.kind,
    name: plan.name,
    before: plan.before,
    desired: plan.desired,
    observed,
    observedAt: new Date().toISOString(),
  };
}
