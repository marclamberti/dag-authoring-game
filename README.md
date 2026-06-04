# DAG Builder Game 🛠️

A **slide-free, fully interactive** format for a DAG-authoring webinar. The
audience collectively writes a best-practice Apache Airflow 3 DAG, **one line at
a time**, by voting on each authoring decision. Every option maps to a real
choice — the wrong ones are the teaching moments.

- **Stage** (you share this on screen): a code editor that grows as the DAG is
  built, the current question with a live vote bar, and a leaderboard.
- **Player** (the audience, zero setup): scan the QR / open the URL, pick a
  name, and tap to vote. Phones, laptops — anything with a browser.

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

1. **Start ▶** — opens the first vote.
2. Audience votes; the bar fills live.
3. **Reveal results 👀** — locks votes, shows the split, highlights the
   best-practice option, scores correct voters, and shows the "why".
4. **Commit & Next →** — types the best-practice snippet into the editor and
   moves to the next decision.

`Reset` clears the editor and all scores back to the lobby.

### Running it for a real (remote) audience

`localhost` only works on your machine. For a live webinar, deploy the app
somewhere public (Render, Railway, Fly.io, a small VM — anything that runs Node
and allows WebSockets) and the QR/URL on the Stage will automatically point at
that host. On the same LAN you can instead share `http://<your-LAN-IP>:3000/`.

## The build-script (what gets voted on)

All 10 rounds live in [`steps.js`](./steps.js) — edit/reorder freely, nothing
else needs to change. The arc:

1. Instantiate the DAG (`@dag` decorator)
2. Schedule (`@daily`) — teases Asset scheduling
3. `start_date` + `catchup` (static datetime, not `datetime.now()`)
4. Define a task (`@task`)
5. No top-level code (work goes inside the task)
6. Pass data downstream via return value / XCom
7. Retries on the flaky `load`
8. Wire dependencies the TaskFlow way
9. **DAG versioning** — predict-then-reveal (Airflow 3 spotlight)
10. **Event-driven finale** — emit an `Asset` outlet (Airflow 3 spotlight)

### Editing a round

Each step is one object in `steps.js`:

```js
{
  id: "schedule",
  kind: "code",                 // "code" advances the editor; "predict" is a knowledge round
  title: "Step 2 — Schedule it",
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

Node + Express + Socket.IO + a vanilla HTML/CSS/JS front-end — no build step,
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
