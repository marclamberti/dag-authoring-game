/**
 * DAG Builder Game — realtime server.
 *
 * Two surfaces, one shared session:
 *   /        -> Player view (phones/laptops in the audience). Zero setup.
 *   /stage   -> Stage view (what the presenter shares on screen).
 *
 * The presenter drives the session from the Stage with Start / Reveal /
 * Commit & Next. Votes stream live; on Commit the editor advances to the
 * step's best-practice snapshot.
 */

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const steps = require("./steps");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ── Level 3 sandboxes (Modal) ───────────────────────────────────────────────
// The game brokers per-participant Airflow sandboxes to a deployed Modal app
// (see modal/). If these aren't configured, Level 3's "Start my Airflow" button
// just reports the feature is unavailable — the rest of the game is unaffected.
const MODAL = {
  start: process.env.MODAL_SANDBOX_START_URL,
  stop: process.env.MODAL_SANDBOX_STOP_URL,
  health: process.env.MODAL_SANDBOX_HEALTH_URL,
  token: process.env.MODAL_SANDBOX_TOKEN || "",
};
const SANDBOXES_ENABLED = !!(MODAL.start && MODAL.stop);
const MAX_SANDBOXES = parseInt(process.env.MAX_SANDBOXES || "60", 10);
const queue = []; // socketIds waiting for a free sandbox slot
// Statuses that occupy a concurrency slot.
const ACTIVE_SANDBOX = new Set(["starting", "booting", "ready"]);

async function modalCall(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The shared token travels in the body (keeps the Modal endpoints simple).
    body: JSON.stringify({ ...(body || {}), token: MODAL.token }),
  });
  if (!r.ok) throw new Error(`modal ${r.status}`);
  return r.json();
}

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "player.html"))
);
app.get("/stage", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "stage.html"))
);

// ── Session state ──────────────────────────────────────────────────────────
const players = {}; // socketId -> { name, score }
const DEFAULT_FILE = "dags/sales_pipeline.py";
const DEFAULT_SECONDS = 20; // countdown length when a step doesn't set `seconds`
let countdownTimer = null; // setTimeout handle for the presenter-started countdown
const state = {
  phase: "lobby", // lobby | teaching | voting | revealed | explaining | finished
  stepIndex: -1,
  votes: {}, // optionId -> count (current step)
  voters: {}, // socketId -> optionId (current step)
  voteTimes: {}, // socketId -> ms timestamp the vote landed (for the speed bonus)
  deadline: null, // ms timestamp the countdown ends (null until the host starts it)
  countdownStart: 0, // ms timestamp the countdown started
  roundAccuracy: null, // % of voters correct this round (set at reveal)
  sessionCorrect: 0, // running totals for the session-wide hype meter
  sessionVotes: 0,
  committed: {}, // filename -> committed code (one entry per file being built)
};

const stepSeconds = (s) => (s && s.seconds) || DEFAULT_SECONDS;

const currentStep = () => (state.stepIndex >= 0 ? steps[state.stepIndex] : null);
const fileOf = (s) => (s && s.file) || DEFAULT_FILE;
const levelOf = (s) => (s && s.level) || 1;
function levelInfo(s) {
  const lvl = levelOf(s);
  const same = steps.filter((x) => levelOf(x) === lvl);
  return { level: lvl, levelStep: same.indexOf(s) + 1, levelTotal: same.length };
}
const correctOption = () => currentStep()?.options.find((o) => o.correct);
const playerList = () => Object.values(players).filter((p) => p.name);

// Fixed options for a "review" (PR) round.
const REVIEW_OPTIONS = [
  { id: "approve", label: "Approve" },
  { id: "request", label: "Request changes" },
];
// The id of the correct answer for any round kind: a line ("L7") for "bug",
// the verdict for "review", otherwise the flagged option.
function correctAnswerId(s) {
  if (!s) return null;
  if (s.kind === "bug") return "L" + s.bugLine;
  if (s.kind === "review") return s.verdict;
  return s.options?.find((o) => o.correct)?.id ?? null;
}
// Streak -> score multiplier (caps at 3x).
const multiplierFor = (streak) => Math.min(Math.max(streak, 1), 3);

function leaderboard() {
  return playerList()
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((p) => ({ name: p.name, score: p.score, streak: p.streak || 0 }));
}

function publicStep() {
  const s = currentStep();
  if (!s) return null;
  // NOTE: the correct answer (correctId / bugLine / verdict) and the explanation
  // (teach/points) are NOT included here so they can't leak during voting.
  const base = {
    index: state.stepIndex,
    total: steps.length,
    title: s.title,
    prompt: s.prompt,
    kind: s.kind || "code",
    explainFirst: !!s.explainFirst,
    ...levelInfo(s),
  };
  if (s.kind === "lab") {
    // Hands-on Level 3 round: a checklist to follow in your own Airflow box.
    base.tasks = s.tasks || [];
  } else if (s.kind === "bug") {
    // The buggy code IS the puzzle; players tap a line. bugLine ships on reveal.
    base.code = s.code;
    base.lineCount = s.code.split("\n").length;
  } else if (s.kind === "review") {
    base.diff = s.diff; // the PR; players Approve / Request changes
    base.options = REVIEW_OPTIONS;
  } else {
    base.options = s.options.map((o) => ({ id: o.id, label: o.label, code: o.code }));
  }
  return base;
}

function fullState() {
  // The correct answer is exposed once revealed (for the result highlight);
  // the explanation slide content ships only during the explaining phase.
  const postVote = state.phase === "revealed" || state.phase === "explaining";
  // The explanation slide content shows during the post-vote "explaining" phase
  // AND during the pre-vote "teaching" phase (explain-first steps).
  const slide = state.phase === "explaining" || state.phase === "teaching";
  const s = currentStep();
  return {
    phase: state.phase,
    step: publicStep(),
    votes: state.votes,
    totalVotes: Object.values(state.votes).reduce((a, b) => a + b, 0),
    correctId: postVote ? correctAnswerId(s) : null,
    teach: slide ? s?.teach : null,
    points: slide ? s?.points || [] : null,
    // "Predict & run": the run output is the dramatic post-vote reveal.
    runOutput: postVote && s?.kind === "predict_run" ? s.runOutput || [] : null,
    // Per-file committed code (one tab each on the Stage) and the file the
    // current step is building (the editor auto-focuses it).
    files: state.committed,
    activeFile: s ? fileOf(s) : null,
    playerCount: playerList().length,
    leaderboard: leaderboard(),
    // Presenter-started countdown. Clients sync their local timer off the skew
    // between `serverNow` and their own clock, then tick to `deadline`.
    deadline: state.phase === "voting" ? state.deadline : null,
    durationMs: stepSeconds(s) * 1000,
    serverNow: Date.now(),
    // Co-op hype meter: this round's collective accuracy (post-vote) and the
    // running session accuracy across all rounds so far.
    roundAccuracy: postVote ? state.roundAccuracy : null,
    sessionAccuracy: state.sessionVotes
      ? Math.round((state.sessionCorrect / state.sessionVotes) * 100)
      : null,
    // Level 3: whether per-participant Airflow sandboxes are configured, and how
    // many are currently running (shown on the Stage).
    sandboxEnabled: SANDBOXES_ENABLED,
    sandboxesRunning: countActiveSandboxes(),
  };
}

function broadcast() {
  io.emit("state", fullState());
}

function clearCountdown() {
  if (countdownTimer) clearTimeout(countdownTimer);
  countdownTimer = null;
  state.deadline = null;
  state.countdownStart = 0;
}

function goToStep(i) {
  const prev = state.stepIndex >= 0 ? steps[state.stepIndex] : null;
  state.stepIndex = i;
  // Level 3 "lab" steps are hands-on (no vote); explain-first steps open on the
  // teaching slide; everything else opens straight into voting.
  state.phase =
    steps[i].kind === "lab" ? "lab" : steps[i].explainFirst ? "teaching" : "voting";
  state.votes = {};
  state.voters = {};
  state.voteTimes = {};
  state.roundAccuracy = null;
  clearCountdown();
  const cs = steps[i];
  if (cs.kind === "review") state.votes = { approve: 0, request: 0 };
  else if (cs.kind !== "bug" && cs.options) for (const o of cs.options) state.votes[o.id] = 0;
  // "bug" rounds tally line votes ("L7") as they arrive (no preset keys).
  // Crossing into a new level starts the editor on a fresh slate; the Stage
  // plays the door animation to cover the swap.
  if (prev && levelOf(steps[i]) !== levelOf(prev)) state.committed = {};
  // Drop an ephemeral bug round's throwaway file so it doesn't linger as a tab.
  if (prev && prev.kind === "bug" && prev.ephemeral) delete state.committed[fileOf(prev)];
  // "bug" rounds show their buggy code in the editor (players tap a line).
  if (cs.kind === "bug") state.committed[fileOf(cs)] = cs.code;
  // Preload reference files for this step (e.g. the "before" DAGs), so they show
  // during voting, before any code is committed.
  if (steps[i].preload) {
    for (const [f, code] of Object.entries(steps[i].preload)) {
      if (state.committed[f] === undefined) state.committed[f] = code;
    }
  }
  broadcast();
}

// Lock votes, score everyone (streak × speed bonus), tally room accuracy, and
// commit the snippet. Called by the "reveal" button OR the countdown timeout.
function doReveal() {
  if (state.phase !== "voting") return;
  state.phase = "revealed";
  const deadlineWas = state.deadline; // capture before clearCountdown() nulls it
  clearCountdown();
  const s = currentStep();
  const correct = correctAnswerId(s);
  const dur = stepSeconds(s) * 1000;
  let correctCount = 0;
  const voterIds = Object.keys(state.voters);
  for (const sid of voterIds) {
    const p = players[sid];
    if (!p) continue;
    const got = state.voters[sid] === correct;
    let gained = 0;
    let mult = 0;
    let speed = 1;
    if (got) {
      correctCount++;
      // Streak multiplier: each consecutive correct answer is worth more.
      p.streak = (p.streak || 0) + 1;
      mult = multiplierFor(p.streak);
      // Speed bonus: answering with more time left earns up to +50%.
      const t = state.voteTimes[sid];
      if (deadlineWas && t) {
        const frac = Math.max(0, Math.min(1, (deadlineWas - t) / dur));
        speed = 1 + 0.5 * frac;
      }
      gained = Math.round((100 * mult * speed) / 10) * 10;
      p.score += gained;
    } else {
      p.streak = 0; // a wrong answer breaks the combo
    }
    io.to(sid).emit("result", {
      correct: got,
      correctId: correct,
      gained,
      multiplier: mult,
      speed: +speed.toFixed(2),
      streak: p.streak,
      score: p.score,
    });
  }
  // Co-op hype meter: this round's accuracy + the running session accuracy.
  state.roundAccuracy = voterIds.length
    ? Math.round((correctCount / voterIds.length) * 100)
    : null;
  state.sessionCorrect += correctCount;
  state.sessionVotes += voterIds.length;
  // Commit the best-practice snippet into this step's file at reveal time, so
  // the code appears as the result is shown (not later on Next).
  if (s.snapshot !== undefined) state.committed[fileOf(s)] = s.snapshot;
  // Seed any additional files (e.g. the downstream DAG) the first time only.
  if (s.seed) {
    for (const [f, code] of Object.entries(s.seed)) {
      if (state.committed[f] === undefined) state.committed[f] = code;
    }
  }
  broadcast();
}

// ── Sandbox brokering ───────────────────────────────────────────────────────
function setSandbox(socketId, sb) {
  const p = players[socketId];
  if (p) p.sandbox = sb;
  io.to(socketId).emit("sandbox", sb);
}
function countActiveSandboxes() {
  return Object.values(players).filter(
    (p) => p.sandbox && ACTIVE_SANDBOX.has(p.sandbox.status)
  ).length;
}
// Promote queued players whenever a slot frees up.
function promoteQueue() {
  while (queue.length && countActiveSandboxes() < MAX_SANDBOXES) {
    const sid = queue.shift();
    if (players[sid]) launchSandbox(sid); // sets status synchronously → counts immediately
  }
}
// Create a sandbox for this player, then poll until Airflow is reachable.
async function launchSandbox(socketId) {
  if (!players[socketId]) return;
  setSandbox(socketId, { status: "starting" }); // occupies a slot before we await
  try {
    const { id, url } = await modalCall(MODAL.start, {});
    if (!players[socketId]) {
      // They left mid-launch — don't leak the box.
      modalCall(MODAL.stop, { id }).catch(() => {});
      promoteQueue();
      return;
    }
    setSandbox(socketId, { status: "booting", url, id });
    pollSandbox(socketId, 0);
  } catch (e) {
    setSandbox(socketId, { status: "error", error: String((e && e.message) || e) });
    promoteQueue();
  }
}
// Poll the health endpoint until the box is ready (or gone). ~200s ceiling.
function pollSandbox(socketId, attempt) {
  if (!MODAL.health) return; // can't poll; the player just waits on the iframe
  const p = players[socketId];
  const sb = p && p.sandbox;
  if (!sb || !sb.id || sb.status === "ready") return;
  const retry = () => {
    if (attempt < 40) setTimeout(() => pollSandbox(socketId, attempt + 1), 5000);
  };
  modalCall(MODAL.health, { id: sb.id })
    .then((res) => {
      const cur = players[socketId] && players[socketId].sandbox;
      if (!cur || cur.id !== sb.id) return; // superseded
      if (res.status === "ready") setSandbox(socketId, { ...cur, status: "ready" });
      else if (res.status === "stopped" || res.status === "gone") {
        setSandbox(socketId, { status: "stopped" });
        promoteQueue();
      } else retry();
    })
    .catch(retry);
}
// Stop a player's box (if any), drop them from the queue, free the slot.
function teardownSandbox(socketId, { reset } = {}) {
  const p = players[socketId];
  const sb = p && p.sandbox;
  if (sb && sb.id) modalCall(MODAL.stop, { id: sb.id }).catch(() => {});
  const qi = queue.indexOf(socketId);
  if (qi >= 0) queue.splice(qi, 1);
  if (p) setSandbox(socketId, { status: reset ? "idle" : "stopped" });
  promoteQueue();
}

// ── Sockets ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  // Either surface asks for current state on load.
  socket.emit("state", fullState());

  // ----- Player -----
  socket.on("join", ({ name }) => {
    players[socket.id] = {
      name: String(name || "Player").trim().slice(0, 24) || "Player",
      score: 0,
      streak: 0,
      sandbox: { status: "idle" }, // Level 3 Airflow sandbox state
    };
    socket.emit("joined", { id: socket.id, score: 0 });
    broadcast();
  });

  // ----- Level 3: per-participant Airflow sandbox -----
  socket.on("startSandbox", () => {
    const p = players[socket.id];
    if (!p) return;
    if (!SANDBOXES_ENABLED) {
      setSandbox(socket.id, { status: "unavailable" });
      return;
    }
    const status = p.sandbox && p.sandbox.status;
    // Already in flight or up? ignore (idempotent button).
    if (["starting", "booting", "ready", "queued", "stopping"].includes(status)) return;
    if (countActiveSandboxes() >= MAX_SANDBOXES) {
      if (!queue.includes(socket.id)) queue.push(socket.id);
      setSandbox(socket.id, { status: "queued", place: queue.indexOf(socket.id) + 1 });
      return;
    }
    launchSandbox(socket.id);
  });

  socket.on("stopSandbox", () => {
    if (players[socket.id]) teardownSandbox(socket.id, { reset: true });
  });

  socket.on("vote", ({ optionId }) => {
    const p = players[socket.id];
    if (!p || state.phase !== "voting") return;
    // Votes only count while the presenter's countdown is live.
    if (!state.deadline || Date.now() > state.deadline) return;
    const s = currentStep();
    let valid;
    if (s.kind === "bug") {
      const m = /^L(\d+)$/.exec(optionId);
      valid = !!m && +m[1] >= 1 && +m[1] <= s.code.split("\n").length;
    } else if (s.kind === "review") {
      valid = optionId === "approve" || optionId === "request";
    } else {
      valid = s.options.some((o) => o.id === optionId);
    }
    if (!valid) return;

    const prev = state.voters[socket.id];
    if (prev === optionId) return;
    if (prev) state.votes[prev] = Math.max(0, (state.votes[prev] || 0) - 1);
    state.voters[socket.id] = optionId;
    state.votes[optionId] = (state.votes[optionId] || 0) + 1;
    state.voteTimes[socket.id] = Date.now(); // for the speed bonus at reveal

    socket.emit("voted", { optionId });
    io.emit("votes", { votes: state.votes, totalVotes: Object.values(state.votes).reduce((a, b) => a + b, 0) });
  });

  // ----- Stage controls -----
  socket.on("start", () => {
    if (state.phase === "lobby" || state.phase === "finished") {
      state.committed = {};
      goToStep(0);
    }
  });

  // Debug: jump straight to the first Level 3 (lab) step from anywhere.
  socket.on("skipToLevel3", () => {
    const i = steps.findIndex((s) => levelOf(s) === 3);
    if (i < 0) return;
    state.committed = {};
    goToStep(i);
  });

  // Explain-first: after the teaching slide, open the vote.
  socket.on("startVote", () => {
    if (state.phase !== "teaching") return;
    state.phase = "voting";
    broadcast();
  });

  // Presenter starts the timer when the room is ready; votes are only accepted
  // while it runs, and it auto-reveals when it hits zero.
  socket.on("startCountdown", () => {
    if (state.phase !== "voting" || state.deadline) return;
    const dur = stepSeconds(currentStep()) * 1000;
    state.countdownStart = Date.now();
    state.deadline = state.countdownStart + dur;
    if (countdownTimer) clearTimeout(countdownTimer);
    countdownTimer = setTimeout(doReveal, dur);
    broadcast();
  });

  socket.on("reveal", doReveal);

  // Reveal -> Show explanation: turn the right panel into the step's slide.
  socket.on("explain", () => {
    if (state.phase !== "revealed") return;
    state.phase = "explaining";
    broadcast();
  });

  socket.on("next", () => {
    // Level 3 "lab" steps have no vote/reveal — Next just advances them.
    if (!["revealed", "explaining", "lab"].includes(state.phase)) return;
    // Code was already committed at reveal; Next just advances the round.
    if (state.stepIndex + 1 < steps.length) {
      goToStep(state.stepIndex + 1);
    } else {
      state.phase = "finished";
      broadcast();
    }
  });

  socket.on("reset", () => {
    state.phase = "lobby";
    state.stepIndex = -1;
    state.votes = {};
    state.voters = {};
    state.voteTimes = {};
    state.roundAccuracy = null;
    state.sessionCorrect = 0;
    state.sessionVotes = 0;
    clearCountdown();
    state.committed = {};
    queue.length = 0; // clear first so teardown's promoteQueue can't relaunch
    for (const id in players) {
      players[id].score = 0;
      players[id].streak = 0;
      teardownSandbox(id, { reset: true }); // stop everyone's Airflow box
    }
    broadcast();
  });

  socket.on("disconnect", () => {
    teardownSandbox(socket.id); // stop their box before we forget the id
    delete players[socket.id];
    delete state.voters[socket.id];
    broadcast();
  });
});

server.listen(PORT, () => {
  console.log(`\n  DAG Builder Game running:`);
  console.log(`    Players :  http://localhost:${PORT}/`);
  console.log(`    Stage   :  http://localhost:${PORT}/stage\n`);
});
