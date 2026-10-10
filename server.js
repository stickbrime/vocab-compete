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
  db.run(`CREATE TABLE IF NOT EXISTS archived_wrong (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    set_name TEXT NOT NULL,
    word TEXT, def TEXT, sentence TEXT, translation TEXT, src TEXT, englishDef TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS community_banks (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    author_email TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    tags TEXT DEFAULT '[]',
    thumbnail TEXT,
    items TEXT NOT NULL,
    downloads INTEGER DEFAULT 0,
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

// Change password
app.put('/api/user/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: '请填写当前密码和新密码' });
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const user = query('SELECT password FROM users WHERE id = ?', [req.userId])[0];
  if (!user || !bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: '当前密码不正确' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  run('UPDATE users SET password = ? WHERE id = ?', [hash, req.userId]);
  res.json({ ok: true });
});

// Get user stats
app.get('/api/user/stats', auth, (req, res) => {
  const rows = query('SELECT items, mastered, wrong FROM sets WHERE user_id = ?', [req.userId]);
  let totalWords = 0, totalMastered = 0, totalWrong = 0, setCount = rows.length;
  rows.forEach(r => {
    const items = JSON.parse(r.items);
    const mastered = JSON.parse(r.mastered);
    const wrong = JSON.parse(r.wrong);
    totalWords += items.length;
    totalMastered += mastered.length;
    totalWrong += wrong.length;
  });
  res.json({ setCount, totalWords, totalMastered, totalWrong });
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
  // Archive wrong words before deleting the set
  const set = query('SELECT name, items, wrong FROM sets WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  if (set.length) {
    const wrongIdx = JSON.parse(set[0].wrong || '[]');
    const items = JSON.parse(set[0].items || '[]');
    wrongIdx.forEach(i => {
      if (items[i]) {
        const item = items[i];
        const archId = 'aw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        run('INSERT INTO archived_wrong (id, user_id, set_name, word, def, sentence, translation, src, englishDef, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [archId, req.userId, set[0].name, item.word || '', item.def || '', item.sentence || '', item.translation || '', item.src || '', item.englishDef || '', Date.now()]);
      }
    });
  }
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

// Physically delete/reset all progress fields for one set
app.delete('/api/sets/:id/progress', auth, (req, res) => {
  const now = Date.now();
  run('UPDATE sets SET mastered = ?, wrong = ?, pos = ?, quiz_order = ?, retry_mode = ?, retry_pos = ?, retry_order = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ['[]', '[]', 0, '[]', 0, 0, '[]', now, req.params.id, req.userId]);
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
          archived: false,
        });
      }
    });
  });
  // Include archived wrong words from deleted sets
  const archived = query('SELECT * FROM archived_wrong WHERE user_id = ?', [req.userId]);
  archived.forEach(a => {
    result.push({
      setId: a.id,
      setName: a.set_name + ' (已删除)',
      word: a.word,
      def: a.def,
      sentence: a.sentence || '',
      translation: a.translation || '',
      src: a.src || '',
      englishDef: a.englishDef || '',
      index: -1,
      archived: true,
      archId: a.id,
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

// Remove an archived wrong word
app.delete('/api/archived-wrong/:id', auth, (req, res) => {
  run('DELETE FROM archived_wrong WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// ---------- Community workshop ----------
// List all published banks (public, no auth needed)
app.get('/api/community', (req, res) => {
  const sort = req.query.sort || 'top'; // top | new | downloads
  let orderBy = 'downloads DESC, created_at DESC';
  if (sort === 'new') orderBy = 'created_at DESC';
  else if (sort === 'downloads') orderBy = 'downloads DESC';
  const rows = query(`SELECT id, user_id, author_email, title, description, tags, thumbnail, downloads, created_at, updated_at FROM community_banks ORDER BY ${orderBy}`);
  const result = rows.map(r => ({
    id: r.id,
    authorId: r.user_id,
    author: r.author_email,
    title: r.title,
    description: r.description || '',
    tags: JSON.parse(r.tags || '[]'),
    thumbnail: r.thumbnail || '',
    downloads: r.downloads || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  res.json(result);
});

// Get a single bank with full items for preview (public)
app.get('/api/community/:id', (req, res) => {
  const rows = query('SELECT * FROM community_banks WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '词集不存在' });
  const r = rows[0];
  res.json({
    id: r.id,
    authorId: r.user_id,
    author: r.author_email,
    title: r.title,
    description: r.description || '',
    tags: JSON.parse(r.tags || '[]'),
    thumbnail: r.thumbnail || '',
    items: JSON.parse(r.items || '[]'),
    downloads: r.downloads || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
});

// Publish a bank (auth required)
app.post('/api/community/publish', auth, (req, res) => {
  const { id, title, description, tags, thumbnail, items } = req.body || {};
  if (!id || !title || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: '标题和词条必填' });
  }
  const user = query('SELECT email FROM users WHERE id = ?', [req.userId])[0];
  if (!user) return res.status(401).json({ error: '用户不存在' });
  const now = Date.now();
  const tagArr = Array.isArray(tags) ? tags.slice(0, 8) : [];
  const thumb = thumbnail || '';
  // If this id already exists and belongs to this user → update
  const existing = query('SELECT id FROM community_banks WHERE id = ? AND user_id = ?', [id, req.userId]);
  if (existing.length) {
    run('UPDATE community_banks SET title = ?, description = ?, tags = ?, thumbnail = ?, items = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [title, description || '', JSON.stringify(tagArr), thumb, JSON.stringify(items), now, id, req.userId]);
  } else {
    run('INSERT INTO community_banks (id, user_id, author_email, title, description, tags, thumbnail, items, downloads, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      [id, req.userId, user.email, title, description || '', JSON.stringify(tagArr), thumb, JSON.stringify(items), now, now]);
  }
  res.json({ ok: true, id });
});

// Import a published bank into the user's own sets (auth required)
app.post('/api/community/:id/import', auth, (req, res) => {
  const rows = query('SELECT * FROM community_banks WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '词集不存在' });
  const bank = rows[0];
  const newId = 'imp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = Date.now();
  const items = JSON.parse(bank.items || '[]');
  run('INSERT INTO sets (id, user_id, name, items, mastered, wrong, pos, quiz_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [newId, req.userId, bank.title, JSON.stringify(items), '[]', '[]', 0, '[]', now, now]);
  // Increment download count
  run('UPDATE community_banks SET downloads = downloads + 1 WHERE id = ?', [req.params.id]);
  res.json({ ok: true, newId, name: bank.title });
});

// Delete own published bank (auth required)
app.delete('/api/community/:id', auth, (req, res) => {
  run('DELETE FROM community_banks WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// ---------- PDF / text parsing via Python (pdfplumber + ENTRY_RE parser) ----------
const { spawnSync } = require('child_process');
const os = require('os');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Parse text (already extracted) using the Python parser
app.post('/api/parse-text', (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: '文本不能为空' });
  const result = spawnSync('python3', [path.join(__dirname, 'parse_vocab.py'), '--stdin'], {
    input: text, encoding: 'utf-8', timeout: 30000
  });
  if (result.status !== 0) {
    return res.status(500).json({ error: '解析失败: ' + (result.stderr || '').slice(0, 200) });
  }
  try {
    const items = JSON.parse(result.stdout || '[]');
    res.json({ items });
  } catch(e) {
    res.status(500).json({ error: '解析结果无效' });
  }
});

// Parse a PDF file (multipart upload) using pdfplumber + Python parser.
// Returns { items, rawText } so the frontend can show raw text for debugging.
app.post('/api/parse-pdf', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF 文件不能为空' });
  const tmpDir = os.tmpdir();
  const tmpPdf = path.join(tmpDir, 'vocab_upload_' + Date.now() + '.pdf');
  try {
    fs.writeFileSync(tmpPdf, req.file.buffer);
    // Use --full mode to get both parsed items and raw extracted text
    const result = spawnSync('python3', [path.join(__dirname, 'parse_vocab.py'), '--full', tmpPdf], {
      encoding: 'utf-8', timeout: 60000, maxBuffer: 50 * 1024 * 1024
    });
    if (result.status !== 0) {
      return res.status(500).json({ error: 'PDF 解析失败: ' + (result.stderr || '').slice(0, 300) });
    }
    const data = JSON.parse(result.stdout || '{"items":[],"rawText":""}');
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: 'PDF 解析出错: ' + e.message });
  } finally {
    try { fs.unlinkSync(tmpPdf); } catch(e) {}
  }
});

// Serve index.html for the root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Vocab server running at http://localhost:${PORT}`));
});
