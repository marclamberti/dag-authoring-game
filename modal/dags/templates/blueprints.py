"""Reusable Blueprint templates for the Level 3 sandbox.

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
