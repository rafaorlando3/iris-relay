// Deliberate allowlist: the browser cannot provide arbitrary upstream URLs.
export const resources = {
  explorer: { label: "REST explorer", area: "Web applications", virtual: true },
  audit: {
    label: "Audit log",
    area: "Logs",
    virtual: true,
    privileges: ["Secure", "Operate"],
  },
  oauthResources: {
    label: "OAuth resource servers",
    area: "Security",
    path: "/v2/security/oauth2/resource-servers",
    table: true,
    privileges: ["Secure"],
  },
  overview: {
    label: "System overview",
    area: "Overview",
    path: "/v2/monitor/dashboard/main",
  },
  capacity: {
    label: "System resources",
    area: "Operations",
    path: "/v2/monitor/dashboard/system-resources",
  },
  processes: {
    label: "Processes",
    area: "Operations",
    path: "/v2/processes",
    table: true,
  },
  devices: {
    label: "Devices",
    area: "Operations",
    path: "/v2/devices",
    table: true,
  },
  tasks: {
    label: "Scheduled tasks",
    area: "Tasks",
    path: "/v2/tasks",
    table: true,
  },
  history: {
    label: "Task history",
    area: "Logs",
    path: "/v2/task/history",
    table: true,
  },
  runtime: {
    label: "Runtime log",
    area: "Logs",
    path: "/logs",
    base: "/api/relay",
    table: true,
    limit: 150,
  },
  journals: {
    label: "Journal files",
    area: "Logs",
    path: "/v2/journal/files",
    table: true,
  },
  webapps: {
    label: "Web applications",
    area: "Web applications",
    path: "/v2/web-apps",
    table: true,
  },
  roles: {
    label: "Roles",
    area: "Permissions",
    path: "/v2/security/roles",
    table: true,
  },
  users: {
    label: "Users",
    area: "Permissions",
    path: "/v2/security/users",
    table: true,
  },
  collections: {
    label: "Wallet collections",
    area: "Security",
    path: "/v2/wallet/collections",
    table: true,
  },
  certificates: {
    label: "X.509 credentials",
    area: "Security",
    path: "/v2/security/x509-credentials",
    table: true,
  },
  oauth: {
    label: "OAuth servers",
    area: "Security",
    path: "/v2/security/oauth2/client/server-definitions",
    table: true,
  },
};

const privileges = {
  overview: ["Operate"],
  capacity: ["Operate"],
  processes: ["Operate"],
  devices: ["Manage"],
  tasks: ["Operate", "Task"],
  history: ["Operate"],
  runtime: ["Operate"],
  journals: ["Journal"],
  webapps: ["Secure"],
  roles: ["Secure"],
  users: ["Secure"],
  collections: ["Wallet"],
  certificates: ["Secure"],
  oauth: ["OAuth2_Client"],
};
for (const [id, required] of Object.entries(privileges))
  resources[id].privileges = required;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        !(key === "HasPrivateKey" && typeof val === "boolean") &&
        /password|secret|token|privatekey|private_key|authorization/i.test(key)
          ? "[REDACTED]"
          : redact(val),
      ]),
    );
  return value;
}

export function apiError(status) {
  return (
    {
      401: "IRIS authentication expired or was rejected. Sign in again.",
      403: "Your IRIS account does not have permission for this operation.",
      404: "The requested endpoint or record was not found.",
      503: "IRIS is unavailable. Check the local instance.",
    }[status] || `IRIS request failed (HTTP ${status}).`
  );
}
