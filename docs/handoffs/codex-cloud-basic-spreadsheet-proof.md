---
artifact_contract: "ce-handoff/v1"
created_at: "2026-09-11T03:33:01Z"
title: "Codex Cloud basic Mog spreadsheet proof"
summary: "Run one bounded cloud task that creates, recalculates, saves, reopens, validates, and returns a basic XLSX artifact to the repository diff."
keywords: ["codex-cloud", "mog", "xlsx", "cloud-proof"]
cwd: "C:\\Users\\MarkMelanson\\Documents\\Mog-Codex-Live-XLSX"
resume_focus: "Execute the basic Mog spreadsheet proof in a Codex Cloud task and return the generated evidence in the repository diff."
repository: "Mog-Codex-Live-XLSX"
repo_root_sha: "f90a965c7d5f625c60488d8f0d7e20bbc1347341"
branch: "main"
head: "a86f2edb9fe8737fac6a6b49f8aa7b000c65f28e"
---

# Codex Cloud basic Mog spreadsheet proof

## Objective authorized by the user

Run one real Codex Cloud task against this repository. The cloud agent must create a basic spreadsheet with Mog, calculate formulas, save it, reopen it, validate exact values, capture a screenshot, and leave the workbook and proof evidence in the task's repository diff.

This is a bounded portability test. It is not evidence of universal Excel compatibility, cloud tenancy, or production security.

## Repository state prepared for the proof

- `scripts/codex-cloud-setup.sh` is the Linux startup script. It checks the repository's Node requirement, installs the lockfile including optional platform packages, and proves that `@mog-sdk/sdk/node` loads.
- `scripts/codex-cloud-spreadsheet-proof.mjs` owns the fixed proof workflow and assertions. It uses the shared workbook service for XLSX persistence.
- `package.json` exposes the workflow as `npm run cloud:proof`.
- Generated evidence belongs under `artifacts/codex-cloud/`. The workbook, PNG, and JSON result are intended to remain visible in the Cloud task diff; `.audit/` receipts remain ignored.
- `AGENTS.md` contains the repository's authoritative safety, SDK, validation, and evidence rules.

## Codex Cloud environment

In the Codex environment settings for this repository, use:

- Container image: default Codex universal Linux image.
- Startup script: `bash scripts/codex-cloud-setup.sh`
- Environment variables: none required.
- Secrets: none required.
- Internet access during the task: not required after the startup script succeeds. Dependency installation during setup requires npm registry access unless dependencies are already cached by the environment.

Do not configure Excel desktop, Windows, GitHub tokens, OpenAI API keys, or third-party credentials for this proof.

## Copy-paste Cloud task prompt

```text
Run the repository's bounded Codex Cloud spreadsheet proof.

Read AGENTS.md and docs/handoffs/codex-cloud-basic-spreadsheet-proof.md first. Do not upgrade packages or change implementation files unless the existing proof cannot run; if it fails, preserve the failure evidence and diagnose it without broadening scope.

Run:
1. npm run cloud:proof
2. npm run check:sdk-surface
3. git status --short

Verify that these generated files exist and are non-empty:
- artifacts/codex-cloud/basic-spreadsheet.xlsx
- artifacts/codex-cloud/basic-spreadsheet.png
- artifacts/codex-cloud/proof-result.json

Read proof-result.json and confirm status is passed, the reopened D4 formula is =C4-B4, and its value is 9000. Report the Node version, platform, architecture, Mog save-fidelity status, and every command result.

Leave the three generated proof files in the task's repository diff so they can be returned for review. Do not push, open a pull request, or make external writes.
```

## Success gate

The proof passes only if:

1. The Mog Node package loads in the Linux startup environment.
2. `npm run cloud:proof` exits zero.
3. XLSX and PNG signatures are validated.
4. The saved workbook reopens and retains formula `=C4-B4` with value `9000`.
5. `proof-result.json` reports `status: "passed"`.
6. The three output files appear in the Cloud task's diff.
7. `npm run check:sdk-surface` passes.

Anything else is a failed or incomplete cloud proof. A locally generated substitute does not count.

## Interpretation boundary

A pass establishes that this Codex Cloud environment can install and load Mog, create a basic workbook, calculate supported formulas, export XLSX, reopen it, validate values, render a screenshot, and return artifacts through the repository diff.

It does not establish arbitrary workbook fidelity, external-link refresh, macros, pivots, complex charts, desktop Excel parity, multi-tenant isolation, durable application storage, or authenticated GitHub writes.
