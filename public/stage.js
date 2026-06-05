/* Stage (presenter) view, drives the session and renders the live editor. */
const socket = io();

const el = (id) => document.getElementById(id);
const editorEl = el("editor");
const caretEl = el("caret");
const editorBody = editorEl.closest(".editor-body");

// Highlight band that flashes over the lines committed at Reveal.
const hl = document.createElement("div");
hl.className = "editor-hl";
editorBody.appendChild(hl);
let hlTimer = null;

let cur = null; // last full state
let displayed = ""; // text currently shown for the active build file
let displayedFile = null; // which file `displayed` belongs to
let typingTimer = null;
let activeTab = null; // filename currently viewed
let lastBuildFile = null; // last step's build file (to auto-switch tabs)
let lastLevel = null; // last step's level (to play the door transition)
const FILE_ORDER = [
  "dags/sales_pipeline.py",
  "dags/sales_report.py",
  "dags/templates/blueprints.py",
  "dags/sales.dag.yaml",
  "dags/loader.py",
];
const LEVEL_NAMES = { 1: "Author DAGs in Python", 2: "Blueprint" };

const langFor = (name) =>
  name && name.endsWith(".yaml") ? "language-yaml" : "language-python";

// Full-screen door transition shown when crossing into a new level.
function playLevelTransition(level) {
  const doors = el("level-doors");
  el("level-label").innerHTML =
    `<div class="level-num">LEVEL ${level}</div>` +
    `<div class="level-name">${escapeHtml(LEVEL_NAMES[level] || "")}</div>`;
  doors.classList.add("active");
  void doors.offsetWidth; // reflow so the closing transition runs
  doors.classList.add("closed");
  setTimeout(() => doors.classList.remove("closed"), 1700); // hold, then open
  setTimeout(() => doors.classList.remove("active"), 2400); // hide once open
}

// ── Join URL + QR ────────────────────────────────────────────
const joinUrl = location.origin + "/";
el("join-url").textContent = joinUrl.replace(/^https?:\/\//, "");
new QRCode(el("qrcode"), { text: joinUrl, width: 96, height: 96, colorDark: "#0b0d17" });

// ── Editor typing animation ──────────────────────────────────
const TICK = 14;
const TICKS = 90; // ~1.3s regardless of snapshot size
function renderEditor(text, typing) {
  editorEl.textContent = text;
  caretEl.style.display = typing ? "inline-block" : "none";
  if (!typing && window.hljs) {
    editorEl.className = langFor(activeTab);
    editorEl.removeAttribute("data-highlighted");
    delete editorEl.dataset.highlighted;
    hljs.highlightElement(editorEl);
  }
  editorBody.scrollTop = editorBody.scrollHeight;
}
function setEditor(target) {
  target = target || "";
  if (target === displayed) {
    renderEditor(target, false);
    return;
  }
  if (typingTimer) clearInterval(typingTimer);
  const prev = displayed;
  let i = 0;
  const min = Math.min(displayed.length, target.length);
  while (i < min && displayed[i] === target[i]) i++;
  const inc = Math.max(1, Math.ceil((target.length - i) / TICKS));
  let n = i;
  renderEditor(target.slice(0, n), true);
  typingTimer = setInterval(() => {
    n = Math.min(target.length, n + inc);
    renderEditor(target.slice(0, n), n < target.length);
    if (n >= target.length) {
      clearInterval(typingTimer);
      typingTimer = null;
      displayed = target;
      flashChange(prev, target);
    }
  }, TICK);
}

// Scroll the changed lines into view and flash a highlight band over them, so
// the just-committed code is always front-and-center (no scrolling to find it).
function flashChange(prev, next) {
  if (!next || prev === next) return;
  let i = 0;
  const min = Math.min(prev.length, next.length);
  while (i < min && prev[i] === next[i]) i++;
  let j = 0;
  while (j < min - i && prev[prev.length - 1 - j] === next[next.length - 1 - j]) j++;
  const startLine = (next.slice(0, i).match(/\n/g) || []).length;
  const endLine = (next.slice(0, Math.max(i, next.length - j)).match(/\n/g) || []).length;
  const cs = getComputedStyle(editorBody);
  const lh = parseFloat(cs.lineHeight) || 30;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const top = padTop + startLine * lh;
  hl.style.top = top + "px";
  hl.style.height = Math.max(1, endLine - startLine + 1) * lh + "px";
  hl.classList.add("show");
  // Bring the change into view with a little context above it.
  editorBody.scrollTop = Math.max(0, top - lh * 2);
  clearTimeout(hlTimer);
  hlTimer = setTimeout(() => hl.classList.remove("show"), 2400);
}

// Render a read-only file (a tab that isn't the current build target):
// no typing, no highlight band. Does NOT touch `displayed`.
function renderStaticEditor(code) {
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
  }
  hl.classList.remove("show");
  editorEl.textContent = code || "";
  caretEl.style.display = "none";
  if (window.hljs) {
    editorEl.className = langFor(activeTab);
    editorEl.removeAttribute("data-highlighted");
    delete editorEl.dataset.highlighted;
    hljs.highlightElement(editorEl);
  }
  editorBody.scrollTop = 0;
}

// Ordered list of file tabs: known files first, then the active build file.
function tabNames(files, buildFile) {
  const set = new Set(Object.keys(files));
  if (buildFile) set.add(buildFile);
  const names = [];
  for (const f of FILE_ORDER) if (set.has(f)) { names.push(f); set.delete(f); }
  for (const f of set) names.push(f);
  return names.length ? names : [FILE_ORDER[0]];
}

// Recompute tabs + editor from `cur`. Auto-focuses the file the step builds,
// types diffs within that file, and shows other files read-only.
function repaintEditor() {
  if (cur && cur.phase === "lobby") {
    displayed = "";
    displayedFile = null;
    lastBuildFile = null;
  }
  const files = (cur && cur.files) || {};
  const buildFile = (cur && cur.activeFile) || null;
  if (buildFile && buildFile !== lastBuildFile) {
    activeTab = buildFile;
    lastBuildFile = buildFile;
  }
  const names = tabNames(files, buildFile);
  if (!activeTab || !names.includes(activeTab)) activeTab = names[0];

  // tabs
  el("tabs").innerHTML = names
    .map(
      (n) =>
        `<button class="tab ${activeTab === n ? "active" : ""}" data-tab="${escapeHtml(n)}">${escapeHtml(
          n
        )}</button>`
    )
    .join("");
  el("tabs")
    .querySelectorAll("button")
    .forEach((b) =>
      b.addEventListener("click", () => {
        activeTab = b.dataset.tab;
        repaintEditor();
      })
    );

  // editor body
  const code = files[activeTab] || "";
  if (activeTab === buildFile) {
    if (displayedFile !== buildFile) {
      // Switched to a new build file: show it as-is (don't diff-type from the
      // previous file), then subsequent reveals type the in-file changes.
      renderStaticEditor(code);
      displayed = code;
      displayedFile = buildFile;
    } else {
      setEditor(code);
    }
  } else {
    renderStaticEditor(code);
  }
}

// ── Rendering ────────────────────────────────────────────────
function pct(count, total) {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

function renderOptions() {
  const wrap = el("options");
  if (!cur || !cur.step) {
    wrap.innerHTML = "";
    return;
  }
  const revealed = cur.phase === "revealed";
  const total = cur.totalVotes || 0;
  wrap.innerHTML = cur.step.options
    .map((o) => {
      const c = (cur.votes && cur.votes[o.id]) || 0;
      const p = pct(c, total);
      const isCorrect = revealed && o.id === cur.correctId;
      return `
      <div class="opt ${isCorrect ? "correct" : ""}">
        <div class="bar" style="width:${revealed ? p : Math.min(p, 100)}%"></div>
        <div class="opt-top">
          <span class="opt-label">${o.label}${
        isCorrect ? '<span class="badge-best">best practice</span>' : ""
      }</span>
          <span class="opt-pct">${revealed ? p + "%" : c}</span>
        </div>
        <div class="opt-code mono">${escapeHtml(o.code)}</div>
      </div>`;
    })
    .join("");
}

function renderLeaderboard() {
  const lb = (cur && cur.leaderboard) || [];
  el("leaderboard").innerHTML =
    lb.length === 0
      ? '<div class="lead-row"><span class="nm" style="color:var(--muted)">No players yet</span></div>'
      : lb
          .map(
            (p, i) =>
              `<div class="lead-row"><span class="rank">${i + 1}</span><span class="nm">${escapeHtml(
                p.name
              )}</span><span class="sc">${p.score}</span></div>`
          )
          .join("");
}

function renderControls() {
  const btn = el("btn-main");
  const phase = cur ? cur.phase : "lobby";
  if (phase === "lobby") btn.textContent = "Start";
  else if (phase === "voting") btn.textContent = "Reveal results";
  else if (phase === "revealed") btn.textContent = "Show explanation";
  else if (phase === "explaining")
    btn.textContent =
      cur.step.index + 1 < cur.step.total ? "Next step" : "Finish";
  else btn.textContent = "Restart";
}

function correctCode() {
  if (!cur || !cur.step || !cur.correctId) return "";
  const o = cur.step.options.find((x) => x.id === cur.correctId);
  return o ? o.code : "";
}

function renderExplain() {
  if (!cur || !cur.step) return;
  el("explain-progress").textContent = `Level ${cur.step.level} · Step ${cur.step.levelStep} of ${cur.step.levelTotal} · Why it matters`;
  el("explain-title").textContent = cur.step.title;
  el("explain-why").textContent = cur.teach || "";
  el("explain-points").innerHTML = (cur.points || [])
    .map((p) => `<li>${escapeHtml(p)}</li>`)
    .join("");

  const snippet = el("explain-snippet");
  const code = correctCode();
  if (code) {
    const codeEl = el("explain-code");
    codeEl.textContent = code;
    codeEl.className = langFor(cur.activeFile);
    codeEl.removeAttribute("data-highlighted");
    delete codeEl.dataset.highlighted;
    if (window.hljs) hljs.highlightElement(codeEl);
    snippet.classList.remove("hidden");
  } else {
    snippet.classList.add("hidden");
  }
}

function render() {
  if (!cur) return;
  el("player-count").textContent = `${cur.playerCount} player${cur.playerCount === 1 ? "" : "s"}`;

  // Play the door transition when the level increases.
  const lvl = cur.step ? cur.step.level : null;
  if (lvl && lastLevel !== null && lvl > lastLevel) playLevelTransition(lvl);
  if (lvl) lastLevel = lvl;

  if (cur.step) {
    el("progress").textContent = `Level ${cur.step.level} · Step ${cur.step.levelStep} of ${cur.step.levelTotal}`;
    el("q-title").textContent = cur.step.title;
    el("q-prompt").textContent = cur.step.prompt;
  } else if (cur.phase === "finished") {
    el("progress").textContent = "Done";
    el("q-title").textContent = "You built a best-practice DAG!";
    el("q-prompt").textContent = "Every line voted in by the room.";
  } else {
    el("progress").textContent = "Lobby";
    el("q-title").textContent = "Build a DAG, together.";
    el("q-prompt").textContent =
      "Scan to join. The whole room votes on every line of best-practice Airflow 3.";
  }

  // Explanation phase swaps the right panel into a focused "slide":
  // hide the question + join/leaderboard, show the explanation; editor stays.
  const explaining = cur.phase === "explaining";
  el("question-card").classList.toggle("hidden", explaining);
  el("foot").classList.toggle("hidden", explaining);
  el("explain-card").classList.toggle("hidden", !explaining);
  if (explaining) renderExplain();

  renderOptions();
  renderLeaderboard();
  renderControls();
  repaintEditor();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ── Socket events ────────────────────────────────────────────
socket.on("state", (s) => {
  cur = s;
  render();
});
socket.on("votes", ({ votes, totalVotes }) => {
  if (!cur) return;
  cur.votes = votes;
  cur.totalVotes = totalVotes;
  renderOptions();
});

// ── Controls ─────────────────────────────────────────────────
el("btn-main").addEventListener("click", () => {
  const phase = cur ? cur.phase : "lobby";
  if (phase === "lobby" || phase === "finished") socket.emit("start");
  else if (phase === "voting") socket.emit("reveal");
  else if (phase === "revealed") socket.emit("explain");
  else if (phase === "explaining") socket.emit("next");
});
el("btn-reset").addEventListener("click", () => {
  if (confirm("Reset the whole session (editor + scores)?")) socket.emit("reset");
});
