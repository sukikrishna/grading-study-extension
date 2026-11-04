const $ = (id) => document.getElementById(id);
const send = (kind, data = {}) => chrome.runtime.sendMessage({ kind, ...data });
let view = null;
let clearArmed = false;

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0"), ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}
function notice(text) { $("notice").textContent = text; }

async function recorderTab() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  return contexts.find((c) => c.documentUrl?.startsWith(chrome.runtime.getURL("recorder.html"))) ?? null;
}

async function refresh() {
  view = await send("getState");
  view.recorderOpen = Boolean(await recorderTab());
  render();
}
function render() {
  const active = view.sessionActive;
  $("setup").hidden = active;
  $("active").hidden = !active;
  $("eventCount").textContent = `${view.eventCount} events stored`;
  if (!active) return;
  $("status").textContent = view.paused ? "On break" : "Logging";
  $("status").classList.toggle("paused", view.paused);
  $("sessionTimer").textContent = clock(Date.now() - Date.parse(view.startedAt));
  $("current").textContent = view.current ? `${view.current.key} · ${clock(Date.now() - view.current.since)}` : "Not on an answer";
  $("seen").textContent = view.submissionsSeen;
  const rec = view.recording;
  $("recording").textContent = !rec ? "Off" : !view.recorderOpen ? "Interrupted (recorder tab closed)"
    : rec.paused ? "Paused" : `On since ${new Date(rec.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  $("pause").textContent = view.paused ? "Resume" : "Take a break";
}

async function saveSelector(region, value) {
  const { selectors = {} } = await chrome.storage.local.get("selectors");
  await chrome.storage.local.set({ selectors: { ...selectors, [region]: value } });
}
async function activeTabMessage(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return chrome.tabs.sendMessage(tab.id, msg);
}
async function buildRegions() {
  const { selectors = {} } = await chrome.storage.local.get("selectors");
  const current = { ...DEFAULT_SELECTORS, ...selectors };
  for (const [region, { label }] of Object.entries(REGIONS)) {
    const row = document.createElement("div");
    row.className = "region-row";
    const field = document.createElement("label");
    field.textContent = label;
    const input = document.createElement("input");
    input.value = current[region];
    input.placeholder = "CSS selector (not set)";
    input.addEventListener("change", () => saveSelector(region, input.value.trim()));
    field.append(input);
    const pick = document.createElement("button");
    pick.textContent = "Pick";
    pick.addEventListener("click", async () => {
      try { await activeTabMessage({ kind: "pick", region }); window.close(); }
      catch { notice("Open (or reload) a Gradescope page in this tab first."); }
    });
    row.append(field, pick);
    $("regions").append(row);
  }
}

$("startSession").addEventListener("click", async () => {
  const participant = $("participant").value.trim();
  if (!participant) return notice("Enter the participant code assigned by the study team.");
  const result = await send("startSession", { participant });
  if (result?.error) return notice(result.error);
});
$("openRecorder").addEventListener("click", () => send("openRecorder"));
$("pause").addEventListener("click", async () => { await send(view.paused ? "resume" : "pause"); refresh(); });
$("mark").addEventListener("click", async () => {
  await send("mark", { note: $("markNote").value.trim() });
  $("markNote").value = "";
  notice("Moment marked.");
});
$("endSession").addEventListener("click", async () => {
  await send("endSession");
  await refresh();
  notice("Session ended. The recorder tab is saving the video and log files to Downloads/grading-study/.");
});

$("probe").addEventListener("click", async () => {
  try {
    const result = await activeTabMessage({ kind: "probe" });
    const parts = Object.entries(result.regions).map(([region, { selector, matches, chars }]) =>
      `${REGIONS[region].label}: ${!selector ? "not set" : matches < 0 ? "invalid selector" : matches ? `found ${matches} (${chars} chars)` : "not found"}`);
    const rubric = result.rubric.map((i) => `[${i.applied === null ? "state unreadable" : i.applied ? "APPLIED" : "off"}] ${i.points ?? ""} ${i.text} → ${i.category ?? "no verdict category"}`);
    parts.unshift(`Question: ${result.question ? `${result.question.number}: ${result.question.title}` : "title not found"}`,
      `Autograder Results: ${result.aiResults}`, `AI sections: ${result.sections.length ? result.sections.join(", ") : "none found (expand Autograder Results)"}`);
    parts.push(`Comment boxes: ${result.commentBoxes}`, `Answer: ${result.key ?? "not a grading page"}`, `Rubric items (${rubric.length}):`, ...rubric);
    $("probeResult").textContent = parts.join("\n");
  } catch { $("probeResult").textContent = "Open (or reload) a Gradescope page in this tab first."; }
});

$("export").addEventListener("click", async () => {
  await send("flush");
  const count = await exportLogs();
  notice(count ? `Saved ${count} events and the per-answer summary to Downloads/grading-study/.` : "No events to export yet.");
});
$("clear").addEventListener("click", async () => {
  if (!clearArmed) { clearArmed = true; $("clear").textContent = "Click again to clear"; return; }
  const result = await send("clear");
  clearArmed = false; $("clear").textContent = "Clear logs";
  notice(result?.error ?? "Logs cleared.");
  refresh();
});

(async () => {
  await refresh();
  $("participant").value = view.participant;
  await buildRegions();
  setInterval(refresh, 1000);
})();
