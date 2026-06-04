/**
 * The build-script for the live DAG-building game.
 *
 * Each entry is ONE voting round. The audience votes on `options`; the one
 * flagged `correct: true` is the best-practice answer. On "Commit & Next" the
 * editor on the Stage is replaced with that step's `snapshot` (the full file
 * after this decision) and the new tail is typed in. Players who voted for the
 * correct option score points.
 *
 * `kind`:
 *   "code"     -> a normal authoring decision; `snapshot` advances the editor.
 *   "predict"  -> a knowledge/prediction round; `snapshot` may just add a
 *                 comment (or be omitted to leave the editor unchanged).
 *
 * After the vote is revealed, the presenter hits "Show explanation", the right
 * panel becomes a slide for this step built from:
 *   `teach`   -> the one-line "why it matters"
 *   `points`  -> the bullet takeaways (the slide content that replaces slides)
 * plus the best-practice snippet (the `correct` option's `code`).
 *
 * To extend the webinar: add/reorder objects here. Nothing else needs to change.
 */

module.exports = [
  // 1 ────────────────────────────────────────────────────────────────────────
  {
    id: "instantiate",
    kind: "code",
    title: "Step 1: Instantiate the DAG",
    prompt: "How should we create the DAG object?",
    teach:
      "The @dag decorator (TaskFlow) is the modern, recommended way in Airflow 3: " +
      "less boilerplate, tasks defined as plain Python, and clean dependency wiring.",
    points: [
      "@dag turns a plain function into a DAG, the modern TaskFlow style.",
      "Less boilerplate than `with DAG()`, and no stray global `dag` object.",
      "Remember to call the function at the bottom so Airflow registers it.",
    ],
    options: [
      { id: "a", label: "@dag decorator", correct: true,
        code: "@dag\ndef sales_pipeline():\n    ..." },
      { id: "b", label: "with DAG(...) as dag:",
        code: 'with DAG("sales_pipeline") as dag:\n    ...' },
      { id: "c", label: "dag = DAG(...)",
        code: 'dag = DAG("sales_pipeline")' },
    ],
    snapshot: `from airflow.sdk import dag, task


@dag
def sales_pipeline():
    pass


sales_pipeline()
`,
  },

  // 2 ────────────────────────────────────────────────────────────────────────
  {
    id: "schedule",
    kind: "code",
    title: "Step 2: Schedule it",
    prompt: "This is a plain daily batch. How do we schedule it?",
    teach:
      "`schedule=\"@daily\"` is clear and declarative. `schedule_interval` is the old " +
      "Airflow 2 argument name. Asset-based scheduling is fantastic, we'll use it at " +
      "the very end for the event-driven finale.",
    points: [
      "`schedule` takes cron, presets like `@daily`, timedeltas, or Assets.",
      "`@daily` is unambiguous and self-documenting for a daily batch.",
      "`schedule_interval` is the old Airflow 2 name, use `schedule` now.",
    ],
    options: [
      { id: "a", label: 'schedule="@daily"', correct: true,
        code: '@dag(schedule="@daily")' },
      { id: "b", label: "schedule_interval=timedelta(days=1)",
        code: "@dag(schedule_interval=timedelta(days=1))" },
      { id: "c", label: 'schedule=[Asset("sales_raw")]',
        code: '@dag(schedule=[Asset("sales_raw")])' },
    ],
    snapshot: `from airflow.sdk import dag, task


@dag(schedule="@daily")
def sales_pipeline():
    pass


sales_pipeline()
`,
  },

  // 3 ────────────────────────────────────────────────────────────────────────
  {
    id: "start_date",
    kind: "code",
    title: "Step 3: start_date & catchup",
    prompt: "What do we pass for start_date and catchup?",
    teach:
      "A STATIC start_date makes runs deterministic and reproducible. `datetime.now()` " +
      "is the classic footgun, it moves every parse, so Airflow can never decide what to " +
      "run. `catchup=False` stops a backfill stampede on first deploy.",
    points: [
      "A static `start_date` makes runs deterministic and reproducible.",
      "`datetime.now()` shifts on every parse, Airflow can never settle.",
      "`catchup=False` prevents a backfill stampede on first deploy.",
    ],
    options: [
      { id: "a", label: "static datetime + catchup=False", correct: true,
        code: "start_date=datetime(2025, 1, 1), catchup=False" },
      { id: "b", label: "datetime.now()",
        code: "start_date=datetime.now()" },
      { id: "c", label: "days_ago(1)",
        code: "start_date=days_ago(1)" },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import dag, task


@dag(schedule="@daily", start_date=datetime(2025, 1, 1), catchup=False)
def sales_pipeline():
    pass


sales_pipeline()
`,
  },

  // 4 ────────────────────────────────────────────────────────────────────────
  {
    id: "first_task",
    kind: "code",
    title: "Step 4: Define the first task",
    prompt: "How do we define the extract task?",
    teach:
      "The @task decorator keeps tasks as ordinary Python functions and lets data flow " +
      "through return values. PythonOperator + python_callable still works, but it's more " +
      "ceremony for the same result.",
    points: [
      "`@task` makes a function a task; data flows through return values.",
      "No `task_id` or `python_callable` boilerplate like PythonOperator.",
      "Tasks stay plain, importable, unit-testable Python.",
    ],
    options: [
      { id: "a", label: "@task def extract(): ...", correct: true,
        code: "@task\ndef extract():\n    ..." },
      { id: "b", label: "PythonOperator(python_callable=...)",
        code: 'extract = PythonOperator(task_id="extract", python_callable=_extract)' },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import dag, task


@dag(schedule="@daily", start_date=datetime(2025, 1, 1), catchup=False)
def sales_pipeline():

    @task
    def extract():
        ...

    extract()


sales_pipeline()
`,
  },

  // 5 ────────────────────────────────────────────────────────────────────────
  {
    id: "no_top_level",
    kind: "code",
    title: "Step 5: Where does the API call go?",
    prompt: "We need to call an API. Where do we put that code?",
    teach:
      "Top-level code runs on EVERY parse of the file, slow scheduler, surprise API " +
      "calls, flaky parsing. Heavy work belongs INSIDE the task, where it runs only at " +
      "execution time.",
    points: [
      "The scheduler re-parses the DAG file constantly.",
      "Top-level API calls run on every parse, slow, flaky, surprising.",
      "Heavy work goes inside the task, run only at execution time.",
    ],
    options: [
      { id: "a", label: "inside the task body", correct: true,
        code: 'def extract():\n    import requests\n    return requests.get(URL).json()' },
      { id: "b", label: "at the top of the file",
        code: 'data = requests.get(URL).json()' },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import dag, task


@dag(schedule="@daily", start_date=datetime(2025, 1, 1), catchup=False)
def sales_pipeline():

    @task
    def extract():
        import requests

        return requests.get("https://api.example.com/sales").json()

    extract()


sales_pipeline()
`,
  },

  // 6 ────────────────────────────────────────────────────────────────────────
  {
    id: "pass_data",
    kind: "code",
    title: "Step 6: Pass data downstream",
    prompt: "transform needs extract's output. How do we hand it over?",
    teach:
      "Returning a value pushes it to XCom; passing it as an argument pulls it back, " +
      "explicit, traceable, and parallel-safe. Global variables and scratch files break " +
      "the moment tasks run on different workers.",
    points: [
      "Return a value to push it to XCom; take an argument to pull it back.",
      "Explicit, traceable, and safe across parallel workers.",
      "Globals and `/tmp` files break when tasks land on different machines.",
    ],
    options: [
      { id: "a", label: "return value → pass as argument (XCom)", correct: true,
        code: "def transform(raw):\n    return clean(raw)\n\ntransform(extract())" },
      { id: "b", label: "store it in a global variable",
        code: "RAW = None" },
      { id: "c", label: "write to /tmp and read it back",
        code: 'open("/tmp/raw.json", "w").write(...)' },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import dag, task


@dag(schedule="@daily", start_date=datetime(2025, 1, 1), catchup=False)
def sales_pipeline():

    @task
    def extract():
        import requests

        return requests.get("https://api.example.com/sales").json()

    @task
    def transform(raw: dict):
        return [row for row in raw["rows"] if row["amount"] > 0]

    transform(extract())


sales_pipeline()
`,
  },

  // 7 ────────────────────────────────────────────────────────────────────────
  {
    id: "retries",
    kind: "code",
    title: "Step 7: Make load resilient",
    prompt: "The load task hits a flaky warehouse. What do we configure?",
    teach:
      "Network and warehouse calls fail transiently, `retries` (with a delay) absorbs " +
      "that for free. Combined with idempotent writes, a retry is safe to run again.",
    points: [
      "Transient network/warehouse errors are absorbed by `retries`.",
      "Pair retries with idempotent writes so a re-run is always safe.",
      "Beats hand-rolled `while True / except` retry loops.",
    ],
    options: [
      { id: "a", label: "@task(retries=3)", correct: true,
        code: "@task(retries=3)\ndef load(rows):\n    ..." },
      { id: "b", label: "no retries, let it fail",
        code: "@task\ndef load(rows):\n    ..." },
      { id: "c", label: "wrap it in while True / except",
        code: "while True:\n    try: ...\n    except: continue" },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import dag, task


@dag(schedule="@daily", start_date=datetime(2025, 1, 1), catchup=False)
def sales_pipeline():

    @task
    def extract():
        import requests

        return requests.get("https://api.example.com/sales").json()

    @task
    def transform(raw: dict):
        return [row for row in raw["rows"] if row["amount"] > 0]

    @task(retries=3)
    def load(rows: list):
        print(f"Loading {len(rows)} clean rows")

    transform(extract())


sales_pipeline()
`,
  },

  // 8 ────────────────────────────────────────────────────────────────────────
  {
    id: "dependencies",
    kind: "code",
    title: "Step 8: Wire the dependencies",
    prompt: "How do we connect extract → transform → load?",
    teach:
      "With TaskFlow you just CALL the tasks: the return values create the dependencies " +
      "automatically. Mixing in `>>` on decorated functions, or pulling XComs by hand, is " +
      "redundant and error-prone.",
    points: [
      "Calling tasks wires the dependencies automatically in TaskFlow.",
      "`load(transform(extract()))` reads like the data flow itself.",
      "Don't mix `>>` on decorated tasks or pull XComs by hand.",
    ],
    options: [
      { id: "a", label: "load(transform(extract()))", correct: true,
        code: "load(transform(extract()))" },
      { id: "b", label: "extract() >> transform() >> load()",
        code: "extract() >> transform() >> load()" },
      { id: "c", label: "manual set_downstream + xcom_pull",
        code: "extract.set_downstream(transform)" },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import dag, task


@dag(schedule="@daily", start_date=datetime(2025, 1, 1), catchup=False)
def sales_pipeline():

    @task
    def extract():
        import requests

        return requests.get("https://api.example.com/sales").json()

    @task
    def transform(raw: dict):
        return [row for row in raw["rows"] if row["amount"] > 0]

    @task(retries=3)
    def load(rows: list):
        print(f"Loading {len(rows)} clean rows")

    load(transform(extract()))


sales_pipeline()
`,
  },

  // 9 ────────────────────────────────────────────────────────────────────────
  {
    id: "versioning",
    kind: "predict",
    title: "Step 9: DAG Versioning (predict!)",
    prompt:
      "You tweak transform and redeploy WHILE a run is in progress. " +
      "Which code does that in-flight run finish with?",
    teach:
      "Airflow 3 pins each DAG run to the DAG VERSION it started on. The in-flight run " +
      "completes on v1; new runs pick up v2, and the UI shows you exactly which run used " +
      "which version. No more 'mystery half-old, half-new' runs.",
    points: [
      "Airflow 3 pins each run to the DAG version it started on.",
      "In-flight runs finish on v1; new runs pick up v2.",
      "The Grid shows which version each run used, no half-old/half-new mysteries.",
    ],
    options: [
      { id: "a", label: "v1, the version it started on", correct: true, code: "" },
      { id: "b", label: "v2, the brand-new code", code: "" },
      { id: "c", label: "it crashes and restarts", code: "" },
    ],
    // The editor gets the v2 edit committed so the audience SEES the change that
    // versioning is tracking.
    snapshot: `from datetime import datetime

from airflow.sdk import dag, task


@dag(schedule="@daily", start_date=datetime(2025, 1, 1), catchup=False)
def sales_pipeline():

    @task
    def extract():
        import requests

        return requests.get("https://api.example.com/sales").json()

    @task
    def transform(raw: dict):
        # v2: keep only high-value sales
        return [row for row in raw["rows"] if row["amount"] > 100]

    @task(retries=3)
    def load(rows: list):
        print(f"Loading {len(rows)} clean rows")

    load(transform(extract()))


sales_pipeline()
`,
  },

  // 10 ───────────────────────────────────────────────────────────────────────
  {
    id: "event_driven",
    kind: "code",
    title: "Step 10: Event-driven finale",
    prompt:
      "A downstream DAG must run the instant clean_sales is refreshed. " +
      "How do we connect them?",
    teach:
      "Emit an Asset from load via `outlets=[Asset(\"clean_sales\")]`; the downstream DAG " +
      "sets `schedule=[Asset(\"clean_sales\")]` and runs automatically when it updates. No " +
      "sensors burning a worker, no brittle TriggerDagRunOperator timing, pure event-driven.",
    points: [
      "Emit an Asset with `outlets=[Asset(...)]` when a task updates data.",
      "Downstream DAGs `schedule=[Asset(...)]` and fire the moment it updates.",
      "No sensors burning worker slots, no brittle TriggerDagRunOperator timing.",
    ],
    options: [
      { id: "a", label: 'outlets=[Asset("clean_sales")]', correct: true,
        code: '@task(outlets=[Asset("clean_sales")])' },
      { id: "b", label: "downstream uses a poke sensor",
        code: "ExternalTaskSensor(...)" },
      { id: "c", label: "TriggerDagRunOperator at the end",
        code: "TriggerDagRunOperator(trigger_dag_id=...)" },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import Asset, dag, task


@dag(
    schedule="@daily",
    start_date=datetime(2025, 1, 1),
    catchup=False,
    tags=["best-practices", "webinar"],
    doc_md="### Daily sales pipeline\\nBuilt live by the audience",
)
def sales_pipeline():

    @task
    def extract():
        import requests

        return requests.get("https://api.example.com/sales").json()

    @task
    def transform(raw: dict):
        # v2: keep only high-value sales
        return [row for row in raw["rows"] if row["amount"] > 100]

    @task(retries=3, outlets=[Asset("clean_sales")])
    def load(rows: list):
        print(f"Loading {len(rows)} clean rows")

    load(transform(extract()))


sales_pipeline()
`,
  },
];
