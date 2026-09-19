import { mountAudit } from "./audit-ui.js";
import { mountExplorer } from "./explorer-ui.js";
import { changesBetween, handoverMarkdown } from "./reports.js";
const $ = (id) => document.getElementById(id);
let session = null,
  current = "overview",
  loaded = null,
  baseline = null,
  requestId = 0;
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
async function api(path, method = "GET", data) {
  const r = await fetch(path, {
    method,
    headers:
      method === "GET"
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Relay-CSRF": session?.csrf || "",
          },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const v = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(v.error || "Request failed"), {
      status: r.status,
    });
  return v;
}
function connected(data) {
  session = data;
  $("login-panel").hidden = true;
  $("workspace").hidden = false;
  $("logout").hidden = false;
  $("connection").textContent = data.info.username + " · " + data.server;
  $("nav").replaceChildren();
  for (const [id, r] of Object.entries(data.resources)) {
    const b = el("button", r.label);
    b.dataset.id = id;
    const allowed = r.privileges?.some(
      (p) => data.info.privileges?.[p]?.use === true,
    );
    if (allowed === false) {
      b.append(el("small", "Restricted", "restricted"));
      b.title = "Your IRIS account does not report the required permission.";
    }
    b.addEventListener("click", () => {
      current = id;
      load();
    });
    $("nav").append(b);
  }
  load();
}
function disconnected() {
  session = null;
  loaded = null;
  baseline = null;
  requestId++;
  $("login-panel").hidden = false;
  $("workspace").hidden = true;
  $("logout").hidden = true;
  $("nav").replaceChildren();
  $("content").replaceChildren();
  $("diff").replaceChildren();
  $("connection").textContent = "LOCAL WORKSPACE";
  $("notes").value = "";
  $("manage").close();
  $("manage-body").replaceChildren();
  $("review").close();
  pendingChange = null;
}
$("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = e.target.querySelector("button");
  b.disabled = true;
  $("login-error").textContent = "";
  try {
    const data = Object.fromEntries(new FormData(e.target));
    const result = await api("/api/login", "POST", data);
    e.target.reset();
    connected(result);
  } catch (e) {
    $("login-error").textContent = e.message;
  } finally {
    b.disabled = false;
  }
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", "POST", {});
    disconnected();
  } catch (e) {
    $("status").textContent = e.message;
  }
});
$("refresh").addEventListener("click", load);
$("filter").addEventListener("input", render);

async function load() {
  const id = ++requestId;
  loaded = null;
  $("export").disabled = true;
  $("export-json").disabled = true;
  $("baseline").disabled = true;
  $("compare").disabled = true;
  $("changes").hidden = true;
  $("status").className = "";
  $("status").textContent = "Reading live data from IRIS…";
  $("content").replaceChildren(el("p", "Loading…", "empty"));
  $("stats").replaceChildren();
  const r = session.resources[current];
  $("stats").hidden = ["explorer", "audit"].includes(current);
  $("filter").hidden = ["explorer", "audit"].includes(current);
  $("baseline").hidden = ["explorer", "audit"].includes(current);
  $("compare").hidden = ["explorer", "audit"].includes(current);
  $("area").textContent = r.area.toUpperCase();
  $("title").textContent = r.label;
  $("subtitle").textContent = "";
  $("filter").value = "";
  for (const b of $("nav").children)
    b.classList.toggle("active", b.dataset.id === current);
  try {
    if (["explorer", "audit"].includes(current)) {
      const mount = current === "audit" ? mountAudit : mountExplorer;
      await mount(
        $("content"),
        api,
        (result) => {
          if (id !== requestId) return;
          loaded = result;
          $("export").disabled = !result;
          $("export-json").disabled = !result;
          $("status").textContent = result
            ? "Response available for handover export. Sensitive-looking structured fields are redacted."
            : current === "audit"
              ? "Choose filters and query the audit log."
              : "Choose an operation and inspect its live response.";
        },
        () => id === requestId && !!session,
      );
      return;
    }
    const result = await api("/api/resource/" + current);
    if (id !== requestId) return;
    loaded = result;
    $("status").textContent =
      "Observed " +
      new Date(result.observedAt).toLocaleString() +
      (result.limit
        ? " · Up to " +
          result.limit +
          " rows. Filters apply only to loaded rows."
        : "");
    $("subtitle").textContent = session.info.serverVersion;
    $("export").disabled = false;
    $("export-json").disabled = false;
    $("baseline").disabled = false;
    $("compare").disabled = !baseline || baseline.resource !== current;
    render();
  } catch (e) {
    if (id !== requestId) return;
    $("status").textContent = e.message;
    $("status").className = "error";
    $("content").replaceChildren(
      el("p", "No data available for this request.", "empty"),
    );
    if (e.status === 401) disconnected();
  }
}
function cell(value) {
  if (typeof value === "boolean")
    return el("span", value ? "Yes" : "No", "pill" + (value ? "" : " off"));
  if (value === null || value === undefined || value === "")
    return el("span", "—");
  if (typeof value === "object") {
    const d = el("details");
    d.append(
      el(
        "summary",
        Array.isArray(value) ? value.length + " values" : "Details",
      ),
      el("pre", JSON.stringify(value, null, 2)),
    );
    return d;
  }
  return el("span", String(value));
}
function rows(data) {
  return Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? Object.entries(data).map(([Property, Value]) => ({ Property, Value }))
      : [{ Value: data }];
}
function render() {
  if (!loaded) return;
  const all = rows(loaded.data);
  const q = $("filter").value.toLowerCase();
  const filtered = all.filter((row) =>
    JSON.stringify(row).toLowerCase().includes(q),
  );
  $("stats").replaceChildren();
  const metrics =
    current === "overview"
      ? [
          [
            "UPTIME",
            loaded.data.Status?.UpTime ?? "Unavailable",
            "Reported by IRIS",
          ],
          [
            "SERIOUS ALERTS",
            loaded.data.Alerts?.SeriousAlerts ?? "Unavailable",
            "Application errors: " +
              (loaded.data.Alerts?.ApplicationErrors ?? "Unavailable"),
          ],
          [
            "LICENSE USE",
            loaded.data.Licensing?.LicenseUse ?? "Unavailable",
            "Limit: " + (loaded.data.Licensing?.LicenseLimit ?? "Unavailable"),
          ],
        ]
      : [
          [
            "LOADED RECORDS",
            all.length,
            loaded.limit
              ? "Response capped at " + loaded.limit + " rows"
              : "Returned by IRIS",
          ],
          [
            "IN THIS VIEW",
            filtered.length,
            q ? "Matching your local filter" : "No filter applied",
          ],
          ["CONNECTION", "Live", session.info.username],
        ];
  for (const [label, value, note] of metrics) {
    const box = el("div", undefined, "stat");
    box.append(el("small", label), el("strong", String(value)), el("p", note));
    $("stats").append(box);
  }
  if (!filtered.length) {
    $("content").replaceChildren(
      el(
        "p",
        q
          ? "No loaded rows match this filter."
          : "IRIS returned no records for this section.",
        "empty",
      ),
    );
    return;
  }
  const keys = [...new Set(filtered.flatMap((x) => Object.keys(x)))];
  const table = el("table"),
    thead = el("thead"),
    h = el("tr"),
    tbody = el("tbody");
  for (const key of keys)
    h.append(el("th", key.replace(/([a-z])([A-Z])/g, "$1 $2")));
  if (current === "tasks") h.append(el("th", "Change schedule"));
  if (
    [
      "webapps",
      "users",
      "roles",
      "collections",
      "certificates",
      "oauthResources",
    ].includes(current)
  )
    h.append(el("th", "Inspect / manage", "actions-cell"));
  thead.append(h);
  for (const row of filtered) {
    const tr = el("tr");
    for (const key of keys) {
      const td = el("td");
      if (key === "Message") td.className = "message-cell";
      td.append(cell(row[key]));
      tr.append(td);
    }
    if (current === "tasks") {
      const td = el("td");
      if (row.Type === "User" && typeof row.Suspended === "boolean") {
        const b = el("button", row.Suspended ? "Resume" : "Suspend");
        b.addEventListener("click", () => previewTask(row));
        td.append(b);
      } else
        td.textContent =
          row.Type === "User" ? "State unavailable" : "Protected system task";
      tr.append(td);
    }
    if (
      [
        "webapps",
        "users",
        "roles",
        "collections",
        "certificates",
        "oauthResources",
      ].includes(current)
    ) {
      const td = el("td"),
        button = el("button", current === "roles" ? "Inspect role" : "Manage");
      td.className = "actions-cell";
      const kind = current;
      button.addEventListener("click", () =>
        openManagement(kind, row.Name ?? row.Alias),
      );
      td.append(button);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  $("content").replaceChildren(table);
}
$("baseline").addEventListener("click", () => {
  if (!loaded) return;
  baseline = structuredClone(loaded);
  $("compare").disabled = false;
  $("status").textContent =
    "Baseline captured for " +
    session.resources[current].label +
    " at " +
    new Date(baseline.observedAt).toLocaleTimeString() +
    ". Refresh to compare.";
});
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  return value;
}
$("compare").addEventListener("click", () => {
  if (!loaded || baseline?.resource !== current) return;
  $("changes").hidden = false;
  $("diff").replaceChildren();
  $("baseline-info").textContent =
    "Baseline: " +
    new Date(baseline.observedAt).toLocaleString() +
    " · Current: " +
    new Date(loaded.observedAt).toLocaleString() +
    ". Comparison covers returned rows only.";
  const changes = changesBetween(baseline.data, loaded.data);
  for (const change of changes) {
    const box = el("div", undefined, "diff-item");
    box.append(el("strong", change.kind + ": " + change.id));
    const d = el("details");
    d.append(
      el("summary", "Review before and after"),
      el(
        "pre",
        JSON.stringify({ before: change.before, after: change.after }, null, 2),
      ),
    );
    box.append(d);
    $("diff").append(box);
  }
  if (!changes.length)
    $("diff").append(el("p", "No changes in the returned rows."));
});
function exportHandover(format) {
  if (!loaded) return;
  const bundle = {
    application: "IRIS Relay",
    exportedAt: new Date().toISOString(),
    serverVersion: session.info.serverVersion,
    resource: current,
    notes: $("notes").value,
    note: "Operational metadata, not a complete audit. Review before sharing. Secret-like fields are redacted; free text can still contain sensitive data.",
    observation: loaded,
    baseline: baseline?.resource === current ? baseline : undefined,
  };
  const text =
    format === "json"
      ? JSON.stringify(bundle, null, 2)
      : handoverMarkdown(bundle);
  const url = URL.createObjectURL(
    new Blob([text], {
      type: format === "json" ? "application/json" : "text/markdown",
    }),
  );
  const a = el("a");
  a.href = url;
  a.download =
    "iris-relay-" +
    current +
    "-" +
    new Date().toISOString().slice(0, 10) +
    "." +
    format;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("export").addEventListener("click", () => exportHandover("md"));
$("export-json").addEventListener("click", () => exportHandover("json"));
api("/api/session")
  .then(connected)
  .catch(() => {});

let pendingChange = null;
async function previewTask(row) {
  $("cancel-change").textContent = "Cancel";
  $("review-result").textContent = "";
  try {
    pendingChange = await api("/api/tasks/preview", "POST", {
      taskId: row.Id,
      action: row.Suspended ? "resume" : "suspend",
    });
    pendingChange.endpoint = "/api/tasks/apply";
    $("review-title").textContent = "Review task change";
    $("review-diff").textContent = "";
    $("review-impact").textContent =
      "This changes the task schedule on the connected instance. The state is checked again before applying.";
    $("review-text").textContent =
      (pendingChange.action === "suspend" ? "Suspend" : "Resume") +
      " " +
      pendingChange.name +
      " on " +
      pendingChange.server +
      "?";
    $("apply-change").disabled = false;
    $("review").showModal();
  } catch (e) {
    $("status").textContent = e.message;
    $("status").className = "error";
  }
}
$("cancel-change").addEventListener("click", () => {
  $("review").close();
  pendingChange = null;
});
$("apply-change").addEventListener("click", async () => {
  if (!pendingChange) return;
  $("apply-change").disabled = true;
  try {
    const r = await api(pendingChange.endpoint, "POST", {
      token: pendingChange.token,
    });
    pendingChange = null;
    $("cancel-change").textContent = "Close";
    $("review-result").textContent = r.verified
      ? "Applied and verified in IRIS."
      : "Accepted by IRIS; verification unavailable. Refresh before another change.";
    await load();
  } catch (e) {
    pendingChange = null;
    $("cancel-change").textContent = "Close";
    $("review-result").textContent = e.message;
  }
});

let managementRequest = 0;
async function openManagement(kind, name) {
  const request = ++managementRequest;
  $("manage-title").textContent = name;
  $("manage-body").replaceChildren(el("p", "Reading current configuration…"));
  $("manage").showModal();
  try {
    const state = await api(
      "/api/manage/details?" + new URLSearchParams({ kind, name }),
    );
    let choices = null;
    if (kind === "certificates" && state.editable)
      choices = (await api("/api/resource/users")).data;
    if (kind === "users" && state.editable)
      choices = (await api("/api/resource/roles")).data;
    if (request !== managementRequest || !$("manage").open) return;
    const body = $("manage-body");
    body.replaceChildren();
    const details = el("details");
    details.append(
      el("summary", "Current configuration"),
      el("pre", JSON.stringify(state.data, null, 2)),
    );
    body.append(details);
    if (kind === "collections" && state.inventory) {
      const inventory = el("details");
      inventory.append(
        el("summary", "Secret inventory (names and types only, up to 100)"),
        el(
          "pre",
          state.inventory.ok
            ? JSON.stringify(state.inventory.data, null, 2)
            : state.inventory.error,
        ),
      );
      body.append(inventory);
    }
    if (kind === "certificates" && state.certificate) {
      const cert = el("details");
      cert.append(
        el("summary", "Certificate identity and validity"),
        el(
          "pre",
          state.certificate.ok
            ? JSON.stringify(state.certificate.data, null, 2)
            : state.certificate.error,
        ),
      );
      body.append(cert);
    }
    if (!state.editable) {
      body.append(el("p", state.reason, "muted"));
      details.open = true;
      return;
    }
    const form = el("form"),
      error = el("p", "", "error");
    error.setAttribute("role", "alert");
    let desiredInput;
    if (["webapps", "oauthResources"].includes(kind)) {
      const label = el(
          "label",
          kind === "oauthResources"
            ? "OAuth configuration status"
            : "Application status",
        ),
        select = el("select");
      select.setAttribute(
        "aria-label",
        kind === "oauthResources"
          ? "OAuth configuration status"
          : "Application status",
      );
      for (const [value, text] of [
        ["true", "Enabled"],
        ["false", "Disabled"],
      ]) {
        const option = el("option", text);
        option.value = value;
        select.append(option);
      }
      select.value = String(state.data.Enabled);
      label.append(select);
      form.append(label);
      form.append(
        el(
          "p",
          kind === "oauthResources"
            ? "Enable or disable this stored OAuth resource server configuration. Issuer, audiences, token validation and authentication mappings remain unchanged. This does not test or contact the identity provider."
            : "Disabling an application stops new requests to that application. Authentication and other settings remain unchanged.",
          "muted",
        ),
      );
      desiredInput = () => ({ enabled: select.value === "true" });
    } else if (kind === "certificates") {
      if (!Array.isArray(choices))
        throw new Error("User choices are unavailable.");
      const group = el("fieldset");
      group.append(el("legend", "Credential owners"));
      for (const name of [
        ...new Set([
          ...choices
            .filter(
              (u) =>
                u.Enabled &&
                !["unknownuser", "_public"].includes(u.Name.toLowerCase()),
            )
            .map((u) => u.Name),
          ...state.data.OwnerList,
        ]),
      ].sort()) {
        const label = el("label", undefined, "role-choice"),
          input = el("input");
        input.type = "checkbox";
        input.value = name;
        input.checked = state.data.OwnerList.includes(name);
        label.append(input, el("span", name));
        group.append(label);
      }
      form.append(
        group,
        el(
          "p",
          "Choose at least one enabled user who may use this credential. An empty list would make it available to all users and is blocked. Certificate and private key material stay in IRIS. Choices include up to 100 returned users plus current owners.",
          "muted",
        ),
      );
      desiredInput = () => ({
        owners: [...group.querySelectorAll("input:checked")].map(
          (i) => i.value,
        ),
      });
    } else if (kind === "collections") {
      const inputs = {};
      for (const [key, text] of [
        ["EditResource", "Resource required to edit secrets"],
        ["UseResource", "Resource required to use secrets"],
      ]) {
        const label = el("label", text),
          input = el("input");
        input.required = true;
        input.maxLength = 256;
        input.value = state.data[key];
        input.setAttribute("aria-label", text);
        input.placeholder = "%Admin_Wallet:USE";
        label.append(input);
        form.append(label);
        inputs[key] = input;
      }
      form.append(
        el(
          "p",
          "Format: Resource:READ, Resource:WRITE or Resource:USE. Changing these resources changes who can use or modify the secrets in this collection. Resources with public permissions are blocked. Secret values remain in IRIS.",
          "muted",
        ),
      );
      desiredInput = () => ({
        policy: Object.fromEntries(
          Object.entries(inputs).map(([k, v]) => [k, v.value]),
        ),
      });
    } else {
      if (!Array.isArray(choices))
        throw new Error("Role choices are unavailable.");
      const fieldset = el("fieldset");
      fieldset.append(el("legend", "Directly assigned roles"));
      const available = [
        ...new Set([
          ...choices.filter((r) => !r.EscalationOnly).map((r) => r.Name),
          ...state.data.Roles,
        ]),
      ].sort();
      for (const role of available) {
        if (
          ["%all", "%manager"].includes(role.toLowerCase()) &&
          !state.data.Roles.includes(role)
        )
          continue;
        const label = el("label", undefined, "role-choice"),
          input = el("input");
        input.type = "checkbox";
        input.value = role;
        input.checked = state.data.Roles.includes(role);
        label.append(input, el("span", role));
        fieldset.append(label);
      }
      form.append(
        fieldset,
        el(
          "p",
          "This replaces direct role assignments. Roles may grant administrative access or inherit other roles. Inspect their definitions in Roles before granting access. Escalation roles are unchanged. Choices cover up to 100 returned roles plus current assignments.",
          "muted",
        ),
      );
      desiredInput = () => ({
        roles: [...fieldset.querySelectorAll("input:checked")].map(
          (i) => i.value,
        ),
      });
    }
    const preview = el("button", "Review change", "primary");
    preview.type = "submit";
    form.append(preview, error);
    body.append(form);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      preview.disabled = true;
      error.textContent = "";
      try {
        const plan = await api("/api/manage/preview", "POST", {
          kind,
          name,
          ...desiredInput(),
        });
        if (!session || request !== managementRequest || !$("manage").open)
          return;
        pendingChange = { ...plan, endpoint: "/api/manage/apply" };
        $("manage").close();
        $("review-title").textContent = "Review configuration change";
        $("review-text").textContent = plan.name + " on " + plan.server;
        $("review-diff").textContent = JSON.stringify(
          { before: plan.before, after: plan.desired },
          null,
          2,
        );
        $("review-impact").textContent =
          kind === "certificates"
            ? "This changes who may use the certificate credential. The owner list and users are checked again before applying."
            : kind === "oauthResources"
              ? "This changes the availability of the stored OAuth resource server configuration. No discovery, login or token request is performed."
              : kind === "collections"
                ? "Confirm who can use or edit this collection. The resource definitions and policy are checked again before applying. Secret values are not displayed or changed."
                : kind === "users"
                  ? "Confirm this user's new access. IRIS permissions are enforced, configuration is rechecked, and the result is read back after applying."
                  : "This changes application availability. Configuration is rechecked before applying, then the result is read back from IRIS.";
        $("review-result").textContent = "";
        $("cancel-change").textContent = "Cancel";
        $("apply-change").disabled = false;
        $("review").showModal();
      } catch (e) {
        error.textContent = e.message;
      } finally {
        preview.disabled = false;
      }
    });
  } catch (e) {
    if (request === managementRequest)
      $("manage-body").replaceChildren(el("p", e.message, "error"));
  }
}
$("close-manage").addEventListener("click", () => {
  managementRequest++;
  $("manage").close();
});
$("manage").addEventListener("cancel", () => managementRequest++);
$("review").addEventListener("cancel", () => {
  pendingChange = null;
});
