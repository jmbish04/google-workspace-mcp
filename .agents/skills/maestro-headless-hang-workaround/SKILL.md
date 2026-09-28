---
name: maestro-headless-hang-workaround
description: Workaround for colby-maestro hanging when spawning code reviewers from headless sessions. Use when attempting to run orchestrator-based PR review in CI or automation, or when maestro processes hang on permission prompts.
---

Colby-maestro hangs when spawning code reviewers from headless sessions. The spawned subprocess uses `--permission-prompt-tool stdio`, and the reviewer's first tool call (typically `git diff`) requires permission, causing the process to block indefinitely on an unanswerable stdin prompt.

**Workaround**: Do not use orchestrator-spawned reviewers in headless (CI, automation) environments. Instead:
- Use an in-process code reviewer directly (e.g., `agent-skills:code-reviewer`).
- Or run maestro review manually from an interactive terminal.

This is a known limitation specific to subprocess-based orchestration with stdio permission prompts in non-interactive environments.