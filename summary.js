// Derives analysis tables from the raw event stream at export time, so the raw events stay the
// source of truth and these definitions can be revised later without re-collecting:
//   summarize()           one row per answer (question × submission) per session
//   summarizeByQuestion() one row per question, aggregating those answers
// README "Data collected" documents each column.
function blankRow(sessionId, key, session) {
  return {
    // identity
    grader_id: session?.graderId ?? "", session_id: sessionId,
    question_number: "", question_title: "", question_id: "", submission_id: "", course_id: "", assignment_id: "",
    answer_key: key, first_opened: "", visits: 0,
    // efficiency
    active_ms: 0, time_on_page_ms: 0, time_to_rubric_ms: "",
    // AI output shown
    ai_sections_found: 0, ai_section_count: "", ai_marks: "", ai_needs_review: "", ai_results_opened: 0,
    // rubric verdict on the AI (read from the page)
    rubric_verdict: "", rubric_items_applied: "", rubric_points: "", rubric_source: "", rubric_actions: 0,
    // AI use (study bar) and workflow
    ai_use: "", ai_use_late: 0, status: "", skips: 0, nav_blocked: 0, leave_prompts: 0,
    // grader's added feedback
    comment_chars: "", comment_ai_overlap: "", comment_pastes: 0, comment_pastes_from_ai: 0,
    // engagement with the AI feedback
    ai_visible_ms: 0, hover_ai_panel_ms: 0, hover_rubric_ms: 0, hover_submission_ms: 0, comment_focus_ms: 0, scroll_px: 0,
    ai_section_hover_s: "", ai_section_clicks: "", ai_copies: 0, markers: 0,
    _firstT: null, _toggles: {}, _dom: null, _sectionHover: {}, _sectionClicks: {}, _missed: false
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
      case "ai_use": if (r) { r.ai_use = e.value ?? ""; if (e.late) r.ai_use_late = 1; } break;
      case "skip": if (r) r.skips++; break;
      case "nav_blocked": if (r) r.nav_blocked++; break;
      case "leave_prompt": if (r) r.leave_prompts++; break;
      case "answer_missed": if (e.missedKey) rowFor(e.sessionId, e.missedKey)._missed = true; break;
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
    r.ai_section_hover_s = joinMap(r._sectionHover, 1000);
    r.ai_section_clicks = joinMap(r._sectionClicks);
    // answered: an AI-use choice is recorded; skipped: only ever skipped; missing: neither.
    r.status = r.ai_use ? "answered" : r.skips ? "skipped" : "missing";
    return Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_")).map(([k, v]) =>
      k.endsWith("_ms") ? [`${k.slice(0, -3)}_s`, v === "" ? "" : Math.round(v / 100) / 10] : [k, v]));
  });
}

// One row per visit: each continuous stretch a grader had one student's answer to one question
// open, from opening it until moving to another answer or ending the session. An answer that is
// skipped and revisited, or reopened later, has several visits; answers.csv adds them up.
// video_start_s / video_end_s locate the visit in the session's screen recording (breaks are
// already cut out of the video), so clips can be cut without watching the whole recording.
// `videoFiles` maps recording IDs to the saved video file names.
function summarizeVisits(events, videoFiles = {}) {
  const visits = [];
  const sessions = {};
  const visibleTabs = new Set();
  const counts = {};
  let visit = null, idle = false, paused = false, lastT = null;
  const close = (e, endedBy) => {
    if (!visit) return;
    visit.ended_at = e.ts;
    if (visit.video_recording_id) visit.video_end_s = e.videoRecordingId === visit.video_recording_id ? e.videoSec : visit._lastVideoSec;
    visit.ended_by ||= endedBy;
    visits.push(visit);
    visit = null;
  };
  for (const e of events) {
    if (visit && lastT !== null && e.type !== "session_started") {
      const dt = e.t - lastT;
      visit.wall_ms += dt;
      if (paused) visit.paused_ms += dt;
      else if (!idle && visibleTabs.has(visit._tabId)) visit.active_ms += dt;
    }
    lastT = e.t;
    if (visit && e.videoRecordingId && e.type !== "page_changed") {
      // A recording that starts mid-visit begins this visit's clip at its first frame.
      if (!visit.video_recording_id) Object.assign(visit, { video_recording_id: e.videoRecordingId, video_start_s: e.videoSec });
      if (e.videoRecordingId === visit.video_recording_id) visit._lastVideoSec = e.videoSec;
    }
    switch (e.type) {
      case "session_started": close(e, "session_restart"); sessions[e.sessionId] = e; idle = false; paused = false; visibleTabs.clear(); break;
      case "session_ended": close(e, "session_end"); break;
      case "paused": paused = true; break;
      case "resumed": paused = false; break;
      case "idle_state": idle = e.state !== "active"; break;
      case "visibility": if (e.visible) visibleTabs.add(e.tabId); else visibleTabs.delete(e.tabId); break;
      case "page_changed": {
        close(e, "other");
        if (!e.key) break;
        const id = `${e.sessionId}|${e.key}`;
        counts[id] = (counts[id] ?? 0) + 1;
        visit = {
          grader_id: sessions[e.sessionId]?.graderId ?? "", session_id: e.sessionId,
          question_number: "", question_title: "", question_id: e.ids?.question ?? "", submission_id: e.ids?.submission ?? "",
          answer_key: e.key, visit_number: counts[id], started_at: e.ts, ended_at: "",
          video_file: "", video_recording_id: e.videoRecordingId ?? "", video_start_s: e.videoSec ?? "", video_end_s: "",
          active_ms: 0, wall_ms: 0, paused_ms: 0, ai_use_at_end: "", ended_by: "", _tabId: e.tabId, _lastVideoSec: e.videoSec ?? ""
        };
        break;
      }
      case "question_info": if (visit && e.key === visit.answer_key) Object.assign(visit, { question_number: e.number, question_title: e.title }); break;
      case "ai_use": if (visit && e.key === visit.answer_key) visit.ai_use_at_end = e.value ?? ""; break;
      case "skip": if (visit && e.key === visit.answer_key) visit.ended_by = "skip"; break;
      case "navigate": if (visit && e.key === visit.answer_key && !visit.ended_by) visit.ended_by = `navigate: ${e.control || "link"}`; break;
      case "leave_prompt": if (visit && e.key === visit.answer_key && !visit.ended_by) visit.ended_by = "left page another way"; break;
    }
  }
  if (visit) visits.push({ ...visit, ended_by: visit.ended_by || "log ended", video_end_s: visit._lastVideoSec });
  for (const v of visits) v.video_file = videoFiles[v.video_recording_id] ?? "";
  // The question title is read once per page; copy it to every visit of the same question.
  const titles = {};
  for (const v of visits) if (v.question_number) titles[v.question_id] = [v.question_number, v.question_title];
  for (const v of visits) if (!v.question_number && titles[v.question_id]) [v.question_number, v.question_title] = titles[v.question_id];
  // ai_use_at_end only reflects answers given during that visit; carry the latest one forward.
  const latest = {};
  for (const v of visits) {
    const id = `${v.session_id}|${v.answer_key}`;
    if (v.ai_use_at_end) latest[id] = v.ai_use_at_end;
    else v.ai_use_at_end = latest[id] ?? "";
  }
  return visits.map((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("_")).map(([k, val]) =>
    k.endsWith("_ms") ? [`${k.slice(0, -3)}_s`, Math.round(val / 100) / 10] : [k, val])));
}

// One row per question per grader (grader_id): answers handled, time spent, AI use and rubric verdicts.
// Combine the files of all graders to get totals per question across graders.
function summarizeByQuestion(rows) {
  const groups = new Map();
  for (const r of rows) {
    const id = `${r.grader_id}|${r.question_id || r.answer_key}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 10) / 10;
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : "");
  const median = (xs) => {
    if (!xs.length) return "";
    const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
  };
  const share = (list, test) => (list.length ? Math.round((list.filter(test).length / list.length) * 1000) / 1000 : "");
  return [...groups.values()].map((list) => {
    const answered = list.filter((r) => r.status === "answered");
    const active = answered.map((r) => r.active_s);
    return {
      grader_id: list[0].grader_id, question_id: list[0].question_id,
      question_number: list.find((r) => r.question_number)?.question_number ?? "",
      question_title: list.find((r) => r.question_title)?.question_title ?? "",
      answers_opened: list.length, answered: answered.length,
      skipped_unfinished: list.filter((r) => r.status === "skipped").length, missing: list.filter((r) => r.status === "missing").length,
      total_active_s: sum(list.map((r) => r.active_s)), total_time_on_page_s: sum(list.map((r) => r.time_on_page_s)),
      mean_active_s_per_answer: mean(active), median_active_s_per_answer: median(active),
      ...Object.fromEntries(USAGE_KEYS.map((u) => [`share_ai_${u}`, share(answered, (r) => r.ai_use === u)])),
      share_rubric_ai_correct: share(answered, (r) => r.rubric_verdict.startsWith("ai_correct")),
      share_rubric_ai_error: share(answered, (r) => r.rubric_verdict === "ai_error"),
      share_rubric_none: share(answered, (r) => r.rubric_verdict === "none"),
      mean_comment_chars: mean(answered.map((r) => r.comment_chars).filter((v) => v !== "")),
      mean_ai_visible_s: mean(answered.map((r) => r.ai_visible_s))
    };
  }).sort((a, b) => String(a.question_number).localeCompare(String(b.question_number), undefined, { numeric: true }));
}
const USAGE_KEYS = ["kept", "edited", "not_used"];

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

// Builds the export files from the stored log and saves them into the session's folder.
// Builds the export files for one session (the current or most recent one by default) and saves
// them into that session's folder next to its screen recording. Earlier sessions are not repeated.
async function exportLogs(sessionId = null) {
  const { studyState, recordings = [] } = await chrome.storage.local.get(["studyState", "recordings"]);
  const sid = sessionId ?? studyState?.sessionId;
  const events = annotateVideoOffsets((studyState?.events ?? []).filter((e) => e.sessionId === sid));
  if (!events.length) return 0;
  const started = events.find((e) => e.type === "session_started");
  const folder = started?.sessionFolder ?? studyState.sessionFolder ?? `grading-study/grader-${String(studyState.graderId || "unknown").replace(/[^\w-]+/g, "_")}`;
  const videoFiles = Object.fromEntries(recordings.filter((m) => m.filename).map((m) => [m.id, m.filename.split(/[\\/]/).pop()]));
  const save = async (filename, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    await chrome.downloads.download({ url, filename: `${folder}/${filename}`, conflictAction: "overwrite" });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const answers = summarize(events);
  await save("events.json", JSON.stringify({ schemaVersion: 6, exportedAt: new Date().toISOString(), extensionVersion: chrome.runtime.getManifest().version, events }, null, 2), "application/json");
  await save("answers.csv", toCsv(answers), "text/csv");
  await save("questions.csv", toCsv(summarizeByQuestion(answers)), "text/csv");
  await save("visits.csv", toCsv(summarizeVisits(events, videoFiles)), "text/csv");
  return events.length;
}
