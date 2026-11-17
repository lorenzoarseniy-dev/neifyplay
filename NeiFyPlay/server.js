require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "NeiFy_Play";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Claude";
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 12);

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error("Ошибка: задайте SESSION_SECRET длиной не менее 32 символов в .env.");
  process.exit(1);
}

if (ADMIN_PASSWORD === "Claude") {
  console.warn("ВНИМАНИЕ: используется простой пароль Claude. Замените его перед публикацией сайта.");
}

if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

const db = new Database(path.join(DATA_DIR, "neifyplay.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    filename TEXT,
    mime_type TEXT,
    original_name TEXT,
    file_size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const episodeCount = db.prepare("SELECT COUNT(*) AS count FROM episodes").get().count;
if (episodeCount === 0) {
  db.prepare(`
    INSERT INTO episodes (title, description)
    VALUES (?, ?)
  `).run(
    "Серия 1",
    "Первая серия сериала «Бессмертный». Видео можно добавить в панели администратора."
  );
}

const SQLiteStore = SQLiteStoreFactory(session);
app.use(session({
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: DATA_DIR,
    table: "sessions"
  }),
  name: "neifyplay.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 12 * 60 * 60 * 1000
  }
}));

function getCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  const supplied = req.get("X-CSRF-Token") || "";
  const expected = req.session.csrfToken || "";
  const valid = supplied.length === expected.length &&
    expected.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));

  if (!valid) {
    return res.status(403).json({ error: "Сессия обновилась. Обновите страницу и попробуйте ещё раз." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ error: "Нужен вход администратора." });
  }
  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Слишком много попыток входа. Попробуйте позже." }
});

const allowedTypes = new Map([
  [".mp4", new Set(["video/mp4"])],
  [".webm", new Set(["video/webm"])],
  [".mov", new Set(["video/quicktime"])],
  [".mkv", new Set(["video/x-matroska", "application/octet-stream"])]
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const validMimes = allowedTypes.get(ext);
    if (!validMimes || !validMimes.has(file.mimetype)) {
      return cb(new Error("Поддерживаются видео MP4, WebM, MOV и MKV. Для лучшей совместимости используйте MP4."));
    }
    cb(null, true);
  }
});

function publicEpisode(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    videoAvailable: Boolean(row.filename),
    videoUrl: row.filename ? `/media/${row.id}` : null
  };
}

app.get("/api/session", (req, res) => {
  res.json({
    authenticated: Boolean(req.session.isAdmin),
    username: req.session.isAdmin ? ADMIN_USERNAME : null,
    csrfToken: getCsrfToken(req)
  });
});

app.post("/api/login", loginLimiter, requireCsrf, async (req, res) => {
  const username = String(req.body.username || "");
  const password = String(req.body.password || "");

  const usernameOk = username === ADMIN_USERNAME;
  const passwordOk = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

  if (!usernameOk || !passwordOk) {
    return res.status(401).json({ error: "Неверный логин или пароль." });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Не удалось создать сессию." });
    req.session.isAdmin = true;
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: "Не удалось сохранить вход." });
      res.json({ ok: true, csrfToken: req.session.csrfToken });
    });
  });
});

app.post("/api/logout", requireCsrf, requireAdmin, (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Не удалось выйти из аккаунта." });
    res.clearCookie("neifyplay.sid", { httpOnly: true, sameSite: "lax" });
    res.json({ ok: true });
  });
});

app.get("/api/episodes", (_req, res) => {
  const rows = db.prepare("SELECT * FROM episodes ORDER BY id ASC").all();
  res.json(rows.map(publicEpisode));
});

app.get("/api/admin/episodes", requireAdmin, (_req, res) => {
  const rows = db.prepare("SELECT * FROM episodes ORDER BY id ASC").all();
  res.json(rows.map(publicEpisode));
});

app.post(
  "/api/admin/episodes",
  requireAdmin,
  requireCsrf,
  (req, res, next) => upload.single("video")(req, res, (err) => {
    if (err) return next(err);
    next();
  }),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "Выберите видеофайл." });
    }

    const title = String(req.body.title || "").trim().slice(0, 120);
    const description = String(req.body.description || "").trim().slice(0, 2000);
    const episodeId = String(req.body.episodeId || "").trim();

    if (!title) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Укажите название серии." });
    }

    const file = req.file;
    const insertEpisode = db.prepare(`
      INSERT INTO episodes (title, description, filename, mime_type, original_name, file_size)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const updateEpisode = db.prepare(`
      UPDATE episodes
      SET title = ?, description = ?, filename = ?, mime_type = ?, original_name = ?,
          file_size = ?, created_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    try {
      if (episodeId) {
        const id = Number(episodeId);
        const existing = db.prepare("SELECT * FROM episodes WHERE id = ?").get(id);
        if (!Number.isInteger(id) || !existing) {
          fs.unlink(file.path, () => {});
          return res.status(404).json({ error: "Такая серия не найдена." });
        }

        updateEpisode.run(
          title, description, file.filename, file.mimetype,
          path.basename(file.originalname), file.size, id
        );

        if (existing.filename) {
          const oldPath = path.join(UPLOAD_DIR, path.basename(existing.filename));
          fs.unlink(oldPath, () => {});
        }
        const updated = db.prepare("SELECT * FROM episodes WHERE id = ?").get(id);
        return res.json(publicEpisode(updated));
      }

      const result = insertEpisode.run(
        title, description, file.filename, file.mimetype,
        path.basename(file.originalname), file.size
      );
      const created = db.prepare("SELECT * FROM episodes WHERE id = ?").get(result.lastInsertRowid);
      return res.status(201).json(publicEpisode(created));
    } catch (error) {
      fs.unlink(file.path, () => {});
      console.error("Episode save error:", error);
      return res.status(500).json({ error: "Не удалось сохранить серию." });
    }
  }
);

app.delete("/api/admin/episodes/:id", requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Некорректный номер серии." });

  const episode = db.prepare("SELECT * FROM episodes WHERE id = ?").get(id);
  if (!episode) return res.status(404).json({ error: "Серия не найдена." });

  db.prepare("DELETE FROM episodes WHERE id = ?").run(id);
  if (episode.filename) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(episode.filename)), () => {});
  }
  res.json({ ok: true });
});

app.get("/media/:id", (req, res) => {
  const id = Number(req.params.id);
  const episode = db.prepare("SELECT * FROM episodes WHERE id = ?").get(id);

  if (!episode || !episode.filename) {
    return res.status(404).send("Видео не найдено.");
  }

  const filePath = path.join(UPLOAD_DIR, path.basename(episode.filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Файл видео не найден на сервере.");
  }

  res.setHeader("Cache-Control", "private, max-age=3600");
  res.type(episode.mime_type || "application/octet-stream");
  res.sendFile(filePath);
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "Файл слишком большой. Максимальный размер — 1 ГБ."
      : "Не удалось загрузить файл.";
    return res.status(400).json({ error: message });
  }
  if (err.message && err.message.startsWith("Поддерживаются видео")) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: "Внутренняя ошибка сервера." });
});

app.listen(PORT, () => {
  console.log(`NeiFyPlay запущен: http://localhost:${PORT}`);
});
