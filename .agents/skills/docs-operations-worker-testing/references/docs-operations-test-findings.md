# Docs operations testing (2026-08-27)

## append_markdown 403 for DWD identity

Tested docs_append_markdown and docs_create_from_markdown as justin@126colby.com — both returned 403 "Upstream Google API error". Likely root cause: internal getRaw or includeTabsContent scope issue. The same identity works fine with docs_insert_text.

## Entity decoding works

Using docs_insert_text with escaped HTML: input contains &quot;hello&quot; and it&#39;s — output in document shows decoded "hello" and it's. Entities are properly decoded.

## Workaround

When append_markdown 403s, use docs_insert_text instead. Both exercise the core write path and allow validation of entity handling without hitting the auth issue.
