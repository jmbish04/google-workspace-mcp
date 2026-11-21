from gws_ingest.chunking import chunk_text
from gws_ingest.rules import MailFacts, decide, matches

F = MailFacts(sender="Eloisa <eloisa@iproofing.test>", to="owner@mailbox.test", subject="COI for the roof", body="certificate of insurance attached", labels=["INBOX"])


def rule(i, cond, act, prio=100, enabled=True, target="gmail"):
    return {"id": i, "enabled": enabled, "priority": prio, "target": target, "conditions": cond, "actions": act}


def test_empty_conditions_match_nothing():
    assert not matches({}, F)
    assert decide([rule(1, {}, {"embed": True})], F).matched_rule_ids == []


def test_conditions_are_anded_lists_are_ored():
    assert matches({"from": ["iproofing.test", "other"], "subjectContains": ["COI"]}, F)
    assert not matches({"from": ["iproofing.test"], "subjectContains": ["invoice"]}, F)
    assert matches({"labels": ["inbox"]}, F)  # case-insensitive
    assert not matches({"labels": ["SENT"]}, F)


def test_actions_merge_in_priority_order_and_later_cannot_turn_off():
    rules = [
        rule(2, {"from": ["iproofing"]}, {"embed": False, "extractAttachments": True, "projectKey": "mr-roofing"}, prio=20),
        rule(1, {"subjectContains": ["coi"]}, {"embed": True, "addLabels": ["coi"]}, prio=10),
    ]
    d = decide(rules, F)
    assert d.matched_rule_ids == [1, 2]
    assert d.embed and d.extract_attachments and d.project_key == "mr-roofing" and d.add_labels == ["coi"]


def test_disabled_and_drive_rules_are_ignored():
    assert decide([rule(1, {"from": ["iproofing"]}, {"embed": True}, enabled=False)], F).matched_rule_ids == []
    assert decide([rule(1, {"from": ["iproofing"]}, {"embed": True}, target="drive")], F).matched_rule_ids == []


def test_chunking():
    assert chunk_text("") == [] and chunk_text("short") == ["short"]
    text = ("Sentence number one is here. " * 200).strip()
    cs = chunk_text(text, max_chars=500, overlap=50)
    assert len(cs) > 5 and all(len(c) <= 500 for c in cs)
    assert "".join(cs).replace(" ", "").count("Sentencenumberone") >= 200  # nothing dropped
