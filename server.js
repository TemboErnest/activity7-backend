/*
 * ICT251 - Activity 7: Backend Development
 * Single-file Node.js + Express REST API (CommonJS).
 *
 * Contains: server, CORS, database layer, schema, seed data,
 * the five record routes, validation, error handling, /health and the HTML guide at "/".
 *
 * ---------------------------------------------------------------
 * SETUP
 *   mkdir activity7-backend && cd activity7-backend
 *   npm init -y
 *   npm install express cors dotenv pg better-sqlite3
 *   npm pkg set scripts.start="node server.js"
 *   (save this file as server.js - do NOT add "type":"module")
 *
 * .env (local only - never commit)
 *   PORT=3000
 *   CLIENT_ORIGINS=http://localhost:5500,http://127.0.0.1:5500
 *   STUDENT_NAME=Your Name
 *   STUDENT_NUMBER=Your Student Number
 *   PUBLIC_URL=https://your-backend.onrender.com   (optional, shown in guide)
 *   # Leave DATABASE_URL empty to use local SQLite (file: data.sqlite).
 *   # Set DATABASE_URL (e.g. Render PostgreSQL) for storage that survives restarts:
 *   # DATABASE_URL=postgres://user:pass@host:5432/dbname
 *   # DATABASE_SSL=true   (needed for most hosted Postgres)
 *
 * .gitignore
 *   node_modules
 *   .env
 *   data.sqlite
 *
 * RUN:  npm start      then open http://localhost:3000
 *
 * RENDER: Web Service -> Build: npm install -> Start: npm start
 *   Env vars: CLIENT_ORIGINS, STUDENT_NAME, STUDENT_NUMBER, and DATABASE_URL
 *   (+ DATABASE_SSL=true) from a Render PostgreSQL instance.
 *   NOTE: Render free web services have a temporary disk, so SQLite data
 *   there is lost on restart/redeploy. Use DATABASE_URL (hosted DB) to keep records.
 * ---------------------------------------------------------------
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");

/* ======================= DATABASE LAYER ======================= */

const USE_PG = Boolean(process.env.DATABASE_URL);
let pool = null;   // PostgreSQL pool
let sqlite = null; // SQLite handle

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS records (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  category TEXT NOT NULL CHECK (char_length(category) BETWEEN 2 AND 40),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 5 AND 300),
  status TEXT NOT NULL CHECK (status IN ('Pending','In progress','Completed'))
);`;

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 80),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 2 AND 40),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 5 AND 300),
  status TEXT NOT NULL CHECK (status IN ('Pending','In progress','Completed'))
);`;

// Made-up records (adapt categories/titles to your Activity 6 system).
const SEED = [
  ["Broken classroom light", "Electrical", "The light in Room B12 does not switch on.", "Pending"],
  ["Leaking tap in lab", "Plumbing", "The tap at the back sink of Computer Lab 2 drips constantly.", "In progress"],
  ["Projector not working", "Equipment", "The projector in Lecture Hall A shows no image.", "Pending"],
  ["Cracked window pane", "Building", "A window in the library reading area has a large crack.", "Completed"],
  ["Slow campus Wi-Fi", "Network", "Wi-Fi in the engineering block drops every few minutes.", "In progress"],
  ["Broken door lock", "Security", "The door lock of Room C04 cannot be locked properly.", "Pending"],
  ["Overflowing bin", "Cleaning", "The bins outside the cafeteria are full and need emptying.", "Completed"],
  ["Faulty air conditioner", "Electrical", "The air conditioner in the staff office makes a loud noise.", "Pending"],
];

// Run a SQL statement using $1,$2... placeholders; always resolves to an array of rows.
async function query(sql, params = []) {
  if (USE_PG) {
    const result = await pool.query(sql, params);
    return result.rows;
  }
  const stmt = sqlite.prepare(sql.replace(/\$\d+/g, "?"));
  if (stmt.reader) return stmt.all(...params);
  stmt.run(...params);
  return [];
}

async function initDatabase() {
  if (USE_PG) {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
    });
    await pool.query(SCHEMA_PG);
  } else {
    const Database = require("better-sqlite3");
    sqlite = new Database(process.env.SQLITE_PATH || "data.sqlite");
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec(SCHEMA_SQLITE);
  }

  // Seed once, only when the table is empty.
  const rows = await query("SELECT COUNT(*) AS n FROM records");
  if (Number(rows[0].n) === 0) {
    for (const r of SEED) {
      await query(
        "INSERT INTO records (title, category, description, status) VALUES ($1, $2, $3, $4)",
        r
      );
    }
    console.log(`Seeded ${SEED.length} records.`);
  }
  console.log(`Database ready (${USE_PG ? "PostgreSQL" : "SQLite"}).`);
}

/* ======================= VALIDATION ======================= */

const STATUSES = ["Pending", "In progress", "Completed"];
const COLUMNS = "id, title, category, description, status";

function parseId(raw) {
  if (!/^[1-9]\d*$/.test(String(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// Returns { error } or { value } with the four trimmed editable fields. Ignores any client id.
function validateBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }
  const labels = { title: "Title", category: "Category", description: "Description", status: "Status" };
  const clean = {};
  for (const field of Object.keys(labels)) {
    if (body[field] === undefined || body[field] === null) {
      return { error: `${labels[field]} is required.` };
    }
    if (typeof body[field] !== "string") {
      return { error: `${labels[field]} must be a string.` };
    }
    clean[field] = body[field].trim();
    if (clean[field] === "") {
      return { error: `${labels[field]} must not be empty or spaces only.` };
    }
  }
  if (clean.title.length < 3 || clean.title.length > 80)
    return { error: "Title must have 3 to 80 characters." };
  if (clean.category.length < 2 || clean.category.length > 40)
    return { error: "Category must have 2 to 40 characters." };
  if (clean.description.length < 5 || clean.description.length > 300)
    return { error: "Description must have 5 to 300 characters." };
  if (!STATUSES.includes(clean.status))
    return { error: "Status must be Pending, In progress or Completed." };
  return { value: clean };
}

/* ======================= RECORD ROUTES ======================= */

const router = express.Router();

// GET all
router.get("/", async (req, res, next) => {
  try {
    const rows = await query(`SELECT ${COLUMNS} FROM records ORDER BY id`);
    res.status(200).json(rows);
  } catch (err) { next(err); }
});

// GET one
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: "Id must be a positive whole number." });
    const rows = await query(`SELECT ${COLUMNS} FROM records WHERE id = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ message: "Record not found." });
    res.status(200).json(rows[0]);
  } catch (err) { next(err); }
});

// POST create
router.post("/", async (req, res, next) => {
  try {
    const { error, value } = validateBody(req.body);
    if (error) return res.status(400).json({ message: error });
    const rows = await query(
      `INSERT INTO records (title, category, description, status)
       VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [value.title, value.category, value.description, value.status]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT replace all four editable fields
router.put("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: "Id must be a positive whole number." });
    const { error, value } = validateBody(req.body);
    if (error) return res.status(400).json({ message: error });
    const rows = await query(
      `UPDATE records SET title = $1, category = $2, description = $3, status = $4
       WHERE id = $5 RETURNING ${COLUMNS}`,
      [value.title, value.category, value.description, value.status, id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Record not found." });
    res.status(200).json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ message: "Id must be a positive whole number." });
    const rows = await query("DELETE FROM records WHERE id = $1 RETURNING id", [id]);
    if (rows.length === 0) return res.status(404).json({ message: "Record not found." });
    res.status(200).json({ message: "Record deleted." });
  } catch (err) { next(err); }
});

/* ======================= APP, GUIDE, HEALTH ======================= */

const app = express();
const origins = (process.env.CLIENT_ORIGINS || "")
  .split(",").map(v => v.trim()).filter(Boolean);

app.use(cors({ origin: origins }));
app.use(express.json());

app.get("/", (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const name = process.env.STUDENT_NAME || "Your Name";
  const number = process.env.STUDENT_NUMBER || "Your Student Number";
  res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Campus Service Requests API - ICT251 Activity 7</title>
<style>
 body{font-family:system-ui,Arial,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#222}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
 th{background:#eef3f8} pre{background:#f5f5f5;padding:1rem;overflow:auto;border-radius:6px}
 code{background:#f5f5f5;padding:0 .25rem}
</style></head><body>
<h1>Campus Service Requests API</h1>
<p><strong>Student:</strong> ${name} &nbsp; <strong>Student number:</strong> ${number}<br>
<strong>Course:</strong> ICT251 Introduction to Web Technologies - Activity 7 (Backend Development)</p>
<p>A REST API for a campus service request system. Users submit maintenance or service requests and track them
as Pending, In progress or Completed. Data is stored in a database and exchanged as JSON.</p>
<p><strong>Live API base URL:</strong> <a href="${base}">${base}</a><br>
Quick links: <a href="/health">/health</a> | <a href="/api/records">/api/records</a></p>
<p><em>Note: on a free host an idle service may sleep, so the first request can take up to a minute to respond.</em></p>

<h2>Routes</h2>
<table>
<tr><th>Method</th><th>Route</th><th>Purpose</th><th>Success</th></tr>
<tr><td>GET</td><td>/</td><td>This API guide</td><td>200</td></tr>
<tr><td>GET</td><td>/health</td><td>Check server and database</td><td>200</td></tr>
<tr><td>GET</td><td>/api/records</td><td>Read all records</td><td>200</td></tr>
<tr><td>GET</td><td>/api/records/:id</td><td>Read one record</td><td>200</td></tr>
<tr><td>POST</td><td>/api/records</td><td>Create a record</td><td>201</td></tr>
<tr><td>PUT</td><td>/api/records/:id</td><td>Update a record (all four fields)</td><td>200</td></tr>
<tr><td>DELETE</td><td>/api/records/:id</td><td>Delete a record</td><td>200</td></tr>
</table>

<h2>Fields</h2>
<table>
<tr><th>Field</th><th>Rule</th></tr>
<tr><td>id</td><td>Positive whole number, generated by the database (do not send it)</td></tr>
<tr><td>title</td><td>Text, 3 to 80 characters</td></tr>
<tr><td>category</td><td>Text, 2 to 40 characters</td></tr>
<tr><td>description</td><td>Text, 5 to 300 characters</td></tr>
<tr><td>status</td><td>Exactly one of: <code>Pending</code>, <code>In progress</code>, <code>Completed</code></td></tr>
</table>

<h2>Valid POST / PUT body</h2>
<p>Send <code>Content-Type: application/json</code>.</p>
<pre>{
  "title": "Broken classroom light",
  "category": "Electrical",
  "description": "The light in Room B12 does not switch on.",
  "status": "Pending"
}</pre>

<h2>Responses</h2>
<table>
<tr><th>Status</th><th>Meaning</th></tr>
<tr><td>200</td><td>GET, PUT or DELETE succeeded (DELETE returns <code>{"message":"Record deleted."}</code>)</td></tr>
<tr><td>201</td><td>POST created a record</td></tr>
<tr><td>400</td><td>Invalid id, invalid input or malformed JSON</td></tr>
<tr><td>404</td><td>Record or route not found</td></tr>
<tr><td>500</td><td>Unexpected server error</td></tr>
<tr><td>503</td><td>/health: database not responding</td></tr>
</table>
<p>Errors are JSON, e.g. <code>{"message":"Title must have 3 to 80 characters."}</code></p>
</body></html>`);
});

app.get("/health", async (req, res) => {
  try {
    await query("SELECT 1 AS ok");
    res.status(200).json({ status: "ok", database: "connected" });
  } catch (err) {
    console.error("Health check failed:", err);
    res.status(503).json({ message: "Database is not responding." });
  }
});

app.use("/api/records", router);

// Unknown routes -> JSON 404
app.use((req, res) => {
  res.status(404).json({ message: "Route not found." });
});

// Error middleware (4 parameters)
app.use((error, req, res, next) => {
  if (error.type === "entity.parse.failed" || (error instanceof SyntaxError && error.status === 400)) {
    return res.status(400).json({ message: "Malformed JSON in request body." });
  }
  console.error("Unexpected error:", error);
  res.status(500).json({ message: "Something went wrong on the server." });
});

/* ======================= START ======================= */

const port = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch(err => {
    console.error("Failed to start:", err);
    process.exit(1);
  });

