const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// Sidebar (mobile)
const sidebar = $("[data-sidebar]");
const sidebarToggle = $("[data-sidebar-toggle]");
const sidebarBackdrop = $("[data-sidebar-backdrop]");

const setSidebarOpen = (isOpen) => {
  if (!sidebar) return;
  sidebar.classList.toggle("is-open", isOpen);
  sidebarBackdrop?.classList.toggle("is-open", isOpen);
  sidebarToggle?.setAttribute("aria-expanded", String(isOpen));
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
  const root = document.documentElement;
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
