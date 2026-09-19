// Explicit fictional data for the static walkthrough. No fetch, credentials or IRIS connection.
const definitions = {
  overview: { label: "System overview", area: "Overview" },
  webapps: { label: "Web applications", area: "Web applications" },
  users: { label: "Users", area: "Permissions" },
  roles: { label: "Roles", area: "Permissions" },
  tls: { label: "TLS configurations", area: "Security" },
  oauthResources: { label: "OAuth resource servers", area: "Security" },
  tasks: { label: "Scheduled tasks", area: "Tasks" },
  runtime: { label: "Runtime log", area: "Logs" },
};
export function createDemoAPI() {
  const data = {
    overview: {
      Status: { UpTime: "3d 04h (sample)" },
      Alerts: { SeriousAlerts: 0, ApplicationErrors: 0 },
      Licensing: { LicenseUse: 2, LicenseLimit: 8 },
      Scenario:
        "A teammate asks you to resume the report task and document the handover.",
    },
    webapps: [
      {
        Name: "/sample-reports",
        NameSpace: "USER",
        Enabled: true,
        IsSystemApp: false,
      },
    ],
    users: [
      {
        Name: "SampleReviewer",
        Enabled: false,
        Roles: [],
        FullName: "Fictional review account",
      },
    ],
    roles: [
      {
        Name: "SampleReadOnly",
        Description: "Sample read access",
        Resources: [{ Name: "SampleReports", Permissions: "R" }],
        GrantedRoles: [],
        EscalationOnly: false,
      },
    ],
    tls: [
      {
        Name: "SampleTLS",
        Description: "Fictional outbound connection",
        Enabled: true,
        TLSMinVersion: 16,
        TLSMaxVersion: 32,
        VerifyPeer: 1,
        Type: 0,
      },
    ],
    oauthResources: [
      {
        Name: "SampleOAuth",
        Description: "Fictional integration",
        Enabled: false,
        IssuerEndpoint: "https://issuer.example.invalid",
        Audiences: ["sample-api"],
        ScopeRequiredToConnect: "reports.read",
      },
    ],
    tasks: [
      {
        Id: 1000,
        Name: "Sample daily report",
        Type: "User",
        Suspended: true,
        StateSource: "Fictional sample",
      },
    ],
    runtime: [
      {
        Time: "Sample 09:00",
        Level: 0,
        Message: "Fictional report task is suspended. Review before resuming.",
      },
      {
        Time: "Sample 09:01",
        Level: 0,
        Message:
          "Use baseline comparison and export a handover after the simulation.",
      },
    ],
  };
  let plan = null;
  const session = {
    demo: true,
    info: {
      username: "Demo operator",
      serverVersion: "Fictional IRIS 2026.2 sample",
    },
    resources: definitions,
    server: "Offline sample. No IRIS connection.",
    csrf: "not-a-credential",
  };
  const error = (message) => {
    throw Object.assign(new Error(message), { status: 400 });
  };
  return async (path, method = "GET", input) => {
    const url = new URL(path, "https://demo.invalid");
    if (url.pathname === "/api/session") return structuredClone(session);
    if (url.pathname === "/api/logout") return { ok: true };
    if (url.pathname.startsWith("/api/resource/")) {
      const resource = url.pathname.split("/").pop();
      if (!Object.hasOwn(data, resource))
        error("This section is not included in the walkthrough.");
      return {
        resource,
        data: structuredClone(data[resource]),
        observedAt: new Date().toISOString(),
        limit: 100,
        demo: true,
      };
    }
    if (url.pathname === "/api/manage/details") {
      const kind = url.searchParams.get("kind"),
        name = url.searchParams.get("name"),
        key =
          { rolePolicy: "roles", oauthSettings: "oauthResources" }[kind] ||
          kind;
      const row = data[key]?.find((r) => r.Name === name);
      if (!row) error("Unknown sample.");
      return {
        kind,
        name,
        data: structuredClone(row),
        editable: true,
        impact: "Simulation only. No server or permissions will change.",
        owners: { ok: true, data: [] },
      };
    }
    if (url.pathname === "/api/tasks/preview") {
      const row = data.tasks.find((t) => t.Id === input.taskId);
      if (!row) error("Unknown sample task.");
      plan = {
        name: row.Name,
        kind: "tasks",
        taskId: row.Id,
        action: input.action,
        before: row.Suspended,
        desired: input.action === "suspend",
        token: "sample-review",
        server: session.server,
      };
      return structuredClone(plan);
    }
    if (url.pathname === "/api/manage/preview") {
      const key =
          { rolePolicy: "roles", oauthSettings: "oauthResources" }[
            input.kind
          ] || input.kind,
        row = data[key]?.find((r) => r.Name === input.name);
      if (!row) error("Unknown sample.");
      const desired =
        input.configuration ||
        ("enabled" in input
          ? { Enabled: input.enabled }
          : { Roles: input.roles });
      plan = {
        name: input.name,
        kind: input.kind,
        key,
        before: structuredClone(row),
        desired: structuredClone(desired),
        token: "sample-review",
        server: session.server,
        impact: "Simulation only. No IRIS request will be sent.",
      };
      return structuredClone(plan);
    }
    if (["/api/tasks/apply", "/api/manage/apply"].includes(url.pathname)) {
      if (!plan || input.token !== plan.token)
        error("Review a sample change first.");
      const p = plan;
      plan = null;
      if (p.kind === "tasks")
        data.tasks.find((t) => t.Id === p.taskId).Suspended = p.desired;
      else
        Object.assign(
          data[p.key].find((r) => r.Name === p.name),
          p.desired,
        );
      return {
        accepted: true,
        verified: false,
        simulated: true,
        name: p.name,
        kind: p.kind,
        before: p.before,
        desired: p.desired,
        observedAt: new Date().toISOString(),
      };
    }
    error("This action is not available in the offline walkthrough.");
  };
}
