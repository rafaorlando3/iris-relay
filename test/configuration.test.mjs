import { test } from "node:test";
import assert from "node:assert/strict";
import {
  managementState,
  previewManagement,
  applyManagement,
} from "../management.mjs";
function setup(kind = "tls") {
  const data =
    kind === "tls"
      ? {
          Description: "Demo",
          Enabled: true,
          TLSMinVersion: 16,
          TLSMaxVersion: 32,
          VerifyPeer: 1,
          Type: 0,
          CAFile: "unchanged",
          PrivateKeyFile: "[REDACTED]",
        }
      : kind === "rolePolicy"
        ? {
            Description: "Demo",
            Resources: [],
            GrantedRoles: [],
            EscalationOnly: false,
          }
        : {
            Description: "Demo",
            Enabled: false,
            IssuerEndpoint: "https://issuer.invalid",
            Audiences: ["demo"],
            ScopeRequiredToConnect: "demo",
            Authenticator: { Implementation: "preserved" },
          };
  const session = {
      credentials: { username: "Operator" },
      info: { username: "Operator" },
      plans: new Map(),
    },
    writes = [],
    dependency = { Description: "Resource", PublicPermission: "" };
  let deny = false,
    ignore = false;
  const upstream = async (c, path, method = "GET", payload) => {
    if (deny) return { ok: false, status: 403, error: "Denied" };
    if (path.includes("server-definitions"))
      return {
        ok: true,
        data: [{ IssuerEndpoint: "https://issuer.invalid", ...dependency }],
      };
    if (path.includes("/resource?"))
      return { ok: true, data: structuredClone(dependency) };
    if (method === "PUT") {
      writes.push(payload);
      if (!ignore) Object.assign(data, structuredClone(payload));
    }
    return { ok: true, data: structuredClone(data) };
  };
  const fields =
    kind === "tls"
      ? [
          "Description",
          "Enabled",
          "TLSMinVersion",
          "TLSMaxVersion",
          "VerifyPeer",
        ]
      : kind === "rolePolicy"
        ? ["Description", "Resources"]
        : [
            "Description",
            "Enabled",
            "IssuerEndpoint",
            "Audiences",
            "ScopeRequiredToConnect",
          ];
  const input = {
    kind,
    name: "Demo",
    configuration: Object.fromEntries(
      fields.map((k) => [k, structuredClone(data[k])]),
    ),
  };
  input.configuration.Description = "Revised";
  return {
    data,
    session,
    writes,
    dependency,
    input,
    upstream,
    preview: (i = input) => previewManagement(session, i, upstream, "lab"),
    apply: (t) => applyManagement(session, t, upstream),
    deny: () => (deny = true),
    ignore: () => (ignore = true),
  };
}
test("TLS, role policy and OAuth changes write only reviewed fields, verify and reject replay", async () => {
  for (const kind of ["tls", "rolePolicy", "oauthSettings"]) {
    const s = setup(kind);
    const p = await s.preview();
    assert.equal(s.writes.length, 0);
    assert.equal((await s.apply(p.token)).verified, true);
    assert.deepEqual(s.writes[0], s.input.configuration);
    await assert.rejects(s.apply(p.token), { status: 409 });
    if (kind === "tls") assert.equal(s.data.CAFile, "unchanged");
    if (kind === "rolePolicy") assert.deepEqual(s.data.GrantedRoles, []);
    if (kind === "oauthSettings")
      assert.equal(s.data.Authenticator.Implementation, "preserved");
  }
});
test("TLS refuses obsolete protocol, inverted range, disabling peer verification and unknown fields", async () => {
  const s = setup();
  for (const delta of [
    { TLSMinVersion: 8 },
    { TLSMinVersion: 32, TLSMaxVersion: 16 },
    { VerifyPeer: 0 },
    { PrivateKeyFile: "/tmp/evil" },
  ])
    await assert.rejects(
      s.preview({
        ...s.input,
        configuration: { ...s.input.configuration, ...delta },
      }),
      { status: 400 },
    );
  assert.equal(s.writes.length, 0);
});
test("custom role permissions require existing resources and dependency consistency", async () => {
  const s = setup("rolePolicy");
  s.input.configuration.Resources = [{ Name: "Sample", Permissions: "UR" }];
  const p = await s.preview();
  assert.equal(p.desired.Resources[0].Permissions, "RU");
  s.dependency.PublicPermission = "R";
  await assert.rejects(s.apply(p.token), { status: 409 });
  assert.equal(s.writes.length, 0);
  for (const Permissions of ["", "X", "RR"])
    await assert.rejects(
      s.preview({
        ...s.input,
        configuration: {
          ...s.input.configuration,
          Resources: [{ Name: "Sample", Permissions }],
        },
      }),
      { status: 400 },
    );
});
test("OAuth validates known HTTPS issuer, nonempty audiences and scope without provider contact", async () => {
  const s = setup("oauthSettings");
  for (const delta of [
    { IssuerEndpoint: "http://issuer.invalid" },
    { IssuerEndpoint: "https://unknown.invalid" },
    { Audiences: [] },
    { ScopeRequiredToConnect: "" },
  ])
    await assert.rejects(
      s.preview({
        ...s.input,
        configuration: { ...s.input.configuration, ...delta },
      }),
      { status: 400 },
    );
  const p = await s.preview();
  s.dependency.Description = "Changed";
  await assert.rejects(s.apply(p.token), { status: 409 });
  assert.equal(s.writes.length, 0);
});
test("configuration edits protect system targets, expire plans, enforce permissions and reject state drift", async () => {
  const s = setup();
  await assert.rejects(s.preview({ ...s.input, name: "%System" }), {
    status: 403,
  });
  const p = await s.preview();
  s.data.CAFile = "external change";
  await assert.rejects(s.apply(p.token), { status: 409 });
  const q = await s.preview();
  s.session.plans.get(q.token).expires = 0;
  await assert.rejects(s.apply(q.token), { status: 409 });
  s.deny();
  await assert.rejects(s.preview(), { status: 403 });
  assert.equal(s.writes.length, 0);
});
test("accepted configuration write with mismatched readback remains unverified", async () => {
  const s = setup();
  const p = await s.preview();
  s.ignore();
  const r = await s.apply(p.token);
  assert.equal(r.accepted, true);
  assert.equal(r.verified, false);
});
