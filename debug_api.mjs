/**
 * debug_api.mjs - Run with: node debug_api.mjs
 * Logs into EAUT and shows the exact 500 error body so we can fix the API call format.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import axios from "axios";
import * as cheerio from "cheerio";

const BASE_URL = "https://qldt.eaut.edu.vn/congthongtin";

// ── Create authenticated session ─────────────────────────────────────────────
async function login(username, password) {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
  }));

  const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
  };

  // Step 1: Get login page
  console.log("\n[1] Fetching login page...");
  const loginPage = await client.get(`${BASE_URL}/login.aspx`, { headers: DEFAULT_HEADERS });
  const $ = cheerio.load(loginPage.data);
  const viewstate = $('input[name="__VIEWSTATE"]').val() || "";
  const viewstateGen = $('input[name="__VIEWSTATEGENERATOR"]').val() || "";
  const eventValidation = $('input[name="__EVENTVALIDATION"]').val() || "";
  console.log(`   VIEWSTATE present: ${viewstate.length > 0}, EVENTVALIDATION present: ${eventValidation.length > 0}`);

  // Step 2: Post login
  console.log("[2] Posting credentials...");
  const formData = new URLSearchParams();
  formData.append("__VIEWSTATE", viewstate);
  formData.append("__VIEWSTATEGENERATOR", viewstateGen);
  formData.append("__EVENTVALIDATION", eventValidation);
  formData.append("txtUserName", username);
  formData.append("txtPassword", password);
  formData.append("btnLogin", "Đăng nhập");

  const loginResp = await client.post(`${BASE_URL}/login.aspx`, formData.toString(), {
    headers: {
      ...DEFAULT_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${BASE_URL}/login.aspx`,
    },
    maxRedirects: 5,
  });

  // Step 3: Extract iM and userId from Index.aspx
  console.log("[3] Fetching main page for iM token...");
  const mainPage = await client.get(`${BASE_URL}/Index.aspx`, { headers: DEFAULT_HEADERS });
  const $main = cheerio.load(mainPage.data);
  const html = mainPage.data;

  // Extract userId
  let userId = username;
  const userIdMatch = html.match(/QLSV_NguoiHoc_Id['"]\s*[:=]\s*['"]?([0-9]+)['"]?/i)
    || html.match(/userId['"]\s*[:=]\s*['"]([^'"]+)['"]/i)
    || html.match(/"userId"\s*:\s*"([^"]+)"/);
  if (userIdMatch) userId = userIdMatch[1];

  // Extract iM token
  let iM = null;
  const iMPatterns = [
    /edu\.system\.iM\s*=\s*['"]([^'"]+)['"]/i,
    /iM\s*[:=]\s*['"]([A-Za-z0-9+/=]{20,})['"]/,
    /[A-Za-z0-9_]+\s*=\s*\(\)\s*=>\s*["']([^"']+)["']/i,
    /["']iM["']\s*:\s*["']([^"']{20,})["']/,
  ];
  for (const pat of iMPatterns) {
    const m = html.match(pat);
    if (m) { iM = m[1]; break; }
  }

  // Normalize cookie paths
  const allCookies = await jar.getCookies(BASE_URL);
  for (const c of allCookies) {
    c.path = "/";
    await jar.setCookie(c, "https://qldt.eaut.edu.vn");
  }

  const studentName = $main("#lblHoTenNguoiDangNhap").text().trim() || "";
  console.log(`   userId: ${userId}`);
  console.log(`   iM: ${iM ? iM.substring(0, 40) + "..." : "NOT FOUND"}`);
  console.log(`   name: ${studentName}`);

  return { client, userId, iM, jar };
}

// ── Test the API call and show full response ─────────────────────────────────
async function testApiCall(client, userId, iM) {
  const API_URL = "https://qldt.eaut.edu.vn/sinhvienapi/api/SV_ThongTin_MH/DSA4BRINKCIpAiAPKSAv";
  
  const now = new Date();
  const fmt = (d) => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay() + 2);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 5);

  // Attempt 1: standard JSON body
  const requestBody = {
    action: "SV_ThongTin_MH/DSA4BRINKCIpAiAPKSAv",
    func: "pkg_congthongtin_hssv_thongtin.LayDSLichCaNhan",
    iM: iM || "",
    strQLSV_NguoiHoc_Id: userId,
    strNgayBatDau: fmt(weekStart),
    strNgayKetThuc: fmt(weekEnd),
  };

  console.log("\n[4] Request body being sent:");
  console.log(JSON.stringify(requestBody, null, 2));

  try {
    const resp = await client.post(API_URL, requestBody, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": `${BASE_URL}/Index.aspx`,
        ...(iM ? { "Token": iM, "iM": iM, "Authorization": `Bearer ${iM}` } : {}),
      },
      timeout: 20000,
      validateStatus: () => true, // Don't throw on error status
    });
    console.log(`\n[5] Response status: ${resp.status}`);
    console.log("[5] Response headers:", JSON.stringify(resp.headers, null, 2));
    console.log("[5] Response body (first 2000 chars):");
    const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    console.log(body.substring(0, 2000));
  } catch (e) {
    console.error("[5] Request threw exception:", e.message);
  }

  // Attempt 2: Try WITHOUT custom iM headers (only body)
  console.log("\n[6] Attempt 2 - Without custom auth headers...");
  try {
    const resp = await client.post(API_URL, requestBody, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": `${BASE_URL}/Index.aspx`,
        "Origin": "https://qldt.eaut.edu.vn",
      },
      timeout: 20000,
      validateStatus: () => true,
    });
    console.log(`   Response status: ${resp.status}`);
    const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    console.log("   Response body (first 2000 chars):");
    console.log(body.substring(0, 2000));
  } catch (e) {
    console.error("   Request threw exception:", e.message);
  }

  // Attempt 3: Try different func name variants
  console.log("\n[7] Attempt 3 - Different func name...");
  const altBody = {
    ...requestBody,
    func: "LayDSLichCaNhan",
  };
  try {
    const resp = await client.post(API_URL, altBody, {
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, */*",
        "Referer": `${BASE_URL}/Index.aspx`,
      },
      timeout: 20000,
      validateStatus: () => true,
    });
    console.log(`   Response status: ${resp.status}`);
    const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    console.log("   Response body (first 2000 chars):");
    console.log(body.substring(0, 2000));
  } catch (e) {
    console.error("   Request threw exception:", e.message);
  }

  // Attempt 4: Check what the response body of 500 says with minimal body
  console.log("\n[8] Attempt 4 - Empty body to see error message...");
  try {
    const resp = await client.post(API_URL, {}, {
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, */*",
        "Referer": `${BASE_URL}/Index.aspx`,
      },
      timeout: 20000,
      validateStatus: () => true,
    });
    console.log(`   Response status: ${resp.status}`);
    const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    console.log("   Response body (first 2000 chars):");
    console.log(body.substring(0, 2000));
  } catch (e) {
    console.error("   Request threw exception:", e.message);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const USERNAME = process.argv[2] || "24001647";
  const PASSWORD = process.argv[3] || "thuy2004@";

  console.log(`=== EAUT API Debug ===`);
  console.log(`Username: ${USERNAME}`);

  try {
    const { client, userId, iM } = await login(USERNAME, PASSWORD);
    await testApiCall(client, userId, iM);
  } catch (e) {
    console.error("Fatal error:", e.message);
    console.error(e.stack);
  }
}

main();
