"""Routing rules: the "advanced filters" that decide what gets embedded (pure, no I/O).

A rule is {target, enabled, priority, conditions, actions}. Conditions are ANDed; each list
condition is an OR over its entries. Rules are applied in priority order (low number first);
actions merge, a later rule never turns an earlier `True` off.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MailFacts:
    sender: str = ""
    to: str = ""
    subject: str = ""
    body: str = ""
    labels: list[str] = field(default_factory=list)


@dataclass
class Decision:
    index: bool = False
    embed: bool = False
    extract_attachments: bool = False
    project_key: str | None = None
    add_labels: list[str] = field(default_factory=list)
    matched_rule_ids: list[int] = field(default_factory=list)


def _any_in(needles: list[str], hay: str) -> bool:
    h = hay.lower()
    return any(n.lower() in h for n in needles if n)


def matches(cond: dict[str, Any], f: MailFacts) -> bool:
    """True when every present condition holds. An empty condition set matches nothing:
    a rule with no conditions is a mistake, not "everything"."""
    checks: list[bool] = []
    if cond.get("from"):
        checks.append(_any_in(cond["from"], f.sender))
    if cond.get("to"):
        checks.append(_any_in(cond["to"], f.to))
    if cond.get("subjectContains"):
        checks.append(_any_in(cond["subjectContains"], f.subject))
    if cond.get("bodyContains"):
        checks.append(_any_in(cond["bodyContains"], f.body))
    if cond.get("labels"):
        have = {x.upper() for x in f.labels}
        checks.append(any(x.upper() in have for x in cond["labels"]))
    return bool(checks) and all(checks)


def decide(rules: list[dict[str, Any]], f: MailFacts) -> Decision:
    d = Decision()
    for r in sorted((r for r in rules if r.get("enabled", True) and r.get("target") == "gmail"), key=lambda r: (r.get("priority", 100), r.get("id", 0))):
        if not matches(r.get("conditions") or {}, f):
            continue
        a = r.get("actions") or {}
        d.matched_rule_ids.append(r["id"])
        d.index = d.index or bool(a.get("index", True))
        d.embed = d.embed or bool(a.get("embed", False))
        d.extract_attachments = d.extract_attachments or bool(a.get("extractAttachments", False))
        d.project_key = d.project_key or a.get("projectKey")
        d.add_labels += [x for x in a.get("addLabels", []) if x not in d.add_labels]
    return d
