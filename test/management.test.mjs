import { test } from "node:test";
import assert from "node:assert/strict";
import {
  managementState,
  previewManagement,
  applyManagement,
} from "../management.mjs";

function setup() {
  const state = {
    certificate: { OwnerList: ["Operator"], PeerNames: [], CAFile: "" },
    oauth: {
      Enabled: false,
      IssuerEndpoint: "https://example.invalid",
      Audiences: ["demo"],
      ScopeRequiredToConnect: "demo",
    },
    collection: { EditResource: "Wallet:USE", UseResource: "Wallet:USE" },
    resource: { PublicPermission: "", Description: "Private resource" },
    app: {
      NameSpace: "USER",
      Enabled: false,
      AutheEnabled: 32,
      Resource: "%Admin_Operate",
    },
    user: {
      Enabled: false,
      Roles: [],
      FullName: "Example",
      EscalationRoles: [],
    },
    role: {
      Resources: [{ Name: "Example", Permissions: "R" }],
      GrantedRoles: [],
      EscalationOnly: false,
    },
    system: false,
    writes: [],
    denied: false,
    failReadback: false,
    ignoreWrite: false,
  };
  const session = {
    credentials: { username: "Operator" },
    info: { username: "Operator" },
    plans: new Map(),
  };
  const upstream = async (c, path, method = "GET", payload) => {
    if (state.denied)
      return { ok: false, status: 403, error: "IRIS denied permission." };
    const route = path.split("?")[0];
    const data = route.endsWith("/x509-credential")
      ? state.certificate
      : route.endsWith("/resource-server")
        ? state.oauth
        : route.endsWith("/collection")
          ? state.collection
          : route.endsWith("/resource")
            ? state.resource
            : route.endsWith("/web-app")
              ? state.app
              : route.endsWith("/user")
                ? state.user
                : route.endsWith("/role")
                  ? state.role
                  : [{ Name: "/demo", IsSystemApp: state.system }];
    if (method === "PUT") {
      state.writes.push({ path, payload: structuredClone(payload) });
      if (!state.ignoreWrite) Object.assign(data, structuredClone(payload));
    } else if (state.failReadback && state.writes.length)
      return { ok: false, status: 503, error: "Unavailable" };
    return { ok: true, data: structuredClone(data) };
  };
  const preview = (input) =>
    previewManagement(session, input, upstream, "http://127.0.0.1:52785");
  const apply = (token) => applyManagement(session, token, upstream);
  return { state, session, upstream, preview, apply };
}
const appChange = { kind: "webapps", name: "/demo", enabled: true };
const rolesChange = { kind: "users", name: "Example", roles: ["Reader"] };
const status = (expected) => (e) => e.status === expected;

test("application edit sends only Enabled, verifies readback, consumes token", async () => {
  const { state, preview, apply } = setup();
  const plan = await preview(appChange);
  assert.equal(state.writes.length, 0);
  assert.deepEqual(plan.before, { Enabled: false });
  assert.equal((await apply(plan.token)).verified, true);
  assert.deepEqual(state.writes[0].payload, { Enabled: true });
  assert.equal(state.app.AutheEnabled, 32);
  await assert.rejects(apply(plan.token), status(409));
  assert.equal(state.writes.length, 1);
});
test("system application, unknown system classification and connection endpoints cannot be changed", async () => {
  const { state, preview } = setup();
  for (const name of [
    "/api/admin",
    "/api/relay",
    "/api/admin/nested",
    "/csp/sys",
  ])
    await assert.rejects(preview({ ...appChange, name }), status(403));
  state.system = true;
  await assert.rejects(preview(appChange), status(403));
  state.system = undefined;
  await assert.rejects(preview(appChange), status(403));
  state.system = false;
  state.app.NameSpace = "%SYS";
  await assert.rejects(preview(appChange), status(403));
  assert.equal(state.writes.length, 0);
});
test("role changes preserve profile and escalation fields, reject administrative and escalation-only grants", async () => {
  const { state, preview, apply } = setup();
  const plan = await preview({ ...rolesChange, roles: ["Reader", "Reader"] });
  assert.deepEqual(plan.desired, { Roles: ["Reader"] });
  assert.equal((await apply(plan.token)).verified, true);
  assert.deepEqual(state.writes[0].payload, { Roles: ["Reader"] });
  assert.equal(state.user.Enabled, false);
  assert.deepEqual(state.user.EscalationRoles, []);
  await assert.rejects(
    preview({ ...rolesChange, roles: ["%All"] }),
    status(403),
  );
  state.role.EscalationOnly = true;
  await assert.rejects(
    preview({ ...rolesChange, roles: ["Escalation"] }),
    status(400),
  );
});
test("self, built-in and full administrator accounts are protected", async () => {
  const { state, preview } = setup();
  for (const name of [
    "Operator",
    "operator",
    "_SYSTEM",
    "%service",
    "Admin",
    "UnknownUser",
    "CSPSystem",
    "IAM",
    "irisowner",
  ])
    await assert.rejects(preview({ ...rolesChange, name }), status(403));
  state.user.Roles = ["%All"];
  await assert.rejects(preview(rolesChange), status(403));
  assert.equal(state.writes.length, 0);
});
test("configuration drift and role definition drift invalidate preview before write", async () => {
  for (const kind of ["webapps", "users"]) {
    const { state, preview, apply } = setup();
    const plan = await preview(kind === "webapps" ? appChange : rolesChange);
    if (kind === "webapps") state.app.AutheEnabled = 64;
    else state.role.Resources[0].Permissions = "RW";
    await assert.rejects(apply(plan.token), status(409));
    assert.equal(state.writes.length, 0);
  }
});
test("IRIS refusal, no-op, malformed, expired and foreign plans do not write", async () => {
  const { state, preview, apply, session } = setup();
  await assert.rejects(preview({ ...appChange, enabled: false }), status(409));
  await assert.rejects(preview({ ...appChange, enabled: "true" }), status(400));
  await assert.rejects(
    preview({ ...rolesChange, roles: "Reader" }),
    status(400),
  );
  await assert.rejects(preview({ ...rolesChange, roles: [null] }), status(400));
  await assert.rejects(
    preview({ ...appChange, kind: "__proto__" }),
    status(400),
  );
  const p = await preview(appChange);
  session.plans.get(p.token).expires = 0;
  await assert.rejects(apply(p.token), status(409));
  session.plans.set("task-token", {
    taskId: 1000,
    expires: Date.now() + 10000,
  });
  await assert.rejects(apply("task-token"), status(409));
  state.denied = true;
  await assert.rejects(preview(appChange), status(403));
  assert.equal(state.writes.length, 0);
});
test("HTTP acceptance without matching readback is never shown as verified", async () => {
  for (const failure of ["failReadback", "ignoreWrite"]) {
    const { state, preview, apply } = setup();
    const p = await preview(appChange);
    state[failure] = true;
    const r = await apply(p.token);
    assert.equal(r.accepted, true);
    assert.equal(r.verified, false);
  }
});
test("role inspection remains read-only and does not need an editable user", async () => {
  const { state, session, upstream } = setup();
  const role = await managementState(session, "roles", "Reader", upstream);
  assert.equal(role.editable, false);
  assert.deepEqual(role.data.Resources, state.role.Resources);
  assert.equal(state.writes.length, 0);
});

test("wallet policy change uses real resource validation and verifies both permissions", async () => {
  const { state, preview, apply } = setup();
  const policy = { EditResource: "Wallet:USE", UseResource: "Operate:USE" };
  const plan = await preview({ kind: "collections", name: "Demo", policy });
  assert.equal(state.writes.length, 0);
  const result = await apply(plan.token);
  assert.equal(result.verified, true);
  assert.deepEqual(state.writes[0].payload, policy);
  await assert.rejects(apply(plan.token), status(409));
});
test("wallet cannot use public resources or overwrite a changed protection resource", async () => {
  const { state, preview, apply } = setup();
  const input = {
    kind: "collections",
    name: "Demo",
    policy: { EditResource: "Wallet:USE", UseResource: "Operate:USE" },
  };
  const plan = await preview(input);
  state.resource.PublicPermission = "R";
  await assert.rejects(apply(plan.token), status(403));
  await assert.rejects(preview(input), status(403));
  assert.equal(state.writes.length, 0);
});
test("wallet rejects empty, malformed and system collection policies", async () => {
  const { state, preview } = setup();
  for (const value of [
    "",
    "Wallet",
    "Wallet:ADMIN",
    "Wallet:READ,WRITE",
    "x&name=public:USE",
  ])
    await assert.rejects(
      preview({
        kind: "collections",
        name: "Demo",
        policy: { EditResource: value, UseResource: "Wallet:USE" },
      }),
      status(400),
    );
  await assert.rejects(
    preview({
      kind: "collections",
      name: "%System",
      policy: { EditResource: "Wallet:USE", UseResource: "Operate:USE" },
    }),
    status(403),
  );
  assert.equal(state.writes.length, 0);
});

test("certificate owners are validated and only OwnerList is written", async () => {
  const { state, preview, apply } = setup();
  state.user.Enabled = true;
  const plan = await preview({
    kind: "certificates",
    name: "Demo",
    owners: ["Operator", "Viewer"],
  });
  assert.equal((await apply(plan.token)).verified, true);
  assert.deepEqual(state.writes[0].payload, {
    OwnerList: ["Operator", "Viewer"],
  });
  assert.deepEqual(state.certificate.PeerNames, []);
  await assert.rejects(
    preview({ kind: "certificates", name: "Demo", owners: [] }),
    status(400),
  );
  await assert.rejects(
    preview({ kind: "certificates", name: "Demo", owners: ["UnknownUser"] }),
    status(403),
  );
  state.user.Enabled = false;
  await assert.rejects(
    preview({ kind: "certificates", name: "Demo", owners: ["Viewer"] }),
    status(400),
  );
});
test("certificate owner changes invalidate review; system aliases are protected", async () => {
  const { state, preview, apply } = setup();
  state.user.Enabled = true;
  const plan = await preview({
    kind: "certificates",
    name: "Demo",
    owners: ["Viewer"],
  });
  state.user.FullName = "Changed";
  await assert.rejects(apply(plan.token), status(409));
  await assert.rejects(
    preview({ kind: "certificates", name: "%System", owners: ["Viewer"] }),
    status(403),
  );
  assert.equal(state.writes.length, 0);
});
test("OAuth availability changes preserve issuer, audiences and required scope", async () => {
  const { state, preview, apply } = setup();
  const original = structuredClone(state.oauth);
  const plan = await preview({
    kind: "oauthResources",
    name: "Demo",
    enabled: true,
  });
  assert.equal((await apply(plan.token)).verified, true);
  assert.deepEqual(state.writes[0].payload, { Enabled: true });
  assert.deepEqual(state.oauth, { ...original, Enabled: true });
  const plan2 = await preview({
    kind: "oauthResources",
    name: "Demo",
    enabled: false,
  });
  state.oauth.Audiences = ["different"];
  await assert.rejects(apply(plan2.token), status(409));
  assert.equal(state.writes.length, 1);
});
