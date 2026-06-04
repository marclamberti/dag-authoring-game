/* Stage (presenter) view, drives the session and renders the live editor. */
const socket = io();

const el = (id) => document.getElementById(id);
const editorEl = el("editor");
const caretEl = el("caret");
const editorBody = editorEl.closest(".editor-body");

let cur = null; // last full state
let displayed = ""; // text currently in the editor
let typingTimer = null;

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
    }
  }, TICK);
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
      cur.step.index + 1 < cur.step.total ? "Commit & Next" : "Commit & Finish";
  else btn.textContent = "Restart";
}

function correctCode() {
  if (!cur || !cur.step || !cur.correctId) return "";
  const o = cur.step.options.find((x) => x.id === cur.correctId);
  return o ? o.code : "";
}

function renderExplain() {
  if (!cur || !cur.step) return;
  el("explain-progress").textContent = `Step ${cur.step.index + 1} of ${cur.step.total} · Why it matters`;
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

  if (cur.step) {
    el("progress").textContent = `Step ${cur.step.index + 1} of ${cur.step.total}`;
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
  setEditor(cur.committedCode);
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
