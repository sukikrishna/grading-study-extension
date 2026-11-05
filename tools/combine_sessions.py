#!/usr/bin/env python3
"""Combine every grader's session folders into study-wide tables.

Each grading session is saved as Downloads/grading-study/grader-<ID>/<date>_<time>/ with
visits.csv, answers.csv, questions.csv, events.json and screen-recording.webm. Collect those
folders into one directory (keeping the grader-<ID>/<session>/ structure) and run:

    python3 tools/combine_sessions.py path/to/grading-study [--out path/to/combined]

Writes to <out> (default: <root>/combined):
  all_visits.csv     every visit from every session, plus session_folder, video_path and
                     overall_visit (1st, 2nd, ... visit to that answer across all sessions)
  all_answers.csv    one row per grader x answer (student x question), merged across sessions,
                     so an answer started one day and finished the next is a single row
  all_questions.csv  one row per question across all graders, and one per grader x question
"""
import argparse
import csv
import statistics
from collections import defaultdict
from pathlib import Path

USES = ["kept", "edited", "not_used"]


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        if not rows:
            return
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def session_folders(root):
    return sorted({p.parent for p in root.rglob("visits.csv") if "combined" not in p.parts})


def video_path(root, folder, name):
    """The session's video: the file named in visits.csv, or the folder's only .webm if it was renamed."""
    if not name:
        return ""
    if (folder / name).exists():
        return str((folder / name).relative_to(root))
    videos = list(folder.glob("*.webm"))
    return str(videos[0].relative_to(root)) if len(videos) == 1 else ""


def load_visits(root):
    visits = []
    for folder in session_folders(root):
        for row in read_csv(folder / "visits.csv"):
            row["session_folder"] = str(folder.relative_to(root))
            row["video_path"] = video_path(root, folder, row.get("video_file"))
            visits.append(row)
    visits.sort(key=lambda v: (v["grader_id"], v["started_at"]))
    # visit_number counts within one session; overall_visit counts across all of a grader's sessions.
    seen = defaultdict(int)
    for v in visits:
        seen[(v["grader_id"], v["answer_key"])] += 1
        v["overall_visit"] = seen[(v["grader_id"], v["answer_key"])]
    return visits


def load_session_answers(root):
    """Latest answers.csv row per grader x answer, for the per-session page readings (rubric etc.)."""
    latest = {}
    for folder in session_folders(root):
        path = folder / "answers.csv"
        if not path.exists():
            continue
        for row in read_csv(path):
            key = (row["grader_id"], row["answer_key"])
            if row.get("rubric_verdict") not in ("", "none") or key not in latest:
                latest[key] = row
    return latest


def combine_answers(visits, session_answers):
    groups = defaultdict(list)
    for v in visits:
        groups[(v["grader_id"], v["answer_key"])].append(v)
    rows = []
    for (grader, key), vs in groups.items():
        vs.sort(key=lambda v: v["started_at"])
        uses = [v["ai_use_at_end"] for v in vs if v.get("ai_use_at_end")]
        final_use = uses[-1] if uses else ""
        skipped = any(v.get("ended_by") == "skip" for v in vs)
        extra = session_answers.get((grader, key), {})
        rows.append({
            "grader_id": grader,
            "question_id": vs[0]["question_id"],
            "question_number": next((v["question_number"] for v in vs if v["question_number"]), ""),
            "question_title": next((v["question_title"] for v in vs if v["question_title"]), ""),
            "submission_id": vs[0]["submission_id"],
            "answer_key": key,
            "sessions": len({v["session_id"] for v in vs}),
            "visits": len(vs),
            "first_started_at": vs[0]["started_at"],
            "last_ended_at": vs[-1]["ended_at"],
            "active_s": round(sum(num(v["active_s"]) for v in vs), 1),
            "wall_s": round(sum(num(v["wall_s"]) for v in vs), 1),
            "paused_s": round(sum(num(v["paused_s"]) for v in vs), 1),
            "ai_use": final_use,
            "status": "answered" if final_use else "skipped" if skipped else "missing",
            "rubric_verdict": extra.get("rubric_verdict", ""),
            "rubric_points": extra.get("rubric_points", ""),
            "comment_chars": extra.get("comment_chars", ""),
            "comment_ai_overlap": extra.get("comment_ai_overlap", ""),
            "ai_results_opened": extra.get("ai_results_opened", ""),
        })
    return sorted(rows, key=lambda r: (r["grader_id"], r["question_number"], r["first_started_at"]))


def question_row(scope, rows):
    answered = [r for r in rows if r["status"] == "answered"]
    active = [r["active_s"] for r in answered]

    def share(test, pool=answered):
        return round(sum(1 for r in pool if test(r)) / len(pool), 3) if pool else ""

    return {
        "scope": scope,
        "question_id": rows[0]["question_id"],
        "question_number": next((r["question_number"] for r in rows if r["question_number"]), ""),
        "question_title": next((r["question_title"] for r in rows if r["question_title"]), ""),
        "graders": len({r["grader_id"] for r in rows}),
        "answers": len(rows),
        "answered": len(answered),
        "skipped_unfinished": sum(1 for r in rows if r["status"] == "skipped"),
        "missing": sum(1 for r in rows if r["status"] == "missing"),
        "total_active_s": round(sum(r["active_s"] for r in rows), 1),
        "mean_active_s_per_answer": round(statistics.mean(active), 1) if active else "",
        "median_active_s_per_answer": round(statistics.median(active), 1) if active else "",
        **{f"share_ai_{u}": share(lambda r, u=u: r["ai_use"] == u) for u in USES},
        "share_rubric_ai_error": share(lambda r: r["rubric_verdict"] == "ai_error"),
        "share_rubric_ai_correct": share(lambda r: r["rubric_verdict"].startswith("ai_correct")),
    }


def combine_questions(answers):
    by_question, by_grader = defaultdict(list), defaultdict(list)
    for r in answers:
        by_question[r["question_id"]].append(r)
        by_grader[(r["grader_id"], r["question_id"])].append(r)
    rows = [question_row("all graders", rs) for rs in by_question.values()]
    rows += [question_row(f"grader {grader}", rs) for (grader, _), rs in by_grader.items()]
    return sorted(rows, key=lambda r: (str(r["question_number"]), r["scope"] != "all graders", r["scope"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", type=Path, help="folder containing grader-<ID>/<session>/ folders")
    parser.add_argument("--out", type=Path, help="output folder (default: <root>/combined)")
    args = parser.parse_args()
    out = args.out or args.root / "combined"

    visits = load_visits(args.root)
    if not visits:
        raise SystemExit(f"No visits.csv files found under {args.root}")
    answers = combine_answers(visits, load_session_answers(args.root))
    write_csv(out / "all_visits.csv", visits)
    write_csv(out / "all_answers.csv", answers)
    write_csv(out / "all_questions.csv", combine_questions(answers))
    print(f"{len(session_folders(args.root))} sessions, {len(visits)} visits, {len(answers)} answers -> {out}")


if __name__ == "__main__":
    main()
