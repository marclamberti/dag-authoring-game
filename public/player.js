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
  blip(660, 0.08, 0.05); // also unlocks the audio context on this tap
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
  blip(880, 0.06, 0.05); // vote blip
  vibrate(15);
  renderVote();
});
socket.on("result", (r) => {
  lastResult = r;
  myScore = r.score;
  if (r.correct) {
    blip(988, 0.18, 0.09);
    vibrate([0, 35, 45, 35]); // celebratory double buzz
  } else {
    blip(220, 0.22, 0.07);
    vibrate(120); // single longer buzz
  }
  renderVote();
});

// ── State ────────────────────────────────────────────────────
let cur = null;
let skew = 0; // serverNow - localNow, to sync the countdown to the server clock
socket.on("state", (s) => {
  if (typeof s.serverNow === "number") skew = s.serverNow - Date.now();
  cur = s;
  // New step? reset per-step local state.
  const idx = s.step ? s.step.index : -1;
  if (idx !== stepIndex) {
    stepIndex = idx;
    myVote = null;
    lastResult = null;
  }
  render();
  // Run the local countdown only while the host's timer is live.
  if (s.phase === "voting" && s.deadline) {
    if (!timerRAF) timerLoop();
  } else {
    stopTimer();
  }
});

// ── Countdown (synced to the server clock) ───────────────────
let timerRAF = null;
function stopTimer() {
  if (timerRAF) cancelAnimationFrame(timerRAF);
  timerRAF = null;
  const t = el("p-timer");
  if (t) t.classList.add("hidden");
}
function timerLoop() {
  if (!cur || cur.phase !== "voting" || !cur.deadline) return stopTimer();
  const remain = cur.deadline - (Date.now() + skew);
  const secs = Math.max(0, Math.ceil(remain / 1000));
  const t = el("p-timer");
  t.classList.remove("hidden");
  t.classList.toggle("urgent", secs <= 5);
  el("p-timer-num").textContent = secs;
  timerRAF = requestAnimationFrame(timerLoop);
}

// ── Sound + haptics (best-effort; phones may be muted) ───────
let actx = null;
function blip(freq, dur, gain) {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    o.connect(g); g.connect(actx.destination);
    const now = actx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain || 0.08, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + (dur || 0.12));
    o.start(now);
    o.stop(now + (dur || 0.12) + 0.02);
  } catch (_) {}
}
function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) {}
}

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
  // Votes only open once the host starts the countdown.
  const live = cur.phase === "voting" && cur.deadline;
  const locked = revealed || (cur.phase === "voting" && !cur.deadline);
  const wrap = el("p-options");
  const dis = locked ? "disabled" : "";

  if (st.kind === "bug") {
    // Spot the bug: one code editor (line numbers + syntax highlight), tap a line.
    const rows = (st.code || "").split("\n").map((ln, i) => {
      const n = i + 1;
      const id = "L" + n;
      const picked = myVote === id, correct = revealed && id === cur.correctId;
      const cls = classNames("code-line", picked && "picked", correct && "correct", revealed && picked && !correct && "wrong");
      const hi = window.hljs ? hljs.highlight(ln || " ", { language: "python" }).value : escapeHtml(ln || " ");
      return `<button class="${cls}" data-opt="${id}" ${dis}><span class="gutter">${n}</span><span class="ln-code">${hi}</span></button>`;
    }).join("");
    wrap.innerHTML = `<div class="code-block hljs">${rows}</div>`;
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
      const fast = lastResult.speed > 1.2 ? " · ⚡ speed bonus" : "";
      status.innerHTML = `<span class="result-good">Correct! +${lastResult.gained}${combo}${fast}</span>`;
    } else {
      status.innerHTML = '<span class="result-bad">Not quite, see the highlighted answer</span>';
    }
  } else if (revealed && !myVote) {
    status.classList.remove("hidden");
    status.textContent = "Round over, jump in next time!";
  } else if (cur.phase === "voting" && !cur.deadline) {
    status.classList.remove("hidden");
    status.textContent = "Get ready — the host is about to start the timer…";
  } else if (myVote) {
    status.classList.remove("hidden");
    status.textContent = "Locked in (tap another to change)";
  } else if (live) {
    status.classList.remove("hidden");
    status.textContent = "Tap your answer — faster is worth more";
  } else {
    status.classList.add("hidden");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
