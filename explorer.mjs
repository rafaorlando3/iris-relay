import { resources } from "./resources.mjs";

const text = (label, required = true) => ({
  type: "string",
  label,
  required,
  maxLength: 256,
});
const maxRows = {
  type: "integer",
  label: "Maximum rows",
  min: 1,
  max: 100,
  default: 100,
};
export const operations = Object.fromEntries(
  Object.entries(resources)
    .filter(([, r]) => r.path && !r.base)
    .map(([id, r]) => [
      id,
      {
        label: r.label,
        path: r.path,
        method: "GET",
        parameters: r.table ? { maxRows } : {},
        description:
          "Read " +
          r.label.toLowerCase() +
          " from the connected IRIS instance.",
      },
    ]),
);
Object.assign(operations, {
  webapp: {
    label: "Web application details",
    path: "/v2/web-app",
    parameters: { name: text("Application name") },
    description:
      "Inspect one application, including its namespace and authentication configuration.",
  },
  user: {
    label: "User details",
    path: "/v2/security/user",
    parameters: { name: text("User name") },
    description:
      "Inspect profile and direct/escalation role assignments. Credential-like fields are redacted.",
  },
  role: {
    label: "Role definition",
    path: "/v2/security/role",
    parameters: { name: text("Role name") },
    description: "Inspect resources, permissions and inherited roles.",
  },
  securityResources: {
    label: "Security resources",
    path: "/v2/security/resources",
    parameters: { names: text("Resource names or pattern", false), maxRows },
    description: "List named permission resources.",
  },
  collection: {
    label: "Wallet collection policy",
    path: "/v2/wallet/collection",
    parameters: { name: text("Collection name") },
    description:
      "Inspect the resources controlling use and modification of secrets.",
  },
  secretNames: {
    label: "Wallet secret inventory",
    path: "/v2/wallet/secrets",
    parameters: { collection: text("Collection name"), maxRows },
    description:
      "List secret names and types only. This endpoint does not return secret values.",
  },
  certificate: {
    label: "X.509 certificate metadata",
    path: "/v2/security/x509-credential/certificate",
    parameters: { alias: text("Credential alias") },
    description:
      "Inspect certificate identity and validity metadata. Does not export private key material.",
  },
  x509: {
    label: "X.509 credential configuration",
    path: "/v2/security/x509-credential",
    parameters: { alias: text("Credential alias") },
    description: "Inspect ownership and peer configuration.",
  },
  oauthDefinition: {
    label: "OAuth server definition",
    path: "/v2/security/oauth2/client/server-definition",
    parameters: {
      serverId: {
        type: "integer",
        label: "Server ID",
        required: true,
        min: 1,
        max: 2147483647,
      },
    },
    description:
      "Inspect stored issuer and metadata. Does not trigger discovery or contact the issuer.",
  },
  auditEvents: {
    label: "Audit event definitions",
    path: "/v2/security/audit/events",
    parameters: { maxRows },
    description:
      "Inspect configured audit event definitions, not audit records.",
  },
  auditEnabled: {
    label: "Audit status",
    path: "/v2/security/audit/enabled",
    parameters: {},
    description: "Read whether IRIS auditing is enabled.",
  },
});
for (const operation of Object.values(operations)) operation.method = "GET";
export function buildQuery(id, parameters = {}) {
  const fail = (message) => {
    throw Object.assign(new Error(message), { status: 400 });
  };
  if (typeof id !== "string" || !Object.hasOwn(operations, id))
    fail("Choose an operation from the catalog.");
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  )
    fail("Parameters must be an object.");
  const operation = operations[id],
    query = new URLSearchParams();
  for (const key of Object.keys(parameters))
    if (!Object.hasOwn(operation.parameters, key))
      fail("Unsupported parameter: " + key);
  for (const [key, rule] of Object.entries(operation.parameters)) {
    let value = parameters[key];
    if (value === undefined || value === "") value = rule.default;
    if (value === undefined) {
      if (rule.required) fail(rule.label + " is required.");
      continue;
    }
    if (rule.type === "integer") {
      if (
        !["number", "string"].includes(typeof value) ||
        !/^\d+$/.test(String(value))
      )
        fail(rule.label + " must be an integer.");
      value = Number(value);
      if (!Number.isSafeInteger(value) || value < rule.min || value > rule.max)
        fail(
          rule.label +
            " must be between " +
            rule.min +
            " and " +
            rule.max +
            ".",
        );
    } else if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > rule.maxLength ||
      /[\x00-\x1f\x7f]/.test(value)
    )
      fail("Invalid " + rule.label.toLowerCase() + ".");
    query.set(key, String(value));
  }
  return {
    operation: id,
    method: "GET",
    path: operation.path + (query.size ? "?" + query : ""),
    limit: query.has("maxRows") ? Number(query.get("maxRows")) : null,
  };
}
