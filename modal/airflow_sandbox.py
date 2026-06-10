"""Modal app that hands every webinar participant their own Airflow sandbox.

Three POST web endpoints (called server-side by the game's Node server):

  start  -> create a Sandbox running Airflow, return {id, url}
  stop   -> terminate a Sandbox by id
  health -> {status: booting | ready | stopped | gone} for a sandbox id

Deploy:  modal deploy modal/airflow_sandbox.py
The deploy prints the three URLs — put them in the game server's env (see
modal/README.md).

Each sandbox runs `start_airflow.sh`: Airflow 3 standalone on :8081 behind a
Caddy proxy on :8080 that strips X-Frame-Options/CSP so the UI embeds in an
iframe. Auth is open (SimpleAuthManager all-admins) — fine for a throwaway box.

NOTE: the seeded files (DAGs, Caddyfile, entrypoint) are inlined as string
constants below and baked into the image at build time. They are NOT read from
local disk, because sandboxes are created from inside a deployed function (where
the local files don't exist) — local-file image layers only work when you run
from your laptop. Edit the DAGs here and redeploy.
"""
from __future__ import annotations

import base64
import os

import modal  # the only dependency needed locally to `modal deploy` this file

app = modal.App("dag-authoring-airflow")

# Tunables (override with env at deploy time if you like).
SANDBOX_TIMEOUT = int(os.environ.get("SANDBOX_TIMEOUT", 45 * 60))  # hard max lifetime
SANDBOX_CPU = float(os.environ.get("SANDBOX_CPU", 2.0))
SANDBOX_MEMORY = int(os.environ.get("SANDBOX_MEMORY", 4096))  # MB
AIRFLOW_VERSION = os.environ.get("AIRFLOW_VERSION", "3.1.0")
PY = "3.11"

# Secret holds SANDBOX_TOKEN (shared with the Node server) and, optionally,
# OPENAI_API_KEY (to make the Common AI DAG runnable). Create it with:
#   modal secret create dag-game-secret SANDBOX_TOKEN=... OPENAI_API_KEY=...
secret = modal.Secret.from_name("dag-game-secret")

# ── Seeded files (baked into the image; see NOTE above) ──────────────────────

CADDYFILE = r"""# Caddy fronts Airflow on the public port (8080) and strips the frame-blocking
# headers so the UI can be embedded in the player's iframe.
{
    admin off
    auto_https off
}

:8080 {
    reverse_proxy localhost:8081 {
        header_down -X-Frame-Options
        header_down -Content-Security-Policy
    }
}
"""

START_SH = r"""#!/usr/bin/env bash
# Boot a single-node Airflow 3 with the seeded DAGs, fronted by Caddy so the UI
# can be embedded in an iframe. Anyone can log in as admin (SimpleAuthManager
# "all admins") — fine for a throwaway per-participant box.
set -euo pipefail

export AIRFLOW_HOME=/root/airflow
export AIRFLOW__CORE__LOAD_EXAMPLES=False
export AIRFLOW__CORE__DAGS_FOLDER=/root/airflow/dags
# No password: every visitor is an admin. NEVER do this outside a demo sandbox.
export AIRFLOW__CORE__SIMPLE_AUTH_MANAGER_ALL_ADMINS=True
# Airflow's API server (which also serves the React UI) listens on 8081;
# Caddy fronts it on the public 8080.
export AIRFLOW__API__HOST=0.0.0.0
export AIRFLOW__API__PORT=8081

mkdir -p "$AIRFLOW_HOME/dags"
cp -r /opt/seed_dags/. "$AIRFLOW_HOME/dags/" 2>/dev/null || true

# Optional: wire an LLM connection so the Common AI DAG can actually run.
# Provide OPENAI_API_KEY via the Modal secret to enable it. The exact conn type
# may need tweaking for your common-ai provider version — the HITL approval step
# works regardless. Best-effort, never fail boot over it.
if [ -n "${OPENAI_API_KEY:-}" ]; then
    airflow connections add openai_default \
        --conn-type openai --conn-password "$OPENAI_API_KEY" >/dev/null 2>&1 || true
fi

# Header-stripping proxy on the public port.
caddy run --config /root/Caddyfile --adapter caddyfile &

# api-server + scheduler + triggerer + dag-processor in one process.
exec airflow standalone
"""

BLUEPRINTS_PY = r'''"""Reusable Blueprint templates for the Level 3 sandbox.

A Blueprint turns a hand-written extract->load pattern into a validated template
that a short YAML file can compose. This is the same idea the room builds in
Level 2 — here it ships pre-installed so participants can run it for real.
"""
from __future__ import annotations

from airflow.providers.standard.operators.python import PythonOperator
from airflow.sdk import TaskGroup
from blueprint import Blueprint, BaseModel, Field
from pydantic import ConfigDict


class ExtractLoadConfig(BaseModel):
    """Config for one extract->load step. `extra="forbid"` turns YAML typos
    (e.g. `tabel:` instead of `table:`) into clear validation errors."""

    model_config = ConfigDict(extra="forbid")

    source: str = Field(description="Source system to read from, e.g. 'postgres'")
    table: str = Field(description="Table to load, e.g. 'sales'")
    rows: int = Field(default=1000, ge=1, description="Row batch size")


class ExtractLoad(Blueprint[ExtractLoadConfig]):
    """Extract rows from a source and load them into the warehouse."""

    def render(self, config: ExtractLoadConfig) -> TaskGroup:
        with TaskGroup(group_id=self.step_id) as group:
            def _extract(table: str = config.table, rows: int = config.rows):
                print(f"Extracting {rows} rows from {config.source}.{table}")
                return rows

            def _load(table: str = config.table):
                print(f"Loading into warehouse.{table}")

            extract = PythonOperator(task_id="extract", python_callable=_extract)
            load = PythonOperator(task_id="load", python_callable=_load)
            extract >> load
        return group
'''

LOADER_PY = r'''"""Turn every *.dag.yaml in this folder into a real Airflow DAG.

One call discovers the blueprints (templates/blueprints.py) and the YAML files
next to it, validates each config, and builds the DAGs.
"""
from blueprint import build_all_dags

build_all_dags()
'''

SALES_YAML = r"""# A whole DAG composed from the ExtractLoad blueprint — no Python needed here.
# The ~25 lines a hand-written DAG would take collapse into a few validated keys.
dag_id: sales_pipeline
schedule: "@daily"
description: "Sales extract -> load, composed from a Blueprint"

steps:
  extract_sales:
    blueprint: extract_load
    source: postgres
    table: sales
    rows: 5000

  extract_regions:
    blueprint: extract_load
    source: postgres
    table: regions
    rows: 200

  report:
    blueprint: extract_load
    depends_on: [extract_sales, extract_regions]
    source: warehouse
    table: sales_report
    rows: 5000
"""

AI_DAG_PY = r'''"""AI draft + human approval (Common AI provider + Human-in-the-Loop).

An LLM drafts a customer-facing release note from a raw changelog, a human
reviews and approves it in the Airflow UI (the new Human-in-the-Loop operator),
and only then does it "publish". This is the Airflow 3.1+ pattern for putting a
person in the loop of an AI workflow.

NOTE: the `draft_note` task uses the Common AI provider and needs an LLM
connection named `openai_default`. The sandbox creates it automatically when an
OPENAI_API_KEY is provided to the Modal app; without a key that one task fails,
but the DAG still parses and the human-approval step is fully usable.
"""
from __future__ import annotations

from airflow.providers.common.compat.sdk import dag, task
from airflow.providers.standard.operators.hitl import ApprovalOperator


@dag(
    schedule=None,
    catchup=False,
    tags=["level-3", "ai", "human-in-the-loop"],
    doc_md=__doc__,
)
def ai_release_notes():
    # Common AI provider: a single LLM call. The model is chosen by the
    # `openai_default` connection (e.g. openai:gpt-4o-mini).
    @task.llm(
        llm_conn_id="openai_default",
        system_prompt=(
            "You are a release-notes writer. Turn the raw changelog into a "
            "friendly, concise customer-facing note of 3-4 sentences."
        ),
    )
    def draft_note(changelog: str) -> str:
        return changelog

    draft = draft_note(
        "- Added Level 3 hands-on Airflow sandboxes\n"
        "- Moved the confetti to each player's phone\n"
        "- Faster reveal animation on the Stage"
    )

    # Human-in-the-Loop: an Approve / Reject gate rendered in the Airflow UI.
    # Downstream stays blocked until a person responds.
    review = ApprovalOperator(
        task_id="human_approval",
        subject="Approve this AI-drafted release note before it goes out?",
    )

    @task
    def publish(note: str):
        print("Publishing approved release note:\n" + str(note))

    draft >> review >> publish(draft)


ai_release_notes()
'''

# Map of container path -> file content. Baked into the image at build.
SEED_FILES = {
    "/root/Caddyfile": CADDYFILE,
    "/root/start_airflow.sh": START_SH,
    "/opt/seed_dags/templates/blueprints.py": BLUEPRINTS_PY,
    "/opt/seed_dags/loader.py": LOADER_PY,
    "/opt/seed_dags/sales.dag.yaml": SALES_YAML,
    "/opt/seed_dags/ai_release_notes.py": AI_DAG_PY,
}


def _bake_files(image):
    """Write each seeded file into the image at build (base64 avoids quoting
    issues). Content comes from the in-code constants above, so the image is
    reproducible without any local files at sandbox-create time."""
    for dest, content in SEED_FILES.items():
        b64 = base64.b64encode(content.encode()).decode()
        image = image.run_commands(
            f"mkdir -p $(dirname {dest}) && printf '%s' '{b64}' | base64 -d > {dest}"
        )
    return image


# ── Images ───────────────────────────────────────────────────────────────────

# Lightweight image for the HTTP endpoints.
endpoint_image = modal.Image.debian_slim(python_version=PY).pip_install(
    "fastapi[standard]", "requests"
)

# Heavy image the sandboxes boot from: Airflow 3 + the providers our seeded DAGs
# use + Blueprint, plus the Caddy binary and the (inlined) seeded files.
constraints = (
    f"https://raw.githubusercontent.com/apache/airflow/"
    f"constraints-{AIRFLOW_VERSION}/constraints-{PY}.txt"
)
airflow_image = _bake_files(
    modal.Image.debian_slim(python_version=PY)
    .apt_install("curl")
    .run_commands(
        "curl -sSL 'https://caddyserver.com/api/download?os=linux&arch=amd64' "
        "-o /usr/bin/caddy && chmod +x /usr/bin/caddy"
    )
    .pip_install(
        f"apache-airflow=={AIRFLOW_VERSION}", extra_options=f"--constraint {constraints}"
    )
    # New/extra providers aren't in the core constraints, so install unpinned.
    .pip_install(
        "apache-airflow-providers-standard",
        "apache-airflow-providers-common-ai",
        "apache-airflow-providers-common-compat",
        "apache-airflow-providers-openai",
        "airflow-blueprint>=0.2.0",
    )
)


# ── Endpoints ────────────────────────────────────────────────────────────────


def _auth(item) -> None:
    """Reject calls without the shared token (when one is configured). The token
    travels in the JSON body so these endpoints need no FastAPI Request object."""
    token = os.environ.get("SANDBOX_TOKEN")
    if token and (not item or item.get("token") != token):
        from fastapi import HTTPException  # available in the endpoint image

        raise HTTPException(status_code=401, detail="bad sandbox token")


def _url_for(sb):
    return sb.tunnels()[8080].url


@app.function(image=endpoint_image, secrets=[secret])
@modal.fastapi_endpoint(method="POST")
def start(item: dict = None):
    """Spin up one Airflow sandbox; return its id + public URL immediately."""
    _auth(item)
    sb = modal.Sandbox.create(
        "bash",
        "/root/start_airflow.sh",
        image=airflow_image,
        app=app,
        timeout=SANDBOX_TIMEOUT,
        cpu=SANDBOX_CPU,
        memory=SANDBOX_MEMORY,
        encrypted_ports=[8080],
        secrets=[secret],  # forwards OPENAI_API_KEY into the box
    )
    return {"id": sb.object_id, "url": _url_for(sb)}


@app.function(image=endpoint_image, secrets=[secret])
@modal.fastapi_endpoint(method="POST")
def stop(item: dict):
    """Terminate a sandbox by id (idempotent)."""
    _auth(item)
    try:
        modal.Sandbox.from_id(item["id"]).terminate()
    except Exception as e:  # already gone / unknown id
        return {"ok": False, "error": str(e)}
    return {"ok": True}


@app.function(image=endpoint_image, secrets=[secret])
@modal.fastapi_endpoint(method="POST")
def health(item: dict):
    """Report whether a sandbox is still booting, ready, or gone."""
    import requests  # available in the endpoint image

    _auth(item)
    try:
        sb = modal.Sandbox.from_id(item["id"])
    except Exception:
        return {"status": "gone"}
    if sb.poll() is not None:  # process exited
        return {"status": "stopped"}
    # Caddy returns 502 until Airflow is listening; any non-5xx means it's up.
    try:
        r = requests.get(_url_for(sb) + "/", timeout=5)
        ready = r.status_code < 500
    except Exception:
        ready = False
    return {"status": "ready" if ready else "booting"}
