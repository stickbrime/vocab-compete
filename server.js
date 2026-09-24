const express = require('express');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'vocab-compete-secret-2026';
const DB_FILE = path.join(__dirname, 'vocab.db');

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(__dirname));

// ---------- Database ----------
let db;
async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const buf = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sets (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    items TEXT NOT NULL,
    mastered TEXT DEFAULT '[]',
    wrong TEXT DEFAULT '[]',
    pos INTEGER DEFAULT 0,
    quiz_order TEXT DEFAULT '[]',
    retry_mode INTEGER DEFAULT 0,
    retry_pos INTEGER DEFAULT 0,
    retry_order TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  // Add columns for existing DBs (ignore error if already exists)
  try { db.run('ALTER TABLE sets ADD COLUMN retry_mode INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE sets ADD COLUMN retry_pos INTEGER DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE sets ADD COLUMN retry_order TEXT DEFAULT "[]"'); } catch(e) {}
  saveDb();
}
function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ---------- Auth middleware ----------
function auth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期' });
  }
}

// ---------- Auth routes ----------
app.post('/api/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '邮箱和密码必填' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const existing = query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length) return res.status(409).json({ error: '该邮箱已注册' });
  const hash = bcrypt.hashSync(password, 10);
  run('INSERT INTO users (email, password, created_at) VALUES (?, ?, ?)', [email, hash, Date.now()]);
  const user = query('SELECT id, email FROM users WHERE email = ?', [email])[0];
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30 * 86400 * 1000, sameSite: 'lax' });
  res.json({ id: user.id, email: user.email });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '邮箱和密码必填' });
  const user = query('SELECT * FROM users WHERE email = ?', [email])[0];
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30 * 86400 * 1000, sameSite: 'lax' });
  res.json({ id: user.id, email: user.email });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/user', auth, (req, res) => {
  const user = query('SELECT id, email FROM users WHERE id = ?', [req.userId])[0];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(user);
});

// ---------- Sets routes ----------
app.get('/api/sets', auth, (req, res) => {
  const rows = query('SELECT * FROM sets WHERE user_id = ? ORDER BY updated_at DESC', [req.userId]);
  const sets = {};
  rows.forEach(r => {
    sets[r.id] = {
      id: r.id,
      name: r.name,
      items: JSON.parse(r.items),
      mastered: JSON.parse(r.mastered),
      wrong: JSON.parse(r.wrong),
      pos: r.pos,
      order: JSON.parse(r.quiz_order),
      retryMode: !!r.retry_mode,
      retryPos: r.retry_pos || 0,
      retryOrder: JSON.parse(r.retry_order || '[]'),
      createdAt: r.created_at,
      lastPlayed: r.updated_at,
    };
  });
  res.json(sets);
});

app.post('/api/sets', auth, (req, res) => {
  const { id, name, items } = req.body || {};
  if (!id || !name || !Array.isArray(items)) return res.status(400).json({ error: '参数不完整' });
  const existing = query('SELECT id FROM sets WHERE id = ? AND user_id = ?', [id, req.userId]);
  const now = Date.now();
  if (existing.length) {
    run('UPDATE sets SET name = ?, items = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [name, JSON.stringify(items), now, id, req.userId]);
  } else {
    run('INSERT INTO sets (id, user_id, name, items, mastered, wrong, pos, quiz_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, req.userId, name, JSON.stringify(items), '[]', '[]', 0, '[]', now, now]);
  }
  res.json({ ok: true });
});

app.put('/api/sets/:id', auth, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: '名称必填' });
  run('UPDATE sets SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    [name, Date.now(), req.params.id, req.userId]);
  res.json({ ok: true });
});

app.delete('/api/sets/:id', auth, (req, res) => {
  run('DELETE FROM sets WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// ---------- Progress sync ----------
app.put('/api/sets/:id/progress', auth, (req, res) => {
  const { mastered, wrong, pos, order, retryMode, retryPos, retryOrder } = req.body || {};
  const now = Date.now();
  run('UPDATE sets SET mastered = ?, wrong = ?, pos = ?, quiz_order = ?, retry_mode = ?, retry_pos = ?, retry_order = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    [JSON.stringify(mastered || []), JSON.stringify(wrong || []), pos || 0, JSON.stringify(order || []),
     retryMode ? 1 : 0, retryPos || 0, JSON.stringify(retryOrder || []),
     now, req.params.id, req.userId]);
  res.json({ ok: true });
});

// ---------- Wrong words collection (错题集) ----------
app.get('/api/wrong-words', auth, (req, res) => {
  const rows = query('SELECT id, name, items, wrong FROM sets WHERE user_id = ?', [req.userId]);
  const result = [];
  rows.forEach(r => {
    const wrongIdx = JSON.parse(r.wrong || '[]');
    if (!wrongIdx.length) return;
    const items = JSON.parse(r.items);
    wrongIdx.forEach(i => {
      if (items[i]) {
        result.push({
          setId: r.id,
          setName: r.name,
          word: items[i].word,
          def: items[i].def,
          sentence: items[i].sentence || '',
          translation: items[i].translation || '',
          src: items[i].src || '',
          englishDef: items[i].englishDef || '',
          index: i,
        });
      }
    });
  });
  res.json(result);
});

// Remove a specific wrong word from a set (by setId + item index)
app.delete('/api/sets/:id/wrong/:idx', auth, (req, res) => {
  const setId = req.params.id;
  const idx = parseInt(req.params.idx);
  const set = query('SELECT wrong FROM sets WHERE id = ? AND user_id = ?', [setId, req.userId]);
  if (!set.length) return res.status(404).json({ error: '词集不存在' });
  const wrong = JSON.parse(set[0].wrong || '[]').filter(i => i !== idx);
  run('UPDATE sets SET wrong = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    [JSON.stringify(wrong), Date.now(), setId, req.userId]);
  res.json({ ok: true });
});

// Serve index.html for the root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Vocab server running at http://localhost:${PORT}`));
});
