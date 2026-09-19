const el = (tag, text) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
};
export async function mountLogs(container, api, onResult, active) {
  const root = el("div");
  root.className = "explorer";
  const sources = await api("/api/logs/sources");
  if (!active()) return;
  const label = el("label", "Log source"),
    select = el("select");
  select.setAttribute("aria-label", "Log source");
  for (const source of sources.sources) {
    const option = el(
      "option",
      `${source.name} · ${source.available ? source.bytes + " bytes" : source.status}`,
    );
    option.value = source.id;
    option.disabled = !source.available;
    select.append(option);
  }
  const first = sources.sources.find((s) => s.available);
  if (first) select.value = first.id;
  label.append(select);
  const latest = el("button", "Load latest"),
    older = el("button", "Older records"),
    filter = el("input"),
    status = el("p"),
    results = el("div"),
    tools = el("div");
  filter.type = "search";
  filter.placeholder = "Search this page…";
  filter.setAttribute("aria-label", "Search this log page");
  tools.className = "toolbar";
  tools.append(latest, older, filter);
  older.disabled = true;
  latest.disabled = !first;
  root.append(
    label,
    tools,
    el(
      "p",
      "Fixed IRIS text sources and up to three numbered rotations. Each page contains at most 64 KiB / 150 lines. Audit, task history and journal inventory have their own sections.",
    ),
    status,
    results,
  );
  container.replaceChildren(root);
  let page = null,
    cursor = null,
    busy = false;
  function render() {
    results.replaceChildren();
    if (!page) return;
    const rows = page.data.filter((r) =>
      JSON.stringify(r).toLowerCase().includes(filter.value.toLowerCase()),
    );
    const table = el("table"),
      head = el("tr");
    for (const h of ["Time", "Level", "Message"]) head.append(el("th", h));
    table.append(head);
    for (const r of rows) {
      const tr = el("tr");
      tr.append(
        el("td", r.Time || "Not reported"),
        el("td", r.Level ?? "Not reported"),
        el(
          "td",
          r.Message + (r.MessageTruncated ? " [message shortened]" : ""),
        ),
      );
      table.append(tr);
    }
    results.append(
      rows.length ? table : el("p", "No matching complete lines in this page."),
    );
  }
  async function load(old = false) {
    if (busy) return;
    busy = true;
    latest.disabled = older.disabled = select.disabled = true;
    status.textContent = "Reading log…";
    onResult(null);
    try {
      const result = await api(
        "/api/logs/page?" +
          new URLSearchParams({
            source: select.value,
            ...(old && cursor ? { cursor } : {}),
          }),
      );
      if (!active()) return;
      page = result;
      cursor = result.metadata.nextCursor;
      status.textContent = `${result.data.length} complete lines · ${new Date(result.observedAt).toLocaleString()} · ${cursor ? "Older data available." : "Beginning of file reached."}${result.metadata.longLineSkipped ? " An oversized line fragment was skipped." : ""}`;
      filter.value = "";
      render();
      onResult(result);
    } catch (e) {
      if (!active()) return;
      page = null;
      cursor = null;
      results.replaceChildren();
      status.textContent = e.message;
    } finally {
      busy = false;
      if (active()) {
        latest.disabled = select.disabled = false;
        older.disabled = !cursor;
      }
    }
  }
  latest.addEventListener("click", () => load());
  older.addEventListener("click", () => load(true));
  select.addEventListener("change", () => {
    cursor = null;
    load();
  });
  filter.addEventListener("input", render);
  if (first) await load();
  else {
    status.textContent = "No supported text log is available in this instance.";
    onResult(null);
  }
}
