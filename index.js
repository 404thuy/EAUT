const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");
const dotenv = require("dotenv");
const { getStudentSchedule, getStudentTermSchedule, getStudentExamSchedule, prefetchAllStudentData } = require("./services/eautClient");

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", 1);


app.use(
  cookieSession({
    name: "eaut-session",
    keys: [process.env.SESSION_SECRET || "eaut-secret-key"],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  })
);

app.get("/favicon.ico", (req, res) => res.sendFile(path.join(__dirname, "public", "logo.png")));
app.get("/favicon.png", (req, res) => res.sendFile(path.join(__dirname, "public", "logo.png")));


// Enable caching for static assets while keeping schedule pages fresh
app.use((req, res, next) => {
  const isStatic = req.path.startsWith("/styles.css") || req.path.startsWith("/app.js") || req.path.startsWith("/favicon") || req.path.endsWith(".png") || req.path.endsWith(".css") || req.path.endsWith(".js");
  if (isStatic) {
    res.header("Cache-Control", "public, max-age=86400");
  } else {
    res.header("Cache-Control", "no-cache, no-store, must-revalidate");
    res.header("Pragma", "no-cache");
    res.header("Expires", "0");
  }
  next();
});

app.get("/health", (req, res) => {
  res.send("Server is healthy");
});

app.get("/ping", (_req, res) => {
  res.header("Cache-Control", "no-store, no-cache, must-revalidate");
  res.header("Pragma", "no-cache");
  res.status(200).send("pong");
});

app.get("/", (req, res) => {
  if (req.session?.studentLogin?.username && req.session?.studentLogin?.password) {
    return res.redirect("/schedule/week");
  }
  res.render("index", {
    error: null,
    result: null,
    formData: { username: "", password: "" },
  });
});

app.post("/schedule", async (req, res) => {
  const formData = {
    username: req.body.username || "",
    password: req.body.password || "",
  };

  if (!formData.username || !formData.password) {
    res.header("Cache-Control", "no-cache, no-store, must-revalidate");
    res.header("Pragma", "no-cache");
    res.header("Expires", "0");
    return res.status(400).render("index", {
      error: "Vui long nhap day du tai khoan va mat khau.",
      result: null,
      formData,
    });
  }

  try {
    const result = await prefetchAllStudentData(formData.username, formData.password, {
      preferredWeek: req.body.week || null,
      strictWeek: false,
      useCache: false, // Force fresh crawl per account on login!
    });

    req.session.studentLogin = {
      username: formData.username,
      password: formData.password,
      studentName: result.studentName
    };

    return res.redirect("/schedule/week");
  } catch (error) {
    console.error("SCHEDULE POST ERROR:", error);
    let msg = error.message || "Không thể lấy lịch học từ hệ thống EAUT.";
    if (msg.includes("SPA framework not initialized") || msg.includes("pptr:evaluate") || msg.includes("/var/task")) {
      msg = "Hệ thống cổng trường EAUT phản hồi chậm hoặc đang bận. Bạn vui lòng bấm Đồng bộ lịch học lại lần nữa nhé!";
    }
    const isLoginError = msg.includes("Đăng nhập thất bại") || msg.includes("Vui lòng nhập");
    const statusCode = isLoginError ? 400 : 500;
    return res.status(statusCode).render("index", {
      error: msg,
      result: null,
      formData: { username: formData.username, password: formData.password },
    });
  }
});

app.get("/schedule", (req, res) => {
  res.redirect("/schedule/week");
});

app.get("/schedule/week", async (req, res) => {
  const selectedWeek = req.query.week || "";
  const selectedSemester = req.query.semester || "";
  const saved = req.session.studentLogin;

  if (!saved?.username || !saved?.password) {
    return res.redirect("/");
  }

  try {
    const result = await getStudentSchedule(saved.username, saved.password, {
      preferredWeek: selectedWeek,
      preferredSemester: selectedSemester,
      strictWeek: true,
      useCache: !req.query.refresh,
    });
    return res.render("index", {
      error: null,
      result: { ...result, viewType: "week" },
      formData: { username: saved.username, password: saved.password },
    });
  } catch (error) {
    console.error("WEEK SCHEDULE ERROR:", error);
    return res.status(500).render("index", {
      error: error.message || "Không thể chuyển tuần học.",
      result: null,
      formData: { username: saved.username, password: saved.password },
    });
  }
});

app.get("/schedule/term", async (req, res) => {
  const selectedSemester = req.query.semester || "";
  const saved = req.session.studentLogin;

  if (!saved?.username || !saved?.password) {
    return res.redirect("/");
  }

  try {
    const isAll = selectedSemester === "all";
    const result = await getStudentTermSchedule(saved.username, saved.password, {
      preferredSemester: isAll ? "" : selectedSemester,
      fetchAll: isAll,
      useCache: !req.query.refresh,
    });
    return res.render("index", {
      error: null,
      result: { ...result, viewType: "term", selectedSemester },
      formData: { username: saved.username, password: saved.password },
    });
  } catch (error) {
    console.error("TERM SCHEDULE ERROR:", error);
    return res.status(500).render("index", {
      error: error.message || "Không thể lấy lịch học kỳ.",
      result: null,
      formData: { username: saved.username, password: saved.password },
    });
  }
});

app.get("/schedule/exam", async (req, res) => {
  const selectedSemester = req.query.semester || "all";
  const saved = req.session.studentLogin;

  if (!saved?.username || !saved?.password) {
    return res.redirect("/");
  }

  try {
    const isAll = selectedSemester === "all";
    const [result, termResult] = await Promise.all([
      getStudentExamSchedule(saved.username, saved.password, {
        preferredSemester: isAll ? "" : selectedSemester,
        fetchAll: isAll,
        useCache: !req.query.refresh,
      }),
      getStudentTermSchedule(saved.username, saved.password, {
        fetchAll: true,
        useCache: true,
      }).catch(() => null),
    ]);

    const creditsMap = {};
    if (termResult && Array.isArray(termResult.results)) {
      termResult.results.forEach((sem) => {
        (sem.rows || []).forEach((row) => {
          if (Array.isArray(row)) {
            let cName = "", cCredits = "";
            row.forEach((cell) => {
              const text = String(cell || "").replace(/<[^>]*>/g, "").trim();
              if (/^\d{1,2}$/.test(text) && !cCredits && Number(text) >= 1 && Number(text) <= 10) {
                cCredits = text;
              } else if (!cName && text.length > 3 && !/^\d+$/.test(text) && !text.includes("/") && !text.toLowerCase().includes("học kỳ")) {
                cName = text;
              }
            });
            if (cName && cCredits) {
              const normKey = cName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").trim();
              creditsMap[normKey] = cCredits;
            }
          }
        });
      });
    }

    return res.render("index", {
      error: null,
      result: { ...result, viewType: "exam", selectedSemester, creditsMap },
      formData: { username: saved.username, password: saved.password },
    });
  } catch (error) {
    return res.status(500).render("index", {
      error: error.message || "Không thể lấy lịch thi.",
      result: null,
      formData: { username: saved.username, password: saved.password },
    });
  }
});

app.get("/schedule/all", async (req, res) => {
  const saved = req.session.studentLogin;
  if (!saved?.username || !saved?.password) {
    return res.redirect("/");
  }
  try {
    const weeklyResult = await getStudentSchedule(saved.username, saved.password, { preferredWeek: null, strictWeek: false });
    const termResult = await getStudentTermSchedule(saved.username, saved.password, { fetchAll: false });
    // Merge results into a single object
    const result = {
      viewType: "combined",
      weekly: weeklyResult,
      term: termResult,
    };
    return res.render("index", {
      error: null,
      result,
      formData: { username: saved.username, password: saved.password },
    });
  } catch (error) {
    return res.status(500).render("index", {
      error: error.message || "Lỗi khi đồng bộ dữ liệu.",
      result: null,
      formData: { username: saved.username, password: saved.password },
    });
  }
});

app.get("/api/schedule/prefetch-all", async (req, res) => {
  const saved = req.session.studentLogin;
  if (!saved?.username || !saved?.password) {
    return res.status(401).json({ success: false, error: "Chưa đăng nhập" });
  }
  try {
    const result = await prefetchAllStudentData(saved.username, saved.password);
    return res.json({ success: true, message: "Đã tải ngầm và lưu trọn vẹn cả 3 lịch", result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/schedule/week", async (req, res) => {
  const selectedWeek = req.query.week || "";
  const selectedSemester = req.query.semester || "";
  const saved = req.session.studentLogin;

  if (!saved?.username || !saved?.password) {
    return res.status(401).json({ success: false, error: "Chưa đăng nhập" });
  }

  try {
    const result = await getStudentSchedule(saved.username, saved.password, {
      preferredWeek: selectedWeek,
      preferredSemester: selectedSemester,
      strictWeek: true,
      useCache: !req.query.refresh,
    });
    return res.json({
      success: true,
      result: { ...result, viewType: "week" },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/schedule/term", async (req, res) => {
  const selectedSemester = req.query.semester || "";
  const saved = req.session.studentLogin;

  if (!saved?.username || !saved?.password) {
    return res.status(401).json({ success: false, error: "Chưa đăng nhập" });
  }

  try {
    const isAll = selectedSemester === "all";
    const result = await getStudentTermSchedule(saved.username, saved.password, {
      preferredSemester: isAll ? "" : selectedSemester,
      fetchAll: isAll,
      useCache: !req.query.refresh,
    });
    return res.json({
      success: true,
      result: { ...result, viewType: "term", selectedSemester },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/schedule/exam", async (req, res) => {
  const selectedSemester = req.query.semester || "all";
  const saved = req.session.studentLogin;

  if (!saved?.username || !saved?.password) {
    return res.status(401).json({ success: false, error: "Chưa đăng nhập" });
  }

  try {
    const isAll = selectedSemester === "all";
    const [result, termResult] = await Promise.all([
      getStudentExamSchedule(saved.username, saved.password, {
        preferredSemester: isAll ? "" : selectedSemester,
        fetchAll: isAll,
        useCache: !req.query.refresh,
      }),
      getStudentTermSchedule(saved.username, saved.password, {
        fetchAll: true,
        useCache: true,
      }).catch(() => null),
    ]);

    const creditsMap = {};
    if (termResult && Array.isArray(termResult.results)) {
      termResult.results.forEach((sem) => {
        (sem.rows || []).forEach((row) => {
          if (Array.isArray(row)) {
            let cName = "", cCredits = "";
            row.forEach((cell) => {
              const text = String(cell || "").replace(/<[^>]*>/g, "").trim();
              if (/^\d{1,2}$/.test(text) && !cCredits && Number(text) >= 1 && Number(text) <= 10) {
                cCredits = text;
              } else if (!cName && text.length > 3 && !/^\d+$/.test(text) && !text.includes("/") && !text.toLowerCase().includes("học kỳ")) {
                cName = text;
              }
            });
            if (cName && cCredits) {
              const normKey = cName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").trim();
              creditsMap[normKey] = cCredits;
            }
          }
        });
      });
    }

    return res.json({
      success: true,
      result: { ...result, viewType: "exam", selectedSemester, creditsMap },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/logout", (req, res) => {
  req.session = null;
  res.redirect("/");
});

// Global error handler for debugging
app.use((err, req, res, next) => {
  console.error("DEBUG ERROR:", err);
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message,
    stack: process.env.NODE_ENV === "production" ? null : err.stack
  });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
  });
}

module.exports = app;
