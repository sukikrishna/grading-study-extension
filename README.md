# Grading Study Logger

A Chrome extension for collecting data in the **human + AI grading study**. The study measures how Teaching Fellows (TFs) work with AI-generated feedback on Gradescope. While a TF grades a problem set, the extension:

- records how long each answer takes;
- reads the TF's rubric verdict on the AI;
- asks one or two quick check-in questions per answer in a small box on the page;
- records the screen.

Grading itself works the same as without the extension.

The AI feedback comes from [`claude-grading-assistant`](../claude-grading-assistant). Its Gradescope autograder grades each student answer against the instructor's rubric and posts per-criterion feedback under **Autograder Results** before a human looks at it. This repo is the measurement side of that project.

---

## 1. The study

### Questions this tool answers (grader side)

| Research question | What the tool measures |
|---|---|
| **Efficiency:** how long does grading take with AI feedback, and where does the time go? | Active time per answer and per question, time to the first rubric decision, time spent on the AI feedback vs. the rubric vs. the student's work, scrolling |
| **Accuracy:** how often is the AI wrong, and where? | The rubric item the TF applies (autograder correct / correct with comments / made an error, with points), and which AI sections the TF says were wrong |
| **Use of the AI feedback:** what do graders do with it? | Per-answer check-in: accepted as-is, accepted and added comments, corrected the AI, or graded without it |
| **Feedback quality:** what do graders add or change? | The TF's comment text next to the AI text, overlap between them, and pastes of AI text. The text is kept for an LLM-as-judge comparison later. |
| **Perceived usefulness:** was the AI feedback helpful? | Per-answer "helpful? yes / somewhat / no" |
| **Engagement:** do graders check the AI feedback or just accept it? | Whether *Autograder Results* was opened, time it was on screen, pointer time per AI section, plus the screen recording for qualitative coding |

All results can be grouped **per question**: each answer is tagged with its Gradescope question ID and title (e.g. "3.1: Show reduction"), and a per-question summary file is produced.

Student-side measures (perceived fairness, learning from feedback, surveys) and expert review of human-AI disagreements are collected separately. They are not part of this tool.

### How grading works in the study

1. The instructor builds the rubric with `claude-grading-assistant`. The autograder runs on every submission.
2. On Gradescope, each answer shows **Autograder Results**: the AI's feedback as numbered sections such as `2.1 — R — Show Reduction to Sorting (0/0)`.
3. The TF checks the AI feedback against the student's work and applies a rubric item recording their verdict:
   - **Autograder score and comments are correct**, or
   - **Autograder score is correct. See below for instructor grader comments.**, or
   - **Autograder made an error. See below for instructor corrections to autograder.** (with a points adjustment).

   The TF adds comments in *Provide Comments Specific To This Submission*.
4. The TF taps the study box (below) and clicks **Next Ungraded**.

### Design notes

- **Every session is human + AI.** To say whether AI makes grading *faster*, the analysis needs a baseline. Options are previous semesters' grading times, human-only grading of comparable questions, or the counterbalanced split discussed in the planning meetings.
- **The grader enters as little as possible.** Anything the page already shows is captured automatically: question, timing, rubric items, comments, AI sections. The box asks only what the page can't show.

---

## 2. What the grader sees and does

### The study box (on every Gradescope grading page)

A small box docked at the bottom-left of the grading page. It can be dragged anywhere and minimized with **–**, and it remembers where it was left. The toolbar icon is not needed while grading.

**Before a session:** a participant-code field and **Start session**.

**During a session**, for the answer on screen:

```
● Q3.1: Show reduction                     2 left  –
┌──────────────────────────────────────────────────┐
│ Rubric: autograder made an error.                │   ← read from the rubric automatically
└──────────────────────────────────────────────────┘
What did you do with the AI feedback?
 [Accepted as-is] [Accepted + added comments] [Corrected the AI] [Graded without it]
Which AI sections were wrong?        (only after "Corrected the AI")
 [1] [2.1] [2.2] [Other]
Was the AI feedback helpful for grading this answer?
 [Yes] [Somewhat] [No]
● Recording                    [Take a break] [End session]
```

- **Title:** the question number and name, read from Gradescope.
- **Rubric line:** shows which verdict item is applied, as a reminder. The grader never enters it twice.
- **Quick buttons:** one tap for usage and one for helpfulness. After "Corrected the AI", tap the sections that were wrong. Taps can be undone by tapping again.
- **Nudge on Next:** if a question is unanswered, the first click on Next / Next Ungraded is held and the box pulses. A second click always goes through, and the skip is recorded. To turn this off, set `CHECKIN.nudgeOnNext = false` in `config.js`.
- **Take a break** pauses logging and the recording. **End session** (click twice to confirm) stops everything and saves the files.

Typical cost: **two taps per answer**, three or four when the AI was wrong.

### Screen recording: one video per session

1. **Start session** opens a pinned *Study screen recorder* tab. Click **Start recording**, choose **Entire screen**, and click **Share**. Chrome then switches you back to Gradescope.
2. Chrome encodes the screen as WebM at 5 frames per second (about 450 MB per hour).
3. While recording, a new 10-second piece is saved in the browser every 10 seconds, so a crash loses at most about 10 seconds. These pieces are internal and never appear as separate files.
4. Breaks pause the same recording. **End session** stops it, joins all pieces into **one `.webm` covering the whole session**, and saves it to `Downloads/grading-study/`. Once Chrome confirms the file is written, **the pieces are deleted from the browser**.
5. Every logged event carries `videoSec`, its second in that video, adjusted for breaks. A coder can jump from any row of data to the matching moment.

The only case with more than one video is when sharing is stopped and restarted mid-session, for example by clicking Chrome's "Stop sharing" bar. Each restart becomes its own file.

**If a file seems missing:** first look in `Downloads/grading-study/`. If the recorder tab was closed mid-session, the saved pieces are joined and saved automatically at **End session**. The recorder tab (extension icon → **Open screen recorder**) also lists every recording, with **Save to Downloads** for any not yet saved. Nothing is uploaded anywhere, so graders must upload the folder to the study drive.

---

## 3. Running it

### Install (each grader, once)

1. Get this folder; a zip is fine.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose this folder.
3. Reload any Gradescope tabs that were already open.
4. macOS only: allow Chrome under System Settings → Privacy & Security → Screen Recording.

After you change the code, click **Reload** on the extension card and reload the Gradescope tab.

### Each grading session (grader)

1. Open any Gradescope grading page. In the study box, enter your participant code and click **Start session**.
2. In the recorder tab: **Start recording** → **Entire screen** → **Share**. You're returned to Gradescope.
3. Grade as usual. For each answer:
   - apply the rubric verdict;
   - add comments as needed;
   - tap the box's buttons;
   - click **Next Ungraded**.
4. **Take a break** for breaks. When you're finished, click **End session** twice.
5. Upload the new files in `Downloads/grading-study/` to the study drive.

### Before the pilot (research team)

1. On a real grading page with AI feedback, **expand Autograder Results**. Then in the extension menu open **Calibrate page regions** → **Check current page**. It should show:
   - the question (e.g. `3.1: Show reduction`);
   - the AI sections (e.g. `1:R, 2.1:R, 2.2:R-`);
   - each rubric item with its points, its verdict category, and whether it is **APPLIED** or off.

   If a rubric item shows **state unreadable**, verdicts fall back to replaying clicks. That fallback is correct for first-time grading but not for reopened answers. Send a page sample, and `appliedState()` in `content.js` can be adapted. If a rubric item has **no verdict category**, adjust `RUBRIC_VERDICTS` in `config.js`.
2. Grade 5–10 mock submissions. Then compare `answers.csv` against the recording for timing, rubric verdicts and check-in answers.

---

## 4. Data collected

### Files saved to `Downloads/grading-study/` at the end of each session

| File | Contents |
|---|---|
| `<participant>-<time>-questions.csv` | **One row per question**: number of answers, total, mean and median active time, share of answers where the AI was correct or wrong, usage and helpfulness shares, check-in completion |
| `<participant>-<time>-answers.csv` | **One row per answer** (question × submission) with every measure below |
| `<participant>-<time>-events.json` | Every raw event with a timestamp and `videoSec`. This is the source of truth; both CSVs are recomputed from it by `summary.js`. |
| `<participant>-<time>-screen.webm` | The session's screen recording. It plays in Chrome or VLC. To make it seekable elsewhere, run `ffmpeg -i in.webm -c copy out.webm`. |

### `answers.csv` columns

| Group | Column | Meaning |
|---|---|---|
| Identity | `session_id`, `participant`, `question_number`, `question_title`, `question_id`, `submission_id`, `course_id`, `assignment_id`, `answer_key`, `first_opened`, `visits` | Which answer; `visits` > 1 means the grader came back to it |
| Efficiency | `active_s` | Seconds actively on this answer: tab visible, input in the last 2 minutes, not on a break |
| | `time_on_page_s` | Wall-clock seconds the answer was open |
| | `time_to_rubric_s` | Seconds from opening the answer to the first rubric action |
| AI output | `ai_sections_found`, `ai_section_count`, `ai_marks`, `ai_needs_review` | AI sections recognized and the band per section (`1:R;2.1:R;2.2:R-`). Recognized once *Autograder Results* has been expanded on that answer. |
| | `ai_results_opened` | Times the grader expanded *Autograder Results* |
| Rubric verdict | `rubric_verdict` | `ai_correct`, `ai_correct_with_comments`, `ai_error`, `other` (an applied item with no verdict category), or `none` |
| | `rubric_items_applied`, `rubric_points` | Exact text and points of every applied rubric item |
| | `rubric_source`, `rubric_actions` | `page` (read from the rubric) or `clicks` (fallback); number of rubric clicks and number-key presses |
| Check-in | `usage` | `accepted`, `accepted_added`, `corrected`, `not_used`, or blank |
| | `wrong_sections` | AI sections the grader flagged as wrong (`2.1;Other`) |
| | `helpful` | `yes` / `somewhat` / `no` / blank |
| | `checkin_complete`, `checkin_nudged`, `left_with_missing` | Whether both questions were answered; times the Next nudge fired; what was unanswered on leaving |
| Grader feedback | `comment_chars`, `comment_ai_overlap` | Length of the grader's comment, and the share of its word trigrams found in the AI text (0–1) |
| | `comment_pastes`, `comment_pastes_from_ai` | Pastes into the comment, and how many were AI text |
| Engagement | `ai_visible_s` | Seconds the expanded AI feedback was on screen while the grader was active |
| | `hover_ai_panel_s`, `hover_rubric_s`, `hover_submission_s`, `comment_focus_s`, `scroll_px` | Pointer and typing time per page component. The submission area needs a calibrated selector. |
| | `ai_section_hover_s`, `ai_section_clicks`, `ai_copies` | Per-section pointer seconds (`2.1:8.5;2.2:3`), clicks, and copies from AI text |
| | `markers` | "Mark moment" notes added from the extension menu |

The full comment text and AI text are kept in the `comment_snapshot` events of the events file, for the LLM-as-judge analysis.

### Event types (events.json)

`session_started` / `session_ended` / `paused` / `resumed` · `page_changed` (answer opened) · `question_info` · `visibility` · `idle_state` · `ai_feedback_present` (sections + marks) · `ai_results_toggle` · `rubric_action` · `checkin` / `checkin_nudge` · `navigate` (Next / Previous clicked) · `comment_snapshot` (applied rubric items, comment text, AI text, overlap) · `comment_paste` · `attention` (15-second aggregates) · `ai_interaction` (section click / copy) · `marker` · `recording_started` / `recording_paused` / `recording_resumed` / `recording_stopped`

---

## 5. Configuration (`config.js`)

| Setting | Purpose |
|---|---|
| `AI_RESULTS_HEADING`, `AI_SECTION_PATTERN`, `AI_BAND_PATTERN`, `AI_NEEDS_REVIEW_PATTERN` | How the AI feedback is recognized; matches `grade.py` test names in `claude-grading-assistant` |
| `QUESTION_TITLE_PATTERN` | How the Gradescope question title ("3.1: Show reduction") is recognized |
| `RUBRIC_VERDICTS` | Text patterns that put each rubric item into `ai_error` / `ai_correct_with_comments` / `ai_correct` |
| `USAGE_OPTIONS` | The "What did you do with the AI feedback?" buttons |
| `CHECKIN.nudgeOnNext`, `CHECKIN.askWrongSections` | Hold the first Next when the check-in is unfinished; ask which sections were wrong after "Corrected the AI" |
| `REGIONS` | Optional selectors for the rubric and student-submission areas. These can also be set from the extension menu with **Pick**. |

The idle threshold (120 s) is `IDLE_SECONDS` in `background.js` and `ATTENTION_IDLE_MS` in `content.js`.

## 6. Privacy, IRB and deployment

- Screen recordings and comment/AI text contain student work and any names on screen. These are FERPA-protected education records. The consent forms (TFs, and students per the protocol) should name screen recording and comment-text capture. The protocol should state where files are uploaded, who can view them, and how long they are kept.
- Event logs identify answers by Gradescope IDs, not names. Keep the participant-code key separate from the data.
- Graders should close unrelated windows before sharing the screen. If the protocol prefers, they can share just the Chrome window; the `surface` field in `recording_started` records which they chose.
- Everything stays on the grader's computer until they upload it. Automatic upload to approved storage (for example Harvard OneDrive or a research server) would need HUIT/IRB approval and is not built yet.
- For more than a few graders, distribute through Harvard-managed Chrome policy or an unlisted Chrome Web Store listing rather than Developer mode.

## 7. Known limits

- Tested end to end in Chromium against a mock page modeled on the real Gradescope screens. Screen capture was simulated in that test. Run the pilot steps in §3 on the live site first.
- Rubric applied/not-applied state is read from the page's accessibility attributes or classes. Confirm it with **Check current page**.
- Chrome only, `www.gradescope.com` only. The recorder tab must stay open while recording; it warns before closing.

## Files

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (Chrome MV3) |
| `config.js` | Study-specific settings (§5) |
| `content.js` | Runs on Gradescope: the study box, page reading, logging, calibration |
| `background.js` | Single writer for the event log; session state; idle detection; opens the recorder |
| `recorder.html` / `recorder.js` | Screen recording; joins it into one video; saves video and log files at session end |
| `summary.js` | Builds `answers.csv`, `questions.csv` and video offsets from the events |
| `popup.html` / `popup.js` / `popup.css` | Toolbar menu: session controls, calibration, manual export |
