"""Turn every *.dag.yaml in this folder into a real Airflow DAG.

One call discovers the blueprints (templates/blueprints.py) and the YAML files
next to it, validates each config, and builds the DAGs.
"""
from blueprint import build_all

build_all()
