# Codex Cloud proof artifacts

Codex's **Create PR** transport does not accept binary files. The XLSX workbook
and PNG screenshot are therefore stored as Base64 text so the proof can cross
that transport without changing their bytes.

Restore both original files from the repository root with:

```bash
node artifacts/codex-cloud/restore-proof-artifacts.mjs
```

The restore script verifies each file's SHA-256 digest before writing it. The
resulting files are:

- `artifacts/codex-cloud/basic-spreadsheet.xlsx`
- `artifacts/codex-cloud/basic-spreadsheet.png`

`proof-result.json` is the original machine-readable result from the cloud run.
