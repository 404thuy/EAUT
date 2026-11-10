/**
 * services/eautApi.js
 * 
 * Module tích hợp trực tiếp Web API của Cổng thông tin Đào tạo EAUT (APIS).
 * Bỏ qua overhead khởi động trình duyệt Puppeteer, giảm thời gian phản hồi từ ~10s xuống ~200ms.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

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

// ─── 2. Hàm gọi API EAUT trực tiếp qua HTTP POST ─────────────────────────────

/**
 * Gọi trực tiếp API nội bộ của EAUT
 *
 * @param {string} cookieHeader Cookie phiên (ASP.NET_SessionId, .ASPXAUTH...)
 * @param {string} iM Token định danh sinh viên
 * @param {string} action Action path, ví dụ "SV_ThongTin_MH/DSA4BRINKCIpAiAPKSAv"
 * @param {string} func Tên procedure PL/SQL
 * @param {object} params Tham số nghiệp vụ
 * @returns {Promise<any>}
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

// ─── 3. Thử đăng nhập HTTP thuần (không cần mở browser) ─────────────────────

/**
 * Thử đăng nhập trực tiếp qua POST form WebForms
 * @returns {Promise<{ cookies: string, iM: string, userId: string, studentName: string } | null>}
 */
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

    // B1: Lấy __VIEWSTATE và __EVENTVALIDATION từ login.aspx
    const loginPage = await client.get(`${BASE_URL}/login.aspx`, {
      headers: DEFAULT_HEADERS,
    });
    const $ = cheerio.load(loginPage.data);
    const viewstate = $('input[name="__VIEWSTATE"]').val() || "";
    const viewstateGen = $('input[name="__VIEWSTATEGENERATOR"]').val() || "";
    const eventValidation = $('input[name="__EVENTVALIDATION"]').val() || "";

    // B2: Gửi credentials
    const formData = new URLSearchParams();
    formData.append("__VIEWSTATE", viewstate);
    formData.append("__VIEWSTATEGENERATOR", viewstateGen);
    formData.append("__EVENTVALIDATION", eventValidation);
    formData.append("username", username);
    formData.append("password", password);
    formData.append("cms_authenticate_do_login", "ĐĂNG NHẬP");

    const postResp = await client.post(`${BASE_URL}/login.aspx`, formData.toString(), {
      headers: {
        ...DEFAULT_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `${BASE_URL}/login.aspx`,
        "Origin": "https://qldt.eaut.edu.vn",
      },
      maxRedirects: 5,
    });

    // B3: Truy cập Index.aspx để trích xuất userId và token iM
    const indexResp = await client.get(`${BASE_URL}/Index.aspx`, {
      headers: DEFAULT_HEADERS,
    });
    const html = indexResp.data;

    if (!html || html.includes("login-new.css") || html.includes("login.aspx")) {
      return null; // Đăng nhập chưa thành công qua HTTP thuần
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
      /["']iM["']\s*:\s*["']([^"']{20,})["']/,
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

    return {
      cookies: cookieHeader,
      iM,
      userId,
      studentName,
    };
  } catch (err) {
    console.warn("[EAUT API] Direct HTTP login attempt failed:", err.message);
    return null;
  }
}

module.exports = {
  encryptPayload,
  decryptResponse,
  callEautApi,
  tryDirectLogin,
};
