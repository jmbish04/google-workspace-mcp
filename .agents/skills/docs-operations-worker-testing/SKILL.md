---
name: docs-operations-worker-testing
description: Test docs operations in the worker and debug auth/scope issues. Use when testing docs_create, docs_insert_text, or docs_append_markdown; when append_markdown returns 403; or when verifying HTML entity handling.
---

When docs operations fail in the worker, docs_append_markdown and docs_create_from_markdown return 403 for the DWD identity (justin@126colby.com); docs_insert_text works fine. Root cause is likely an internal getRaw or scope issue.

Workaround: Use docs_insert_text to validate docs flows and entity handling — it exercises the same write path and reliably tests entity decoding.

Entity handling confirmed working (PR #19 deployed): HTML entities in input (&quot;, &#39;, &amp;) decode properly in the document output.

See references/docs-operations-test-findings.md for test details.
