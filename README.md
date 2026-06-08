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

1. **Start ▶**, opens the first vote.
2. Audience votes; the bar fills live.
3. **Reveal results 👀**, locks votes, shows the split, highlights the
   best-practice option, scores correct voters, and shows the "why".
4. **Commit & Next →**, types the best-practice snippet into the editor and
   moves to the next decision.

`Reset` clears the editor and all scores back to the lobby.

### Running it for a real (remote) audience

`localhost` only works on your machine. For a live webinar, deploy the app
somewhere public (Render, Railway, Fly.io, a small VM, anything that runs Node
and allows WebSockets) and the QR/URL on the Stage will automatically point at
that host. On the same LAN you can instead share `http://<your-LAN-IP>:3000/`.

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
4. Define the first task (`@task` vs `PythonOperator`)
5. Idempotency: `get_date` returns the injected `ds`, not `datetime.now()`
6. No top-level code (read the API URL from a `Variable` inside the task)
7. Pass data downstream (date → extract → transform via XCom)
8. Make `load` resilient (`retries`, `retry_delay`, exponential backoff, `execution_timeout`)
9. Wire dependencies the TaskFlow way
10. **DAG versioning**, predict-then-reveal (Airflow 3 spotlight)
11. **Trigger a downstream DAG**, emit an `Asset` outlet; a second tab seeds the consumer DAG

**`dags/sales_report.py`** (the downstream DAG)

12. **Dynamic task mapping** (`.expand()`), one report per region instead of a loop
13. **Task groups** (`@task_group`), readable, modular, reusable, mappable
14. **Deferrable mode** (`deferrable=True`), wait via the triggerer without holding a slot

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

### Editing a round

Each step is one object in `steps.js`:

```js
{
  id: "schedule",
  kind: "code",                 // "code" advances the editor; "predict" is a knowledge round
  title: "Step 2: Schedule it",
  prompt: "This is a plain daily batch. How do we schedule it?",
  teach: "Why @daily wins …",   // shown on Reveal
  options: [
    { id: "a", label: 'schedule="@daily"', correct: true, code: '@dag(schedule="@daily")' },
    { id: "b", label: "schedule_interval=…",                code: "…" },
  ],
  snapshot: `…full file after this step…`, // committed into the editor on "Next"
}
```

The option flagged `correct: true` is what scores points and what `snapshot`
reflects.

## Tech

Node + Express + Socket.IO + a vanilla HTML/CSS/JS front-end, no build step,
runs with one command, and a single server comfortably handles a few hundred
live voters. (Easy to wrap in Next.js later if you want richer visuals.)

## Project layout

```
server.js          realtime server + session state machine
steps.js           the build-script (all voting rounds)
public/
  stage.html/.js   presenter screen (editor + live tally + leaderboard + QR)
  player.html/.js  audience screen (join + vote)
  style.css        shared styling
```
