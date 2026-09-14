// 最小而健壮的 CSV 解析（RFC4180 风格：支持 "" 转义、字段内逗号与换行、BOM）
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // 去掉末尾全空行
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

/** 以表头为键，返回对象数组 */
function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
}

/** 生成 CSV（供模板下载） */
function toCsv(header, rows) {
  const esc = v => {
    v = String(v ?? '');
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [header.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  return '﻿' + lines.join('\n'); // BOM 方便 Excel 识别中文
}

module.exports = { parseCsv, parseCsvObjects, toCsv };
