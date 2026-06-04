/* End-to-end smoke test: boots the server, simulates a stage + two players
 * through one full round, asserts votes/scoring/editor-commit work. */
process.env.PORT = "3999";
require("./server.js");
const { io } = require("socket.io-client");
const URL = "http://localhost:3999";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const next = (sock, ev) => new Promise((r) => sock.once(ev, r));

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
}

(async () => {
  await wait(400);
  const stage = io(URL);
  const alice = io(URL);
  const bob = io(URL);
  await wait(300);

  // Join two players
  alice.emit("join", { name: "Alice" });
  bob.emit("join", { name: "Bob" });
  await wait(200);

  // Start the session
  const started = next(stage, "state");
  stage.emit("start");
  const st = await started;
  assert(st.phase === "voting", "session starts in voting phase");
  assert(st.step && st.step.index === 0, "first step loaded");
  assert(st.committedCode === "", "editor empty at step 1");

  const correctId = require("./steps.js")[0].options.find((o) => o.correct).id;
  const wrongId = require("./steps.js")[0].options.find((o) => !o.correct).id;

  alice.emit("vote", { optionId: correctId }); // Alice right
  bob.emit("vote", { optionId: wrongId }); //   Bob wrong
  await wait(200);

  // Reveal
  const aliceResult = next(alice, "result");
  const bobResult = next(bob, "result");
  const revealed = next(stage, "state");
  stage.emit("reveal");
  const [ar, br, rev] = await Promise.all([aliceResult, bobResult, revealed]);

  assert(rev.phase === "revealed", "phase is revealed after Reveal");
  assert(rev.correctId === correctId, "correct option exposed on reveal");
  assert(ar.correct === true && ar.score === 100, "Alice scored 100 for correct vote");
  assert(br.correct === false && br.score === 0, "Bob scored 0 for wrong vote");
  assert(rev.leaderboard[0].name === "Alice" && rev.leaderboard[0].score === 100,
    "Alice tops the leaderboard");
  assert(rev.points == null, "explanation points hidden until Show explanation");

  // Show explanation -> phase becomes explaining, slide content exposed
  const explaining = next(stage, "state");
  stage.emit("explain");
  const exp = await explaining;
  assert(exp.phase === "explaining", "phase is explaining after Show explanation");
  assert(Array.isArray(exp.points) && exp.points.length > 0, "explanation points exposed");
  assert(typeof exp.teach === "string" && exp.teach.length > 0, "explanation 'why' exposed");

  // Commit & Next -> editor should advance to step 1's snapshot
  const committed = next(stage, "state");
  stage.emit("next");
  const st2 = await committed;
  const expected = require("./steps.js")[0].snapshot;
  assert(st2.committedCode === expected, "editor advanced to step-1 best-practice snapshot");
  assert(st2.step.index === 1 && st2.phase === "voting", "advanced to step 2, voting");

  console.log(`\n${failures === 0 ? "ALL PASS ✅" : failures + " FAILED ❌"}`);
  stage.close(); alice.close(); bob.close();
  process.exit(failures === 0 ? 0 : 1);
})();
