// 认证：scrypt 加盐密码哈希 + 会话守卫中间件
const crypto = require('crypto');
const { get } = require('./db');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function findUserByLogin(username, password) {
  const user = get('SELECT * FROM users WHERE username = ?;', [username]);
  if (!user) return null;
  return verifyPassword(password, user.salt, user.password_hash) ? user : null;
}

const requireAuth = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: '请先登录' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
};

module.exports = { hashPassword, verifyPassword, findUserByLogin, requireAuth, requireAdmin };
