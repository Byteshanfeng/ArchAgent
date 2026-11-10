const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UPLOADS_DIR } = require('./config');
const { selectModel } = require('./models');

function imageMime(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
}

async function postJson(url, key, body, keyHeader = 'Authorization') {
  const headers = { 'Content-Type': 'application/json' };
  headers[keyHeader] = keyHeader === 'Authorization' ? `Bearer ${key}` : key;
  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180000)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(json.error?.message || json.message || response.statusText)
      .replaceAll(key, '<redacted>').slice(0, 300);
    throw new Error(`生图接口返回 ${response.status}: ${detail}`);
  }
  return json;
}

function imageExtension(bytes, mime = '') {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return '.jpg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return '.webp';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  throw new Error('模型返回了无法识别的图片格式');
}

async function generateImageWithModel(model, prompt, referenceDiskPath, outputDir = UPLOADS_DIR) {
  let bytes;
  let mime = '';
  if (model.provider === 'openai-images') {
    const editing = Boolean(referenceDiskPath);
    const body = { model: model.model, prompt };
    if (editing) {
      const input = fs.readFileSync(referenceDiskPath);
      body.images = [{ image_url: `data:${imageMime(referenceDiskPath)};base64,${input.toString('base64')}` }];
    }
    const result = await postJson(`${model.baseUrl}/images/${editing ? 'edits' : 'generations'}`, model.apiKey, body);
    const first = result.data?.[0];
    if (first?.b64_json) bytes = Buffer.from(first.b64_json, 'base64');
    else if (first?.url) {
      const response = await fetch(first.url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`图片下载失败: ${response.status}`);
      mime = response.headers.get('content-type')?.split(';')[0] || '';
      bytes = Buffer.from(await response.arrayBuffer());
    }
  } else if (model.provider === 'gemini') {
    const parts = [{ text: prompt }];
    if (referenceDiskPath) {
      parts.push({ inline_data: { mime_type: imageMime(referenceDiskPath), data: fs.readFileSync(referenceDiskPath).toString('base64') } });
    }
    const result = await postJson(
      `${model.baseUrl}/models/${encodeURIComponent(model.model.replace(/^models\//, ''))}:generateContent`,
      model.apiKey,
      { contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } },
      'x-goog-api-key'
    );
    const imagePart = result.candidates?.flatMap(item => item.content?.parts || [])
      .find(part => part.inlineData?.data || part.inline_data?.data);
    const inline = imagePart?.inlineData || imagePart?.inline_data;
    if (inline?.data) {
      bytes = Buffer.from(inline.data, 'base64');
      mime = inline.mimeType || inline.mime_type || '';
    }
  } else {
    throw new Error(`不支持的生图接口类型: ${model.provider}`);
  }
  if (!bytes || bytes.length < 16 || bytes.length > 50 * 1024 * 1024) throw new Error('模型未返回有效图片');
  const ext = imageExtension(bytes, mime);
  fs.mkdirSync(outputDir, { recursive: true });
  const filename = `gen_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const diskPath = path.join(outputDir, filename);
  fs.writeFileSync(diskPath, bytes);
  return { diskPath, publicUrl: `/uploads/${filename}`, modelUsed: model.model, modelLabel: model.label };
}

async function generateImage({ modelId, prompt, referenceDiskPath }) {
  return generateImageWithModel(selectModel('images', modelId), prompt, referenceDiskPath);
}

module.exports = { generateImage, generateImageWithModel };
