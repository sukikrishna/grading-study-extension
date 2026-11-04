// Derives analysis tables from the raw event stream at export time, so the raw events stay the
// source of truth and these definitions can be revised later without re-collecting:
//   summarize()           one row per answer (question × submission) per session
//   summarizeByQuestion() one row per question, aggregating those answers
// README "Data collected" documents each column.
function blankRow(sessionId, key, session) {
  return {
    // identity
    session_id: sessionId, participant: session?.participant ?? "",
    question_number: "", question_title: "", question_id: "", submission_id: "", course_id: "", assignment_id: "",
    answer_key: key, first_opened: "", visits: 0,
    // efficiency
    active_ms: 0, time_on_page_ms: 0, time_to_rubric_ms: "",
    // AI output shown
    ai_sections_found: 0, ai_section_count: "", ai_marks: "", ai_needs_review: "", ai_results_opened: 0,
    // rubric verdict on the AI (read from the page)
    rubric_verdict: "", rubric_items_applied: "", rubric_points: "", rubric_source: "", rubric_actions: 0,
    // grader check-in
    usage: "", wrong_sections: "", helpful: "", checkin_complete: 0, checkin_nudged: 0, left_with_missing: "",
    // grader's added feedback
    comment_chars: "", comment_ai_overlap: "", comment_pastes: 0, comment_pastes_from_ai: 0,
    // engagement with the AI feedback
    ai_visible_ms: 0, hover_ai_panel_ms: 0, hover_rubric_ms: 0, hover_submission_ms: 0, comment_focus_ms: 0, scroll_px: 0,
    ai_section_hover_s: "", ai_section_clicks: "", ai_copies: 0, markers: 0,
    _firstT: null, _toggles: {}, _dom: null, _sectionHover: {}, _sectionClicks: {}, _wrong: []
  };
}
const VERDICT_ORDER = ["ai_error", "ai_correct_with_comments", "ai_correct"];
const strongest = (categories) => VERDICT_ORDER.find((c) => categories.includes(c)) ?? (categories.length ? "other" : "none");
const add = (obj, key, n) => { obj[key] = (obj[key] ?? 0) + n; };
const joinMap = (obj, scale = 1) => Object.entries(obj).map(([k, v]) => `${k}:${Math.round((v / scale) * 10) / 10}`).join(";");

function summarize(events) {
  const rows = new Map();
  const sessions = {};
  const visibleTabs = new Set();
  let current = null, idle = false, paused = false, lastT = null;
  const rowFor = (sessionId, key) => {
    const id = `${sessionId}|${key}`;
    if (!rows.has(id)) rows.set(id, blankRow(sessionId, key, sessions[sessionId]));
    return rows.get(id);
  };

  for (const e of events) {
    // Time since the previous event belongs to whatever answer was open. "Active" also
    // requires the grading tab to be visible and the computer not idle.
    if (current && lastT !== null && !paused && e.type !== "session_started") {
      const dt = e.t - lastT, row = rowFor(current.sessionId, current.key);
      row.time_on_page_ms += dt;
      if (!idle && visibleTabs.has(current.tabId)) row.active_ms += dt;
    }
    lastT = e.t;
    const r = e.key ? rowFor(e.sessionId, e.key) : null;
    switch (e.type) {
      case "session_started": sessions[e.sessionId] = e; current = null; idle = false; paused = false; visibleTabs.clear(); break;
      case "session_ended": current = null; break;
      case "paused": paused = true; break;
      case "resumed": paused = false; break;
      case "idle_state": idle = e.state !== "active"; break;
      case "visibility": if (e.visible) visibleTabs.add(e.tabId); else visibleTabs.delete(e.tabId); break;
      case "page_changed":
        current = e.key ? { sessionId: e.sessionId, key: e.key, tabId: e.tabId } : null;
        if (r) {
          r.visits++; r.first_opened ||= e.ts; r._firstT ??= e.t;
          Object.assign(r, { course_id: e.ids?.course ?? "", assignment_id: e.ids?.assignment ?? "", question_id: e.ids?.question ?? "", submission_id: e.ids?.submission ?? "" });
        }
        break;
      case "question_info": if (r) Object.assign(r, { question_number: e.number, question_title: e.title }); break;
      case "ai_feedback_present": if (r) {
        const sections = e.sections ?? [];
        Object.assign(r, {
          ai_sections_found: 1, ai_section_count: sections.length,
          ai_marks: sections.filter((s) => !s.needsReview).map((s) => `${s.id}:${s.mark}`).join(";"),
          ai_needs_review: sections.filter((s) => s.needsReview).map((s) => s.id).join(";")
        });
      } break;
      case "ai_results_toggle": if (r && e.expanded) r.ai_results_opened++; break;
      case "rubric_action": if (r) {
        r.rubric_actions++;
        if (e.category) r._toggles[e.category] = !r._toggles[e.category];
        if (r.time_to_rubric_ms === "" && r._firstT !== null) r.time_to_rubric_ms = e.t - r._firstT;
      } break;
      case "checkin": if (r) {
        if (e.field === "wrong_sections") r._wrong = e.value ?? [];
        else r[e.field] = e.value ?? "";
      } break;
      case "checkin_nudge": if (r) r.checkin_nudged++; break;
      case "navigate": if (r) r.left_with_missing = (e.checkinMissing ?? []).join(";"); break;
      case "comment_snapshot": if (r) {
        r.comment_chars = e.commentChars; r.comment_ai_overlap = e.aiOverlap ?? "";
        if (e.rubric?.readable) r._dom = e.rubric.applied;
      } break;
      case "comment_paste": if (r) { r.comment_pastes++; if (e.fromAi) r.comment_pastes_from_ai++; } break;
      case "attention": if (r) {
        const hover = e.hoverMs ?? {};
        r.ai_visible_ms += e.aiVisibleMs ?? 0; r.comment_focus_ms += e.commentFocusMs ?? 0; r.scroll_px += e.scrollPx ?? 0;
        r.hover_ai_panel_ms += hover.ai_panel ?? 0; r.hover_rubric_ms += hover.rubric ?? 0; r.hover_submission_ms += hover.submission ?? 0;
        for (const [section, ms] of Object.entries(e.sectionHoverMs ?? {})) add(r._sectionHover, section, ms);
      } break;
      case "ai_interaction": if (r) {
        if (e.action === "copy") r.ai_copies++;
        else if (e.section) add(r._sectionClicks, e.section, 1);
      } break;
      case "marker": if (e.currentKey) rowFor(e.sessionId, e.currentKey).markers++; break;
    }
  }

  return [...rows.values()].map((r) => {
    // Prefer the rubric items read from the page; fall back to replaying clicks.
    if (r._dom) {
      r.rubric_source = "page";
      r.rubric_verdict = strongest(r._dom.map((i) => i.category).filter(Boolean));
      if (!r._dom.length) r.rubric_verdict = "none";
      r.rubric_items_applied = r._dom.map((i) => i.text).join(" | ");
      r.rubric_points = r._dom.map((i) => i.points).filter(Boolean).join(";");
    } else if (r.rubric_actions) {
      r.rubric_source = "clicks";
      r.rubric_verdict = strongest(Object.entries(r._toggles).filter(([, on]) => on).map(([c]) => c));
    } else r.rubric_verdict = "none";
    r.wrong_sections = r._wrong.join(";");
    r.ai_section_hover_s = joinMap(r._sectionHover, 1000);
    r.ai_section_clicks = joinMap(r._sectionClicks);
    r.checkin_complete = r.usage && r.helpful && (r.usage !== "corrected" || !r.ai_sections_found || r._wrong.length) ? 1 : 0;
    return Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_")).map(([k, v]) =>
      k.endsWith("_ms") ? [`${k.slice(0, -3)}_s`, v === "" ? "" : Math.round(v / 100) / 10] : [k, v]));
  });
}

// One row per question: how many answers, how long they took, and how graders judged the AI.
function summarizeByQuestion(rows) {
  const groups = new Map();
  for (const r of rows) {
    const id = r.question_id || r.answer_key;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : "");
  const median = (xs) => {
    if (!xs.length) return "";
    const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
  };
  const share = (list, test) => (list.length ? Math.round((list.filter(test).length / list.length) * 1000) / 1000 : "");
  return [...groups.values()].map((list) => {
    const active = list.map((r) => r.active_s);
    const toRubric = list.map((r) => r.time_to_rubric_s).filter((v) => v !== "");
    const checked = list.filter((r) => r.checkin_complete);
    return {
      question_id: list[0].question_id, question_number: list.find((r) => r.question_number)?.question_number ?? "",
      question_title: list.find((r) => r.question_title)?.question_title ?? "",
      participants: [...new Set(list.map((r) => r.participant))].join(";"), answers: list.length,
      total_active_s: Math.round(active.reduce((a, b) => a + b, 0) * 10) / 10,
      mean_active_s: mean(active), median_active_s: median(active), mean_time_to_rubric_s: mean(toRubric),
      share_rubric_ai_correct: share(list, (r) => r.rubric_verdict.startsWith("ai_correct")),
      share_rubric_ai_error: share(list, (r) => r.rubric_verdict === "ai_error"),
      share_rubric_none: share(list, (r) => r.rubric_verdict === "none"),
      ...Object.fromEntries(USAGE_KEYS.map((u) => [`share_usage_${u}`, share(checked, (r) => r.usage === u)])),
      share_helpful_yes: share(checked, (r) => r.helpful === "yes"),
      share_helpful_somewhat: share(checked, (r) => r.helpful === "somewhat"),
      share_helpful_no: share(checked, (r) => r.helpful === "no"),
      checkin_completion: share(list, (r) => r.checkin_complete),
      mean_comment_chars: mean(list.map((r) => r.comment_chars).filter((v) => v !== "")),
      mean_ai_visible_s: mean(list.map((r) => r.ai_visible_s))
    };
  }).sort((a, b) => String(a.question_number).localeCompare(String(b.question_number), undefined, { numeric: true }));
}
const USAGE_KEYS = ["accepted", "accepted_added", "corrected", "not_used"];

// Adds videoRecordingId / videoSec to each event that happened while a screen recording was
// running, so a coder can jump straight to that moment in the .webm file.
function annotateVideoOffsets(events) {
  let rec = null;
  return events.map((e) => {
    if (e.type === "recording_started") rec = { id: e.recordingId, start: e.t, pausedMs: 0, pausedAt: null };
    let out = e;
    if (rec) {
      if (e.type === "recording_paused") rec.pausedAt = e.t;
      if (e.type === "recording_resumed" && rec.pausedAt !== null) { rec.pausedMs += e.t - rec.pausedAt; rec.pausedAt = null; }
      const at = rec.pausedAt ?? e.t;
      out = { ...e, videoRecordingId: rec.id, videoSec: Math.round((at - rec.start - rec.pausedMs) / 100) / 10 };
    }
    if (e.type === "recording_stopped") rec = null;
    return out;
  });
}

function toCsv(rows) {
  if (!rows.length) return "";
  const header = Object.keys(rows[0]);
  const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [header, ...rows.map((r) => header.map((h) => r[h]))].map((line) => line.map(cell).join(",")).join("\n") + "\n";
}

// Builds the export files from the stored log and saves them to Downloads/grading-study/.
async function exportLogs() {
  const { studyState } = await chrome.storage.local.get("studyState");
  const events = annotateVideoOffsets(studyState?.events ?? []);
  if (!events.length) return 0;
  const base = `grading-study/${String(studyState.participant || "participant").replace(/[^\w-]+/g, "_")}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  const save = async (filename, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const answers = summarize(events);
  await save(`${base}-events.json`, JSON.stringify({ schemaVersion: 5, exportedAt: new Date().toISOString(), extensionVersion: chrome.runtime.getManifest().version, events }, null, 2), "application/json");
  await save(`${base}-answers.csv`, toCsv(answers), "text/csv");
  await save(`${base}-questions.csv`, toCsv(summarizeByQuestion(answers)), "text/csv");
  return events.length;
}
