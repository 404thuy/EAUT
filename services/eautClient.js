const path = require("path");
const crypto = require("crypto");

// ─── Cache Management & Change Detection ──────────────────────────────
const scheduleCache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes TTL

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
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    scheduleCache.delete(key);
    return null;
  }
  return entry.data;
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
}

// ─── Puppeteer Singleton Browser Management ────────────────────────────
let _browser = null;
async function getBrowser() {
  const { default: puppeteer } = await import("puppeteer");
  if (_browser && _browser.connected) return _browser;
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
  await page.setRequestInterception(true);
  page.on("request", (req) => {
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
      req.abort();
    } else {
      req.continue();
    }
  });
}

// ─── Core: Login and Prepare an Authenticated Page ─────────────────────
async function createAuthenticatedPage(username, password) {
  const MAX_LOGIN_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
    const browser = await getBrowser();
    const context = typeof browser.createBrowserContext === "function"
      ? await browser.createBrowserContext()
      : typeof browser.createIncognitoBrowserContext === "function"
      ? await browser.createIncognitoBrowserContext()
      : browser.defaultBrowserContext();

    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
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
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {}),
        ]);
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
      await page.close().catch(() => {});
      await context.close().catch(() => {});

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
  return await page.evaluate(
    async (action, func, extraParams) => {
      return new Promise((resolve, reject) => {
        if (!window.edu || !window.edu.system || !window.edu.system.makeRequest) {
          reject(new Error("SPA framework not initialized"));
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
        setTimeout(() => resolve({ Success: false, Data: [] }), 12000);
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

function inferSemesterFromDate(dateStr, fallbackSemLabel) {
  if (!dateStr || dateStr === "-") return fallbackSemLabel || "Học kỳ hiện tại";
  const parts = dateStr.split("/");
  if (parts.length !== 3) return fallbackSemLabel || "Học kỳ hiện tại";

  const month = parseInt(parts[1], 10);
  let year = parseInt(parts[2], 10);
  if (year < 100) year += 2000;
  if (isNaN(month) || isNaN(year)) return fallbackSemLabel || "Học kỳ hiện tại";

  let startYear, endYear, hkNum;
  if (month >= 9) {
    startYear = year;
    endYear = year + 1;
    hkNum = 1;
  } else if (month <= 2) {
    startYear = year - 1;
    endYear = year;
    hkNum = 1;
  } else {
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
    const hinhThuc = item.HINHTHUCHOC || item.LOAILOPHOCPHAN || "-";
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
          const hinhThuc = item.HINHTHUCHOC || item.LOAILOPHOCPHAN || "-";
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
    .catch(() => {});

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
    const hinhThuc = cleanString(s.HINHTHUCHOC || s.LOAILOPHOCPHAN) || "Chính thức";
    const ngay = s.NGAYHOC || "";

    const semLabel = inferSemesterFromDate(ngay, "Học kỳ hiện tại");

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
        sched: ngay ? `Lịch học: ${ngay}` : "Theo thời khóa biểu",
        fee: "0 đ",
        mode: hinhThuc,
      });
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

  // Format semester options for UI dropdown
  let formattedSemesterOptions = semesterOptions.map((s) => ({
    label: formatSemLabel(s.label),
    value: s.value,
    selected: preferredSemester === s.value,
  }));

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

  const semesterOptions = await page.evaluate(() => {
    const options = [];
    const sel = document.querySelector("#dropSearch_HocKy");
    if (sel) {
      sel.querySelectorAll("option").forEach((opt) => {
        if (opt.value) {
          options.push({ label: opt.textContent.trim(), value: opt.value, selected: opt.selected });
        }
      });
    }
    return options;
  });

  let targetSemester = null;
  if (preferredSemester && preferredSemester !== "all") {
    targetSemester = semesterOptions.find((s) => s.value === preferredSemester || s.label === preferredSemester);
  }
  if (!targetSemester) {
    targetSemester = semesterOptions.find((s) => s.selected) || semesterOptions[0];
  }

  const scrapedResultsMap = new Map();
  if (targetSemester) {
    await page.evaluate((semVal) => {
      const sel = document.querySelector("#dropSearch_HocKy");
      if (sel) {
        sel.value = semVal;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        if (window.$ && window.$.fn.select2) {
          try { $(sel).trigger("change"); } catch (e) {}
        }
      }
    }, targetSemester.value);
    await new Promise((r) => setTimeout(r, 250));

    await page.evaluate(() => {
      const btn = document.querySelector("#btnXemLich");
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 700));

    const rows = await page.evaluate(() => {
      const table = document.querySelector("#tblLichThiCaNhan");
      if (!table) return [];
      const res = [];
      table.querySelectorAll("tbody tr").forEach((tr) => {
        const cells = [];
        tr.querySelectorAll("td").forEach((td) => cells.push(td.textContent.trim()));
        if (cells.length > 2 && cells.some((c) => c)) res.push(cells);
      });
      return res;
    });

    if (rows && rows.length > 0) {
      const label = formatSemLabel(targetSemester.label);
      scrapedResultsMap.set(label, rows);
    }
  }

  const userId = await page.evaluate(() => window.edu?.system?.userId || "");
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

  const examHeaders = ["HK", "Môn", "Lần", "Đợt", "Ngày", "Buổi", "Giờ", "Phòng", "SBD", "Hình thức"];
  const mergedSemestersMap = new Map();

  for (const [semLabel, rows] of scrapedResultsMap.entries()) {
    for (const cells of rows) {
      const courseName = cells[2] || cells[1] || "-";
      const attempt = cells[3] || "1";
      const date = cells[4] || "-";
      const time = cells[5] || "-";
      const format = cells[6] && cells[6] !== "-" ? cells[6] : "Thi kết thúc HP";
      const room = cells[7] || "-";
      const sbd = cells[8] || "-";

      const inferredSem = inferSemesterFromDate(date, semLabel);
      const attemptNum = parseInt(attempt, 10) || 1;
      const realSemLabel = attemptNum > 1 ? "Khác" : inferredSem;

      if (!mergedSemestersMap.has(realSemLabel)) {
        mergedSemestersMap.set(realSemLabel, []);
      }
      const semRows = mergedSemestersMap.get(realSemLabel);

      const existing = semRows.find((r) => r[1].toLowerCase().trim() === courseName.toLowerCase().trim());
      if (!existing) {
        semRows.push([realSemLabel, courseName, attempt, "-", date, "-", time, room, sbd, format]);
      } else {
        if ((!existing[8] || existing[8] === "-") && sbd !== "-") existing[8] = sbd;
        if ((!existing[7] || existing[7] === "-") && room !== "-") existing[7] = room;
        if ((!existing[9] || existing[9] === "-" || existing[9] === "Thi kết thúc HP") && format !== "-") existing[9] = format;
      }
    }
  }

  if (apiExamItems.length > 0) {
    for (const item of apiExamItems) {
      const pad = (n) => String(n || 0).padStart(2, "0");
      const cName = item.TENHOCPHAN || "-";
      const date = item.NGAYHOC || "-";
      const gioBD = `${pad(item.GIOBATDAU)}:${pad(item.PHUTBATDAU)}`;
      const gioKT = `${pad(item.GIOKETTHUC)}:${pad(item.PHUTKETTHUC)}`;
      const time = (gioBD !== "00:00" || gioKT !== "00:00") ? `${gioBD} - ${gioKT}` : "-";
      const room = item.PHONGHOC_TEN || item.TENPHONGHOC || item.PHONGTHI || "-";
      const sbd = (item.SOBAODANH && item.SOBAODANH !== "0") ? item.SOBAODANH : (item.SBD || "-");
      const format = item.HINHTHUCTHI || item.DANGKY_LOPHOCPHAN_TEN || item.LOAILOPHOCPHAN || "Thi kết thúc HP";

      const inferredSem = inferSemesterFromDate(date, "Học kỳ hiện tại");
      const attemptNumApi = parseInt(item.LANTHI, 10) || 1;
      const realSemLabel = attemptNumApi > 1 ? "Khác" : inferredSem;

      if (!mergedSemestersMap.has(realSemLabel)) {
        mergedSemestersMap.set(realSemLabel, []);
      }
      const semRows = mergedSemestersMap.get(realSemLabel);

      const match = semRows.find((r) => r[1].toLowerCase().trim() === cName.toLowerCase().trim());
      if (match) {
        if ((!match[8] || match[8] === "-") && sbd !== "-") match[8] = sbd;
        if ((!match[7] || match[7] === "-") && room !== "-") match[7] = room;
        if ((!match[9] || match[9] === "-" || match[9] === "Thi kết thúc HP") && format !== "-") match[9] = format;
        if ((!match[6] || match[6] === "-") && time !== "-") match[6] = time;
      } else {
        semRows.push([realSemLabel, cName, item.LANTHI || "1", "-", date, "-", time, room, sbd, format]);
      }
    }
  }

  let allResults = [];
  for (const [semester, rows] of mergedSemestersMap.entries()) {
    allResults.push({
      semester,
      headers: examHeaders,
      rows,
    });
  }

  let finalResults = [];
  if (preferredSemester && preferredSemester !== "all") {
    const selectedOpt = semesterOptions.find((s) => s.value === preferredSemester);
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
    selected: preferredSemester === s.value,
  }));

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
      if (page) await page.close().catch(() => {});
      if (browserContext) await browserContext.close().catch(() => {});
    }
  });
}

async function getStudentSchedule(username, password, options = {}) {
  const preferredWeek = options.preferredWeek || null;
  const preferredSemester = options.preferredSemester || null;
  const strictWeek = Boolean(options.strictWeek);

  const key = cacheKey(username, "weekly", { preferredWeek, preferredSemester, strictWeek });
  if (options.useCache !== false) {
    const cached = getFromCache(key);
    if (cached) return cached;
  }

  return prefetchAllStudentData(username, password, options);
}

async function getStudentTermSchedule(username, password, options = {}) {
  const fetchAll = Boolean(options.fetchAll);
  const preferredSemester = options.preferredSemester || "";

  const specificKey = cacheKey(username, "term", { fetchAll, preferredSemester });
  const generalKey = cacheKey(username, "term", { fetchAll: true, preferredSemester: "" });
  const allKey = cacheKey(username, "term", { fetchAll: true, preferredSemester: "all" });

  if (options.useCache !== false) {
    const cached = getFromCache(specificKey) || getFromCache(generalKey) || getFromCache(allKey);
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
      return filterResultsBySemester(result, preferredSemester);
    } finally {
      if (page) await page.close().catch(() => {});
      if (browserContext) await browserContext.close().catch(() => {});
    }
  });
}

async function getStudentExamSchedule(username, password, options = {}) {
  const preferredSemester = options.preferredSemester || "all";
  const fetchAllExams = preferredSemester === "all" || Boolean(options.fetchAll);

  const specificKey = cacheKey(username, "exam", { fetchAll: fetchAllExams, preferredSemester });
  const generalKey = cacheKey(username, "exam", { fetchAll: true, preferredSemester: "all" });

  if (options.useCache !== false) {
    const cached = getFromCache(specificKey) || getFromCache(generalKey);
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
      return filterResultsBySemester(result, preferredSemester);
    } finally {
      if (page) await page.close().catch(() => {});
      if (browserContext) await browserContext.close().catch(() => {});
    }
  });
}

module.exports = {
  getStudentSchedule,
  getStudentTermSchedule,
  getStudentExamSchedule,
  prefetchAllStudentData,
};
