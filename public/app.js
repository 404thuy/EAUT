const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// --- Tactile Soft Sound FX (Cảm ứng chạm tiếng êm dịu, ấm áp & thư thái) ---
let audioCtx = null;
let lastTapTimestamp = 0;

function playSoftTap() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }

    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();

    // Lọc thông thấp (lowpass) tại ~680Hz để triệt tiêu hoàn toàn âm chói, cho tiếng ấm tròn êm tai
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(680, t);
    filter.Q.setValueAtTime(1.1, t);

    // Dạng sóng Sine thuần khiết, lướt tần số nhẹ từ 300Hz xuống 120Hz tạo độ nảy haptic tự nhiên
    osc.type = "sine";
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.038);

    // Âm lượng khẽ (0.04), suy giảm mượt mà về 0 trong 38ms
    gain.gain.setValueAtTime(0.04, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.038);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start(t);
    osc.stop(t + 0.042);
  } catch (err) {
    // Fail silently without disturbing UI
  }
}

window.playTactileTap = playSoftTap;

// Bắt cảm ứng chạm (touch/pointer) mượt mà không độ trễ trên tất cả các phần tử tương tác
document.addEventListener("pointerdown", (event) => {
  const interactiveSelector = "button, a, summary, [role='button'], select, input[type='submit'], input[type='button'], input[type='checkbox'], input[type='radio'], .btn, .icon-btn, .nav-item, .session-item, .term-card, [data-view-mode], [data-day-filter]";
  const target = event.target && event.target.closest(interactiveSelector);
  if (target) {
    const now = performance.now();
    if (now - lastTapTimestamp > 45) {
      lastTapTimestamp = now;
      playSoftTap();
    }
  }
}, { passive: true });

// Sidebar (mobile)
const sidebar = $("[data-sidebar]");
const sidebarToggle = $("[data-sidebar-toggle]");
const sidebarBackdrop = $("[data-sidebar-backdrop]");

const setSidebarOpen = (isOpen) => {
  if (!sidebar) return;
  sidebar.classList.toggle("is-open", isOpen);
  sidebarBackdrop?.classList.toggle("is-open", isOpen);
  sidebarToggle?.setAttribute("aria-expanded", String(isOpen));
  sidebarToggle?.classList.toggle("is-active", isOpen);
};

if (sidebarToggle && sidebar) {
  sidebarToggle.addEventListener("click", () => setSidebarOpen(!sidebar.classList.contains("is-open")));
  sidebarBackdrop?.addEventListener("click", () => setSidebarOpen(false));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setSidebarOpen(false);
  });

  $$('a[href^="#"]', sidebar).forEach((link) => {
    link.addEventListener("click", () => setSidebarOpen(false));
  });
}

// Dark mode (persisted)
const themeToggles = $$("[data-theme-toggle]");
const THEME_KEY = "eaut_theme";

const applyTheme = (theme) => {
  console.log(`[Theme] Applying: ${theme}`);
  const root = document.documentElement;
  const isLight = theme === "light";
  root.classList.toggle("light-theme", isLight);
  document.body.classList.toggle("light-theme", isLight);
  
  // Backwards compatibility for logic that might use attributes
  root.setAttribute("data-theme", theme);
  
  // Update titles for all toggles
  const label = theme === "dark" ? "Chuyển sang nền sáng" : "Chuyển sang nền tối";
  themeToggles.forEach(btn => {
    btn.title = label;
    btn.setAttribute("aria-label", label);
  });
};

const getPreferredTheme = () => {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
};

applyTheme(getPreferredTheme());

themeToggles.forEach(btn => {
  btn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
});

const viewButtons = $$("[data-view-mode]");
const viewBlocks = $$("[data-view-block]");

if (viewButtons.length && viewBlocks.length) {
  const setViewMode = (mode) => {
    viewBlocks.forEach((block) => {
      block.classList.toggle("is-hidden", block.dataset.viewBlock !== mode);
    });
    viewButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.viewMode === mode);
    });
  };

  // Detect mobile and set default view to list
  const isMobile = window.innerWidth < 768;
  setViewMode(isMobile ? "list" : "table");

  viewButtons.forEach((button) => {
    button.addEventListener("click", () => setViewMode(button.dataset.viewMode));
  });
}

const filterInput = $("#subjectFilter");
const sessionItems = $$(".session-item, .list-item");
const dayGroups = $$(".list-day-group");

// Sidebar active item by user selection
const navItems = $$("[data-nav-item]");
const setActiveNav = (id) => {
  navItems.forEach((item) => item.classList.toggle("is-active", item.getAttribute("data-nav-item") === id));
};
navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const id = item.getAttribute("data-nav-item");
    if (id) setActiveNav(id);
  });
});

if (filterInput && sessionItems.length) {
  filterInput.addEventListener("input", (event) => {
    const keyword = String(event.target.value || "").toLowerCase().trim();
    sessionItems.forEach((item) => {
      const source = item.dataset.searchContent || "";
      const isMatch = !keyword || source.includes(keyword);
      item.classList.toggle("is-hidden", !isMatch);
    });
  });
}

const examFilterInput = $("#examFilter");
const examItems = $$(".exam-item");
if (examFilterInput && examItems.length) {
  examFilterInput.addEventListener("input", (event) => {
    const keyword = String(event.target.value || "").toLowerCase().trim();
    examItems.forEach((item) => {
      const source = item.dataset.searchContent || "";
      const isMatch = !keyword || source.includes(keyword);
      item.classList.toggle("is-hidden", !isMatch);
    });
  });
}

const dayFilterButtons = $$("[data-day-filter]");
if (dayFilterButtons.length) {
  const tableHeaders = $$(".week-grid__day");
  const tableCells = $$(".week-grid__cell");

  const setDayFilter = (value) => {
    // 1. Update buttons
    dayFilterButtons.forEach((button) => {
      button.classList.toggle("is-active", button.getAttribute("data-day-filter") === value);
    });

    // 2. Filter list view groups
    dayGroups.forEach((group) => {
      const current = group.getAttribute("data-day-group");
      group.classList.toggle("is-hidden", value !== "all" && current !== value);
    });
  };

  setDayFilter("all");
  dayFilterButtons.forEach((button) => {
    button.addEventListener("click", () => setDayFilter(button.getAttribute("data-day-filter") || "all"));
  });
}

// Toggle Password Visibility
const togglePasswordBtn = $("#togglePasswordBtn");
const passwordInput = $("#password");

if (togglePasswordBtn && passwordInput) {
  togglePasswordBtn.addEventListener("click", () => {
    const isPassword = passwordInput.getAttribute("type") === "password";
    passwordInput.setAttribute("type", isPassword ? "text" : "password");

    const eyeOff = togglePasswordBtn.querySelector(".eye-off");
    const eyeOn = togglePasswordBtn.querySelector(".eye-on");

    if (eyeOff && eyeOn) {
      eyeOff.style.display = isPassword ? "none" : "block";
      eyeOn.style.display = isPassword ? "block" : "none";
    }

    const newLabel = isPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu";
    togglePasswordBtn.setAttribute("aria-label", newLabel);
    togglePasswordBtn.setAttribute("title", newLabel);
  });
}

// Game Ping / Real-time Latency Indicator
const pingBadge = $("#pingBadge");
const pingText = $("#pingText");

if (pingBadge && pingText) {
  let isPinging = false;
  let liveTimerInterval = null;

  const updatePingUI = (ms) => {
    pingBadge.classList.remove("is-good", "is-medium", "is-poor", "is-measuring");
    if (ms === null || isNaN(ms)) {
      pingText.textContent = "-- ms";
      pingBadge.title = "Mất kết nối máy chủ";
      pingBadge.classList.add("is-poor");
      return;
    }
    pingText.textContent = `${ms} ms`;
    pingBadge.title = `Độ trễ máy chủ: ${ms}ms`;
    if (ms < 150) {
      pingBadge.classList.add("is-good");
    } else if (ms < 400) {
      pingBadge.classList.add("is-medium");
    } else {
      pingBadge.classList.add("is-poor");
    }
  };

  // 1. Calculate the exact real latency experienced by the user on this page load / reload
  let realLatency = null;
  const actionStart = sessionStorage.getItem("eaut_action_start");

  if (actionStart) {
    const diff = Date.now() - parseInt(actionStart, 10);
    sessionStorage.removeItem("eaut_action_start");
    if (diff > 0 && diff < 120000) {
      realLatency = diff;
    }
  }

  // Fallback to Navigation Timing API if actionStart was not present
  if (!realLatency && window.performance) {
    const navEntries = performance.getEntriesByType("navigation");
    if (navEntries && navEntries.length > 0) {
      const nav = navEntries[0];
      if (nav.responseEnd && nav.requestStart && (nav.responseEnd - nav.requestStart) > 0) {
        realLatency = Math.round(nav.responseEnd - nav.requestStart);
      } else if (nav.duration && nav.duration > 0) {
        realLatency = Math.round(nav.duration);
      }
    }
    if (!realLatency && performance.timing) {
      const t = performance.timing;
      if (t.responseEnd && t.requestStart && (t.responseEnd - t.requestStart) > 0) {
        realLatency = t.responseEnd - t.requestStart;
      }
    }
  }

  if (!realLatency) {
    realLatency = Math.max(1, Math.round(performance.now()));
  }

  // Set initial UI with true page load latency
  updatePingUI(realLatency);

  // If page finishes loading completely and wasn't a manual click action, refine with full navigation duration
  if (!actionStart) {
    window.addEventListener("load", () => {
      const navEntries = performance.getEntriesByType("navigation");
      if (navEntries && navEntries.length > 0 && navEntries[0].duration > 0) {
        updatePingUI(Math.round(navEntries[0].duration));
      }
    });
  }

  // 2. Global tracker function to update live counter during reload / navigation
  window.startLiveLatencyTracker = () => {
    const startTime = Date.now();
    sessionStorage.setItem("eaut_action_start", startTime.toString());

    if (liveTimerInterval) clearInterval(liveTimerInterval);
    pingBadge.classList.remove("is-good", "is-poor");
    pingBadge.classList.add("is-medium");

    const loadingTimer = document.getElementById("loadingTimer");

    liveTimerInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      pingText.textContent = `${elapsed} ms`;
      if (loadingTimer) {
        loadingTimer.textContent = `Đang xử lý: ${elapsed} ms`;
      }
      if (elapsed >= 400) {
        pingBadge.classList.remove("is-medium");
        pingBadge.classList.add("is-poor");
      }
    }, 25);
  };

  // Attach tracker to all navigation links
  document.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:") && !link.target) {
      link.addEventListener("click", () => {
        if (!link.hasAttribute("download")) {
          window.startLiveLatencyTracker();
        }
      });
    }
  });

  // Attach tracker to page unload (F5 or browser reload)
  window.addEventListener("beforeunload", () => {
    if (!sessionStorage.getItem("eaut_action_start")) {
      sessionStorage.setItem("eaut_action_start", Date.now().toString());
    }
  });

  // 3. Ping measurement function (Real-time Round-trip Latency)
  const measurePing = async () => {
    if (isPinging || document.hidden) return;
    isPinging = true;

    const startTime = performance.now();
    try {
      const resp = await fetch("/ping?t=" + Date.now(), { 
        cache: "no-store", 
        method: "GET",
        headers: { "Cache-Control": "no-cache" }
      });
      if (resp.ok) {
        const elapsed = Math.max(1, Math.round(performance.now() - startTime));
        updatePingUI(elapsed);
      } else {
        updatePingUI(null);
      }
    } catch {
      updatePingUI(null);
    } finally {
      isPinging = false;
    }
  };

  // 4. Continuously auto-update ping every 2.5 seconds without user interaction
  let pingInterval = setInterval(measurePing, 2500);

  // Pause pinging when tab is hidden, resume immediately when tab becomes visible
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (pingInterval) clearInterval(pingInterval);
    } else {
      measurePing();
      pingInterval = setInterval(measurePing, 2500);
    }
  });
}
