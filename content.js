// Runs on Gradescope grading pages. Shows the study bar (recording state, per-answer timer, AI-use
// buttons, Skip, Pause, End) and, while a session is active, records what the study's measures
// need (see README "Data collected"). An "answer" is one student's submission for one question;
// each has its own Gradescope URL and is the unit every measure is recorded for.
const EDITABLE = "textarea, [contenteditable=''], [contenteditable='true']";
const NAV_TEXT = /^(next|previous)( ungraded)?$/i;
const APPLIED_CLASS = /(--applied|is-applied|\bapplied\b|\bselected\b|\bchecked\b|is-active)/i;
const POINTS = /([+-]?\s?\d+(?:\.\d+)?)\s*(?:Points|pts)\b/i;
const ATTENTION_IDLE_MS = 120_000;
let status = { active: false, paused: false, recording: false, graderId: "" };
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
let toggles = {};        // answer key -> { category: on/off } replayed from clicks when the page state is unreadable
// Per-answer study state, shared across tabs and page loads through chrome.storage.local.
let answers = {};        // answer key -> { usage, skipped }
let entryMs = {};        // answer key -> active ms on that answer (shown on the bar)
let pending = [];        // answers left without an AI-use answer by a route the bar couldn't block
let lastEntry = null;    // the answer most recently open
let leaving = false;     // set when the bar itself sends the grader on, so the leave guard stays quiet

const logging = () => status.active && !status.paused;
function freshAttention() { return { aiVisibleMs: 0, commentFocusMs: 0, scrollPx: 0, hoverMs: {}, sectionHoverMs: {} }; }

function send(type, data = {}) {
  if (!logging()) return;
  try { chrome.runtime.sendMessage({ kind: "log", event: { type, key: ctx.key, ...data } }).catch(() => {}); }
  catch { /* extension was reloaded; this page needs a refresh */ }
}
// Keeps the last failure where the popup's "Check current page" can show it.
let lastErrorAt = 0;
function reportError(where, err) {
  console.error("[grading study]", where, err);
  if (Date.now() - lastErrorAt < 10_000) return;
  lastErrorAt = Date.now();
  chrome.storage.local.set({ contentError: {
    where, message: String(err?.message ?? err), stack: String(err?.stack ?? "").slice(0, 800),
    page: location.pathname, at: new Date().toISOString(), version: chrome.runtime.getManifest().version
  } }).catch(() => {});
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
    acceptNode: (n) => (barHost.contains(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
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
      if (!head || head.childElementCount > 10 || barHost.contains(el)) continue;
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
  setTimeout(() => { cache.rubric = null; snapshot("rubric"); renderBar(); }, 400);
}

// ---- Comment snapshot ------------------------------------------------------------------------

function commentText() {
  return [...document.querySelectorAll(EDITABLE)]
    .filter((el) => !inAi(el) && !barHost.contains(el))
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

// ---- Answers: AI use, skip, and the move-on guard -------------------------------------------

const isDone = (key) => Boolean(answers[key]?.usage || answers[key]?.skipped);
const canLeave = () => !logging() || !ctx.key || (isDone(ctx.key) && !pending.length);
function saveAnswers() { chrome.storage.local.set({ studyAnswers: { answers, pending, lastEntry } }).catch(() => {}); }
// Called whenever the open answer may have changed. An answer left without an AI-use choice
// (e.g. through a keyboard shortcut) is queued so the bar asks about it on the next page.
function enterEntry() {
  if (!logging() || lastEntry === ctx.key) return;
  if (lastEntry && !isDone(lastEntry) && !pending.includes(lastEntry)) {
    pending.push(lastEntry);
    send("answer_missed", { missedKey: lastEntry });
  }
  if (ctx.key && answers[ctx.key]?.skipped) answers[ctx.key].skipped = false; // back to a skipped answer: it needs an answer now
  lastEntry = ctx.key;
  saveAnswers();
  renderBar();
}
function setUsage(key, value, late = false) {
  answers[key] = { ...answers[key], usage: answers[key]?.usage === value && !late ? null : value, skipped: false };
  pending = pending.filter((k) => k !== key);
  saveAnswers();
  send("ai_use", { key, value: answers[key].usage, ...(late ? { late: true } : {}) });
  hideMessage();
  renderBar();
}
function findNextControl() {
  const controls = [...document.querySelectorAll("button, a, [role='button']")].filter((el) => !barHost.contains(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true");
  return controls.find((el) => /^next ungraded$/i.test(controlText(el))) ?? controls.find((el) => /^next$/i.test(controlText(el)));
}
function skip() {
  if (!logging() || !ctx.key) return;
  answers[ctx.key] = { ...answers[ctx.key], skipped: true };
  saveAnswers();
  flushAttention(); snapshot("skip");
  send("skip");
  const next = findNextControl();
  if (next) { leaving = true; next.click(); setTimeout(() => { leaving = false; }, 3000); }
  else showMessage("Skipped. Open another student or question to continue; come back to this one later.");
  renderBar();
}
function blockedMessage() {
  return pending.length
    ? "First answer the AI-use question for the earlier answer shown below."
    : "Choose how you used the AI for this answer, or press Skip, before moving on.";
}
// Chrome's own "Leave site?" prompt for any other way off the page while the answer is open.
addEventListener("beforeunload", (e) => {
  if (leaving || canLeave()) return;
  send("leave_prompt");
  e.preventDefault();
  e.returnValue = "";
});

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
  command("seenGradescope");
  send("visibility", { visible: true });
  send("page_context", { ids: ctx.ids, path: ctx.path });
  enterEntry();
}
function checkUrl() {
  if (location.pathname === ctx.path) return;
  flushAttention();
  ctx = parseContext(); lastSnapshot = ""; cache = {};
  if (document.visibilityState === "visible") { send("page_context", { ids: ctx.ids, path: ctx.path }); enterEntry(); }
  renderBar();
}

// Once a second: time the open answer, note the question and AI feedback, refresh the bar.
let entrySaveAt = 0;
setInterval(() => { try { tick(); } catch (err) { reportError("tick", err); } }, 1000);
function tick() {
  const now = performance.now(), dt = Math.min(now - lastTick, 2000);
  lastTick = now;
  if (document.visibilityState !== "visible") return;
  if (logging() && ctx.key && now - lastInput <= ATTENTION_IDLE_MS) {
    entryMs[ctx.key] = (entryMs[ctx.key] ?? 0) + dt;
    if (now - entrySaveAt > 5000) { entrySaveAt = now; chrome.storage.local.set({ studyEntryMs: entryMs }).catch(() => {}); }
  }
  renderBar();
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
  if (document.hasFocus() && document.activeElement?.closest?.(EDITABLE) && !barHost.contains(document.activeElement)) attention.commentFocusMs += dt;
  if (now - lastFlush > 15_000) flushAttention();
}
setInterval(checkUrl, 500);
addEventListener("popstate", checkUrl);

const markInput = () => { lastInput = performance.now(); };
for (const type of ["mousemove", "keydown", "wheel", "pointerdown"]) addEventListener(type, markInput, { capture: true, passive: true });
addEventListener("scroll", () => { attention.scrollPx += Math.abs(scrollY - lastScrollY); lastScrollY = scrollY; markInput(); }, { passive: true });
document.addEventListener("scroll", (e) => { if (e.target !== document) markInput(); }, { capture: true, passive: true });

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushAttention(); snapshot("hidden"); send("visibility", { visible: false });
    chrome.storage.local.set({ studyEntryMs: entryMs }).catch(() => {});
  } else announce();
});
addEventListener("pagehide", () => {
  flushAttention(); snapshot("pagehide"); send("visibility", { visible: false });
  chrome.storage.local.set({ studyEntryMs: entryMs }).catch(() => {});
});

document.addEventListener("mouseover", (e) => {
  const region = regionOf(e.target);
  hover = { region, section: region === "ai_panel" ? sectionOf(e.target) : null };
}, true);
document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) hover = { region: null, section: null }; }, true);

const controlText = (el) => (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").trim().replace(/\s+/g, " ");
// A link that would open a different answer or question (question dropdown, submission list, etc.).
function leadsElsewhere(el) {
  const link = el.closest?.("a[href]");
  if (!link) return false;
  const url = new URL(link.href, location.href);
  return url.origin === location.origin && url.pathname !== location.pathname && /\/(questions|submissions)\//.test(url.pathname);
}

// Registered on window (capture) so a blocked click never reaches Gradescope's own handlers.
addEventListener("click", (e) => {
  if (!logging() || barHost.contains(e.target) || picking) return;
  const control = e.target.closest?.("button, a, [role='button'], [role='menuitem'], [role='option'], summary");
  const label = control ? controlText(control) : "";
  const isNav = control && (NAV_TEXT.test(label) || leadsElsewhere(control));
  if (isNav) {
    if (!leaving && !canLeave()) {
      e.preventDefault(); e.stopImmediatePropagation();
      send("nav_blocked", { control: label.slice(0, 60) });
      showMessage(blockedMessage(), true);
      return;
    }
    flushAttention(); snapshot("navigate");
    send("navigate", { control: label.slice(0, 60) });
    leaving = true; setTimeout(() => { leaving = false; }, 3000);
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
  if (!e.target.closest?.(EDITABLE) || barHost.contains(e.target)) return;
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

// ---- Study bar -------------------------------------------------------------------------------
// A compact bar pinned to the top of every Gradescope grading page (draggable, like a screen-share
// bar). Before a session it offers Start; during one it shows recording state, the open answer
// and its timer, the AI-use buttons, Skip, Pause and End. Pausing also covers the page.

const barHost = document.createElement("div");
const bar = barHost.attachShadow({ mode: "open" });
bar.innerHTML = `
  <style>
    :host { all: initial; }
    /* All bar sizes are in em, so A−/A+ (which change --scale) resize the bar and let it reflow to fit the window. */
    .wrap { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 2147483646; font: calc(12px * var(--scale, 1))/1.3 system-ui, sans-serif;
      display: grid; gap: .33em; justify-items: center; width: max-content; max-width: calc(100vw - 16px); }
    .wrap.moved { transform: none; }
    .bar { display: flex; align-items: center; gap: .5em; flex-wrap: wrap; justify-content: center; padding: .5em .66em; border-radius: .85em;
      background: #202124; color: #e8eaed; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
    .grip { cursor: move; color: #9aa0a6; user-select: none; padding: 0 .15em; letter-spacing: -.15em; }
    .sep { width: 1px; align-self: stretch; background: #5f6368; }
    .overview { color: #bdc1c6; }
    .who { color: #9aa0a6; font-variant-numeric: tabular-nums; }
    .rec { display: flex; align-items: center; gap: .4em; white-space: nowrap; }
    .dot { width: .75em; height: .75em; border-radius: 50%; background: #9aa0a6; }
    .dot.on { background: #f28b82; box-shadow: 0 0 0 .25em rgba(242,139,130,.25); }
    .entry { display: flex; align-items: baseline; gap: .5em; white-space: nowrap; }
    .q { font-weight: 600; max-width: 16em; overflow: hidden; text-overflow: ellipsis; }
    .clock { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 1.17em; color: #fff; }
    .qtotal { color: #9aa0a6; font-variant-numeric: tabular-nums; }
    .ai { display: flex; align-items: center; gap: .33em; }
    .ai .label { color: #bdc1c6; margin-right: .15em; }
    .ai.todo .label { color: #fdd663; font-weight: 600; }
    .tools { display: flex; gap: .25em; }
    button { font: inherit; cursor: pointer; border-radius: .5em; padding: .33em .75em; border: 1px solid #5f6368; background: #3c4043; color: #e8eaed; white-space: nowrap; }
    button:hover { background: #4a4e52; }
    button.choice[aria-pressed="true"] { background: #8ab4f8; border-color: #8ab4f8; color: #202124; font-weight: 600; }
    button.primary { background: #8ab4f8; border-color: #8ab4f8; color: #202124; font-weight: 600; }
    button.end { background: #c5221f; border-color: #c5221f; color: #fff; }
    button.icon { padding: .33em .5em; }
    input { font: inherit; padding: .33em .5em; border-radius: .5em; border: 1px solid #5f6368; background: #303134; color: #e8eaed; width: 24em; max-width: 60vw; }
    .msg, .pending { padding: .5em .85em; border-radius: .66em; background: #fef7e0; color: #3c2a00; box-shadow: 0 2px 8px rgba(0,0,0,.2); display: flex; gap: .5em; align-items: center; flex-wrap: wrap; }
    .pending { background: #fce8e6; color: #5c0b0b; }
    .pending button { background: #fff; color: #202124; border-color: #dadce0; }
    .shake { animation: shake .35s ease-in-out 2; }
    @keyframes shake { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
    .overlay { position: fixed; inset: 0; z-index: 2147483645; background: #202124; color: #e8eaed; display: grid; place-content: center;
      text-align: center; gap: 12px; font: 15px/1.5 system-ui, sans-serif; }
    .overlay b { font-size: 22px; }
    .overlay button { justify-self: center; font-size: 15px; padding: 8px 18px; }
    .paused .full { display: none !important; }
    /* Minimized: only what's needed to move on (AI use) and to step away (Pause). */
    .min > :not(.keep), .min .rec-text, .min .startrec { display: none !important; }
    [hidden] { display: none !important; }
  </style>
  <div class="overlay" hidden><b>Paused</b><div>Grading time and the screen recording are paused,<br>and this page is hidden while you're away.</div><button class="primary resume">Resume grading</button></div>
  <div class="wrap">
    <div class="bar" role="toolbar" aria-label="Grading study">
      <span class="grip keep" title="Drag to move">⋮⋮</span>
      <span data-view="idle"><b>Grading study</b></span>
      <input data-view="idle" class="code" placeholder="Paste your grader ID" maxlength="64" spellcheck="false" aria-label="Grader ID">
      <button data-view="idle" class="primary go">Start session</button>
      <span data-view="live" class="who full" title=""></span>
      <span data-view="live" class="rec keep"><span class="dot"></span><span class="rec-text"></span><button class="startrec" hidden>Start recording</button></span>
      <span data-view="live" class="sep full"></span>
      <span data-view="live" class="overview">Not grading right now. Open a question to grade; timing starts automatically.</span>
      <span data-view="live" data-answer class="entry"><span class="q"></span><span class="clock" title="Time on this answer">00:00</span><span class="qtotal full" title="Total time on this question"></span></span>
      <span data-view="live" data-answer class="sep full"></span>
      <span data-view="live" data-answer class="ai full keep"><span class="label">AI use:</span></span>
      <button data-view="live" data-answer class="skip full" title="Leave this answer for now and come back later">Skip ⏭</button>
      <span data-view="live" class="sep full"></span>
      <button data-view="live" class="pause keep" title="Pause timer and recording">⏸ Pause</button>
      <button data-view="live" class="end" title="End the session and save files">■ End</button>
      <span class="tools"><button class="icon size" data-step="-1" title="Make the bar smaller">A−</button><button class="icon size" data-step="1" title="Make the bar larger">A+</button><button class="icon help" title="How this works">?</button></span>
      <button class="icon min-btn keep" title="Minimize">–</button>
    </div>
    <div class="pending" hidden></div>
    <div class="msg" hidden></div>
  </div>`;
const $b = (sel) => bar.querySelector(sel);
let ui = { minimized: false, left: null, top: null, scale: 1 };
const SCALE_MIN = 0.8, SCALE_MAX = 2;
let endArmed = false;
let msgTimer = null;

$b(".ai").append(...USAGE_OPTIONS.map(([value, text]) => Object.assign(document.createElement("button"), { className: "choice", textContent: text, value })));

function showMessage(text, shake = false) {
  const msg = $b(".msg");
  msg.textContent = text;
  msg.hidden = false;
  if (shake) { const b = $b(".bar"); b.classList.remove("shake"); void b.offsetWidth; b.classList.add("shake"); ui.minimized = false; renderBar(); }
  clearTimeout(msgTimer);
  msgTimer = setTimeout(hideMessage, 6000);
}
function hideMessage() { $b(".msg").hidden = true; }

bar.addEventListener("click", async (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.classList.contains("help")) return command("openTutorial");
  if (button.classList.contains("min-btn")) { ui.minimized = !ui.minimized; chrome.storage.local.set({ barUi: ui }); return renderBar(); }
  if (button.classList.contains("size")) {
    ui.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(((ui.scale ?? 1) + Number(button.dataset.step) * 0.1) * 10) / 10));
    chrome.storage.local.set({ barUi: ui });
    return place();
  }
  if (button.classList.contains("go")) {
    const graderId = $b(".code").value;
    const error = graderIdError(graderId);
    if (error) { showMessage(error, true); return $b(".code").focus(); }
    const result = await command("startSession", { graderId });
    if (result?.error) showMessage(result.error);
    return;
  }
  if (button.classList.contains("startrec")) return command("openRecorder");
  if (button.classList.contains("pause")) {
    if (status.paused) return command("resume");
    flushAttention(); snapshot("pause");
    return command("pause");
  }
  if (button.classList.contains("resume")) return command("resume");
  if (button.classList.contains("skip")) return skip();
  if (button.classList.contains("end")) {
    if (!endArmed) {
      endArmed = true;
      showMessage(isDone(ctx.key) || !ctx.key ? "Click ■ End again to end the session and save your files." : "This answer has no AI-use choice yet. Click ■ End again to end anyway.");
      setTimeout(() => { endArmed = false; }, 5000);
      return;
    }
    endArmed = false;
    flushAttention(); snapshot("session_end");
    await command("endSession");
    showMessage("Session ended. Your recording and logs are being saved to Downloads/grading-study/.");
    return;
  }
  if (button.classList.contains("choice")) {
    const key = button.closest(".pending") ? button.dataset.key : ctx.key;
    if (key) setUsage(key, button.value, key !== ctx.key);
  }
});
bar.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && e.target.classList.contains("code")) $b(".go").click(); });
$b(".grip").addEventListener("mousedown", (e) => {
  const box = $b(".wrap").getBoundingClientRect(), dx = e.clientX - box.left, dy = e.clientY - box.top;
  const move = (m) => { ui.left = Math.max(0, m.clientX - dx); ui.top = Math.max(0, m.clientY - dy); place(); };
  const up = () => { removeEventListener("mousemove", move, true); removeEventListener("mouseup", up, true); chrome.storage.local.set({ barUi: ui }); };
  addEventListener("mousemove", move, true); addEventListener("mouseup", up, true);
  e.preventDefault();
});
function place() {
  $b(".wrap").style.setProperty("--scale", ui.scale ?? 1);
  if (ui.left === null) return;
  $b(".wrap").classList.add("moved");
  Object.assign($b(".wrap").style, { left: `${Math.min(ui.left, innerWidth - 160)}px`, top: `${Math.min(ui.top, innerHeight - 40)}px` });
}
function clock(ms) {
  const s = Math.floor((ms ?? 0) / 1000);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}
const answerLabel = (key) => {
  const [, q, sub] = key.match(/^q?(\w+)-s(\d+)$/) ?? [];
  return q ? `question ${q}, submission ${sub}` : key;
};
const onCoursePage = () => /^\/courses\/\d+/.test(location.pathname);
function renderBar() { try { drawBar(); } catch (err) { reportError("bar", err); } }
function drawBar() {
  if (!onCoursePage()) { barHost.remove(); return; }
  if (!barHost.isConnected) { document.documentElement.append(barHost); place(); }
  const view = !status.active ? "idle" : "live";
  $b(".bar").classList.toggle("min", ui.minimized);
  $b(".min-btn").textContent = ui.minimized ? "⤢" : "–";
  $b(".min-btn").title = ui.minimized ? "Show the full bar" : "Minimize";
  $b(".bar").classList.toggle("paused", status.paused);
  $b(".pause").textContent = status.paused ? "▶ Resume" : "⏸ Pause";
  $b(".pause").classList.toggle("primary", status.paused);
  bar.querySelectorAll("[data-view]").forEach((el) => {
    el.hidden = el.dataset.view !== view || ("answer" in el.dataset && !ctx.key) || (el.classList.contains("overview") && Boolean(ctx.key));
  });
  $b(".overlay").hidden = !(status.active && status.paused);
  if (view === "idle") {
    if (!$b(".code").value && status.graderId) $b(".code").value = status.graderId;
    $b(".pending").hidden = true;
    return;
  }
  $b(".who").textContent = `Grader ${status.graderId.slice(0, 8)}`;
  $b(".who").title = `Grader ID ${status.graderId}`;
  $b(".dot").classList.toggle("on", status.recording);
  $b(".rec-text").textContent = status.recording ? "REC" : status.paused ? "Paused" : "Not recording";
  $b(".startrec").hidden = status.recording || status.paused;
  const q = questionInfo();
  $b(".q").textContent = q ? `Q${q.number} ${q.title}` : `Question ${ctx.ids.question ?? ""}`;
  $b(".q").title = `Submission ${ctx.ids.submission ?? ""}`;
  $b(".clock").textContent = clock(entryMs[ctx.key]);
  const prefix = ctx.ids.question ? `q${ctx.ids.question}-` : null;
  const total = prefix ? Object.entries(entryMs).filter(([k]) => k.startsWith(prefix)).reduce((sum, [, ms]) => sum + ms, 0) : 0;
  $b(".qtotal").textContent = prefix ? `Q total ${clock(total)}` : "";
  const a = answers[ctx.key] ?? {};
  $b(".ai").classList.toggle("todo", !a.usage);
  $b(".ai .label").textContent = a.usage ? "AI use:" : "AI use? ▸";
  bar.querySelectorAll(".bar .choice").forEach((b) => b.setAttribute("aria-pressed", String(a.usage === b.value)));
  // Earlier answers left without an AI-use choice are asked about here, one at a time.
  const missed = pending.find((k) => k !== ctx.key);
  const box = $b(".pending");
  box.hidden = !missed;
  if (missed && box.dataset.key !== missed) {
    box.dataset.key = missed;
    box.replaceChildren(Object.assign(document.createElement("span"), { textContent: `You left ${answerLabel(missed)} without an AI-use answer. What did you do with the AI there?` }),
      ...USAGE_OPTIONS.map(([value, text]) => {
        const b = Object.assign(document.createElement("button"), { className: "choice", textContent: text, value });
        b.dataset.key = missed;
        return b;
      }));
  }
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
    version: chrome.runtime.getManifest().version, barShown: barHost.isConnected,
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

function loadAnswers(saved) {
  answers = saved?.answers ?? {};
  pending = saved?.pending ?? [];
  lastEntry = saved?.lastEntry ?? null;
}
chrome.storage.local.get(["studyStatus", "selectors", "studyAnswers", "studyEntryMs", "barUi"]).then((saved) => {
  status = { ...status, ...saved.studyStatus };
  selectors = { ...DEFAULT_SELECTORS, ...saved.selectors };
  loadAnswers(saved.studyAnswers);
  entryMs = saved.studyEntryMs ?? {};
  ui = { ...ui, ...saved.barUi };
  announce(); renderBar();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.selectors) selectors = { ...DEFAULT_SELECTORS, ...changes.selectors.newValue };
  if (changes.studyAnswers) loadAnswers(changes.studyAnswers.newValue);
  if (changes.studyEntryMs) {
    // Another tab may also be timing answers; keep the larger count for each.
    const incoming = changes.studyEntryMs.newValue ?? {};
    entryMs = Object.keys(incoming).length ? Object.fromEntries([...new Set([...Object.keys(entryMs), ...Object.keys(incoming)])]
      .map((k) => [k, Math.max(entryMs[k] ?? 0, incoming[k] ?? 0)])) : {};
  }
  if (changes.studyStatus) {
    const was = logging();
    status = { ...status, ...changes.studyStatus.newValue };
    if (!was && logging()) announce();
    renderBar();
  }
});
