const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UPLOADS_DIR } = require('../agent/config');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const EXTS = 'skp|dwg|dxf|obj|png|jpg|jpeg|webp';
const ALLOWED_EXTENSIONS = new Set(EXTS.split('|').map(ext => `.${ext}`));
const ROOTS = '(?:/Users/|~/|/Volumes/|/tmp/)';
const QUOTED_RE = new RegExp(`['"](${ROOTS}[^'"]+\\.(?:${EXTS}))['"]`, 'gi');
const UNQUOTED_RE = new RegExp(`(${ROOTS}[^\\s'"]+\\.(?:${EXTS}))`, 'gi');

const expandHome = p => p.replace(/^~\//, `${process.env.HOME}/`);

// Pull local file paths (quoted or bare) out of a chat message; returns paths + the remaining prompt text.
function extractFilePathsFromText(text) {
  const found = [];
  let rest = text;
  for (const re of [QUOTED_RE, UNQUOTED_RE]) {
    re.lastIndex = 0;
    const source = rest;
    let m;
    while ((m = re.exec(source)) !== null) {
      const p = expandHome(m[1]);
      if (!found.includes(p)) found.push(p);
      rest = rest.replace(m[0], ' ');
    }
  }
  return { filePaths: found, cleanPrompt: rest.replace(/\s+/g, ' ').trim() };
}

function saveUploadedFile(name, dataUrl) {
  const m = /^data:[^;]+;base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('无效的文件数据');
  const ext = path.extname(name).toLowerCase() || '.png';
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error(`不支持上传 ${ext} 文件`);
  const safeBase = path.basename(name, ext).replace(/[^a-zA-Z0-9_一-龥-]/g, '_');
  const diskPath = path.join(UPLOADS_DIR, `raw_${Date.now()}${crypto.randomInt(0, 1000000).toString().padStart(6, '0')}_${safeBase}${ext}`);
  fs.writeFileSync(diskPath, Buffer.from(m[1], 'base64'));
  return diskPath;
}

// Scene lighting: explicit wording in the prompt wins over the UI default.
function resolveLighting(prompt, fallback = 'day') {
  if (/夜景|暗景|蓝调|夜晚|黄昏|傍晚/.test(prompt)) return 'night';
  if (/日景|亮景|白天|晴天|正午/.test(prompt)) return 'day';
  return fallback;
}

module.exports = { extractFilePathsFromText, saveUploadedFile, resolveLighting };
