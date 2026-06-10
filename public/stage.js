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
  "dags/daily_export.py",
  "dags/load_config.py",
  "dags/customers.py",
  "dags/orders.py",
  "dags/templates/blueprints.py",
  "dags/sales.dag.yaml",
  "dags/dag_factory.yaml",
  "dags/marketing.dag.yaml",
  "dags/loader.py",
];
const LEVEL_NAMES = { 1: "Author DAGs in Python", 2: "Blueprint", 3: "Run it for real" };

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
  if (typeof sfx !== "undefined") sfx.levelup();
}

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
  // Level 3 "lab": no vote — show the task checklist + how many boxes are live.
  if (cur.step.kind === "lab") {
    const tasks = (cur.step.tasks || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("");
    const n = cur.sandboxesRunning || 0;
    const status = cur.sandboxEnabled
      ? `<div class="lab-count">${n} participant${n === 1 ? "" : "s"} running Airflow</div>`
      : `<div class="lab-count warn">Sandboxes not configured — set MODAL_SANDBOX_* env to enable</div>`;
    wrap.innerHTML = `<ul class="lab-tasks-stage">${tasks}</ul>${status}`;
    return;
  }
  // "bug" rounds have no options; players tap a line in the code on the left.
  if (cur.step.kind === "bug") {
    const line = revealed && cur.correctId ? cur.correctId.slice(1) : null;
    wrap.innerHTML = revealed
      ? `<div class="bug-answer">🐛 The bug is on <b>line ${line}</b>, highlighted on the left.</div>`
      : `<div class="bug-hint">Tap the broken line. <span class="opt-pct">${total} vote${total === 1 ? "" : "s"}</span></div>`;
    return;
  }
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

// Animated leaderboard: rows slide to their new rank via FLIP. The streak flame
// is rendered static (no growing) — only positions animate.
function renderLeaderboard() {
  const container = el("leaderboard");
  const lb = (cur && cur.leaderboard) || [];
  // FIRST: record where each named row currently sits.
  const firstTop = {};
  container.querySelectorAll(".lead-row[data-name]").forEach((r) => {
    firstTop[r.dataset.name] = r.offsetTop;
  });

  container.innerHTML =
    lb.length === 0
      ? '<div class="lead-row"><span class="nm" style="color:var(--muted)">No players yet</span></div>'
      : lb
          .map(
            (p, i) =>
              `<div class="lead-row" data-name="${escapeHtml(p.name)}"><span class="rank">${i + 1}</span><span class="nm">${escapeHtml(
                p.name
              )}${p.streak >= 2 ? ` <span class="streak">🔥${p.streak}</span>` : ""}</span><span class="sc">${p.score}</span></div>`
          )
          .join("");

  // LAST + INVERT + PLAY: offset each moved row to its old spot, then release.
  container.querySelectorAll(".lead-row[data-name]").forEach((r) => {
    const prev = firstTop[r.dataset.name];
    if (prev === undefined) return;
    const dy = prev - r.offsetTop;
    if (!dy) return;
    r.style.transition = "none";
    r.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      r.style.transition = "transform 420ms cubic-bezier(.2,.8,.2,1)";
      r.style.transform = "";
    });
  });
}

function renderControls() {
  const btn = el("btn-main");
  const phase = cur ? cur.phase : "lobby";
  const isLast = cur && cur.step && cur.step.index + 1 >= cur.step.total;
  if (phase === "lobby") btn.textContent = "Start";
  else if (phase === "teaching") btn.textContent = "Start vote";
  else if (phase === "voting") btn.textContent = cur.deadline ? "Reveal now" : "Start countdown";
  else if (phase === "revealed")
    btn.textContent = cur.step.explainFirst ? (isLast ? "Finish" : "Next step") : "Show explanation";
  else if (phase === "explaining") btn.textContent = isLast ? "Finish" : "Next step";
  else if (phase === "lab") btn.textContent = isLast ? "Finish" : "Next step";
  else btn.textContent = "Restart";
}

function correctCode() {
  if (!cur || !cur.step || !cur.correctId || !cur.step.options) return "";
  const o = cur.step.options.find((x) => x.id === cur.correctId);
  return o ? o.code : "";
}

function renderExplain() {
  if (!cur || !cur.step) return;
  const tag = cur.phase === "teaching" ? "Learn this first" : "Why it matters";
  el("explain-progress").textContent = `Level ${cur.step.level} · Step ${cur.step.levelStep} of ${cur.step.levelTotal} · ${tag}`;
  el("explain-title").textContent = cur.step.title;
  el("explain-why").textContent = cur.teach || "";
  el("explain-points").innerHTML = (cur.points || [])
    .map((p) => `<li>${escapeHtml(p)}</li>`)
    .join("");

  const snippet = el("explain-snippet");
  // Only the post-vote explanation shows the snippet (correctId is set once
  // revealed); the pre-vote teaching slide never shows the answer code.
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

  // The explanation slide shows during the post-vote "explaining" phase and the
  // pre-vote "teaching" phase (explain-first steps). Editor stays on the left.
  const slide = cur.phase === "explaining" || cur.phase === "teaching";
  el("question-card").classList.toggle("hidden", slide);
  el("foot").classList.toggle("hidden", slide);
  el("explain-card").classList.toggle("hidden", !slide);
  if (slide) renderExplain();

  renderOptions();
  renderLeaderboard();
  renderControls();
  renderStageCode();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ── Editor area: dispatch by round kind ──────────────────────
let runTimer = null;
let runShownFor = -1;

function renderStageCode() {
  const st = cur && cur.step;
  if (st && st.kind === "lab") return renderLabStage();
  if (st && st.kind === "review") return renderDiff(st.diff);
  if (st && st.kind === "predict_run" && cur.runOutput &&
      (cur.phase === "revealed" || cur.phase === "explaining"))
    return renderRun(cur.runOutput, st.index);
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
  repaintEditor();
  // Spot the bug: flash the broken line on reveal.
  if (st && st.kind === "bug" && cur.phase === "revealed" && cur.correctId)
    highlightBugLine(parseInt(cur.correctId.slice(1), 10));
  else hl.classList.remove("bug");
}

function highlightBugLine(n) {
  if (!n) return;
  const cs = getComputedStyle(editorBody);
  const lh = parseFloat(cs.lineHeight) || 30;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const top = padTop + (n - 1) * lh;
  hl.style.top = top + "px";
  hl.style.height = lh + "px";
  hl.classList.add("show", "bug");
  editorBody.scrollTop = Math.max(0, top - lh * 3);
}

// Level 3 lab: the editor steps aside — everyone's hands-on in their own box.
function renderLabStage() {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
  hl.classList.remove("show", "bug");
  caretEl.style.display = "none";
  el("tabs").innerHTML = "";
  editorEl.className = "lab-stage";
  editorEl.innerHTML =
    `<div class="lab-stage-msg">` +
    `<div class="lab-stage-title">Everyone's running their own Airflow now</div>` +
    `<div class="lab-stage-sub">Follow the checklist on your phone — this part is hands-on.</div>` +
    `</div>`;
}

// You're the reviewer: render the PR diff with +/- coloring.
function renderDiff(diff) {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
  hl.classList.remove("show", "bug");
  caretEl.style.display = "none";
  editorEl.className = "diff";
  editorEl.innerHTML = (diff || "")
    .split("\n")
    .map((ln) => {
      const c = ln.startsWith("+") ? "diff-add" : ln.startsWith("-") ? "diff-del" : "diff-ctx";
      return `<span class="${c}">${escapeHtml(ln || " ")}</span>`;
    })
    .join("\n");
  editorBody.scrollTop = 0;
}

// Predict & run: a terminal that prints the run output line by line on reveal.
function renderRun(lines, stepIndex) {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
  hl.classList.remove("show", "bug");
  caretEl.style.display = "none";
  editorEl.className = "run";
  const paint = (k) => {
    editorEl.innerHTML = lines
      .slice(0, k)
      .map((l) => `<span class="run-line">${escapeHtml(l || " ")}</span>`)
      .join("\n");
    editorBody.scrollTop = editorBody.scrollHeight;
  };
  if (runShownFor === stepIndex) {
    if (runTimer) { clearInterval(runTimer); runTimer = null; }
    return paint(lines.length);
  }
  runShownFor = stepIndex;
  let k = 0;
  paint(0);
  if (runTimer) clearInterval(runTimer);
  runTimer = setInterval(() => {
    k++;
    paint(k);
    if (k >= lines.length) { clearInterval(runTimer); runTimer = null; }
  }, 240);
}

// ── Sound (Web Audio, no asset files) ────────────────────────
let actx = null;
function audio() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
  }
  if (actx && actx.state === "suspended") actx.resume();
  return actx;
}
function tone(freq, at, dur, type, gain) {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type || "sine";
  o.frequency.value = freq;
  o.connect(g); g.connect(a.destination);
  const t = a.currentTime + (at || 0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain || 0.12, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.2));
  o.start(t);
  o.stop(t + (dur || 0.2) + 0.03);
}
const sfx = {
  tick: () => tone(1175, 0, 0.08, "square", 0.06), // last-5s heartbeat
  reveal: () => { tone(659, 0, 0.16, "sine", 0.12); tone(988, 0.07, 0.24, "sine", 0.11); },
  levelup: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.28, "triangle", 0.12)),
};

// Confetti lives on the Player view now: it's a personal reward for the people
// who actually got the answer right (the Stage keeps the fanfare + door cues).

// ── Countdown timer (presenter-started; clients sync via server clock) ───────
let skew = 0; // serverNow - localNow, to correct clock drift
let timerRAF = null;
let lastTickSec = null;
function stopTimer() {
  if (timerRAF) cancelAnimationFrame(timerRAF);
  timerRAF = null;
  el("timer").classList.add("hidden");
}
function timerLoop() {
  if (!cur || cur.phase !== "voting" || !cur.deadline) return stopTimer();
  const remain = cur.deadline - (Date.now() + skew);
  const dur = cur.durationMs || 20000;
  const frac = Math.max(0, Math.min(1, remain / dur));
  const secs = Math.max(0, Math.ceil(remain / 1000));
  const t = el("timer");
  t.classList.remove("hidden");
  el("timer-bar").style.width = frac * 100 + "%";
  el("timer-num").textContent = secs;
  t.classList.toggle("urgent", secs <= 5);
  if (secs !== lastTickSec) {
    if (lastTickSec !== null && secs <= 5 && secs > 0) sfx.tick();
    lastTickSec = secs;
  }
  timerRAF = requestAnimationFrame(timerLoop);
}

// ── Co-op hype meter (room accuracy on reveal) ───────────────
function renderHype() {
  const hype = el("hype");
  if (!cur || cur.phase !== "revealed" || cur.roundAccuracy == null) {
    hype.classList.add("hidden");
    return;
  }
  const acc = cur.roundAccuracy;
  const mood = acc >= 80 ? "The room nailed it" : acc >= 50 ? "Room's dialing in" : "A tricky one";
  const session = cur.sessionAccuracy != null ? `<span>Session ${cur.sessionAccuracy}%</span>` : "<span></span>";
  hype.classList.remove("hidden");
  hype.innerHTML =
    `<div class="hype-label">Room accuracy</div>` +
    `<div class="hype-track"><div class="hype-fill" style="width:${acc}%"></div></div>` +
    `<div class="hype-meta"><span>${acc}% correct · ${mood}</span>${session}</div>`;
}

// ── Socket events ────────────────────────────────────────────
let lastPhase = null;
socket.on("state", (s) => {
  // Sync to the server clock so the countdown is consistent across machines.
  if (typeof s.serverNow === "number") skew = s.serverNow - Date.now();
  cur = s;
  render();
  // Phase-transition cues (fire once per change).
  if (s.phase !== lastPhase) {
    if (s.phase === "voting" && s.deadline) lastTickSec = null; // arm tick sounds
    if (s.phase === "revealed") sfx.reveal();
    lastPhase = s.phase;
  }
  // Run/stop the countdown loop to match the current round.
  if (s.phase === "voting" && s.deadline) {
    if (!timerRAF) timerLoop();
  } else {
    stopTimer();
  }
  renderHype();
});
socket.on("votes", ({ votes, totalVotes }) => {
  if (!cur) return;
  cur.votes = votes;
  cur.totalVotes = totalVotes;
  renderOptions();
});

// ── Controls ─────────────────────────────────────────────────
el("btn-main").addEventListener("click", () => {
  audio(); // unlock the audio context on a user gesture
  const phase = cur ? cur.phase : "lobby";
  if (phase === "lobby" || phase === "finished") socket.emit("start");
  else if (phase === "teaching") socket.emit("startVote");
  else if (phase === "voting") socket.emit(cur.deadline ? "reveal" : "startCountdown");
  else if (phase === "revealed") socket.emit(cur.step.explainFirst ? "next" : "explain");
  else if (phase === "explaining") socket.emit("next");
  else if (phase === "lab") socket.emit("next");
});
el("btn-reset").addEventListener("click", () => {
  if (confirm("Reset the whole session (editor + scores)?")) socket.emit("reset");
});
// Debug: jump straight to the first Level 3 (lab) step.
el("btn-skip-l3").addEventListener("click", () => socket.emit("skipToLevel3"));
