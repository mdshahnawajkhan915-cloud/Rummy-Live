const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const SECRET = process.env.JWT_SECRET;
const ADMIN = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      coins BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coin_requests (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id),
      amount INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS activity (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id),
      action TEXT NOT NULL,
      amount INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Login required" });
  }
}

function admin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

app.get("/", (req, res) => {
  res.json({ name: "RUMMY LIVE", status: "Backend Online" });
});

app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || password.length < 6)
      return res.status(400).json({ error: "Username and 6+ character password required" });

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO players(username,password,coins) VALUES($1,$2,0) RETURNING id,username,coins",
      [username.trim(), hash]
    );

    const player = result.rows[0];
    const token = jwt.sign({ id: player.id, role: "player" }, SECRET);
    res.json({ token, player });
  } catch {
    res.status(400).json({ error: "Username already exists or registration failed" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query("SELECT * FROM players WHERE username=$1", [username]);
    if (!result.rows.length || !(await bcrypt.compare(password, result.rows[0].password)))
      return res.status(401).json({ error: "Invalid login details" });

    const p = result.rows[0];
    const token = jwt.sign({ id: p.id, role: "player" }, SECRET);
    res.json({ token, player: { id: p.id, username: p.username, coins: p.coins } });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (!ADMIN_PASSWORD || username !== ADMIN || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: "Invalid admin login" });

  const token = jwt.sign({ role: "admin" }, SECRET);
  res.json({ token, role: "admin" });
});

app.get("/api/me", auth, async (req, res) => {
  if (req.user.role !== "player") return res.status(403).json({ error: "Player only" });
  const result = await pool.query(
    "SELECT id,username,coins,created_at FROM players WHERE id=$1",
    [req.user.id]
  );
  res.json(result.rows[0] || {});
});

app.post("/api/coin-request", auth, async (req, res) => {
  if (req.user.role !== "player") return res.status(403).json({ error: "Player only" });
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000)
    return res.status(400).json({ error: "Invalid amount" });

  const result = await pool.query(
    "INSERT INTO coin_requests(player_id,amount) VALUES($1,$2) RETURNING *",
    [req.user.id, amount]
  );
  res.json({ message: "Coin request submitted", request: result.rows[0] });
});

app.get("/api/history", auth, async (req, res) => {
  if (req.user.role !== "player") return res.status(403).json({ error: "Player only" });
  const result = await pool.query(
    "SELECT action,amount,created_at FROM activity WHERE player_id=$1 ORDER BY id DESC LIMIT 100",
    [req.user.id]
  );
  res.json(result.rows);
});

app.get("/api/admin/players", auth, admin, async (req, res) => {
  const result = await pool.query(
    "SELECT id,username,coins,created_at FROM players ORDER BY id DESC"
  );
  res.json(result.rows);
});

app.post("/api/admin/coins", auth, admin, async (req, res) => {
  const { playerId, amount } = req.body;
  const change = Number(amount);
  if (!Number.isInteger(Number(playerId)) || !Number.isInteger(change) || change === 0)
    return res.status(400).json({ error: "Invalid player or amount" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "UPDATE players SET coins=coins+$1 WHERE id=$2 AND coins+$1>=0 RETURNING id,username,coins",
      [change, playerId]
    );
    if (!result.rows.length) throw new Error("Player not found or insufficient balance");

    await client.query(
      "INSERT INTO activity(player_id,action,amount) VALUES($1,$2,$3)",
      [playerId, change > 0 ? "Admin credited coins" : "Admin deducted coins", change]
    );
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get("/api/admin/requests", auth, admin, async (req, res) => {
  const result = await pool.query(`
    SELECT r.*,p.username FROM coin_requests r
    JOIN players p ON p.id=r.player_id
    ORDER BY r.id DESC
  `);
  res.json(result.rows);
});

app.post("/api/admin/requests/:id/approve", auth, admin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const request = await client.query(
      "SELECT * FROM coin_requests WHERE id=$1 AND status='pending' FOR UPDATE",
      [req.params.id]
    );
    if (!request.rows.length) throw new Error("Request not found");

    const r = request.rows[0];
    await client.query("UPDATE players SET coins=coins+$1 WHERE id=$2", [r.amount, r.player_id]);
    await client.query(
      "INSERT INTO activity(player_id,action,amount) VALUES($1,$2,$3)",
      [r.player_id, "Coin request approved", r.amount]
    );
    await client.query("UPDATE coin_requests SET status='approved' WHERE id=$1", [r.id]);
    await client.query("COMMIT");
    res.json({ message: "Request approved" });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
setup()
  .then(() => app.listen(PORT, "0.0.0.0", () => {
    console.log("RUMMY LIVE API running on port " + PORT);
  }))
  .catch(error => {
    console.error("Database setup failed:", error);
    process.exit(1);
  });
