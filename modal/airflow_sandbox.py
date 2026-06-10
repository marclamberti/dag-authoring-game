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
"""
from __future__ import annotations

import os

import modal
import requests
from fastapi import HTTPException, Request
from pydantic import BaseModel

app = modal.App("dag-authoring-airflow")

# Tunables (override with env at deploy time if you like).
SANDBOX_TIMEOUT = int(os.environ.get("SANDBOX_TIMEOUT", 45 * 60))  # hard max lifetime
SANDBOX_CPU = float(os.environ.get("SANDBOX_CPU", 2.0))
SANDBOX_MEMORY = int(os.environ.get("SANDBOX_MEMORY", 4096))  # MB
AIRFLOW_VERSION = os.environ.get("AIRFLOW_VERSION", "3.1.0")
PY = "3.11"

HERE = os.path.dirname(__file__)

# Secret holds SANDBOX_TOKEN (shared with the Node server) and, optionally,
# OPENAI_API_KEY (to make the Common AI DAG runnable). Create it with:
#   modal secret create dag-game-secret SANDBOX_TOKEN=... OPENAI_API_KEY=...
secret = modal.Secret.from_name("dag-game-secret")

# Lightweight image for the HTTP endpoints.
endpoint_image = modal.Image.debian_slim(python_version=PY).pip_install(
    "fastapi[standard]", "requests"
)

# Heavy image the sandboxes boot from: Airflow 3 + the providers our seeded DAGs
# use + Blueprint, plus the Caddy binary and the seeded files.
constraints = (
    f"https://raw.githubusercontent.com/apache/airflow/"
    f"constraints-{AIRFLOW_VERSION}/constraints-{PY}.txt"
)
airflow_image = (
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
    .add_local_dir(os.path.join(HERE, "dags"), "/opt/seed_dags", copy=True)
    .add_local_file(os.path.join(HERE, "Caddyfile"), "/root/Caddyfile", copy=True)
    .add_local_file(
        os.path.join(HERE, "start_airflow.sh"), "/root/start_airflow.sh", copy=True
    )
)


class IdReq(BaseModel):
    id: str


def _auth(request: Request) -> None:
    """Reject calls without the shared token (when one is configured)."""
    token = os.environ.get("SANDBOX_TOKEN")
    if token and request.headers.get("x-sandbox-token") != token:
        raise HTTPException(status_code=401, detail="bad sandbox token")


def _url_for(sb: modal.Sandbox) -> str:
    return sb.tunnels()[8080].url


@app.function(image=endpoint_image, secrets=[secret])
@modal.fastapi_endpoint(method="POST")
def start(request: Request):
    """Spin up one Airflow sandbox; return its id + public URL immediately."""
    _auth(request)
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
def stop(item: IdReq, request: Request):
    """Terminate a sandbox by id (idempotent)."""
    _auth(request)
    try:
        modal.Sandbox.from_id(item.id).terminate()
    except Exception as e:  # already gone / unknown id
        return {"ok": False, "error": str(e)}
    return {"ok": True}


@app.function(image=endpoint_image, secrets=[secret])
@modal.fastapi_endpoint(method="POST")
def health(item: IdReq, request: Request):
    """Report whether a sandbox is still booting, ready, or gone."""
    _auth(request)
    try:
        sb = modal.Sandbox.from_id(item.id)
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
