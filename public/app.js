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

// --- Reusable Interactive Handlers (kích hoạt cho cả trang gốc và sau khi đổi tab tức thì) ---
function rebindInteractiveHandlers() {
  const root = document.getElementById("workspace") || document;

  // 1. Chuyển đổi giao diện Dạng bảng / Dạng danh sách
  const viewButtons = $$("[data-view-mode]", root);
  const viewBlocks = $$("[data-view-block]", root);

  if (viewButtons.length && viewBlocks.length) {
    const setViewMode = (mode) => {
      viewBlocks.forEach((block) => {
        block.classList.toggle("is-hidden", block.dataset.viewBlock !== mode);
      });
      viewButtons.forEach((button) => {
        button.classList.toggle("is-active", button.dataset.viewMode === mode);
      });
    };

    // Detect mobile and set default view to list if not explicitly selected
    const isMobile = window.innerWidth < 768;
    const currentActive = viewButtons.find((b) => b.classList.contains("is-active"));
    setViewMode(currentActive ? currentActive.dataset.viewMode : (isMobile ? "list" : "table"));

    viewButtons.forEach((button) => {
      button.onclick = () => setViewMode(button.dataset.viewMode);
    });
  }

  // 2. Bộ lọc tìm kiếm môn học / giảng viên / phòng
  const filterInput = $("#subjectFilter", root);
  const sessionItems = $$(".session-item, .list-item", root);
  if (filterInput && sessionItems.length) {
    filterInput.oninput = (event) => {
      const keyword = String(event.target.value || "").toLowerCase().trim();
      sessionItems.forEach((item) => {
        const source = item.dataset.searchContent || "";
        const isMatch = !keyword || source.includes(keyword);
        item.classList.toggle("is-hidden", !isMatch);
      });
    };
  }

  // 3. Bộ lọc lịch thi
  const examFilterInput = $("#examFilter", root);
  const examItems = $$(".exam-item", root);
  if (examFilterInput && examItems.length) {
    examFilterInput.oninput = (event) => {
      const keyword = String(event.target.value || "").toLowerCase().trim();
      examItems.forEach((item) => {
        const source = item.dataset.searchContent || "";
        const isMatch = !keyword || source.includes(keyword);
        item.classList.toggle("is-hidden", !isMatch);
      });
    };
  }

  // 4. Lọc theo thứ trong tuần
  const dayFilterButtons = $$("[data-day-filter]", root);
  const dayGroups = $$(".list-day-group", root);
  if (dayFilterButtons.length) {
    const setDayFilter = (value) => {
      dayFilterButtons.forEach((button) => {
        button.classList.toggle("is-active", button.getAttribute("data-day-filter") === value);
      });
      dayGroups.forEach((group) => {
        const current = group.getAttribute("data-day-group");
        group.classList.toggle("is-hidden", value !== "all" && current !== value);
      });
    };

    const activeFilterBtn = dayFilterButtons.find((b) => b.classList.contains("is-active"));
    setDayFilter(activeFilterBtn ? (activeFilterBtn.getAttribute("data-day-filter") || "all") : "all");

    dayFilterButtons.forEach((button) => {
      button.onclick = () => setDayFilter(button.getAttribute("data-day-filter") || "all");
    });
  }

  // 5. Chuyển tuần và học kỳ mượt mà qua Instant Navigator (nếu có)
  $$("form.week-form", root).forEach((form) => {
    const select = form.querySelector("select");
    if (select) {
      select.onchange = (e) => {
        e.preventDefault();
        const action = form.getAttribute("action") || window.location.pathname;
        const name = select.getAttribute("name") || "semester";
        const val = select.value;
        const targetUrl = action + (action.includes("?") ? "&" : "?") + encodeURIComponent(name) + "=" + encodeURIComponent(val);
        if (window.InstantTabNavigator && window.InstantTabNavigator.navigateTo) {
          window.InstantTabNavigator.navigateTo(targetUrl);
        } else {
          form.submit();
        }
      };
    }
  });

  // 6. Cập nhật đồng hồ đếm ngược nếu có
  if (typeof window.updateCountdowns === "function") {
    window.updateCountdowns();
  }
}

// Chạy khởi tạo tương tác lần đầu
rebindInteractiveHandlers();

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
      try {
        const prev = parseInt(localStorage.getItem("eaut_avg_crawl_time") || "8000", 10);
        const calibrated = Math.round(prev * 0.35 + diff * 0.65);
        localStorage.setItem("eaut_avg_crawl_time", calibrated.toString());
      } catch (e) {}
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

    // Dynamic countdown timer for login / synchronization (default ~8s for production web crawls)
    let estimatedMs = 8000;
    try {
      const savedDuration = parseInt(localStorage.getItem("eaut_avg_crawl_time") || "8000", 10);
      if (savedDuration >= 3000 && savedDuration <= 15000) {
        estimatedMs = savedDuration;
      }
    } catch (e) {}

    const updateCountdown = (elapsed) => {
      if (!loadingTimer) return;
      const remainingMs = estimatedMs - elapsed;
      if (remainingMs > 1000) {
        const sec = Math.ceil(remainingMs / 1000);
        loadingTimer.textContent = `Ước tính: ${sec} giây`;
      } else if (remainingMs > 0) {
        loadingTimer.textContent = `Ước tính: 1 giây`;
      } else {
        loadingTimer.textContent = `Ước tính: gần xong...`;
      }
    };

    updateCountdown(0);

    liveTimerInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      pingText.textContent = `${elapsed} ms`;
      updateCountdown(elapsed);
      if (elapsed >= 400) {
        pingBadge.classList.remove("is-medium");
        pingBadge.classList.add("is-poor");
      }
    }, 50);
  };

  // Attach tracker to all navigation links (ngoại trừ các tab chuyển tức thì)
  document.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:") && !link.target) {
      link.addEventListener("click", () => {
        if (!link.hasAttribute("download") && !link.closest(".sidebar-nav a[data-nav-item]")) {
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

// --- InstantTabNavigator: Chuyển tab lịch học tức thì (0ms) với bộ nhớ đệm thiết bị ---
window.InstantTabNavigator = (() => {
  const memoryCache = new Map();
  const STORAGE_PREFIX = "eaut_view_html_";
  let isNavigating = false;

  const metaEl = document.getElementById("eautAppMeta");
  const user = metaEl ? metaEl.getAttribute("data-user") : (window.__EAUT_USER__ || "");

  const normalizeUrl = (url) => {
    try {
      const u = new URL(url, window.location.origin);
      return u.pathname + u.search;
    } catch {
      return url;
    }
  };

  const getStorageKey = (url) => {
    return STORAGE_PREFIX + (user || "anon") + "_" + normalizeUrl(url);
  };

  const saveCache = (url, data) => {
    const norm = normalizeUrl(url);
    memoryCache.set(norm, {
      ...data,
      timestamp: Date.now()
    });
    try {
      sessionStorage.setItem(getStorageKey(norm), JSON.stringify({
        title: data.title,
        html: data.html,
        timestamp: Date.now()
      }));
    } catch (e) {}
  };

  const getCache = (url) => {
    const norm = normalizeUrl(url);
    if (memoryCache.has(norm)) {
      return memoryCache.get(norm);
    }
    try {
      const raw = sessionStorage.getItem(getStorageKey(norm));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.timestamp < 2 * 60 * 60 * 1000) {
          memoryCache.set(norm, parsed);
          return parsed;
        }
      }
    } catch (e) {}
    return null;
  };

  const updateActiveNav = (targetUrl) => {
    const norm = normalizeUrl(targetUrl);
    let navType = "weekly";
    if (norm.startsWith("/schedule/term")) navType = "term";
    else if (norm.startsWith("/schedule/exam")) navType = "exams";

    document.querySelectorAll("[data-nav-item]").forEach((item) => {
      const id = item.getAttribute("data-nav-item");
      item.classList.toggle("is-active", id === navType);
    });
  };

  let progressBar = null;
  const showProgressBar = () => {
    if (!progressBar) {
      progressBar = document.createElement("div");
      progressBar.className = "top-progress-bar";
      progressBar.style.cssText = "position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,var(--primary,#4f46e5),#38bdf8);z-index:99999;transition:width 0.2s ease;width:0%;box-shadow:0 0 8px rgba(56,189,248,0.6);";
      document.body.appendChild(progressBar);
    }
    progressBar.style.display = "block";
    progressBar.style.width = "35%";
  };

  const finishProgressBar = () => {
    if (progressBar) {
      progressBar.style.width = "100%";
      setTimeout(() => {
        if (progressBar) {
          progressBar.style.display = "none";
          progressBar.style.width = "0%";
        }
      }, 200);
    }
  };

  const applyWorkspaceHTML = (html, targetUrl, title, isPopState = false) => {
    const workspace = document.getElementById("workspace");
    if (!workspace) return false;

    // 1. Hoán đổi DOM tức thì
    workspace.innerHTML = html;

    // 2. Đồng bộ menu sidebar và tiêu đề trang
    updateActiveNav(targetUrl);
    if (title) document.title = title;

    // 3. Cập nhật URL trình duyệt nếu không phải từ nút Back/Forward
    if (!isPopState) {
      window.history.pushState({ instant: true, url: targetUrl }, "", targetUrl);
    }

    // 4. Cuộn lên đầu giao diện mượt mà
    window.scrollTo({ top: 0, behavior: "instant" });

    // 5. Đóng sidebar trên thiết bị di động
    if (typeof setSidebarOpen === "function") {
      setSidebarOpen(false);
    }

    // 6. Phát cảm ứng chạm xúc giác
    if (typeof window.playTactileTap === "function") {
      window.playTactileTap();
    }

    // 7. Kích hoạt lại các bộ lọc, chế độ xem, select của view mới
    if (typeof rebindInteractiveHandlers === "function") {
      rebindInteractiveHandlers();
    }

    // 8. Cập nhật Ping hiển thị phản hồi tức thì (< 1ms từ phần cứng máy)
    const pingText = document.getElementById("pingText");
    const pingBadge = document.getElementById("pingBadge");
    if (pingText && pingBadge) {
      pingBadge.classList.remove("is-poor", "is-medium", "is-measuring");
      pingBadge.classList.add("is-good");
      pingText.textContent = "1 ms";
      pingBadge.title = "Dữ liệu tức thì từ bộ nhớ đệm thiết bị (0ms latency)";
    }

    return true;
  };

  const navigateTo = async (targetUrl, isPopState = false) => {
    const norm = normalizeUrl(targetUrl);

    // Nếu đang ở đúng URL này và không phải popstate, cuộn mượt lên đầu
    if (!isPopState && norm === normalizeUrl(window.location.pathname + window.location.search)) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    // Nếu là yêu cầu làm mới dữ liệu từ server
    if (norm.includes("refresh=1") || norm.includes("refresh=true")) {
      window.location.href = targetUrl;
      return;
    }

    // 1. Kiểm tra bộ nhớ đệm tức thì
    const cached = getCache(norm);
    if (cached && cached.html) {
      applyWorkspaceHTML(cached.html, norm, cached.title, isPopState);
      return;
    }

    // 2. Cache miss: Tải về từ server
    if (isNavigating) return;
    isNavigating = true;
    showProgressBar();

    try {
      const startTime = performance.now();
      const res = await fetch(targetUrl, {
        headers: { "X-Requested-With": "XMLHttpRequest" },
        credentials: "same-origin"
      });

      if (!res.ok) throw new Error("HTTP error " + res.status);

      const text = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");

      const newWorkspace = doc.getElementById("workspace");
      if (newWorkspace) {
        const pageTitle = doc.title || document.title;
        const pageHtml = newWorkspace.innerHTML;

        saveCache(norm, {
          title: pageTitle,
          html: pageHtml
        });

        applyWorkspaceHTML(pageHtml, norm, pageTitle, isPopState);

        const fetchTime = Math.round(performance.now() - startTime);
        const pingText = document.getElementById("pingText");
        if (pingText) pingText.textContent = `${fetchTime} ms`;
      } else {
        window.location.href = targetUrl;
      }
    } catch (err) {
      console.error("[InstantNav] Fallback chuyển trang thường:", err);
      window.location.href = targetUrl;
    } finally {
      isNavigating = false;
      finishProgressBar();
    }
  };

  const prefetchTabs = async () => {
    const tabsToPrefetch = ["/schedule/week", "/schedule/term", "/schedule/exam"];
    const currentNorm = normalizeUrl(window.location.pathname);

    for (const url of tabsToPrefetch) {
      if (normalizeUrl(url) !== currentNorm && !getCache(url)) {
        try {
          const res = await fetch(url, {
            headers: { "X-Requested-With": "XMLHttpRequest" },
            credentials: "same-origin"
          });
          if (res.ok) {
            const text = await res.text();
            const doc = new DOMParser().parseFromString(text, "text/html");
            const newWorkspace = doc.getElementById("workspace");
            if (newWorkspace) {
              saveCache(url, {
                title: doc.title || document.title,
                html: newWorkspace.innerHTML
              });
            }
          }
        } catch (e) {}
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  };

  const init = () => {
    const currentWorkspace = document.getElementById("workspace");
    if (!currentWorkspace) return;

    // 1. Lưu ngay chế độ xem ban đầu vào cache
    const currentUrl = normalizeUrl(window.location.pathname + window.location.search);
    saveCache(currentUrl, {
      title: document.title,
      html: currentWorkspace.innerHTML
    });

    // 2. Chặn các liên kết menu điều hướng chính để chuyển tab tức thì
    document.querySelectorAll(".sidebar-nav a[data-nav-item]").forEach((link) => {
      const navItem = link.getAttribute("data-nav-item");
      if (["weekly", "term", "exams"].includes(navItem)) {
        link.addEventListener("click", (e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          const targetUrl = link.getAttribute("href");
          if (targetUrl) {
            navigateTo(targetUrl);
          }
        });

        // Nạp trước khi rê chuột hoặc chạm nhẹ
        const handlePreload = () => {
          const targetUrl = link.getAttribute("href");
          if (targetUrl && !getCache(targetUrl) && !link._hasPrefetched) {
            link._hasPrefetched = true;
            fetch(targetUrl, { headers: { "X-Requested-With": "XMLHttpRequest" } })
              .then((res) => res.text())
              .then((text) => {
                const doc = new DOMParser().parseFromString(text, "text/html");
                const ws = doc.getElementById("workspace");
                if (ws) {
                  saveCache(targetUrl, { title: doc.title || document.title, html: ws.innerHTML });
                }
              })
              .catch(() => {});
          }
        };
        link.addEventListener("mouseenter", handlePreload, { passive: true });
        link.addEventListener("touchstart", handlePreload, { passive: true });
      }
    });

    // 3. Hỗ trợ nút Back / Forward của trình duyệt
    window.addEventListener("popstate", () => {
      const targetUrl = normalizeUrl(window.location.pathname + window.location.search);
      if (targetUrl.includes("/schedule/")) {
        navigateTo(targetUrl, true);
      }
    });

    // 4. Nạp ngầm các tab còn lại khi máy rảnh
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(prefetchTabs, { timeout: 2000 });
    } else {
      setTimeout(prefetchTabs, 800);
    }
  };

  return {
    init,
    navigateTo,
    saveCache,
    getCache
  };
})();

// Khởi chạy bộ chuyển tab tức thì
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => window.InstantTabNavigator.init());
} else {
  window.InstantTabNavigator.init();
}
