/**
 * services/eautApi.js
 * 
 * Module tích hợp trực tiếp Web API của Cổng thông tin Đào tạo EAUT (APIS).
 * Bỏ qua overhead khởi động trình duyệt Puppeteer, giảm thời gian phản hồi từ ~15s xuống ~150ms.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const cheerio = require("cheerio");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const isServerless =
  process.env.VERCEL === "1" ||
  Boolean(process.env.VERCEL_ENV) ||
  Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
  (process.env.NODE_ENV === "production" && process.platform === "linux");

const CACHE_DIR = isServerless ? path.join("/tmp", "eaut_cache") : path.join(process.cwd(), ".cache");
try {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
} catch (e) {}

const BASE_URL = "https://qldt.eaut.edu.vn/congthongtin";
const API_BASE_URL = "https://qldt.eaut.edu.vn/sinhvienapi/api";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  "Connection": "keep-alive",
};

// ─── 1. Thuật toán mã hóa & giải mã APIS (AE / AD) ───────────────────────────

/**
 * Mã hóa payload gửi lên API (Hàm AE từ crypto-js.js của EAUT)
 * XOR từng ký tự với key (action suffix), sau đó mã hóa Base64.
 *
 * @param {string} rawJsonStr
 * @param {string} actionKey Ví dụ: "DSA4BRINKCIpAiAPKSAv"
 * @returns {string} Chuỗi Base64 bọc trong object { A: ... }
 */
function encryptPayload(rawJsonStr, actionKey) {
  if (!rawJsonStr || !actionKey) return "";
  const chars = [];
  for (let i = 0; i < rawJsonStr.length; i++) {
    const xorCode = rawJsonStr.charCodeAt(i) ^ actionKey[i % actionKey.length].charCodeAt(0);
    chars.push(String.fromCharCode(xorCode));
  }
  return Buffer.from(chars.join(""), "binary").toString("base64");
}

/**
 * Giải mã dữ liệu trả về từ trường Data.B (Hàm AD từ crypto-js.js của EAUT)
 * Giải mã Base64, sau đó XOR từng ký tự với token iM.
 *
 * @param {string} encryptedB
 * @param {string} iM Token ma trận định danh sinh viên
 * @returns {string} Chuỗi JSON thô ban đầu
 */
function decryptResponse(encryptedB, iM) {
  if (!encryptedB || !iM) return "";
  const decoded = Buffer.from(encryptedB, "base64").toString("binary");
  const chars = [];
  for (let i = 0; i < decoded.length; i++) {
    const xorCode = decoded.charCodeAt(i) ^ iM[i % iM.length].charCodeAt(0);
    chars.push(String.fromCharCode(xorCode));
  }
  return chars.join("");
}

// ─── 2. Quản lý Session Cache (Lưu iM, cookies, userId trong 2 giờ) ──────────

const userSessionMap = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000; // 2 giờ

function getUserSession(username) {
  if (!username) return null;
  // 1. Kiểm tra RAM
  const entry = userSessionMap.get(username);
  if (entry && Date.now() - entry.timestamp <= SESSION_TTL) {
    return entry.data;
  }
  userSessionMap.delete(username);

  // 2. Kiểm tra Disk
  try {
    const safeKey = crypto.createHash("md5").update(`session_${username}`).digest("hex");
    const filePath = path.join(CACHE_DIR, `sess_${safeKey}.json`);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Date.now() - parsed.timestamp <= SESSION_TTL) {
        userSessionMap.set(username, { data: parsed.data, timestamp: parsed.timestamp });
        return parsed.data;
      }
      fs.unlinkSync(filePath);
    }
  } catch (e) {}

  return null;
}

function saveUserSession(username, data) {
  if (!username || !data) return;
  const now = Date.now();
  userSessionMap.set(username, { data, timestamp: now });
  try {
    const safeKey = crypto.createHash("md5").update(`session_${username}`).digest("hex");
    const filePath = path.join(CACHE_DIR, `sess_${safeKey}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ timestamp: now, data }), "utf8");
  } catch (e) {}
}

function clearUserSession(username) {
  if (!username) return;
  userSessionMap.delete(username);
  try {
    const safeKey = crypto.createHash("md5").update(`session_${username}`).digest("hex");
    const filePath = path.join(CACHE_DIR, `sess_${safeKey}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

// ─── 3. Hàm gọi API EAUT trực tiếp qua HTTP POST ─────────────────────────────

/**
 * Gọi trực tiếp API nội bộ của EAUT
 */
async function callEautApi(cookieHeader, iM, action, func, params = {}) {
  const actionKey = action.substring(action.indexOf("/") + 1);

  const requestBody = {
    action,
    func,
    iM: iM || "",
    strChucNang_Id: "",
    ...params,
  };

  const encryptedA = encryptPayload(JSON.stringify(requestBody), actionKey);
  const url = `${API_BASE_URL}/${action}`;

  const response = await axios.post(
    url,
    { A: encryptedA },
    {
      headers: {
        ...DEFAULT_HEADERS,
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": `${BASE_URL}/Index.aspx`,
        "Origin": "https://qldt.eaut.edu.vn",
        "Cookie": cookieHeader || "",
        ...(iM ? { iM } : {}),
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );

  if (response.status !== 200) {
    throw new Error(`API HTTP ${response.status}: ${JSON.stringify(response.data || "")}`);
  }

  const rawData = response.data;
  if (rawData && rawData.Data && rawData.Data.B) {
    try {
      const decryptedStr = decryptResponse(rawData.Data.B, iM);
      const parsed = JSON.parse(decryptedStr);
      return { Success: true, Data: parsed, Message: rawData.Message || "" };
    } catch (e) {
      console.error("[EAUT API] JSON parse error on decrypted data:", e.message);
      return { Success: false, Data: [], Error: e.message };
    }
  }

  return rawData;
}

// ─── 4. Đăng nhập HTTP thuần (không cần mở browser) ─────────────────────────

async function tryDirectLogin(username, password) {
  try {
    const jar = new CookieJar();
    const client = wrapper(
      axios.create({
        jar,
        withCredentials: true,
        timeout: 15000,
      })
    );

    const loginPage = await client.get(`${BASE_URL}/login.aspx`, {
      headers: DEFAULT_HEADERS,
    });
    const $ = cheerio.load(loginPage.data);
    const viewstate = $('input[name="__VIEWSTATE"]').val() || "";
    const viewstateGen = $('input[name="__VIEWSTATEGENERATOR"]').val() || "";
    const eventValidation = $('input[name="__EVENTVALIDATION"]').val() || "";

    const formData = new URLSearchParams();
    formData.append("__VIEWSTATE", viewstate);
    formData.append("__VIEWSTATEGENERATOR", viewstateGen);
    formData.append("__EVENTVALIDATION", eventValidation);
    formData.append("username", username);
    formData.append("password", password);
    formData.append("cms_authenticate_do_login", "ĐĂNG NHẬP");

    await client.post(`${BASE_URL}/login.aspx`, formData.toString(), {
      headers: {
        ...DEFAULT_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `${BASE_URL}/login.aspx`,
        "Origin": "https://qldt.eaut.edu.vn",
      },
      maxRedirects: 5,
    });

    const indexResp = await client.get(`${BASE_URL}/Index.aspx`, {
      headers: DEFAULT_HEADERS,
    });
    const html = indexResp.data;

    if (!html || html.includes("login-new.css") || html.includes("login.aspx")) {
      return null;
    }

    const $index = cheerio.load(html);
    const studentName =
      $index("#lblHoTenNguoiDangNhap").text().trim() ||
      $index(".nav-account button > span").text().trim() ||
      "";

    let userId = username;
    const userIdMatch =
      html.match(/QLSV_NguoiHoc_Id['"]\s*[:=]\s*['"]?([0-9a-zA-Z_-]+)['"]?/i) ||
      html.match(/userId['"]\s*[:=]\s*['"]([^'"]+)['"]/i) ||
      html.match(/"userId"\s*:\s*"([^"]+)"/);
    if (userIdMatch) userId = userIdMatch[1];

    let iM = null;
    const iMPatterns = [
      /edu\.system\.iM\s*=\s*['"]([^'"]+)['"]/i,
      /iM\s*[:=]\s*['"]([A-Za-z0-9+/=]{20,})['"]/,
      /[A-Za-z0-9_]+\s*=\s*\(\)\s*=>\s*["']([^"']+)["']/i,
      /["']iM["']\s*:\s*["']([^'"]{20,})["']/,
    ];
    for (const pat of iMPatterns) {
      const m = html.match(pat);
      if (m) {
        iM = m[1];
        break;
      }
    }

    if (!iM) return null;

    const cookies = await jar.getCookies(BASE_URL);
    const cookieHeader = cookies.map((c) => `${c.key}=${c.value}`).join("; ");

    const sessionData = {
      cookieHeader,
      iM,
      userId,
      studentName,
    };
    saveUserSession(username, sessionData);
    return sessionData;
  } catch (err) {
    console.warn("[EAUT API] Direct HTTP login attempt failed:", err.message);
    return null;
  }
}

// ─── 5. Helpers Ngày tháng & Tuần học ───────────────────────────────────────

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseDDMMYYYY(str) {
  if (!str) return null;
  const parts = str.split("/");
  if (parts.length !== 3) return null;
  return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
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
    startYear = year;
    endYear = year + 1;
    hkNum = 1;
  } else if (month <= 1) {
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

// ─── 6. Fast Direct API Fetchers (Không cần Puppeteer) ──────────────────────

/**
 * Lấy lịch tuần trực tiếp qua API EAUT (~150ms)
 */
async function fetchWeeklyScheduleDirect(session, username, options = {}) {
  const preferredWeek = options.preferredWeek || null;
  const preferredSemester = options.preferredSemester || null;

  let weekStart, weekEnd;
  if (preferredWeek) {
    const parsed = parseDDMMYYYY(preferredWeek);
    if (parsed) {
      const range = getWeekRange(parsed);
      weekStart = range.start;
      weekEnd = range.end;
    }
  }
  if (!weekStart) {
    const range = getWeekRange(new Date());
    weekStart = range.start;
    weekEnd = range.end;
  }

  const startStr = formatDate(weekStart);
  const endStr = formatDate(weekEnd);

  const action = "SV_ThongTin_MH/DSA4BRINKCIpAiAPKSAv";
  const func = "pkg_congthongtin_hssv_thongtin.LayDSLichCaNhan";

  const apiRes = await callEautApi(
    session.cookieHeader,
    session.iM,
    action,
    func,
    {
      strQLSV_NguoiHoc_Id: session.userId,
      strNgayBatDau: startStr,
      strNgayKetThuc: endStr,
    }
  );

  const allItems = (apiRes && apiRes.Success && Array.isArray(apiRes.Data)) ? apiRes.Data : [];
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

    const rawMode = String(item.HINHTHUCHOC || item.LOAILOPHOCPHAN || "").trim().toLowerCase();
    const roomClean = String(phong || "").trim();
    const hasRoom = roomClean && roomClean !== "-" && roomClean !== "Đang cập nhật" && !roomClean.toLowerCase().includes("online") && !roomClean.toLowerCase().includes("elearning");

    let hinhThuc = "Trực tiếp";
    if (rawMode.includes("elearning") || rawMode.includes("online") || rawMode.includes("trực tuyến")) {
      hinhThuc = "Elearning";
    } else if (rawMode.includes("trực tiếp") || rawMode.includes("offline")) {
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

  return {
    scheduleUrl: "https://qldt.eaut.edu.vn/congthongtin/Index.aspx#lichhoc",
    fetchedAt: new Date().toISOString(),
    hasData: rows.length > 0,
    selectedWeekLabel: `${startStr} - ${endStr}`,
    selectedWeekValue: startStr,
    weekOptions,
    semesterOptions: session.semesterOptions || [],
    selectedSemesterValue: preferredSemester || null,
    autoSwitchedWeek: false,
    headers,
    rows,
    studentName: session.studentName || username,
    username,
  };
}

/**
 * Lấy lịch thi trực tiếp qua API EAUT (~200ms) - Khắc phục hoàn toàn lỗi 500 Timeout trên Vercel
 */
async function fetchExamScheduleDirect(session, username, options = {}) {
  const preferredSemester = options.preferredSemester || "";
  const fetchAll = Boolean(options.fetchAll);

  // 1. Lấy danh sách học kỳ thi
  let semesterOptions = [];
  try {
    const semRes = await callEautApi(
      session.cookieHeader,
      session.iM,
      "SV_ThongTin_MH/DSA4BRIVKS4oBiggLw0oIikVKSgP",
      "pkg_congthongtin_hssv_thongtin.LayDSThoiGianLichThi",
      { strNguoiThucHien_Id: session.userId }
    );
    if (semRes && semRes.Success && Array.isArray(semRes.Data)) {
      semesterOptions = semRes.Data.map((hk) => ({
        label: hk.THOIGIAN ? hk.THOIGIAN.trim() : hk.ID,
        value: hk.ID,
        selected: false,
      }));
    }
  } catch (e) {}

  const semestersToFetch =
    preferredSemester && !fetchAll
      ? semesterOptions.filter((s) => s.value === preferredSemester)
      : semesterOptions;

  const targetList = semestersToFetch.length > 0 ? semestersToFetch : semesterOptions;
  const examResultsMap = new Map();

  // 2. Gọi song song LayDSLichThi_KeHoachThi cho từng học kỳ
  await Promise.all(
    targetList.map(async (semOpt) => {
      try {
        const examRes = await callEautApi(
          session.cookieHeader,
          session.iM,
          "SV_ThongTin_MH/DSA4FQoDDS4xCikuLyYCLg0oIikCKSgVKCQ1",
          "pkg_congthongtin_hssv_thongtin.LayDSLichThi_KeHoachThi",
          {
            strQLSV_NguoiHoc_Id: session.userId,
            strDaoTao_ThoiGianDaoTao_Id: semOpt.value || "",
            strDaoTao_HocPhan_Id: "",
          }
        );

        if (examRes && examRes.Success && Array.isArray(examRes.Data)) {
          const semLabel = formatSemLabel(semOpt.label);
          const rows = examRes.Data.map((item) => {
            const courseName = item.TENHOCPHAN || item.TENHP || "-";
            const attempt = String(item.LANTHI || "1");
            const date = item.NGAYTHI || item.NGAY || "-";
            const pad = (n) => String(n || 0).padStart(2, "0");
            const time = item.GIOBATDAU
              ? `${pad(item.GIOBATDAU)}:${pad(item.PHUTBATDAU)} - ${pad(item.GIOKETTHUC)}:${pad(item.PHUTKETTHUC)}`
              : item.THOIGIAN || "-";
            const format = item.HINHTHUCTHI || item.HINHTHUC || "Thi kết thúc HP";
            const room = item.PHONGTHI || item.PHONG || "-";
            const sbd = item.SBD || item.SOBAODANH || "-";
            return [semLabel, courseName, attempt, "-", date, "-", time, room, sbd, format];
          });
          if (rows.length > 0) {
            examResultsMap.set(semLabel, rows);
          }
        }
      } catch (err) {}
    })
  );

  const results = [];
  const examHeaders = ["Học kỳ", "Tên học phần", "Lần thi", "Số TC", "Ngày thi", "Thứ", "Thời gian", "Phòng thi", "SBD", "Hình thức"];

  for (const [semName, rows] of examResultsMap.entries()) {
    results.push({
      semesterName: semName,
      headers: examHeaders,
      rows,
      hasData: rows.length > 0,
    });
  }

  return {
    results,
    hasData: results.some((r) => r.hasData),
    semesterOptions,
    selectedSemesterValue: preferredSemester || (semesterOptions[0]?.value || null),
    studentName: session.studentName || username,
    username,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Lấy lịch học kỳ trực tiếp qua API EAUT (~250ms)
 */
async function fetchTermScheduleDirect(session, username, options = {}) {
  const preferredSemester = options.preferredSemester || "";
  const now = new Date();
  const semStart = new Date(now.getFullYear() - 1, 0, 1);
  const semEnd = new Date(now.getFullYear() + 1, 11, 31);

  const apiRes = await callEautApi(
    session.cookieHeader,
    session.iM,
    "SV_ThongTin_MH/DSA4BRINKCIpAiAPKSAv",
    "pkg_congthongtin_hssv_thongtin.LayDSLichCaNhan",
    {
      strQLSV_NguoiHoc_Id: session.userId,
      strNgayBatDau: formatDate(semStart),
      strNgayKetThuc: formatDate(semEnd),
    }
  );

  const scheduleData = (apiRes && apiRes.Success && Array.isArray(apiRes.Data)) ? apiRes.Data : [];
  const semMap = new Map();
  const termHeaders = ["Mã lớp", "Tên học phần", "Hình thức", "Thời gian học", "Phòng", "Học phí"];

  for (const s of scheduleData) {
    if (!s || s.PHANLOAI === "LICHTHI") continue;
    const cName = String(s.TENHOCPHAN || "").trim();
    if (!cName) continue;
    const cClass = String(s.MALOPHOCPHAN || s.TENLOPHOCPHAN || cName).trim();
    const ngay = s.NGAYHOC || "";
    const semName = inferSemesterFromDate(ngay, "Học kỳ hiện tại", cClass);

    if (!semMap.has(semName)) {
      semMap.set(semName, new Map());
    }
    const courseMap = semMap.get(semName);

    if (!courseMap.has(cName)) {
      const room = String(s.PHONGHOC_TEN || s.TENPHONGHOC || "Đang cập nhật").trim();
      const rawMode = String(s.HINHTHUCHOC || s.LOAILOPHOCPHAN || "").trim().toLowerCase();
      let hinhThuc = "Trực tiếp";
      if (rawMode.includes("elearning") || rawMode.includes("online") || rawMode.includes("trực tuyến")) {
        hinhThuc = "Elearning";
      } else if (room && room !== "-" && room !== "Đang cập nhật" && !room.toLowerCase().includes("online")) {
        hinhThuc = "Trực tiếp";
      } else {
        hinhThuc = "Elearning";
      }

      courseMap.set(cName, [
        cClass,
        cName,
        hinhThuc,
        "Đang cập nhật",
        room,
        "Đã hoàn thành",
      ]);
    }
  }

  const results = [];
  const semesterOptions = [];

  for (const [semName, cMap] of semMap.entries()) {
    const rows = Array.from(cMap.values());
    semesterOptions.push({ label: semName, value: semName, selected: false });
    results.push({
      semesterName: semName,
      headers: termHeaders,
      rows,
      hasData: rows.length > 0,
    });
  }

  return {
    results,
    hasData: results.some((r) => r.hasData),
    semesterOptions,
    selectedSemesterValue: preferredSemester || (semesterOptions[0]?.value || null),
    studentName: session.studentName || username,
    username,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  encryptPayload,
  decryptResponse,
  callEautApi,
  tryDirectLogin,
  getUserSession,
  saveUserSession,
  clearUserSession,
  fetchWeeklyScheduleDirect,
  fetchTermScheduleDirect,
  fetchExamScheduleDirect,
  getWeekRange,
  formatDate,
  parseDDMMYYYY,
  getDayOfWeek,
  formatSemLabel,
  inferSemesterFromDate,
};
