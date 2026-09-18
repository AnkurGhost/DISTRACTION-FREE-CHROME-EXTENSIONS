const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "think";
const target = params.get("target") || "";
const configuredWait = Number(params.get("wait"));
const waitSeconds = Number.isFinite(configuredWait) && configuredWait >= 1 ? Math.round(configuredWait) : 30;
const SESSION_DURATIONS = [1, 5, 10, 20, 30];

const title = document.getElementById("title");
const message = document.getElementById("message");
const site = document.getElementById("site");
const icon = document.getElementById("icon");
const countdownBox = document.getElementById("countdownBox");
const countdown = document.getElementById("countdown");
const actions = document.getElementById("actions");
const openBtn = document.getElementById("openBtn");
const blockedActions = document.getElementById("blockedActions");
const sessionSetup = document.getElementById("sessionSetup");
const sessionMinutes = document.getElementById("sessionMinutes");
const startSessionOpenBtn = document.getElementById("startSessionOpenBtn");
const cancelSessionSetupBtn = document.getElementById("cancelSessionSetupBtn");
const sessionSetupError = document.getElementById("sessionSetupError");
const sessionLockPanel = document.getElementById("sessionLockPanel");
const unlockInput = document.getElementById("unlockInput");
const unlockBtn = document.getElementById("unlockBtn");
const error = document.getElementById("error");
const hint = document.getElementById("hint");

function safeHost(value) {
  try { return new URL(value).hostname; } catch { return value || "unknown site"; }
}

function showError(text, node = error) {
  node.textContent = text;
  node.classList.remove("hidden");
}

function hideError(node = error) {
  node.textContent = "";
  node.classList.add("hidden");
}

async function getSession() {
  const response = await chrome.runtime.sendMessage({ type: "getSessionState" });
  if (!response?.ok) throw new Error(response?.error || "Could not read the session state.");
  return response.session || null;
}

site.textContent = safeHost(target);
document.title = mode === "blocked" ? "Website blocked" : mode === "sessionLocked" ? "Session locked" : "Think Before Open";
actions.classList.add("hidden");
blockedActions.classList.add("hidden");
sessionSetup.classList.add("hidden");
sessionLockPanel.classList.add("hidden");
hideError();
hideError(sessionSetupError);

if (mode === "blocked") {
  icon.textContent = "⛔";
  title.textContent = "This website is blocked.";
  message.textContent = "You added this site to your block list, so Think Before Open will stop it from opening.";
  countdownBox.classList.add("hidden");
  blockedActions.classList.remove("hidden");
  hint.textContent = "You can change your block list from the dashboard.";
} else if (mode === "sessionLocked") {
  icon.textContent = "🔒";
  title.textContent = "Your session has ended.";
  message.textContent = "Type the full phrase, then choose how long your new session should last.";
  countdownBox.classList.add("hidden");
  sessionLockPanel.classList.remove("hidden");
  hint.textContent = "After the phrase is accepted, choose 1, 5, 10, 20, or 30 minutes.";
  sessionMinutes.value = "";
  unlockInput.focus();
} else {
  icon.textContent = "⏳";
  title.textContent = `Take ${waitSeconds} seconds.`;
  message.textContent = "Pause and decide whether you really want to open this site.";
  let seconds = waitSeconds;
  countdown.textContent = String(seconds);
  hint.textContent = "The Open Website button appears when the thinking timer finishes.";

  const timer = setInterval(() => {
    seconds -= 1;
    countdown.textContent = String(Math.max(seconds, 0));
    if (seconds <= 0) {
      clearInterval(timer);
      countdownBox.classList.add("hidden");
      actions.classList.remove("hidden");
      hint.textContent = "Click Open Website to choose your session time.";
    }
  }, 1000);
}

openBtn.addEventListener("click", async () => {
  if (!target) return;
  openBtn.disabled = true;
  hideError();
  try {
    const session = await getSession();
    if (session?.locked) {
      await chrome.runtime.sendMessage({ type: "continueToSite", targetUrl: target });
      return;
    }

    if (session?.configured && session?.endsAt && session.endsAt > Date.now()) {
      const response = await chrome.runtime.sendMessage({ type: "continueToSite", targetUrl: target });
      if (!response?.ok) throw new Error(response?.error || "Could not open the website.");
      return;
    }

    actions.classList.add("hidden");
    sessionSetup.classList.remove("hidden");
    hint.textContent = "Choose 1, 5, 10, 20, or 30 minutes. The timer starts when you confirm.";
    sessionMinutes.focus();
  } catch (err) {
    showError(err?.message || "Could not prepare the session.");
  } finally {
    openBtn.disabled = false;
  }
});

cancelSessionSetupBtn.addEventListener("click", () => {
  hideError(sessionSetupError);
  sessionSetup.classList.add("hidden");
  actions.classList.remove("hidden");
  hint.textContent = "Click Open Website to choose your session time.";
});

startSessionOpenBtn.addEventListener("click", async () => {
  const durationMinutes = Number(sessionMinutes.value);
  hideError(sessionSetupError);
  if (!SESSION_DURATIONS.includes(durationMinutes)) {
    showError("Choose 1, 5, 10, 20, or 30 minutes.", sessionSetupError);
    return;
  }

  startSessionOpenBtn.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "startSessionAndOpen",
      targetUrl: target,
      durationMinutes
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not start the session.");
    }
  } catch (err) {
    showError(err?.message || "Could not start the session.", sessionSetupError);
    startSessionOpenBtn.disabled = false;
  }
});

unlockBtn.addEventListener("click", async () => {
  const phrase = unlockInput.value;
  hideError();
  if (!phrase) return showError("Type the full phrase first.");
  unlockBtn.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "unlockSession", targetUrl: target, phrase });
    if (!response?.ok) {
      showError(response?.error || "Could not unlock the session.");
      unlockInput.select();
      return;
    }
    sessionLockPanel.classList.add("hidden");
    sessionSetup.classList.remove("hidden");
    sessionMinutes.value = "";
    hideError(sessionSetupError);
    title.textContent = "Choose your new session time.";
    message.textContent = "Your phrase was accepted. Select the duration for your new session, then open the website.";
    hint.textContent = "You must choose a new session time: 1, 5, 10, 20, or 30 minutes.";
    sessionMinutes.focus();
  } catch (err) {
    showError(err?.message || "Could not unlock the session.");
  } finally {
    unlockBtn.disabled = false;
  }
});

unlockInput.addEventListener("keydown", event => {
  if (event.key === "Enter") void unlockBtn.click();
});

document.getElementById("closeBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "closeTab" });
});

document.getElementById("backBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "closeTab" });
});

document.getElementById("lockCloseBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "closeTab" });
});

document.getElementById("dashboardBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "openDashboard" });
});
