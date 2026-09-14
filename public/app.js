// 前端逻辑：登录态、志愿者必看片/反馈、管理后台
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let ME = null, statsTimer = null;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
}
async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escAttr(s) { return esc(s); }
function rateClass(r) { return r >= 80 ? 'high' : r >= 40 ? 'mid' : 'low'; }
function stars(id, val) {
  return `<div class="stars" data-input="${id}">` + [1,2,3,4,5].map(i =>
    `<span data-v="${i}" class="${i <= val ? 'on' : ''}">★</span>`).join('') + '</div>';
}

/* ---------------- 登录 ---------------- */
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUser').value.trim(), password: $('#loginPass').value }),
    });
    enterApp(user);
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
});

function enterApp(user) {
  ME = user;
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#whoName').textContent = `${user.real_name}（${user.position}）`;
  const roleEl = $('#whoRole');
  roleEl.textContent = user.role === 'admin' ? '管理员' : '志愿者';
  roleEl.classList.toggle('admin', user.role === 'admin');
  if (user.role === 'admin') { $('#adminView').classList.remove('hidden'); initAdmin(); }
  else { $('#volView').classList.remove('hidden'); loadMyVideos(); }
}

/* ---------------- 志愿者端 ---------------- */
async function loadMyVideos() {
  const { position, total, completed, videos } = await api('/api/my/videos');
  $('#volTitle').textContent = `${ME.real_name} 的必看片 · ${position}`;
  $('#volMeta').textContent = `共 ${total} 部必看培训片，已完成 ${completed} 部${total ? '，还差 ' + (total - completed) + ' 部' : ''}`;
  const rate = total ? Math.round(completed / total * 100) : 0;
  $('#progRing').style.setProperty('--p', rate);
  $('#progText').textContent = rate + '%';

  $('#videoList').innerHTML = videos.map(v => {
    const done = v.watched === 1;
    const isCommon = v.position === '通用';
    return `<div class="card video-card ${done ? 'done' : ''}">
      <div class="thumb">${done ? '✅' : '🎬'}</div>
      <div class="video-body">
        <h3>${esc(v.title)}
          <span class="tag ${isCommon ? 'common' : 'pos'}">${esc(v.position)}</span>
          <span class="tag ${done ? 'done' : 'todo'}">${done ? '已完成' : '待观看'}</span>
        </h3>
        <div class="video-meta">
          <span>编号 ${esc(v.code)}</span><span>⏱ ${v.duration_minutes} 分钟</span>
          ${done && v.watched_at ? `<span>完成于 ${new Date(v.watched_at).toLocaleString('zh-CN')}</span>` : ''}
        </div>
        ${v.url ? `<a href="${escAttr(v.url)}" target="_blank" rel="noopener">▶ 打开视频地址观看</a>` : '<span class="muted">（管理员未配置视频地址）</span>'}
        ${v.exam_tips ? `<div class="exam-tips"><b>📝 考试提示：</b>${esc(v.exam_tips)}</div>` : ''}
        ${v.description ? `<div class="muted">${esc(v.description)}</div>` : ''}
        <div class="feedback-box">
          <div class="muted" style="margin-bottom:6px">${done ? '更新你的观看反馈：' : '看完后提交反馈并标记完成：'}</div>
          <div class="field"><label>内容评分</label>${stars('rate-' + v.id, v.rating || 5)}</div>
          <div class="field">
            <textarea id="comment-${v.id}" rows="2" placeholder="说说收获或建议（可选）">${esc(v.comment || '')}</textarea>
          </div>
          <button class="btn sm" data-feedback="${v.id}" data-watch="1">${done ? '更新反馈（仍为已完成）' : '标记已看完并提交反馈'}</button>
          ${!done ? `<button class="btn ghost sm" data-feedback="${v.id}" data-watch="0">仅保存反馈，暂未看完</button>` : ''}
          ${done ? `<div class="my-comment"><span class="t">你的反馈：</span>${esc(v.comment || '（无文字意见）')} · 评分 ${v.rating}/5</div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('') || '<div class="card muted">当前岗位暂无比看培训片，请联系管理员导入。</div>';
}

document.addEventListener('click', async e => {
  const star = e.target.closest('.stars span');
  if (star) {
    const wrap = star.parentElement;
    const v = +star.dataset.v;
    wrap.querySelectorAll('span').forEach(s => s.classList.toggle('on', +s.dataset.v <= v));
    wrap.dataset.value = v;
    return;
  }
  const fbBtn = e.target.closest('[data-feedback]');
  if (!fbBtn || !ME || ME.role !== 'volunteer') return;
  const id = fbBtn.dataset.feedback;
  const rating = +($$(`.stars[data-input="rate-${id}"] span.on`).length || 5);
  const comment = $('#comment-' + id).value;
  const watched = +fbBtn.dataset.watch;
  fbBtn.disabled = true;
  try {
    await api(`/api/my/videos/${id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ watched, rating, comment }),
    });
    toast(watched ? '已标记完成，感谢反馈！' : '反馈已保存');
    await loadMyVideos();
  } catch (err) { toast(err.message); fbBtn.disabled = false; }
});

/* ---------------- 管理员端 ---------------- */
let POSITIONS = [];
function initAdmin() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#statsPosition').addEventListener('change', e => loadStats(e.target.value));
  $('#feedbackVideo').addEventListener('change', loadFeedback);
  $('#uploadVideos').addEventListener('click', () => uploadCsv('videos'));
  $('#uploadUsers').addEventListener('click', () => uploadCsv('users'));
  refreshAll();
}
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  ['stats','videos','users','import','feedback'].forEach(n =>
    $('#tab-' + n).classList.toggle('hidden', n !== name));
  if (name === 'stats') loadStats($('#statsPosition').value);
  if (name === 'feedback') loadFeedback();
}
async function refreshAll() {
  const [{ positions }, { videos }, { users }, fb] = await Promise.all([
    api('/api/admin/positions'), api('/api/admin/videos'), api('/api/admin/users'), api('/api/admin/feedback'),
  ]);
  POSITIONS = positions.map(p => p.position);
  const sp = $('#statsPosition');
  sp.innerHTML = POSITIONS.map(p => `<option>${esc(p)}</option>`).join('');
  $('#videosTbody').innerHTML = videos.map(v => `<tr>
    <td>${esc(v.code)}</td><td>${esc(v.title)}</td><td>${esc(v.position)}</td>
    <td class="num">${v.duration_minutes}</td><td class="num">${v.feedback_count}</td>
    <td class="num"><b>${v.completed_count}</b></td>
    <td class="muted">${esc(v.exam_tips || '—')}</td></tr>`).join('');
  $('#usersTbody').innerHTML = users.map(u => `<tr>
    <td>${esc(u.username)}</td><td>${esc(u.real_name)}</td><td>${esc(u.position)}</td>
    <td>${u.role === 'admin' ? '<span class="badge-role admin">管理员</span>' : '志愿者'}</td>
    <td class="num">${u.completed_total}/${u.required_total}</td></tr>`).join('');
  $('#feedbackVideo').innerHTML = '<option value="">全部影片</option>' +
    videos.map(v => `<option value="${v.id}">${esc(v.title)}</option>`).join('');
  renderFeedback(fb.feedback);
  if (POSITIONS.length) await loadStats(sp.value || POSITIONS[0]);
}

async function loadStats(position) {
  if (!position) return;
  const s = await api('/api/admin/stats?position=' + encodeURIComponent(position));
  $('#statCards').innerHTML = `
    <div class="stat-card"><div class="v">${s.overview.volunteers}</div><div class="l">岗位志愿者</div></div>
    <div class="stat-card"><div class="v">${s.overview.required_videos}</div><div class="l">必看片数量（含通用）</div></div>
    <div class="stat-card"><div class="v">${s.overview.overall_rate}%</div><div class="l">总体完成率</div></div>
    <div class="stat-card"><div class="v">${s.overview.fully_done}</div><div class="l">全部完成人数</div></div>`;
  $('#statsVideoTable').querySelector('tbody').innerHTML = s.videos.map(v => {
    const r = v.total_volunteers ? Math.round(v.completed_count / v.total_volunteers * 100) : 0;
    return `<tr><td>${esc(v.code)}</td><td>${esc(v.title)}</td><td class="num">${v.duration_minutes}</td>
      <td class="num">${v.completed_count}/${v.total_volunteers}</td>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="bar green" style="flex:1"><i style="width:${r}%"></i></div><span class="rate-pill ${rateClass(r)}">${r}%</span></div></td></tr>`;
  }).join('');
  $('#statsUserTable').querySelector('tbody').innerHTML = s.volunteers.map(u => `<tr>
    <td>${esc(u.real_name)}</td><td>${esc(u.username)}</td>
    <td class="num">${u.completed_total}/${u.required_total}</td>
    <td><div class="bar"><i style="width:${u.rate}%"></i></div></td>
    <td class="num"><span class="rate-pill ${rateClass(u.rate)}">${u.rate}%</span></td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">该岗位暂无志愿者</td></tr>';
}

async function loadFeedback() {
  const vid = $('#feedbackVideo').value;
  const { feedback } = await api('/api/admin/feedback' + (vid ? '?video_id=' + vid : ''));
  renderFeedback(feedback);
}
function renderFeedback(list) {
  $('#feedbackTbody').innerHTML = list.map(f => `<tr>
    <td>${esc(f.video_title)}<div class="muted">${esc(f.video_code)}</div></td>
    <td>${esc(f.user_name)}</td><td>${esc(f.user_position)}</td>
    <td>${f.watched ? '<span class="tag done">已完成</span>' : '<span class="tag todo">未看完</span>'}</td>
    <td class="num">${'★'.repeat(f.rating)}<span style="color:#cbd5e1">${'★'.repeat(5 - f.rating)}</span></td>
    <td>${esc(f.comment || '—')}</td><td class="muted">${esc(f.updated_at)}</td></tr>`).join('')
    || '<tr><td colspan="7" class="muted">暂无反馈记录</td></tr>';
}

async function uploadCsv(kind) {
  const input = kind === 'videos' ? $('#videosFile') : $('#usersFile');
  const box = kind === 'videos' ? $('#videosResult') : $('#usersResult');
  if (!input.files[0]) { box.className = 'import-result err'; box.textContent = '请先选择 CSV 文件'; return; }
  const fd = new FormData();
  fd.append('file', input.files[0]);
  box.className = 'import-result'; box.textContent = '导入中…';
  try {
    const res = await fetch(`/api/admin/import/${kind}`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const errs = (data.errors || []).map(e => `<li>第 ${e.line} 行：${esc(e.msg)}</li>`).join('');
    box.className = 'import-result ' + (data.errors.length ? 'err' : 'ok');
    box.innerHTML = `导入完成：新增 <b>${data.inserted}</b> 条，更新 <b>${data.updated}</b> 条，共 ${data.total} 行。`
      + (errs ? `<ul>${errs}</ul>` : '');
    input.value = '';
    await refreshAll();
  } catch (err) {
    box.className = 'import-result err';
    box.textContent = '导入失败：' + err.message;
  }
}

/* ---------------- 启动：恢复会话 ---------------- */
(async () => {
  try {
    const { user } = await api('/api/auth/me');
    if (user) enterApp(user);
  } catch { /* 未登录 */ }
})();
