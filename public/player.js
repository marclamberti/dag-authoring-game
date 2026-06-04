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

function renderVote() {
  if (!cur || !cur.step) return;
  el("p-title").textContent = cur.step.title;
  el("p-prompt").textContent = cur.step.prompt;
  el("p-score").textContent = myScore > 0 ? `Score: ${myScore}` : "";

  const revealed = cur.phase === "revealed" || cur.phase === "explaining";
  el("p-options").innerHTML = cur.step.options
    .map((o) => {
      const picked = myVote === o.id;
      const correct = revealed && o.id === cur.correctId;
      const wrong = revealed && picked && !correct;
      const cls = ["p-opt", picked ? "picked" : "", correct ? "correct" : "", wrong ? "wrong" : ""]
        .filter(Boolean)
        .join(" ");
      return `<button class="${cls}" data-opt="${o.id}" ${revealed ? "disabled" : ""}>
        ${escapeHtml(o.label)}<span class="p-code mono">${escapeHtml(o.code)}</span>
      </button>`;
    })
    .join("");

  el("p-options")
    .querySelectorAll("button")
    .forEach((b) =>
      b.addEventListener("click", () => socket.emit("vote", { optionId: b.dataset.opt }))
    );

  const status = el("p-status");
  if (revealed && lastResult) {
    status.classList.remove("hidden");
    status.innerHTML = lastResult.correct
      ? '<span class="result-good">Best practice! +100</span>'
      : '<span class="result-bad">Not the best practice, see the highlighted answer</span>';
  } else if (revealed && !myVote) {
    status.classList.remove("hidden");
    status.textContent = "Round over, vote next time!";
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
