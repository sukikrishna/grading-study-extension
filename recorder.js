// Records the grader's screen with getDisplayMedia + MediaRecorder for the whole session (breaks
// pause the same recording). 10-second pieces go to IndexedDB as they arrive, so a crash or a
// closed tab loses at most a few seconds. When recording stops, the pieces are joined into one
// .webm in Downloads/grading-study/ and, once Chrome confirms the file is written, deleted.
// This tab also saves the session's log files when the session ends.
const $ = (id) => document.getElementById(id);
const CHUNK_MS = 10_000;
const params = new URLSearchParams(location.search);
const returnTab = Number(params.get("return")) || null;
let db = null;
let stream = null;
let recorder = null;
let active = null;
let stopped = null;
let writes = Promise.resolve();
let metaQueue = Promise.resolve();
let armedDelete = null;

function request(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
function openDb() {
  const req = indexedDB.open("grading-study-recordings", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("chunks", { autoIncrement: true }).createIndex("byRecording", "recordingId");
  return request(req);
}
const chunkStore = (mode) => db.transaction("chunks", mode).objectStore("chunks");
const log = (type, data = {}) => chrome.runtime.sendMessage({ kind: "log", event: { type, ...data } }).catch(() => {});
function notice(text) { $("notice").textContent = text; }

async function getMeta() { return (await chrome.storage.local.get("recordings")).recordings ?? []; }
function updateMeta(id, patch) {
  metaQueue = metaQueue.then(async () => {
    const list = await getMeta();
    const i = list.findIndex((r) => r.id === id);
    if (patch === null) { if (i >= 0) list.splice(i, 1); }
    else if (i < 0) list.push({ id, ...patch });
    else list[i] = { ...list[i], ...patch };
    await chrome.storage.local.set({ recordings: list });
  });
  return metaQueue.then(renderList);
}

async function start() {
  const view = await chrome.runtime.sendMessage({ kind: "getState" });
  if (!view?.sessionActive) return notice("Start a session first (from the box on the Gradescope page or the extension icon).");
  if (view.paused) return notice("Resume the session before recording.");
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 5, max: 10 }, displaySurface: "monitor" }, audio: false,
      monitorTypeSurfaces: "include", selfBrowserSurface: "exclude"
    });
  } catch { return notice("Screen sharing was cancelled. Click Start recording to try again."); }
  const track = stream.getVideoTracks()[0];
  const { displaySurface, width, height } = track.getSettings();
  const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const id = `grader-${String(view.graderId).replace(/[^\w-]+/g, "_")}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  active = { id, seq: 0, bytes: 0, startedAt: null, pausedMs: 0, pausedAt: null };
  let finish;
  stopped = new Promise((resolve) => { finish = resolve; });
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_000_000 });
  recorder.onstart = () => {
    active.startedAt = Date.now();
    updateMeta(id, { graderId: view.graderId, folder: view.sessionFolder, startedAt: active.startedAt, mimeType, surface: displaySurface, width, height, bytes: 0 });
    log("recording_started", { recordingId: id, surface: displaySurface, width, height });
    notice(displaySurface !== "monitor"
      ? `You shared a ${displaySurface}, not the entire screen. Stop and restart if the study asks for the full screen.`
      : "Recording. Go back to your Gradescope tab; the study bar is at the top of the page.");
    render();
    const back = view.lastGradescopeTab ?? returnTab; // most recent Gradescope tab; the URL's may be from an earlier session
    if (back) chrome.tabs.update(back, { active: true }).then((tab) => chrome.windows.update(tab.windowId, { focused: true })).catch(() => {});
  };
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    const chunk = { recordingId: id, seq: active.seq++, blob: e.data };
    active.bytes += e.data.size;
    writes = writes.then(() => request(chunkStore("readwrite").add(chunk))).catch((err) => notice(`Could not save video: ${err}`));
    updateMeta(id, { bytes: active.bytes });
  };
  recorder.onstop = async () => {
    await writes;
    const stoppedAt = Date.now();
    if (active.pausedAt) active.pausedMs += stoppedAt - active.pausedAt;
    stream.getTracks().forEach((t) => t.stop());
    log("recording_stopped", { recordingId: id });
    const durationMs = stoppedAt - active.startedAt - active.pausedMs;
    recorder = stream = active = null;
    await updateMeta(id, { stoppedAt, durationMs });
    render();
    await saveRecording((await getMeta()).find((r) => r.id === id));
    finish();
  };
  track.addEventListener("ended", stop);
  recorder.start(CHUNK_MS);
}
function stop() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  return stopped ?? Promise.resolve();
}

// Resolves true once Chrome reports the download finished, false if it failed.
async function downloadFinished(id) {
  return new Promise((resolve) => {
    const done = (state) => { chrome.downloads.onChanged.removeListener(listener); resolve(state === "complete"); };
    const listener = (delta) => { if (delta.id === id && ["complete", "interrupted"].includes(delta.state?.current)) done(delta.state.current); };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([item]) => { if (item && ["complete", "interrupted"].includes(item.state)) done(item.state); });
  });
}
async function clearChunks(recordingId) {
  const keys = await request(chunkStore("readonly").index("byRecording").getAllKeys(recordingId));
  const store = chunkStore("readwrite");
  keys.forEach((key) => store.delete(key));
  await new Promise((resolve, reject) => { store.transaction.oncomplete = resolve; store.transaction.onerror = () => reject(store.transaction.error); });
}
// Joins the pieces into one .webm in Downloads/grading-study/, then deletes the pieces.
async function saveRecording(meta) {
  if (!meta || meta.savedAt) return;
  await writes;
  const rows = await request(chunkStore("readonly").index("byRecording").getAll(meta.id));
  if (!rows.length) return notice("No video data found for this recording.");
  rows.sort((a, b) => a.seq - b.seq);
  const url = URL.createObjectURL(new Blob(rows.map((r) => r.blob), { type: meta.mimeType ?? "video/webm" }));
  const filename = `${meta.folder ?? "grading-study"}/screen-recording.webm`;
  const downloadId = await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
  const ok = await downloadFinished(downloadId);
  URL.revokeObjectURL(url);
  if (!ok) return notice("Saving the video to Downloads failed. Click Save to Downloads to try again; the backup is kept.");
  const [item] = await chrome.downloads.search({ id: downloadId });
  const saved = item?.filename || filename;
  await clearChunks(meta.id);
  await updateMeta(meta.id, { savedAt: Date.now(), filename: saved });
  notice(`Recording saved to ${saved}.`);
}
// After a session: save any recording not yet saved (e.g. the tab was closed mid-recording),
// then the session's log files.
async function finishSession() {
  await stop();
  for (const meta of await getMeta()) if (!meta.savedAt && meta.id !== active?.id) await saveRecording(meta);
  const count = await exportLogs();
  const videos = (await getMeta()).filter((m) => m.savedAt && m.savedAt > Date.now() - 10 * 60_000).length;
  const view = await chrome.runtime.sendMessage({ kind: "getState" });
  notice(`Session saved to Downloads/${view?.sessionFolder ?? "grading-study"}/: ${count} logged events, the answer and question summaries${videos ? `, and ${videos === 1 ? "the screen recording" : `${videos} screen recordings`}` : " (no screen recording was made)"}. Upload that folder to the study drive.`);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.kind === "sessionEnded") finishSession();
  if (msg.kind === "paused" && recorder?.state === "recording") {
    recorder.pause(); active.pausedAt = Date.now();
    log("recording_paused", { recordingId: active.id }); render();
  }
  if (msg.kind === "resumed" && recorder?.state === "paused") {
    recorder.resume(); active.pausedMs += Date.now() - active.pausedAt; active.pausedAt = null;
    log("recording_resumed", { recordingId: active.id }); render();
  }
});

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function render() {
  const state = recorder?.state ?? "inactive";
  $("status").textContent = { recording: "Recording", paused: "Paused (on break)", inactive: "Not recording" }[state];
  $("status").className = `badge ${state === "recording" ? "" : state === "paused" ? "paused" : "idle"}`;
  $("start").disabled = state !== "inactive";
  $("stop").disabled = state === "inactive";
  $("elapsed").textContent = active?.startedAt
    ? clock(Date.now() - active.startedAt - active.pausedMs - (active.pausedAt ? Date.now() - active.pausedAt : 0)) : "";
}
async function renderList() {
  const list = (await getMeta()).sort((a, b) => b.startedAt - a.startedAt);
  $("empty").hidden = list.length > 0;
  $("recordings").replaceChildren(...list.map((meta) => {
    const li = document.createElement("li");
    const when = new Date(meta.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const live = meta.id === active?.id;
    const length = meta.durationMs ? clock(meta.durationMs) : live ? "recording…" : "interrupted, partial file";
    const where = meta.savedAt ? ` · saved to ${meta.filename}` : live ? "" : " · not saved yet";
    const info = document.createElement("span");
    info.textContent = `${(meta.graderId ?? "").slice(0, 8)}… · ${when} · ${length} · ${((meta.bytes ?? 0) / 1e6).toFixed(1)} MB${where}`;
    li.append(info);
    if (!live) {
      if (!meta.savedAt) {
        const save = Object.assign(document.createElement("button"), { textContent: "Save to Downloads" });
        save.addEventListener("click", () => saveRecording(meta));
        li.append(save);
      }
      const remove = Object.assign(document.createElement("button"), { textContent: armedDelete === meta.id ? "Click again to remove" : "Remove" });
      remove.addEventListener("click", () => removeRecording(meta));
      li.append(remove);
    }
    return li;
  }));
}
async function removeRecording(meta) {
  if (armedDelete !== meta.id) { armedDelete = meta.id; return renderList(); }
  armedDelete = null;
  await clearChunks(meta.id);
  await updateMeta(meta.id, null);
  notice(meta.savedAt ? "Removed from this list (the saved file in Downloads is untouched)." : "Recording deleted.");
}

$("start").addEventListener("click", start);
$("stop").addEventListener("click", stop);
addEventListener("beforeunload", (e) => { if (recorder) { e.preventDefault(); e.returnValue = ""; } });

(async () => {
  db = await openDb();
  render();
  renderList();
  setInterval(render, 1000);
  if (params.get("ended")) finishSession();
})();
