# Grading Study Logger

A Chrome extension for collecting data in the **human + AI grading study**. The study measures how Teaching Fellows (TFs) work with AI-generated feedback on Gradescope. While a TF grades a problem set, the extension:

- records how long each answer takes, with a pause for stepping away;
- records, with one click per answer, whether the TF kept, edited or didn't use the AI feedback;
- reads the TF's rubric verdict on the AI;
- records the screen.

Grading itself works the same as without the extension.

The AI feedback comes from [`claude-grading-assistant`](https://github.com/rebeccanesson/claude-grading-assistant). Its Gradescope autograder grades each student answer against the instructor's rubric and posts per-criterion feedback under **Autograder Results** before a human looks at it. This repo is the measurement side of that project.

---

## 1. The study

### Questions this tool answers (grader side)

| Research question | What the tool measures |
|---|---|
| **Efficiency:** how long does grading take with AI feedback, and where does the time go? | Active time per answer and per question, time to the first rubric decision, time spent on the AI feedback vs. the rubric vs. the student's work, scrolling |
| **Accuracy:** how often is the AI wrong, and where? | The rubric item the TF applies (autograder correct / correct with comments / made an error, with points), and which AI sections the TF says were wrong |
| **Use of the AI feedback:** what do graders do with it? | Per-answer AI-use button: kept as-is, edited it (grade or feedback changed in any way), or didn't use it. Required before moving on. |
| **Feedback quality:** what do graders add or change? | The TF's comment text next to the AI text, overlap between them, and pastes of AI text. The text is kept for an LLM-as-judge comparison later. |
| **Engagement:** do graders check the AI feedback or just accept it? | Whether *Autograder Results* was opened, time it was on screen, pointer time per AI section, plus the screen recording for qualitative coding |

All results can be grouped **per question**: each answer is tagged with its Gradescope question ID and title (e.g. "3.1: Show reduction"), and a per-question summary file is produced.

Student-side measures (perceived fairness, learning from feedback, surveys) and expert review of human-AI disagreements are collected separately. They are not part of this tool.

### How grading works in the study

1. The instructor builds the rubric with [`claude-grading-assistant`](https://github.com/rebeccanesson/claude-grading-assistant). The autograder runs on every submission.
2. On Gradescope, each answer shows **Autograder Results**: the AI's feedback as numbered sections such as `2.1 — R — Show Reduction to Sorting (0/0)`.
3. The TF checks the AI feedback against the student's work and applies a rubric item recording their verdict:
   - **Autograder score and comments are correct**, or
   - **Autograder score is correct. See below for instructor grader comments.**, or
   - **Autograder made an error. See below for instructor corrections to autograder.** (with a points adjustment).

   The TF adds comments in *Provide Comments Specific To This Submission*.
4. The TF presses an **AI use** button on the study bar (below) and clicks **Next Ungraded**.

### Design notes

- **Every session is human + AI.** To say whether AI makes grading *faster*, the analysis needs a baseline. Options are previous semesters' grading times, human-only grading of comparable questions, or the counterbalanced split discussed in the planning meetings.
- **The grader enters as little as possible.** Anything the page already shows is captured automatically: question, timing, rubric items, comments, AI sections. The bar asks only the one thing the page can't show: what the grader did with the AI.
- **Screen recordings are a backup, not the main data source.** Every measure above comes from the logs, so the videos only need to be watched for qualitative coding or to resolve questions.
- **Works with both Gradescope grading orders:** one question across all students (Next / Next Ungraded), or all questions for one student (the question dropdown). Each student × question pair is one record either way.

---

## 2. What the grader sees and does

### The study bar (top of every Gradescope course page)

A dark bar pinned to the top center of every Gradescope course page, like a screen-share control bar. It can be dragged by its **⋮⋮** handle and remembers its position, size and minimized state.

```
⋮⋮ Grader 3f2a9c1e ● REC │ Q3.1 Show reduction 02:31 Q total 1:12:05 │ AI use? ▸ [Kept as-is] [Edited it] [Didn't use] [Skip ⏭] │ [⏸ Pause] [■ End] [A−][A+][?] [–]
```

Minimized (**–**), it keeps only what's needed to move on and to step away. **⤢** restores the full bar.

```
⋮⋮ ● AI use: [Kept as-is] [Edited it] [Didn't use] [⏸ Pause] [⤢]
```

| Part | What it does |
|---|---|
| **● REC** | Recording state. If the recording isn't running, a **Start recording** button appears here. |
| **Q3.1 Show reduction 02:31** | The question being graded, from Gradescope, and a live timer for this student's answer. The timer counts only while the page is visible, the grader isn't paused, and there has been input in the last 2 minutes. |
| **Q total** | Time on all answers to this question so far. |
| **AI use** | **Kept as-is**: the AI's grade and feedback were left unchanged. **Edited it**: the AI's grade or feedback was changed in any way, including corrections or added comments. **Didn't use**: graded without the AI feedback. Shown in yellow until one is chosen. |
| **Skip ⏭** | Leaves this answer for now, records the skip, and goes to the next ungraded answer. When the grader comes back to it, an AI-use choice is needed again. |
| **⏸ Pause** | Pauses the timer, the logging and the screen recording, and covers the page with a solid "Paused" screen so student work isn't visible while the grader is away. **▶ Resume** continues. |
| **■ End** | Ends the session (click twice to confirm). Saves the video and the log files. |
| **A− / A+** | Make the bar smaller or larger (80%–200%). A larger bar wraps onto a second row, never off the screen. |
| **?** | Opens the tutorial. |

**Timing follows the page; there is nothing to start or stop per question.** On an assignment's question list (or any other non-grading page) the bar reads "Not grading right now. Open a question to grade; timing starts automatically." Opening a question's grading page starts that student × question's timer. Next / Next Ungraded closes it and starts the next one. When Gradescope returns to the question list after the last student, the timer stops. Time spent on the question list is never counted toward any answer.

Before a session starts, the bar shows a **grader ID** field and **Start session** instead. During a session it shows the first characters of the ID ("Grader 3f2a9c1e", full ID on hover), so graders can confirm it is theirs.

### Moving on requires an AI-use answer

A grader can't move to another answer until they've pressed an AI-use button or **Skip**. Three layers enforce this:

1. **Next / Previous / Next Ungraded**, and links to other answers or questions (question dropdown, submission list), are blocked. The bar shakes and explains why.
2. **Any other way off the page** (keyboard shortcut, address bar, closing the tab) triggers Chrome's "Leave site?" prompt.
3. **If the grader leaves anyway**, the next page shows "You left question 7, submission 103 without an AI-use answer" with the three buttons. Next stays blocked until it's answered.

Every answer ends up **answered**, **skipped** (never returned to), or **missing**, and the data records which.

### Tutorial

A two-minute guide (`tutorial.html`) opens automatically when the extension is installed. It can be reopened from the bar's **?** button or the toolbar menu.

### Screen recording: one video per session

1. **Start session** opens a pinned *Study screen recorder* tab. Click **Start recording**, choose **Entire screen**, and click **Share**. Chrome then switches you back to Gradescope.
2. Chrome encodes the screen as WebM at 5 frames per second (about 450 MB per hour).
3. While recording, a new 10-second piece is saved in the browser every 10 seconds, so a crash loses at most about 10 seconds. These pieces are internal and never appear as separate files.
4. **Pause** pauses the same recording. **End session** stops it, joins all pieces into **one `.webm` covering the whole session**, and saves it as `screen-recording.webm` in the session's folder (see §4). Once Chrome confirms the file is written, **the pieces are deleted from the browser**.
5. Every logged event carries `videoSec`, its second in that video, adjusted for breaks. Every visit in `visits.csv` has `video_start_s` and `video_end_s`, so the video can be cut down to particular answers without watching it (see §5).

The only case with more than one video in a session is when sharing is stopped and restarted mid-session, for example by clicking Chrome's "Stop sharing" bar. Each restart becomes its own file (`screen-recording (1).webm`, …).

**If a file seems missing:** first look in the session's folder under `Downloads/grading-study/`. If the recorder tab was closed mid-session, the saved pieces are joined and saved automatically at **End session**. The recorder tab (extension icon → **Open screen recorder**) also lists every recording, with **Save to Downloads** for any not yet saved. Nothing is uploaded anywhere, so graders must upload the folder to the study drive.

---

## 3. Running it

### Install (each grader, once)

1. Get this folder; a zip is fine.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose this folder.
3. Reload any Gradescope tabs that were already open.
4. macOS only: allow Chrome under System Settings → Privacy & Security → Screen Recording.

After you change the code, click **Reload** on the extension card and reload the Gradescope tab.

### Each grading session (grader)

1. Open any Gradescope grading page. In the study bar, paste your **grader ID** and click **Start session**. It's remembered for later sessions.
2. In the recorder tab: **Start recording** → **Entire screen** → **Share**. You're returned to Gradescope.
3. Grade as usual. For each answer: apply the rubric, add comments, press one **AI use** button, then click **Next Ungraded**. Use **Skip** to come back to an answer later.
4. **⏸ Pause** whenever you step away. When you're finished, press **■ End** twice.
5. Upload the new files in `Downloads/grading-study/` to the study drive.

### Issuing grader IDs (research team)

Every grader needs an ID before their first session. The ID is attached to every logged event, every CSV row (`grader_id`) and every file name, so all of a grader's work can be traced to them across sessions and computers.

1. Generate one ID per grader, for example with `python3 -c "import uuid; print(uuid.uuid4())"`.
2. Record the ID → grader name key in a separate, access-controlled file. It is never needed by the extension.
3. Send each grader their ID. They paste it into the study bar once; it's remembered after that.
4. Optional: list the issued IDs in `GRADER_IDS` in `config.js` before distributing the extension. Any other ID, including typos, is then rejected. Without the list, any correctly formatted UUID is accepted.

For trying the extension out, use the test ID `00000000-0000-4000-8000-000000000001`. Drop rows with that `grader_id`, and files named `grader-00000000-…`, before analysis.

### Before the pilot (research team)

1. On a real grading page with AI feedback, **expand Autograder Results**. Then in the extension menu open **Calibrate page regions** → **Check current page**. It should show:
   - the question (e.g. `3.1: Show reduction`);
   - the AI sections (e.g. `1:R, 2.1:R, 2.2:R-`);
   - each rubric item with its points, its verdict category, and whether it is **APPLIED** or off.

   If a rubric item shows **state unreadable**, verdicts fall back to replaying clicks. That fallback is correct for first-time grading but not for reopened answers. Send a page sample, and `appliedState()` in `content.js` can be adapted. If a rubric item has **no verdict category**, adjust `RUBRIC_VERDICTS` in `config.js`.
2. Grade 5–10 mock submissions. Then compare `answers.csv` against the recording for timing, rubric verdicts and AI-use answers.

---

### Troubleshooting

| Problem | Fix |
|---|---|
| No study bar on Gradescope | Reload the Gradescope tab after installing or reloading the extension; pages opened earlier don't have the study script. The bar appears on course pages (`gradescope.com/courses/…`) only. |
| Still no bar | Open the extension menu → **Calibrate page regions** → **Check current page**. The first line shows the extension version and whether the study bar is showing. If the script failed on the page, the last error is shown at the end; send it to the study team. |
| Not sure which version is loaded | The version is next to the title in the extension menu. After pulling a new version, click **Reload** on the extension card in `chrome://extensions`. |
| Stuck on the recorder tab after sharing | Click your Gradescope tab. The recorder normally switches back automatically. |

## 4. Data collected

### What each session saves

When a grader presses **■ End**, everything from that session is saved together in one folder. The folder is named with the grader ID and the session's local start time:

```
Downloads/grading-study/
└── grader-3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c/
    ├── 2026-11-04_14-02-11/        ← Monday's session
    │   ├── screen-recording.webm
    │   ├── visits.csv
    │   ├── answers.csv
    │   ├── questions.csv
    │   └── events.json
    └── 2026-11-05_09-30-48/        ← Tuesday's session
        └── … same five files
```

| File | Contents |
|---|---|
| `screen-recording.webm` | The session's screen recording, with pauses cut out. It plays in Chrome or VLC. To make it seekable elsewhere, run `ffmpeg -i in.webm -c copy out.webm`. |
| `visits.csv` | **One row per visit**: each continuous stretch one student × question was open. It has the clock start and end (`started_at`, `ended_at`), where that falls in the video (`video_file`, `video_start_s`, `video_end_s`), `active_s`, `wall_s`, `paused_s`, the AI-use choice at the end of the visit, and how it ended (`navigate: Next Ungraded`, `skip`, `left page another way`, `session_end`, …). |
| `answers.csv` | **One row per student × question** in this session, with every measure below |
| `questions.csv` | **One row per question** in this session: answers opened, answered, skipped and missing; total active time and wall time; mean and median time per answer; AI-use shares (kept / edited / didn't use); rubric verdict shares |
| `events.json` | Every raw event of this session with a timestamp and `videoSec`. This is the source of truth; the CSVs are recomputed from it by `summary.js`. |

**Coming back another day starts a new session and a new folder.** Earlier folders are never changed, and each folder holds only its own session. An answer that was skipped on Monday and finished on Tuesday has a visit in each folder. `tools/combine_sessions.py` (§5) merges them into one row.

### `answers.csv` columns

| Group | Column | Meaning |
|---|---|---|
| Identity | `grader_id`, `session_id`, `question_number`, `question_title`, `question_id`, `submission_id`, `course_id`, `assignment_id`, `answer_key`, `first_opened`, `visits` | Which answer; `visits` > 1 means the grader came back to it |
| Efficiency | `active_s` | Seconds actively on this answer, summed over all its visits (see `visits.csv` for each visit): tab visible, input in the last 2 minutes, not paused |
| | `time_on_page_s` | Wall-clock seconds the answer was open |
| | `time_to_rubric_s` | Seconds from opening the answer to the first rubric action |
| AI output | `ai_sections_found`, `ai_section_count`, `ai_marks`, `ai_needs_review` | AI sections recognized and the band per section (`1:R;2.1:R;2.2:R-`). Recognized once *Autograder Results* has been expanded on that answer. |
| | `ai_results_opened` | Times the grader expanded *Autograder Results* |
| Rubric verdict | `rubric_verdict` | `ai_correct`, `ai_correct_with_comments`, `ai_error`, `other` (an applied item with no verdict category), or `none` |
| | `rubric_items_applied`, `rubric_points` | Exact text and points of every applied rubric item |
| | `rubric_source`, `rubric_actions` | `page` (read from the rubric) or `clicks` (fallback); number of rubric clicks and number-key presses |
| AI use | `ai_use` | `kept`, `edited`, `not_used`, or blank |
| | `ai_use_late` | 1 if it was answered from the "you left … without an answer" prompt on a later page |
| | `status` | `answered` (AI use recorded), `skipped` (only ever skipped), or `missing` |
| | `skips`, `nav_blocked`, `leave_prompts` | Times the answer was skipped; times moving on was blocked; times Chrome's "Leave site?" prompt appeared |
| Grader feedback | `comment_chars`, `comment_ai_overlap` | Length of the grader's comment, and the share of its word trigrams found in the AI text (0–1) |
| | `comment_pastes`, `comment_pastes_from_ai` | Pastes into the comment, and how many were AI text |
| Engagement | `ai_visible_s` | Seconds the expanded AI feedback was on screen while the grader was active |
| | `hover_ai_panel_s`, `hover_rubric_s`, `hover_submission_s`, `comment_focus_s`, `scroll_px` | Pointer and typing time per page component. The submission area needs a calibrated selector. |
| | `ai_section_hover_s`, `ai_section_clicks`, `ai_copies` | Per-section pointer seconds (`2.1:8.5;2.2:3`), clicks, and copies from AI text |
| | `markers` | "Mark moment" notes added from the extension menu |

The full comment text and AI text are kept in the `comment_snapshot` events of the events file, for the LLM-as-judge analysis.

### Event types (events.json)

`session_started` / `session_ended` / `paused` / `resumed` · `page_changed` (answer opened) · `question_info` · `visibility` · `idle_state` · `ai_feedback_present` (sections + marks) · `ai_results_toggle` · `rubric_action` · `ai_use` · `skip` · `nav_blocked` · `leave_prompt` · `answer_missed` · `navigate` (Next / Previous / answer links) · `comment_snapshot` (applied rubric items, comment text, AI text, overlap) · `comment_paste` · `attention` (15-second aggregates) · `ai_interaction` (section click / copy) · `marker` · `recording_started` / `recording_paused` / `recording_resumed` / `recording_stopped`

---

## 5. After collecting: combine sessions and cut clips

Collect every grader's `grading-study/` folders into one place, keeping the `grader-<ID>/<session>/` structure; for example, everything uploaded to the study drive. The two scripts in `tools/` need only Python 3. Cutting clips also needs [ffmpeg](https://ffmpeg.org/download.html) installed.

**1. Combine all sessions and graders**

```bash
python3 tools/combine_sessions.py path/to/grading-study
```

Writes `path/to/grading-study/combined/`:

| File | Contents |
|---|---|
| `all_visits.csv` | Every visit from every session and grader, with `session_folder`, `video_path` and `overall_visit` (1st, 2nd, … visit to that answer across all sessions) |
| `all_answers.csv` | One row per grader × student × question, **merged across sessions**: number of sessions and visits, first start and last end time, total `active_s` / `wall_s` / `paused_s`, final AI use, status, rubric verdict |
| `all_questions.csv` | One row per question across all graders (`scope = all graders`) and one per grader × question: answers, answered / skipped / missing, total, mean and median active time, AI-use and rubric shares |

**2. Cut the videos down to the answers where the AI was used**

```bash
python3 tools/cut_clips.py path/to/grading-study                 # answers marked "Kept as-is" or "Edited it"
python3 tools/cut_clips.py path/to/grading-study --uses edited   # only answers where the AI was edited
python3 tools/cut_clips.py path/to/grading-study --dry-run       # list the ffmpeg commands only
```

For each visit to a matching answer, the script cuts that stretch out of the session's recording, with 2 seconds of context on each side (`--pad`). It writes `clips/grader-<ID>/Q<question>_sub<submission>_visit<N>.mp4` plus `clips/clips_index.csv`, which lists each clip with its grader, question, submission, AI use, clock times and position in the source video. Coders review only those clips instead of whole sessions.

## 6. Configuration (`config.js`)

| Setting | Purpose |
|---|---|
| `AI_RESULTS_HEADING`, `AI_SECTION_PATTERN`, `AI_BAND_PATTERN`, `AI_NEEDS_REVIEW_PATTERN` | How the AI feedback is recognized; matches `grade.py` test names in [`claude-grading-assistant`](https://github.com/rebeccanesson/claude-grading-assistant) |
| `QUESTION_TITLE_PATTERN` | How the Gradescope question title ("3.1: Show reduction") is recognized |
| `RUBRIC_VERDICTS` | Text patterns that put each rubric item into `ai_error` / `ai_correct_with_comments` / `ai_correct` |
| `GRADER_ID_PATTERN`, `GRADER_IDS` | Grader ID format (UUID by default) and optional list of issued IDs |
| `USAGE_OPTIONS` | The AI-use buttons on the study bar |
| `REGIONS` | Optional selectors for the rubric and student-submission areas. These can also be set from the extension menu with **Pick**. |

The idle threshold (120 s) is `IDLE_SECONDS` in `background.js` and `ATTENTION_IDLE_MS` in `content.js`.

## 7. Privacy, IRB and deployment

- Screen recordings and comment/AI text contain student work and any names on screen. These are FERPA-protected education records. The consent forms (TFs, and students per the protocol) should name screen recording and comment-text capture. The protocol should state where files are uploaded, who can view them, and how long they are kept.
- Graders are identified only by their grader ID, and answers only by Gradescope IDs, never by names. Keep the grader ID → name key separate from the data.
- Graders should close unrelated windows before sharing the screen. If the protocol prefers, they can share just the Chrome window; the `surface` field in `recording_started` records which they chose.
- Everything stays on the grader's computer until they upload it. Automatic upload to approved storage (for example Harvard OneDrive or a research server) would need HUIT/IRB approval and is not built yet.
- For more than a few graders, distribute through Harvard-managed Chrome policy or an unlisted Chrome Web Store listing rather than Developer mode.

## 8. Known limits

- Tested end to end in Chromium against a mock page modeled on the real Gradescope screens. Screen capture was simulated in that test. Run the pilot steps in §3 on the live site first.
- Rubric applied/not-applied state is read from the page's accessibility attributes or classes. Confirm it with **Check current page**.
- Chrome only, `gradescope.com` only. The recorder tab must stay open while recording; it warns before closing.

## Files

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (Chrome MV3) |
| `config.js` | Study-specific settings (§6) |
| `content.js` | Runs on Gradescope: the study bar, the move-on guard, page reading, logging, calibration |
| `background.js` | Single writer for the event log; session state; idle detection; opens the recorder |
| `recorder.html` / `recorder.js` | Screen recording; joins it into one video; saves video and log files at session end |
| `summary.js` | Builds `visits.csv`, `answers.csv`, `questions.csv` and video offsets from the events, and saves the session's files |
| `tools/combine_sessions.py` | Merges all graders' session folders into study-wide tables |
| `tools/cut_clips.py` | Cuts recordings down to the answers where the AI was used |
| `tutorial.html` | Two-minute guide for graders; opens on install and from the bar's **?** |
| `popup.html` / `popup.js` / `popup.css` | Toolbar menu: session controls, tutorial link, calibration, manual export |
