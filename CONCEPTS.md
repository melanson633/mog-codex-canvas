# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Workbook access

### Workbook Root

The authorized local directory that bounds every workbook and generated-image operation, including canonical path checks that prevent aliases or links from escaping it.

### Workbook Revision

A content-derived identity for the workbook bytes currently on disk, used to detect whether a file changed between opening and saving it.

### Workbook Session

A server-managed handle for one opened workbook that binds subsequent operations to the file revision observed at open time.

After a successful save, the session advances to the new revision. If the workbook changes outside the session first, the save is refused and the attempted work is preserved separately rather than overwriting the newer file.

## Host validation

### Mog Canvas

The live spreadsheet surface that owns interactive editing and computation while its host owns file access, persistence, and authorization.

### Reference Host

A local test harness that implements the MCP Apps host contract closely enough to exercise the real application resource, sandbox, tool bridge, and user interaction without making claims about a specific production host.

### Host Acceptance Gate

The final deployment check performed in the actual target host, requiring visible application rendering plus a real edit, save, and persisted-file validation before host integration is declared working.

Reference Host success is prerequisite evidence, not a substitute for this gate.
