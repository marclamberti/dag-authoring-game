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
const state = {
  phase: "lobby", // lobby | teaching | voting | revealed | explaining | finished
  stepIndex: -1,
  votes: {}, // optionId -> count (current step)
  voters: {}, // socketId -> optionId (current step)
  committed: {}, // filename -> committed code (one entry per file being built)
};

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
  if (s.kind === "bug") {
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
  };
}

function broadcast() {
  io.emit("state", fullState());
}

function goToStep(i) {
  const prev = state.stepIndex >= 0 ? steps[state.stepIndex] : null;
  state.stepIndex = i;
  // Explain-first steps open on the teaching slide before the vote.
  state.phase = steps[i].explainFirst ? "teaching" : "voting";
  state.votes = {};
  state.voters = {};
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
    };
    socket.emit("joined", { id: socket.id, score: 0 });
    broadcast();
  });

  socket.on("vote", ({ optionId }) => {
    const p = players[socket.id];
    if (!p || state.phase !== "voting") return;
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

  // Explain-first: after the teaching slide, open the vote.
  socket.on("startVote", () => {
    if (state.phase !== "teaching") return;
    state.phase = "voting";
    broadcast();
  });

  socket.on("reveal", () => {
    if (state.phase !== "voting") return;
    state.phase = "revealed";
    const s = currentStep();
    const correct = correctAnswerId(s);
    for (const [sid, opt] of Object.entries(state.voters)) {
      const p = players[sid];
      if (!p) continue;
      const got = opt === correct;
      let gained = 0;
      let mult = 0;
      if (got) {
        // Streak multiplier: each consecutive correct answer is worth more.
        p.streak = (p.streak || 0) + 1;
        mult = multiplierFor(p.streak);
        gained = 100 * mult;
        p.score += gained;
      } else {
        p.streak = 0; // a wrong answer breaks the combo
      }
      io.to(sid).emit("result", {
        correct: got,
        correctId: correct,
        gained,
        multiplier: mult,
        streak: p.streak,
        score: p.score,
      });
    }
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
  });

  // Reveal -> Show explanation: turn the right panel into the step's slide.
  socket.on("explain", () => {
    if (state.phase !== "revealed") return;
    state.phase = "explaining";
    broadcast();
  });

  socket.on("next", () => {
    if (state.phase !== "revealed" && state.phase !== "explaining") return;
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
    state.committed = {};
    for (const id in players) {
      players[id].score = 0;
      players[id].streak = 0;
    }
    broadcast();
  });

  socket.on("disconnect", () => {
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
