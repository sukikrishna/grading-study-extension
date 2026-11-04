// AI feedback comes from the claude-grading-assistant Gradescope autograder (tests[] in
// results.json), shown on the grading page under "Autograder Results". Each test header renders
// as "<question> — <criterion> (<score>/<max>)", where the criterion usually begins with the AI's
// band, e.g. "2.1 — R — Show Reduction to Sorting (0/0)". Ungradable questions render as
// "<label> — needs human review (0/5)".
const AI_RESULTS_HEADING = /^\s*Autograder Results\s*$/i;
const AI_SECTION_PATTERN = /^\s*(.{1,40}?)\s+[—–]\s+(.+?)\s*\(\s*([\d.]+)\s*\/\s*([\d.]+)\s*\)\s*$/;
const AI_BAND_PATTERN = /^(\S{1,4})\s+[—–]\s+(.+)$/;
const AI_NEEDS_REVIEW_PATTERN = /needs human review/i;

// Gradescope's question title in the grading pane, e.g. "3.1: Show reduction".
const QUESTION_TITLE_PATTERN = /^\s*(\d+(?:\.\d+)*)\s*:\s*(\S.{0,100})$/;

// Rubric items that record the grader's verdict on the autograder result. Each applied rubric
// item is matched against these in order; the first match decides its category. The exact text
// of every applied item is logged too, so categories can be re-derived in analysis.
// Check them on a live page with the popup's "Check current page".
const RUBRIC_VERDICTS = [
  ["ai_error", /made an error|NOT CONFIRMED/i],
  ["ai_correct_with_comments", /correct\.?\s*See below for instructor/i],
  ["ai_correct", /comments are correct|score (and comments )?(is|are) correct|CONFIRMED/i]
];

// Quick buttons on the check-in box: what the grader did with the AI feedback on this answer.
const USAGE_OPTIONS = [
  ["accepted", "Accepted as-is"],
  ["accepted_added", "Accepted + added comments"],
  ["corrected", "Corrected the AI"],
  ["not_used", "Graded without it"]
];

const CHECKIN = {
  // The first Next / Next Ungraded click with an unfinished check-in shows a reminder instead of
  // moving on; clicking again always proceeds (logged as skipped). Set false to never hold Next.
  nudgeOnNext: true,
  // After "Corrected the AI", also ask which AI sections were wrong (when sections are visible).
  askWrongSections: true
};

// Optional page regions for finer attention measures. Selectors can be set from the popup's
// "Calibrate page regions" panel; overrides are saved in chrome.storage.local under "selectors".
const REGIONS = {
  ai_panel: { label: "AI feedback (auto-detected; override only if needed)", selector: "" },
  rubric: { label: "Rubric panel", selector: "[class*='rubric' i]" },
  submission: { label: "Student submission", selector: "" }
};
const DEFAULT_SELECTORS = Object.fromEntries(Object.entries(REGIONS).map(([region, { selector }]) => [region, selector]));
