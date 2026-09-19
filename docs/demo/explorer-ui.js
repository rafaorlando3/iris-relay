const el = (tag, text) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
};
export async function mountExplorer(container, api, onResult, isCurrent) {
  const catalog = await api("/api/explorer/catalog");
  if (!isCurrent()) return;
  const section = el("section");
  section.className = "explorer";
  section.append(
    el(
      "p",
      "Explore a curated set of read-only IRIS management endpoints. Requests use your current IRIS account and the configured instance. No arbitrary URLs or write methods are accepted.",
    ),
  );
  const form = el("form"),
    label = el("label", "Operation"),
    select = el("select");
  select.setAttribute("aria-label", "API operation");
  for (const [id, op] of Object.entries(catalog.operations)) {
    const option = el("option", op.label);
    option.value = id;
    select.append(option);
  }
  label.append(select);
  const description = el("p"),
    route = el("code"),
    fields = el("div"),
    button = el("button", "Run read-only request");
  button.className = "primary";
  button.type = "submit";
  const output = el("div"),
    status = el("p");
  status.setAttribute("role", "status");
  form.append(label, description, route, fields, button);
  section.append(form, status, output);
  container.replaceChildren(section);
  let sequence = 0;
  const update = () => {
    sequence++;
    button.disabled = false;
    status.textContent = "";
    status.className = "";
    output.replaceChildren();
    onResult(null);
    const op = catalog.operations[select.value];
    description.textContent = op.description;
    route.textContent = "GET /api/admin" + op.path;
    fields.replaceChildren();
    for (const [name, rule] of Object.entries(op.parameters)) {
      const label = el(
          "label",
          rule.label + (rule.required ? " (required)" : ""),
        ),
        input = el("input");
      input.name = name;
      input.required = !!rule.required;
      input.setAttribute("aria-label", rule.label);
      if (rule.type === "integer") {
        input.type = "number";
        input.min = rule.min;
        input.max = rule.max;
        input.step = "1";
      } else {
        input.type = "text";
        input.maxLength = rule.maxLength;
      }
      if (rule.default !== undefined) input.value = rule.default;
      label.append(input);
      fields.append(label);
    }
  };
  select.addEventListener("change", update);
  update();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const request = ++sequence;
    button.disabled = true;
    status.className = "";
    status.textContent = "Reading from IRIS…";
    output.replaceChildren();
    onResult(null);
    const parameters = Object.fromEntries(new FormData(form));
    try {
      const result = await api("/api/explorer/run", "POST", {
        operation: select.value,
        parameters,
      });
      if (!isCurrent() || request !== sequence) return;
      status.textContent =
        "HTTP " +
        result.status +
        " · " +
        result.durationMs +
        " ms · Observed " +
        new Date(result.observedAt).toLocaleString() +
        (result.limit ? " · Up to " + result.limit + " rows" : "");
      output.append(el("pre", JSON.stringify(result.data, null, 2)));
      onResult(result);
    } catch (e) {
      if (isCurrent() && request === sequence) {
        status.textContent =
          "HTTP " + (e.status || "unavailable") + " · " + e.message;
        status.className = "error";
      }
    } finally {
      if (isCurrent() && request === sequence) button.disabled = false;
    }
  });
}
