// Selective management of existing configurations. Never echo private fields.
import { randomBytes } from "node:crypto";
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const checked = (r) => {
  if (!r.ok) fail(r.status, r.error);
  return r.data;
};
const stable = (x) =>
  JSON.stringify(
    x && typeof x === "object"
      ? Array.isArray(x)
        ? x.map((v) => JSON.parse(stable(v)))
        : Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, JSON.parse(stable(x[k]))]),
          )
      : x,
  );
export const configurationKinds = {
  tls: {
    path: "/v2/security/ssl-configuration",
    fields: [
      "Description",
      "Enabled",
      "TLSMinVersion",
      "TLSMaxVersion",
      "VerifyPeer",
    ],
    impact:
      "Changes the TLS policy used by connections that reference this configuration. Certificate files, private keys and cipher settings are preserved.",
  },
  rolePolicy: {
    path: "/v2/security/role",
    fields: ["Description", "Resources"],
    impact:
      "Changes resource permissions for every account or role inheriting this role. Inherited roles and escalation settings are preserved.",
  },
  oauthSettings: {
    path: "/v2/security/oauth2/resource-server",
    fields: [
      "Description",
      "Enabled",
      "IssuerEndpoint",
      "Audiences",
      "ScopeRequiredToConnect",
    ],
    impact:
      "Changes accepted issuer, audiences and required scope. Existing clients may lose access. No discovery or authentication request is made by Relay.",
  },
};
const string = (v, label, max = 256, required = false) => {
  if (
    typeof v !== "string" ||
    v.length > max ||
    /[\x00-\x1f\x7f]/.test(v) ||
    (required && !v.trim())
  )
    fail(400, `Invalid ${label}.`);
  return v;
};
const project = (kind, data) =>
  Object.fromEntries(configurationKinds[kind].fields.map((k) => [k, data[k]]));
export async function configurationState(session, kind, name, upstream) {
  if (!Object.hasOwn(configurationKinds, kind))
    fail(400, "Unsupported configuration.");
  string(name, "configuration name", 256, true);
  const path =
    configurationKinds[kind].path + "?" + new URLSearchParams({ name });
  const data = checked(await upstream(session.credentials, path));
  if (!data || Array.isArray(data) || typeof data !== "object")
    fail(502, "Invalid configuration response.");
  const editable =
    !/^(?:[%_]|ISC[.])/i.test(name) &&
    configurationKinds[kind].fields.every((k) => Object.hasOwn(data, k)) &&
    !(kind === "rolePolicy" && data.EscalationOnly !== false);
  return {
    kind,
    name,
    path,
    data,
    editable,
    reason: editable
      ? ""
      : "Built-in, escalation-only or incomplete configurations are protected.",
    impact: configurationKinds[kind].impact,
  };
}
async function desiredConfiguration(session, kind, input, current, upstream) {
  if (
    !input ||
    Array.isArray(input) ||
    typeof input !== "object" ||
    Object.keys(input).some((k) => !configurationKinds[kind].fields.includes(k))
  )
    fail(400, "Unsupported configuration fields.");
  const desired = {
      Description: string(input.Description, "description", 512),
    },
    dependencies = [];
  if (kind === "rolePolicy") {
    if (!Array.isArray(input.Resources) || input.Resources.length > 100)
      fail(400, "Use up to 100 resources.");
    desired.Resources = [];
    for (const resource of input.Resources) {
      if (!resource || typeof resource !== "object")
        fail(400, "Invalid resource.");
      const name = string(resource.Name, "resource name", 256, true);
      if (
        !/^[%A-Za-z][%A-Za-z0-9_]*$/.test(name) ||
        name.toLowerCase() === "%all"
      )
        fail(400, "Invalid resource name.");
      if (
        typeof resource.Permissions !== "string" ||
        !/^[RWU]{1,3}$/.test(resource.Permissions) ||
        new Set(resource.Permissions).size !== resource.Permissions.length
      )
        fail(400, "Resource permissions must use R, W and/or U once each.");
      if (desired.Resources.some((r) => r.Name === name))
        fail(400, "Duplicate resource.");
      const definition = checked(
        await upstream(
          session.credentials,
          "/v2/security/resource?" + new URLSearchParams({ name }),
        ),
      );
      dependencies.push({ name, definition });
      desired.Resources.push({
        Name: name,
        Permissions: [..."RWU"]
          .filter((p) => resource.Permissions.includes(p))
          .join(""),
      });
    }
    desired.Resources.sort((a, b) => a.Name.localeCompare(b.Name));
  } else {
    if (typeof input.Enabled !== "boolean")
      fail(400, "Choose enabled or disabled.");
    desired.Enabled = input.Enabled;
    if (kind === "tls") {
      if (
        ![16, 32].includes(input.TLSMinVersion) ||
        ![16, 32].includes(input.TLSMaxVersion) ||
        input.TLSMinVersion > input.TLSMaxVersion
      )
        fail(400, "Use a valid TLS 1.2 / TLS 1.3 range.");
      if (![0, 1].includes(current.Type))
        fail(502, "Unknown TLS configuration type.");
      // Never weaken peer verification through this editor.
      if (
        !(current.Type === 0 ? [1] : [1, 3]).includes(input.VerifyPeer) ||
        input.VerifyPeer < current.VerifyPeer
      )
        fail(
          400,
          "Peer verification must remain enabled and cannot be weakened.",
        );
      Object.assign(desired, {
        TLSMinVersion: input.TLSMinVersion,
        TLSMaxVersion: input.TLSMaxVersion,
        VerifyPeer: input.VerifyPeer,
      });
    } else {
      const issuer = string(input.IssuerEndpoint, "issuer", 2048, true);
      let url;
      try {
        url = new URL(issuer);
      } catch {
        fail(400, "Use an HTTPS issuer URL.");
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        fail(
          400,
          "Use an HTTPS issuer URL without credentials, query or fragment.",
        );
      const definitions = checked(
        await upstream(
          session.credentials,
          "/v2/security/oauth2/client/server-definitions?maxRows=100",
        ),
      );
      const definition =
        Array.isArray(definitions) &&
        definitions.find((d) => d.IssuerEndpoint === issuer);
      if (!definition) fail(400, "Choose an existing OAuth issuer from IRIS.");
      dependencies.push(definition);
      if (
        !Array.isArray(input.Audiences) ||
        input.Audiences.length < 1 ||
        input.Audiences.length > 25
      )
        fail(400, "Specify 1 to 25 accepted audiences.");
      desired.IssuerEndpoint = issuer;
      desired.Audiences = [
        ...new Set(
          input.Audiences.map((a) => string(a, "audience", 256, true)),
        ),
      ].sort();
      desired.ScopeRequiredToConnect = string(
        input.ScopeRequiredToConnect,
        "required scope",
        256,
        true,
      );
    }
  }
  return { desired, dependency: stable(dependencies) };
}
export async function previewConfiguration(session, input, upstream, server) {
  const state = await configurationState(
    session,
    input.kind,
    input.name,
    upstream,
  );
  if (!state.editable) fail(403, state.reason);
  const { desired, dependency } = await desiredConfiguration(
    session,
    input.kind,
    input.configuration,
    state.data,
    upstream,
  );
  const before = project(input.kind, state.data);
  if (stable(before) === stable(desired))
    fail(409, "There are no changes to apply.");
  const plan = {
    kind: input.kind,
    name: input.name,
    path: state.path,
    before,
    desired,
    dependency,
    snapshot: stable(state.data),
    token: randomBytes(24).toString("hex"),
    expires: Date.now() + 120000,
    configuration: true,
  };
  session.plans.clear();
  session.plans.set(plan.token, plan);
  return {
    kind: plan.kind,
    name: plan.name,
    token: plan.token,
    before,
    desired,
    expires: plan.expires,
    server,
    impact: state.impact,
  };
}
export async function applyConfiguration(session, token, upstream) {
  const plan = session.plans.get(token);
  if (!plan?.configuration || plan.expires < Date.now())
    fail(
      409,
      "Review this change again; the preview expired or was already used.",
    );
  session.plans.delete(token);
  const state = await configurationState(
    session,
    plan.kind,
    plan.name,
    upstream,
  );
  if (!state.editable || stable(state.data) !== plan.snapshot)
    fail(409, "Configuration changed since review. Refresh and review again.");
  const fresh = await desiredConfiguration(
    session,
    plan.kind,
    plan.desired,
    state.data,
    upstream,
  );
  if (fresh.dependency !== plan.dependency)
    fail(409, "A referenced resource or issuer changed. Review again.");
  const result = await upstream(
    session.credentials,
    plan.path,
    "PUT",
    plan.desired,
  );
  if (!result.ok)
    fail(
      result.status,
      result.error +
        " The change may have reached IRIS. Refresh before retrying.",
    );
  const after = await upstream(session.credentials, plan.path);
  const observed =
    after.ok && after.data && typeof after.data === "object"
      ? project(plan.kind, after.data)
      : null;
  return {
    accepted: true,
    verified: observed !== null && stable(observed) === stable(plan.desired),
    kind: plan.kind,
    name: plan.name,
    before: plan.before,
    desired: plan.desired,
    observed,
    observedAt: new Date().toISOString(),
  };
}
