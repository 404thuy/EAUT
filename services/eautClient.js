const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");
const { CookieJar } = require("tough-cookie");
const https = require("https");

// Simple in-memory cache for schedule data
const scheduleCache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000; // Increase to 12 hours for better user experience

const BASE_URL = process.env.EAUT_BASE_URL || "https://sinhvien.eaut.edu.vn";
const LOGIN_PATH = process.env.EAUT_LOGIN_PATH || "/login.aspx";
const LOGIN_PATH_CANDIDATES = [LOGIN_PATH, "/login.aspx", "/Login.aspx", "/"];

function cacheKey(username, type, options = {}) {
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
  scheduleCache.set(key, { data, timestamp: Date.now() });
}

function normalizeText(text) {
  return (text || "").toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d");
}

function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function extractHiddenFields($) {
  const fields = {};
  $('input[type="hidden"]').each((_i, el) => {
    const name = $(el).attr("name");
    const value = $(el).attr("value");
    if (name) fields[name] = value || "";
  });
  return fields;
}

function extractStudentName($) {
  try {
    const nameEl = $("#HeaderSV1_lblHo_ten, #lblHoTen, .na span");
    if (nameEl.length) return cleanText(nameEl.first().text());
    
    const profile = $(".user-profile, .profile, .btn-dropdown, .dropdown-toggle");
    const name = cleanText(profile.find(".na span, span, b, strong").first().text());
    if (name && !/^\d+$/.test(name)) return name;

    const pageText = $("body").text();
    const match = pageText.match(/(?:Xin chào|Chào|Sinh viên|Hi)[:\s,]+([^|!( \n]+(?:\s+[^|!( \n]+){1,4})/i);
    if (match) return cleanText(match[1]);
  } catch (_e) {}
  return "Sinh viên";
}

function findScheduleUrl($) {
  try {
    const link = $('a[href*="LichHocSinhVien"]').first();
    if (link.length) {
      const href = link.attr("href");
      return new URL(href, BASE_URL).toString();
    }
  } catch (_e) {}
  return null;
}

async function performLogin(client, username, password, existingJar = null) {
  if (existingJar) {
    try {
      const testPage = await client.get(new URL("/", BASE_URL).toString());
      const $ = cheerio.load(testPage.data);
      if (looksLikeLoggedIn($)) {
        return { $afterLogin: $, studentName: extractStudentName($), jar: client.defaults.jar };
      }
    } catch (_e) {}
  }

  let loginPage = null;
  for (const candidatePath of LOGIN_PATH_CANDIDATES) {
    try {
      loginPage = await client.get(new URL(candidatePath, BASE_URL).toString());
      break;
    } catch (_e) {}
  }

  if (!loginPage) throw new Error("Không thể truy cập trang đăng nhập EAUT.");
  const $ = cheerio.load(loginPage.data);
  const actionUrl = new URL($("form").attr("action") || LOGIN_PATH, BASE_URL).toString();
  const hiddenFields = extractHiddenFields($);

  const payload = new URLSearchParams({
    ...hiddenFields,
    txtTai_khoan: username,
    txtMat_khau: password,
    btnDang_nhap: "Đăng nhập",
  });

  const response = await client.post(actionUrl, payload.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const $after = cheerio.load(response.data);
  if (!looksLikeLoggedIn($after)) {
    throw new Error("Đăng nhập thất bại. Vui lòng kiểm tra lại mã sinh viên và mật khẩu.");
  }

  return { $afterLogin: $after, studentName: extractStudentName($after), jar: client.defaults.jar };
}

function looksLikeLoggedIn($) {
  return $('a[href*="Logout.aspx"], a[href*="Default.aspx?page=logout"]').length > 0 || extractStudentName($) !== "Sinh viên";
}

function extractSemesterOptions($) {
  const options = [];
  $("#drpHocKy option, #cmbHocKy option").each((_i, el) => {
    options.push({
      label: cleanText($(el).text()),
      value: $(el).val(),
      selected: $(el).attr("selected") === "selected",
      fieldName: $(el).parent().attr("name") || "drpHocKy"
    });
  });
  return options;
}

function extractWeekMeta($) {
  const options = [];
  let selected = null;
  $("#cmbTuan_thu option").each((_i, el) => {
    const item = {
      label: cleanText($(el).text()),
      value: $(el).val(),
      selected: $(el).attr("selected") === "selected",
    };
    options.push(item);
    if (item.selected) selected = item;
  });
  return { options, selected };
}

function extractTableData($) {
  const headers = [];
  $(".grid-header th").each((_i, el) => {
    headers.push(cleanText($(el).text()));
  });

  const rows = [];
  $(".grid-row, .grid-alternate-row").each((_i, row) => {
    const rowData = [];
    $(row).find("td").each((_j, cell) => {
      rowData.push(cleanText($(cell).text()));
    });
    if (rowData.length > 0) rows.push(rowData);
  });

  return { headers, rows };
}

function createClient(jar) {
    return wrapper(
      axios.create({
        jar: jar || new CookieJar(),
        withCredentials: true,
        maxRedirects: 5,
        timeout: 30000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        },
      })
    );
}

async function getStudentSchedule(username, password, options = {}) {
  const key = cacheKey(username, "weekly", options);
  if (options.useCache !== false) {
    const cached = getFromCache(key);
    if (cached) return cached;
  }

  const client = createClient(options.jar);
  const { $afterLogin, studentName, jar: updatedJar } = await performLogin(client, username, password, options.jar);

  let scheduleUrl = findScheduleUrl($afterLogin) || new URL("/wfrmLichHocSinhVienTinChi.aspx", BASE_URL).toString();
  let scheduleResponse = await client.get(scheduleUrl);
  let $schedule = cheerio.load(scheduleResponse.data);

  // 1. Semester Selection
  const semesters = extractSemesterOptions($schedule);
  if (semesters.length > 0) {
    const latestSemester = semesters[semesters.length - 1];
    if (!latestSemester.selected) {
      const hidden = extractHiddenFields($schedule);
      const semPayload = {
        ...hidden,
        __EVENTTARGET: latestSemester.fieldName,
        __EVENTARGUMENT: "",
        [latestSemester.fieldName]: latestSemester.value,
      };
      scheduleResponse = await client.post(scheduleUrl, new URLSearchParams(semPayload).toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      $schedule = cheerio.load(scheduleResponse.data);
    }
  }

  let schedule = extractTableData($schedule);
  let weekMeta = extractWeekMeta($schedule);
  let resolvedFromAnotherWeek = false;
  let originalWeekLabel = weekMeta.selected?.label || null;

  // 2. Week Selection
  const preferredWeek = options.preferredWeek;
  if (preferredWeek && weekMeta.options.some(i => i.value === preferredWeek)) {
    const hidden = extractHiddenFields($schedule);
    const payload = { ...hidden, __EVENTTARGET: "cmbTuan_thu", __EVENTARGUMENT: "", cmbTuan_thu: preferredWeek };
    const weekResp = await client.post(scheduleUrl, new URLSearchParams(payload).toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    $schedule = cheerio.load(weekResp.data);
    schedule = extractTableData($schedule);
    weekMeta = extractWeekMeta($schedule);
  }

  const result = {
    scheduleUrl,
    fetchedAt: new Date().toISOString(),
    hasData: schedule.rows.length > 0,
    selectedWeekLabel: weekMeta.selected?.label || null,
    selectedWeekValue: weekMeta.selected?.value || null,
    weekOptions: weekMeta.options.map(i => ({ label: i.label, value: i.value, selected: i.selected })),
    autoSwitchedWeek: resolvedFromAnotherWeek,
    originalWeekLabel,
    studentName,
    jar: updatedJar,
    ...schedule,
  };
  setCache(key, result);
  return result;
}

async function getStudentTermSchedule(username, password, options = {}) {
  const fetchAll = Boolean(options.fetchAll);
  const key = cacheKey(username, "term", { fetchAll });
  if (options.useCache !== false) {
    const cached = getFromCache(key);
    if (cached) return cached;
  }

  const client = createClient(options.jar);
  const { studentName, jar: updatedJar } = await performLogin(client, username, password, options.jar);

  const termUrl = new URL("/wfrmDangKyLopTinChiB3.aspx", BASE_URL).toString();
  let termPage = await client.get(termUrl);
  let $term = cheerio.load(termPage.data);
  const semesterOptions = extractSemesterOptions($term);
  let results = [];

  if (fetchAll && semesterOptions.length > 0) {
    let currentHidden = extractHiddenFields($term);
    for (const sem of semesterOptions) {
      try {
        const payload = { ...currentHidden, __EVENTTARGET: sem.fieldName, __EVENTARGUMENT: "", [sem.fieldName]: sem.value };
        const resp = await client.post(termUrl, new URLSearchParams(payload).toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        const $sem = cheerio.load(resp.data);
        currentHidden = extractHiddenFields($sem);
        const sched = extractTableData($sem);
        if (sched.rows.length > 0) results.push({ semester: sem.label, ...sched });
      } catch (_e) {}
    }
  } else {
    results.push({ semester: "Học kỳ hiện tại", ...extractTableData($term) });
  }

  const result = { termUrl, fetchedAt: new Date().toISOString(), semesterOptions, results, studentName, jar: updatedJar };
  setCache(key, result);
  return result;
}

async function getStudentExamSchedule(username, password, options = {}) {
  const fetchAll = options.preferredSemester === "all" || options.fetchAll;
  const key = cacheKey(username, "exam", { fetchAll });
  if (options.useCache !== false) {
    const cached = getFromCache(key);
    if (cached) return cached;
  }

  const client = createClient(options.jar);
  const { studentName, jar: updatedJar } = await performLogin(client, username, password, options.jar);

  const examUrl = new URL("/ThongTinLichThi.aspx", BASE_URL).toString();
  let examPage = await client.get(examUrl);
  let $exam = cheerio.load(examPage.data);
  const schedule = extractTableData($exam);

  const result = { examUrl, fetchedAt: new Date().toISOString(), results: [{ semester: "Lịch thi", ...schedule }], studentName, jar: updatedJar };
  setCache(key, result);
  return result;
}

module.exports = { getStudentSchedule, getStudentTermSchedule, getStudentExamSchedule };
