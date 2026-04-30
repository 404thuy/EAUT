const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");
const { CookieJar } = require("tough-cookie");
const https = require("https");

// Simple in-memory cache for schedule data
// Key format: `${username}|${type}|${JSON.stringify(options)}`
const scheduleCache = new Map();
// Cache TTL in milliseconds (5 minutes)
const CACHE_TTL = 5 * 60 * 1000;

// Helper to perform a request with retry logic
async function requestWithRetry(requestFn, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestFn();
    } catch (err) {
      lastError = err;
      // Simple backoff
      await new Promise((res) => setTimeout(res, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

const BASE_URL = process.env.EAUT_BASE_URL || "https://sinhvien.eaut.edu.vn";
const LOGIN_PATH = process.env.EAUT_LOGIN_PATH || "/login.aspx";
const LOGIN_PATH_CANDIDATES = [LOGIN_PATH, "/login.aspx", "/Login.aspx", "/"];
const SCHEDULE_PATH_CANDIDATES = [
  "/wfrmLichHocSinhVienTinChi.aspx",
  "/wfrmDangKyLopTinChiB3.aspx",
];
const SCHEDULE_KEYWORDS = [
  "lich hoc",
  "thoi khoa bieu",
  "xem lich hoc ky",
  "xem lich hoc tuan",
];

function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function stripVietnamese(value) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function normalizeText(value) {
  return stripVietnamese(cleanText(value)).toLowerCase();
}

function norm(value) {
  return normalizeText(value);
}

function pickLoginForm($) {
  const forms = $("form").toArray();
  if (forms.length === 0) {
    throw new Error("Khong tim thay form dang nhap tren cong sinh vien.");
  }

  const withPassword = forms.find((form) =>
    $(form).find('input[type="password"]').length > 0
  );
  return withPassword || forms[0];
}

function buildLoginPayload($, formNode, username, password) {
  const payload = {};
  const form = $(formNode);
  const inputs = form.find("input").toArray();

  let usernameField = null;
  let passwordField = null;

  for (const input of inputs) {
    const name = $(input).attr("name");
    if (!name) {
      continue;
    }

    const type = ($(input).attr("type") || "text").toLowerCase();
    const value = $(input).attr("value") || "";
    payload[name] = value;

    if (!passwordField && type === "password") {
      passwordField = name;
    }

    const lowerName = name.toLowerCase();
    const isTextLike = ["text", "email", "tel"].includes(type);
    if (
      !usernameField &&
      isTextLike &&
      (lowerName.includes("user") ||
        lowerName.includes("email") ||
        lowerName.includes("login") ||
        lowerName.includes("tai") ||
        lowerName.includes("masv") ||
        lowerName.includes("mssv"))
    ) {
      usernameField = name;
    }
  }

  if (!usernameField || !passwordField) {
    throw new Error("Khong xac dinh duoc truong tai khoan/mat khau tu form dang nhap.");
  }

  payload[usernameField] = username;
  payload[passwordField] = password;

  return payload;
}

function resolveActionUrl($, formNode) {
  const action = $(formNode).attr("action") || LOGIN_PATH;
  return new URL(action, BASE_URL).toString();
}

async function performLogin(client, username, password) {
  let loginPage = null;
  for (const candidatePath of LOGIN_PATH_CANDIDATES) {
    try {
      loginPage = await client.get(new URL(candidatePath, BASE_URL).toString());
      break;
    } catch (_e) {}
  }

  if (!loginPage) throw new Error("Không thể truy cập trang đăng nhập EAUT.");

  const $login = cheerio.load(loginPage.data);
  const formNode = pickLoginForm($login);
  const actionUrl = resolveActionUrl($login, formNode);
  const payload = buildLoginPayload($login, formNode, username, password);

  const submitResponse = await client.post(
    actionUrl,
    new URLSearchParams(payload).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const $afterLogin = cheerio.load(submitResponse.data);

  if (!looksLikeLoggedIn($afterLogin)) {
    throw new Error("Đăng nhập thất bại. Vui lòng kiểm tra lại mã sinh viên và mật khẩu.");
  }

  // Extract student name from header using exact UniSoft IDs
  let studentName = "";
  try {
    const nameEl = $afterLogin("#HeaderSV1_lblHo_ten, #lblHoTen, .na span");
    if (nameEl.length) {
      studentName = cleanText(nameEl.first().text());
    }
    
    if (!studentName || /^\d+$/.test(studentName)) {
      // Fallback: search for greeting patterns or other common locations
      const profile = $afterLogin(".user-profile, .profile, .btn-dropdown, .dropdown-toggle");
      studentName = cleanText(profile.find(".na span, span, b, strong").first().text());
    }

    if (!studentName || /^\d+$/.test(studentName)) {
      const pageText = $afterLogin("body").text();
      const match = pageText.match(/(?:Xin chào|Chào|Sinh viên|Hi)[:\s,]+([^|!( \n]+(?:\s+[^|!( \n]+){1,4})/i);
      if (match) studentName = cleanText(match[1]);
    }
  } catch (_e) {}

  return { client, $afterLogin, studentName: studentName || "Sinh viên" };
}

function looksLikeLoggedIn($) {
  const pageText = normalizeText($("body").text());
  const hasLogout = pageText.includes("dang xuat") || pageText.includes("logout");
  const hasStudentId = $("#HeaderSV1_lblMa_sv, #lblMaSV").length > 0 || /\d{8,}/.test($(".user-info, .na span").text());
  return hasLogout && hasStudentId;
}

function findScheduleUrl($) {
  // Weekly schedule is the user's primary target.
  const directWeek = $("#XemLichHocTuan").attr("href");
  if (directWeek) {
    return new URL(directWeek, BASE_URL).toString();
  }

  // The portal often marks the semester schedule menu with this id.
  const directById = $("#XemLichHocKy").attr("href");
  if (directById) {
    return new URL(directById, BASE_URL).toString();
  }

  const links = $("a").toArray();
  for (const link of links) {
    const text = normalizeText($(link).text());
    const href = $(link).attr("href");
    if (!href) {
      continue;
    }
    if (SCHEDULE_KEYWORDS.some((keyword) => text.includes(keyword))) {
      return new URL(href, BASE_URL).toString();
    }
  }
  return null;
}

function scoreScheduleTable($, tableNode) {
  const table = $(tableNode);
  const text = normalizeText(table.text());
  const rows = table.find("tr").length;
  const cells = table.find("td").length;
  let score = 0;

  if (rows >= 4) score += 3;
  if (cells >= 12) score += 3;
  if (text.includes("thu")) score += 2;
  if (text.includes("ngay")) score += 2;
  if (text.includes("phong")) score += 2;
  if (text.includes("giang vien")) score += 2;
  if (text.includes("tiet")) score += 2;

  return score;
}

function extractScheduleTable($) {
  const tables = $("table").toArray();
  if (tables.length === 0) {
    return null;
  }

  let bestTable = tables[0];
  let bestScore = -1;
  for (const tableNode of tables) {
    const score = scoreScheduleTable($, tableNode);
    if (score > bestScore) {
      bestScore = score;
      bestTable = tableNode;
    }
  }

  // If all tables are weak matches, return null and try text fallback.
  if (bestScore < 3) {
    return null;
  }

  const headers = [];
  $(bestTable)
    .find("thead tr th")
    .each((_index, th) => headers.push(cleanText($(th).text())));

  if (headers.length === 0) {
    $(bestTable)
      .find("tr")
      .first()
      .find("th,td")
      .each((_index, cell) => headers.push(cleanText($(cell).text())));
  }

  const rows = [];
  $(bestTable).find("tbody tr").each((_index, tr) => {
    const row = [];
    $(tr)
      .find("td")
      .each((_cellIndex, cell) => row.push(cleanText($(cell).text())));
    if (row.length > 0) {
      rows.push(row);
    }
  });

  if (rows.length === 0) {
    $(bestTable)
      .find("tr")
      .slice(1)
      .each((_index, tr) => {
      const row = [];
      $(tr)
        .find("td")
        .each((_cellIndex, cell) => row.push(cleanText($(cell).text())));
      if (row.length > 0) {
        rows.push(row);
      }
      });
  }

  return { headers, rows };
}

function parseWeeklySessionText(text) {
  // Normalize Unicode to handle both composed and decomposed accents
  const normalized = cleanText(String(text || "").normalize("NFC").replace(/\s*<br\s*\/?>\s*/gi, "\n"));
  if (!normalized) return null;

  // Flexible regex for periods: Tiết [học]: 4-6 or 4 - 6 or 4—6
  const periodMatch = normalized.match(/(?:Ti\S+\s+h\S+|Ti\S+|T\S+h)[:\s]*(\d+)\s*[-–—]\s*(\d+)/i);
  // Teacher: capture until the next clearly labeled field (not just "Ma" which can appear in names)
  const teacherMatch = normalized.match(/(?:GV|Gi[aả]ng\s*vi[eê]n|Giang\s*vien)[:\s]+(.+?)(?=\s*(?:Ph[oò]ng|H[iì]nh\s*th[ứu]c|M[aã]\s*l[oớ]p|Ti[eê]t|$))/i);
  const classMatch = normalized.match(/(?:M\S+\s+l\S+|Mã\s*lớp)[:\s]*([^|]+?)(?=\s*(?:GV|Phong|Phòng|Hinh|Hình|Ti[eê]t|$))/i);
  const modeMatch = normalized.match(/(?:H\S+\s+th\S+|Hình\s*thức)[:\s]*([^|]+?)(?=\s*(?:GV|Phong|Phòng|M[aã]|Ti[eê]t|$))/i);

  const roomMatches = [...normalized.matchAll(/(?:Phong|Phòng)[:\s]*([^|]+?)(?=\s*(?:GV|Giảng|Hinh|Hình|M[aã]|Ti[eê]t|$))/gi)];
  let room = "Đang cập nhật";
  if (roomMatches.length > 0) {
    const bestRoom = roomMatches.find((m) => !/Thứ\s+\d/i.test(m[1])) || roomMatches[0];
    room = cleanText(bestRoom[1]);
  }

  // Split the course name by ANY keyword
  const keywords = [
    "Ti[eê]t\\s*h[oọ]c", "Ti[eê]t", "M[aã]\\s*l[oớ]p", "GV", 
    "Giang\\s*vi[eê]n", "Giảng\\s*viên", "Phong", "Phòng", 
    "H[iì]nh\\s*th[ứu]c", "Hình\\s*thức", "Thu", "Thứ"
  ];
  const splitRegex = new RegExp(`(?:${keywords.join("|")})`, "i");
  const courseRaw = normalized.split(splitRegex)[0]
    .replace(/^Sang|^Chieu|^Toi|^Sáng|^Chiều|^Tối/i, "")
    .trim();
  const course = cleanText(courseRaw.replace(/^Lop hoc[:\-]?\s*|^Lớp\s*học[:\-]?\s*/i, ""));

  let periodStart = "-";
  let periodCount = "-";
  let time = "-";
  if (periodMatch) {
    const start = Number(periodMatch[1]);
    const end = Number(periodMatch[2]);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      periodStart = String(start);
      periodCount = String(Math.max(end - start + 1, 1));
      time = `${start}-${end}`;
    }
  }

  return {
    course: course || "Môn học",
    teacher: cleanText(teacherMatch ? teacherMatch[1] : "") || "Đang cập nhật",
    room: room || "Đang cập nhật",
    periodStart,
    periodCount,
    time,
    classCode: cleanText(classMatch ? classMatch[1] : ""),
    mode: cleanText(modeMatch ? modeMatch[1] : ""),
  };
}

function extractScheduleFromWeeklyGrid($) {
  // Try multiple known IDs for the weekly grid
  const grid = $("#gridLichHoc, #grdViewLopDangKy, #gridLich").first();
  if (!grid.length) return null;

  const headers = [];
  grid.find("tr").first().find("th").each((_idx, th) => {
    headers.push(cleanText($(th).text()));
  });

  // Weekly screen may be empty: header exists but no data cells.
  if (headers.length <= 1) {
    return { headers: [], rows: [] };
  }

  const dayColumns = headers.slice(1).map((label) => {
    const m = label.match(/^(.*?),\s*(\d{1,2}\/\d{1,2}\/\d{4})$/);
    if (!m) {
      return { day: label || "Khong ro thu", date: "" };
    }
    return { day: cleanText(m[1]), date: cleanText(m[2]) };
  });

  const rows = [];
  grid.find("tr").slice(1).each((_rowIndex, tr) => {
    const cells = $(tr).find("td");
    if (!cells.length) return;
    const sessionLabel = cleanText($(cells[0]).text()) || "";

    cells.slice(1).each((cellIndex, td) => {
      const dayMeta = dayColumns[cellIndex] || { day: "Khong ro thu", date: "" };
      const blockNodes = $(td).find("p.hocthuong, p.hocbu, p.nghihoc, .hocthuong, .hocbu, .nghihoc");
      if (!blockNodes.length) return;

      blockNodes.each((_i, node) => {
        const html = ($(node).html() || "").replace(/<br\s*\/?>/gi, "\n");
        const text = cleanText(html.replace(/<[^>]+>/g, " "));
        const parsed = parseWeeklySessionText(text);
        if (!parsed) return;

        rows.push([
          dayMeta.day,
          dayMeta.date,
          parsed.course,
          parsed.room,
          parsed.teacher,
          parsed.periodStart,
          parsed.periodCount,
          parsed.time,
          sessionLabel || "-",
          parsed.classCode || "-",
          parsed.mode || "-",
        ]);
      });
    });
  });

  return {
    headers: [
      "Thu",
      "Ngay",
      "Mon hoc",
      "Phong",
      "Giang vien",
      "Tiet bat dau",
      "So tiet",
      "Gio hoc",
      "Ca hoc",
      "Ma lop",
      "Hinh thuc hoc",
    ],
    rows,
  };
}

function extractScheduleTextBlocks($) {
  const selectors = ["p.hocthuong", "p.nghihoc", "p.hocbu", ".hocthuong", ".nghihoc", ".hocbu"];
  const rows = [];

  for (const selector of selectors) {
    $(selector).each((_index, node) => {
      const text = cleanText($(node).text());
      if (text) {
        rows.push([text]);
      }
    });
  }

  if (rows.length === 0) {
    return null;
  }

  return {
    headers: ["Chi tiet lich hoc"],
    rows,
  };
}

function extractHiddenFields($) {
  const fields = {};
  $("input[type='hidden'][name]").each((_index, node) => {
    const name = $(node).attr("name");
    if (!name) return;
    fields[name] = $(node).val() || "";
  });
  return fields;
}

function extractWeekOptions($) {
  const options = [];
  $("#cmbTuan_thu option").each((_index, node) => {
    options.push({
      value: $(node).attr("value") || "",
      label: cleanText($(node).text()),
      selected: $(node).is(":selected"),
    });
  });
  return options.filter((option) => option.value);
}

function extractWeekMeta($) {
  const options = extractWeekOptions($);
  const selected = options.find((item) => item.selected) || null;
  return { options, selected };
}

function extractTermScheduleFromGrid($) {
  // 1. Try known IDs
  let grid = $("#grdKetQua, #grdDangKy, #grdLopDangKy, #grdViewLopDangKy").first();
  
  // 2. Fallback: Find the largest table with "Ma hoc phan" or similar content
  if (!grid.length) {
    const tables = $("table").toArray();
    let bestScore = -1;
    for (const t of tables) {
      const text = normalizeText($(t).text());
      let score = 0;
      if (text.includes("ma hoc phan") || text.includes("ma lop")) score += 5;
      if (text.includes("ten hoc phan") || text.includes("tin chi")) score += 5;
      if (text.includes("lich hoc") || text.includes("ca hoc")) score += 5;
      if (text.includes("giao vien") || text.includes("giang vien")) score += 3;
      if (score > bestScore) {
        bestScore = score;
        grid = $(t);
      }
    }
  }

  if (!grid || !grid.length) return { headers: [], rows: [] };

  const headers = [];
  grid.find("tr").first().find("th, td.header, .header").each((_i, th) => {
    headers.push(cleanText($(th).text()));
  });

  const rows = [];
  let lastRowData = [];

  grid.find("tr").slice(1).each((_idx, tr) => {
    const cells = $(tr).find("td").toArray().map(td => {
      // Replace <br> and block tags with a separator so text doesn't collapse
      let html = $(td).html() || "";
      html = html.replace(/<br\s*\/?>/gi, " | ");
      html = html.replace(/<\/(p|div|li|h[1-6])>/gi, " | ");
      const text = cheerio.load(html).text();
      return cleanText(text.replace(/\|\s*\|/g, "|").replace(/(^\|\s*|\s*\|$)/g, ""));
    });
    if (cells.length < 3) return; // Skip separator/empty rows

    const processedRow = cells.map((cell, i) => {
      // Use merging logic for leading columns (ID, Name, Credits, Class)
      if (!cell && i < 4 && lastRowData[i]) {
        return lastRowData[i];
      }
      return cell;
    });

    if (processedRow.some(c => c)) {
      rows.push(processedRow);
      lastRowData = processedRow;
    }
  });

  return { headers, rows };
}

function extractExamScheduleFromGrid($) {
  let grid = null;
  const possibleIds = ["#grd", "#grdView", "#gvLichThi", "#gvLichThiSinhVien", "#grdLichThi", "#grdKetQua", "#grdDangKy", "table.grid", "table.table-hover"];
  for (const id of possibleIds) {
    const t = $(id);
    if (t.length) {
      const text = normalizeText(t.text());
      if (text.includes("mon") || text.includes("hoc phan") || text.includes("lich thi")) {
        grid = t;
        break;
      }
    }
  }

  if (!grid) {
    // Aggressive search: ANY table containing "Phòng thi" or "Số báo danh"
    $("table").each((_i, t) => {
      const text = normalizeText($(t).text());
      if ((text.includes("phong thi") || text.includes("so bao danh") || text.includes("sbd")) && 
          (text.includes("mon") || text.includes("hoc phan") || text.includes("ngay thi"))) {
        grid = $(t);
        return false; // break
      }
    });
  }
  
  if (!grid || !grid.length) return { headers: [], rows: [] };

  const headers = [];
  grid.find("tr").first().find("th, td.header, .header").each((_i, th) => {
    headers.push(cleanText($(th).text()));
  });

  const findIdx = (p, exclude = []) => {
    return headers.findIndex((h, i) => {
      if (exclude.includes(i)) return false;
      const nh = norm(h);
      return p.some(x => {
          const nx = normalizeText(x);
          if (nx.includes(" ")) return nh === nx || nh.includes(nx); 
          return nh === nx || nh.split(" ").includes(nx);
      });
    });
  };

  const idxHk = findIdx(["hoc ky", "nam hoc", "hk"]);
  const idxSubject = findIdx(["hoc phan", "ten mon", "mon hoc"], [idxHk].filter(x => x >= 0));
  const idxAttempt = findIdx(["lan thi", "lan"], [idxHk, idxSubject].filter(x => x >= 0));
  const idxPhase = findIdx(["dot thi", "dot"], [idxHk, idxSubject, idxAttempt].filter(x => x >= 0));
  const idxDate = findIdx(["ngay thi", "ngay"], [idxHk, idxSubject, idxAttempt, idxPhase].filter(x => x >= 0));
  const idxShift = findIdx(["buoi thi", "buoi"], [idxHk, idxSubject, idxAttempt, idxPhase, idxDate].filter(x => x >= 0));
  const idxTime = findIdx(["gio thi", "gio"], [idxHk, idxSubject, idxAttempt, idxPhase, idxDate, idxShift].filter(x => x >= 0));
  const idxRoom = findIdx(["phong thi", "phong"], [idxHk, idxSubject, idxAttempt, idxPhase, idxDate, idxShift, idxTime].filter(x => x >= 0));
  const idxSbd = findIdx(["so bao danh", "sbd"], [idxHk, idxSubject, idxAttempt, idxPhase, idxDate, idxShift, idxTime, idxRoom].filter(x => x >= 0));
  const idxFormat = findIdx(["hinh thuc thi", "hinh thuc"], [idxHk, idxSubject, idxAttempt, idxPhase, idxDate, idxShift, idxTime, idxRoom, idxSbd].filter(x => x >= 0));

  const rows = [];
  let lastHk = "Học kỳ hiện tại";

  grid.find("tr").slice(1).each((_idx, tr) => {
    let cells = $(tr).find("td").toArray().map(td => {
      let html = $(td).html() || "";
      html = html.replace(/<br\s*\/?>/gi, " | ");
      const text = cheerio.load(html).text();
      return cleanText(text.replace(/\|\s*\|/g, "|").replace(/(^\|\s*|\s*\|$)/g, ""));
    });
    
    if (cells.length < 3) return;

    // Handle rowspan: If first cell is missing, it means it's spanned from above
    if (cells.length < headers.length) {
       cells.unshift("");
    }

    let rowHk = idxHk >= 0 ? cells[idxHk] : "";
    if (rowHk && (rowHk.includes("HK:") || rowHk.includes("Học kỳ") || rowHk.includes("NH:"))) {
      lastHk = rowHk;
    } else {
      rowHk = lastHk;
    }

    const getVal = (idx) => (idx >= 0 ? cells[idx] || "-" : "-");
    
    rows.push([
      rowHk,
      getVal(idxSubject),
      getVal(idxAttempt),
      getVal(idxPhase),
      getVal(idxDate),
      getVal(idxShift),
      getVal(idxTime),
      getVal(idxRoom),
      getVal(idxSbd),
      getVal(idxFormat)
    ]);
  });

  return { headers: ["HK", "Môn", "Lần", "Đợt", "Ngày", "Buổi", "Giờ", "Phòng", "SBD", "Hình thức"], rows };
}

function extractTableData($) {
  const fromWeeklyGrid = extractScheduleFromWeeklyGrid($);
  if (fromWeeklyGrid) return fromWeeklyGrid;

  const regTableIds = ["#grdKetQua", "#grdDangKy", "#grdLopDangKy", "#grdLichHoc"];
  for (const id of regTableIds) {
    if ($(id).length) {
      // If it's the weekly grid, use the specific extractor
      if (id === "#grdLichHoc") {
        const weekly = extractScheduleFromWeeklyGrid($);
        if (weekly && weekly.rows.length > 0) return weekly;
      }
      return extractTermScheduleFromGrid($);
    }
  }

  const fromTable = extractScheduleTable($);
  if (fromTable && fromTable.rows.length > 0) return fromTable;

  const fromText = extractScheduleTextBlocks($);
  if (fromText) return fromText;

  return { headers: [], rows: [] };
}

function extractSemesterOptions($) {
  const options = [];
  const select = $("select").filter((_i, el) => {
    const text = $(el).text();
    const name = $(el).attr("name") || "";
    const id = $(el).attr("id") || "";
    const normalizedText = normalizeText(text);
    return normalizedText.includes("hoc ky") || 
           normalizedText.includes("nam hoc") || 
           name.toLowerCase().includes("hocky") ||
           id.toLowerCase().includes("hocky") ||
           name.toLowerCase().includes("semester");
  }).first();

  if (select.length) {
    const name = select.attr("name");
    select.find("option").each((_index, node) => {
      options.push({
        value: $(node).attr("value") || "",
        label: cleanText($(node).text()),
        selected: $(node).is(":selected") || $(node).attr("selected") === "selected",
        fieldName: name
      });
    });
  }
  return options.filter((opt) => opt.value);
}

// Helper to generate a cache key
function cacheKey(username, type, options) {
  return `${username}|${type}|${JSON.stringify(options)}`;
}

// Retrieve from cache if fresh
function getFromCache(key) {
  const entry = scheduleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    scheduleCache.delete(key);
    return null;
  }
  return entry.data;
}

// Store result in cache
function setCache(key, data) {
  scheduleCache.set(key, { data, timestamp: Date.now() });
}

async function getStudentSchedule(username, password, options = {}) {
  const preferredWeek = options.preferredWeek || null;
  const strictWeek = Boolean(options.strictWeek);

  const key = cacheKey(username, "weekly", { preferredWeek, strictWeek });
  if (options.useCache !== false) {
    const cached = getFromCache(key);
    if (cached) return cached;
  }

  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 5,
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      },
    })
  );

  const { $afterLogin, studentName } = await performLogin(client, username, password);

  let scheduleUrl = findScheduleUrl($afterLogin) || new URL("/wfrmLichHocSinhVienTinChi.aspx", BASE_URL).toString();
  let scheduleResponse = await client.get(scheduleUrl);
  let $schedule = cheerio.load(scheduleResponse.data);

  // 1. Handle Semester Selection
  const semesters = extractSemesterOptions($schedule);
  if (semesters.length > 0) {
    const latestSemester = semesters[semesters.length - 1];
    if (!latestSemester.selected) {
      const hidden = extractHiddenFields($schedule);
      const semPayload = {
        ...hidden,
        __EVENTTARGET: $("#drpHocKy").length ? "drpHocKy" : "cmbHocKy",
        __EVENTARGUMENT: "",
        [$("#drpHocKy").length ? "drpHocKy" : "cmbHocKy"]: latestSemester.value,
      };
      scheduleResponse = await client.post(
        scheduleUrl,
        new URLSearchParams(semPayload).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      $schedule = cheerio.load(scheduleResponse.data);
    }
  }

  let schedule = extractTableData($schedule);
  let weekMeta = extractWeekMeta($schedule);
  let resolvedFromAnotherWeek = false;
  let originalWeekLabel = weekMeta.selected?.label || null;

  // 2. Handle Week Selection
  if (preferredWeek && weekMeta.options.some((item) => item.value === preferredWeek)) {
    const hidden = extractHiddenFields($schedule);
    const weekPayload = {
      ...hidden,
      __EVENTTARGET: "cmbTuan_thu",
      __EVENTARGUMENT: "",
      cmbTuan_thu: preferredWeek,
    };
    const weekResponse = await client.post(
      scheduleUrl,
      new URLSearchParams(weekPayload).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    $schedule = cheerio.load(weekResponse.data);
    schedule = extractTableData($schedule);
    weekMeta = extractWeekMeta($schedule);
  }

  // 3. Fallback to nearby weeks if current week is empty
  if (!strictWeek && !schedule.rows.length && weekMeta.options.length > 1 && weekMeta.selected) {
    const currentIndex = weekMeta.options.findIndex((item) => item.value === weekMeta.selected.value);
    const orderedIndexes = [];
    for (let i = currentIndex - 1; i >= 0; i -= 1) orderedIndexes.push(i);
    for (let i = currentIndex + 1; i < weekMeta.options.length; i += 1) orderedIndexes.push(i);

    for (const index of orderedIndexes) {
      const candidate = weekMeta.options[index];
      const hidden = extractHiddenFields($schedule);
      const payload = {
        ...hidden,
        __EVENTTARGET: "cmbTuan_thu",
        __EVENTARGUMENT: "",
        cmbTuan_thu: candidate.value,
      };
      try {
        const changedWeekResponse = await client.post(
          scheduleUrl,
          new URLSearchParams(payload).toString(),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );
        const $changedWeek = cheerio.load(changedWeekResponse.data);
        const candidateSchedule = extractTableData($changedWeek);
        if (candidateSchedule.rows.length > 0) {
          schedule = candidateSchedule;
          weekMeta = extractWeekMeta($changedWeek);
          resolvedFromAnotherWeek = true;
          break;
        }
      } catch (_e) {}
    }
  }

  const result = {
    scheduleUrl,
    fetchedAt: new Date().toISOString(),
    hasData: schedule.rows.length > 0,
    selectedWeekLabel: weekMeta.selected?.label || null,
    selectedWeekValue: weekMeta.selected?.value || null,
    weekOptions: weekMeta.options.map((item) => ({
      label: item.label,
      value: item.value,
      selected: item.selected,
    })),
    autoSwitchedWeek: resolvedFromAnotherWeek,
    originalWeekLabel,
    studentName,
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

  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 5,
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      },
    })
  );

  const { studentName } = await performLogin(client, username, password);

  // 2. Initial Fetch
  const termUrl = new URL("/wfrmDangKyLopTinChiB3.aspx", BASE_URL).toString();
  let termPage = await client.get(termUrl);
  let $term = cheerio.load(termPage.data);

  const semesterOptions = extractSemesterOptions($term);
  let results = [];

  if (fetchAll && semesterOptions.length > 0) {
    let currentHidden = extractHiddenFields($term);
    for (const sem of semesterOptions) {
      try {
        const fieldName = sem.fieldName || "drpHocKy";
        const payload = {
          ...currentHidden,
          __EVENTTARGET: fieldName,
          __EVENTARGUMENT: "",
          [fieldName]: sem.value,
        };
        const resp = await client.post(termUrl, new URLSearchParams(payload).toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        const $sem = cheerio.load(resp.data);
        currentHidden = extractHiddenFields($sem);
        
        const schedule = extractTermScheduleFromGrid($sem);
        if (schedule.rows.length > 0) {
          results.push({
            semester: sem.label,
            ...schedule
          });
        }
      } catch (_e) {
        console.error("Lỗi khi tải học kỳ:", sem.label);
      }
    }
  } else {
    const targetSem = options.preferredSemester || (semesterOptions.find(o => o.selected) || semesterOptions[semesterOptions.length - 1]);
    const targetVal = typeof targetSem === "string" ? targetSem : targetSem?.value;
    const targetLabel = typeof targetSem === "string" ? (semesterOptions.find(o => o.value === targetSem)?.label || "Học kỳ") : (targetSem?.label || "Học kỳ hiện tại");
    
    if (targetVal) {
        const fieldName = semesterOptions.find(o => o.value === targetVal)?.fieldName || "drpHocKy";
        const hidden = extractHiddenFields($term);
        const payload = {
          ...hidden,
          __EVENTTARGET: fieldName,
          __EVENTARGUMENT: "",
          [fieldName]: targetVal,
        };
        const resp = await client.post(termUrl, new URLSearchParams(payload).toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        $term = cheerio.load(resp.data);
    }
    const schedule = extractTermScheduleFromGrid($term);
    results.push({
      semester: targetLabel,
      ...schedule
    });
  }

  const result = {
    termUrl,
    fetchedAt: new Date().toISOString(),
    semesterOptions,
    results, 
    studentName
  };
  return result;
}

async function getStudentExamSchedule(username, password, options = {}) {
  const fetchAllExams = options.preferredSemester === "all" || options.fetchAll;
  const key = cacheKey(username, "exam", { fetchAll: fetchAllExams, preferredSemester: options.preferredSemester });
  if (options.useCache !== false) {
    const cached = getFromCache(key);
    if (cached) return cached;
  }

  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 5,
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      },
    })
  );

  const { studentName } = await performLogin(client, username, password);

  const examUrl = new URL("/ThongTinLichThi.aspx", BASE_URL).toString();
  let examPage = await client.get(examUrl);
  let $exam = cheerio.load(examPage.data);

  let semesterOptions = extractSemesterOptions($exam);
  
  // If exam page doesn't have semesters, try the term schedule page
  if (semesterOptions.length === 0) {
    try {
      const termUrl = new URL("/wfrmDangKyLopTinChiB3.aspx", BASE_URL).toString();
      const termPage = await client.get(termUrl);
      const $term = cheerio.load(termPage.data);
      semesterOptions = extractSemesterOptions($term);
    } catch (_e) {}
  }

  let results = [];
  const initialSchedule = extractExamScheduleFromGrid($exam);

  const hasSemesterDropdown = $exam('select').filter((_i, el) => {
    const text = normalizeText($(el).text());
    return text.includes("hoc ky") || text.includes("nam hoc");
  }).length > 0;

  if (fetchAllExams) {
    if (hasSemesterDropdown && semesterOptions.length > 0) {
      let currentHidden = extractHiddenFields($exam);
      // Fetch sequentially to respect UniSoft session state
      for (const sem of semesterOptions) {
        try {
          const fieldName = sem.fieldName || "drpHocKy";
          const payload = { ...currentHidden, __EVENTTARGET: fieldName, __EVENTARGUMENT: "", [fieldName]: sem.value };
          const resp = await client.post(examUrl, new URLSearchParams(payload).toString(), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          });
          const $sem = cheerio.load(resp.data);
          // Update hidden fields for the next request in sequence
          currentHidden = extractHiddenFields($sem);
          
          const schedule = extractExamScheduleFromGrid($sem);
          if (schedule.rows.length > 0) {
             results.push({ semester: sem.label, ...schedule });
          }
        } catch (_e) {
          console.error(`Error fetching exam for ${sem.label}:`, _e.message);
        }
      }
    } 
    
    // Fallback or Grouping for single-page "All Semesters" view
    if (results.length === 0 && initialSchedule.rows.length > 0) {
      // Group rows by the HK column
      const groups = {};
      initialSchedule.rows.forEach(row => {
        const hk = row[0] || "Khác";
        if (!groups[hk]) groups[hk] = [];
        groups[hk].push(row);
      });
      results = Object.keys(groups).map(hk => ({
        semester: hk,
        headers: initialSchedule.headers,
        rows: groups[hk]
      }));
    }
  } else {
    const targetSem = options.preferredSemester || (semesterOptions.find(o => o.selected) || semesterOptions[semesterOptions.length - 1]);
    const targetVal = typeof targetSem === "string" ? targetSem : targetSem?.value;
    const targetLabel = typeof targetSem === "string" ? (semesterOptions.find(o => o.value === targetSem)?.label || "Học kỳ") : (targetSem?.label || "Học kỳ hiện tại");
    
    let finalSchedule = initialSchedule;

    if (targetVal && hasSemesterDropdown) {
        const fieldName = semesterOptions.find(o => o.value === targetVal)?.fieldName || "drpHocKy";
        const hidden = extractHiddenFields($exam);
        const payload = { ...hidden, __EVENTTARGET: fieldName, __EVENTARGUMENT: "", [fieldName]: targetVal };
        try {
          const resp = await client.post(examUrl, new URLSearchParams(payload).toString(), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          });
          finalSchedule = extractExamScheduleFromGrid(cheerio.load(resp.data));
        } catch (_e) {}
    }
    
    // Filter rows if we have a target semester and the data might be mixed
    if (targetVal && targetVal !== "all" && finalSchedule.rows.length > 0) {
       const normLabel = normalizeText(targetLabel);
       const filteredRows = finalSchedule.rows.filter(row => {
          const rowHk = normalizeText(row[0]);
          const labelNums = normLabel.match(/\d+/g) || [];
          const rowNums = rowHk.match(/\d+/g) || [];
          if (labelNums.length >= 2 && rowNums.length >= 2) {
             return labelNums.every(n => rowHk.includes(n)) || rowNums.every(n => normLabel.includes(n));
          }
          return rowHk.includes(normLabel) || normLabel.includes(rowHk);
       });
       if (filteredRows.length > 0) {
         finalSchedule.rows = filteredRows;
       }
    }

    results.push({
      semester: targetLabel,
      ...finalSchedule
    });
  }

  const result = {
    examUrl,
    fetchedAt: new Date().toISOString(),
    semesterOptions,
    results, 
    selectedSemester: options.preferredSemester || "all",
    studentName
  };
  setCache(key, result);
  return result;
}

module.exports = {
  getStudentSchedule,
  getStudentTermSchedule,
  getStudentExamSchedule,
};
