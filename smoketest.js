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
  assert(Object.keys(st.files || {}).length === 0, "editor empty at step 1");

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
  assert(rev.files["dags/sales_pipeline.py"] === require("./steps.js")[0].snapshot,
    "best-practice code committed into the editor at Reveal");

  // Show explanation -> phase becomes explaining, slide content exposed
  const explaining = next(stage, "state");
  stage.emit("explain");
  const exp = await explaining;
  assert(exp.phase === "explaining", "phase is explaining after Show explanation");
  assert(Array.isArray(exp.points) && exp.points.length > 0, "explanation points exposed");
  assert(typeof exp.teach === "string" && exp.teach.length > 0, "explanation 'why' exposed");

  // Next -> just advances the round; the step-1 code stays in the editor
  const committed = next(stage, "state");
  stage.emit("next");
  const st2 = await committed;
  const expected = require("./steps.js")[0].snapshot;
  assert(st2.files["dags/sales_pipeline.py"] === expected, "step-1 code persists in the editor after Next");
  assert(st2.step.index === 1 && st2.phase === "voting", "advanced to step 2, voting");

  // Drive the remaining rounds; verify per-file commits, report seeding, and
  // that steps 12+ build the downstream DAG.
  const STEPS = require("./steps.js");
  const lvl = (i) => STEPS[i].level || 1;
  let s = st2;
  let seededReport = false;
  let builtReport = false;
  let levelResetClearedL1 = false;
  let preloadedBefore = false;
  let explainFirstTaught = false;
  while (true) {
    const idx = s.step.index;
    // Explain-first steps open on the teaching slide; open the vote first.
    if (STEPS[idx].explainFirst) {
      assert(s.phase === "teaching", `step ${idx + 1} opens in teaching (explain-first)`);
      explainFirstTaught = true;
      const v = next(stage, "state");
      stage.emit("startVote");
      s = await v;
    }
    alice.emit("vote", { optionId: STEPS[idx].options.find((o) => o.correct).id });
    await wait(50);
    const revd = next(stage, "state");
    stage.emit("reveal");
    s = await revd;
    const f = STEPS[idx].file || "dags/sales_pipeline.py";
    // Steps that build code commit their snapshot at reveal (framing steps have none).
    if (STEPS[idx].snapshot !== undefined && s.files[f] !== STEPS[idx].snapshot) {
      assert(false, `step ${idx + 1} committed into ${f}`);
    }
    if (STEPS[idx].id === "event_driven" && s.files["dags/sales_report.py"]) seededReport = true;
    if (STEPS[idx].file === "dags/sales_report.py" && s.activeFile === "dags/sales_report.py")
      builtReport = true;
    // First step of Level 2: L1 files cleared (fresh slate) + "before" DAGs preloaded.
    if (lvl(idx) === 2 && idx > 0 && lvl(idx - 1) === 1) {
      levelResetClearedL1 = !s.files["dags/sales_pipeline.py"];
      preloadedBefore =
        !!s.files["dags/customers.py"] && !!s.files["dags/orders.py"];
      assert(s.step.level === 2, "level switches to 2 for the Blueprint steps");
    }
    if (idx + 1 >= STEPS.length) {
      const fin = next(stage, "state");
      stage.emit("next");
      s = await fin;
      break;
    }
    const nx = next(stage, "state");
    stage.emit("next");
    s = await nx;
  }
  assert(seededReport, "step 11 seeds dags/sales_report.py");
  assert(builtReport, "Level 1 steps 12-14 build dags/sales_report.py");
  assert(levelResetClearedL1, "entering Level 2 clears the Level 1 files (fresh slate)");
  assert(preloadedBefore, "Level 2 preloads the 'before' DAGs (customers.py + orders.py)");
  assert(explainFirstTaught, "Level 2 build steps open on the teaching slide before the vote");
  assert(s.phase === "finished", "session finishes after the last step");
  assert(
    s.files["dags/templates/blueprints.py"] &&
      s.files["dags/sales.dag.yaml"] &&
      s.files["dags/marketing.dag.yaml"] &&
      s.files["dags/loader.py"],
    "Level 2 builds the Blueprint, sales.dag.yaml, marketing.dag.yaml, and loader.py"
  );
  assert(
    s.files["dags/customers.py"] && s.files["dags/orders.py"],
    "the 'before' DAGs persist as reference tabs through Level 2"
  );

  console.log(`\n${failures === 0 ? "ALL PASS ✅" : failures + " FAILED ❌"}`);
  stage.close(); alice.close(); bob.close();
  process.exit(failures === 0 ? 0 : 1);
})();
