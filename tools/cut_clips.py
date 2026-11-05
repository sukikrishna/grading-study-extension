#!/usr/bin/env python3
"""Cut the screen recordings down to the answers where the grader used the AI feedback.

Reads combined/all_visits.csv (from tools/combine_sessions.py) and, for every visit to an answer
whose final AI-use choice is in --uses, cuts that stretch out of the session's recording with
ffmpeg. Coders then review only those clips instead of whole sessions.

    python3 tools/cut_clips.py path/to/grading-study [--uses kept,edited] [--pad 2] [--dry-run]

Writes <root>/clips/<grader>/Q<question>_sub<submission>_visit<N>.mp4 and clips_index.csv, which
lists each clip with its grader, question, submission, AI use and source timestamps.
Requires ffmpeg on the PATH (https://ffmpeg.org/download.html); --dry-run only prints commands.
"""
import argparse
import csv
import shutil
import subprocess
from pathlib import Path


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def final_uses(visits):
    """Final AI-use choice per grader x answer (the last one given, across sessions)."""
    final = {}
    for v in sorted(visits, key=lambda v: v["started_at"]):
        if v.get("ai_use_at_end"):
            final[(v["grader_id"], v["answer_key"])] = v["ai_use_at_end"]
    return final


def safe(text):
    return "".join(c if c.isalnum() or c in "-._" else "_" for c in str(text))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", type=Path, help="folder containing grader-<ID>/<session>/ folders and combined/")
    parser.add_argument("--uses", default="kept,edited", help="AI-use choices to keep (default: kept,edited)")
    parser.add_argument("--pad", type=float, default=2.0, help="seconds of context before and after each visit")
    parser.add_argument("--out", type=Path, help="output folder (default: <root>/clips)")
    parser.add_argument("--dry-run", action="store_true", help="print the ffmpeg commands without running them")
    args = parser.parse_args()

    visits_path = args.root / "combined" / "all_visits.csv"
    if not visits_path.exists():
        raise SystemExit(f"{visits_path} not found; run tools/combine_sessions.py {args.root} first")
    with open(visits_path, newline="", encoding="utf-8") as f:
        visits = list(csv.DictReader(f))
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg and not args.dry_run:
        raise SystemExit("ffmpeg not found on PATH; install it or use --dry-run")

    wanted = {u.strip() for u in args.uses.split(",") if u.strip()}
    final = final_uses(visits)
    out = args.out or args.root / "clips"
    index, skipped = [], 0
    for v in visits:
        use = final.get((v["grader_id"], v["answer_key"]), "")
        if use not in wanted:
            continue
        start, end = num(v.get("video_start_s")), num(v.get("video_end_s"))
        video = args.root / v["video_path"] if v.get("video_path") else None
        if start is None or end is None or end <= start or not video or not video.exists():
            skipped += 1
            continue
        clip_start = max(0.0, start - args.pad)
        duration = end - start + 2 * args.pad
        clip = out / f"grader-{safe(v['grader_id'])[:8]}" / f"Q{safe(v['question_number'] or v['question_id'])}_sub{safe(v['submission_id'])}_visit{v.get('overall_visit') or v['visit_number']}.mp4"
        cmd = [ffmpeg or "ffmpeg", "-y", "-loglevel", "error", "-ss", f"{clip_start:.1f}", "-i", str(video), "-t", f"{duration:.1f}",
               "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", str(clip)]
        if args.dry_run:
            print(" ".join(cmd))
        else:
            clip.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(cmd, check=True)
        index.append({
            "clip": str(clip.relative_to(out)), "grader_id": v["grader_id"], "question_number": v["question_number"],
            "question_title": v["question_title"], "submission_id": v["submission_id"], "visit": v.get("overall_visit") or v["visit_number"],
            "ai_use": use, "started_at": v["started_at"], "ended_at": v["ended_at"],
            "source_video": v["video_path"], "source_start_s": round(clip_start, 1), "clip_length_s": round(duration, 1),
        })

    if index and not args.dry_run:
        with open(out / "clips_index.csv", "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(index[0].keys()))
            writer.writeheader()
            writer.writerows(index)
    print(f"{len(index)} clips{' (dry run)' if args.dry_run else f' -> {out}'}; {skipped} matching visits had no usable video")


if __name__ == "__main__":
    main()
