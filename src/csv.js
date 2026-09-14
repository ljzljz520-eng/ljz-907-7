// 最小而健壮的 CSV 解析（RFC4180 风格：支持 "" 转义、字段内逗号与换行、BOM）
// 严格模式：引号未闭合、引号位置非法、数据行列数与表头不一致，都会抛出带行号的错误，
// 绝不让格式错误的文件被静默当作有效数据。
function parseCsvRecords(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;    // 当前字段已有内容后再出现引号 → 非法
  let justClosedQuote = false; // 闭合引号后只允许跟 , 或换行
  let line = 1;                // 当前物理行（引号内换行也计数）
  let rowLine = 1;             // 当前记录的起始行号（用于报错）

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; justClosedQuote = true; }
      } else {
        field += ch;
        if (ch === '\n') line++;
      }
    } else if (ch === '"') {
      if (fieldStarted) throw new Error(`第 ${rowLine} 行：字段中间出现非法引号，引号字段必须用双引号整体包裹`);
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      if (justClosedQuote) justClosedQuote = false;
      row.push(field); field = ''; fieldStarted = false;
    } else if (ch === '\n') {
      row.push(field); rows.push({ cells: row, line: rowLine });
      row = []; field = ''; fieldStarted = false; justClosedQuote = false;
      line++; rowLine = line;
    } else {
      if (justClosedQuote) throw new Error(`第 ${rowLine} 行：闭合引号后存在非法字符`);
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new Error(`第 ${rowLine} 行：引号未闭合，文件可能被截断`);
  if (field !== '' || row.length) { row.push(field); rows.push({ cells: row, line: rowLine }); }
  // 容忍空白行（如文件末尾空行），但不容忍其他格式错误
  return rows.filter(r => !(r.cells.length === 1 && r.cells[0].trim() === ''));
}

function parseCsv(text) {
  return parseCsvRecords(text).map(r => r.cells);
}

/** 以表头为键，返回对象数组；数据行列数必须与表头一致，否则抛错 */
function parseCsvObjects(text) {
  const rows = parseCsvRecords(text);
  if (!rows.length) return [];
  const header = rows[0].cells.map(h => h.trim());
  return rows.slice(1).map(({ cells, line }) => {
    if (cells.length !== header.length) {
      throw new Error(`第 ${line} 行：列数 ${cells.length} 与表头列数 ${header.length} 不一致`);
    }
    const obj = {};
    header.forEach((h, i) => { obj[h] = cells[i].trim(); });
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
