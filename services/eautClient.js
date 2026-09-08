const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const isServerless =
  process.env.VERCEL === "1" ||
  Boolean(process.env.VERCEL_ENV) ||
  Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
  (process.env.NODE_ENV === "production" && process.platform === "linux");

// ─── Cache Management & Change Detection ──────────────────────────────
const scheduleCache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours TTL

const CACHE_DIR = isServerless ? path.join("/tmp", "eaut_cache") : path.join(process.cwd(), ".cache");
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
} catch (e) {}

function getDiskCache(key) {
  try {
    const safeKey = crypto.createHash("md5").update(key).digest("hex");
    const filePath = path.join(CACHE_DIR, `${safeKey}.json`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      const entry = JSON.parse(content);
      if (Date.now() - entry.timestamp <= CACHE_TTL) {
        return entry.data;
      }
      fs.unlinkSync(filePath);
    }
  } catch (e) {}
  return null;
}

function setDiskCache(key, data) {
  try {
    const safeKey = crypto.createHash("md5").update(key).digest("hex");
    const filePath = path.join(CACHE_DIR, `${safeKey}.json`);
    const entry = {
      timestamp: Date.now(),
      data,
    };
    fs.writeFileSync(filePath, JSON.stringify(entry), "utf8");
  } catch (e) {}
}

function computeHash(obj) {
  try {
    return crypto.createHash("sha256").update(JSON.stringify(obj || {})).digest("hex");
  } catch (e) {
    return "";
  }
}

function cacheKey(username, type, options) {
  return `${username}|${type}|${JSON.stringify(options)}`;
}

function getFromCache(key) {
  const entry = scheduleCache.get(key);
  if (entry) {
    if (Date.now() - entry.timestamp <= CACHE_TTL) {
      return entry.data;
    }
    scheduleCache.delete(key);
  }
  const diskData = getDiskCache(key);
  if (diskData) {
    scheduleCache.set(key, { data: diskData, timestamp: Date.now() });
    return diskData;
  }
  return null;
}

function setCache(key, data) {
  if (!data) return;
  const dataHash = computeHash(data);
  const enrichedData = {
    ...data,
    _metadata: {
      cachedAt: new Date().toISOString(),
      dataHash: dataHash,
    },
  };
  scheduleCache.set(key, { data: enrichedData, timestamp: Date.now(), hash: dataHash });
  setDiskCache(key, enrichedData);
}

// ─── Puppeteer Singleton Browser Management ────────────────────────────
let _browser = null;
async function getBrowser() {
  if (_browser && _browser.connected) return _browser;

  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;

  if (execPath) {
    // ── Docker / Railway / Render: dùng Chrome hệ thống ──────────────
    console.log(`[BROWSER] Docker mode - Chrome: ${execPath}`);
    const { default: puppeteerCore } = await import("puppeteer-core");
    _browser = await puppeteerCore.launch({
      headless: true,
      executablePath: execPath,
      ignoreHTTPSErrors: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--ignore-certificate-errors",
      ],
    });
  } else if (isServerless) {
    // ── Production (Vercel / AWS Lambda): dùng Chromium dành cho serverless ──
    console.log("[BROWSER] Serverless mode - using @sparticuz/chromium");

    const { default: chromium } = await import("@sparticuz/chromium");
    const { default: puppeteerCore } = await import("puppeteer-core");

    // Tắt đồ họa WebGL để tiết kiệm RAM và giảm thời gian giải nén
    chromium.setGraphicsMode = false;

    const CHROMIUM_PACK_URL =
      process.env.CHROMIUM_PACK_URL ||
      "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.tar";

    let executablePath;
    const defaultBin = path.join(process.cwd(), "node_modules", "@sparticuz", "chromium", "bin");

    if (fs.existsSync(defaultBin)) {
      executablePath = await chromium.executablePath();
    } else {
      console.log("[BROWSER] Local Chromium binary not packaged, fetching remote pack...");
      executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);
    }

    _browser = await puppeteerCore.launch({
      args: [
        ...chromium.args,
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      defaultViewport: chromium.defaultViewport || { width: 1280, height: 800 },
      executablePath: executablePath,
      headless: "shell",
      ignoreHTTPSErrors: true,
    });

    _browser.on("disconnected", () => {
      console.log("[BROWSER] Chromium disconnected, resetting singleton.");
      _browser = null;
    });
  } else {
    // ── Local dev: dùng puppeteer bình thường ─────────────────────────
    console.log("[BROWSER] Local dev mode - bundled Chrome");
    const { default: puppeteer } = await import("puppeteer");
    _browser = await puppeteer.launch({
      headless: "new",
      ignoreHTTPSErrors: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-web-security",
        "--ignore-certificate-errors",
        "--ignore-certificate-errors-spki-list",
        "--disable-gpu",
        "--disable-dev-shm-usage",
      ],
    });
  }

  return _browser;
}



// ─── Worker Pool & Concurrency Semaphore Queue ─────────────────────────
const MAX_CONCURRENT_TASKS = 4;
let _activeCount = 0;
const _taskQueueList = [];

function enqueueTask(fn) {
  return new Promise((resolve, reject) => {
    const runTask = async () => {
      _activeCount++;
      const startTime = Date.now();
      try {
        console.log(`[CRAWL WORKER] Start task. Active workers: ${_activeCount}/${MAX_CONCURRENT_TASKS}`);
        const result = await fn();
        console.log(`[CRAWL WORKER] Task completed in ${Date.now() - startTime}ms.`);
        resolve(result);
      } catch (err) {
        console.error(`[CRAWL WORKER] Task failed in ${Date.now() - startTime}ms: ${err.message}`);
        reject(err);
      } finally {
        _activeCount--;
        if (_taskQueueList.length > 0) {
          const next = _taskQueueList.shift();
          next();
        }
      }
    };

    if (_activeCount < MAX_CONCURRENT_TASKS) {
      runTask();
    } else {
      console.log(`[CRAWL QUEUE] Task queued (active: ${_activeCount}, queue length: ${_taskQueueList.length + 1})`);
      _taskQueueList.push(runTask);
    }
  });
}

// ─── Request Interception for Speed Optimization ───────────────────────
async function setupPageInterception(page) {
  if (!page || page.isClosed() || page._hasInterception) return;
  page._hasInterception = true;
  await page.setRequestInterception(true).catch(() => {});
  page.on("request", (req) => {
    try {
      if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
      const resourceType = req.resourceType();
      const url = req.url().toLowerCase();

      // Block non-essential media, fonts, styles & tracking
      if (
        resourceType === "image" ||
        resourceType === "font" ||
        resourceType === "media" ||
        url.includes("google-analytics") ||
        url.includes("firebase") ||
        url.includes("socket.io") ||
        url.includes("mathjax") ||
        url.includes("slick") ||
        url.includes("swiper")
      ) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    } catch (e) {}
  });
}

async function cleanupPage(page, browserContext) {
  if (isServerless) {
    if (page && !page.isClosed()) {
      try {
        page.removeAllListeners("request");
        await page.setRequestInterception(false).catch(() => {});
        page._hasInterception = false;
        await page.goto("about:blank").catch(() => {});
      } catch (e) {}
    }
  } else {
    if (page) await page.close().catch(() => {});
    if (browserContext) await browserContext.close().catch(() => {});
  }
}

// ─── Core: Login and Prepare an Authenticated Page ─────────────────────
async function createAuthenticatedPage(username, password) {
  const MAX_LOGIN_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
    const browser = await getBrowser();
    let context = null;
    let page;

    try {
      if (isServerless) {
        // Trong môi trường serverless: dùng trực tiếp page của default context
        // KHÔNG gọi createBrowserContext vì Chromium --single-process sẽ gây "Protocol error (Target.createTarget): Target closed"
        const pages = await browser.pages();
        page = pages.length > 0 ? pages[0] : await browser.newPage();

        // Reset request interception & listeners từ phiên trước để tránh Request already handled / block script
        page.removeAllListeners("request");
        await page.setRequestInterception(false).catch(() => {});
        page._hasInterception = false;

        // Xóa sạch cookie & cache cho phiên mới
        const client = await page.target().createCDPSession().catch(() => null);
        if (client) {
          await client.send("Network.clearBrowserCookies").catch(() => {});
          await client.send("Network.clearBrowserCache").catch(() => {});
          await client.detach().catch(() => {});
        }
      } else {
        context = typeof browser.createBrowserContext === "function"
          ? await browser.createBrowserContext()
          : typeof browser.createIncognitoBrowserContext === "function"
            ? await browser.createIncognitoBrowserContext()
            : browser.defaultBrowserContext();
        page = await context.newPage();
      }

      await page.setViewport({ width: 1280, height: 800 });

      // 1. Navigate to login page naturally (full JS/CSS bundles)
      await page.goto("https://qldt.eaut.edu.vn/congthongtin/login.aspx#diemhoc", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });

      const isLoginFormPresent = await page.waitForSelector('#username', { timeout: 5000 }).catch(() => null);

      if (isLoginFormPresent) {
        await page.focus('#username');
        await page.$eval('#username', (el) => (el.value = ''));
        await page.type('#username', username, { delay: 15 });

        await page.focus('#password');
        await page.$eval('#password', (el) => (el.value = ''));
        await page.type('#password', password, { delay: 15 });

        await Promise.all([
          page.click('#cms_authenticate_do_login'),
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => { }),
        ]);

        // Đợi chuyển hướng rời khỏi login.aspx sang Index.aspx (nếu có)
        await page.waitForFunction(
          () => !window.location.pathname.toLowerCase().includes("login.aspx") ||
                (window.edu && window.edu.system && window.edu.system.userId),
          { timeout: 15000 }
        ).catch(() => {});
      }

      // 2. Wait up to 15s for SPA framework & userId initialization
      const isAuthenticated = await page.waitForFunction(
        () =>
          window.edu &&
          window.edu.system &&
          window.edu.system.userId &&
          typeof window.edu.system.makeRequest === "function",
        { timeout: 15000 }
      ).then(() => true).catch(() => false);

      if (!isAuthenticated) {
        const errorMsg = await page.evaluate(() => {
          const errEl = document.querySelector("#lblError, .text-danger, .error-message, font[color='red'], div[style*='color: red'], div[style*='color:Red'], #divError");
          if (errEl && errEl.textContent.trim()) return errEl.textContent.trim();
          const bodyText = document.body.innerText || "";
          if (bodyText.includes("ORA-") || bodyText.includes("PL/SQL") || bodyText.includes("QTDHDA")) {
            return "Hệ thống máy chủ EAUT đang gặp sự cố cơ sở dữ liệu (Oracle Database Error). Vui lòng thử lại sau ít phút.";
          }
          return "";
        });

        if (errorMsg) {
          throw new Error(`Đăng nhập thất bại: ${errorMsg}`);
        }
        throw new Error("Đăng nhập thất bại. Vui lòng kiểm tra lại tài khoản và mật khẩu.");
      }

      const studentName = await page.evaluate(() => {
        const el = document.querySelector("#lblHoTenNguoiDangNhap");
        if (el) return el.textContent.trim();
        const span = document.querySelector(".nav-account button > span");
        if (span) return span.textContent.trim();
        return "";
      });

      // 3. Enable request interception AFTER authentication to speed up data scraping
      await setupPageInterception(page);

      console.log(`[AUTH SUCCESS] Logged in for ${studentName || username} (${username}) (attempt ${attempt})`);
      return { browserContext: context, page, studentName };
    } catch (error) {
      await cleanupPage(page, context);

      if (_browser && !_browser.connected) {
        _browser = null;
      }

      if (error.message.includes("Đăng nhập thất bại")) {
        throw error;
      }

      if (attempt < MAX_LOGIN_RETRIES) {
        console.log(`[AUTH RETRY] Attempt ${attempt} failed (${error.message}), retrying in ${attempt * 1000}ms...`);
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }

      throw error;
    }
  }
}

// ─── Helper: Call SPA internal API via page.evaluate ───────────────────
async function callSPAApi(page, apiAction, apiFunc, params = {}) {
  // Ensure the page has the SPA framework initialized
  const isReady = await page.waitForFunction(
    () => window.edu && window.edu.system && typeof window.edu.system.makeRequest === "function",
    { timeout: 12000 }
  ).then(() => true).catch(() => false);

  if (!isReady) {
    const currentUrl = page.url();
    console.error(`[SPA API ERROR] SPA framework not ready on URL: ${currentUrl}`);
    if (currentUrl.includes("login.aspx")) {
      throw new Error("Phiên đăng nhập đã hết hạn hoặc chưa hoàn tất. Vui lòng thử lại.");
    }
    throw new Error("Hệ thống cổng trường đang phản hồi chậm. Vui lòng thử lại sau ít giây.");
  }

  return await page.evaluate(
    async (action, func, extraParams) => {
      return new Promise((resolve, reject) => {
        if (!window.edu || !window.edu.system || typeof window.edu.system.makeRequest !== "function") {
          reject(new Error("Hệ thống cổng trường chưa sẵn sàng. Vui lòng thử lại."));
          return;
        }
        const requestData = {
          action: action,
          func: func,
          iM: window.edu.system.iM,
          ...extraParams,
        };
        window.edu.system.makeRequest(
          {
            success: function (d) {
              resolve(d);
            },
            error: function (err) {
              reject(new Error("API error: " + JSON.stringify(err)));
            },
            type: "POST",
            action: action,
            contentType: true,
            data: requestData,
            fakedb: [],
          },
          false,
          false,
          false,
          null
        );
        setTimeout(() => resolve({ Success: false, Data: [] }), 15000);
      });
    },
    apiAction,
    apiFunc,
    params
  );
}

// ─── Helper: Navigate to a SPA module ──────────────────────────────────
async function navigateToModule(page, hash, htmlPath, moduleId) {
  await page.evaluate(
    (h, p, id) => {
      if (window.edu && window.edu.system && window.edu.system.initMain) {
        window.edu.system.initMain(h, p, id);
      } else {
        const link = document.querySelector(`a[href="${h}"]`);
        if (link) link.click();
      }
    },
    hash,
    htmlPath,
    moduleId
  );
  await new Promise((r) => setTimeout(r, 300));
}

// ─── Helper: Date & Week Formatter ─────────────────────────────────────
function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function getWeekRange(referenceDate) {
  const d = new Date(referenceDate);
  const day = d.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMon);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: monday, end: sunday };
}

function parseDDMMYYYY(str) {
  if (!str) return null;
  const parts = str.split("/");
  if (parts.length !== 3) return null;
  return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
}

function getDayOfWeek(dateStr) {
  const d = parseDDMMYYYY(dateStr);
  if (!d) return "Khong ro";
  const names = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
  return names[d.getDay()];
}

function formatSemLabel(raw) {
  let s = String(raw || "").trim();
  const m = s.match(/(\d{4})[\_\-\s]+(\d{4})[\_\-\s]+(\d+)/);
  if (m) return `HK${m[3]} (${m[1]}-${m[2]})`;
  const m2 = s.match(/học\s*kỳ\s*(\d+).*?(\d{4})\s*[\-\_]?\s*(\d{4})/i);
  if (m2) return `HK${m2[1]} (${m2[2]}-${m2[3]})`;
  return s;
}

function inferSemesterFromDate(dateStr, fallbackSemLabel, classCode = "") {
  // 1. Check if classCode explicitly has semester pattern like -1-1-26 or -2-1-25
  if (classCode) {
    const codeMatch = String(classCode).match(/[-_](\d)[-_](\d)[-_](\d{2})/);
    if (codeMatch) {
      const hkNum = parseInt(codeMatch[1], 10);
      let year = parseInt(codeMatch[3], 10);
      if (year < 100) year += 2000;
      if (hkNum === 1) {
        return `HK1 (${year}-${year + 1})`;
      } else {
        return `HK${hkNum} (${year - 1}-${year})`;
      }
    }
  }

  if (!dateStr || dateStr === "-") return fallbackSemLabel || "Học kỳ hiện tại";
  const parts = dateStr.split("/");
  if (parts.length !== 3) return fallbackSemLabel || "Học kỳ hiện tại";

  const month = parseInt(parts[1], 10);
  let year = parseInt(parts[2], 10);
  if (year < 100) year += 2000;
  if (isNaN(month) || isNaN(year)) return fallbackSemLabel || "Học kỳ hiện tại";

  let startYear, endYear, hkNum;
  if (month >= 8) {
    // Tháng 8, 9, 10, 11, 12 thuộc Học kỳ 1 của năm học mới (year - year+1)
    startYear = year;
    endYear = year + 1;
    hkNum = 1;
  } else if (month <= 1) {
    // Tháng 1 vẫn thuộc Học kỳ 1 của năm học trước (year-1 - year)
    startYear = year - 1;
    endYear = year;
    hkNum = 1;
  } else {
    // Tháng 2, 3, 4, 5, 6, 7 thuộc Học kỳ 2 của năm học (year-1 - year)
    startYear = year - 1;
    endYear = year;
    hkNum = 2;
  }

  return `HK${hkNum} (${startYear}-${endYear})`;
}

// ─── INTERNAL FETCHERS (Run on an open Puppeteer Page) ────────────────

async function fetchWeeklyScheduleInternal(page, username, studentName, options = {}) {
  const preferredWeek = options.preferredWeek || null;
  const preferredSemester = options.preferredSemester || null;
  const strictWeek = Boolean(options.strictWeek);

  await navigateToModule(
    page,
    "#lichhoc",
    "/modules/thoikhoabieu/html/lichhoc.html",
    "B46109CD333D4E3DAC50D43E8607ED46"
  );

  let weekStart, weekEnd;
  if (preferredWeek) {
    const parsed = parseDDMMYYYY(preferredWeek);
    if (parsed) {
      const range = getWeekRange(parsed);
      weekStart = range.start;
      weekEnd = range.end;
    } else {
      const range = getWeekRange(new Date());
      weekStart = range.start;
      weekEnd = range.end;
    }
  } else {
    const range = getWeekRange(new Date());
    weekStart = range.start;
    weekEnd = range.end;
  }

  const startStr = formatDate(weekStart);
  const endStr = formatDate(weekEnd);

  const userId = await page.evaluate(() => window.edu?.system?.userId || "");
  const response = await callSPAApi(
    page,
    "SV_ThongTin_MH/DSA4BRINKCIpAiAPKSAv",
    "pkg_congthongtin_hssv_thongtin.LayDSLichCaNhan",
    {
      strQLSV_NguoiHoc_Id: userId,
      strNgayBatDau: startStr,
      strNgayKetThuc: endStr,
    }
  );

  const allItems = (response && response.Success && response.Data) ? response.Data : [];
  const scheduleItems = allItems.filter((e) => e && e.PHANLOAI !== "LICHTHI");

  const headers = [
    "Thu", "Ngay", "Mon hoc", "Phong", "Giang vien",
    "Tiet bat dau", "So tiet", "Gio hoc", "Ca hoc", "Ma lop", "Hinh thuc hoc",
  ];

  const rows = scheduleItems.map((item) => {
    const pad = (n) => String(n || 0).padStart(2, "0");
    const ngay = item.NGAYHOC || "";
    const thu = getDayOfWeek(ngay);
    const tenHP = item.TENHOCPHAN || "Đang cập nhật";
    const phong = item.PHONGHOC_TEN || item.TENPHONGHOC || "Đang cập nhật";
    const giangVien = item.TENGIAOVIEN || item.TENGV || item.GIANGVIEN || "Đang cập nhật";
    const tietBD = item.TIETBATDAU || "-";
    const tietKT = item.TIETKETTHUC || "-";
    const soTiet =
      tietBD !== "-" && tietKT !== "-" ? String(Math.max(Number(tietKT) - Number(tietBD) + 1, 1)) : "-";
    const gioBD = `${pad(item.GIOBATDAU)}:${pad(item.PHUTBATDAU)}`;
    const gioKT = `${pad(item.GIOKETTHUC)}:${pad(item.PHUTKETTHUC)}`;
    const gioHoc = gioBD !== "00:00" || gioKT !== "00:00" ? `${gioBD}-${gioKT}` : "-";
    const caHoc = item.CAHOC || item.TENCA || "-";
    const maLop = item.MALOPHOCPHAN || item.TENLOPHOCPHAN || "-";
    
    // Determine Hình thức học: Trực tiếp vs Elearning
    const rawMode = String(item.HINHTHUCHOC || item.LOAILOPHOCPHAN || "").trim();
    const rawModeLower = rawMode.toLowerCase();
    const roomClean = String(phong || "").trim();
    const hasRoom = roomClean && roomClean !== "-" && roomClean !== "Đang cập nhật" && !roomClean.toLowerCase().includes("online") && !roomClean.toLowerCase().includes("elearning");

    let hinhThuc = "Trực tiếp";
    if (rawModeLower.includes("elearning") || rawModeLower.includes("online") || rawModeLower.includes("trực tuyến")) {
      hinhThuc = "Elearning";
    } else if (rawModeLower.includes("trực tiếp") || rawModeLower.includes("offline")) {
      hinhThuc = "Trực tiếp";
    } else if (hasRoom) {
      hinhThuc = "Trực tiếp";
    } else {
      hinhThuc = "Elearning";
    }

    return [thu, ngay, tenHP, phong, giangVien, String(tietBD), soTiet, gioHoc, caHoc, maLop, hinhThuc];
  });

  rows.sort((a, b) => {
    const dateA = parseDDMMYYYY(a[1]) || new Date(0);
    const dateB = parseDDMMYYYY(b[1]) || new Date(0);
    if (dateA.getTime() !== dateB.getTime()) return dateA - dateB;
    return (parseInt(a[5]) || 0) - (parseInt(b[5]) || 0);
  });

  const weekOptions = [];
  for (let i = -4; i <= 4; i++) {
    const wStart = new Date(weekStart);
    wStart.setDate(wStart.getDate() + i * 7);
    const wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 6);
    const label = `${formatDate(wStart)} - ${formatDate(wEnd)}`;
    const value = formatDate(wStart);
    weekOptions.push({ label, value, selected: i === 0 });
  }

  const semesterOptions = await page.evaluate(() => {
    const options = [];
    const select = document.querySelector("#dropSearch_HocKy, select[id*='HocKy']");
    if (select) {
      select.querySelectorAll("option").forEach((opt) => {
        if (opt.value) {
          options.push({ label: opt.textContent.trim(), value: opt.value, selected: opt.selected });
        }
      });
    }
    return options;
  });

  const result = {
    scheduleUrl: "https://qldt.eaut.edu.vn/congthongtin/Index.aspx#lichhoc",
    fetchedAt: new Date().toISOString(),
    hasData: rows.length > 0,
    selectedWeekLabel: `${startStr} - ${endStr}`,
    selectedWeekValue: startStr,
    weekOptions,
    semesterOptions,
    selectedSemesterValue: preferredSemester || null,
    autoSwitchedWeek: false,
    originalWeekLabel: `${startStr} - ${endStr}`,
    studentName,
    headers,
    rows,
  };

  if (!strictWeek && rows.length === 0) {
    for (let offset of [-7, 7, -14, 14]) {
      const altStart = new Date(weekStart);
      altStart.setDate(altStart.getDate() + offset);
      const altEnd = new Date(altStart);
      altEnd.setDate(altStart.getDate() + 6);

      const altResponse = await callSPAApi(
        page,
        "SV_ThongTin_MH/DSA4BRINKCIpAiAPKSAv",
        "pkg_congthongtin_hssv_thongtin.LayDSLichCaNhan",
        {
          strQLSV_NguoiHoc_Id: userId,
          strNgayBatDau: formatDate(altStart),
          strNgayKetThuc: formatDate(altEnd),
        }
      );

      const altItems = (altResponse && altResponse.Success && altResponse.Data) ? altResponse.Data : [];
      const altSchedule = altItems.filter((e) => e && e.PHANLOAI !== "LICHTHI");

      if (altSchedule.length > 0) {
        const altRows = altSchedule.map((item) => {
          const pad = (n) => String(n || 0).padStart(2, "0");
          const ngay = item.NGAYHOC || "";
          const thu = getDayOfWeek(ngay);
          const tenHP = item.TENHOCPHAN || "Đang cập nhật";
          const phong = item.PHONGHOC_TEN || item.TENPHONGHOC || "Đang cập nhật";
          const giangVien = item.TENGIAOVIEN || item.TENGV || item.GIANGVIEN || "Đang cập nhật";
          const tietBD = item.TIETBATDAU || "-";
          const tietKT = item.TIETKETTHUC || "-";
          const soTiet = tietBD !== "-" && tietKT !== "-" ? String(Math.max(Number(tietKT) - Number(tietBD) + 1, 1)) : "-";
          const gioBD = `${pad(item.GIOBATDAU)}:${pad(item.PHUTBATDAU)}`;
          const gioKT = `${pad(item.GIOKETTHUC)}:${pad(item.PHUTKETTHUC)}`;
          const gioHoc = gioBD !== "00:00" || gioKT !== "00:00" ? `${gioBD}-${gioKT}` : "-";
          const caHoc = item.CAHOC || item.TENCA || "-";
          const maLop = item.MALOPHOCPHAN || item.TENLOPHOCPHAN || "-";

          const rawMode = String(item.HINHTHUCHOC || item.LOAILOPHOCPHAN || "").trim();
          const rawModeLower = rawMode.toLowerCase();
          const roomClean = String(phong || "").trim();
          const hasRoom = roomClean && roomClean !== "-" && roomClean !== "Đang cập nhật" && !roomClean.toLowerCase().includes("online") && !roomClean.toLowerCase().includes("elearning");

          let hinhThuc = "Trực tiếp";
          if (rawModeLower.includes("elearning") || rawModeLower.includes("online") || rawModeLower.includes("trực tuyến")) {
            hinhThuc = "Elearning";
          } else if (rawModeLower.includes("trực tiếp") || rawModeLower.includes("offline")) {
            hinhThuc = "Trực tiếp";
          } else if (hasRoom) {
            hinhThuc = "Trực tiếp";
          } else {
            hinhThuc = "Elearning";
          }

          return [thu, ngay, tenHP, phong, giangVien, String(tietBD), soTiet, gioHoc, caHoc, maLop, hinhThuc];
        });
        altRows.sort((a, b) => {
          const dateA = parseDDMMYYYY(a[1]) || new Date(0);
          const dateB = parseDDMMYYYY(b[1]) || new Date(0);
          if (dateA.getTime() !== dateB.getTime()) return dateA - dateB;
          return (parseInt(a[5]) || 0) - (parseInt(b[5]) || 0);
        });
        result.rows = altRows;
        result.headers = headers;
        result.hasData = true;
        result.autoSwitchedWeek = true;
        result.selectedWeekLabel = `${formatDate(altStart)} - ${formatDate(altEnd)}`;
        result.selectedWeekValue = formatDate(altStart);
        break;
      }
    }
  }

  return result;
}

async function fetchTermScheduleInternal(page, username, studentName, options = {}) {
  const preferredSemester = options.preferredSemester || "";

  await navigateToModule(
    page,
    "#tracuu",
    "/modules/dangkyhoc/html/tracuu.html",
    "A9CE858670AE453B90BB0A74458EFA34"
  );

  // Wait up to 3 seconds for DOM select options to render
  await page
    .waitForFunction(
      () => {
        const sel = document.querySelector("#dropSearch_HocKy");
        return sel && sel.querySelectorAll("option").length > 1;
      },
      { timeout: 3000 }
    )
    .catch(() => { });

  // Extract semester dropdown options directly from DOM
  const semesterOptions = await page.evaluate(() => {
    const options = [];
    const sel = document.querySelector("#dropSearch_HocKy");
    if (sel) {
      sel.querySelectorAll("option").forEach((opt) => {
        if (opt.value && opt.value !== "all") {
          options.push({ label: opt.textContent.trim(), value: opt.value, selected: opt.selected });
        }
      });
    }
    return options;
  });

  // Fetch complete personal schedule API data across the year range
  const userId = await page.evaluate(() => window.edu?.system?.userId || "");
  const now = new Date();
  const semStart = new Date(now.getFullYear() - 1, 0, 1);
  const semEnd = new Date(now.getFullYear() + 1, 11, 31);

  const apiResponse = await callSPAApi(
    page,
    "SV_ThongTin_MH/DSA4BRINKCIpAiAPKSAv",
    "pkg_congthongtin_hssv_thongtin.LayDSLichCaNhan",
    {
      strQLSV_NguoiHoc_Id: userId,
      strNgayBatDau: formatDate(semStart),
      strNgayKetThuc: formatDate(semEnd),
    }
  );

  const scheduleData = (apiResponse && apiResponse.Success && apiResponse.Data) ? apiResponse.Data : [];

  const cleanString = (str) =>
    String(str || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/&lt;br\s*\/?&gt;/gi, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;[^&]*&gt;/gi, "")
      .replace(/\s*Có mặt\s*/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  // Map courses by inferred Semester Label from NGAYHOC or DOM option
  const semMap = new Map();
  const termHeaders = ["Mã lớp", "Tên học phần", "Hình thức", "Thời gian học", "Phòng", "Học phí"];

  for (const s of scheduleData) {
    if (!s || s.PHANLOAI === "LICHTHI") continue;
    const cName = cleanString(s.TENHOCPHAN);
    if (!cName) continue;
    const cClass = cleanString(s.MALOPHOCPHAN || s.TENLOPHOCPHAN || cName);
    const teacher = cleanString(s.TENGIAOVIEN || s.TENGV || s.GIANGVIEN) || "Đang cập nhật";
    const room = cleanString(s.PHONGHOC_TEN || s.TENPHONGHOC) || "Đang cập nhật";
    const credits = cleanString(s.SOTINCHI || s.TINCHI) || "3";
    const rawHinhThuc = cleanString(s.HINHTHUCHOC || s.LOAILOPHOCPHAN) || "";
    const ngay = s.NGAYHOC || "";

    const rawModeLower = rawHinhThuc.toLowerCase();
    const roomClean = room.trim();
    const hasRoom = roomClean && roomClean !== "-" && roomClean !== "Đang cập nhật" && !roomClean.toLowerCase().includes("online") && !roomClean.toLowerCase().includes("elearning");

    let hinhThuc = "Trực tiếp";
    if (rawModeLower.includes("elearning") || rawModeLower.includes("online") || rawModeLower.includes("trực tuyến")) {
      hinhThuc = "Elearning";
    } else if (rawModeLower.includes("trực tiếp") || rawModeLower.includes("offline")) {
      hinhThuc = "Trực tiếp";
    } else if (hasRoom) {
      hinhThuc = "Trực tiếp";
    } else {
      hinhThuc = "Elearning";
    }

    const semLabel = inferSemesterFromDate(ngay, "Học kỳ hiện tại", cClass);

    if (!semMap.has(semLabel)) {
      semMap.set(semLabel, new Map());
    }
    const courseMap = semMap.get(semLabel);

    if (!courseMap.has(cClass.toLowerCase())) {
      courseMap.set(cClass.toLowerCase(), {
        id: cClass,
        name: cName,
        className: cClass,
        credits: credits,
        teacher: teacher,
        room: room,
        sessionDates: ngay ? [ngay] : [],
        sched: ngay ? `Lịch học: ${ngay}` : "Theo thời khóa biểu",
        fee: "0 đ",
        mode: hinhThuc,
      });
    } else {
      const existing = courseMap.get(cClass.toLowerCase());
      if (ngay && !existing.sessionDates.includes(ngay)) {
        existing.sessionDates.push(ngay);
      }
      if (teacher && teacher !== "Đang cập nhật") existing.teacher = teacher;
      if (room && room !== "Đang cập nhật") {
        existing.room = room;
        if (hasRoom) existing.mode = "Trực tiếp";
      }
      if (hinhThuc === "Trực tiếp") existing.mode = "Trực tiếp";
    }
  }

  // Format schedule date ranges for all courses
  for (const courseMap of semMap.values()) {
    for (const course of courseMap.values()) {
      if (course.sessionDates && course.sessionDates.length > 0) {
        course.sessionDates.sort((a, b) => {
          const dA = parseDDMMYYYY(a) || new Date(0);
          const dB = parseDDMMYYYY(b) || new Date(0);
          return dA - dB;
        });
        const first = course.sessionDates[0];
        const last = course.sessionDates[course.sessionDates.length - 1];
        if (first === last) {
          course.sched = `Bắt đầu ${first}`;
        } else {
          course.sched = `${first} → ${last}`;
        }
      }
      delete course.sessionDates;
    }
  }

  const mergedResults = [];
  for (const [semLabel, courseMap] of semMap.entries()) {
    mergedResults.push({
      semester: semLabel,
      headers: termHeaders,
      rows: Array.from(courseMap.values()),
    });
  }

  // Sort mergedResults chronologically oldest first so reverse() in index.ejs renders newest semester on top
  mergedResults.sort((a, b) => {
    const parseSem = (s) => {
      const m = String(s).match(/HK(\d+)\s*\((\d{4})-(\d{4})\)/i);
      if (m) return parseInt(m[2]) * 10 + parseInt(m[1]);
      return 0;
    };
    return parseSem(a.semester) - parseSem(b.semester);
  });

  // Format semester options for UI dropdown
  let formattedSemesterOptions = semesterOptions.map((s) => ({
    label: formatSemLabel(s.label),
    value: s.value,
    selected: preferredSemester === s.value,
  }));

  // Ensure all semesters present in mergedResults exist in dropdown options
  for (const r of mergedResults) {
    const semName = r.semester;
    const exists = formattedSemesterOptions.some(
      (opt) => opt.label === semName || formatSemLabel(opt.label) === semName
    );
    if (!exists) {
      formattedSemesterOptions.push({
        label: semName,
        value: semName,
        selected: preferredSemester === semName,
      });
    }
  }

  // Failsafe: If DOM select options were empty, fallback to semMap keys!
  if (formattedSemesterOptions.length === 0) {
    for (const semLabel of semMap.keys()) {
      formattedSemesterOptions.push({
        label: semLabel,
        value: semLabel,
        selected: preferredSemester === semLabel,
      });
    }
  }

  // Sort semester options newest first
  formattedSemesterOptions.sort((a, b) => {
    const parseSem = (s) => {
      const m = String(s).match(/HK(\d+)\s*\((\d{4})-(\d{4})\)/i);
      if (m) return parseInt(m[2]) * 10 + parseInt(m[1]);
      return 0;
    };
    return parseSem(b.label) - parseSem(a.label);
  });

  const finalOptions = [
    { label: "-- Xem tất cả học kỳ --", value: "all", selected: !preferredSemester || preferredSemester === "all" },
    ...formattedSemesterOptions,
  ];

  return {
    termUrl: "https://qldt.eaut.edu.vn/congthongtin/Index.aspx#tracuu",
    fetchedAt: new Date().toISOString(),
    semesterOptions: finalOptions,
    results: mergedResults,
    studentName,
  };
}

async function fetchExamScheduleInternal(page, username, studentName, options = {}) {
  const preferredSemester = options.preferredSemester || "all";

  await navigateToModule(
    page,
    "#lichthi",
    "/modules/thoikhoabieu/html/lichthi.html",
    "AF6FFE7566A84F058C31083395D4ED4B"
  );

  // 1. Wait up to 4s for #dropSearch_HocKy to populate with options
  await page
    .waitForFunction(
      () => {
        const sel = document.querySelector("#dropSearch_HocKy");
        return sel && sel.querySelectorAll("option").length > 1;
      },
      { timeout: 4000 }
    )
    .catch(() => {});

  // 2. Extract semester dropdown options directly from DOM
  const semesterOptions = await page.evaluate(() => {
    const options = [];
    const sel = document.querySelector("#dropSearch_HocKy");
    if (sel) {
      sel.querySelectorAll("option").forEach((opt) => {
        if (opt.value && opt.value !== "all") {
          options.push({ label: opt.textContent.trim(), value: opt.value, selected: opt.selected });
        }
      });
    }
    return options;
  });

  // 3. Determine which semesters to scrape from DOM table
  let semestersToScrape = [];
  if (preferredSemester && preferredSemester !== "all") {
    const matched = semesterOptions.find(
      (s) => s.value === preferredSemester || s.label === preferredSemester || formatSemLabel(s.label) === preferredSemester
    );
    if (matched) {
      semestersToScrape = [matched];
    } else {
      semestersToScrape = semesterOptions;
    }
  } else {
    semestersToScrape = semesterOptions;
  }
  if (semestersToScrape.length === 0 && semesterOptions.length > 0) {
    semestersToScrape = semesterOptions;
  }

  const scrapedResultsMap = new Map();

  // 4. Scrape each semester from #tblLichThiCaNhan (or fallback #tblLichThiChung)
  for (const semOpt of semestersToScrape) {
    const semLabel = formatSemLabel(semOpt.label);

    await page.evaluate((semVal) => {
      const sel = document.querySelector("#dropSearch_HocKy");
      if (sel) {
        sel.value = semVal;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        if (window.$ && window.$.fn.select2) {
          try { $(sel).trigger("change"); } catch (e) {}
        }
      }
    }, semOpt.value);
    await new Promise((r) => setTimeout(r, 150));

    await page.evaluate(() => {
      const btn = document.querySelector("#btnXemLich");
      if (btn) btn.click();
    });

    await page
      .waitForFunction(
        () => {
          const pTable = document.querySelector("#tblLichThiCaNhan tbody");
          const cTable = document.querySelector("#tblLichThiChung tbody");
          return (pTable && pTable.querySelectorAll("tr").length > 0) || (cTable && cTable.querySelectorAll("tr").length > 0);
        },
        { timeout: 2200 }
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 250));

    const rows = await page.evaluate(() => {
      const res = [];
      const clean = (s) => (s || "").trim().replace(/\s+/g, " ");

      // Lịch thi cá nhân: [STT, Mã HP, Tên HP, Lần thi, Ngày thi, Thời gian thi, Hình thức, Phòng thi, SBD, Thông tin SV]
      const pTable = document.querySelector("#tblLichThiCaNhan");
      if (pTable) {
        pTable.querySelectorAll("tbody tr").forEach((tr) => {
          const cells = [];
          tr.querySelectorAll("td").forEach((td) => cells.push(clean(td.textContent)));
          if (cells.length > 2 && cells.some((c) => c)) res.push(cells);
        });
      }

      // Kế hoạch thi chung fallback: [STT, Mã HP, Tên HP, Ngày thi, Thời gian thi, Hình thức, Phòng thi, SBD]
      if (res.length === 0) {
        const cTable = document.querySelector("#tblLichThiChung");
        if (cTable) {
          cTable.querySelectorAll("tbody tr").forEach((tr) => {
            const cells = [];
            tr.querySelectorAll("td").forEach((td) => cells.push(clean(td.textContent)));
            if (cells.length > 2 && cells.some((c) => c)) {
              res.push([
                cells[0] || "",
                cells[1] || "",
                cells[2] || "",
                "1",
                cells[3] || "-",
                cells[4] || "-",
                cells[5] || "-",
                cells[6] || "-",
                cells[7] || "-",
                ""
              ]);
            }
          });
        }
      }
      return res;
    });

    if (rows && rows.length > 0) {
      scrapedResultsMap.set(semLabel, rows);
    }
  }

  // 5. Query SPA APIs for 100% accurate SBD from official student exam endpoints
  const userId = await page.evaluate(() => window.edu?.system?.userId || "");

  // Query all available exam semesters from API LayDSThoiGianLichThi
  try {
    const hocKyResp = await callSPAApi(
      page,
      "SV_ThongTin_MH/DSA4BRIVKS4oBiggLw0oIikVKSgP",
      "pkg_congthongtin_hssv_thongtin.LayDSThoiGianLichThi",
      {
        strNguoiThucHien_Id: userId,
      }
    );
    if (hocKyResp && hocKyResp.Success && Array.isArray(hocKyResp.Data)) {
      hocKyResp.Data.forEach((hk) => {
        if (hk && hk.ID && !semesterOptions.some((s) => s.value === hk.ID)) {
          semesterOptions.push({
            label: hk.THOIGIAN ? hk.THOIGIAN.trim() : hk.ID,
            value: hk.ID,
            selected: false,
          });
        }
      });
    }
  } catch (e) {}

  const mergedSemestersMap = new Map();

  // Populate scraped table rows
  for (const [semLabel, rows] of scrapedResultsMap.entries()) {
    if (!mergedSemestersMap.has(semLabel)) {
      mergedSemestersMap.set(semLabel, []);
    }
    const semRows = mergedSemestersMap.get(semLabel);

    for (const cells of rows) {
      const courseName = cells[2] || cells[1] || "-";
      const attempt = String(cells[3] || "1").replace(/\D/g, "") || "1";
      const date = cells[4] || "-";
      const time = cells[5] || "-";
      const format = cells[6] && cells[6] !== "-" ? cells[6] : "Thi kết thúc HP";
      const room = cells[7] || "-";
      const sbd = cells[8] || "-";

      const existing = semRows.find((r) => r[1].toLowerCase().trim() === courseName.toLowerCase().trim());
      if (!existing) {
        semRows.push([semLabel, courseName, attempt, "-", date, "-", time, room, sbd, format]);
      } else {
        if ((!existing[8] || existing[8] === "-") && sbd !== "-") existing[8] = sbd;
        if ((!existing[7] || existing[7] === "-") && room !== "-") existing[7] = room;
        if ((!existing[9] || existing[9] === "-" || existing[9] === "Thi kết thúc HP") && format !== "-") existing[9] = format;
        if ((!existing[6] || existing[6] === "-") && time !== "-") existing[6] = time;
        if ((!existing[4] || existing[4] === "-") && date !== "-") existing[4] = date;
      }
    }
  }

  // Query official exam API LayDSLichThi_KeHoachThi (regular + history) for each semester
  const pad = (n) => String(n || 0).padStart(2, "0");
  const cleanStr = (s) => String(s || "").trim();

  for (const semOpt of semesterOptions) {
    const semLabel = formatSemLabel(semOpt.label);
    if (!mergedSemestersMap.has(semLabel)) {
      mergedSemestersMap.set(semLabel, []);
    }
    const semRows = mergedSemestersMap.get(semLabel);

    const callKeHoachThi = async (actionPath) => {
      try {
        const resp = await callSPAApi(
          page,
          actionPath,
          "pkg_congthongtin_hssv_thongtin.LayDSLichThi_KeHoachThi",
          {
            strQLSV_NguoiHoc_Id: userId,
            strDaoTao_ThoiGianDaoTao_Id: semOpt.value || "",
            strDaoTao_HocPhan_Id: "",
          }
        );
        return resp && resp.Success && resp.Data ? resp.Data : null;
      } catch (e) {
        return null;
      }
    };

    const dCurrent = await callKeHoachThi("SV_ThongTin_MH/DSA4BRINKCIpFSkoHgokCS4gIikVKSgP");
    const dHistory = await callKeHoachThi("SV_ThongTin_MH/DSA4BRINKCIpFSkoHgokCS4gIikVKSgeDSgiKRI0");

    const caNhanList = [
      ...(dCurrent && Array.isArray(dCurrent.rsLichThiCaNhan) ? dCurrent.rsLichThiCaNhan : []),
      ...(dHistory && Array.isArray(dHistory.rsLichThiCaNhan) ? dHistory.rsLichThiCaNhan : []),
    ];
    const chungList = [
      ...(dCurrent && Array.isArray(dCurrent.rsKeHoachThiChung) ? dCurrent.rsKeHoachThiChung : []),
      ...(dHistory && Array.isArray(dHistory.rsKeHoachThiChung) ? dHistory.rsKeHoachThiChung : []),
    ];

    const processItem = (item, isPersonal = false) => {
      if (!item) return;
      const cName = cleanStr(item.TENHOCPHAN);
      if (!cName) return;
      const attempt = String(item.LANTHI || "1").replace(/\D/g, "") || "1";
      const date = item.NGAYHOC || "-";
      const time = (item.GIOBATDAU != null || item.PHUTBATDAU != null)
        ? `${pad(item.GIOBATDAU)}:${pad(item.PHUTBATDAU)} - ${pad(item.GIOKETTHUC)}:${pad(item.PHUTKETTHUC)}`
        : "-";
      const format = cleanStr(item.DANGKY_LOPHOCPHAN_TEN) || "Thi kết thúc HP";
      const room = cleanStr(item.PHONGHOC_TEN) || "-";
      const rawSbd = item.SOBAODANH != null ? String(item.SOBAODANH).trim() : "";
      const sbd = (rawSbd && rawSbd !== "0" && rawSbd !== "-") ? rawSbd : (item.SBD || item.SO_BAO_DANH || "-");
      const credits = cleanStr(item.SOTINCHI || item.SO_TIN_CHI || item.TINCHI || item.SOTC || "");

      const existing = semRows.find((r) => r[1].toLowerCase().trim() === cName.toLowerCase().trim());
      if (!existing) {
        semRows.push([semLabel, cName, attempt, "-", date, "-", time, room, sbd, format, credits]);
      } else {
        if ((!existing[8] || existing[8] === "-") && sbd !== "-") existing[8] = sbd;
        if ((!existing[7] || existing[7] === "-") && room !== "-") existing[7] = room;
        if ((!existing[9] || existing[9] === "-" || existing[9] === "Thi kết thúc HP") && format !== "-") existing[9] = format;
        if ((!existing[6] || existing[6] === "-") && time !== "-") existing[6] = time;
        if ((!existing[4] || existing[4] === "-") && date !== "-") existing[4] = date;
        if (isPersonal && sbd !== "-") existing[8] = sbd;
        if (!existing[10] && credits) existing[10] = credits;
      }
    };

    caNhanList.forEach((it) => processItem(it, true));
    chungList.forEach((it) => processItem(it, false));
  }

  // Cross-query general student schedule API LayDSLichCaNhan as further cross-enrichment
  const now = new Date();
  const examStart = new Date(now.getFullYear() - 1, 0, 1);
  const examEnd = new Date(now.getFullYear() + 1, 11, 31);

  const apiResponse = await callSPAApi(
    page,
    "SV_ThongTin_MH/DSA4BRINKCIpAiAPKSAv",
    "pkg_congthongtin_hssv_thongtin.LayDSLichCaNhan",
    {
      strQLSV_NguoiHoc_Id: userId,
      strNgayBatDau: formatDate(examStart),
      strNgayKetThuc: formatDate(examEnd),
    }
  );

  const allItems = (apiResponse && apiResponse.Success && apiResponse.Data) ? apiResponse.Data : [];
  const apiExamItems = allItems.filter((e) => e && e.PHANLOAI === "LICHTHI");

  if (apiExamItems.length > 0) {
    for (const item of apiExamItems) {
      const cName = String(item.TENHOCPHAN || "").trim();
      if (!cName) continue;

      const date = item.NGAYHOC || "-";
      const gioBD = `${pad(item.GIOBATDAU)}:${pad(item.PHUTBATDAU)}`;
      const gioKT = `${pad(item.GIOKETTHUC)}:${pad(item.PHUTKETTHUC)}`;
      const time = (gioBD !== "00:00" || gioKT !== "00:00") ? `${gioBD} - ${gioKT}` : "-";
      const room = item.PHONGHOC_TEN || item.TENPHONGHOC || item.PHONGTHI || "-";
      const rawSbd = item.SOBAODANH != null ? String(item.SOBAODANH).trim() : "";
      const sbd = (rawSbd && rawSbd !== "0" && rawSbd !== "-") ? rawSbd : (item.SBD || item.SO_BAO_DANH || "-");
      const format = item.HINHTHUCTHI || item.LOAILOPHOCPHAN || item.DANGKY_LOPHOCPHAN_TEN || "Thi kết thúc HP";
      const attempt = String(item.LANTHI || "1").replace(/\D/g, "") || "1";
      const classCode = item.DANGKY_LOPHOCPHAN_MA || item.MALOPHOCPHAN || "";

      // Check if course already exists in ANY semester
      let foundExisting = false;
      for (const [_, rowsList] of mergedSemestersMap.entries()) {
        const match = rowsList.find((r) => r[1].toLowerCase().trim() === cName.toLowerCase().trim());
        if (match) {
          foundExisting = true;
          if ((!match[8] || match[8] === "-") && sbd !== "-") match[8] = sbd;
          if ((!match[7] || match[7] === "-") && room !== "-") match[7] = room;
          if ((!match[9] || match[9] === "-" || match[9] === "Thi kết thúc HP") && format && format !== "Thi kết thúc HP") match[9] = format;
          if ((!match[6] || match[6] === "-") && time !== "-") match[6] = time;
          if ((!match[4] || match[4] === "-") && date !== "-") match[4] = date;
          break;
        }
      }

      // If not present in any semester, add using inferred semester
      if (!foundExisting) {
        const inferredSem = inferSemesterFromDate(date, "Học kỳ hiện tại", classCode);
        if (!mergedSemestersMap.has(inferredSem)) {
          mergedSemestersMap.set(inferredSem, []);
        }
        mergedSemestersMap.get(inferredSem).push([inferredSem, cName, attempt, "-", date, "-", time, room, sbd, format, ""]);
      }
    }
  }

  // Sort rows chronologically inside each semester
  for (const rows of mergedSemestersMap.values()) {
    rows.sort((a, b) => {
      const dateA = parseDDMMYYYY(a[4]) || new Date(0);
      const dateB = parseDDMMYYYY(b[4]) || new Date(0);
      if (dateA.getTime() !== dateB.getTime()) return dateA - dateB;
      return (a[1] || "").localeCompare(b[1] || "");
    });
  }

  const examHeaders = ["HK", "Môn", "Lần", "Đợt", "Ngày", "Buổi", "Giờ", "Phòng", "SBD", "Hình thức"];
  let allResults = [];
  for (const [semester, rows] of mergedSemestersMap.entries()) {
    allResults.push({
      semester,
      headers: examHeaders,
      rows,
    });
  }

  // Sort semesters: newest first
  allResults.sort((a, b) => {
    const parseSem = (s) => {
      const m = String(s).match(/HK(\d+)\s*\((\d{4})-(\d{4})\)/i);
      if (m) return parseInt(m[2]) * 10 + parseInt(m[1]);
      return 0;
    };
    return parseSem(b.semester) - parseSem(a.semester);
  });

  let finalResults = [];
  if (preferredSemester && preferredSemester !== "all") {
    const selectedOpt = semesterOptions.find((s) => s.value === preferredSemester || s.label === preferredSemester);
    const targetLabel = selectedOpt ? formatSemLabel(selectedOpt.label) : formatSemLabel(preferredSemester);

    finalResults = allResults.filter((r) => r.semester === targetLabel);
    if (finalResults.length === 0) {
      finalResults = allResults.filter((r) => r.semester.includes(preferredSemester) || targetLabel.includes(r.semester));
    }
  }
  if (finalResults.length === 0) {
    finalResults = allResults;
  }

  const formattedSemesterOptions = semesterOptions.map((s) => ({
    label: formatSemLabel(s.label),
    value: s.value,
    selected: preferredSemester === s.value || preferredSemester === formatSemLabel(s.label),
  }));

  // Ensure all scraped semesters exist in dropdown
  for (const r of allResults) {
    const semName = r.semester;
    const exists = formattedSemesterOptions.some(
      (opt) => opt.label === semName || formatSemLabel(opt.label) === semName
    );
    if (!exists) {
      formattedSemesterOptions.push({
        label: semName,
        value: semName,
        selected: preferredSemester === semName,
      });
    }
  }

  formattedSemesterOptions.sort((a, b) => {
    const parseSem = (s) => {
      const m = String(s).match(/HK(\d+)\s*\((\d{4})-(\d{4})\)/i);
      if (m) return parseInt(m[2]) * 10 + parseInt(m[1]);
      return 0;
    };
    return parseSem(b.label) - parseSem(a.label);
  });

  const hasAll = formattedSemesterOptions.some((o) => o.value === "all");
  const finalOptions = hasAll
    ? formattedSemesterOptions
    : [{ label: "-- Tất cả lịch thi các kỳ --", value: "all", selected: !preferredSemester || preferredSemester === "all" }, ...formattedSemesterOptions];

  return {
    examUrl: "https://qldt.eaut.edu.vn/congthongtin/Index.aspx#lichthi",
    fetchedAt: new Date().toISOString(),
    semesterOptions: finalOptions,
    results: finalResults,
    selectedSemester: preferredSemester,
    studentName,
  };
}

function filterResultsBySemester(cached, preferredSemester) {
  if (!cached || !cached.results) return cached;

  if (!preferredSemester || preferredSemester === "all") {
    const updatedOptions = (cached.semesterOptions || []).map((opt) => ({
      ...opt,
      selected: opt.value === "all" || opt.value === preferredSemester,
    }));
    return {
      ...cached,
      semesterOptions: updatedOptions,
      results: cached.results,
      selectedSemester: "all",
    };
  }

  const options = cached.semesterOptions || [];
  const targetOpt = options.find(
    (opt) =>
      opt.value === preferredSemester ||
      opt.label === preferredSemester ||
      formatSemLabel(opt.label) === formatSemLabel(preferredSemester)
  );

  let filtered = [];
  const labelLower = targetOpt ? targetOpt.label.toLowerCase().trim() : "";

  if (labelLower) {
    filtered = cached.results.filter(
      (r) =>
        r.semester.toLowerCase().trim() === labelLower ||
        r.semester.toLowerCase().includes(labelLower) ||
        labelLower.includes(r.semester.toLowerCase())
    );
  }

  if (filtered.length === 0) {
    const m = preferredSemester.match(/(\d{4})[\_\-\s]+(\d{4})[\_\-\s]+(\d+)/);
    if (m) {
      const yearStart = m[1];
      const yearEnd = m[2];
      const hkNum = m[3];

      filtered = cached.results.filter((r) => {
        const sem = r.semester || "";
        const hasYear = sem.includes(yearStart) || sem.includes(yearEnd);
        const hasHK = sem.includes(`HK${hkNum}`) || sem.includes(`Học kỳ ${hkNum}`);
        return hasYear && hasHK;
      });
    }
  }

  if (filtered.length === 0) {
    filtered = cached.results.filter(
      (r) =>
        r.semester.includes(preferredSemester) ||
        preferredSemester.includes(r.semester)
    );
  }

  const updatedSemesterOptions = options.map((opt) => ({
    ...opt,
    selected:
      opt.value === preferredSemester ||
      (targetOpt && opt.value === targetOpt.value),
  }));

  return {
    ...cached,
    semesterOptions: updatedSemesterOptions,
    results: filtered,
    selectedSemester: targetOpt ? targetOpt.value : preferredSemester,
  };
}

// ─── PUBLIC PREFETCH & SCHEDULE EXPORTS ───────────────────────────────

async function prefetchAllStudentData(username, password, options = {}) {
  const preferredWeek = options.preferredWeek || null;
  const preferredSemester = options.preferredSemester || null;
  const strictWeek = Boolean(options.strictWeek);

  const weeklyKey = cacheKey(username, "weekly", { preferredWeek, preferredSemester, strictWeek });
  if (options.useCache !== false) {
    const cachedWeekly = getFromCache(weeklyKey);
    if (cachedWeekly) return cachedWeekly;
  }

  return enqueueTask(async () => {
    let browserContext, page, studentName;
    try {
      console.log(`[PREFETCH BATCH] Logging in once in isolated context for ${username}...`);
      ({ browserContext, page, studentName } = await createAuthenticatedPage(username, password));

      // 1. Fetch Weekly Schedule
      const weeklyResult = await fetchWeeklyScheduleInternal(page, username, studentName, options);
      setCache(weeklyKey, weeklyResult);

      // 2. Fetch & Cache Term Schedule
      try {
        const termResult = await fetchTermScheduleInternal(page, username, studentName, { fetchAll: true });
        setCache(cacheKey(username, "term", { fetchAll: false, preferredSemester: "" }), termResult);
        setCache(cacheKey(username, "term", { fetchAll: true, preferredSemester: "" }), termResult);
        setCache(cacheKey(username, "term", { fetchAll: false, preferredSemester: "all" }), termResult);
        setCache(cacheKey(username, "term", { fetchAll: true, preferredSemester: "all" }), termResult);
        console.log(`[PREFETCH BATCH] Term schedule cached successfully for ${username}`);
      } catch (err) {
        console.error("[PREFETCH TERM ERROR]", err.message);
      }

      // 3. Fetch & Cache Exam Schedule
      try {
        const examResult = await fetchExamScheduleInternal(page, username, studentName, { fetchAll: true, preferredSemester: "all" });
        setCache(cacheKey(username, "exam", { fetchAll: true, preferredSemester: "all" }), examResult);
        setCache(cacheKey(username, "exam", { fetchAll: false, preferredSemester: "all" }), examResult);
        setCache(cacheKey(username, "exam", { fetchAll: false, preferredSemester: "" }), examResult);
        console.log(`[PREFETCH BATCH] Exam schedule cached successfully for ${username}`);
      } catch (err) {
        console.error("[PREFETCH EXAM ERROR]", err.message);
      }

      return weeklyResult;
    } finally {
      await cleanupPage(page, browserContext);
    }
  });
}

async function getStudentSchedule(username, password, options = {}) {
  const preferredWeek = options.preferredWeek || null;
  const preferredSemester = options.preferredSemester || null;
  const strictWeek = Boolean(options.strictWeek);

  const key = cacheKey(username, "weekly", { preferredWeek, preferredSemester, strictWeek });
  const keyAlt = cacheKey(username, "weekly", { preferredWeek, preferredSemester, strictWeek: !strictWeek });
  if (options.useCache !== false) {
    const cached = getFromCache(key) || (!preferredWeek && !preferredSemester ? getFromCache(keyAlt) : null);
    if (cached) return cached;
  }

  return enqueueTask(async () => {
    let browserContext, page, studentName;
    try {
      ({ browserContext, page, studentName } = await createAuthenticatedPage(username, password));
      const weeklyResult = await fetchWeeklyScheduleInternal(page, username, studentName, options);
      setCache(key, weeklyResult);
      if (!preferredWeek && !preferredSemester) {
        setCache(keyAlt, weeklyResult);
      }
      return weeklyResult;
    } finally {
      await cleanupPage(page, browserContext);
    }
  });
}

async function getStudentTermSchedule(username, password, options = {}) {
  const fetchAll = Boolean(options.fetchAll);
  const preferredSemester = options.preferredSemester || "";

  const specificKey = cacheKey(username, "term", { fetchAll, preferredSemester });
  const generalKey = cacheKey(username, "term", { fetchAll: true, preferredSemester: "" });
  const allKey = cacheKey(username, "term", { fetchAll: true, preferredSemester: "all" });
  const falseEmptyKey = cacheKey(username, "term", { fetchAll: false, preferredSemester: "" });
  const falseAllKey = cacheKey(username, "term", { fetchAll: false, preferredSemester: "all" });

  if (options.useCache !== false) {
    const cached =
      getFromCache(specificKey) ||
      getFromCache(generalKey) ||
      getFromCache(allKey) ||
      getFromCache(falseEmptyKey) ||
      getFromCache(falseAllKey);
    if (cached) {
      return filterResultsBySemester(cached, preferredSemester);
    }
  }

  return enqueueTask(async () => {
    let browserContext, page, studentName;
    try {
      ({ browserContext, page, studentName } = await createAuthenticatedPage(username, password));
      const result = await fetchTermScheduleInternal(page, username, studentName, options);
      setCache(specificKey, result);
      setCache(generalKey, result);
      setCache(allKey, result);
      setCache(falseEmptyKey, result);
      setCache(falseAllKey, result);
      return filterResultsBySemester(result, preferredSemester);
    } finally {
      await cleanupPage(page, browserContext);
    }
  });
}

async function getStudentExamSchedule(username, password, options = {}) {
  const preferredSemester = options.preferredSemester || "all";
  const fetchAllExams = preferredSemester === "all" || Boolean(options.fetchAll);

  const specificKey = cacheKey(username, "exam", { fetchAll: fetchAllExams, preferredSemester });
  const generalKey = cacheKey(username, "exam", { fetchAll: true, preferredSemester: "all" });
  const emptyKey = cacheKey(username, "exam", { fetchAll: true, preferredSemester: "" });
  const falseAllKey = cacheKey(username, "exam", { fetchAll: false, preferredSemester: "all" });
  const falseEmptyKey = cacheKey(username, "exam", { fetchAll: false, preferredSemester: "" });

  if (options.useCache !== false) {
    const cached =
      getFromCache(specificKey) ||
      getFromCache(generalKey) ||
      getFromCache(emptyKey) ||
      getFromCache(falseAllKey) ||
      getFromCache(falseEmptyKey);
    if (cached) {
      return filterResultsBySemester(cached, preferredSemester);
    }
  }

  return enqueueTask(async () => {
    let browserContext, page, studentName;
    try {
      ({ browserContext, page, studentName } = await createAuthenticatedPage(username, password));
      const result = await fetchExamScheduleInternal(page, username, studentName, options);
      setCache(specificKey, result);
      setCache(generalKey, result);
      setCache(emptyKey, result);
      setCache(falseAllKey, result);
      setCache(falseEmptyKey, result);
      return filterResultsBySemester(result, preferredSemester);
    } finally {
      await cleanupPage(page, browserContext);
    }
  });
}

module.exports = {
  getStudentSchedule,
  getStudentTermSchedule,
  getStudentExamSchedule,
  prefetchAllStudentData,
};
