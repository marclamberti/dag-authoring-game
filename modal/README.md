# Level 3 — per-participant Airflow sandboxes (Modal)

Level 3 gives every participant their **own** Airflow 3, booted on demand in a
[Modal](https://modal.com) Sandbox and embedded in their phone/laptop as an
iframe. They run, for real, two DAGs:

- **`sales_pipeline`** — composed from a **Blueprint** (`dags/sales.dag.yaml` +
  `dags/templates/blueprints.py` + `dags/loader.py`), the Level 2 idea made runnable.
- **`ai_release_notes`** — the **Common AI provider** (`@task.llm`) drafts a
  release note, then a **Human-in-the-Loop** `ApprovalOperator` gates publishing.

This folder is the Modal side; the game's Node server just brokers `start` /
`stop` / `health` calls to it.

## What's here

```
airflow_sandbox.py   Modal app: image + start/stop/health web endpoints
start_airflow.sh     sandbox entrypoint (Airflow standalone + Caddy proxy)
Caddyfile            strips X-Frame-Options/CSP so the UI can be iframed
dags/                seeded DAGs baked into the image
  templates/blueprints.py
  sales.dag.yaml
  loader.py
  ai_release_notes.py
```

## One-time setup

1. **Install + auth Modal** (with [uv](https://docs.astral.sh/uv/))
   ```bash
   uv tool install modal     # puts the `modal` CLI on your PATH
   modal token new
   ```
   `modal` is the only thing you install locally — Airflow and the providers are
   built into the sandbox image, remotely. Prefer not to install anything? Swap
   `modal …` for `uvx modal …` below to run it ephemerally (e.g.
   `uvx modal deploy modal/airflow_sandbox.py`).

2. **Create the shared secret.** `SANDBOX_TOKEN` is a password the Node server
   sends on every call (pick any random string). `OPENAI_API_KEY` is optional —
   include it only if you want the `@task.llm` step to actually call an LLM.
   ```bash
   modal secret create dag-game-secret \
     SANDBOX_TOKEN="$(openssl rand -hex 16)" \
     OPENAI_API_KEY="sk-..."        # optional
   ```

3. **Deploy.**
   ```bash
   modal deploy modal/airflow_sandbox.py
   ```
   It prints three URLs, e.g.
   ```
   https://<workspace>--dag-authoring-airflow-start.modal.run
   https://<workspace>--dag-authoring-airflow-stop.modal.run
   https://<workspace>--dag-authoring-airflow-health.modal.run
   ```

4. **Point the game server at them.** Set these env vars on the Node server
   (locally or on Render — see the root README):
   ```
   MODAL_SANDBOX_START_URL=https://<workspace>--dag-authoring-airflow-start.modal.run
   MODAL_SANDBOX_STOP_URL=https://<workspace>--dag-authoring-airflow-stop.modal.run
   MODAL_SANDBOX_HEALTH_URL=https://<workspace>--dag-authoring-airflow-health.modal.run
   MODAL_SANDBOX_TOKEN=<the SANDBOX_TOKEN you generated>
   MAX_SANDBOXES=60          # hard cap on concurrent sandboxes (queue beyond it)
   ```

If those env vars are absent the game runs fine — Level 3's "Start my Airflow"
button just reports that sandboxes aren't configured.

## Cost & scale

Each sandbox is a real container (default 2 CPU / 4 GB) running until it's
stopped or hits `SANDBOX_TIMEOUT` (45 min). For a 100-person webinar that's up
to 100 concurrent boxes — set `MAX_SANDBOXES` to a number you're comfortable
paying for; the Node server queues participants beyond it and auto-stops a box
when its owner disconnects or you Reset the session. First boot takes ~60–120s
(image is cached after the first deploy), which is why starting is a deliberate
button press.

Tune resources / lifetime at deploy time:
```bash
SANDBOX_CPU=1 SANDBOX_MEMORY=2048 SANDBOX_TIMEOUT=2700 modal deploy modal/airflow_sandbox.py
```

## Notes / gotchas

- **Auth is wide open** inside each sandbox (`SIMPLE_AUTH_MANAGER_ALL_ADMINS`).
  That's intentional for a throwaway demo box; never reuse this image for
  anything real.
- The **LLM connection** (`openai_default`) is created best-effort from
  `OPENAI_API_KEY`. If your `common-ai` provider version expects a different
  connection type, adjust `start_airflow.sh`; the Human-in-the-Loop approval
  works with or without a key.
- The Airflow version + provider set are pinned in `airflow_sandbox.py`
  (`AIRFLOW_VERSION`). Bump as needed and redeploy.
- This piece needs a live Modal account to exercise end-to-end; the rest of the
  game (Levels 1–2) runs without it.
