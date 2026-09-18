const DEFAULTS = {
  thinkSites: [],
  blockedSites: [],
  waitSeconds: 30,
  youtubeDistractionEnabled: true,
  youtubeHideHomeFeed: true,
  youtubeHideRelated: true,
  youtubeHideShorts: true,
  youtubeHideComments: true,
  youtubeHideEndscreen: true,
  youtubeHideTrending: true,
  youtubeDisableAutoplay: true,
  youtubeDislikeEnabled: true,
  convertCaseEnabled: true
};
const MIN_WAIT_SECONDS = 1;
const MAX_WAIT_SECONDS = 600;

const $ = id => document.getElementById(id);
const timerBadge = $("timerBadge");
const waitSecondsInput = $("waitSeconds");
const saveWaitButton = $("saveWait");
const waitStatus = $("waitStatus");
const status = $("status");
const siteInput = $("siteInput");
const addThink = $("addThink");
const addBlock = $("addBlock");
const thinkCount = $("thinkCount");
const blockedCount = $("blockedCount");
const thinkList = $("thinkList");
const blockedList = $("blockedList");
const saveToast = $("saveToast");

const toolIds = [
  "youtubeDistractionEnabled",
  "youtubeHideHomeFeed",
  "youtubeHideRelated",
  "youtubeHideShorts",
  "youtubeHideComments",
  "youtubeHideEndscreen",
  "youtubeHideTrending",
  "youtubeDisableAutoplay",
  "youtubeDislikeEnabled",
  "convertCaseEnabled"
];

function unique(list) { return [...new Set(list)]; }

function normalizeHost(input) {
  if (!input) return "";
  let value = String(input).trim().toLowerCase().replace(/^\*:\/\//, "").replace(/^\*\.\//, "");
  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(candidate).hostname.replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return value.split("/")[0].split(":")[0].replace(/^www\./, "").replace(/\.$/, "");
  }
}

function showStatus(text, isError = false) {
  status.textContent = text;
  status.style.color = isError ? "#ff9ea8" : "#aeb7c7";
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => { status.textContent = ""; }, 3200);
}

function showWaitStatus(text, isError = false) {
  waitStatus.textContent = text;
  waitStatus.style.color = isError ? "#ff9ea8" : "#aeb7c7";
  clearTimeout(showWaitStatus.timer);
  showWaitStatus.timer = setTimeout(() => { waitStatus.textContent = ""; }, 3200);
}


function showSaveToast(text = "Settings saved.", isError = false) {
  saveToast.textContent = text;
  saveToast.classList.toggle("error", isError);
  saveToast.classList.add("show");
  clearTimeout(showSaveToast.timer);
  showSaveToast.timer = setTimeout(() => saveToast.classList.remove("show"), 2200);
}

async function readSettings() {
  const data = await chrome.storage.local.get(DEFAULTS);
  return {
    thinkSites: Array.isArray(data.thinkSites) ? unique(data.thinkSites) : [],
    blockedSites: Array.isArray(data.blockedSites) ? unique(data.blockedSites) : [],
    waitSeconds: Math.round(Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, Number(data.waitSeconds) || DEFAULTS.waitSeconds))),
    youtubeDistractionEnabled: data.youtubeDistractionEnabled !== false,
    youtubeHideHomeFeed: data.youtubeHideHomeFeed !== false,
    youtubeHideRelated: data.youtubeHideRelated !== false,
    youtubeHideShorts: data.youtubeHideShorts !== false,
    youtubeHideComments: data.youtubeHideComments !== false,
    youtubeHideEndscreen: data.youtubeHideEndscreen !== false,
    youtubeHideTrending: data.youtubeHideTrending !== false,
    youtubeDisableAutoplay: data.youtubeDisableAutoplay !== false,
    youtubeDislikeEnabled: data.youtubeDislikeEnabled !== false,
    convertCaseEnabled: data.convertCaseEnabled !== false
  };
}

async function saveAll(next) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "saveSettings", ...next });
  } catch (error) {
    throw new Error(error?.message || "Could not save settings.");
  }
  if (!response?.ok) throw new Error(response?.error || "Could not save settings.");
  showSaveToast("Settings saved.");
  return response;
}

async function addSite(kind) {
  try {
    const value = normalizeHost(siteInput.value);
    if (!value) return showStatus("Enter a valid website domain or URL.", true);
    const settings = await readSettings();
    const target = kind === "think" ? settings.thinkSites : settings.blockedSites;
    if (target.includes(value)) return showStatus("That website is already on the list.", true);
    if (kind === "think") settings.thinkSites = unique([...target, value]);
    else settings.blockedSites = unique([...target, value]);
    await saveAll(settings);
    siteInput.value = "";
    showStatus(`${value} added to the ${kind === "think" ? "think" : "block"} list.`);
    await refresh();
  } catch (error) {
    showStatus(error?.message || "Could not save the website.", true);
    showSaveToast(error?.message || "Could not save settings.", true);
  }
}

async function removeEntry(kind, value) {
  try {
    const settings = await readSettings();
    if (kind === "think") settings.thinkSites = settings.thinkSites.filter(item => item !== value);
    if (kind === "blocked") settings.blockedSites = settings.blockedSites.filter(item => item !== value);
    await saveAll(settings);
    await refresh();
  } catch (error) {
    showStatus(error?.message || "Could not save the change.", true);
    showSaveToast(error?.message || "Could not save settings.", true);
  }
}

function renderList(container, entries, kind) {
  container.textContent = "";
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = kind === "think" ? "No thinking sites yet." : "No blocked sites yet.";
    container.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "item";
    const domain = document.createElement("div");
    domain.className = "domain";
    domain.textContent = entry;
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => void removeEntry(kind, entry));
    item.append(domain, remove);
    container.appendChild(item);
  }
}

async function saveWait() {
  try {
    const value = Number(waitSecondsInput.value);
    if (!Number.isFinite(value)) return showWaitStatus("Enter a number between 1 and 600.", true);
    const settings = await readSettings();
    settings.waitSeconds = Math.round(Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, value)));
    await saveAll(settings);
    waitSecondsInput.value = String(settings.waitSeconds);
    timerBadge.textContent = `${settings.waitSeconds} sec pause`;
    showWaitStatus(`Thinking time set to ${settings.waitSeconds} seconds.`);
  } catch (error) {
    showWaitStatus(error?.message || "Could not save thinking time.", true);
    showSaveToast(error?.message || "Could not save settings.", true);
  }
}


async function saveYouTubeSettings() {
  try {
    const settings = await readSettings();
    for (const id of toolIds.filter(key => key.startsWith("youtube"))) settings[id] = $(id).checked;
    await saveAll(settings);
    showStatus("YouTube tool settings saved.");
  } catch (error) {
    showStatus(error?.message || "Could not save YouTube settings.", true);
    showSaveToast(error?.message || "Could not save settings.", true);
  }
}

async function saveConvertCase() {
  try {
    const settings = await readSettings();
    settings.convertCaseEnabled = $("convertCaseEnabled").checked;
    await saveAll(settings);
    showStatus(settings.convertCaseEnabled ? "Convert Case is enabled in the right-click menu." : "Convert Case is disabled.");
  } catch (error) {
    showStatus(error?.message || "Could not save Convert Case settings.", true);
    showSaveToast(error?.message || "Could not save settings.", true);
  }
}

function loadToolControls(settings) {
  for (const id of toolIds) $(id).checked = Boolean(settings[id]);
}

function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remaining = mins % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function getDateKeyFromDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDayLabel(key) {
  const d = new Date(`${key}T00:00:00`);
  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(d);
}

function sumDay(usage, key) {
  const day = usage[key] || {};
  return Object.values(day).reduce((total, seconds) => total + Number(seconds || 0), 0);
}

function getLastDays(count) {
  const result = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    result.push(getDateKeyFromDate(d));
  }
  return result;
}

function buildWeeklySeries(usage, count = 8) {
  const result = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = count - 1; i >= 0; i--) {
    const end = new Date(today);
    end.setDate(end.getDate() - i * 7);
    let total = 0;
    for (let offset = 0; offset < 7; offset++) {
      const d = new Date(end);
      d.setDate(end.getDate() - (6 - offset));
      total += sumDay(usage, getDateKeyFromDate(d));
    }
    result.push({ label: `${end.getMonth() + 1}/${end.getDate()}`, value: total });
  }
  return result;
}

function buildMonthlySeries(usage, count = 6) {
  const result = [];
  const current = new Date();
  current.setDate(1);
  current.setHours(0, 0, 0, 0);
  for (let i = count - 1; i >= 0; i--) {
    const month = new Date(current.getFullYear(), current.getMonth() - i, 1);
    let total = 0;
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= days; day++) total += sumDay(usage, getDateKeyFromDate(new Date(month.getFullYear(), month.getMonth(), day)));
    result.push({ label: new Intl.DateTimeFormat(undefined, { month: "short" }).format(month), value: total });
  }
  return result;
}

function renderBarChart(container, items) {
  container.textContent = "";
  const max = Math.max(1, ...items.map(item => item.value));
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "bar-item";
    const label = document.createElement("div");
    label.className = "bar-label";
    label.textContent = item.label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${item.value ? Math.max(5, (item.value / max) * 100) : 0}%`;
    track.appendChild(fill);
    const value = document.createElement("div");
    value.className = "bar-value";
    value.textContent = formatDuration(item.value);
    row.append(label, track, value);
    container.appendChild(row);
  }
}

function renderTodaySites(usage) {
  const todayKey = getDateKeyFromDate(new Date());
  const today = usage[todayKey] || {};
  const entries = Object.entries(today).sort((a, b) => Number(b[1]) - Number(a[1]));
  const total = entries.reduce((sum, [, value]) => sum + Number(value || 0), 0);
  $("todayTotal").textContent = `${formatDuration(total)} total active time today`;
  const container = $("todaySites");
  container.textContent = "";
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No web usage recorded yet today.";
    container.appendChild(empty);
    return;
  }
  const max = Math.max(1, ...entries.map(([, seconds]) => Number(seconds)));
  for (const [host, seconds] of entries.slice(0, 25)) {
    const row = document.createElement("div");
    row.className = "usage-row";
    const label = document.createElement("div");
    label.className = "usage-domain";
    label.textContent = host;
    const track = document.createElement("div");
    track.className = "usage-track";
    const fill = document.createElement("div");
    fill.className = "usage-fill";
    fill.style.width = `${Math.max(4, (Number(seconds) / max) * 100)}%`;
    track.appendChild(fill);
    const value = document.createElement("div");
    value.className = "usage-value";
    value.textContent = formatDuration(seconds);
    row.append(label, track, value);
    container.appendChild(row);
  }
}

async function loadUsage() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "getUsage" });
    const usage = response?.usage || {};
    renderBarChart($("dailyChart"), getLastDays(7).map(key => ({ label: formatDayLabel(key), value: sumDay(usage, key) })));
    renderBarChart($("weeklyChart"), buildWeeklySeries(usage));
    renderBarChart($("monthlyChart"), buildMonthlySeries(usage));
    renderTodaySites(usage);
  } catch {
    renderTodaySites({});
  }
}


async function refresh() {
  const settings = await readSettings();
  thinkCount.textContent = String(settings.thinkSites.length);
  blockedCount.textContent = String(settings.blockedSites.length);
  waitSecondsInput.value = String(settings.waitSeconds);
  timerBadge.textContent = `${settings.waitSeconds} sec pause`;
  renderList(thinkList, settings.thinkSites, "think");
  renderList(blockedList, settings.blockedSites, "blocked");
  loadToolControls(settings);
  await loadUsage();
}

addThink.addEventListener("click", () => void addSite("think"));
addBlock.addEventListener("click", () => void addSite("blocked"));
saveWaitButton.addEventListener("click", () => void saveWait());
addThink.addEventListener("click", () => void addSite("think"));
addBlock.addEventListener("click", () => void addSite("blocked"));
saveWaitButton.addEventListener("click", () => void saveWait());
$("saveYoutubeDistraction").addEventListener("click", () => void saveYouTubeSettings());
$("saveYoutubeDislike").addEventListener("click", () => void saveYouTubeSettings());
$("saveConvertCase").addEventListener("click", () => void saveConvertCase());
siteInput.addEventListener("keydown", event => { if (event.key === "Enter") void addSite("think"); });
waitSecondsInput.addEventListener("keydown", event => { if (event.key === "Enter") void saveWait(); });
$("refreshUsage").addEventListener("click", () => void loadUsage());

chrome.storage.onChanged.addListener(changes => {
  const relevant = [
    "thinkSites", "blockedSites", "waitSeconds",
    "youtubeDistractionEnabled", "youtubeHideHomeFeed", "youtubeHideRelated", "youtubeHideShorts", "youtubeHideComments",
    "youtubeHideEndscreen", "youtubeHideTrending", "youtubeDisableAutoplay", "youtubeDislikeEnabled", "convertCaseEnabled"
  ];
  if (relevant.some(key => changes[key])) void refresh();
});

void refresh();
setInterval(() => { void loadUsage(); }, 30_000);
