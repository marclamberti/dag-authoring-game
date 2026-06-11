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
SANDBOX_TIMEOUT = int(os.environ.get("SANDBOX_TIMEOUT", 15 * 60))  # hard max lifetime
SANDBOX_CPU = float(os.environ.get("SANDBOX_CPU", 2.0))
SANDBOX_MEMORY = int(os.environ.get("SANDBOX_MEMORY", 4096))  # MB
AIRFLOW_VERSION = os.environ.get("AIRFLOW_VERSION", "3.1.0")
PY = "3.11"

# Secret holds SANDBOX_TOKEN (shared with the Node server) and, optionally, the
# LLM key for the Common AI DAG: either OPENAI_API_KEY (we build the connection)
# or the full AIRFLOW_CONN_OPENAI_DEFAULT (Airflow reads it as the connection
# directly). Both flow into the sandbox via this secret. Create it with:
#   modal secret create dag-game-secret SANDBOX_TOKEN=... OPENAI_API_KEY=...
secret = modal.Secret.from_name("dag-game-secret")

# ── Seeded files (baked into the image; see NOTE above) ──────────────────────

CADDYFILE = r"""# Caddy fronts Airflow on the public port (8080) and rewrites responses so the
# UI works inside the player's cross-origin iframe:
#   - drop X-Frame-Options / CSP that forbid framing
#   - rewrite Set-Cookie to SameSite=None; Secure; Partitioned, because browsers
#     (Chrome included) block a cross-site iframe's cookies unless they're marked
#     this way (CHIPS). Without it Airflow can't authenticate in the frame and
#     the page renders blank.
{
    admin off
    auto_https off
}

:8080 {
    reverse_proxy localhost:8081 {
        header_down -X-Frame-Options
        header_down -Content-Security-Policy
        header_down Set-Cookie "(?i); *SameSite=[^;]+" ""
        header_down Set-Cookie "^(.+)$" "$1; SameSite=None; Secure; Partitioned"
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

# Wire the LLM connection for the Common AI DAG as an env-var connection (Airflow
# reads AIRFLOW_CONN_<CONN_ID> straight from the environment, no DB write). The
# Common AI provider expects a "pydanticai" connection: the model lives in extra
# in provider:model form (e.g. openai:gpt-4o-mini) and the API key in password.
# Provide AIRFLOW_CONN_OPENAI_DEFAULT directly via the secret for full control,
# or set OPENAI_API_KEY (+ optional AI_MODEL) and we build it here. Exported so
# every Airflow process (scheduler/triggerer/api-server) inherits it.
if [ -z "${AIRFLOW_CONN_OPENAI_DEFAULT:-}" ] && [ -n "${OPENAI_API_KEY:-}" ]; then
    AI_MODEL="${AI_MODEL:-openai:gpt-5}"
    export AIRFLOW_CONN_OPENAI_DEFAULT='{"conn_type": "pydanticai", "password": "'"$OPENAI_API_KEY"'", "extra": "{\"model\": \"'"$AI_MODEL"'\"}"}'
fi

# Read-only HTTP connection the AI agent's HookToolset calls (randomuser.me).
export AIRFLOW_CONN_RANDOMUSER_API='{"conn_type": "http", "host": "randomuser.me", "schema": "https"}'

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
from blueprint import build_all

build_all()
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

AI_DAG_PY = r'''"""Personalized release-note email — AI agent + LLM + Human-in-the-Loop.

One coherent pipeline using the Airflow 3.1+ AI building blocks together:

  find_recipient  (@task.agent)      an AI agent calls the randomuser.me API
                                     through a HookToolset over the HTTP hook to
                                     pick a real customer to notify.
  draft_email     (@task.llm)        drafts a release-note email personalized to
                                     that recipient.
  human_approval  (ApprovalOperator) a person reviews and approves the draft.
  send_email      (@task)            "sends" it, only after approval.

NOTE: the AI tasks use an LLM connection named `openai_default`. The sandbox
builds it from OPENAI_API_KEY; without a key those tasks fail, but the DAG still
parses and the human-approval step is fully usable.
"""
from __future__ import annotations

from airflow.sdk import dag, task
from airflow.providers.common.ai.toolsets import HookToolset
from airflow.providers.http.hooks.http import HttpHook
from airflow.providers.standard.operators.hitl import ApprovalOperator


# HttpHook.run() returns a requests.Response, which doesn't serialize into
# anything an LLM can read. Expose a thin wrapper that returns the parsed JSON,
# and hand that one method to the agent via the HookToolset.
class RandomUserHook(HttpHook):
    def fetch(self) -> dict:
        """Fetch one random user from the API as JSON. Takes no arguments so the
        LLM can't pass a wrong endpoint — the path is fixed here."""
        return self.run("/api/").json()


@dag(
    schedule=None,
    catchup=False,
    tags=["level-3", "ai", "agent", "human-in-the-loop"],
    doc_md=__doc__,
)
def ai_release_notes():
    # 1. Agent: pick a real customer to notify, via the HTTP tool (randomuser.me).
    @task.agent(
        llm_conn_id="openai_default",
        system_prompt=(
            "Use the `fetch` tool to get a random user, then reply with exactly "
            "one line: 'Full Name <email> (Country)'."
        ),
        toolsets=[
            HookToolset(
                RandomUserHook(method="GET", http_conn_id="randomuser_api"),
                allowed_methods=["fetch"],
            )
        ],
    )
    def find_recipient(prompt: str) -> str:
        return prompt

    recipient = find_recipient("Find a customer to send the release note to.")

    # 2. LLM: draft a release-note email personalized to that recipient.
    @task.llm(
        llm_conn_id="openai_default",
        system_prompt=(
            "You are a release-notes writer. Write a friendly, concise "
            "release-note email of 3-4 sentences, addressed to the recipient by "
            "name, covering the changelog."
        ),
    )
    def draft_email(recipient: str) -> str:
        return f"""Recipient: {recipient}

Changelog:
- Added Level 3 hands-on Airflow sandboxes
- Moved the confetti to each player's phone
- Faster reveal animation on the Stage"""

    draft = draft_email(recipient)

    # 3. Human-in-the-Loop: a person approves the drafted email. `body` is a
    #    template field, so the reviewer sees the draft in the Airflow UI.
    review = ApprovalOperator(
        task_id="human_approval",
        subject="Approve this AI-drafted release-note email before it's sent?",
        body=draft,
    )

    # 4. Send it — only after approval.
    @task
    def send_email(email: str):
        print("Sending approved release-note email to:")
        print(email)

    review >> send_email(draft)


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
        "apache-airflow-providers-http",
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
