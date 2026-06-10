#!/usr/bin/env bash
# Sandbox entrypoint: boot a single-node Airflow 3 with the seeded DAGs, fronted
# by Caddy so the UI can be embedded in an iframe. Anyone can log in as admin
# (SimpleAuthManager "all admins") — fine for a throwaway per-participant box.
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
