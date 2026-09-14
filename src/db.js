// 数据库层：sql.js (WASM SQLite) —— 真正的 SQL 关系数据库，定期导出持久化到文件
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_DIR = process.env.VLIB_DATA_DIR
  ? path.resolve(process.env.VLIB_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = process.env.VLIB_DB_FILE || path.join(DB_DIR, 'library.db');
const WASM_FILE = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let db = null;
let saveTimer = null;

/** 将内存数据库刷盘（写入合并、防抖） */
function persist(immediate = false) {
  if (!db) return;
  const doSave = () => {
    const data = db.export();
    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, Buffer.from(data));
  };
  if (immediate) {
    clearTimeout(saveTimer);
    doSave();
  } else {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 50);
  }
}

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs({ locateFile: () => WASM_FILE });
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON;');
  migrate();
  seed();
  persist(true);
  return db;
}

function migrate() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      real_name TEXT NOT NULL,
      position TEXT NOT NULL,                 -- 服务岗位：导览/签到/急救/后勤 等
      role TEXT NOT NULL DEFAULT 'volunteer' CHECK (role IN ('admin','volunteer')),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,             -- 影片编号（CSV 去重/更新依据）
      title TEXT NOT NULL,                   -- 片名
      position TEXT NOT NULL,                -- 适用岗位，通用培训用 “通用”
      url TEXT NOT NULL DEFAULT '',          -- 视频地址
      duration_minutes INTEGER NOT NULL DEFAULT 0,  -- 时长（分钟）
      exam_tips TEXT NOT NULL DEFAULT '',    -- 考试提示
      description TEXT NOT NULL DEFAULT '',  -- 简介
      active INTEGER NOT NULL DEFAULT 1,     -- 1 必看在列, 0 已下架
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      watched INTEGER NOT NULL DEFAULT 0,    -- 是否观看完成 0/1
      watched_at TEXT,                       -- 观看完成时间
      rating INTEGER NOT NULL DEFAULT 5 CHECK (rating BETWEEN 1 AND 5),  -- 满意度
      comment TEXT NOT NULL DEFAULT '',      -- 反馈意见
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (user_id, video_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_videos_position ON videos(position);
    CREATE INDEX IF NOT EXISTS idx_feedback_video ON feedback(video_id);
  `);
}

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  hash: crypto.scryptSync(String(password), salt, 64).toString('hex'),
});

/** 首次运行写入示例数据（默认管理员 + 4 个岗位的志愿者） */
function seed() {
  const cnt = db.exec('SELECT COUNT(*) AS c FROM users;')[0].values[0][0];
  if (cnt === 0) {
    const seeds = [
      ['admin', 'admin123', '系统管理员', '管理', 'admin'],
      ['zhangwei', 'vol123', '张伟', '导览服务', 'volunteer'],
      ['lina', 'vol123', '李娜', '签到引导', 'volunteer'],
      ['wangfang', 'vol123', '王芳', '应急救护', 'volunteer'],
      ['liuyang', 'vol123', '刘洋', '后勤保障', 'volunteer'],
    ];
    const stmt = db.prepare(
      'INSERT INTO users (username, password_hash, salt, real_name, position, role) VALUES (?,?,?,?,?,?)'
    );
    for (const [u, p, name, pos, role] of seeds) {
      const { hash, salt } = hashPassword(p);
      stmt.run([u, hash, salt, name, pos, role]);
    }
    stmt.free();
    console.log('[seed] 已创建初始账号：admin/admin123 及 4 名示例志愿者（密码 vol123）');
  }
  seedVideosFromSample();
}

/** 首次启动导入样例影片（来自 samples/videos.csv，正式使用时可在后台覆盖） */
function seedVideosFromSample() {
  const countRow = db.exec('SELECT COUNT(*) AS c FROM videos;');
  const c = countRow.length ? countRow[0].values[0][0] : 0;
  if (c > 0) return;
  try {
    const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'videos.csv'), 'utf8');
    const { parseCsvObjects } = require('./csv');
    const rows = parseCsvObjects(sample);
    const pickField = (o, ...ks) => { for (const k of ks) if (o[k] !== undefined && o[k] !== '') return o[k]; return ''; };
    const stmt = db.prepare(
      `INSERT INTO videos (code, title, position, url, duration_minutes, exam_tips, description)
       VALUES (?,?,?,?,?,?,?);`
    );
    for (const r of rows) {
      stmt.run([
        pickField(r, '编号', 'code'), pickField(r, '片名', 'title'), pickField(r, '适用岗位', 'position'),
        pickField(r, '视频地址', 'url'),
        parseInt(pickField(r, '时长分钟', '时长', 'duration_minutes'), 10) || 0,
        pickField(r, '考试提示', 'exam_tips'), pickField(r, '简介', 'description'),
      ]);
    }
    stmt.free();
    console.log(`[seed] 已导入 ${rows.length} 部样例培训影片（samples/videos.csv）`);
  } catch (e) {
    console.warn('[seed] 样例影片导入跳过：', e.message);
  }
}

/** 查询：返回对象数组 */
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function get(sql, params = []) {
  return all(sql, params)[0] || null;
}
/** 写操作（INSERT/UPDATE/DELETE），自动刷盘，返回 lastInsertRowid */
function run(sql, params = []) {
  db.run(sql, params);
  persist();
  return { lastInsertRowid: db.exec('SELECT last_insert_rowid() AS id;')[0].values[0][0] };
}

module.exports = { getDb, all, get, run, persist };
