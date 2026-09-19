const el = (tag, text) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
};
export function configurationForm(form, state) {
  const inputs = {};
  const field = (key, label, options, multiline = false) => {
    const wrap = el("label", label),
      node = el(options ? "select" : multiline ? "textarea" : "input");
    node.setAttribute("aria-label", label);
    if (options)
      for (const [v, t] of options) {
        const o = el("option", t);
        o.value = String(v);
        node.append(o);
      }
    else {
      node.maxLength = key === "Description" ? 512 : 2048;
      if (multiline) node.rows = 4;
    }
    const value = state.data[key];
    node.value = Array.isArray(value) ? value.join("\n") : String(value ?? "");
    inputs[key] = node;
    wrap.append(node);
    form.append(wrap);
    return node;
  };
  field("Description", "Description");
  if (state.kind === "rolePolicy") {
    const help = el(
      "p",
      "Editing this role affects all its holders, including inherited access. System and escalation-only roles cannot be edited. One resource per line: ResourceName:R, ResourceName:RW or ResourceName:U.",
    );
    help.className = "muted";
    form.append(help);
    const area = field("Resources", "Resource permissions", null, true);
    area.value = state.data.Resources.map(
      (r) => `${r.Name}:${r.Permissions}`,
    ).join("\n");
    const impact = el("details");
    impact.append(
      el("summary", "Who holds this role? (up to 100)"),
      el(
        "pre",
        state.owners?.ok
          ? JSON.stringify(state.owners.data, null, 2)
          : state.owners?.error || "Impact inventory unavailable.",
      ),
    );
    form.append(impact);
  } else {
    field("Enabled", "Configuration status", [
      [true, "Enabled"],
      [false, "Disabled"],
    ]);
    if (state.kind === "tls") {
      const options = [
        [16, "TLS 1.2"],
        [32, "TLS 1.3"],
      ];
      field("TLSMinVersion", "Minimum TLS version", options);
      field("TLSMaxVersion", "Maximum TLS version", options);
      const peers =
        state.data.Type === 0
          ? [[1, "Require valid server certificate"]]
          : [
              [1, "Verify client certificate when supplied"],
              [3, "Require valid client certificate"],
            ];
      field("VerifyPeer", "Peer verification", peers);
    } else {
      field("IssuerEndpoint", "Existing issuer URL");
      field("Audiences", "Accepted audiences (one per line)", null, true);
      field("ScopeRequiredToConnect", "Required scope");
    }
  }
  const impact = el("p", state.impact);
  impact.className = "muted";
  form.append(impact);
  return () => ({
    configuration: Object.fromEntries(
      Object.entries(inputs).map(([k, n]) => [
        k,
        k === "Enabled"
          ? n.value === "true"
          : ["TLSMinVersion", "TLSMaxVersion", "VerifyPeer"].includes(k)
            ? Number(n.value)
            : k === "Audiences"
              ? n.value
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean)
              : k === "Resources"
                ? n.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((line) => {
                      const i = line.lastIndexOf(":");
                      return {
                        Name: line.slice(0, i),
                        Permissions: line.slice(i + 1),
                      };
                    })
                : n.value,
      ]),
    ),
  });
}
