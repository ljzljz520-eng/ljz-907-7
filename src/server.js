// 志愿者培训片库 —— Express 服务入口
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const { getDb, all, get, run, persist, DATA_DIR } = require('./db');
const { hashPassword, findUserByLogin, requireAuth, requireAdmin } = require('./auth');
const { parseCsvObjects, toCsv } = require('./csv');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- 会话密钥（持久化到数据目录，与数据库同处一地，重启不掉登录） ----
const dataDir = DATA_DIR;
fs.mkdirSync(dataDir, { recursive: true });
const secretFile = path.join(dataDir, '.session-secret');
let SECRET = '';
if (fs.existsSync(secretFile)) {
  SECRET = fs.readFileSync(secretFile, 'utf8').trim();
}
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
}

app.use(session({
  name: 'vlib.sid',
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
}));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/samples', express.static(path.join(__dirname, '..', 'samples')));

const COMMON = '通用';
const pick = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== '') return o[k]; return ''; };
const normPos = p => String(p || '').trim();

/* ============================ 认证 ============================ */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  const user = findUserByLogin(String(username).trim(), String(password));
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  req.session.user = { id: user.id, username: user.username, role: user.role, real_name: user.real_name, position: user.position };
  res.json({ user: req.session.user });
});
app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/auth/me', (req, res) => res.json({ user: req.session.user || null }));

/* ======================== 志愿者端 API ======================= */
// 当前用户的必看片（岗位匹配 + 通用培训），附本人完成/反馈状态
app.get('/api/my/videos', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const videos = all(`
    SELECT v.id, v.code, v.title, v.position, v.url, v.duration_minutes,
           v.exam_tips, v.description,
           f.watched, f.watched_at, f.rating, f.comment, f.updated_at AS feedback_at
    FROM videos v
    LEFT JOIN feedback f ON f.video_id = v.id AND f.user_id = ?
    WHERE v.active = 1 AND (v.position = ? OR v.position = ?)
    ORDER BY (v.position = ?) DESC, v.id;
  `, [uid, COMMON, req.session.user.position, COMMON]);
  const total = videos.length;
  const completed = videos.filter(v => v.watched === 1).length;
  res.json({ position: req.session.user.position, total, completed, videos });
});

app.get('/api/my/videos/:id', requireAuth, (req, res) => {
  const v = get(`
    SELECT v.*, f.watched, f.watched_at, f.rating, f.comment
    FROM videos v LEFT JOIN feedback f ON f.video_id = v.id AND f.user_id = ?
    WHERE v.id = ? AND v.active = 1 AND (v.position = ? OR v.position = ?);
  `, [req.session.user.id, req.params.id, COMMON, req.session.user.position]);
  if (!v) return res.status(404).json({ error: '影片不存在或不在你的必看清单中' });
  res.json({ video: v });
});

// 提交/更新观看反馈（每人每片唯一；完成状态不可逆）
app.post('/api/my/videos/:id/feedback', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const vid = Number(req.params.id);
  const v = get('SELECT id FROM videos WHERE id=? AND active=1 AND (position=? OR position=?);',
    [vid, COMMON, req.session.user.position]);
  if (!v) return res.status(404).json({ error: '影片不存在或不在你的必看清单中' });

  let { watched, rating, comment } = req.body || {};
  watched = watched === true || watched === 1 || watched === '1' ? 1 : 0;
  rating = Math.max(1, Math.min(5, parseInt(rating, 10) || 5));
  comment = String(comment || '').slice(0, 1000);

  const old = get('SELECT * FROM feedback WHERE user_id=? AND video_id=?;', [uid, vid]);
  if (old) {
    const nowWatched = Math.max(old.watched, watched); // 一旦完成不可撤销
    const watchedAt = old.watched_at || (nowWatched ? new Date().toISOString() : null);
    run(`UPDATE feedback SET watched=?, watched_at=?, rating=?, comment=?,
         updated_at=datetime('now','localtime') WHERE id=?;`,
      [nowWatched, watchedAt, rating, comment, old.id]);
  } else {
    run(`INSERT INTO feedback (user_id, video_id, watched, watched_at, rating, comment)
         VALUES (?,?,?,?,?,?);`,
      [uid, vid, watched, watched ? new Date().toISOString() : null, rating, comment]);
  }
  persist(true);
  res.json({ ok: true, watched: Math.max(old ? old.watched : 0, watched) });
});

/* ======================== 管理员：CSV 导入 ======================= */
const VIDEO_HEADERS = {
  code: ['code', '编号', '影片编号'], title: ['title', '片名', '名称'],
  position: ['position', '适用岗位', '岗位'], url: ['url', '视频地址', '地址', '链接'],
  duration_minutes: ['duration_minutes', '时长分钟', '时长', '时长(分钟)'],
  exam_tips: ['exam_tips', '考试提示', '考核提示'], description: ['description', '简介', '说明'],
};
const USER_HEADERS = {
  username: ['username', '用户名', '账号'], password: ['password', '密码'],
  real_name: ['real_name', '姓名', '名字'], position: ['position', '岗位', '服务岗位'],
  role: ['role', '角色'],
};
function normalizeRow(raw, headerMap) {
  const out = {};
  for (const [field, aliases] of Object.entries(headerMap)) out[field] = pick(raw, ...aliases);
  return out;
}

// 角色只认白名单精确值：admin/管理员 → admin；volunteer/志愿者/留空 → volunteer；
// 其余任何值（如 notadmin、administrator）一律拒绝，绝不猜测提权。
function parseRole(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'admin' || v === '管理员') return 'admin';
  if (v === '' || v === 'volunteer' || v === '志愿者') return 'volunteer';
  return null;
}

app.post('/api/admin/import/videos', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  let rows;
  try { rows = parseCsvObjects(req.file.buffer.toString('utf8')); }
  catch (e) { return res.status(400).json({ error: `CSV 解析失败：${e.message}` }); }
  if (!rows.length) return res.status(400).json({ error: 'CSV 没有数据行' });

  let inserted = 0, updated = 0;
  const errors = [];
  rows.forEach((raw, i) => {
    const lineNo = i + 2;
    const r = normalizeRow(raw, VIDEO_HEADERS);
    if (!r.code || !r.title || !r.position) {
      errors.push({ line: lineNo, msg: '编号、片名、适用岗位为必填项' }); return;
    }
    const dur = Math.max(0, parseInt(r.duration_minutes, 10) || 0);
    const existing = get('SELECT id FROM videos WHERE code=?;', [r.code]);
    if (existing) {
      run(`UPDATE videos SET title=?, position=?, url=?, duration_minutes=?, exam_tips=?, description=?
           WHERE code=?;`,
        [r.title, normPos(r.position), r.url, dur, r.exam_tips, r.description, r.code]);
      updated++;
    } else {
      run(`INSERT INTO videos (code, title, position, url, duration_minutes, exam_tips, description)
           VALUES (?,?,?,?,?,?,?);`,
        [r.code, r.title, normPos(r.position), r.url, dur, r.exam_tips, r.description]);
      inserted++;
    }
  });
  persist(true);
  res.json({ inserted, updated, errors, total: rows.length });
});

app.post('/api/admin/import/users', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  let rows;
  try { rows = parseCsvObjects(req.file.buffer.toString('utf8')); }
  catch (e) { return res.status(400).json({ error: `CSV 解析失败：${e.message}` }); }
  if (!rows.length) return res.status(400).json({ error: 'CSV 没有数据行' });

  let inserted = 0, updated = 0;
  const errors = [];
  rows.forEach((raw, i) => {
    const lineNo = i + 2;
    const r = normalizeRow(raw, USER_HEADERS);
    if (!r.username || !r.real_name || !r.position) {
      errors.push({ line: lineNo, msg: '用户名、姓名、岗位为必填项' }); return;
    }
    const role = parseRole(r.role);
    if (role === null) {
      errors.push({ line: lineNo, msg: `角色值「${r.role}」无效，仅支持 admin/volunteer/管理员/志愿者` }); return;
    }
    const existing = get('SELECT id FROM users WHERE username=?;', [r.username]);
    if (existing) {
      run('UPDATE users SET real_name=?, position=?, role=? WHERE username=?;',
        [r.real_name, normPos(r.position), role, r.username]);
      if (r.password) {
        const { hash, salt } = hashPassword(r.password);
        run('UPDATE users SET password_hash=?, salt=? WHERE username=?;', [hash, salt, r.username]);
      }
      updated++;
    } else {
      if (!r.password) { errors.push({ line: lineNo, msg: `新用户 ${r.username} 缺少初始密码` }); return; }
      const { hash, salt } = hashPassword(r.password);
      run('INSERT INTO users (username, password_hash, salt, real_name, position, role) VALUES (?,?,?,?,?,?);',
        [r.username, hash, salt, r.real_name, normPos(r.position), role]);
      inserted++;
    }
  });
  persist(true);
  res.json({ inserted, updated, errors, total: rows.length });
});

/* ======================== 管理员：查询与统计 ======================= */
app.get('/api/admin/videos', requireAdmin, (req, res) => {
  const videos = all(`
    SELECT v.*,
      (SELECT COUNT(*) FROM feedback f WHERE f.video_id=v.id AND f.watched=1) AS completed_count,
      (SELECT COUNT(*) FROM feedback f WHERE f.video_id=v.id) AS feedback_count
    FROM videos v ORDER BY v.position, v.id;
  `);
  res.json({ videos });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = all(`
    SELECT u.id, u.username, u.real_name, u.position, u.role, u.created_at,
      (SELECT COUNT(*) FROM videos v WHERE v.active=1 AND (v.position=u.position OR v.position=?)) AS required_total,
      (SELECT COUNT(*) FROM feedback f JOIN videos v ON v.id=f.video_id
        WHERE f.user_id=u.id AND f.watched=1 AND (v.position=u.position OR v.position=?)) AS completed_total
    FROM users u ORDER BY u.role DESC, u.position, u.id;
  `, [COMMON, COMMON]);
  res.json({ users });
});

app.get('/api/admin/positions', requireAdmin, (req, res) => {
  const pos = all(`
    SELECT position, COUNT(*) AS volunteer_count FROM users
    WHERE role='volunteer' GROUP BY position
    UNION
    SELECT position, 0 FROM videos WHERE position <> ? AND active=1
    GROUP BY position;`, [COMMON]);
  // 合并去重
  const merged = {};
  pos.forEach(p => { merged[p.position] = Math.max(merged[p.position] || 0, p.volunteer_count); });
  res.json({ positions: Object.entries(merged).map(([position, volunteer_count]) => ({ position, volunteer_count })) });
});

// 按岗位统计：每位志愿者的完成进度 + 每部必看片完成人数
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const position = normPos(req.query.position);
  if (!position) return res.status(400).json({ error: '缺少 position 参数' });

  const volunteers = all(`
    SELECT id, username, real_name FROM users WHERE role='volunteer' AND position=? ORDER BY id;
  `, [position]);
  const required = all(`
    SELECT id, code, title, duration_minutes FROM videos
    WHERE active=1 AND (position=? OR position=?) ORDER BY (position=?) DESC, id;
  `, [COMMON, position, COMMON]);

  const videoStats = required.map(v => {
    const row = get(`SELECT COUNT(*) AS cnt FROM feedback f
      JOIN users u ON u.id=f.user_id WHERE f.video_id=? AND f.watched=1 AND u.position=?;`,
      [v.id, position]);
    return { ...v, completed_count: row.cnt, total_volunteers: volunteers.length };
  });

  const volunteerStats = volunteers.map(u => {
    const done = get(`SELECT COUNT(*) AS cnt FROM feedback f JOIN videos v ON v.id=f.video_id
      WHERE f.user_id=? AND f.watched=1 AND v.active=1 AND (v.position=? OR v.position=?);`,
      [u.id, COMMON, position]).cnt;
    return { ...u, required_total: required.length, completed_total: done,
             rate: required.length ? Math.round(done / required.length * 100) : 0 };
  });

  const sumDone = volunteerStats.reduce((s, x) => s + x.completed_total, 0);
  const sumReq = volunteerStats.reduce((s, x) => s + x.required_total, 0);
  res.json({
    position,
    overview: {
      volunteers: volunteers.length,
      required_videos: required.length,
      overall_rate: sumReq ? Math.round(sumDone / sumReq * 100) : 0,
      fully_done: volunteerStats.filter(v => v.required_total > 0 && v.completed_total === v.required_total).length,
    },
    videos: videoStats,
    volunteers: volunteerStats,
  });
});

// 反馈明细（可按影片过滤）
app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  const { video_id } = req.query;
  const rows = all(`
    SELECT f.id, f.watched, f.watched_at, f.rating, f.comment, f.created_at, f.updated_at,
           u.real_name AS user_name, u.position AS user_position, u.username,
           v.title AS video_title, v.code AS video_code
    FROM feedback f
    JOIN users u ON u.id=f.user_id
    JOIN videos v ON v.id=f.video_id
    ${video_id ? 'WHERE f.video_id=?' : ''}
    ORDER BY f.updated_at DESC;`, video_id ? [video_id] : []);
  res.json({ feedback: rows });
});

// CSV 模板下载
app.get('/api/admin/template/:kind', requireAdmin, (req, res) => {
  if (req.params.kind === 'videos') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="videos-template.csv"');
    res.send(toCsv(['编号', '片名', '适用岗位', '视频地址', '时长分钟', '考试提示', '简介'], [
      ['V001', '志愿者通用礼仪', '通用', 'https://example.com/v001.mp4', '12',
       '考点：三点微笑服务标准、服务忌语 5 句', '面向全体志愿者的服务礼仪基础培训'],
      ['V002', '展厅导览讲解技巧', '导览服务', 'https://example.com/v002.mp4', '20',
       '考点：讲解动线、停顿互动节奏、常见提问应答', ''],
    ]));
  } else if (req.params.kind === 'users') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users-template.csv"');
    res.send(toCsv(['用户名', '密码', '姓名', '岗位', '角色'], [
      ['zhangwei', 'vol123', '张伟', '导览服务', 'volunteer'],
      ['lina', 'vol123', '李娜', '签到引导', 'volunteer'],
    ]));
  } else res.status(404).end();
});

// 前端单页入口
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

(async () => {
  await getDb();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`志愿者培训片库已启动: http://localhost:${PORT}`));
})().catch(err => { console.error(err); process.exit(1); });
