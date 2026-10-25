// ctx review page. Plain DOM, no framework. Every value from the API is inserted as text
// (never innerHTML), because fact text is written by a model from chat content.

const $main = document.getElementById("main");
const state = { tab: "projects", project: "", selected: "", type: "", view: "review", projects: [], timer: 0 };

// ---------- helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

function ago(ts) {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 90) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** The last ~n characters, starting at a word boundary. */
function tailText(text, n) {
  if (text.length <= n) return text;
  const cut = text.slice(-n);
  return "…" + cut.slice(cut.search(/\s/) + 1);
}

const fmt = (n) => Number(n ?? 0).toLocaleString();

let toastTimer = 0;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

class AuthError extends Error {}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(data.error);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** replaceChildren that skips empty values (it would otherwise print "null"). */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

function show(...nodes) {
  fill($main, ...nodes);
}

function projectSelect(value, onchange, { allowAll = true } = {}) {
  return h(
    "select",
    { "aria-label": "Project", onchange: (e) => onchange(e.target.value) },
    allowAll ? h("option", { value: "" }, "All projects") : h("option", { value: "" }, "Pick a project…"),
    state.projects.map((p) => h("option", { value: p.id, selected: p.id === value }, p.slug)),
  );
}

async function loadProjects() {
  if (!state.projects.length) state.projects = await api("/api/projects");
  return state.projects;
}

// ---------- Projects ----------

async function renderProjects() {
  state.projects = await api("/api/projects");
  const filter = h("input", { type: "search", placeholder: "Filter projects…", "aria-label": "Filter projects", oninput: () => draw() });
  const tableWrap = h("div", { class: "panel" });
  const preview = h("div");

  function draw() {
    const q = filter.value.toLowerCase();
    const rows = state.projects.filter((p) => !q || p.slug.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    fill(tableWrap, 
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Project"), h("th", { class: "num" }, "Sessions"), h("th", { class: "num" }, "Facts"), h("th", { class: "num" }, "Brief"), h("th", { class: "num" }, "Last active"))),
        h(
          "tbody",
          {},
          rows.map((p) =>
            h(
              "tr",
              { class: `click${p.id === state.selected ? " selected" : ""}`, tabindex: "0", onclick: () => select(p.id), onkeydown: (e) => e.key === "Enter" && select(p.id) },
              h(
                "td",
                {},
                h("div", {}, p.slug, " ", p.mixed ? h("span", { class: "chip", title: "Catch-all folder: brief shows only sessions and preferences" }, "mixed") : null, p.aliases.length ? h("span", { class: "chip", title: p.aliases.join("\n") }, `+${p.aliases.length} alias`) : null),
                h("div", { class: "muted small" }, p.id),
              ),
              h("td", { class: "num" }, fmt(p.sessions)),
              h("td", { class: "num" }, fmt(p.facts)),
              h("td", { class: "num" }, `${fmt(p.briefTokens)} tok`),
              h("td", { class: "num" }, ago(p.last)),
            ),
          ),
        ),
      ),
    );
    if (!rows.length) fill(tableWrap, h("div", { class: "empty" }, "No matching projects."));
  }

  async function select(id) {
    state.selected = id;
    draw();
    const b = await api(`/api/brief?project=${encodeURIComponent(id)}`);
    fill(preview, 
      h(
        "div",
        { class: "row" },
        h("h2", {}, `${b.slug}: brief preview `, h("span", { class: "muted" }, "exactly what a new chat in this project receives")),
        h("span", { class: "spacer" }),
        h("span", { class: "chip" }, `${fmt(b.tokens)} tokens · ${fmt(b.chars)} chars`),
        h("button", { onclick: () => go("facts", id) }, "Review facts"),
        h("button", { onclick: () => go("sessions", id) }, "Sessions"),
      ),
      h("div", { class: "panel pad scroll" }, b.text ? h("pre", {}, b.text) : h("div", { class: "empty" }, "This project has no shared memory yet, so new chats get no brief.")),
    );
    preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  draw();
  show(h("div", { class: "row" }, h("h2", {}, "Projects ", h("span", { class: "muted" }, `${state.projects.length} with sessions`)), h("span", { class: "spacer" }), filter), tableWrap, preview);
  if (state.selected) select(state.selected);
}

// ---------- Facts ----------

async function renderFacts() {
  await loadProjects();
  const params = new URLSearchParams({ view: state.view });
  if (state.project) params.set("project", state.project);
  if (state.type) params.set("type", state.type);
  const needsProject = state.view === "all" && !state.project;
  const data = needsProject ? { facts: [], duplicates: [] } : await api(`/api/facts?${params}`);
  const selected = new Set();

  const controls = h(
    "div",
    { class: "row" },
    projectSelect(state.project, (v) => ((state.project = v), renderFacts())),
    h(
      "select",
      { "aria-label": "Type", onchange: (e) => ((state.type = e.target.value), renderFacts()) },
      h("option", { value: "" }, "All types"),
      ["decision", "rejected", "preference", "gotcha", "todo", "progress"].map((t) => h("option", { value: t, selected: t === state.type }, t)),
    ),
    h(
      "select",
      { "aria-label": "Show", onchange: (e) => ((state.view = e.target.value), renderFacts()) },
      h("option", { value: "review", selected: state.view === "review" }, "Needs review"),
      h("option", { value: "all", selected: state.view === "all" }, "All active facts"),
    ),
  );

  const bulkCount = h("span", {}, "");
  const bulk = h(
    "div",
    { class: "panel pad bulk row", hidden: true },
    bulkCount,
    h("span", { class: "spacer" }),
    h("button", { onclick: () => act([...selected], "done") }, "Done"),
    h("button", { class: "danger", onclick: () => act([...selected], "retract") }, "Retract"),
    h("button", { onclick: () => act([...selected], "keep") }, "Keep"),
  );
  const updateBulk = () => {
    bulk.hidden = selected.size === 0;
    bulkCount.textContent = `${selected.size} selected`;
  };

  async function act(ids, action) {
    if (!ids.length) return;
    if (action === "retract" && !confirm(`Retract ${ids.length} fact${ids.length > 1 ? "s" : ""}? Retract means it was wrong; it stops appearing anywhere.`)) return;
    const r = await api("/api/facts/action", { ids, action });
    toast(`${{ done: "Marked done", retract: "Retracted", keep: "Kept" }[action]}: ${r.ok.length}`);
    state.projects = [];
    renderFacts();
  }

  function factRow(f) {
    const box = h("input", {
      type: "checkbox",
      "aria-label": "Select",
      onchange: (e) => (e.target.checked ? selected.add(f.id) : selected.delete(f.id), updateBulk()),
    });
    const detail = h("div", { class: "detail", hidden: true });
    const toggle = async () => {
      if (!detail.hidden) return (detail.hidden = true);
      const d = await api(`/api/fact?id=${encodeURIComponent(f.id)}`);
      fill(detail, 
        h("div", {}, h("b", {}, "Id "), d.id, " · ", d.status, " · confidence ", d.confidence, " · created ", ago(d.created)),
        d.quote ? h("div", {}, h("b", {}, "Quote "), `"${d.quote}"`) : null,
        d.sourceTurns.length ? h("div", {}, h("b", {}, "Source "), d.sourceTurns.map((t) => h("div", { class: "muted" }, `${t.id}: "${t.user.slice(0, 200)}"`))) : null,
        d.mergedFrom.length ? h("div", {}, h("b", {}, "Replaces "), d.mergedFrom.map((m) => h("div", { class: "muted" }, `${m.id} (${m.status}): ${m.text}`))) : null,
        d.superseded_by ? h("div", {}, h("b", {}, "Superseded by "), d.superseded_by) : null,
      );
      detail.hidden = false;
    };
    const unconfirmed = f.origin === "agent" && f.confidence < 0.8;
    return h(
      "div",
      { class: "fact" },
      box,
      h(
        "div",
        {},
        h("div", { class: "text", tabindex: "0", role: "button", onclick: toggle, onkeydown: (e) => e.key === "Enter" && toggle() }, f.text, f.why ? h("span", { class: "why" }, ` Why: ${f.why}`) : null),
        h(
          "div",
          { class: "meta row" },
          h("span", { class: `chip ${f.type}` }, f.type),
          h("span", {}, ago(f.updated)),
          h("span", {}, unconfirmed ? `${f.origin}, unconfirmed` : f.origin === "manual" ? "note" : f.origin),
          !state.project && f.slug ? h("span", {}, f.slug) : null,
          h("span", { class: "muted" }, f.id),
        ),
      ),
      h(
        "div",
        { class: "actions" },
        h("button", { onclick: () => act([f.id], "done"), title: "Finished (todos)" }, "Done"),
        h("button", { class: "danger", onclick: () => act([f.id], "retract"), title: "It was wrong" }, "Retract"),
        h("button", { onclick: () => act([f.id], "keep"), title: "Still true: refresh its age" }, "Keep"),
      ),
      detail,
    );
  }

  const dupSection = data.duplicates.length
    ? [
        h(
          "div",
          { class: "row" },
          h("h2", {}, "Duplicates ", h("span", { class: "muted" }, "reworded copies of the same fact; merging keeps the newer wording")),
          h("span", { class: "spacer" }),
          h("button", { onclick: () => merge(data.duplicates.map((p) => p.drop.id)) }, `Merge all ${data.duplicates.length}`),
        ),
        h(
          "div",
          { class: "panel" },
          data.duplicates.map((p) =>
            h(
              "div",
              { class: "pair" },
              h("div", { class: "row" }, h("span", { class: `chip ${p.drop.type}` }, p.drop.type), h("span", {}, p.drop.text), h("span", { class: "spacer" }), h("button", { onclick: () => merge([p.drop.id]) }, "Merge into newer")),
              h("div", { class: "arrow" }, "≈ same as"),
              h("div", { class: "muted" }, p.keep.text, " ", h("span", { class: "small" }, `(${p.keep.id}, ${ago(p.keep.created)})`)),
            ),
          ),
        ),
      ]
    : [];

  async function merge(drop) {
    const r = await api("/api/dedupe", { project: state.project || undefined, drop });
    toast(`Merged ${r.merged}`);
    renderFacts();
  }

  const noteType = h("select", { "aria-label": "Note type" }, ["decision", "rejected", "preference", "gotcha", "todo", "progress"].map((t) => h("option", { value: t }, t)));
  const noteText = h("input", { type: "text", placeholder: "What should future sessions know?", "aria-label": "Note text", maxlength: "400" });
  const noteWhy = h("input", { type: "text", placeholder: "Why (optional)", "aria-label": "Why", maxlength: "300" });
  const noteForm = h(
    "form",
    {
      class: "panel pad row",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!state.project) return toast("Pick a project first");
        if (!noteText.value.trim()) return toast("Write the note first");
        const r = await api("/api/note", { project: state.project, type: noteType.value, text: noteText.value, why: noteWhy.value });
        toast(`Saved ${r.id}`);
        renderFacts();
      },
    },
    h("b", {}, "Add note"),
    noteType,
    h("span", { class: "spacer" }),
    noteText,
    noteWhy,
    h("button", { class: "primary", type: "submit", disabled: !state.project }, "Save"),
  );
  noteText.style.minWidth = "280px";

  const title =
    state.view === "review"
      ? h("h2", {}, "Needs review ", h("span", { class: "muted" }, "old todos and gotchas, and facts the agent assumed without your confirmation"))
      : h("h2", {}, "All active facts");
  const list = needsProject
    ? h("div", { class: "panel empty" }, "Pick a project to see all of its facts.")
    : data.facts.length
      ? h("div", { class: "panel" }, data.facts.map(factRow))
      : h("div", { class: "panel empty" }, state.view === "review" ? "Nothing needs review. Memory is in good shape." : "No facts.");

  show(controls, ...dupSection, title, bulk, list, h("h2", {}, ""), noteForm);
}

// ---------- Sessions ----------

async function renderSessions() {
  await loadProjects();
  const rows = await api(`/api/sessions?n=40${state.project ? `&project=${encodeURIComponent(state.project)}` : ""}`);
  const live = (s) => Date.now() / 1000 - s.last_ts < 600;

  function row(s) {
    const turns = h("div", { hidden: true });
    const open = async () => {
      if (!turns.hidden) return (turns.hidden = true);
      const t = await api(`/api/tail?session=${encodeURIComponent(s.id)}&n=6`);
      fill(turns, 
        ...t.map((x) =>
          h(
            "div",
            { class: "turn" },
            h("div", { class: "who" }, `${x.shortId} · ${ago(x.ts_end)}${x.complete ? "" : " · in progress"}`),
            h("div", {}, h("b", {}, "You: "), x.user.slice(0, 600)),
            x.assistant ? h("div", { class: "muted" }, h("b", {}, "Agent: "), tailText(x.assistant, 700)) : null,
          ),
        ),
      );
      turns.hidden = false;
    };
    return h(
      "div",
      { class: "panel" },
      h(
        "div",
        { class: "pad row click", tabindex: "0", role: "button", onclick: open, onkeydown: (e) => e.key === "Enter" && open() },
        h("span", { class: live(s) ? "ok" : "muted", title: live(s) ? "active in the last 10 minutes" : "" }, live(s) ? "●" : "○"),
        h("span", { class: "chip" }, `${s.harness ?? "?"}/${s.source}`),
        h("b", {}, s.title || "(untitled)"),
        h("span", { class: "spacer" }),
        h("span", { class: "muted" }, s.slug ?? ""),
        h("span", { class: "muted" }, `${s.turns} turns`),
        h("span", { class: "muted" }, ago(s.last_ts)),
      ),
      turns,
    );
  }

  const list = rows.length ? h("div", { class: "stack" }, rows.map(row)) : h("div", { class: "panel empty" }, "No sessions.");
  show(h("div", { class: "row" }, h("h2", {}, "Sessions ", h("span", { class: "muted" }, "click one to see its latest turns")), h("span", { class: "spacer" }), projectSelect(state.project, (v) => ((state.project = v), renderSessions()))), list);
}

// ---------- Health ----------

async function renderHealth() {
  const d = await api("/api/health");
  const x = d.health;
  const stat = (label, big, sub, pct) =>
    h("div", { class: "panel pad stat" }, h("div", { class: "muted small" }, label), h("div", { class: "big" }, big), sub ? h("div", { class: "muted small" }, sub) : null, pct !== undefined ? barEl(pct) : null);
  const checks = [{ ok: true, name: "ctxd running", detail: `pid ${d.daemon.pid}, up ${Math.round(d.daemon.uptime / 60)}m` }, { ok: d.daemon.embedReady, name: "embeddings", detail: d.daemon.embedReady ? "ready" : "loading or off" }, ...d.checks];
  const r = d.recall;
  const maxN = Math.max(1, ...r.buckets.map((b) => b.n));

  show(
    h("h2", {}, "Status"),
    h("div", { class: "panel pad" }, checks.map((c) => h("div", { class: "check" }, h("span", { class: c.ok ? "ok" : "bad" }, c.ok ? "✓" : "✗"), h("span", {}, c.name), h("span", { class: "muted" }, c.detail)))),
    h("h2", {}, "Memory and cost"),
    h(
      "div",
      { class: "grid" },
      stat("Extraction today", `${x.extract.calls} / ${x.extract.cap}`, `$${x.extract.cost.toFixed(2)} list price · ${x.extract.failures} failures · ${x.extract.pending} sessions waiting`, x.extract.calls / x.extract.cap),
      x.backfill ? stat("Backfill", `~${fmt(x.backfill.calls)} calls left`, `${x.backfill.sessions} sessions since ${new Date(x.backfill.since * 1000).toISOString().slice(0, 10)}`) : stat("Backfill", "off", "ctx backfill --days 60 to process older history"),
      stat("Active facts", fmt(x.facts), `${fmt(x.sessions)} sessions`),
      stat("Turns stored", fmt(x.turns), `${fmt(x.embedded)} with vectors · index ${(x.indexBytes / 1e6).toFixed(0)} MB`),
    ),
    h("h2", {}, "Sources"),
    h("div", { class: "panel" }, h("table", {}, h("tbody", {}, x.sources.map((s) => h("tr", {}, h("td", {}, s.source), h("td", { class: "num" }, `${fmt(s.files)} files`), h("td", { class: "num" }, `${fmt(s.unreadBytes)} bytes unread`), h("td", { class: "num" }, `newest turn ${ago(s.newest) || "never"}`)))))),
    h("h2", {}, "Notes added to prompts ", h("span", { class: "muted" }, `best match per prompt vs the threshold (recall.minSim ${r.minSim})`)),
    h(
      "div",
      { class: "panel pad" },
      r.prompts
        ? [
            h("div", { class: "muted small" }, `${r.injected} of ${r.prompts} searched prompts got notes (${Math.round((r.injected / r.prompts) * 100)}%)`),
            h("div", { class: "hist" }, r.buckets.filter((b) => b.n || b.threshold).flatMap((b) => {
              const fill = h("div", { class: "fill" });
              fill.style.width = `${(b.n / maxN) * 100}%`;
              return [h("span", { class: b.threshold ? "t" : "muted" }, `${b.lo.toFixed(2)}${b.threshold ? " ← min" : ""}`), h("div", {}, fill), h("span", { class: "num" }, b.n)];
            })),
            r.near.length ? h("div", { class: "muted small" }, "Near misses (just under the threshold): ", r.near.map((n) => `${n.id} ${n.sim.toFixed(3)}`).join(", ")) : null,
          ]
        : h("div", { class: "muted" }, "No data yet. Scores are logged for each prompt once embeddings are ready."),
    ),
  );
}

function barEl(pct) {
  const fill = h("span");
  fill.style.width = `${Math.min(100, Math.max(0, pct * 100))}%`;
  return h("div", { class: "bar" }, fill);
}

// ---------- routing ----------

const VIEWS = { projects: renderProjects, facts: renderFacts, sessions: renderSessions, health: renderHealth };
const AUTO_REFRESH = new Set(["sessions", "health"]);

function go(tab, project) {
  if (project !== undefined) state.project = project;
  location.hash = tab;
}

async function render() {
  state.tab = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "projects";
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("active", a.dataset.tab === state.tab);
  try {
    await VIEWS[state.tab]();
  } catch (e) {
    show(
      h(
        "div",
        { class: "panel empty" },
        e instanceof AuthError ? ["This page needs a fresh link. In a terminal, run ", h("code", {}, "ctx ui"), "."] : `Something went wrong: ${e.message}`,
      ),
    );
  }
}

window.addEventListener("hashchange", render);
setInterval(() => {
  if (document.visibilityState === "visible" && AUTO_REFRESH.has(state.tab) && !document.querySelector(".turn")) render();
}, 10_000);
render();
