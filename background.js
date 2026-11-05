// Single writer for the event log. Content scripts, the popup and the recorder tab all send
// messages here so events are appended in one place and in order.
importScripts("config.js");
const IDLE_SECONDS = 120;
let state = null;
let ready = null;
let saveTimer = null;
let saving = Promise.resolve();

function load() {
  ready ??= chrome.storage.local.get("studyState").then(({ studyState }) => {
    state = studyState ?? { sessionActive: false, events: [] };
  });
  return ready;
}
function persist() {
  clearTimeout(saveTimer); saveTimer = null;
  saving = saving.then(() => chrome.storage.local.set({ studyState: state }));
  return saving;
}
function scheduleSave() { saveTimer ??= setTimeout(persist, 1000); }
function publishStatus() {
  return chrome.storage.local.set({ studyStatus: {
    active: Boolean(state.sessionActive), paused: Boolean(state.paused),
    recording: Boolean(state.recording && !state.recording.paused), graderId: state.graderId ?? ""
  } });
}
function addEvent(type, data = {}) {
  const t = Date.now();
  state.events.push({ t, ts: new Date(t).toISOString(), graderId: state.graderId ?? null, sessionId: state.sessionId ?? null, type, ...data });
}
// Downloads/grading-study/grader-<ID>/<local start date>_<time>/ holds everything from one session.
function sessionFolder(graderId, start) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}_${pad(start.getHours())}-${pad(start.getMinutes())}-${pad(start.getSeconds())}`;
  return `grading-study/grader-${graderId.replace(/[^\w-]+/g, "_")}/${stamp}`;
}
function broadcast(kind) { chrome.runtime.sendMessage({ kind }).catch(() => {}); }

const RECORDER_URL = chrome.runtime.getURL("recorder.html");
async function recorderTab() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  return contexts.find((c) => c.documentUrl?.startsWith(RECORDER_URL)) ?? null;
}
// Opens (or focuses) the pinned recorder tab. `returnTab` is the Gradescope tab to switch back to
// once sharing starts; `ended` asks a freshly opened recorder to save the session's logs.
async function openRecorder({ returnTab = null, ended = false, focus = true } = {}) {
  const existing = await recorderTab();
  if (existing) {
    if (focus) { await chrome.tabs.update(existing.tabId, { active: true }); await chrome.windows.update(existing.windowId, { focused: true }); }
    return;
  }
  const params = new URLSearchParams({ ...(returnTab ? { return: returnTab } : {}), ...(ended ? { ended: "1" } : {}) });
  await chrome.tabs.create({ url: `${RECORDER_URL}?${params}`, pinned: true, active: focus });
}

const handlers = {
  getState: () => ({
    sessionActive: Boolean(state.sessionActive), paused: Boolean(state.paused), graderId: state.graderId ?? "",
    startedAt: state.startedAt ?? null,
    current: state.current ?? null, submissionsSeen: state.submissionsSeen?.length ?? 0, recording: state.recording ?? null,
    eventCount: state.events.length, sessionFolder: state.sessionFolder ?? null, lastGradescopeTab: state.lastGradescopeTab ?? null
  }),

  flush: () => persist().then(() => ({ ok: true })),

  seenGradescope: (_msg, sender) => { state.lastGradescopeTab = sender.tab?.id ?? state.lastGradescopeTab; return { ok: true }; },

  async startSession({ graderId }, sender) {
    const error = graderIdError(graderId);
    if (error) return { error };
    graderId = normalizeGraderId(graderId);
    if (state.sessionActive) return { error: "A session is already active." };
    Object.assign(state, {
      sessionActive: true, sessionId: crypto.randomUUID(), graderId, captureText: true,
      startedAt: new Date().toISOString(), paused: false, current: null, recording: null, submissionsSeen: []
    });
    state.sessionFolder = sessionFolder(graderId, new Date(state.startedAt));
    addEvent("session_started", { graderId, sessionFolder: state.sessionFolder, extensionVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
    await persist(); await publishStatus();
    await chrome.storage.local.remove(["studyAnswers", "studyEntryMs"]);
    const fromGradescope = sender.tab && /^https:\/\/([\w-]+\.)?gradescope\.com\//.test(sender.url ?? "");
    await openRecorder({ returnTab: fromGradescope ? sender.tab.id : state.lastGradescopeTab ?? null });
    return { ok: true };
  },

  async endSession() {
    if (!state.sessionActive) return { ok: true };
    addEvent("session_ended");
    Object.assign(state, { sessionActive: false, paused: false, current: null });
    await persist(); await publishStatus();
    // The recorder tab stops the video and saves the log files; open one if it was closed.
    if (await recorderTab()) broadcast("sessionEnded");
    else await openRecorder({ ended: true, focus: false });
    return { ok: true };
  },

  async pause() {
    if (!state.sessionActive || state.paused) return { ok: true };
    addEvent("paused"); state.paused = true;
    await persist(); await publishStatus(); broadcast("paused");
    return { ok: true };
  },

  async resume() {
    if (!state.sessionActive || !state.paused) return { ok: true };
    state.paused = false; addEvent("resumed");
    await persist(); await publishStatus(); broadcast("resumed");
    return { ok: true };
  },

  async mark({ note }) {
    if (!state.sessionActive) return { ok: false };
    addEvent("marker", { note: note || null, currentKey: state.current?.key ?? null });
    await persist();
    return { ok: true };
  },

  log({ event }, sender) {
    // Recording events are always kept so the video timeline can be reconstructed.
    const isRecording = event.type.startsWith("recording_");
    if (!isRecording && (!state.sessionActive || state.paused)) return { logged: false };
    const tabId = sender.tab?.id ?? null;
    if (event.type === "page_context") {
      state.lastGradescopeTab = tabId;
      const key = event.key ?? null;
      if (key === (state.current?.key ?? null) && (!key || tabId === state.current.tabId)) return { logged: false };
      state.current = key ? { key, tabId, since: Date.now() } : null;
      if (key && !state.submissionsSeen.includes(key)) state.submissionsSeen.push(key);
      addEvent("page_changed", { tabId, key, ids: event.ids, path: event.path });
    } else {
      if (event.type === "recording_started") state.recording = { id: event.recordingId, startedAt: Date.now(), paused: false };
      if (event.type === "recording_paused" && state.recording) state.recording.paused = true;
      if (event.type === "recording_resumed" && state.recording) state.recording.paused = false;
      if (event.type === "recording_stopped") state.recording = null;
      addEvent(event.type, { ...event, tabId });
      if (isRecording) publishStatus();
    }
    scheduleSave();
    return { logged: true };
  },

  openRecorder: () => openRecorder().then(() => ({ ok: true })),
  openTutorial: () => chrome.tabs.create({ url: chrome.runtime.getURL("tutorial.html") }).then(() => ({ ok: true })),

  async clear() {
    if (state.sessionActive) return { error: "End the session before clearing logs." };
    state = { sessionActive: false, events: [], graderId: state.graderId };
    await persist();
    await chrome.storage.local.remove(["studyAnswers", "studyEntryMs"]);
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = handlers[msg.kind];
  if (!handler) return false;
  load().then(() => handler(msg, sender)).then(reply, (err) => reply({ error: String(err) }));
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("tutorial.html") });
});

chrome.idle.setDetectionInterval(IDLE_SECONDS);
chrome.idle.onStateChanged.addListener((idleState) => load().then(() => {
  if (!state.sessionActive || state.paused) return;
  addEvent("idle_state", { state: idleState });
  scheduleSave();
}));
