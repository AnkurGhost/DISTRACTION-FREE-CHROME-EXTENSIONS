(() => {
  const STYLE_ID = "tbo-youtube-distraction-style";
  const DISLIKE_ID = "tbo-return-dislike";
  let settings = null;
  let lastVideoId = "";
  let dislikeRequestInFlight = false;
  let observerTimer = null;

  const DEFAULTS = {
    youtubeDistractionEnabled: true,
    youtubeHideHomeFeed: true,
    youtubeHideRelated: true,
    youtubeHideShorts: true,
    youtubeHideComments: true,
    youtubeHideEndscreen: true,
    youtubeHideTrending: true,
    youtubeDisableAutoplay: true,
    youtubeDislikeEnabled: true
  };

  function readSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(DEFAULTS, value => {
        settings = value;
        resolve(value);
      });
    });
  }

  function buildCss(s) {
    if (!s.youtubeDistractionEnabled) return "";
    const rules = [];
    if (s.youtubeHideHomeFeed) {
      rules.push('ytd-browse[page-subtype="home"] #contents ytd-rich-grid-renderer');
      rules.push('ytd-browse[page-subtype="home"] #contents #rich-grid-container');
    }
    if (s.youtubeHideRelated) {
      rules.push('ytd-watch-next-secondary-results-renderer #related');
      rules.push('ytd-watch-flexy #secondary #related');
    }
    if (s.youtubeHideShorts) {
      rules.push('ytd-reel-shelf-renderer');
      rules.push('ytd-rich-shelf-renderer[is-shorts]');
      rules.push('ytd-mini-guide-entry-renderer a[href^="/shorts"]');
      rules.push('ytd-guide-entry-renderer a[href^="/shorts"]');
    }
    if (s.youtubeHideComments) rules.push('ytd-comments#comments');
    if (s.youtubeHideEndscreen) rules.push('.ytp-endscreen-content', 'ytd-player-legacy-desktop-watch-ads-renderer + *');
    if (s.youtubeHideTrending) {
      rules.push('ytd-guide-entry-renderer a[href="/feed/trending"]');
      rules.push('ytd-guide-entry-renderer a[href="/feed/explore"]');
    }
    return rules.length ? `${rules.join(",\n")} { display: none !important; }` : "";
  }

  function applyStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.documentElement || document.head || document.body)?.appendChild(style);
    }
    style.textContent = buildCss(settings || DEFAULTS);
  }

  function disableAutoplay() {
    if (!settings?.youtubeDistractionEnabled || !settings.youtubeDisableAutoplay) return;
    document.querySelectorAll("video").forEach(video => {
      try { video.autoplay = false; } catch {}
    });
    const button = document.querySelector("button.ytp-autonav-toggle-button[aria-checked=\"true\"], button.ytp-autonav-toggle-button[aria-pressed=\"true\"]");
    if (button) button.click();
  }

  function getVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname === "/watch") return url.searchParams.get("v") || "";
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
      return "";
    } catch { return ""; }
  }

  function formatCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  }

  function removeOldDislike() {
    document.querySelectorAll(`#${DISLIKE_ID}`).forEach(el => el.remove());
  }

  function injectDislike(data) {
    if (!settings?.youtubeDislikeEnabled || !data || data.dislikes == null) return;
    const target = document.querySelector("#top-level-buttons-computed") || document.querySelector("ytd-watch-metadata #top-level-buttons-computed");
    if (!target) return false;
    const existing = document.getElementById(DISLIKE_ID);
    const label = `👎 ${formatCount(data.dislikes)} dislikes`;
    if (existing) {
      existing.textContent = label;
      return true;
    }

    const themeStyleId = "tbo-return-dislike-theme-style";
    let themeStyle = document.getElementById(themeStyleId);
    if (!themeStyle) {
      themeStyle = document.createElement("style");
      themeStyle.id = themeStyleId;
      themeStyle.textContent = `#${DISLIKE_ID}{color:#0f0f0f!important;background:#f2f2f2!important;opacity:1!important;visibility:visible!important;-webkit-text-fill-color:#0f0f0f!important}html[dark] #${DISLIKE_ID},html[dark-mode] #${DISLIKE_ID},body[dark] #${DISLIKE_ID}{color:#f1f1f1!important;background:#272727!important;-webkit-text-fill-color:#f1f1f1!important}`;
      (document.head || document.documentElement).appendChild(themeStyle);
    }

    const wrapper = document.createElement("div");
    wrapper.id = DISLIKE_ID;
    wrapper.setAttribute("aria-label", `Return YouTube Dislike: ${label}`);
    wrapper.title = "Return YouTube Dislike estimate";
    wrapper.style.cssText = [
      "display:flex",
      "align-items:center",
      "height:36px",
      "padding:0 14px",
      "margin-left:8px",
      "border-radius:18px",
      "background:rgba(0,0,0,.05)",
      "color:#0f0f0f",
      "color-scheme:light dark",
      "font-family:Roboto,Arial,sans-serif",
      "font-size:14px",
      "white-space:nowrap",
      "box-sizing:border-box"
    ].join(";");
    wrapper.textContent = label;
    target.appendChild(wrapper);
    return true;
  }

  async function loadDislike() {
    if (!settings?.youtubeDislikeEnabled) {
      removeOldDislike();
      return;
    }
    const id = getVideoId();
    if (!id || id === lastVideoId && document.getElementById(DISLIKE_ID)) return;
    lastVideoId = id;
    dislikeRequestInFlight = true;
    const response = await chrome.runtime.sendMessage({ type: "getYouTubeDislike" }).catch(() => null);
    dislikeRequestInFlight = false;
    if (!response?.ok) return;
    let attempts = 0;
    const place = () => {
      attempts += 1;
      if (injectDislike(response.data) || attempts > 20) return;
      setTimeout(place, 500);
    };
    place();
  }

  function refresh() {
    if (!settings) return;
    applyStyle();
    if (settings.youtubeDistractionEnabled) disableAutoplay();
    if (settings.youtubeDislikeEnabled && !dislikeRequestInFlight) loadDislike();
    if (!settings.youtubeDislikeEnabled) removeOldDislike();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const relevant = [
      "youtubeDistractionEnabled",
      "youtubeHideHomeFeed",
      "youtubeHideRelated",
      "youtubeHideShorts",
      "youtubeHideComments",
      "youtubeHideEndscreen",
      "youtubeHideTrending",
      "youtubeDisableAutoplay",
      "youtubeDislikeEnabled"
    ];
    if (relevant.some(key => changes[key])) {
      readSettings().then(refresh);
    }
  });

  window.addEventListener("yt-navigate-finish", () => {
    lastVideoId = "";
    setTimeout(refresh, 300);
  });

  const observer = new MutationObserver(() => {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(refresh, 500);
  });

  readSettings().then(() => {
    refresh();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
})();
