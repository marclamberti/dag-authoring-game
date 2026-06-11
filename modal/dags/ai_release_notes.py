"""AI draft + human approval (Common AI provider + Human-in-the-Loop).

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

from airflow.sdk import dag, task
from airflow.providers.common.ai.toolsets import HookToolset
from airflow.providers.http.hooks.http import HttpHook
from airflow.providers.standard.operators.hitl import ApprovalOperator


# HttpHook.run() returns a requests.Response, which doesn't serialize into
# anything an LLM can read. Expose a thin wrapper that returns the parsed JSON,
# and hand that one method to the agent via the HookToolset.
class RandomUserHook(HttpHook):
    def fetch(self, endpoint: str = "/api/") -> dict:
        """Fetch JSON from the random user API at the given endpoint."""
        return self.run(endpoint).json()


@dag(
    schedule=None,
    catchup=False,
    tags=["level-3", "ai", "human-in-the-loop"],
    doc_md=__doc__,
)
def ai_release_notes():
    # Common AI provider: a single LLM call. The model is chosen by the
    # `openai_default` connection (e.g. openai:gpt-5).
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
    # `body` is a template field, so passing the draft XComArg renders the AI's
    # note for the reviewer (and wires draft_note -> human_approval). Downstream
    # stays blocked until a person responds.
    review = ApprovalOperator(
        task_id="human_approval",
        subject="Approve this AI-drafted release note before it goes out?",
        body=draft,
    )

    @task
    def publish(note: str):
        print("Publishing approved release note:\n" + str(note))

    # Common AI agent: multi-step reasoning that can call tools. A HookToolset
    # exposes our HTTP hook's `fetch` method, so the agent calls the randomuser.me
    # API and summarizes the result. Independent of the draft/approval branch.
    @task.agent(
        llm_conn_id="openai_default",
        system_prompt=(
            "You can call an HTTP API with the `fetch` tool. Fetch a random user, "
            "then reply with one sentence: their full name, country, and email."
        ),
        toolsets=[
            HookToolset(
                RandomUserHook(method="GET", http_conn_id="randomuser_api"),
                allowed_methods=["fetch"],
            )
        ],
    )
    def describe_random_user(prompt: str) -> str:
        return prompt

    describe_random_user("Fetch a random user and describe them.")

    draft >> review >> publish(draft)


ai_release_notes()
