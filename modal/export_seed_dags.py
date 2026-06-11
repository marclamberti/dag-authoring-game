#!/usr/bin/env python3
"""Write the seeded DAG sources out as real files under modal/dags/.

The seed DAGs live as inlined string constants in airflow_sandbox.py (they must,
because sandboxes are created from a deployed function where local files don't
exist). The game's Node server, however, reads real files to show participants
the code on the Level 3 screen. This script keeps those files in sync with the
constants — they are the single source of truth.

Usage:
  python3 modal/export_seed_dags.py          # (re)write modal/dags/*
  python3 modal/export_seed_dags.py --check   # exit 1 if any file is out of sync

Run it after editing a DAG constant in airflow_sandbox.py, then commit the files.
"""
from __future__ import annotations

import ast
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "airflow_sandbox.py")

# Constant name in airflow_sandbox.py -> output path (relative to modal/dags/).
EXPORTS = {
    "BLUEPRINTS_PY": "templates/blueprints.py",
    "LOADER_PY": "loader.py",
    "SALES_YAML": "sales.dag.yaml",
    "AI_DAG_PY": "ai_release_notes.py",
}


def _constants() -> dict[str, str]:
    tree = ast.parse(open(APP).read())
    out = {}
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            out[node.targets[0].id] = node.value.value
    return out


def main() -> int:
    check = "--check" in sys.argv
    consts = _constants()
    dags_dir = os.path.join(HERE, "dags")
    drift = []
    for name, rel in EXPORTS.items():
        if name not in consts:
            print(f"missing constant {name} in airflow_sandbox.py", file=sys.stderr)
            return 1
        dest = os.path.join(dags_dir, rel)
        content = consts[name]
        current = open(dest).read() if os.path.exists(dest) else None
        if current == content:
            continue
        if check:
            drift.append(rel)
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w") as f:
            f.write(content)
        print(f"wrote dags/{rel}")
    if check and drift:
        print("OUT OF SYNC: " + ", ".join(drift), file=sys.stderr)
        print("run: python3 modal/export_seed_dags.py", file=sys.stderr)
        return 1
    if check:
        print("seed DAGs in sync")
    return 0


if __name__ == "__main__":
    sys.exit(main())
