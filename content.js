// Runs on Gradescope grading pages. Shows the floating study box (start / check-in / break / end)
// and, while a session is active, records only what the study's measures need (see README
// "Data collected"): which question and answer is open and for how long, the AI feedback shown,
// the rubric items applied, the grader's comment, engagement with the AI feedback, and the
// per-answer check-in.
const EDITABLE = "textarea, [contenteditable=''], [contenteditable='true']";
const NAV_TEXT = /^(next|previous)( ungraded)?$/i;
const APPLIED_CLASS = /(--applied|is-applied|\bapplied\b|\bselected\b|\bchecked\b|is-active)/i;
const POINTS = /([+-]?\s?\d+(?:\.\d+)?)\s*(?:Points|pts)\b/i;
const ATTENTION_IDLE_MS = 120_000;
let status = { active: false, paused: false, recording: false, participant: "" };
let selectors = { ...DEFAULT_SELECTORS };
let ctx = parseContext();
let hover = { region: null, section: null };
let attention = freshAttention();
let lastTick = performance.now();
let lastFlush = performance.now();
let lastInput = performance.now();
let lastScrollY = scrollY;
let lastSnapshot = "";
let aiSeenKey = null;
let questionSentKey = null;
let cache = {};
let picking = null;
let checkins = {};       // answer key -> { usage, helpful, wrongSections }
let toggles = {};        // answer key -> { category: on/off } replayed from clicks when the page state is unreadable
let nudgedKey = null;

const logging = () => status.active && !status.paused;
function freshAttention() { return { aiVisibleMs: 0, commentFocusMs: 0, scrollPx: 0, hoverMs: {}, sectionHoverMs: {} }; }

function send(type, data = {}) {
  if (!logging()) return;
  try { chrome.runtime.sendMessage({ kind: "log", event: { type, key: ctx.key, ...data } }).catch(() => {}); }
  catch { /* extension was reloaded; this page needs a refresh */ }
}
function command(kind, data = {}) {
  try { return chrome.runtime.sendMessage({ kind, ...data }); }
  catch { showToast("The study extension was updated. Reload this page."); return Promise.resolve(null); }
}

function parseContext() {
  const ids = {};
  for (const [, name, id] of location.pathname.matchAll(/\/(courses|assignments|questions|submissions)\/(\d+)/g)) ids[name.slice(0, -1)] = id;
  const key = ids.submission ? `${ids.question ? `q${ids.question}` : `a${ids.assignment ?? "?"}`}-s${ids.submission}` : null;
  return { ids, key, path: location.pathname };
}

function query(selector) { try { return selector ? document.querySelector(selector) : null; } catch { return null; } }
function within(el, selector) { try { return Boolean(selector && el.closest(selector)); } catch { return false; } }
function inViewport(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}
// Re-computes a page reading at most every 2 s per page, so the 1 s loop stays cheap.
function cached(name, compute) {
  const now = performance.now(), hit = cache[name];
  if (hit && hit.path === location.pathname && now - hit.at < 2000) return hit.value;
  const value = compute();
  cache[name] = { at: now, path: location.pathname, value };
  return value;
}
function* textNodes() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (cardHost.contains(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) yield node;
}

// ---- Question and AI feedback ----------------------------------------------------------------

function questionInfo() {
  return cached("question", () => {
    for (const node of textNodes()) {
      if (node.data.length > 110) continue;
      const m = node.data.match(QUESTION_TITLE_PATTERN);
      if (m) return { number: m[1], title: m[2].trim() };
    }
    return null;
  });
}
function aiSections() {
  return cached("sections", () => {
    const found = [];
    for (const el of document.querySelectorAll("div, section, article, li, details, tr")) {
      const head = el.firstElementChild;
      if (!head || head.childElementCount > 10 || cardHost.contains(el)) continue;
      const text = head.textContent;
      if (text.length > 200) continue;
      const m = text.match(AI_SECTION_PATTERN);
      if (!m) continue;
      const band = m[2].match(AI_BAND_PATTERN);
      found.push({
        el, id: m[1].trim(), mark: band ? band[1] : "", title: (band ? band[2] : m[2]).trim(),
        score: Number(m[3]), max: Number(m[4]), needsReview: AI_NEEDS_REVIEW_PATTERN.test(m[2])
      });
    }
    return found.filter((s) => !found.some((o) => o !== s && o.el.contains(s.el)));
  });
}
// The "Autograder Results" block (collapsed or expanded), used when sections aren't recognized.
function aiResultsBlock() {
  return cached("resultsBlock", () => {
    for (const node of textNodes()) {
      if (!AI_RESULTS_HEADING.test(node.data)) continue;
      let el = node.parentElement;
      for (let depth = 0; depth < 4 && el.parentElement && el.parentElement !== document.body; depth++) {
        el = el.parentElement;
        if (el.textContent.trim().length > node.data.trim().length + 5) break;
      }
      return el;
    }
    return null;
  });
}
function aiPanels() {
  const custom = query(selectors.ai_panel);
  if (custom) return [custom];
  const sections = aiSections();
  if (sections.length) return sections.map((s) => s.el);
  const block = aiResultsBlock();
  return block ? [block] : [];
}
function inAi(el) { return aiPanels().some((panel) => panel.contains(el)); }
function sectionOf(el) { return aiSections().find((s) => s.el.contains(el))?.id ?? null; }
function aiText() { return aiPanels().map((el) => el.innerText.trim()).join("\n\n"); }
const aiExpanded = () => aiPanels().some((el) => el.innerText.trim().length > 60);

function regionOf(node) {
  const el = node instanceof Element ? node : node?.parentElement;
  if (!el) return null;
  if (inAi(el)) return "ai_panel";
  if (el.closest(EDITABLE)) return "comment";
  if (within(el, selectors.rubric)) return "rubric";
  if (within(el, selectors.submission)) return "submission";
  return "page";
}

// ---- Rubric ----------------------------------------------------------------------------------

const verdictCategory = (text) => RUBRIC_VERDICTS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
// true / false from aria state or an "applied" class on the element or its descendants; null if unreadable.
function appliedState(el) {
  const nodes = [el, ...el.querySelectorAll("[aria-pressed], [aria-checked], [aria-selected], [class]")];
  let sawAria = false;
  for (const node of nodes) {
    for (const attr of ["aria-pressed", "aria-checked", "aria-selected"]) {
      const v = node.getAttribute(attr);
      if (v === "true") return true;
      if (v !== null) sawAria = true;
    }
  }
  if (nodes.some((node) => APPLIED_CLASS.test(node.className?.baseVal ?? node.className ?? ""))) return true;
  return sawAria ? false : null;
}
// Every rubric item on the page with its text, points, verdict category and applied state.
function rubricItems() {
  return cached("rubric", () => {
    let items = [];
    try { items = [...document.querySelectorAll("[class*='rubricItem' i]:not([class*='rubricItem' i] *)")]; } catch { /* old selector engine */ }
    if (!items.length) {
      // Fallback: climb from each verdict-text node to a container that holds the item's points.
      for (const node of textNodes()) {
        if (!verdictCategory(node.data)) continue;
        let el = node.parentElement;
        for (let depth = 0; depth < 5 && el.parentElement && !POINTS.test(el.textContent); depth++) el = el.parentElement;
        if (!items.includes(el)) items.push(el);
      }
    }
    return items.map((el) => {
      const text = el.innerText.trim().replace(/\s+/g, " ").slice(0, 200);
      return { el, text, points: text.match(POINTS)?.[1].replace(/\s/g, "") ?? null, category: verdictCategory(text), applied: appliedState(el) };
    });
  });
}
function rubricState() {
  const items = rubricItems();
  const readable = items.some((i) => i.applied !== null);
  const applied = readable ? items.filter((i) => i.applied) : [];
  return { readable, applied: applied.map(({ text, points, category }) => ({ text, points, category })) };
}
function currentVerdict() {
  const state = rubricState();
  const categories = state.readable
    ? state.applied.map((i) => i.category)
    : Object.entries(toggles[ctx.key] ?? {}).filter(([, on]) => on).map(([category]) => category);
  return RUBRIC_VERDICTS.map(([category]) => category).find((c) => categories.includes(c)) ?? "none";
}
function rubricItemOf(el) {
  for (let node = el, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
    const text = node.textContent ?? "";
    if (text.length > 400) break;
    const category = verdictCategory(text);
    if (category) return { category, text: text.trim().replace(/\s+/g, " ").slice(0, 200) };
  }
  return null;
}
function afterRubricChange() {
  cache.rubric = null;
  setTimeout(() => { cache.rubric = null; snapshot("rubric"); renderCard(); }, 400);
}

// ---- Comment snapshot ------------------------------------------------------------------------

function commentText() {
  return [...document.querySelectorAll(EDITABLE)]
    .filter((el) => !inAi(el) && !cardHost.contains(el))
    .map((el) => ("value" in el ? el.value : el.innerText).trim())
    .filter(Boolean).join("\n\n");
}
const normalize = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();
const words = (text) => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
function grams(list, n) {
  const out = new Set();
  for (let i = 0; i + n <= list.length; i++) out.add(list.slice(i, i + n).join(" "));
  return out;
}
// Share of the grader's comment word-trigrams that also appear in the AI feedback (0–1).
function overlap(comment, ai) {
  const cw = words(comment), aw = words(ai);
  if (!cw.length || !aw.length) return null;
  const n = Math.min(3, cw.length);
  const c = grams(cw, n), a = grams(aw, n);
  let hits = 0;
  c.forEach((g) => { if (a.has(g)) hits++; });
  return Math.round((hits / c.size) * 1000) / 1000;
}
function snapshot(reason) {
  if (!ctx.key || !logging()) return;
  const comment = commentText(), ai = aiText(), rubric = rubricState();
  const signature = `${ctx.key}\u0000${comment}\u0000${ai.length}\u0000${JSON.stringify(rubric)}`;
  if (signature === lastSnapshot) return;
  lastSnapshot = signature;
  send("comment_snapshot", { reason, rubric, commentChars: comment.length, aiChars: ai.length, aiOverlap: overlap(comment, ai), commentText: comment, aiText: ai });
}

// ---- Attention and navigation ----------------------------------------------------------------

const round = (obj) => Object.fromEntries(Object.entries(obj).map(([k, ms]) => [k, Math.round(ms)]));
function flushAttention() {
  const { aiVisibleMs, commentFocusMs, scrollPx, hoverMs, sectionHoverMs } = attention;
  if (aiVisibleMs || commentFocusMs || scrollPx || Object.keys(hoverMs).length) {
    send("attention", {
      aiVisibleMs: Math.round(aiVisibleMs), commentFocusMs: Math.round(commentFocusMs), scrollPx: Math.round(scrollPx),
      hoverMs: round(hoverMs), sectionHoverMs: round(sectionHoverMs)
    });
  }
  attention = freshAttention();
  lastFlush = performance.now();
}
function announce() {
  if (document.visibilityState !== "visible") return;
  send("visibility", { visible: true });
  send("page_context", { ids: ctx.ids, path: ctx.path });
}
function checkUrl() {
  if (location.pathname === ctx.path) return;
  flushAttention();
  ctx = parseContext(); lastSnapshot = ""; nudgedKey = null; cache = {};
  if (document.visibilityState === "visible") send("page_context", { ids: ctx.ids, path: ctx.path });
  renderCard();
}

// Once a second: note the question and AI feedback, time attention, refresh the box.
setInterval(() => {
  const now = performance.now(), dt = Math.min(now - lastTick, 2000);
  lastTick = now;
  if (document.visibilityState !== "visible") return;
  renderCard();
  if (!logging() || !ctx.key) return;
  const question = questionInfo();
  if (question && questionSentKey !== ctx.key) { questionSentKey = ctx.key; send("question_info", question); }
  const sections = aiSections();
  if (sections.length && aiSeenKey !== ctx.key) {
    aiSeenKey = ctx.key;
    send("ai_feedback_present", { aiChars: aiText().length, sections: sections.map(({ id, mark, title, score, max, needsReview }) => ({ id, mark, title, score, max, needsReview })) });
    snapshot("ai_loaded");
  }
  if (now - lastInput > ATTENTION_IDLE_MS) return;
  if (aiExpanded() && aiPanels().some(inViewport)) attention.aiVisibleMs += dt;
  if (hover.region) attention.hoverMs[hover.region] = (attention.hoverMs[hover.region] ?? 0) + dt;
  if (hover.section) attention.sectionHoverMs[hover.section] = (attention.sectionHoverMs[hover.section] ?? 0) + dt;
  if (document.hasFocus() && document.activeElement?.closest?.(EDITABLE) && !cardHost.contains(document.activeElement)) attention.commentFocusMs += dt;
  if (now - lastFlush > 15_000) flushAttention();
}, 1000);
setInterval(checkUrl, 500);
addEventListener("popstate", checkUrl);

const markInput = () => { lastInput = performance.now(); };
for (const type of ["mousemove", "keydown", "wheel", "pointerdown"]) addEventListener(type, markInput, { capture: true, passive: true });
addEventListener("scroll", () => { attention.scrollPx += Math.abs(scrollY - lastScrollY); lastScrollY = scrollY; markInput(); }, { passive: true });
document.addEventListener("scroll", (e) => { if (e.target !== document) markInput(); }, { capture: true, passive: true });

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { flushAttention(); snapshot("hidden"); send("visibility", { visible: false }); }
  else announce();
});
addEventListener("pagehide", () => { flushAttention(); snapshot("pagehide"); send("visibility", { visible: false }); });

document.addEventListener("mouseover", (e) => {
  const region = regionOf(e.target);
  hover = { region, section: region === "ai_panel" ? sectionOf(e.target) : null };
}, true);
document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) hover = { region: null, section: null }; }, true);

const controlText = (el) => (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").trim().replace(/\s+/g, " ");

// Registered on window (capture) so a held Next click never reaches Gradescope's own handlers.
addEventListener("click", (e) => {
  if (!logging() || cardHost.contains(e.target) || picking) return;
  const control = e.target.closest?.("button, a, [role='button'], summary");
  const label = control ? controlText(control) : "";
  if (control && NAV_TEXT.test(label)) {
    const missing = checkinMissing();
    if (CHECKIN.nudgeOnNext && /^next/i.test(label) && missing.length && nudgedKey !== ctx.key) {
      e.preventDefault(); e.stopImmediatePropagation();
      nudgedKey = ctx.key;
      send("checkin_nudge", { missing, control: label });
      renderCard({ nudge: true });
      return;
    }
    flushAttention(); snapshot("navigate");
    send("navigate", { control: label, checkinMissing: missing });
    return;
  }
  if (control && AI_RESULTS_HEADING.test(label)) {
    setTimeout(() => { cache = {}; send("ai_results_toggle", { expanded: aiExpanded() }); }, 300);
    return;
  }
  const region = regionOf(e.target);
  if (region === "ai_panel") { send("ai_interaction", { action: "click", section: sectionOf(e.target), control: label.slice(0, 60) || null }); return; }
  const item = rubricItemOf(e.target);
  if (item) {
    const t = (toggles[ctx.key] ??= {});
    t[item.category] = !t[item.category];
    send("rubric_action", { ...item, via: "click" });
    afterRubricChange();
  } else if (region === "rubric") afterRubricChange();
}, true);

document.addEventListener("keydown", (e) => {
  if (e.target.closest?.(`${EDITABLE}, input, select`) || e.ctrlKey || e.metaKey || e.altKey) return;
  // Gradescope applies rubric item N with the number key N; the page state is read afterwards.
  if (/^[0-9]$/.test(e.key)) { send("rubric_action", { key: e.key, via: "key" }); afterRubricChange(); }
}, true);
document.addEventListener("focusout", (e) => { if (e.target.closest?.(EDITABLE)) snapshot("blur"); }, true);
let commentTimer = null;
document.addEventListener("input", (e) => {
  if (!e.target.closest?.(EDITABLE) || cardHost.contains(e.target)) return;
  clearTimeout(commentTimer);
  commentTimer = setTimeout(() => snapshot("typing"), 2000);
}, true);

document.addEventListener("copy", () => {
  const anchor = getSelection()?.anchorNode;
  const el = anchor instanceof Element ? anchor : anchor?.parentElement;
  if (el && inAi(el)) send("ai_interaction", { action: "copy", section: sectionOf(el), chars: getSelection().toString().length });
}, true);
document.addEventListener("paste", (e) => {
  if (!e.target.closest?.(EDITABLE)) return;
  const text = e.clipboardData?.getData("text/plain") ?? "";
  const pasted = normalize(text);
  send("comment_paste", { chars: text.length, fromAi: pasted.length >= 8 && normalize(aiText()).includes(pasted) });
}, true);

// ---- Floating study box ----------------------------------------------------------------------
// Always on Gradescope grading pages. Before a session it offers Start; during a session it shows
// the question, the rubric verdict read from the page, the quick check-in buttons, and
// Break / End controls, so graders never need the toolbar popup.

const cardHost = document.createElement("div");
const card = cardHost.attachShadow({ mode: "open" });
card.innerHTML = `
  <style>
    :host { all: initial; }
    .card { position: fixed; left: 56px; bottom: 44px; z-index: 2147483646; width: 320px; font: 12px/1.35 system-ui, sans-serif;
      color: #202124; background: #fff; border: 1px solid #dadce0; border-radius: 10px; box-shadow: 0 4px 14px rgba(0,0,0,.18); }
    .head { display: flex; align-items: center; gap: 6px; padding: 7px 10px; cursor: move; border-bottom: 1px solid #eee; user-select: none; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa0a6; flex: none; }
    .dot.rec { background: #d93025; } .dot.live { background: #1e8e3e; } .dot.paused { background: #f29900; }
    .title { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .state { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: #fef7e0; color: #b06000; white-space: nowrap; }
    .state.done { background: #e6f4ea; color: #137333; }
    .min { border: 0; background: none; font-size: 16px; line-height: 1; cursor: pointer; padding: 0 2px; color: #5f6368; }
    .body { padding: 8px 10px 10px; display: grid; gap: 9px; }
    .collapsed .body { display: none; } .collapsed .head { border-bottom: 0; }
    .verdict { padding: 6px 8px; border-radius: 6px; background: #f1f3f4; }
    .verdict.ok { background: #e6f4ea; color: #137333; } .verdict.bad { background: #fce8e6; color: #a50e0e; } .verdict.todo { background: #fef7e0; color: #7a4a00; }
    .label { display: block; margin-bottom: 4px; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    button { font: inherit; cursor: pointer; }
    button.chip { padding: 3px 9px; border: 1px solid #bdc1c6; border-radius: 14px; background: #fff; }
    button.chip[aria-pressed="true"] { background: #1a73e8; border-color: #1a73e8; color: #fff; }
    .nudge { padding: 6px 8px; border-radius: 6px; background: #e8f0fe; color: #174ea6; }
    .foot { display: flex; gap: 6px; align-items: center; border-top: 1px solid #eee; padding-top: 8px; }
    .foot .info { flex: 1; color: #5f6368; font-size: 11px; }
    button.small { padding: 3px 9px; border: 1px solid #bdc1c6; border-radius: 6px; background: #fff; }
    button.primary { padding: 4px 12px; border: 1px solid #1a73e8; border-radius: 6px; background: #1a73e8; color: #fff; }
    button.danger { border-color: #f6aea9; background: #fce8e6; }
    input { font: inherit; padding: 4px 6px; border: 1px solid #bdc1c6; border-radius: 6px; width: 120px; }
    .start { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .pulse { animation: pulse .9s ease-in-out 2; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(26,115,232,.35); } }
    [hidden] { display: none !important; }
  </style>
  <div class="card" role="region" aria-label="Grading study">
    <div class="head"><span class="dot"></span><span class="title">Grading study</span><span class="state" hidden></span>
      <button class="min" title="Minimize" aria-label="Minimize">–</button></div>
    <div class="body">
      <div class="start" data-view="idle">
        <input class="code" placeholder="Participant code" maxlength="40" aria-label="Participant code">
        <button class="primary go">Start session</button>
      </div>
      <div data-view="paused">On a break. Logging and recording are paused. <button class="small resume">Resume</button></div>
      <div class="verdict" data-view="live"></div>
      <div data-view="live" class="usage"><span class="label">What did you do with the AI feedback?</span><div class="chips"></div></div>
      <div data-view="live" class="sections"><span class="label">Which AI sections were wrong?</span><div class="chips"></div></div>
      <div data-view="live" class="helpful"><span class="label">Was the AI feedback helpful for grading this answer?</span>
        <div class="chips"><button class="chip" data-v="yes">Yes</button><button class="chip" data-v="somewhat">Somewhat</button><button class="chip" data-v="no">No</button></div></div>
      <div class="nudge" data-view="live" hidden>Quick check-in before moving on, or click Next again to skip.</div>
      <div class="foot" data-view="session"><span class="info"></span><button class="small brk">Take a break</button><button class="small danger end">End session</button></div>
    </div>
  </div>`;
const $c = (sel) => card.querySelector(sel);
let ui = { collapsed: false, left: null, top: null };
let endArmed = false;

$c(".usage .chips").append(...USAGE_OPTIONS.map(([value, text]) => Object.assign(document.createElement("button"), { className: "chip", textContent: text, value })));

function answers() { return (checkins[ctx.key] ??= { usage: null, helpful: null, wrongSections: [] }); }
function saveCheckins() { chrome.storage.local.set({ checkins }).catch(() => {}); }
const wrongSectionChoices = () => [...aiSections().filter((s) => !s.needsReview).map((s) => s.id), "Other"];
function checkinMissing() {
  if (!ctx.key) return [];
  const a = answers(), missing = [];
  if (!a.usage) missing.push("usage");
  if (CHECKIN.askWrongSections && a.usage === "corrected" && aiSections().length && !a.wrongSections.length) missing.push("wrong_sections");
  if (!a.helpful) missing.push("helpful");
  return missing;
}
function setAnswer(field, value) {
  const a = answers();
  if (field === "wrong_sections") a.wrongSections = a.wrongSections.includes(value) ? a.wrongSections.filter((s) => s !== value) : [...a.wrongSections, value];
  else a[field] = a[field] === value ? null : value;
  saveCheckins();
  send("checkin", { field, value: field === "wrong_sections" ? a.wrongSections : a[field] });
  renderCard();
}
card.addEventListener("click", async (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.classList.contains("min")) { ui.collapsed = !ui.collapsed; chrome.storage.local.set({ checkinUi: ui }); renderCard(); return; }
  if (button.classList.contains("go")) {
    const participant = $c(".code").value.trim();
    if (!participant) { $c(".code").focus(); return; }
    const result = await command("startSession", { participant });
    if (result?.error) showToast(result.error);
    return;
  }
  if (button.classList.contains("brk")) { await command("pause"); return; }
  if (button.classList.contains("resume")) { await command("resume"); return; }
  if (button.classList.contains("end")) {
    if (!endArmed) { endArmed = true; button.textContent = "Click to confirm"; setTimeout(() => { endArmed = false; renderCard(); }, 4000); return; }
    endArmed = false;
    flushAttention(); snapshot("session_end");
    await command("endSession");
    showToast("Session ended. Your logs and recording are being saved to Downloads/grading-study/.", 8000);
    return;
  }
  if (button.closest(".usage")) setAnswer("usage", button.value);
  else if (button.closest(".helpful")) setAnswer("helpful", button.dataset.v);
  else if (button.closest(".sections")) setAnswer("wrong_sections", button.dataset.v);
});
card.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && e.target.classList.contains("code")) $c(".go").click(); });
$c(".head").addEventListener("mousedown", (e) => {
  if (e.target.closest("button")) return;
  const box = $c(".card").getBoundingClientRect(), dx = e.clientX - box.left, dy = e.clientY - box.top;
  const move = (m) => { ui.left = Math.max(0, m.clientX - dx); ui.top = Math.max(0, m.clientY - dy); place(); };
  const up = () => { removeEventListener("mousemove", move, true); removeEventListener("mouseup", up, true); chrome.storage.local.set({ checkinUi: ui }); };
  addEventListener("mousemove", move, true); addEventListener("mouseup", up, true);
  e.preventDefault();
});
function place() {
  if (ui.left === null) return;
  Object.assign($c(".card").style, { left: `${Math.min(ui.left, innerWidth - 120)}px`, top: `${Math.min(ui.top, innerHeight - 40)}px`, bottom: "auto" });
}
const VERDICT_TEXT = {
  none: ["todo", "Rubric: no autograder-verdict item applied yet."],
  ai_correct: ["ok", "Rubric: autograder correct."],
  ai_correct_with_comments: ["ok", "Rubric: autograder correct, with your comments."],
  ai_error: ["bad", "Rubric: autograder made an error."]
};
function setPressed(scope, isPressed) { card.querySelectorAll(`${scope} button`).forEach((b) => b.setAttribute("aria-pressed", String(isPressed(b)))); }
function renderCard({ nudge = false } = {}) {
  if (!ctx.key) { cardHost.remove(); return; }
  if (!cardHost.isConnected) { document.documentElement.append(cardHost); place(); }
  const view = !status.active ? "idle" : status.paused ? "paused" : "live";
  const shell = $c(".card");
  const nudging = view === "live" && nudgedKey === ctx.key && checkinMissing().length > 0;
  shell.classList.toggle("collapsed", ui.collapsed && !nudge && !nudging);
  card.querySelectorAll("[data-view]").forEach((el) => {
    el.hidden = !(el.dataset.view === view || (el.dataset.view === "session" && view !== "idle"));
  });
  $c(".dot").className = `dot${status.recording ? " rec" : view === "live" ? " live" : view === "paused" ? " paused" : ""}`;
  const q = questionInfo();
  $c(".title").textContent = view === "idle" ? "Grading study" : q ? `Q${q.number}: ${q.title}` : "Grading study";
  $c(".foot .info").textContent = status.recording ? "● Recording" : view === "idle" ? "" : "Not recording";
  $c(".end").textContent = endArmed ? "Click to confirm" : "End session";
  if (view === "idle") {
    if (!$c(".code").value && status.participant) $c(".code").value = status.participant;
    $c(".state").hidden = true;
    return;
  }
  if (view === "paused") { $c(".state").hidden = true; return; }

  const a = answers(), missing = checkinMissing();
  const [tone, text] = VERDICT_TEXT[currentVerdict()];
  $c(".verdict").className = `verdict ${tone}`;
  $c(".verdict").textContent = text;
  setPressed(".usage", (b) => a.usage === b.value);
  setPressed(".helpful", (b) => a.helpful === b.dataset.v);
  const showSections = CHECKIN.askWrongSections && a.usage === "corrected" && aiSections().length > 0;
  $c(".sections").hidden = !showSections;
  if (showSections) {
    const ids = wrongSectionChoices(), chips = $c(".sections .chips");
    if (chips.dataset.ids !== ids.join("|")) {
      chips.dataset.ids = ids.join("|");
      chips.replaceChildren(...ids.map((id) => {
        const b = Object.assign(document.createElement("button"), { className: "chip", textContent: id, title: aiSections().find((s) => s.id === id)?.title ?? "" });
        b.dataset.v = id;
        return b;
      }));
    }
    setPressed(".sections", (b) => a.wrongSections.includes(b.dataset.v));
  }
  $c(".state").hidden = false;
  $c(".state").textContent = missing.length ? `${missing.length} left` : "done";
  $c(".state").className = `state${missing.length ? "" : " done"}`;
  $c(".nudge").hidden = !nudging;
  if (nudge) { shell.classList.remove("pulse"); void shell.offsetWidth; shell.classList.add("pulse"); }
}

// ---- Calibration (researcher tool) -----------------------------------------------------------

const pickBox = document.createElement("div");
Object.assign(pickBox.style, { position: "fixed", zIndex: "2147483647", pointerEvents: "none", outline: "3px solid #1a73e8", background: "rgba(26,115,232,.12)" });
const toast = document.createElement("div");
Object.assign(toast.style, { position: "fixed", right: "12px", bottom: "56px", zIndex: "2147483647", pointerEvents: "none", maxWidth: "420px",
  background: "#202124", color: "#fff", font: "13px/1.4 system-ui, sans-serif", padding: "8px 12px", borderRadius: "6px" });
let toastTimer = null;
function showToast(text, ms = 5000) {
  toast.textContent = text;
  document.documentElement.append(toast);
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => toast.remove(), ms);
}
function highlight(el) {
  picking.el = el;
  const r = el.getBoundingClientRect();
  Object.assign(pickBox.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
}
const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
const pickListeners = [
  ["mousemove", (e) => highlight(e.target)],
  ["mousedown", swallow], ["mouseup", swallow], ["pointerdown", swallow], ["pointerup", swallow],
  ["click", (e) => { swallow(e); choose(); }],
  ["keydown", (e) => {
    swallow(e);
    if (e.key === "Escape") { stopPick(); showToast("Selection cancelled."); }
    else if (e.key === "ArrowUp" && picking.el?.parentElement && picking.el.parentElement !== document.documentElement) highlight(picking.el.parentElement);
    else if (e.key === "Enter") choose();
  }]
];
function startPick(region) {
  stopPick();
  picking = { region, el: null };
  document.documentElement.append(pickBox);
  showToast(`Click the ${REGIONS[region].label}. ↑ selects the parent element, Enter confirms, Esc cancels.`, 0);
  for (const [type, fn] of pickListeners) addEventListener(type, fn, true);
}
function stopPick() {
  if (!picking) return;
  for (const [type, fn] of pickListeners) removeEventListener(type, fn, true);
  pickBox.remove();
  setTimeout(() => { picking = null; }, 0);
}
const stableId = (id) => id && !/\d{3,}/.test(id);
function selectorFor(el) {
  if (stableId(el.id)) return `#${CSS.escape(el.id)}`;
  const parts = [];
  for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
    if (node !== el && stableId(node.id)) { parts.unshift(`#${CSS.escape(node.id)}`); return parts.join(" > "); }
    const classes = [...node.classList].filter((c) => !/\d{3,}|^(is-|active|hover|focus|selected)/.test(c)).slice(0, 2);
    let part = node.tagName.toLowerCase() + classes.map((c) => `.${CSS.escape(c)}`).join("");
    if (!classes.length && node.parentElement) part += `:nth-of-type(${[...node.parentElement.children].filter((c) => c.tagName === node.tagName).indexOf(node) + 1})`;
    parts.unshift(part);
    const selector = parts.join(" > ");
    if (classes.length && document.querySelectorAll(selector).length === 1) return selector;
  }
  return parts.join(" > ");
}
async function choose() {
  const { region, el } = picking ?? {};
  if (!el) return;
  stopPick();
  const selector = selectorFor(el);
  const { selectors: saved = {} } = await chrome.storage.local.get("selectors");
  await chrome.storage.local.set({ selectors: { ...saved, [region]: selector } });
  showToast(`${REGIONS[region].label} saved: ${selector}`);
}
function probe() {
  cache = {};
  const regions = {};
  for (const region of Object.keys(REGIONS)) {
    const selector = selectors[region];
    let matches = 0, chars = 0;
    try {
      const els = selector ? document.querySelectorAll(selector) : [];
      matches = els.length; chars = els[0]?.innerText.trim().length ?? 0;
    } catch { matches = -1; }
    regions[region] = { selector, matches, chars };
  }
  return {
    key: ctx.key, question: questionInfo(), regions,
    aiResults: aiResultsBlock() ? (aiExpanded() ? "found, expanded" : "found, collapsed") : "not found",
    sections: aiSections().map(({ id, mark, needsReview }) => (needsReview ? `${id}:needs review` : `${id}:${mark || "?"}`)),
    rubric: rubricItems().map(({ text, points, category, applied }) => ({ text: text.slice(0, 80), points, category, applied })),
    commentBoxes: document.querySelectorAll(EDITABLE).length
  };
}
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.kind === "pick") { startPick(msg.region); reply({ ok: true }); }
  if (msg.kind === "probe") reply(probe());
});

chrome.storage.local.get(["studyStatus", "selectors", "checkins", "checkinUi"]).then((saved) => {
  status = { ...status, ...saved.studyStatus };
  selectors = { ...DEFAULT_SELECTORS, ...saved.selectors };
  checkins = saved.checkins ?? {};
  ui = { ...ui, ...saved.checkinUi };
  announce(); renderCard();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.selectors) selectors = { ...DEFAULT_SELECTORS, ...changes.selectors.newValue };
  if (changes.checkins) checkins = changes.checkins.newValue ?? {};
  if (changes.studyStatus) {
    const was = logging();
    status = { ...status, ...changes.studyStatus.newValue };
    if (!was && logging()) announce();
    renderCard();
  }
});
