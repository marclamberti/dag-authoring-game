/* Player (audience) view, join, vote, see your result + score. */
const socket = io();
const el = (id) => document.getElementById(id);

let joined = false;
let myVote = null; // optionId I picked this step
let myScore = 0;
let stepIndex = -1; // to detect new steps and reset my vote
let lastResult = null; // {correct, correctId, score} for the current step

// ── Join ─────────────────────────────────────────────────────
function doJoin() {
  const name = el("name").value.trim();
  if (!name) {
    el("name").focus();
    return;
  }
  socket.emit("join", { name });
}
el("join-btn").addEventListener("click", doJoin);
el("name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doJoin();
});

socket.on("joined", ({ score }) => {
  joined = true;
  myScore = score || 0;
});
socket.on("voted", ({ optionId }) => {
  myVote = optionId;
  renderVote();
});
socket.on("result", (r) => {
  lastResult = r;
  myScore = r.score;
  renderVote();
});

// ── State ────────────────────────────────────────────────────
let cur = null;
socket.on("state", (s) => {
  cur = s;
  // New step? reset per-step local state.
  const idx = s.step ? s.step.index : -1;
  if (idx !== stepIndex) {
    stepIndex = idx;
    myVote = null;
    lastResult = null;
  }
  render();
});

function show(screen) {
  for (const id of ["join-screen", "wait-screen", "vote-screen"]) {
    el(id).classList.toggle("hidden", id !== screen);
  }
}

function render() {
  if (!cur) return;
  if (!joined) {
    show("join-screen");
    return;
  }
  const phase = cur.phase;
  if (phase === "lobby") {
    show("wait-screen");
    el("wait-title").textContent = "You're in!";
    el("wait-sub").textContent = "Waiting for the host to start…";
    setWaitScore();
  } else if (phase === "finished") {
    show("wait-screen");
    el("wait-title").textContent = "That's a wrap!";
    el("wait-sub").textContent = "You helped build a best-practice DAG.";
    setWaitScore();
  } else if (phase === "teaching") {
    show("wait-screen");
    el("wait-title").textContent = "Watch the screen";
    el("wait-sub").textContent = "Learn this, then the question is coming up…";
    setWaitScore();
  } else {
    show("vote-screen");
    renderVote();
  }
}

function setWaitScore() {
  const s = el("wait-score");
  if (myScore > 0) {
    s.textContent = `Your score: ${myScore}`;
    s.classList.remove("hidden");
  } else {
    s.classList.add("hidden");
  }
}

function classNames(...c) { return c.filter(Boolean).join(" "); }

function renderVote() {
  if (!cur || !cur.step) return;
  const st = cur.step;
  el("p-title").textContent = st.title;
  el("p-prompt").textContent = st.prompt;
  el("p-score").textContent = myScore > 0 ? `Score: ${myScore}` : "";
  const revealed = cur.phase === "revealed" || cur.phase === "explaining";
  const wrap = el("p-options");
  const dis = revealed ? "disabled" : "";

  if (st.kind === "bug") {
    // Spot the bug: tap the broken line.
    wrap.innerHTML = (st.code || "").split("\n").map((ln, i) => {
      const id = "L" + (i + 1);
      const picked = myVote === id, correct = revealed && id === cur.correctId;
      const cls = classNames("p-line", picked && "picked", correct && "correct", revealed && picked && !correct && "wrong");
      return `<button class="${cls}" data-opt="${id}" ${dis}><span class="p-ln">${i + 1}</span><span class="p-code mono">${escapeHtml(ln || " ")}</span></button>`;
    }).join("");
  } else if (st.kind === "review") {
    // You're the reviewer: read the diff, then Approve / Request changes.
    const diff = (st.diff || "").split("\n").map((ln) => {
      const c = ln.startsWith("+") ? "diff-add" : ln.startsWith("-") ? "diff-del" : "diff-ctx";
      return `<div class="p-diff-line ${c} mono">${escapeHtml(ln || " ")}</div>`;
    }).join("");
    const btns = (st.options || []).map((o) => {
      const picked = myVote === o.id, correct = revealed && o.id === cur.correctId;
      const cls = classNames("p-opt", "p-review-btn", picked && "picked", correct && "correct", revealed && picked && !correct && "wrong");
      return `<button class="${cls}" data-opt="${o.id}" ${dis}>${escapeHtml(o.label)}</button>`;
    }).join("");
    wrap.innerHTML = `<div class="p-diff">${diff}</div>${btns}`;
  } else {
    // Standard options (code / predict / predict_run).
    wrap.innerHTML = (st.options || []).map((o) => {
      const picked = myVote === o.id, correct = revealed && o.id === cur.correctId;
      const cls = classNames("p-opt", picked && "picked", correct && "correct", revealed && picked && !correct && "wrong");
      const code = o.code ? `<span class="p-code mono">${escapeHtml(o.code)}</span>` : "";
      return `<button class="${cls}" data-opt="${o.id}" ${dis}>${escapeHtml(o.label)}${code}</button>`;
    }).join("");
  }

  wrap.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => socket.emit("vote", { optionId: b.dataset.opt }))
  );

  const status = el("p-status");
  if (revealed && lastResult) {
    status.classList.remove("hidden");
    if (lastResult.correct) {
      const combo = lastResult.multiplier > 1 ? ` · 🔥 ${lastResult.multiplier}× (streak ${lastResult.streak})` : "";
      status.innerHTML = `<span class="result-good">Correct! +${lastResult.gained}${combo}</span>`;
    } else {
      status.innerHTML = '<span class="result-bad">Not quite, see the highlighted answer</span>';
    }
  } else if (revealed && !myVote) {
    status.classList.remove("hidden");
    status.textContent = "Round over, jump in next time!";
  } else if (myVote) {
    status.classList.remove("hidden");
    status.textContent = "Locked in (tap another to change)";
  } else {
    status.classList.add("hidden");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
