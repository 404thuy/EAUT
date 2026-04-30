const path = require("path");
const express = require("express");
const session = require("express-session");
const dotenv = require("dotenv");
const { getStudentSchedule, getStudentTermSchedule, getStudentExamSchedule } = require("./services/eautClient");

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", 1); // Trust first proxy (Vercel)
app.use(
  session({
    secret: process.env.SESSION_SECRET || "eaut-schedule-local-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { 
      maxAge: 1000 * 60 * 60 * 24, // 24 hours
      secure: process.env.NODE_ENV === "production" // Only send over HTTPS in production
    },
  })
);

// Disable caching for all routes to ensure fresh data
app.use((req, res, next) => {
  res.header("Cache-Control", "no-cache, no-store, must-revalidate");
  res.header("Pragma", "no-cache");
  res.header("Expires", "0");
  next();
});

app.get("/health", (req, res) => {
  res.send("Server is healthy");
});

app.get("/", (_req, res) => {
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
    const result = await getStudentSchedule(formData.username, formData.password, {
      preferredWeek: req.body.week || null,
      strictWeek: false,
    });

    req.session.studentLogin = {
      username: formData.username,
      password: formData.password,
      studentName: result.studentName
    };

    return res.redirect("/schedule/week");
  } catch (error) {
    return res.status(500).render("index", {
      error: error.message || "Khong the lay lich hoc tu he thong EAUT.",
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
  const saved = req.session.studentLogin;

  if (!saved?.username || !saved?.password) {
    return res.redirect("/");
  }

  try {
    const result = await getStudentSchedule(saved.username, saved.password, {
      preferredWeek: selectedWeek,
      strictWeek: true,
      useCache: !req.query.refresh,
    });
    return res.render("index", {
      error: null,
      result: { ...result, viewType: "week" },
      formData: { username: saved.username, password: saved.password },
    });
  } catch (error) {
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
    const result = await getStudentExamSchedule(saved.username, saved.password, {
      preferredSemester: isAll ? "" : selectedSemester,
      fetchAll: isAll,
      useCache: !req.query.refresh,
    });
    return res.render("index", {
      error: null,
      result: { ...result, viewType: "exam", selectedSemester },
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

app.get("/logout", (req, res) => {
  req.session.destroy();
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

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
  });
}

module.exports = app;
