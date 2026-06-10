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
    burstConfetti(110); // your reward for nailing it
  } else {
    blip(220, 0.22, 0.07);
    vibrate(120); // single longer buzz
  }
  renderVote();
});

// ── State ────────────────────────────────────────────────────
let cur = null;
let skew = 0; // serverNow - localNow, to sync the countdown to the server clock
let lastLevel = null; // to celebrate reaching a new level
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
  // Reaching a new level is a shared win — confetti for the whole room.
  const lvl = s.step ? s.step.level : null;
  if (lvl && lastLevel !== null && lvl > lastLevel) burstConfetti(150);
  if (lvl) lastLevel = lvl;
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

// ── Confetti (self-contained canvas burst) ───────────────────
const confettiCanvas = el("confetti");
const cctx = confettiCanvas.getContext("2d");
let confParts = [], confRAF = null;
function sizeConfetti() { confettiCanvas.width = innerWidth; confettiCanvas.height = innerHeight; }
sizeConfetti();
addEventListener("resize", sizeConfetti);
function burstConfetti(count) {
  sizeConfetti();
  const colors = ["#9146ff", "#00f593", "#1db3ff", "#ffca5f", "#ffffff"];
  for (let i = 0; i < (count || 120); i++) {
    confParts.push({
      x: Math.random() * innerWidth,
      y: -20 - Math.random() * innerHeight * 0.3,
      vx: (Math.random() - 0.5) * 6,
      vy: 3 + Math.random() * 5,
      g: 0.12 + Math.random() * 0.08,
      size: 6 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[i % colors.length],
    });
  }
  if (!confRAF) confLoop();
}
function confLoop() {
  cctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  for (const p of confParts) {
    p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
    cctx.save();
    cctx.translate(p.x, p.y);
    cctx.rotate(p.rot);
    cctx.fillStyle = p.color;
    cctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
    cctx.restore();
  }
  confParts = confParts.filter((p) => p.y < confettiCanvas.height + 40);
  if (confParts.length) confRAF = requestAnimationFrame(confLoop);
  else { confRAF = null; cctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height); }
}

function show(screen) {
  for (const id of ["join-screen", "wait-screen", "vote-screen", "lab-screen"]) {
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
  } else if (phase === "lab") {
    show("lab-screen");
    renderLab();
  } else {
    show("vote-screen");
    renderVote();
  }
}

// ── Level 3 lab: your own Airflow ────────────────────────────
let sandbox = { status: "idle" }; // updated by the per-socket "sandbox" event
socket.on("sandbox", (sb) => {
  sandbox = sb || { status: "idle" };
  if (cur && cur.phase === "lab") renderSandbox();
});

function renderLab() {
  if (!cur || !cur.step) return;
  el("lab-title").textContent = cur.step.title;
  el("lab-prompt").textContent = cur.step.prompt;
  el("lab-tasks").innerHTML = (cur.step.tasks || [])
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join("");
  el("lab-score").textContent = myScore > 0 ? `Score: ${myScore}` : "";
  renderSandbox();
}

function renderSandbox() {
  const box = el("lab-sandbox");
  const st = sandbox.status;

  if (!cur.sandboxEnabled || st === "unavailable") {
    box.innerHTML =
      '<div class="lab-msg">Live sandboxes aren\'t enabled for this session — just follow along on the big screen.</div>';
    return;
  }

  // Airflow opens in a new tab (a cross-origin iframe can't run it — browsers
  // block the storage its UI needs). As soon as we have a URL, show the button.
  if ((st === "booting" || st === "ready") && sandbox.url) {
    const u = escapeAttr(sandbox.url);
    const booting = st === "booting";
    box.innerHTML =
      `<a class="p-opt lab-open-primary" href="${u}" target="_blank" rel="noopener">Open my Airflow ↗</a>` +
      (booting
        ? `<div class="lab-booting"><div class="spinner"></div><div>Booting… the first load can take ~90s. If the tab isn't up yet, wait a moment and refresh it.</div></div>`
        : `<div class="lab-ready">Your Airflow is ready — it opens in a new tab.</div>`) +
      `<button class="lab-stop" id="lab-stop-btn">Stop my Airflow</button>`;
    el("lab-stop-btn").addEventListener("click", () => socket.emit("stopSandbox"));
    return;
  }

  if (st === "queued") {
    box.innerHTML = `<div class="lab-msg">You're #${sandbox.place || "?"} in line — your Airflow starts as a slot frees up.</div>`;
    return;
  }
  if (st === "starting") {
    box.innerHTML = '<div class="lab-booting"><div class="spinner"></div><div>Requesting your sandbox…</div></div>';
    return;
  }
  // idle / stopped / error -> a start button
  const err =
    st === "error"
      ? `<div class="lab-msg err">Couldn't start: ${escapeHtml(sandbox.error || "")}. Try again.</div>`
      : st === "stopped"
      ? '<div class="lab-msg">Sandbox stopped. Start a fresh one anytime.</div>'
      : "";
  box.innerHTML = `${err}<button class="p-opt lab-start" id="lab-start-btn">Start my Airflow</button>`;
  el("lab-start-btn").addEventListener("click", () => {
    blip(660, 0.08, 0.05);
    sandbox = { status: "starting" };
    renderSandbox();
    socket.emit("startSandbox");
  });
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
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
