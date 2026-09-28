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
  const size = (bytes) =>
    bytes >= 1048576
      ? (bytes / 1048576).toFixed(1) + " MiB"
      : bytes >= 1024
        ? Math.round(bytes / 1024) + " KiB"
        : bytes + " bytes";
  const current = document.createElement("optgroup"),
    archived = document.createElement("optgroup");
  current.label = "Current logs and numbered rotations";
  archived.label = "Archived rotations (messages.old_*)";
  for (const source of sources.sources) {
    const option = el(
      "option",
      source.archived
        ? `${source.name} · ${size(source.bytes)} · last written ${new Date(source.modified).toLocaleString()}`
        : `${source.name} · ${source.available ? size(source.bytes) : source.status}`,
    );
    option.value = source.id;
    option.disabled = !source.available;
    (source.archived ? archived : current).append(option);
  }
  select.append(current);
  if (archived.children.length) select.append(archived);
  const archivedCount = archived.children.length;
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
      `Fixed IRIS text sources, up to three numbered rotations and ${archivedCount ? archivedCount + " archived messages.old_* rotation" + (archivedCount === 1 ? "" : "s") : "no archived messages.old_* rotations"} found in the manager directory${sources.archivedOmitted ? ` (${sources.archivedOmitted} older not listed; newest ${sources.archiveLimit} shown)` : ""}. Each page contains at most 64 KiB / 150 lines. Audit, task history and journal inventory have their own sections.`,
    ),
    status,
    results,
  );
  root.append(similaritySearch(api, active));
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

// Similarity search across every indexed text log, ranked by IRIS VECTOR_COSINE.
function similaritySearch(api, active) {
  const box = el("section"),
    form = el("form"),
    query = el("input"),
    run = el("button", "Search all logs"),
    refresh = el("button", "Refresh index"),
    status = el("p"),
    results = el("div");
  box.className = "vector-search";
  box.append(
    el("h3", "Search all logs by similarity"),
    el(
      "p",
      "Finds lines with similar wording across the current logs and the archived messages.old_* files, ranked inside IRIS with VECTOR_COSINE. Repeats of the same message are grouped. The index keeps up to 3,000 recent lines per file and 20,000 in total; it is a cache rebuilt from the files, not an audit.",
    ),
  );
  query.type = "search";
  query.maxLength = 200;
  query.required = true;
  query.placeholder = "For example: journal switch, license exceeded, certificate expires";
  query.setAttribute("aria-label", "Search all logs by similarity");
  run.type = "submit";
  run.className = "primary";
  refresh.type = "button";
  form.className = "toolbar";
  form.append(query, run, refresh);
  box.append(form, status, results);
  let busy = false;
  const lock = (on) => {
    busy = on;
    run.disabled = refresh.disabled = query.disabled = on;
  };
  async function reindex() {
    status.textContent = "Updating the index from the log files…";
    const r = await api("/api/logs/index", "POST", {});
    const problems = r.problems?.length
      ? ` ${r.problems.length} file(s) not indexed: ${r.problems.map((p) => p.source + " (" + p.status + ")").join("; ")}.`
      : "";
    status.textContent = `Index: ${r.totalLines} lines from ${r.files} files. ${r.indexedLines} lines updated, ${r.unchangedFiles} files unchanged.${problems}`;
    return r;
  }
  function render(r) {
    results.replaceChildren();
    if (!r.rows.length) {
      results.append(el("p", "No similar lines found."));
      return;
    }
    const table = el("table"),
      head = el("tr");
    for (const h of ["Similarity", "Message", "Seen", "Files", "Time", "Level"])
      head.append(el("th", h));
    table.append(head);
    for (const row of r.rows) {
      const tr = el("tr"),
        message = el("td", row.Message + (row.Contains ? "  [contains your text]" : ""));
      message.className = "message-cell";
      tr.append(
        el("td", row.Score.toFixed(3)),
        message,
        el("td", `${row.Occurrences}× in ${row.Files.length} file${row.Files.length === 1 ? "" : "s"}`),
        el("td", row.Files.join(", ")),
        el("td", row.Time || "Not reported"),
        el("td", row.Level ?? "Not reported"),
      );
      table.append(tr);
    }
    results.append(table);
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    lock(true);
    try {
      await reindex();
      if (!active()) return;
      const r = await api(
        "/api/logs/search?" + new URLSearchParams({ q: query.value.trim(), limit: "15" }),
      );
      if (!active()) return;
      status.textContent += ` ${r.rows.length} result group(s) among the ${r.candidates} closest lines.`;
      render(r);
    } catch (error) {
      if (active()) {
        results.replaceChildren();
        status.textContent = error.message;
      }
    } finally {
      if (active()) lock(false);
    }
  });
  refresh.addEventListener("click", async () => {
    if (busy) return;
    lock(true);
    try {
      await reindex();
    } catch (error) {
      if (active()) status.textContent = error.message;
    } finally {
      if (active()) lock(false);
    }
  });
  return box;
}
