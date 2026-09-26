# Hosted Mog workflows: Sites, WebMCP, TypeSafe and TabFM

Assessment: 2026-09-19. This is an architecture assessment requested alongside
the decision-desk implementation. No Site was created, no workbook was uploaded,
and no paid model API was called for this assessment.

## Recommendation

A private Site is a promising coordination and review surface for parallel
experiments. Keep the authoritative workbook and deterministic calculations local
initially. Add an outbound local job runner and a revision-checked proposal
import path before considering automatic synchronization. The Site should not
be presented as a drop-in deployment of the current Node application.

The current application uses native Node SDK execution, child processes and
filesystem containment. Sites documents a Cloudflare Worker runtime, D1 state
and R2 object storage. Those are useful hosting building blocks, but do not
establish compatibility with the native SDK or provide a mount of local files.
Browser WASM computation is a possible separate experiment, not a verified
replacement for the existing engine's financial calculations.

## Roles of the proposed tools

| Tool | Best role | What it does not establish |
| --- | --- | --- |
| Sites | Private experiment queue, assignment/status views, artifact review, parallel workspace metadata | Native Node process execution, local filesystem access or automatic conflict-safe sync |
| WebMCP | Structured browser actions sharing validation with visible controls | A durable worker, job scheduler, authorization system or sync protocol |
| TypeSafe Jev | Semantic selection, classification, triage and ranking with typed outputs | Exact accounting arithmetic, a guarantee that a judgment is true, or local-only processing |
| Google TabFM | Prediction of numeric targets or classes using labelled example rows | Spreadsheet formula evaluation, causal explanations or accounting reconciliation |
| Mog and workbook-service | Workbook calculation, bounded experiments and controlled local persistence | Predictive inference or semantic classification by themselves |

## Source findings

### Sites and WebMCP

The installed Sites references describe [Worker capabilities](C:/Users/MarkMelanson/.codex/plugins/cache/openai-curated-remote/sites/0.1.65/skills/sites-building/references/starter-capabilities.md),
[D1/R2 persistence](C:/Users/MarkMelanson/.codex/plugins/cache/openai-curated-remote/sites/0.1.65/skills/sites-building/references/persistence-and-storage.md)
and [WebMCP integration](C:/Users/MarkMelanson/.codex/plugins/cache/openai-curated-remote/sites/0.1.65/skills/sites-building/references/webmcp.md).
These are machine-local documentation links, not a tested deployment.

[Chrome's WebMCP overview](https://developer.chrome.com/docs/ai/webmcp) describes
an early browser tool surface. [Its security guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
reinforces origin and permission boundaries. A tool such as `read_job_status`
can expose the same operation as a visible UI control. `stage_result` must still
use the application's validation and authorization; exposing a tool is not
permission to apply its output to a local workbook.

### TypeSafe

The [live documentation index](https://docs.typesafe.ai/llms.txt),
[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript), and
[confidence guidance](https://docs.typesafe.ai/confidence) describe a hosted API
returning choices, rubric scores and yes/no probabilities. A useful first
experiment would rank explicitly selected model-review findings or map a user
request to an existing validated analysis action. Known calculations stay in code.
The current SDK requires an API key; the JavaScript SDK documents Node 20+.

The [privacy policy](https://typesafe.ai/legal/privacy-policy) states that inputs
are not used for model training, while the [customer agreement](https://typesafe.ai/legal/mca)
allows service processing and telemetry. Sending a financial table to the API
is still an external data transfer. Initial experiments should use synthetic
or explicitly approved, minimized data; no client workbook should be sent just
because this skill or API is available.

### TabFM

[Google's announcement](https://research.google/blog/introducing-tabfm-a-zero-shot-foundation-model-for-tabular-data/)
and [official repository](https://github.com/google-research/tabfm) describe
tabular classification/regression using labelled rows as context. Possible
financial applications include payment-delay prediction, expense-category
suggestions or missing-value estimates, separately labelled as predictions.
Backtesting must compare it to straightforward baselines and avoid temporal
leakage; it must never silently replace workbook facts.

At the time of research, the repository states that there is no TabFM technical
report. Related papers linked by the announcement are not a TabFM paper. The
Python implementation supports JAX/PyTorch and optional CUDA; these are not
established Sites Worker runtimes.

The [released weight model card](https://huggingface.co/google/tabfm-1.0.0-pytorch)
and repository specify separate non-commercial, non-production terms for the
pretrained weights. Do not treat a permissive code license as production rights
to those weights. Review current terms for the intended deployment before adoption.

Google also documents a distinct [BigQuery AI.PREDICT Preview](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/bigqueryml-syntax-ai-predict).
The researched docs specify 20 feature columns and 10 classes and bill use
through BigQuery, with pricing changes announced for October 30, 2026. This is
a separate cloud-data and billing path, not a bundled local Mog capability.
Availability, limits and terms must be rechecked before an implementation.

## Proposed workflow

1. Create a job with a workbook identifier, base SHA-256 revision, permitted
   sheet/range scope, explicit analysis request and execution budget.
2. Store job metadata in D1. Use R2 for immutable snapshots or result artifacts
   only when that data transfer has been approved. Separate jobs and access by
   workspace; never expose a shared bucket as a public workbook directory.
3. Let a local runner poll over outbound HTTPS. It reads workbook bytes through
   `workbook-service`, validates the base revision, and executes the existing
   disposable experiment code. Read-only branches can run independently within
   a measured concurrency budget; each native calculation still needs memory.
4. Return source-linked evidence. Mark numerical engine results, semantic model
   judgments, and predictive estimates as different result types.
5. Show the proposed change or evidence in the Site and local workbench. Import
   only a validated result envelope, not arbitrary scripts or caller paths.
6. Re-read and compare the local revision immediately before promotion. A changed
   revision makes the proposal stale. Use existing staged saves, backups and
   fidelity validation for an approved edit; do not merge competing XLSX binaries.
7. Preserve jobs and local work across disconnects. Use idempotent job/result
   identifiers so a retried completion cannot apply the same change twice.

For agents, WebMCP can provide `list_jobs`, `inspect_result`, `submit_analysis`
and `stage_proposal` over these same operations. It must not bypass the local
promotion gate. Do not open a general cloud-to-loopback endpoint to accomplish sync.

## First viable prototype and proof

Use only the synthetic consulting workbook. Submit two read-only jobs from a
private Site, execute locally, and render their evidence back on the Site.
Then test a proposed edit to a disposable copy: matching revision accepted,
stale revision refused, duplicate completion idempotent, invalid ranges rejected,
unapproved data excluded, network failure leaving original bytes intact.

Only after that works should the project evaluate native browser calculation,
TypeSafe semantic triage or TabFM predictions. This assessment recommends the
architecture; none of these cloud integration claims has been runtime-verified.
