"""Builds tests/fixtures/longmemeval-mini.jsonl.gz, the retrieval regression fixture.

    python bench/make_fixture.py path/to/longmemeval_s_cleaned.json

LongMemEval (Wu et al., 2024, MIT licence): https://github.com/xiaowu0162/LongMemEval
For each question type, the first PER_TYPE questions (by question_id) that have marked evidence.
Each question keeps every session with an answer-bearing turn plus DISTRACTORS other sessions,
picked evenly across the haystack, in haystack order. Output is deterministic.
"""
import gzip
import json
import sys
from collections import defaultdict

PER_TYPE = 6
DISTRACTORS = 8


def main(src: str, dst: str = "tests/fixtures/longmemeval-mini.jsonl.gz") -> None:
    data = json.load(open(src, encoding="utf-8"))
    by_type = defaultdict(list)
    for q in sorted(data, key=lambda q: q["question_id"]):
        if q["question_id"].endswith("_abs"):
            continue
        if any(t.get("has_answer") for s in q["haystack_sessions"] for t in s):
            by_type[q["question_type"]].append(q)
    out = []
    for kind in sorted(by_type):
        for q in by_type[kind][:PER_TYPE]:
            sessions = list(zip(q["haystack_session_ids"], q["haystack_sessions"]))
            ev_idx = [i for i, (_, s) in enumerate(sessions) if any(t.get("has_answer") for t in s)]
            others = [i for i in range(len(sessions)) if i not in ev_idx]
            step = len(others) / DISTRACTORS
            keep = sorted(set(ev_idx) | {others[int(k * step)] for k in range(DISTRACTORS)})
            conv = {"id": q["question_id"], "kind": kind, "question": q["question"], "sessions": [], "evidence_groups": []}
            for i in keep:
                sid, turns = sessions[i]
                msgs = [{"id": f"{sid}:{t}", "role": turn["role"], "content": turn["content"]} for t, turn in enumerate(turns)]
                conv["sessions"].append({"id": sid, "messages": msgs})
                group = [f"{sid}:{t}" for t, turn in enumerate(turns) if turn.get("has_answer")]
                if group:
                    conv["evidence_groups"].append(group)
            out.append(conv)
    with gzip.GzipFile(dst, "wb", mtime=0) as f:
        for c in out:
            f.write((json.dumps(c, ensure_ascii=True) + "\n").encode("ascii"))
    print(f"wrote {len(out)} questions to {dst}", file=sys.stderr)


if __name__ == "__main__":
    main(*sys.argv[1:])
