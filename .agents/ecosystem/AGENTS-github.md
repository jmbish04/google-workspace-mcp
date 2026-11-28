# GitHub

> Part of the workstation briefing. **`~/AGENTS.md` is the parent — read it first**;
> it carries the rules that apply everywhere (secrets, backups, how to write to
> Justin, when to flag). This file adds the rules for **GitHub** — PRs, reviews, merges, workflow files, and the auth traps.

---

# GitHub

**Use `gh-tools`. It is the toolkit built for exactly this.** Agents lose hours
to GitHub auth every week; this CLI exists so they stop.

```bash
gh-tools --help
```

`gh-tools` (in `~/bin`, on the terminal banner) is a thin wrapper around
`local-github-control` — either name works.

**Three subcommands live in the wrapper itself, not in `local-github-control`,** and
they are how the machine-wide briefings reach a repo (`~/AGENTS.md` → "Every repo
pulls its own right-sized copy of these briefings"):

| Command | What it does |
| --- | --- |
| `gh-tools agents-sync [<path>\|<owner/repo>]` | install the briefing sync Action into one repo — workflow, secret, first sync, git hooks |
| `gh-tools agents-audit [--limit=30]` | check the most recently pushed repos for it: `workflow`, `secret`, `synced` |
| `gh-tools agents-rollout [--yes]` | install it into every repo missing it. **Writes nothing without `--yes`** |

Run `agents-rollout` bare first and read the list — it commits to each repo's
default branch and sets a secret on each.

## Workflow files: measure the token, fall back to SSH — never ask Justin for a scope

**Before pushing `.github/workflows/*`, measure the token's scopes.** Since
2026-09-11 the gh login and both tokens-CLI names carry `workflow` (verified by
an accepted HTTPS token push). If a token ever lacks it again, **push over SSH**,
which does not need the scope at all — measured on one commit pushed both ways
while the tokens still lacked it:

```
https + token : ! [remote rejected] … (refusing to allow an OAuth App to create or
                update workflow `.github/workflows/probe.yml` without `workflow` scope)
ssh           : * [new branch]      probe/ssh-workflow-scope -> probe/ssh-workflow-scope
```

```bash
git push git@github.com:<owner>/<repo>.git <branch>               # no remote change needed
git push ssh://git@ssh.github.com:443/<owner>/<repo>.git <branch> # port 22 blocked
ssh -T git@github.com                                             # "Hi jmbish04!"
```

Three mistakes agents have made here:

- **Handing Justin `gh auth refresh -s workflow` from a local session.** SSH is
  right there. It is only a legitimate ask from a cloud session with no SSH key.
- **Trusting `gh-tools upsert-workflow` without measuring.** It writes through
  the Contents API with a token, so it needs `workflow` scope — and fails with a **404**, not
  a 403. GitHub answers a refused write on a private resource with "Not Found".
  A 404 on `PUT …/contents/.github/workflows/…` means *scope*, not *missing repo*;
  confirm the repo with a GET before believing it.
- **Concluding "no credential can do this"** after measuring only tokens. The
  scope is a token restriction. Your account can push workflows; your tokens
  cannot.

To write the workflow file, commit it and push the branch over SSH, then open the
PR with `gh-tools create-pr` as usual — PRs and merges do not need `workflow`
scope.

## GitHub Actions routing: 3 tiers, one `runs-on` form

Every workflow job picks its runner through a repo variable and falls back to a
GitHub-hosted runner. A failover daemon on Proxmox flips the variable when a tier
degrades (`AGENTS-proxmox.md` → "GitHub Actions runners").

| Tier | Runs on | When |
| --- | --- | --- |
| 1 (default) | GitHub-hosted `ubuntu-latest` | `CI_RUNNER` / `AGENTS_SYNC_RUNNER` unset, empty, or anything that is not a JSON array |
| 2 | `github-actions-1` (lxc/135, `192.168.1.197:8791`) | variable set to `["self-hosted","Linux","X64","proxmox-actions"]` |
| 3 | `github-actions-2` (lxc/139, `192.168.1.208:8791`) | lxc/135 overflow or down; the two hosts forward to each other |

**Every job uses this form, with `ubuntu-latest` as the fallback:**

```yaml
runs-on: ${{ startsWith(vars.CI_RUNNER, '[') && endsWith(vars.CI_RUNNER, ']') && fromJSON(vars.CI_RUNNER) || 'ubuntu-latest' }}
```

`agents-sync.yml` uses `vars.AGENTS_SYNC_RUNNER` in the same shape.

**The brackets are checked before `fromJSON` is reached, and that is the whole point.**
GitHub's cloud runners are the default, whatever the variable holds (Justin, 2026-11-02:
the hosted budget is raised, and the Proxmox boxes are for when hosted fails). Only one
value sends a job to Proxmox: a JSON array of that repo's runner labels.

The shape this replaced was `vars.CI_RUNNER && fromJSON(vars.CI_RUNNER) || 'ubuntu-latest'`.
It fell back to hosted for unset and empty, and for nothing else — measured against
GitHub's own engine (`@actions/expressions` 0.3.61):

| `CI_RUNNER` | the old form | this form |
| --- | --- | --- |
| unset | `ubuntu-latest` | `ubuntu-latest` |
| `""` | `ubuntu-latest` | `ubuntu-latest` |
| `self-hosted` | **threw, failing the job** | `ubuntu-latest` |
| `{"a":1}` | **`Object`**, a label no runner has | `ubuntu-latest` |
| `["self-hosted","Linux","X64","proxmox-actions"]` | the labels | the labels |
| `[oops]` | **threw** | **threw** |

The fourth row is the worse of the two failures: a `runs-on` of `Object` does not fail
red, it sits queued and invisible. A garbled variable is not a request to leave the
default, so it lands on hosted instead of taking the repo's CI down.

**The last row is the limit, and it is not fixable here.** Expression syntax cannot
validate JSON, so the brackets narrow the failure from "any non-JSON string" to "a value
shaped like an array whose contents are not JSON", and no further.

`scripts/test-runner-expression` carries that table as assertions against GitHub's own
engine, reading the expressions out of the files that ship them. It takes extra paths, so a
repo's own workflow is checked with the same assertions:
`node scripts/test-runner-expression .github/workflows/ci.yml`.

**It checks every `runs-on` in a file, not the first one.** A workflow with four jobs where
only job one is guarded reads exactly like a workflow that is fully guarded, so a test that
reads one line per file is an instrument that cannot fail. Measured on a two-job file: the
single-line version printed `all assertions passed` while job two still carried the shape
the test exists to reject.

**Never hardcode `runs-on: self-hosted` or `[self-hosted, Linux, X64, proxmox-actions]`.**
A hardcoded label traps the repo on the Proxmox runners while Tier 1 is the live
default, and it queues forever in a repo with no runner (a queued job is invisible;
a failed one is not).

This is enforced, not just written down:

| Guard | Where | What it does |
| --- | --- | --- |
| `scripts/runner-guard` | every repo (shipped by `pull-agents`) | `check FILE...` / `check --staged`; exit 1 on a hardcoded self-hosted `runs-on` |
| git `pre-commit` | installed by `pull-agents install-hooks` | runs `runner-guard check --staged` over staged workflows; chains any hook already there |
| Claude Code `PreToolUse` | `claude/settings.json` | blocks `Write` / `Edit` / `MultiEdit` on `.github/workflows/*.y*ml` (and `templates/*.yml`) with the fix; also blocks the Bash commands that bring persistent runner services back |

The guard reads the **staged blob**, not the working tree, and ignores comments.
Test: `scripts/test-runner-guard` (29 assertions, each shown to fail when the guard
is broken on purpose). Bypass a commit only with Justin's OK: `git commit --no-verify`.

## The toolkit

It is PyGithub-first and **deliberately does not depend on the `gh` CLI** for PR
metadata or patch retrieval. It resolves auth itself: `GITHUB_TOKEN` or
`GH_TOKEN` from the environment, falling back to the tokens CLI when neither is
set. No browser flow. It authenticates with a token, so it inherits the token's
missing `workflow` scope (above).

| Need | Command |
|---|---|
| Open a PR | `create-pr` |
| Read a PR's discussion, reviews, and code comments | `pr-discussion <repo_path> <pr_number>` |
| Review / merge | `review-pr`, `merge-pr` |
| Clear merge drift | `update-pr-branch` |
| Check out a PR head locally, push a patch back | `sync-pr`, `patch-pr` |
| New repo | `create-repo` |
| Read / dispatch workflows | `list-workflows`, `get-workflow`, `run-workflow` |
| **Write** a workflow file | `git push` (measure the token has `workflow`; else push over SSH). `upsert-workflow` works only when the token has `workflow` — otherwise it 404s |
| Actions secrets | `set-secret` |
| Anything else | `github-op` (one JSON-driven entrypoint) |

Positional args, not flags — `gh-tools pr-discussion /path/to/repo 20`, not
`--repo-name`. Check `<subcommand> --help` first.

`gh` remains fine for quick reads and for anything the toolkit does not cover.
The maestro MCP GitHub tools are a third path. Use whichever works — but reach
for `local-github-control` first on PR and workflow work, because it sidesteps
the auth and sandbox problems that `gh` runs into.

## Never report a GitHub failure you have not measured

This is the rule that actually saves the time. Before saying you are blocked,
lack permission, or lack scope, run the check and quote the output:

```bash
gh auth status                    # accounts, which is active, and their scopes
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $(tokens show GH_TOKEN --value-only)" https://api.github.com/user
```

"I ran X and got `<exact error>`" is always acceptable. "I can't, I don't have
permission" without a command behind it is not. If one path fails, try another
before reporting — a differently-scoped token, the toolkit instead of `gh`, REST
instead of GraphQL. There is almost always a path.

**How the tokens actually behave (verified 2026-09-11 — re-measure, do not trust):**
The gh login, `GH_TOKEN` and `GITHUB_TOKEN` (tokens CLI) are one `gho_` token with
`repo, gist, read:org, admin:public_key, workflow`. The tokens CLI re-syncs both
names from `gh auth token` on every call (`_seed_github_tokens`,
`~/bin/tokens_cli/core/data.py`), checking only that the token works — not its
scopes. So a PAT stored by hand under either name is replaced on the next call;
change the **gh login's** scopes instead.

Justin's interactive terminal additionally exports a `ghp_` PAT from the cache
`~/.config/zsh/tokens.env` (via `tokens_env.zsh`); agent shells do not load it.
That split is why "my auth works" and "no token has `workflow`" were both true
before the fix. `~/.config/zsh/refresh_tokens.sh` rewrites that cache from the
tokens CLI — safe now that the tokens CLI copy has `workflow`.

If scope is ever missing again, Justin runs this once, in a browser. `env -u` is
required: with `GH_TOKEN` set, gh refuses ("The value of the GH_TOKEN
environment variable is being used for authentication"). Have him type the code
into a **fresh** github.com/login/device tab — a stale tab reports "expired" for
a code seconds old:

```bash
env -u GH_TOKEN -u GITHUB_TOKEN gh auth refresh -h github.com -s workflow
```
---