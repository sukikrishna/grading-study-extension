// Single writer for the event log. Content scripts, the popup and the recorder tab all send
// messages here so events are appended in one place and in order.
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
    recording: Boolean(state.recording && !state.recording.paused), participant: state.participant ?? ""
  } });
}
function addEvent(type, data = {}) {
  const t = Date.now();
  state.events.push({ t, ts: new Date(t).toISOString(), sessionId: state.sessionId ?? null, type, ...data });
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
    sessionActive: Boolean(state.sessionActive), paused: Boolean(state.paused), participant: state.participant ?? "",
    startedAt: state.startedAt ?? null,
    current: state.current ?? null, submissionsSeen: state.submissionsSeen?.length ?? 0, recording: state.recording ?? null,
    eventCount: state.events.length
  }),

  flush: () => persist().then(() => ({ ok: true })),

  async startSession({ participant }, sender) {
    if (state.sessionActive) return { error: "A session is already active." };
    Object.assign(state, {
      sessionActive: true, sessionId: crypto.randomUUID(), participant, captureText: true,
      startedAt: new Date().toISOString(), paused: false, current: null, recording: null, submissionsSeen: []
    });
    addEvent("session_started", { participant, extensionVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
    await persist(); await publishStatus();
    await chrome.storage.local.remove("checkins");
    await openRecorder({ returnTab: sender.tab?.id ?? null });
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

  async clear() {
    if (state.sessionActive) return { error: "End the session before clearing logs." };
    state = { sessionActive: false, events: [], participant: state.participant };
    await persist();
    await chrome.storage.local.remove("checkins");
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = handlers[msg.kind];
  if (!handler) return false;
  load().then(() => handler(msg, sender)).then(reply, (err) => reply({ error: String(err) }));
  return true;
});

chrome.idle.setDetectionInterval(IDLE_SECONDS);
chrome.idle.onStateChanged.addListener((idleState) => load().then(() => {
  if (!state.sessionActive || state.paused) return;
  addEvent("idle_state", { state: idleState });
  scheduleSave();
}));
