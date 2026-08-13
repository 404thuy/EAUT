const puppeteer = require("puppeteer");

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    ignoreHTTPSErrors: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    console.log("Navigating to login page...");
    await page.goto("https://qldt.eaut.edu.vn/congthongtin/login.aspx#diemhoc", {
      waitUntil: "networkidle2",
      timeout: 45000,
    });

    console.log("Typing credentials...");
    await page.focus('#username');
    await page.$eval('#username', (el) => (el.value = ''));
    await page.type('#username', '24003543', { delay: 15 });

    await page.focus('#password');
    await page.$eval('#password', (el) => (el.value = ''));
    await page.type('#password', 'toan2832006', { delay: 15 });

    console.log("Clicking login...");
    await Promise.all([
      page.click('#cms_authenticate_do_login'),
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }).catch(() => {}),
    ]);

    await page.screenshot({ path: "scratch/after_login.png" });
    console.log("Screenshot saved at scratch/after_login.png");

    const errorMsg = await page.evaluate(() => {
      const errEl = document.querySelector("#lblError, .text-danger, .error-message, font[color='red'], div[style*='color: red'], div[style*='color:Red'], #divError");
      return errEl ? errEl.textContent.trim() : null;
    });
    console.log("Error message on page:", errorMsg);

    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log("Is authenticated checks:", {
      edu: await page.evaluate(() => !!window.edu),
      system: await page.evaluate(() => !!(window.edu && window.edu.system)),
      userId: await page.evaluate(() => !!(window.edu && window.edu.system && window.edu.system.userId)),
      userIdVal: await page.evaluate(() => window.edu && window.edu.system && window.edu.system.userId),
      bodyLength: bodyText.length,
      bodySnippet: bodyText.substring(0, 500)
    });

  } catch (error) {
    console.error("Error occurred:", error);
  } finally {
    await browser.close();
  }
})();
