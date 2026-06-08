/**
 * The build-script for the live DAG-building game.
 *
 * Each entry is ONE voting round. The audience votes on `options`; the one
 * flagged `correct: true` is the best-practice answer. On "Reveal results" the
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
 * Each step targets a `file` (default "dags/sales_pipeline.py"); a step can also
 * `seed` another file. The Stage shows one editor tab per file and focuses the
 * step's file. Two files get built:
 *   dags/sales_pipeline.py : get_date -> extract -> transform -> load (steps 1-11)
 *   dags/sales_report.py   : the Asset consumer, then dynamic task mapping,
 *                            task groups, and a deferrable sensor (steps 12-14)
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
    title: "Step 2: Schedule on multiple crons",
    prompt: "Run at 9am AND 5pm on weekdays. How do we schedule that?",
    teach:
      "Airflow 3's MultipleCronTriggerTimetable runs a DAG on several cron expressions " +
      "at once, here 9am and 5pm on weekdays, each firing its own run with the right " +
      "data interval. It reads clearly and, unlike a single comma-cron, scales to " +
      "genuinely different schedules (different days, months, or timezones). Duplicating " +
      "the DAG per time just invites drift.",
    points: [
      "MultipleCronTriggerTimetable triggers on several cron expressions at once.",
      "Each cron fires its own run with the correct data interval.",
      "Far cleaner than duplicating the DAG once per schedule.",
      "Handles schedules a single cron can't express (different days/timezones).",
    ],
    options: [
      { id: "a", label: "MultipleCronTriggerTimetable(...)", correct: true,
        code:
          "schedule=MultipleCronTriggerTimetable(\n" +
          '    "0 9 * * 1-5",\n' +
          '    "0 17 * * 1-5",\n' +
          '    timezone="UTC",\n' +
          ")" },
      { id: "b", label: "two DAGs, one per time",
        code: "# sales_9am.py + sales_5pm.py (duplicated DAG)" },
      { id: "c", label: "run hourly, skip off-hours",
        code: 'schedule="0 * * * 1-5"  # then skip unless 9 or 17' },
    ],
    snapshot: `from airflow.sdk import dag, task
from airflow.timetables.trigger import MultipleCronTriggerTimetable


@dag(
    schedule=MultipleCronTriggerTimetable(
        "0 9 * * 1-5",
        "0 17 * * 1-5",
        timezone="UTC",
    )
)
def sales_pipeline():
    pass


sales_pipeline()
`,
  },

  // 3 ────────────────────────────────────────────────────────────────────────
  {
    id: "start_date",
    kind: "code",
    title: "Step 3: Set a start_date",
    prompt: "What do we pass for start_date?",
    teach:
      "A STATIC start_date makes runs deterministic and reproducible. `datetime.now()` " +
      "is the classic footgun, it moves every parse, so Airflow can never decide what to " +
      "run. In Airflow 3 `catchup` defaults to False, so you no longer need to set it.",
    points: [
      "A static `start_date` makes runs deterministic and reproducible.",
      "`datetime.now()` shifts on every parse, Airflow can never settle.",
      "Airflow 3 defaults `catchup=False`, so you don't set catchup anymore.",
    ],
    options: [
      { id: "a", label: "static datetime", correct: true,
        code: "start_date=datetime(2026, 1, 1)" },
      { id: "b", label: "datetime.now()",
        code: "start_date=datetime.now()" },
      { id: "c", label: "days_ago(1)",
        code: "start_date=days_ago(1)" },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import dag, task
from airflow.timetables.trigger import MultipleCronTriggerTimetable


@dag(
    schedule=MultipleCronTriggerTimetable(
        "0 9 * * 1-5",
        "0 17 * * 1-5",
        timezone="UTC",
    ),
    start_date=datetime(2026, 1, 1),
)
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
    prompt: "How do we define our first task, get_date?",
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
      { id: "a", label: "@task def get_date(): ...", correct: true,
        code: "@task\ndef get_date():\n    ..." },
      { id: "b", label: "PythonOperator(python_callable=...)",
        code: 'get_date = PythonOperator(task_id="get_date", python_callable=_get_date)' },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import dag, task
from airflow.timetables.trigger import MultipleCronTriggerTimetable


@dag(
    schedule=MultipleCronTriggerTimetable(
        "0 9 * * 1-5",
        "0 17 * * 1-5",
        timezone="UTC",
    ),
    start_date=datetime(2026, 1, 1),
)
def sales_pipeline():

    @task
    def get_date():
        ...

    get_date()


sales_pipeline()
`,
  },

  // 5 ────────────────────────────────────────────────────────────────────────
  {
    id: "idempotency",
    kind: "code",
    title: "Step 5: Make the first task idempotent",
    prompt: "get_date returns the run's date. What should it return?",
    teach:
      "Return Airflow's `ds` (the run's logical date / data interval), not the wall " +
      "clock. Declare `ds` as a parameter and Airflow injects it. With `datetime.now()`, " +
      "re-running a past date fetches TODAY's data; with `ds`, a rerun recomputes for the " +
      "exact date the run is for. That is idempotency: same run, same result, every time.",
    points: [
      "`ds` is the run's logical date, the data interval Airflow gives you.",
      "Declare `ds` as a task parameter and Airflow passes it in automatically.",
      "`datetime.now()` is wall-clock, so a rerun of a past date grabs today's data.",
      "Returning `ds` keeps the task idempotent: reruns and backfills are reproducible.",
    ],
    options: [
      { id: "a", label: "ds parameter", correct: true,
        code: "@task\ndef get_date(ds=None):\n    return ds" },
      { id: "b", label: "datetime.now().date()",
        code: "@task\ndef get_date():\n    return datetime.now().date()" },
      { id: "c", label: "date.today()",
        code: "@task\ndef get_date():\n    return date.today()" },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import dag, task
from airflow.timetables.trigger import MultipleCronTriggerTimetable


@dag(
    schedule=MultipleCronTriggerTimetable(
        "0 9 * * 1-5",
        "0 17 * * 1-5",
        timezone="UTC",
    ),
    start_date=datetime(2026, 1, 1),
)
def sales_pipeline():

    @task
    def get_date(ds=None):
        return ds

    get_date()


sales_pipeline()
`,
  },

  // 6 ────────────────────────────────────────────────────────────────────────
  {
    id: "variable",
    kind: "code",
    title: "Step 6: Read the API URL from a Variable",
    prompt: "The API URL lives in an Airflow Variable. Where do we fetch it?",
    teach:
      "Keep config like the API URL in an Airflow Variable, not hardcoded. But " +
      "`Variable.get()` at the top of the file runs on EVERY parse, a metadata-DB query " +
      "each time, which slows the scheduler and hammers the database. Fetch the Variable " +
      "INSIDE the task, so it's read once at run time.",
    points: [
      "Keep config (URLs, paths) in Airflow Variables, not hardcoded.",
      "Top-level `Variable.get()` hits the metadata DB on every parse.",
      "That slows the scheduler and hammers the database.",
      "Fetch the Variable inside the task, read once at run time.",
    ],
    options: [
      { id: "a", label: "inside the task body", correct: true,
        code:
          "def extract(date):\n" +
          '    api_url = Variable.get("sales_api_url")\n' +
          "    return requests.get(api_url).json()" },
      { id: "b", label: "at the top of the file",
        code: 'api_url = Variable.get("sales_api_url")' },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import Variable, dag, task
from airflow.timetables.trigger import MultipleCronTriggerTimetable


@dag(
    schedule=MultipleCronTriggerTimetable(
        "0 9 * * 1-5",
        "0 17 * * 1-5",
        timezone="UTC",
    ),
    start_date=datetime(2026, 1, 1),
)
def sales_pipeline():

    @task
    def get_date(ds=None):
        return ds

    @task
    def extract(date: str):
        import requests

        api_url = Variable.get("sales_api_url")
        return requests.get(f"{api_url}?date={date}").json()

    extract(get_date())


sales_pipeline()
`,
  },

  // 7 ────────────────────────────────────────────────────────────────────────
  {
    id: "pass_data",
    kind: "code",
    title: "Step 7: Pass data downstream",
    prompt: "Pass each task's output to the next (date → extract → transform). How?",
    teach:
      "Returning a value pushes it to XCom; taking it as an argument pulls it back. The " +
      "date flows from get_date into extract, and extract's rows flow into transform, " +
      "explicit, traceable, and parallel-safe. Globals and scratch files break the " +
      "moment tasks run on different workers.",
    points: [
      "Return a value to push it to XCom; take an argument to pull it back.",
      "The date flows get_date → extract; the rows flow extract → transform.",
      "Explicit and safe across parallel workers; globals and `/tmp` don't survive.",
    ],
    options: [
      { id: "a", label: "return value → pass as argument (XCom)", correct: true,
        code: "def transform(raw):\n    return clean(raw)\n\ntransform(extract(get_date()))" },
      { id: "b", label: "store it in a global variable",
        code: "RAW = None" },
      { id: "c", label: "write to /tmp and read it back",
        code: 'open("/tmp/raw.json", "w").write(...)' },
    ],
    snapshot: `from datetime import datetime

from airflow.sdk import Variable, dag, task
from airflow.timetables.trigger import MultipleCronTriggerTimetable


@dag(
    schedule=MultipleCronTriggerTimetable(
        "0 9 * * 1-5",
        "0 17 * * 1-5",
        timezone="UTC",
    ),
    start_date=datetime(2026, 1, 1),
)
def sales_pipeline():

    @task
    def get_date(ds=None):
        return ds

    @task
    def extract(date: str):
        import requests

        api_url = Variable.get("sales_api_url")
        return requests.get(f"{api_url}?date={date}").json()

    @task
    def transform(raw: dict):
        return [row for row in raw["rows"] if row["amount"] > 0]

    transform(extract(get_date()))


sales_pipeline()
`,
  },

  // 8 ────────────────────────────────────────────────────────────────────────
  {
    id: "resilience",
    kind: "code",
    title: "Step 8: Make load resilient",
    prompt: "load hits a flaky warehouse. How do we configure it for production?",
    teach:
      "Flaky network and warehouse calls need real resilience. `retries` re-runs a " +
      "failed task; `retry_delay` waits between attempts; `retry_exponential_backoff` " +
      "lengthens that wait each time instead of hammering a struggling system; and " +
      "`execution_timeout` kills a hung task so it can never run forever and block a slot.",
    points: [
      "retries: how many times Airflow re-runs a failed task.",
      "retry_delay: how long to wait between attempts (e.g. 5 minutes).",
      "retry_exponential_backoff: grow the wait each retry instead of hammering.",
      "execution_timeout: kill a hung task so it can't run forever or block the pool.",
    ],
    options: [
      { id: "a", label: "retries + retry_delay + backoff + execution_timeout", correct: true,
        code:
          "@task(\n" +
          "    retries=3,\n" +
          "    retry_delay=timedelta(minutes=5),\n" +
          "    retry_exponential_backoff=True,\n" +
          "    execution_timeout=timedelta(hours=1),\n" +
          ")" },
      { id: "b", label: "just retries=3",
        code: "@task(retries=3)" },
      { id: "c", label: "retries=50, no timeout",
        code: "@task(retries=50)" },
    ],
    snapshot: `from datetime import datetime, timedelta

from airflow.sdk import Variable, dag, task
from airflow.timetables.trigger import MultipleCronTriggerTimetable


@dag(
    schedule=MultipleCronTriggerTimetable(
        "0 9 * * 1-5",
        "0 17 * * 1-5",
        timezone="UTC",
    ),
    start_date=datetime(2026, 1, 1),
)
def sales_pipeline():

    @task
    def get_date(ds=None):
        return ds

    @task
    def extract(date: str):
        import requests

        api_url = Variable.get("sales_api_url")
        return requests.get(f"{api_url}?date={date}").json()

    @task
    def transform(raw: dict):
        return [row for row in raw["rows"] if row["amount"] > 0]

    @task(
        retries=3,
        retry_delay=timedelta(minutes=5),
        retry_exponential_backoff=True,
        execution_timeout=timedelta(hours=1),
    )
    def load(rows: list):
        print(f"Loading {len(rows)} clean rows")

    transform(extract(get_date()))


sales_pipeline()
`,
  },

  // 9 ────────────────────────────────────────────────────────────────────────
  {
    id: "dependencies",
    kind: "code",
    title: "Step 9: Wire the dependencies",
    prompt: "How do we connect get_date → extract → transform → load?",
    teach:
      "With TaskFlow you just CALL the tasks: the return values create the dependencies " +
      "automatically. Mixing in `>>` on decorated functions, or pulling XComs by hand, is " +
      "redundant and error-prone.",
    points: [
      "Calling tasks wires the dependencies automatically in TaskFlow.",
      "`load(transform(extract(get_date())))` reads like the data flow itself.",
      "Don't mix `>>` on decorated tasks or pull XComs by hand.",
    ],
    options: [
      { id: "a", label: "load(transform(extract(get_date())))", correct: true,
        code: "load(transform(extract(get_date())))" },
      { id: "b", label: "extract() >> transform() >> load()",
        code: "extract() >> transform() >> load()" },
      { id: "c", label: "manual set_downstream + xcom_pull",
        code: "extract.set_downstream(transform)" },
    ],
    snapshot: `from datetime import datetime, timedelta

from airflow.sdk import Variable, dag, task
from airflow.timetables.trigger import MultipleCronTriggerTimetable


@dag(
    schedule=MultipleCronTriggerTimetable(
        "0 9 * * 1-5",
        "0 17 * * 1-5",
        timezone="UTC",
    ),
    start_date=datetime(2026, 1, 1),
)
def sales_pipeline():

    @task
    def get_date(ds=None):
        return ds

    @task
    def extract(date: str):
        import requests

        api_url = Variable.get("sales_api_url")
        return requests.get(f"{api_url}?date={date}").json()

    @task
    def transform(raw: dict):
        return [row for row in raw["rows"] if row["amount"] > 0]

    @task(
        retries=3,
        retry_delay=timedelta(minutes=5),
        retry_exponential_backoff=True,
        execution_timeout=timedelta(hours=1),
    )
    def load(rows: list):
        print(f"Loading {len(rows)} clean rows")

    load(transform(extract(get_date())))


sales_pipeline()
`,
  },

  // 10 ───────────────────────────────────────────────────────────────────────
  {
    id: "versioning",
    kind: "predict",
    title: "Step 10: DAG Versioning (predict!)",
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
    snapshot: `from datetime import datetime, timedelta

from airflow.sdk import Variable, dag, task
from airflow.timetables.trigger import MultipleCronTriggerTimetable


@dag(
    schedule=MultipleCronTriggerTimetable(
        "0 9 * * 1-5",
        "0 17 * * 1-5",
        timezone="UTC",
    ),
    start_date=datetime(2026, 1, 1),
)
def sales_pipeline():

    @task
    def get_date(ds=None):
        return ds

    @task
    def extract(date: str):
        import requests

        api_url = Variable.get("sales_api_url")
        return requests.get(f"{api_url}?date={date}").json()

    @task
    def transform(raw: dict):
        # v2: keep only high-value sales
        return [row for row in raw["rows"] if row["amount"] > 100]

    @task(
        retries=3,
        retry_delay=timedelta(minutes=5),
        retry_exponential_backoff=True,
        execution_timeout=timedelta(hours=1),
    )
    def load(rows: list):
        print(f"Loading {len(rows)} clean rows")

    load(transform(extract(get_date())))


sales_pipeline()
`,
  },

  // 11 ───────────────────────────────────────────────────────────────────────
  {
    id: "event_driven",
    kind: "code",
    title: "Step 11: Trigger a downstream DAG",
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
    // On reveal, seed the downstream DAG file (a second editor tab) with the
    // consumer scheduled on the Asset this step emits. Steps 12+ build it out.
    seed: {
      "dags/sales_report.py": `from airflow.sdk import Asset, dag, task


@dag(schedule=[Asset("clean_sales")])
def sales_report():

    @task
    def build_report():
        print("Building report from fresh clean_sales")

    build_report()


sales_report()
`,
    },
    options: [
      { id: "a", label: 'outlets=[Asset("clean_sales")]', correct: true,
        code: 'outlets=[Asset("clean_sales")]' },
      { id: "b", label: "downstream uses a poke sensor",
        code: "ExternalTaskSensor(...)" },
      { id: "c", label: "TriggerDagRunOperator at the end",
        code: "TriggerDagRunOperator(trigger_dag_id=...)" },
    ],
    snapshot: `from datetime import datetime, timedelta

from airflow.sdk import Asset, Variable, dag, task
from airflow.timetables.trigger import MultipleCronTriggerTimetable


@dag(
    schedule=MultipleCronTriggerTimetable(
        "0 9 * * 1-5",
        "0 17 * * 1-5",
        timezone="UTC",
    ),
    start_date=datetime(2026, 1, 1),
    tags=["best-practices", "webinar"],
    doc_md="### Sales pipeline\\nBuilt live by the audience",
)
def sales_pipeline():

    @task
    def get_date(ds=None):
        return ds

    @task
    def extract(date: str):
        import requests

        api_url = Variable.get("sales_api_url")
        return requests.get(f"{api_url}?date={date}").json()

    @task
    def transform(raw: dict):
        # v2: keep only high-value sales
        return [row for row in raw["rows"] if row["amount"] > 100]

    @task(
        retries=3,
        retry_delay=timedelta(minutes=5),
        retry_exponential_backoff=True,
        execution_timeout=timedelta(hours=1),
        outlets=[Asset("clean_sales")],
    )
    def load(rows: list):
        print(f"Loading {len(rows)} clean rows")

    load(transform(extract(get_date())))


sales_pipeline()
`,
  },

  // 12 ───────────────────────────────────────────────────────────────────────
  {
    id: "dynamic_mapping",
    kind: "code",
    file: "dags/sales_report.py",
    title: "Step 12: Build one report per region",
    prompt: "We need a report for each region. How do we create the tasks?",
    teach:
      "Use dynamic task mapping: `.expand()` creates one task instance per input at " +
      "run time, so the graph scales with the data. A Python for-loop fixes the count " +
      "at parse time, clutters the file, and can't react to runtime values.",
    points: [
      "`.expand()` creates one mapped task instance per input, at run time.",
      "It scales automatically when the number of inputs changes.",
      "A parse-time for-loop hardcodes the count and bloats the graph.",
      "Mapped instances collapse under a single task in the UI.",
    ],
    options: [
      { id: "a", label: "build_report.expand(region=get_regions())", correct: true,
        code: "build_report.expand(region=get_regions())" },
      { id: "b", label: "for r in get_regions(): build_report(r)",
        code: "for r in get_regions():\n    build_report(r)" },
      { id: "c", label: "hardcode one task per region",
        code: 'build_report("us")\nbuild_report("eu")\nbuild_report("apac")' },
    ],
    snapshot: `from airflow.sdk import Asset, dag, task


@dag(schedule=[Asset("clean_sales")])
def sales_report():

    @task
    def get_regions():
        return ["us", "eu", "apac"]

    @task
    def build_report(region: str):
        print(f"Building {region} report")

    build_report.expand(region=get_regions())


sales_report()
`,
  },

  // 13 ───────────────────────────────────────────────────────────────────────
  {
    id: "task_groups",
    kind: "code",
    file: "dags/sales_report.py",
    title: "Step 13: Group related tasks",
    prompt: "Each region builds then publishes. How do we organize those tasks?",
    teach:
      "Wrap related tasks in a `@task_group`. It collapses into one unit in the UI so " +
      "big DAGs stay readable, makes the structure obvious, and is modular, you can " +
      "import the group into other DAGs. You can even dynamically map a whole group.",
    points: [
      "Task groups bundle related tasks into one collapsible unit in the UI.",
      "They keep large DAGs readable and the structure obvious.",
      "A group is modular: import and reuse it across DAGs.",
      "You can dynamically map an entire task group with `.expand()`.",
    ],
    options: [
      { id: "a", label: "@task_group bundling build + publish", correct: true,
        code: "@task_group\ndef report(region):\n    publish(build(region))" },
      { id: "b", label: "leave them as separate top-level tasks",
        code: "build(region)\npublish(region)" },
      { id: "c", label: "do everything in one big task",
        code: "@task\ndef build_and_publish(region): ..." },
    ],
    snapshot: `from airflow.sdk import Asset, dag, task, task_group


@dag(schedule=[Asset("clean_sales")])
def sales_report():

    @task
    def get_regions():
        return ["us", "eu", "apac"]

    @task_group
    def report(region: str):
        @task
        def build(region: str):
            print(f"Building {region} report")

        @task
        def publish(region: str):
            print(f"Publishing {region} report")

        publish(build(region))

    report.expand(region=get_regions())


sales_report()
`,
  },

  // 14 ───────────────────────────────────────────────────────────────────────
  {
    id: "deferrable",
    kind: "code",
    file: "dags/sales_report.py",
    title: "Step 14: Wait without wasting a worker",
    prompt: "Reports should wait for market close. How do we wait efficiently?",
    teach:
      "Use a deferrable operator/sensor (`deferrable=True`). It releases the worker " +
      "slot while waiting and resumes via the triggerer once the condition is met, so " +
      "thousands can wait at once. Poke-mode sensors and `time.sleep()` hold a slot the " +
      "whole time.",
    points: [
      "Deferrable operators release the worker slot while waiting.",
      "They resume via the triggerer when the condition is met.",
      "Thousands can wait concurrently without exhausting worker slots.",
      "Poke-mode sensors and `time.sleep()` block a slot the whole time.",
    ],
    options: [
      { id: "a", label: "DateTimeSensor(..., deferrable=True)", correct: true,
        code:
          "DateTimeSensor(\n" +
          '    task_id="wait_for_close",\n' +
          '    target_time="...",\n' +
          "    deferrable=True,\n" +
          ")" },
      { id: "b", label: "regular sensor in poke mode",
        code: 'DateTimeSensor(task_id="wait_for_close", target_time="...")' },
      { id: "c", label: "time.sleep() inside a task",
        code: "@task\ndef wait():\n    time.sleep(3600)" },
    ],
    snapshot: `from airflow.providers.standard.sensors.date_time import DateTimeSensor

from airflow.sdk import Asset, dag, task, task_group


@dag(schedule=[Asset("clean_sales")])
def sales_report():

    wait_for_close = DateTimeSensor(
        task_id="wait_for_close",
        target_time="{{ ds }} 18:00:00",
        deferrable=True,
    )

    @task
    def get_regions():
        return ["us", "eu", "apac"]

    @task_group
    def report(region: str):
        @task
        def build(region: str):
            print(f"Building {region} report")

        @task
        def publish(region: str):
            print(f"Publishing {region} report")

        publish(build(region))

    wait_for_close >> report.expand(region=get_regions())


sales_report()
`,
  },

  // ══════════════════════════════════════════════════════════════════════════
  // LEVEL 2 — Blueprint: from copy-pasted DAGs to validated templates + YAML
  // ══════════════════════════════════════════════════════════════════════════

  // L2.1 ──────────────────────────────────────────────────────────────────────
  {
    id: "bp_problem",
    kind: "code",
    level: 2,
    file: "dags/customers.py",
    title: "Step 1: The problem",
    prompt: "50 analysts each copy this DAG for their table. What goes wrong?",
    teach:
      "Copy-paste doesn't scale. customers.py reads the URL from a Variable and sets " +
      "retries; orders.py already drifted, it hardcodes the URL and dropped retries. " +
      "Multiply by 50 and you get inconsistent, unvalidated pipelines nobody can " +
      "maintain. Blueprint fixes this: one validated template, many tiny YAML configs.",
    points: [
      "Copy-pasted DAGs drift: orders.py lost retries and hardcoded the URL.",
      "Nothing validates the config, a typo ships straight to production.",
      "50 near-identical files are impossible to keep consistent.",
      "Blueprint: one tested template, pipelines become small YAML.",
    ],
    preload: {
      "dags/customers.py": `from datetime import datetime

from airflow.sdk import Variable, dag, task


@dag(schedule="@daily", start_date=datetime(2026, 1, 1))
def customers():

    @task(retries=3)
    def extract():
        import requests

        api_url = Variable.get("sales_api_url")
        return requests.get(f"{api_url}/customers").json()

    @task
    def load(rows):
        print(f"Loading {len(rows)} customers")

    load(extract())


customers()
`,
      "dags/orders.py": `from datetime import datetime

from airflow.sdk import dag, task


@dag(schedule="@daily", start_date=datetime(2026, 1, 1))
def orders():

    @task
    def extract():
        import requests

        # drifted: hardcoded URL and no retries
        return requests.get("https://api.example.com/orders").json()

    @task
    def load(rows):
        print(f"Loading {len(rows)} orders")

    load(extract())


orders()
`,
    },
    options: [
      { id: "a", label: "They drift and can't be validated", correct: true,
        code: "# orders.py: no retries, hardcoded URL" },
      { id: "b", label: "Nothing, copy-paste is fine",
        code: "# cp customers.py orders.py" },
      { id: "c", label: "Add a linter and hope",
        code: "# pre-commit + good intentions" },
    ],
  },

  // L2.2 ──────────────────────────────────────────────────────────────────────
  {
    id: "bp_define",
    kind: "code",
    level: 2,
    explainFirst: true,
    file: "dags/templates/blueprints.py",
    title: "Step 2: Define a Blueprint",
    prompt: "How do we capture the extract -> load pattern once, for everyone?",
    teach:
      "A blueprint is a reusable task group template for a piece of a pipeline, " +
      "think of a cookie cutter: you design it once in Python, and everyone stamps out " +
      "their own pipeline from it. A Blueprint has two parts: a config (the few values " +
      "that change each time, like which table to pull) and a render method (the actual " +
      "tasks to run). Our Ingest template runs extract then load, with the good defaults, " +
      "retries and reading the URL from a Variable, baked in, so every pipeline made from " +
      "it is correct by default.",
    points: [
      "Reusable task group templates composed into Airflow DAGs via YAML",
      "Part 1, the config: the few values that change each time (e.g. the table).",
      "Part 2, render: the tasks to run, bundled together.",
      "Good defaults (retries, the Variable) live inside it, so every use is consistent.",
    ],
    options: [
      { id: "a", label: "Blueprint[Config] subclass + render()", correct: true,
        code: "class Ingest(Blueprint[IngestConfig]):\n    def render(self, config) -> TaskGroup:\n        ..." },
      { id: "b", label: "a shared helper function",
        code: "def ingest(source): ..." },
      { id: "c", label: "a base DAG everyone copies",
        code: "# cp base_dag.py my_dag.py" },
    ],
    snapshot: `from airflow.sdk import TaskGroup, Variable, task
from blueprint import BaseModel, Blueprint


class IngestConfig(BaseModel):
    source: str


class Ingest(Blueprint[IngestConfig]):
    """Extract a source from the API and load it into the warehouse."""

    def render(self, config: IngestConfig) -> TaskGroup:
        with TaskGroup(group_id=self.step_id) as group:

            @task(retries=3)
            def extract():
                import requests

                api_url = Variable.get("sales_api_url")
                return requests.get(f"{api_url}/{config.source}").json()

            @task
            def load(rows):
                print(f"Loading {len(rows)} {config.source} rows")

            load(extract())
        return group
`,
  },

  // L2.3 ──────────────────────────────────────────────────────────────────────
  {
    id: "bp_validate",
    kind: "code",
    level: 2,
    explainFirst: true,
    file: "dags/templates/blueprints.py",
    title: "Step 3: Validate the config",
    prompt: "How do we stop a typo'd or bad config from reaching production?",
    teach:
      "The config is just the list of values someone fills in for the template. We can " +
      "describe each value and set rules for it, what it means, whether it's required, " +
      "using Pydantic (Python's standard library for validated data). We also turn on " +
      "strict mode (extra=\"forbid\"): if someone misspells a value or adds one that " +
      "doesn't exist, Airflow stops with a clear error instead of silently ignoring it. " +
      "Bad config is caught immediately, not at 3am in production.",
    points: [
      "The config is the handful of values someone fills in for the template.",
      "Pydantic (Python's data-validation library) describes and checks each value.",
      "Strict mode rejects misspelled or unknown values instead of ignoring them.",
      "Mistakes fail right away with a clear message, not silently in production.",
    ],
    options: [
      { id: "a", label: 'Pydantic Field + extra="forbid"', correct: true,
        code:
          'model_config = ConfigDict(extra="forbid")\n' +
          'source: str = Field(description="...")' },
      { id: "b", label: "no validation, trust the YAML",
        code: "source: str" },
      { id: "c", label: "assert inside render()",
        code: "assert config.source  # too late" },
    ],
    snapshot: `from airflow.sdk import TaskGroup, Variable, task
from blueprint import BaseModel, Blueprint, Field
from pydantic import ConfigDict


class IngestConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(description="Source name, e.g. customers")


class Ingest(Blueprint[IngestConfig]):
    """Extract a source from the API and load it into the warehouse."""

    def render(self, config: IngestConfig) -> TaskGroup:
        with TaskGroup(group_id=self.step_id) as group:

            @task(retries=3)
            def extract():
                import requests

                api_url = Variable.get("sales_api_url")
                return requests.get(f"{api_url}/{config.source}").json()

            @task
            def load(rows):
                print(f"Loading {len(rows)} {config.source} rows")

            load(extract())
        return group
`,
  },

  // L2.4 ──────────────────────────────────────────────────────────────────────
  {
    id: "bp_compose",
    kind: "code",
    level: 2,
    explainFirst: true,
    file: "dags/sales.dag.yaml",
    title: "Step 4: Compose a DAG in YAML",
    prompt: "How does an analyst build a pipeline now? (compare with customers.py)",
    teach:
      "Now the payoff. Instead of writing Python, an analyst describes their pipeline in " +
      "a small text file using YAML, a simple, readable key-and-value format. They give it " +
      "a name and a schedule, then list the steps, and each step just picks a blueprint and " +
      "fills in its values. That's it. The 25-line customers.py becomes a handful of lines, " +
      "and it still gets retries and the Variable, because those live in the blueprint.",
    points: [
      "Pipelines are now described in a small YAML file, not Python.",
      "YAML is a plain, readable key-and-value text format.",
      "Each step just picks a `blueprint` and fills in its values.",
      "~25 lines of Python become a few lines, best practices still baked in.",
    ],
    options: [
      { id: "a", label: "a *.dag.yaml with steps", correct: true,
        code: "steps:\n  ingest_customers:\n    blueprint: ingest\n    source: customers" },
      { id: "b", label: "write the DAG in Python anyway",
        code: "@dag\ndef sales(): ..." },
      { id: "c", label: "keep customers.py as-is",
        code: "# leave the 25 lines" },
    ],
    snapshot: `dag_id: sales
schedule: "@daily"
description: "Ingest sources via Blueprint"

steps:
  ingest_customers:
    blueprint: ingest
    source: customers
`,
  },

  // L2.5 ──────────────────────────────────────────────────────────────────────
  {
    id: "bp_depends",
    kind: "code",
    level: 2,
    explainFirst: true,
    file: "dags/sales.dag.yaml",
    title: "Step 5: Wire the steps",
    prompt: "ingest_orders must run after ingest_customers. How?",
    teach:
      "Pipelines have an order: some steps must finish before others can start. In the " +
      "YAML you simply list the steps a step should wait for, with depends_on. Blueprint " +
      "connects them in the right order for you, and even checks you didn't create an " +
      "impossible loop (A waits for B while B waits for A). No Airflow wiring code to learn.",
    points: [
      "Steps often need an order: do this, then that.",
      "`depends_on` lists the steps a step should wait for.",
      "Blueprint connects them for you and catches impossible loops.",
      "It stays plain config, no Airflow wiring code to write.",
    ],
    options: [
      { id: "a", label: "depends_on: [ingest_customers]", correct: true,
        code: "depends_on: [ingest_customers]" },
      { id: "b", label: "use >> in the YAML",
        code: "ingest_customers >> ingest_orders" },
      { id: "c", label: "rely on key order",
        code: "# hope the file order wins" },
    ],
    snapshot: `dag_id: sales
schedule: "@daily"
description: "Ingest sources via Blueprint"

steps:
  ingest_customers:
    blueprint: ingest
    source: customers

  ingest_orders:
    blueprint: ingest
    source: orders
    depends_on: [ingest_customers]
`,
  },

  // L2.6 ──────────────────────────────────────────────────────────────────────
  {
    id: "bp_reuse",
    kind: "code",
    level: 2,
    explainFirst: true,
    file: "dags/marketing.dag.yaml",
    title: "Step 6: A second pipeline, for free",
    prompt: "A new team needs a campaigns pipeline. What do they write?",
    teach:
      "Here's why teams love this. Another team needs a new pipeline? They write no " +
      "Python, they add one small YAML file that reuses the same blueprint. Their pipeline " +
      "is automatically consistent and validated, because it's built from the same " +
      "template. And when you improve the blueprint later (say, add a timeout), every " +
      "pipeline built from it gets that improvement at once.",
    points: [
      "A new pipeline is just one more small YAML file, no Python.",
      "It reuses the same template, so it's consistent and validated by default.",
      "Adding a pipeline becomes a quick config change, not a project.",
      "Improve the template once and every pipeline gets the upgrade.",
    ],
    options: [
      { id: "a", label: "another *.dag.yaml reusing ingest", correct: true,
        code: "steps:\n  ingest_campaigns:\n    blueprint: ingest\n    source: campaigns" },
      { id: "b", label: "write a new Python DAG",
        code: "@dag\ndef marketing(): ..." },
      { id: "c", label: "copy a teammate's DAG file",
        code: "# cp orders.py campaigns.py  (drift again)" },
    ],
    snapshot: `dag_id: marketing
schedule: "@daily"
description: "A new pipeline, just YAML"

steps:
  ingest_campaigns:
    blueprint: ingest
    source: campaigns
`,
  },

  // L2.7 ──────────────────────────────────────────────────────────────────────
  {
    id: "bp_loader",
    kind: "code",
    level: 2,
    explainFirst: true,
    file: "dags/loader.py",
    title: "Step 7: Load the YAML DAGs",
    prompt: "How does Airflow turn every *.dag.yaml into a DAG?",
    teach:
      "One last piece connects this to Airflow. Airflow finds DAGs by scanning Python " +
      "files, but our pipelines are YAML now. So we add a single small file, the loader, " +
      "that says: find every YAML pipeline and turn it into a real DAG. You write it once " +
      "for the whole project, and from then on, adding a pipeline is just dropping in a YAML file.",
    points: [
      "Airflow normally discovers DAGs from Python files, but ours are YAML.",
      "One small `loader.py` calls `build_all_dags()` to turn every YAML into a DAG.",
      "You write the loader once for the whole project.",
      "After that, a new pipeline is just a new YAML file, nothing else.",
    ],
    options: [
      { id: "a", label: "loader.py with build_all_dags()", correct: true,
        code: "from blueprint import build_all_dags\n\nbuild_all_dags()" },
      { id: "b", label: "import each DAG by hand",
        code: "from my_dags import sales" },
      { id: "c", label: "a loop that exec()s the YAML",
        code: "for f in glob(...): exec(...)" },
    ],
    snapshot: `from blueprint import build_all_dags

build_all_dags()
`,
  },
];
