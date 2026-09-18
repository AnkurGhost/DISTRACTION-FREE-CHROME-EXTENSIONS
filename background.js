const DEFAULT_SETTINGS = {
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

const BYPASS_KEY = "temporaryBypass";
const USAGE_KEY = "usageByDay";
const ACTIVE_KEY = "activeUsageSession";
const USAGE_ALARM = "usageTick";
const SESSION_KEY = "sessionState";
const SESSION_ALARM = "sessionExpiry";
const SESSION_DURATIONS = [1, 5, 10, 20, 30];
const SESSION_UNLOCK_PHRASE = "I understand that my session has ended and I am intentionally starting a new timed session.";
const MIN_WAIT_SECONDS = 1;
const MAX_WAIT_SECONDS = 600;
const USAGE_RETENTION_DAYS = 180;
const CONTEXT_MENU_PARENT = "tbo-convert-case";
const IMAGE_MENU_PARENT = "tbo-save-image-as";
const IMAGE_MENU_ITEMS = {
  png: { mime: "image/png", extension: "png" },
  jpg: { mime: "image/jpeg", extension: "jpg" },
  webp: { mime: "image/webp", extension: "webp" },
  bmp: { mime: "image/bmp", extension: "bmp" }
};
const DISLIKE_CACHE_TTL_MS = 10 * 60 * 1000;

let usageQueue = Promise.resolve();
const dislikeCache = new Map();

function enqueueUsage(task) {
  usageQueue = usageQueue.then(task).catch(() => {});
  return usageQueue;
}

function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function normalizeHost(input) {
  if (!input) return "";
  let value = String(input).trim().toLowerCase();
  value = value.replace(/^\*:??\/\//, "").replace(/^\*\./, "");
  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(candidate);
    return url.hostname.replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    value = value.split("/")[0].split(":")[0];
    return value.replace(/^www\./, "").replace(/\.$/, "");
  }
}

function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostMatches(hostname, ruleHost) {
  const host = normalizeHost(hostname);
  const rule = normalizeHost(ruleHost);
  return Boolean(host && rule && (host === rule || host.endsWith(`.${rule}`)));
}

function normalizeSites(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(normalizeHost).filter(Boolean))];
}

function normalizeWaitSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.waitSeconds;
  return Math.round(Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, n)));
}


function toBoolean(value, fallback) {
  return value === undefined ? fallback : Boolean(value);
}

async function getSettings() {
  const data = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    thinkSites: normalizeSites(data.thinkSites),
    blockedSites: normalizeSites(data.blockedSites),
    waitSeconds: normalizeWaitSeconds(data.waitSeconds),
    youtubeDistractionEnabled: toBoolean(data.youtubeDistractionEnabled, true),
    youtubeHideHomeFeed: toBoolean(data.youtubeHideHomeFeed, true),
    youtubeHideRelated: toBoolean(data.youtubeHideRelated, true),
    youtubeHideShorts: toBoolean(data.youtubeHideShorts, true),
    youtubeHideComments: toBoolean(data.youtubeHideComments, true),
    youtubeHideEndscreen: toBoolean(data.youtubeHideEndscreen, true),
    youtubeHideTrending: toBoolean(data.youtubeHideTrending, true),
    youtubeDisableAutoplay: toBoolean(data.youtubeDisableAutoplay, true),
    youtubeDislikeEnabled: toBoolean(data.youtubeDislikeEnabled, true),
    convertCaseEnabled: toBoolean(data.convertCaseEnabled, true)
  };
}

async function getSessionState() {
  const data = await chrome.storage.local.get({
    [SESSION_KEY]: { configured: false, durationMinutes: 0, startedAt: 0, endsAt: 0, locked: false, unlockPhrase: "" }
  });
  return data[SESSION_KEY] || { configured: false, durationMinutes: 0, startedAt: 0, endsAt: 0, locked: false, unlockPhrase: "" };
}

function normalizeSessionMinutes(value) {
  const n = Number(value);
  return SESSION_DURATIONS.includes(n) ? n : 5;
}

async function setSessionState(state) {
  await chrome.storage.local.set({ [SESSION_KEY]: state });
}

async function startSession(durationMinutes) {
  const minutes = normalizeSessionMinutes(durationMinutes);
  const now = Date.now();
  const session = {
    configured: true,
    durationMinutes: minutes,
    startedAt: now,
    endsAt: now + minutes * 60_000,
    locked: false,
    unlockPhrase: ""
  };
  await chrome.alarms.clear(SESSION_ALARM);
  await setSessionState(session);
  await chrome.alarms.create(SESSION_ALARM, { when: session.endsAt });
  return session;
}

function sessionLockUrl(targetUrl) {
  const query = new URLSearchParams({ mode: "sessionLocked", target: targetUrl });
  return chrome.runtime.getURL(`interstitial.html?${query.toString()}`);
}

async function redirectThinkTabToSessionLock(tabId, targetUrl) {
  try {
    await chrome.tabs.update(tabId, { url: sessionLockUrl(targetUrl) });
  } catch {}
}

async function reopenLockedTabsForHost(hostname, excludeTabId = null) {
  const normalized = normalizeHost(hostname);
  if (!normalized) return;
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (!tab?.id || tab.id === excludeTabId || !tab.url) return;
    if (!tab.url.startsWith(chrome.runtime.getURL("interstitial.html"))) return;
    try {
      const url = new URL(tab.url);
      if (url.searchParams.get("mode") !== "sessionLocked") return;
      const target = url.searchParams.get("target") || "";
      if (!isWebUrl(target) || normalizeHost(getHostname(target)) !== normalized) return;
      await allowOneNavigation(tab.id, target);
      await chrome.tabs.update(tab.id, { url: target });
    } catch {}
  }));
}

async function lockOpenThinkTabs() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (!tab?.id || !tab.url) return;
    let target = "";
    if (isWebUrl(tab.url)) {
      if (settings.thinkSites.some(rule => hostMatches(getHostname(tab.url), rule))) target = tab.url;
    } else if (tab.url.startsWith(chrome.runtime.getURL("interstitial.html"))) {
      try {
        const url = new URL(tab.url);
        if (url.searchParams.get("mode") === "think") {
          const candidate = url.searchParams.get("target") || "";
          if (isWebUrl(candidate) && settings.thinkSites.some(rule => hostMatches(getHostname(candidate), rule))) target = candidate;
        }
      } catch {}
    }
    if (target) await redirectThinkTabToSessionLock(tab.id, target);
  }));
}

async function lockExpiredSession() {
  const current = await getSessionState();
  if (!current?.configured || current.locked) return current;
  if (!current.endsAt || current.endsAt > Date.now()) return current;
  const locked = { ...current, locked: true, lockedAt: Date.now(), unlockPhrase: SESSION_UNLOCK_PHRASE };
  await setSessionState(locked);
  await chrome.alarms.clear(SESSION_ALARM);
  await lockOpenThinkTabs();
  return locked;
}

async function ensureSessionState() {
  const current = await getSessionState();
  if (current?.configured && !current.locked && current.endsAt && current.endsAt <= Date.now()) return lockExpiredSession();
  return current;
}

async function getBypasses() {
  const data = await chrome.storage.session.get({ [BYPASS_KEY]: {} });
  return data[BYPASS_KEY] || {};
}

async function setBypasses(bypasses) {
  await chrome.storage.session.set({ [BYPASS_KEY]: bypasses });
}

async function hasTemporaryOpenBypass(tabId, url) {
  const bypasses = await getBypasses();
  const item = bypasses[String(tabId)];
  if (!item) return false;
  if (item.expiresAt && Date.now() > item.expiresAt) {
    delete bypasses[String(tabId)];
    await setBypasses(bypasses);
    return false;
  }
  return hostMatches(getHostname(url), item.hostname);
}

async function allowOneNavigation(tabId, targetUrl) {
  const hostname = getHostname(targetUrl);
  if (!hostname) return;
  const bypasses = await getBypasses();
  bypasses[String(tabId)] = {
    hostname,
    createdAt: Date.now(),
    expiresAt: Date.now() + 15_000
  };
  await setBypasses(bypasses);
}

async function classifyUrl(url) {
  if (!isWebUrl(url)) return "none";
  const hostname = getHostname(url);
  if (!hostname) return "none";
  const settings = await getSettings();

  if (settings.blockedSites.some(rule => hostMatches(hostname, rule))) return "blocked";

  if (settings.thinkSites.some(rule => hostMatches(hostname, rule))) {
    return "think";
  }

  return "none";
}

function interstitialUrl(mode, targetUrl, waitSeconds = 30) {
  const query = new URLSearchParams({ mode, target: targetUrl, wait: String(waitSeconds) });
  return chrome.runtime.getURL(`interstitial.html?${query.toString()}`);
}

async function handleNavigation(tabId, url) {
  if (!isWebUrl(url)) return;
  if (url.startsWith(chrome.runtime.getURL(""))) return;
  if (await hasTemporaryOpenBypass(tabId, url)) return;

  const mode = await classifyUrl(url);
  if (mode === "none") return;

  const settings = await getSettings();
  if (mode === "think") {
    const session = await ensureSessionState();
    if (session?.locked) {
      await redirectThinkTabToSessionLock(tabId, url);
      return;
    }
  }
  try {
    await chrome.tabs.update(tabId, { url: interstitialUrl(mode, url, settings.waitSeconds) });
  } catch {
    // Ignore tabs that disappear between the navigation event and redirect.
  }
}

function isTrackableWebUrl(url) {
  return isWebUrl(url) && !url.startsWith(chrome.runtime.getURL(""));
}

async function getUsage() {
  const data = await chrome.storage.local.get({ [USAGE_KEY]: {} });
  return data[USAGE_KEY] || {};
}

async function setUsage(usage) {
  await chrome.storage.local.set({ [USAGE_KEY]: usage });
}

function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysAgoKey(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return dateKey(d);
}

function pruneUsage(usage) {
  const cutoff = daysAgoKey(USAGE_RETENTION_DAYS);
  for (const key of Object.keys(usage)) {
    if (key < cutoff) delete usage[key];
  }
  return usage;
}

async function getActiveUsageSession() {
  const data = await chrome.storage.local.get({ [ACTIVE_KEY]: null });
  return data[ACTIVE_KEY];
}

async function setActiveUsageSession(session) {
  await chrome.storage.local.set({ [ACTIVE_KEY]: session });
}

async function addUsage(hostname, seconds) {
  if (!hostname || seconds <= 0) return;
  const usage = pruneUsage(await getUsage());
  const day = dateKey();
  if (!usage[day]) usage[day] = {};
  usage[day][hostname] = Number(usage[day][hostname] || 0) + seconds;
  await setUsage(usage);
}

async function syncUsageWithCurrentTab() {
  const now = Date.now();
  const old = await getActiveUsageSession();
  if (old?.focused && old.hostname && old.lastAt) {
    const elapsed = Math.max(0, (now - old.lastAt) / 1000);
    if (dateKey(new Date(old.lastAt)) === dateKey(new Date(now))) {
      await addUsage(old.hostname, elapsed);
    }
  }

  let next = { focused: false, tabId: null, hostname: "", lastAt: now };
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win && win.focused && win.id !== chrome.windows.WINDOW_ID_NONE) {
      const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
      const tab = tabs[0];
      const hostname = tab && isTrackableWebUrl(tab.url) ? getHostname(tab.url) : "";
      if (tab && hostname) next = { focused: true, tabId: tab.id, hostname, lastAt: now };
    }
  } catch {
    // Ignore browser shutdown/empty-window states.
  }
  await setActiveUsageSession(next);
}

async function recordAndPauseUsage() {
  const old = await getActiveUsageSession();
  const now = Date.now();
  if (old?.focused && old.hostname && old.lastAt && dateKey(new Date(old.lastAt)) === dateKey()) {
    const elapsed = Math.max(0, (now - old.lastAt) / 1000);
    await addUsage(old.hostname, elapsed);
  }
  await setActiveUsageSession({ focused: false, tabId: null, hostname: "", lastAt: now });
}

async function ensureUsageAlarm() {
  try {
    await chrome.alarms.create(USAGE_ALARM, { periodInMinutes: 0.5 });
  } catch {}
}

function videoIdFromUrl(url) {
  try {
    const value = new URL(url);
    if (value.pathname === "/watch") return value.searchParams.get("v") || "";
    if (value.pathname.startsWith("/shorts/")) return value.pathname.split("/")[2] || "";
    if (value.pathname === "/embed") return value.searchParams.get("v") || "";
    return "";
  } catch {
    return "";
  }
}

async function fetchDislikeData(videoId) {
  if (!videoId) return { ok: false, error: "Missing video id." };
  const cached = dislikeCache.get(videoId);
  if (cached && Date.now() - cached.time < DISLIKE_CACHE_TTL_MS) return { ok: true, data: cached.data };

  try {
    const response = await fetch(`https://returnyoutubedislikeapi.com/votes?videoId=${encodeURIComponent(videoId)}`, {
      method: "GET",
      cache: "no-store"
    });
    if (!response.ok) return { ok: false, error: `API ${response.status}` };
    const data = await response.json();
    dislikeCache.set(videoId, { time: Date.now(), data });
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Could not reach Return YouTube Dislike API." };
  }
}

let contextMenuRebuildQueue = Promise.resolve();

async function createContextMenu(id, properties) {
  try {
    await new Promise((resolve, reject) => {
      chrome.contextMenus.create({ id, ...properties }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  } catch {}
}

async function createAllContextMenus() {
  contextMenuRebuildQueue = contextMenuRebuildQueue.catch(() => {}).then(async () => {
    try { await new Promise(resolve => chrome.contextMenus.removeAll(() => resolve())); } catch {}
    const settings = await getSettings();

    await createContextMenu(IMAGE_MENU_PARENT, { title: "Save Image as Type", contexts: ["image"] });
    for (const [key, item] of Object.entries(IMAGE_MENU_ITEMS)) {
      await createContextMenu(`tbo-image-${key}`, { parentId: IMAGE_MENU_PARENT, title: key === "webp" ? "WebP" : key.toUpperCase(), contexts: ["image"] });
    }

    if (!settings.convertCaseEnabled) return;
    await createContextMenu(CONTEXT_MENU_PARENT, { title: "Convert Case", contexts: ["selection"] });
    const items = [
      ["tbo-uppercase", "UPPERCASE"],
      ["tbo-lowercase", "lowercase"],
      ["tbo-titlecase", "Title Case"],
      ["tbo-sentencecase", "Sentence case"],
      ["tbo-togglecase", "tOGGLE cASE"]
    ];
    for (const [id, title] of items) {
      await createContextMenu(id, { parentId: CONTEXT_MENU_PARENT, title, contexts: ["selection"] });
    }
  });
  return contextMenuRebuildQueue;
}

function mimeForImageMenuId(id) {
  return IMAGE_MENU_ITEMS[String(id || "").replace(/^tbo-image-/, "")] || null;
}

function filenameWithoutExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const raw = decodeURIComponent(pathname.split("/").pop() || "image");
    const safe = raw.replace(/[\\/:*?"<>|]+/g, "_").trim();
    return safe.replace(/\.[^.]+$/, "") || "image";
  } catch { return "image"; }
}

async function imageBlobFromSource(tabId, srcUrl) {
  if (!srcUrl) throw new Error("Missing image URL.");
  if (/^blob:/i.test(srcUrl)) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async url => {
        const response = await fetch(url);
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      },
      args: [srcUrl]
    });
    const dataUrl = results?.[0]?.result;
    if (!dataUrl) throw new Error("Could not read image.");
    return await (await fetch(dataUrl)).blob();
  }
  const response = await fetch(srcUrl, { cache: "no-store", credentials: "include" });
  if (!response.ok) throw new Error(`Could not download image (HTTP ${response.status}).`);
  return await response.blob();
}

function imageDataToBmpBlob(imageData) {
  const { width, height, data } = imageData;
  const rowSize = Math.ceil(width * 3 / 4) * 4;
  const pixelBytes = rowSize * height;
  const buffer = new ArrayBuffer(54 + pixelBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes[0] = 0x42; bytes[1] = 0x4d;
  view.setUint32(2, buffer.byteLength, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true); view.setInt32(22, height, true);
  view.setUint16(26, 1, true); view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  view.setInt32(38, 2835, true); view.setInt32(42, 2835, true);
  let o = 54;
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      bytes[o++] = data[i + 2]; bytes[o++] = data[i + 1]; bytes[o++] = data[i];
    }
    o += rowSize - width * 3;
  }
  return new Blob([buffer], { type: "image/bmp" });
}

async function convertImageToFormat(blob, targetMime) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: targetMime === "image/bmp" });
  if (!ctx) { bitmap.close(); throw new Error("Image conversion is not supported."); }
  if (targetMime === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  if (targetMime === "image/bmp") return imageDataToBmpBlob(ctx.getImageData(0, 0, canvas.width, canvas.height));
  return await canvas.convertToBlob({ type: targetMime, quality: targetMime === "image/jpeg" ? 0.92 : 0.95 });
}

async function saveImageAsType(tabId, srcUrl, target) {
  const source = await imageBlobFromSource(tabId, srcUrl);
  const output = await convertImageToFormat(source, target.mime);
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(output);
  });
  await chrome.downloads.download({
    url: dataUrl,
    filename: `${filenameWithoutExtension(srcUrl)}.${target.extension}`,
    saveAs: true,
    conflictAction: "uniquify"
  });
}


async function initialize() {
  const existing = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const next = {
    ...DEFAULT_SETTINGS,
    thinkSites: normalizeSites(existing.thinkSites),
    blockedSites: normalizeSites(existing.blockedSites),
    waitSeconds: normalizeWaitSeconds(existing.waitSeconds),
    youtubeDistractionEnabled: toBoolean(existing.youtubeDistractionEnabled, DEFAULT_SETTINGS.youtubeDistractionEnabled),
    youtubeHideHomeFeed: toBoolean(existing.youtubeHideHomeFeed, DEFAULT_SETTINGS.youtubeHideHomeFeed),
    youtubeHideRelated: toBoolean(existing.youtubeHideRelated, DEFAULT_SETTINGS.youtubeHideRelated),
    youtubeHideShorts: toBoolean(existing.youtubeHideShorts, DEFAULT_SETTINGS.youtubeHideShorts),
    youtubeHideComments: toBoolean(existing.youtubeHideComments, DEFAULT_SETTINGS.youtubeHideComments),
    youtubeHideEndscreen: toBoolean(existing.youtubeHideEndscreen, DEFAULT_SETTINGS.youtubeHideEndscreen),
    youtubeHideTrending: toBoolean(existing.youtubeHideTrending, DEFAULT_SETTINGS.youtubeHideTrending),
    youtubeDisableAutoplay: toBoolean(existing.youtubeDisableAutoplay, DEFAULT_SETTINGS.youtubeDisableAutoplay),
    youtubeDislikeEnabled: toBoolean(existing.youtubeDislikeEnabled, DEFAULT_SETTINGS.youtubeDislikeEnabled),
    convertCaseEnabled: toBoolean(existing.convertCaseEnabled, DEFAULT_SETTINGS.convertCaseEnabled)
  };
  await chrome.storage.local.set(next);
  await chrome.storage.local.remove("exclusions");

  await chrome.storage.session.set({ [BYPASS_KEY]: {} });
  const session = await getSessionState();
  if (session?.configured && !session.locked) {
    if (session.endsAt > Date.now()) await chrome.alarms.create(SESSION_ALARM, { when: session.endsAt });
    else await lockExpiredSession();
  }
  await createAllContextMenus();
  await ensureUsageAlarm();
  await enqueueUsage(() => syncUsageWithCurrentTab());
}

chrome.runtime.onInstalled.addListener(() => void initialize());
chrome.runtime.onStartup.addListener(() => void initialize());

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === USAGE_ALARM) {
    void enqueueUsage(() => syncUsageWithCurrentTab());
    return;
  }
  if (alarm.name === SESSION_ALARM) {
    void lockExpiredSession();
  }
});

// Only handle real URL changes. This prevents the interstitial from redirecting itself
// again on the subsequent "loading" status updates triggered by chrome.tabs.update().
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) void handleNavigation(tabId, changeInfo.url);
});

chrome.tabs.onActivated.addListener(() => void enqueueUsage(() => syncUsageWithCurrentTab()));
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) void enqueueUsage(() => recordAndPauseUsage());
  else void enqueueUsage(() => syncUsageWithCurrentTab());
});

chrome.tabs.onRemoved.addListener(tabId => {
  void enqueueUsage(async () => {
    const old = await getActiveUsageSession();
    if (old?.tabId === tabId) await recordAndPauseUsage();
    const bypasses = await getBypasses();
    if (bypasses[String(tabId)]) {
      delete bypasses[String(tabId)];
      await setBypasses(bypasses);
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId || "");
  if (tab?.id == null) return;
  const imageTarget = mimeForImageMenuId(id);
  if (imageTarget) {
    void saveImageAsType(tab.id, info.srcUrl, imageTarget).catch(error => console.warn("Think Before Open: image conversion failed", error));
    return;
  }
  if (!id.startsWith("tbo-") || id === CONTEXT_MENU_PARENT || id === IMAGE_MENU_PARENT) return;
  chrome.scripting.executeScript({ target: { tabId: tab.id }, func: replaceSelectedTextWithCase, args: [id.replace("tbo-", "")] }).catch(() => {});
});

function replaceSelectedTextWithCase(operation) {
  const selected = window.getSelection()?.toString() || "";
  if (!selected) return;
  const lower = selected.toLowerCase();
  const upper = selected.toUpperCase();
  const title = selected.toLowerCase().replace(/\b([a-z])/g, match => match.toUpperCase());
  const sentence = selected.toLowerCase().replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix, char) => `${prefix}${char.toUpperCase()}`);
  const toggled = [...selected].map(char => char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()).join("");
  const output = ({ uppercase: upper, lowercase: lower, titlecase: title, sentencecase: sentence, togglecase: toggled })[operation];
  if (output === undefined) return;

  const active = document.activeElement;
  if (active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.selectionStart != null && active.selectionEnd != null) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    active.setRangeText(output, start, end, "end");
    active.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) {
    range.deleteContents();
    range.insertNode(document.createTextNode(output));
    selection.removeAllRanges();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "continueToSite" && sender.tab?.id != null && isWebUrl(message.targetUrl)) {
    (async () => {
      const settings = await getSettings();
      const mode = await classifyUrl(message.targetUrl);
      if (mode === "think") {
        const session = await ensureSessionState();
        if (session?.locked) {
          await redirectThinkTabToSessionLock(sender.tab.id, message.targetUrl);
          sendResponse({ ok: false, locked: true, error: "This session has ended. Unlock to start a new session." });
          return;
        }
      }
      if (mode === "blocked") {
        await chrome.tabs.update(sender.tab.id, { url: interstitialUrl("blocked", message.targetUrl, settings.waitSeconds) });
        sendResponse({ ok: false, blocked: true, error: "This website is blocked." });
        return;
      }
      await allowOneNavigation(sender.tab.id, message.targetUrl);
      await chrome.tabs.update(sender.tab.id, { url: message.targetUrl });
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false, error: "Could not open the website." }));
    return true;
  }

  if (message?.type === "getSessionState") {
    (async () => {
      const session = await ensureSessionState();
      sendResponse({ ok: true, session });
    })().catch(() => sendResponse({ ok: false, error: "Could not read the session." }));
    return true;
  }

  if (message?.type === "startSessionAndOpen" && sender.tab?.id != null && isWebUrl(message.targetUrl)) {
    (async () => {
      const settings = await getSettings();
      const mode = await classifyUrl(message.targetUrl);
      if (mode === "blocked") {
        await chrome.tabs.update(sender.tab.id, { url: interstitialUrl("blocked", message.targetUrl, settings.waitSeconds) });
        sendResponse({ ok: false, blocked: true, error: "This website is blocked." });
        return;
      }
      if (mode !== "think") {
        sendResponse({ ok: false, error: "This website is no longer on your think list." });
        return;
      }

      const current = await ensureSessionState();
      if (current?.locked) {
        await redirectThinkTabToSessionLock(sender.tab.id, message.targetUrl);
        sendResponse({ ok: false, locked: true, error: "This session has ended. Unlock to start a new session." });
        return;
      }

      let session = current;
      if (!session?.configured || !session?.endsAt || session.endsAt <= Date.now()) {
        session = await startSession(message.durationMinutes);
      }

      await allowOneNavigation(sender.tab.id, message.targetUrl);
      await chrome.tabs.update(sender.tab.id, { url: message.targetUrl });
      await reopenLockedTabsForHost(getHostname(message.targetUrl), sender.tab.id);
      sendResponse({ ok: true, session, syncedTabs: true });
    })().catch(() => sendResponse({ ok: false, error: "Could not start the session and open the website." }));
    return true;
  }

  if (message?.type === "unlockSession" && sender.tab?.id != null) {
    (async () => {
      const session = await ensureSessionState();
      if (!session?.locked) {
        sendResponse({ ok: false, error: "This session is not locked." });
        return;
      }
      if (String(message.phrase || "") !== String(session.unlockPhrase || SESSION_UNLOCK_PHRASE)) {
        sendResponse({ ok: false, error: "The phrase does not match. Type the full phrase exactly." });
        return;
      }
      const settings = await getSettings();
      const mode = await classifyUrl(message.targetUrl);
      if (mode === "blocked") {
        sendResponse({ ok: false, error: "This website is blocked." });
        return;
      }
      if (mode !== "think") {
        sendResponse({ ok: false, error: "This website is no longer on your think list." });
        return;
      }
      await chrome.alarms.clear(SESSION_ALARM);
      const unlocked = {
        configured: false,
        durationMinutes: 0,
        startedAt: 0,
        endsAt: 0,
        locked: false,
        unlockPhrase: ""
      };
      await setSessionState(unlocked);
      sendResponse({ ok: true, requiresDuration: true });
    })().catch(() => sendResponse({ ok: false, error: "Could not unlock the website." }));
    return true;
  }

  if (message?.type === "closeTab" && sender.tab?.id != null) {
    (async () => {
      await chrome.tabs.remove(sender.tab.id);
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "openDashboard") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "getUsage") {
    (async () => sendResponse({ usage: await getUsage() }))().catch(() => sendResponse({ usage: {} }));
    return true;
  }


  if (message?.type === "saveSettings") {
    (async () => {
      const current = await getSettings();
      const next = {
        thinkSites: normalizeSites(message.thinkSites ?? current.thinkSites),
        blockedSites: normalizeSites(message.blockedSites ?? current.blockedSites),
        waitSeconds: normalizeWaitSeconds(message.waitSeconds ?? current.waitSeconds),
        youtubeDistractionEnabled: toBoolean(message.youtubeDistractionEnabled, current.youtubeDistractionEnabled),
        youtubeHideHomeFeed: toBoolean(message.youtubeHideHomeFeed, current.youtubeHideHomeFeed),
        youtubeHideRelated: toBoolean(message.youtubeHideRelated, current.youtubeHideRelated),
        youtubeHideShorts: toBoolean(message.youtubeHideShorts, current.youtubeHideShorts),
        youtubeHideComments: toBoolean(message.youtubeHideComments, current.youtubeHideComments),
        youtubeHideEndscreen: toBoolean(message.youtubeHideEndscreen, current.youtubeHideEndscreen),
        youtubeHideTrending: toBoolean(message.youtubeHideTrending, current.youtubeHideTrending),
        youtubeDisableAutoplay: toBoolean(message.youtubeDisableAutoplay, current.youtubeDisableAutoplay),
        youtubeDislikeEnabled: toBoolean(message.youtubeDislikeEnabled, current.youtubeDislikeEnabled),
        convertCaseEnabled: toBoolean(message.convertCaseEnabled, current.convertCaseEnabled)
      };

      await chrome.storage.local.set(next);
      await chrome.storage.local.remove("exclusions");

      // Context-menu rebuilding is unrelated to settings persistence. Do not let a
      // menu API error make a successful settings save look like it failed.
      await createAllContextMenus().catch(() => {});

      const saved = await getSettings();
      sendResponse({ ok: true, settings: saved });
    })().catch(() => sendResponse({ ok: false, error: "Could not save settings." }));
    return true;
  }


  if (message?.type === "getYouTubeDislike" && sender.tab?.url) {
    (async () => {
      const settings = await getSettings();
      if (!settings.youtubeDislikeEnabled) {
        sendResponse({ ok: false, disabled: true });
        return;
      }
      const videoId = videoIdFromUrl(sender.tab.url);
      sendResponse(await fetchDislikeData(videoId));
    })().catch(() => sendResponse({ ok: false, error: "Could not load dislike data." }));
    return true;
  }
});

chrome.storage.onChanged.addListener(changes => {
  const menuSettingChanged = changes.convertCaseEnabled;
  if (menuSettingChanged) void createAllContextMenus();
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
void initialize();
