const express = require("express");
const mysql = require("mysql2");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || "127.0.0.1";
const requiredDatabaseSettings = ["DB_HOST", "DB_USER", "DB_NAME"];
const missingSettings = requiredDatabaseSettings.filter((key) => !process.env[key]);

if (missingSettings.length) {
  console.error("Missing database settings: " + missingSettings.join(", ") + ". Add them to CODE/.env.");
  process.exit(1);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  dateStrings: false
});

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    pool.query(sql, params, (error, rows) => {
      if (error) return reject(error);
      resolve(rows);
    });
  });
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/script.js", (req, res) => res.sendFile(path.join(__dirname, "script.js")));

app.get("/api/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Database health check failed:", error.message);
    res.status(503).json({ status: "unavailable", database: "disconnected" });
  }
});

app.get("/api/latest-period", async (req, res) => {
  try {
    const rows = await query(
      "SELECT CONCAT(`year`, '-', LPAD(`month`, 2, '0')) AS period FROM merged_worker_attendance ORDER BY `year` DESC, `month` DESC LIMIT 1"
    );
    res.json({ period: rows[0]?.period || null });
  } catch (error) {
    console.error("Error fetching latest wage period:", error.message);
    res.status(500).json({ error: "Unable to load the latest wage period." });
  }
});

app.get("/api/periods", async (req, res) => {
  try {
    const rows = await query(
      `SELECT available_periods.period_year AS year,
              available_periods.period_month AS month,
              MAX(available_periods.has_wages) AS has_wages,
              MAX(available_periods.has_attendance) AS has_attendance
       FROM (
         SELECT payroll.year AS period_year, payroll.month AS period_month, 1 AS has_wages, 0 AS has_attendance
         FROM merged_worker_attendance AS payroll
         GROUP BY payroll.year, payroll.month
         UNION ALL
         SELECT YEAR(W_DATE) AS period_year, MONTH(W_DATE) AS period_month, 0 AS has_wages, 1 AS has_attendance
         FROM Attendance
         WHERE W_DATE IS NOT NULL
         GROUP BY YEAR(W_DATE), MONTH(W_DATE)
       ) AS available_periods
       GROUP BY available_periods.period_year, available_periods.period_month
       ORDER BY available_periods.period_year DESC, available_periods.period_month DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error("Error fetching available wage periods:", error.message);
    res.status(500).json({ error: "Unable to load available wage periods." });
  }
});

app.get("/api/job-codes", async (req, res) => {
  try {
    const rows = await query(
      `SELECT job_code
       FROM (
         SELECT CAST(job_code AS CHAR) AS job_code
         FROM merged_worker_attendance
         WHERE job_code IS NOT NULL
         UNION
         SELECT CAST(job_code AS CHAR) AS job_code
         FROM Attendance
         WHERE job_code IS NOT NULL
       ) AS available_jobs
       ORDER BY job_code`
    );
    res.json(rows);
  } catch (error) {
    console.error("Error fetching job codes:", error.message);
    res.status(500).json({ error: "Unable to load job codes." });
  }
});

app.get("/api/job-details/:jobCode", async (req, res) => {
  const jobCode = req.params.jobCode;
  if (!jobCode || jobCode.length > 100) {
    return res.status(400).json({ error: "A valid job code is required." });
  }

  try {
    const [jobRows, attendanceRows] = await Promise.all([
      query(
        "SELECT job_code, agency, start_date, end_date, work_place, job_description FROM jobs WHERE job_code = ? LIMIT 1",
        [jobCode]
      ),
      query(
        "SELECT GROUP_CONCAT(DISTINCT AGENCY ORDER BY AGENCY SEPARATOR ', ') AS agencies, GROUP_CONCAT(DISTINCT CAST(DEPT_CD AS CHAR) ORDER BY DEPT_CD SEPARATOR ', ') AS department_code, MIN(W_DATE) AS attendance_start_date, MAX(W_DATE) AS attendance_end_date FROM Attendance WHERE CAST(job_code AS CHAR) = ?",
        [jobCode]
      )
    ]);
    const attendance = attendanceRows[0] || {};
    if (jobRows.length) {
      return res.json({
        ...jobRows[0],
        department_code: attendance.department_code || null,
        attendance_start_date: attendance.attendance_start_date || null,
        attendance_end_date: attendance.attendance_end_date || null,
        period_label: "Contract period",
        contract_details_available: true
      });
    }
    if (!attendance.attendance_start_date && !attendance.agencies) {
      return res.status(404).json({ error: "Job details not found." });
    }
    res.json({
      job_code: jobCode,
      agency: attendance.agencies || null,
      start_date: attendance.attendance_start_date || null,
      end_date: attendance.attendance_end_date || null,
      period_label: "Attendance range",
      work_place: null,
      job_description: null,
      department_code: attendance.department_code || null,
      contract_details_available: false
    });
  } catch (error) {
    console.error("Error fetching job details:", error.message);
    res.status(500).json({ error: "Unable to load job details." });
  }
});

app.get("/api/merged-workers/:jobCode", async (req, res) => {
  const jobCode = req.params.jobCode;
  const month = Number(req.query.month);
  const yearText = String(req.query.year || "");

  if (!jobCode || jobCode.length > 100) {
    return res.status(400).json({ error: "A valid job code is required." });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12 || !/^\d{4}$/.test(yearText)) {
    return res.status(400).json({ error: "A valid month and four-digit year are required." });
  }

  const sql = `
    SELECT w.S_no,
           CONCAT('•••• •••• ', RIGHT(CAST(w.ADHAR_ID AS CHAR), 4)) AS ADHAR_ID,
           w.Name, w.Birth_Date, w.Skill, w.job_code,
           w.Present_Days, w.Absent_Days,
           w.Allowance_1 AS Allowance_1,
           w.Allowance_2 AS Allowance_2,
           w.Total AS Total_Wages
    FROM merged_worker_attendance w
    WHERE w.job_code = ?
      AND w.month = ?
      AND w.year = ?
    ORDER BY w.S_no
  `;

  try {
    const wageRows = await query(sql, [jobCode, month, Number(yearText)]);
    if (wageRows.length) {
      return res.json(wageRows.map((row) => ({ ...row, record_type: "wage" })));
    }

    const attendanceRows = await query(
      `SELECT MIN(w.Column_1) AS S_no,
              CONCAT('•••• •••• ', RIGHT(CAST(a.ADHAR_ID AS CHAR), 4)) AS ADHAR_ID,
              MAX(w.LAB_NAME) AS Name,
              MAX(w.LAB_BIRTH_DT) AS Birth_Date,
              COALESCE(MAX(NULLIF(a.WORKER_SKILL, '')), MAX(w.LAB_SKILL)) AS Skill,
              MAX(CAST(a.job_code AS CHAR)) AS job_code,
              COUNT(DISTINCT a.W_DATE) AS Present_Days,
              NULL AS Absent_Days,
              NULL AS Allowance_1,
              NULL AS Allowance_2,
              NULL AS Total_Wages,
              'attendance' AS record_type
       FROM Attendance a
       LEFT JOIN worker_details_shyam w
         ON CAST(w.ADHAR_ID AS CHAR) = CAST(a.ADHAR_ID AS CHAR)
        AND CAST(w.job_code AS CHAR) = CAST(a.job_code AS CHAR)
       WHERE CAST(a.job_code AS CHAR) = ?
         AND MONTH(a.W_DATE) = ?
         AND YEAR(a.W_DATE) = ?
       GROUP BY a.ADHAR_ID, a.job_code
       ORDER BY MIN(w.Column_1), a.ADHAR_ID`,
      [jobCode, month, Number(yearText)]
    );
    res.json(attendanceRows);
  } catch (error) {
    console.error("Error fetching wage records:", error.message);
    res.status(500).json({ error: "Unable to load wage records." });
  }
});

const server = app.listen(port, host, () => {
  console.log("Wage sheet app running at http://" + host + ":" + port);
});

function closeServer() {
  server.close(() => pool.end(() => process.exit(0)));
}
process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);
