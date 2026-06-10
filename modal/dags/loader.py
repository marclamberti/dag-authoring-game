"""Turn every *.dag.yaml in this folder into a real Airflow DAG.

One call discovers the blueprints (templates/blueprints.py) and the YAML files
next to it, validates each config, and builds the DAGs. Add a new pipeline by
dropping in another *.dag.yaml — no Python changes.
"""
from blueprint import build_all_dags

build_all_dags()
