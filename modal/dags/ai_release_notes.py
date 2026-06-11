"""Personalized release-note email — AI agent + LLM + Human-in-the-Loop.

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
