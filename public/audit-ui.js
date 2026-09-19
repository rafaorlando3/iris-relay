const el = (tag, text) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
};
export function mountAudit(container, api, onResult, isCurrent) {
  const section = el("section");
  section.className = "explorer";
  section.append(
    el(
      "p",
      "Read up to 100 recent audit summaries. IRIS runs this query in the background. Dates use the IRIS server local time. Detailed event payloads and session identifiers are excluded.",
    ),
  );
  const form = el("form"),
    inputs = {};
  for (const [name, labelText, type] of [
    ["username", "User name (optional)", "text"],
    ["begin", "Begin, server local time (optional)", "datetime-local"],
    ["end", "End, server local time (optional)", "datetime-local"],
    ["maxRows", "Maximum records", "number"],
  ]) {
    const label = el("label", labelText),
      input = el("input");
    input.type = type;
    input.name = name;
    input.setAttribute("aria-label", labelText);
    if (name === "maxRows") {
      input.min = 1;
      input.max = 100;
      input.value = 50;
      input.required = true;
    } else input.maxLength = 128;
    label.append(input);
    form.append(label);
    inputs[name] = input;
  }
  const start = el("button", "Query audit log");
  start.type = "submit";
  start.className = "primary";
  form.append(start);
  const check = el("button", "Check query status");
  check.type = "button";
  check.hidden = true;
  const status = el("p");
  status.setAttribute("role", "status");
  const output = el("div");
  section.append(form, status, check, output);
  container.replaceChildren(section);
  onResult(null);
  let job = null,
    busy = false,
    sequence = 0;
  const show = (result) => {
    job = result.id;
    status.className = result.error ? "error" : "";
    status.textContent =
      result.error ||
      (result.complete
        ? "Finished · " +
          result.data.length +
          " returned records · " +
          new Date(result.observedAt).toLocaleString()
        : "Query " +
          result.state.toLowerCase() +
          ". Records are not complete yet.");
    if (result.reused)
      status.textContent +=
        " Continuing your existing query; new filters have not been applied.";
    check.hidden =
      result.complete || ["Failed", "Canceled"].includes(result.state);
    start.disabled = !check.hidden;
    output.replaceChildren();
    if (result.complete) {
      const table = el("table"),
        head = el("thead"),
        header = el("tr"),
        body = el("tbody");
      const columns = [
        ["TimeStamp", "Server time"],
        ["Event", "Event"],
        ["Username", "User"],
        ["Description", "Description"],
        ["Namespace", "Namespace"],
      ];
      for (const [, label] of columns) header.append(el("th", label));
      head.append(header);
      for (const row of result.data) {
        const tr = el("tr");
        for (const [key] of columns)
          tr.append(el("td", String(row[key] ?? "")));
        body.append(tr);
      }
      table.append(head, body);
      output.append(table);
      if (!result.data.length)
        output.append(
          el("p", "IRIS returned no audit summaries for these filters."),
        );
      const raw = el("details");
      raw.append(
        el("summary", "Structured response"),
        el("pre", JSON.stringify(result.data, null, 2)),
      );
      output.append(raw);
      onResult(result);
    }
  };
  async function poll() {
    if (!job || busy || !isCurrent()) return;
    busy = true;
    check.disabled = true;
    try {
      const result = await api(
        "/api/audit/result?" + new URLSearchParams({ id: job }),
      );
      if (isCurrent()) show(result);
    } catch (e) {
      if (isCurrent()) {
        status.textContent = e.message;
        status.className = "error";
        start.disabled = false;
      }
    } finally {
      busy = false;
      check.disabled = false;
    }
  }
  check.addEventListener("click", poll);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const turn = ++sequence;
    busy = true;
    start.disabled = true;
    check.hidden = true;
    output.replaceChildren();
    onResult(null);
    status.textContent = "Starting a bounded audit query…";
    status.className = "";
    const date = (value) =>
      value.length === 16
        ? value.replace("T", " ") + ":00"
        : value.replace("T", " ");
    try {
      const result = await api("/api/audit/query", "POST", {
        username: inputs.username.value,
        begin: date(inputs.begin.value),
        end: date(inputs.end.value),
        maxRows: Number(inputs.maxRows.value),
      });
      if (!isCurrent() || turn !== sequence) return;
      show(result);
      busy = false;
      // Brief bounded polling, then leave an explicit manual status action.
      for (
        let attempt = 0;
        attempt < 6 && !check.hidden && isCurrent();
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!isCurrent() || turn !== sequence) return;
        await poll();
      }
    } catch (e) {
      if (isCurrent()) {
        status.textContent = e.message;
        status.className = "error";
        start.disabled = false;
      }
    } finally {
      busy = false;
    }
  });
}
