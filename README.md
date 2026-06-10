# DAG Builder Game 🛠️

A **slide-free, fully interactive** format for a DAG-authoring webinar. The
audience collectively writes a best-practice Apache Airflow 3 DAG, **one line at
a time**, by voting on each authoring decision. Every option maps to a real
choice, the wrong ones are the teaching moments.

- **Stage** (you share this on screen): a code editor that grows as the DAG is
  built, the current question with a live vote bar, and a leaderboard.
- **Player** (the audience, zero setup): scan the QR / open the URL, pick a
  name, and tap to vote. Phones, laptops, anything with a browser.

When you hit **Reveal**, the room sees the split and the best-practice answer is
**always** the one written into the editor (so the final DAG is correct no
matter how the crowd votes). Players who picked it score points.

## How it runs

```
┌──────────────┐    votes     ┌─────────────┐   live editor + tally
│  Players     │ ───────────▶ │   Server    │ ─────────────────────▶  Stage
│ (their phone)│ ◀─────────── │ (Socket.IO) │   start / reveal / next  (your screen)
└──────────────┘   questions  └─────────────┘
```

## Quick start

```bash
npm install
npm start
```

Then open:

- **Stage** → http://localhost:3000/stage  (share this screen)
- **Players** → http://localhost:3000/  (the QR on the Stage points here)

Drive the session from the Stage:

1. **Start** opens the first round.
2. **Start countdown** opens the vote window — a timer drains on every screen and
   votes are only accepted while it runs. (Explain-first steps open on a teaching
   slide first; click **Start vote** when ready, then **Start countdown**.)
3. Audience votes; the bar fills live. **Reveal now** locks votes early, or the
   timer auto-reveals at zero. Reveal shows the split, highlights the
   best-practice option, scores correct voters, and types the snippet into the
   editor.
4. **Show explanation** turns the right panel into a slide (why + takeaways);
   then **Next step** moves on. (Explain-first steps skip straight to Next.)

`Reset` clears the editor and all scores back to the lobby. Crossing into a new
level plays a door transition and starts the editor fresh (scores carry over).

### Game feel

The build doubles as a game show, all client-side, no extra setup:

- **Presenter-started countdown + speed bonus** — you click **Start countdown**
  when the room is ready; answering earlier in the window is worth up to +50%.
  Length is 20s by default, or per-step via a `seconds` field in `steps.js`.
- **Streak multiplier** — consecutive correct answers score `100 × min(streak, 3)`
  (a wrong answer resets the combo), shown as a 🔥 flame on the leaderboard.
- **Sound, confetti & haptics** — the Stage plays vote blips, a reveal sting, a
  last-5-seconds heartbeat and a level-up fanfare (Web Audio, no asset files).
  Confetti fires on each player's **own** phone when they get the answer right
  (plus a shared burst on level-up), and phones buzz on your result.
- **Animated leaderboard** — rows slide to their new rank (FLIP) as scores change.
- **Co-op hype meter** — each reveal shows the room's collective accuracy this
  round plus the running session accuracy, framing it as a team effort.

### Running it for a real (remote) audience

`localhost` only works on your machine. The QR/URL on the Stage always points at
whatever host it's served from, so deploying needs no code change. It's a
stateful Socket.IO server with the game in memory, so host it as **one instance**
on a **persistent Node process** (not serverless, not autoscaled).

**Deploy to Render (one click)** — a [`render.yaml`](./render.yaml) Blueprint is
included:

1. Push this repo to GitHub (done).
2. [render.com](https://render.com) → **New → Blueprint** → pick the repo →
   **Apply**. It runs `npm install` / `npm start` and gives you an HTTPS URL.
3. Share `https://<your-app>.onrender.com/stage` on screen; the QR sends the
   audience to `/`.

The free tier **sleeps after ~15 min idle** (cold start ~30s) — open the URL a
few minutes before you go live, or switch the `plan` in `render.yaml` to
`starter` to keep it warm. Railway and Fly.io work the same way (Fly needs a
Dockerfile).

**Quickest, no deploy** — run locally and expose a public HTTPS tunnel for a
one-off session: `npm start`, then `npx cloudflared tunnel --url http://localhost:3000`.

On the same LAN you can also just share `http://<your-LAN-IP>:3000/`.

## The build-script (what gets voted on)

All rounds live in [`steps.js`](./steps.js), edit/reorder freely, nothing else
needs to change. Each step targets a `file` (one editor tab each) and a `level`;
crossing into a new level plays a full-screen door transition and starts the
editor on a fresh slate (scores carry over). The arc:

## Level 1, Author DAGs in Python

**`dags/sales_pipeline.py`**

1. Instantiate the DAG (`@dag` decorator)
2. Schedule on multiple crons (`MultipleCronTriggerTimetable`, e.g. 9am & 5pm weekdays)
3. `start_date` (static datetime, not `datetime.now()`; Airflow 3 defaults `catchup=False`)
4. Settings every DAG should have (`doc_md`, `tags`, `dagrun_timeout`, `max_consecutive_failed_dag_runs`)
5. Define the first task (`@task` vs `PythonOperator`)
6. Idempotency: `get_date` returns the injected `ds`, not `datetime.now()`
7. No top-level code (read the API URL from a `Variable` inside the task)
8. Pass data downstream (date → extract → transform via XCom)
9. Make `load` resilient (`retries`, `retry_delay`, exponential backoff, `execution_timeout`)
10. Wire dependencies the TaskFlow way
11. **DAG versioning**, predict-then-reveal (Airflow 3 spotlight)
12. **Trigger a downstream DAG**, emit an `Asset` outlet; a second tab seeds the consumer DAG

**`dags/sales_report.py`** (the downstream DAG)

13. **Dynamic task mapping** (`.expand()`), one report per region instead of a loop
14. **Task groups** (`@task_group`), readable, modular, reusable, mappable
15. **Deferrable mode** (`deferrable=True`), wait via the triggerer without holding a slot

## Level 2, Blueprint (from copy-pasted DAGs to validated templates)

Opens on a "before" state: two drifted, hand-copied DAGs (`dags/customers.py`,
`dags/orders.py`) are preloaded as read-only reference tabs. Each round then
improves on them, building `dags/templates/blueprints.py`, `dags/sales.dag.yaml`,
`dags/marketing.dag.yaml`, and `dags/loader.py`.

1. **The problem** — 50 analysts copy a DAG → drift, no validation (the before-DAGs)
2. **Define a Blueprint** — extract the extract→load pattern into `Blueprint[Config].render()`
3. **Validate the config** — Pydantic `Field` + `ConfigDict(extra="forbid")`
4. **Compose a DAG in YAML** — `sales.dag.yaml`; the ~25-line DAG becomes a few lines
5. **Wire the steps** — `depends_on: [...]`
6. **A second pipeline, for free** — `marketing.dag.yaml` reuses the blueprint, no Python
7. **Load the YAML DAGs** — `dags/loader.py` calling `build_all_dags()`
8. **Blueprint vs DAG Factory** — flip between `dag_factory.yaml` (verbose, raw Airflow) and `sales.dag.yaml` (Blueprint) for the same pipeline

## Level 3, Run it for real (your own Airflow)

Hands-on, no voting. Each participant taps **Start my Airflow** and gets a
**dedicated Airflow 3** booted on demand in a [Modal](https://modal.com) sandbox,
embedded right in their phone/laptop (with an "open in new tab" fallback). They
run, for real, the patterns the room just authored:

1. **Your own Airflow** — boot the sandbox, log in (no password)
2. **Run the Blueprint pipeline** — trigger `sales_pipeline` (composed from a Blueprint) and watch it go green
3. **AI draft, you approve** — trigger `ai_release_notes`: the **Common AI provider** (`@task.llm`) drafts a note, then a **Human-in-the-Loop** `ApprovalOperator` waits for the participant to approve before it publishes

This needs the Modal side deployed and a few env vars set (below). **Without
them the first two levels are unaffected** — the Level 3 "Start my Airflow"
button simply reports that sandboxes aren't enabled. Full setup, cost notes, and
the seeded DAGs live in **[`modal/README.md`](./modal/README.md)**.

```
MODAL_SANDBOX_START_URL=…    # printed by `modal deploy modal/airflow_sandbox.py`
MODAL_SANDBOX_STOP_URL=…
MODAL_SANDBOX_HEALTH_URL=…
MODAL_SANDBOX_TOKEN=…        # shared secret with the Modal app
MAX_SANDBOXES=60             # concurrency cap; the server queues beyond it
```

The server brokers `start`/`stop`/`health` to Modal, caps concurrency (queuing
extra participants), and **auto-stops a participant's box** when they disconnect
or you Reset — so you don't pay for idle Airflows.

### Editing a round

Each step is one object in `steps.js`:

```js
{
  id: "idempotency",
  kind: "code",            // "code" advances the editor; "predict" is a knowledge round
  level: 1,               // optional (default 1); a new level triggers the door transition
  file: "dags/sales_pipeline.py", // optional (default); which editor tab this step builds
  explainFirst: true,     // optional; open on the teaching slide before the vote
  seconds: 20,            // optional (default 20); countdown length for this round
  title: "Step 6: Make the first task idempotent",
  prompt: "get_date returns the run's date. What should it return?",
  teach: "Return the run logical date (ds), not the wall clock.", // one-line slide headline
  points: ["…bullet takeaways shown on the explanation slide…"],
  options: [
    { id: "a", label: "ds parameter", correct: true, code: "@task\ndef get_date(ds=None):\n    return ds" },
    { id: "b", label: "datetime.now().date()", code: "…" },
  ],
  // snapshot: committed into the editor at Reveal. A step may also `preload`/`seed`
  // other files (reference tabs). Omit snapshot for a pure knowledge round.
  snapshot: `…full file after this step…`,
}
```

The option flagged `correct: true` is what scores points and what `snapshot`
reflects.

A `kind: "lab"` step (Level 3) is hands-on instead of a vote — it carries a
`tasks: ["…", "…"]` checklist the participant follows in their own Airflow
sandbox, and the presenter just clicks **Next** to move between lab steps.

## Tech

Node + Express + Socket.IO + a vanilla HTML/CSS/JS front-end, no build step,
runs with one command, and a single server comfortably handles a few hundred
live voters. (Easy to wrap in Next.js later if you want richer visuals.)

## Project layout

```
server.js          realtime server + session state machine + sandbox brokering
steps.js           the build-script (all voting rounds + Level 3 labs)
public/
  stage.html/.js   presenter screen (editor + live tally + leaderboard + QR)
  player.html/.js  audience screen (join + vote + Level 3 Airflow iframe)
  style.css        shared styling
modal/             Level 3: Modal app that boots per-participant Airflow sandboxes
  airflow_sandbox.py   image + start/stop/health endpoints
  start_airflow.sh     sandbox entrypoint (Airflow standalone + Caddy proxy)
  Caddyfile            strips frame headers so the UI can be iframed
  dags/                seeded DAGs (Blueprint pipeline + Common AI/HITL)
  README.md            deploy + cost guide
```
