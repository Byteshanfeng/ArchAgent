const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadModelConfig, publicCatalog } = require('../agent/models');
const { generateImageWithModel } = require('../agent/image-api');
const execFileAsync = promisify(execFile);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');

test('environment model configuration supports multiple providers without exposing keys', () => {
  const configured = loadModelConfig({
    CHAT_MODEL_1_ID: 'brain', CHAT_MODEL_1_PROVIDER: 'openai-compatible',
    CHAT_MODEL_1_BASE_URL: 'https://example.test/v1/', CHAT_MODEL_1_MODEL: 'chat-model',
    CHAT_MODEL_1_API_KEY_ENV: 'TEST_BRAIN_KEY', TEST_BRAIN_KEY: 'private-test-key',
    IMAGE_MODEL_2_ID: 'image', IMAGE_MODEL_2_PROVIDER: 'gemini',
    IMAGE_MODEL_2_BASE_URL: 'https://example.test/v1beta', IMAGE_MODEL_2_MODEL: 'image-model',
    IMAGE_MODEL_2_API_KEY: 'image-private-key',
    IMAGE_MODEL_3_ID: 'unused', IMAGE_MODEL_3_PROVIDER: 'openai-images',
    IMAGE_MODEL_3_BASE_URL: 'https://example.test/v1', IMAGE_MODEL_3_MODEL: 'another-image'
  });
  assert.equal(configured.brains[0].apiKey, 'private-test-key');
  assert.equal(configured.brains[0].baseUrl, 'https://example.test/v1');
  assert.equal(configured.images[0].apiKey, 'image-private-key');
  assert.equal(configured.images.length, 1);
  assert.doesNotMatch(JSON.stringify(publicCatalog(configured)), /private-test-key|image-private-key|apiKey/);
});

test('configuration loads a local env file before reading settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-agent-env-'));
  try {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'PORT=4555\nARCH_AGENT_TEST_VALUE=loaded-from-file\n');
    const env = { ...process.env, ARCH_AGENT_ENV_FILE: envFile };
    delete env.PORT;
    delete env.ARCH_AGENT_TEST_VALUE;
    const { stdout } = await execFileAsync(process.execPath,
      ['-e', `const c=require('./agent/config');console.log(JSON.stringify({port:c.PORT,value:process.env.ARCH_AGENT_TEST_VALUE}))`],
      { cwd: path.join(__dirname, '..'), env, timeout: 10000 });
    assert.deepEqual(JSON.parse(stdout), { port: 4555, value: 'loaded-from-file' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('direct image adapters send the right request for generation and editing', async () => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes(':generateContent')) {
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] }));
    } else {
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-agent-images-'));
  const reference = path.join(dir, 'reference.png');
  fs.writeFileSync(reference, png);
  try {
    const openai = { id: 'openai', label: 'OpenAI', provider: 'openai-images', baseUrl, model: 'gpt-image-2', apiKey: 'test-openai-key' };
    const gemini = { id: 'gemini', label: 'Gemini', provider: 'gemini', baseUrl, model: 'gemini-3.1-flash-image', apiKey: 'test-gemini-key' };
    const generated = await generateImageWithModel(openai, 'building', null, dir);
    const edited = await generateImageWithModel(openai, 'change lighting', reference, dir);
    const geminiImage = await generateImageWithModel(gemini, 'building', reference, dir);
    assert.ok([generated, edited, geminiImage].every(result => fs.existsSync(result.diskPath)));
    assert.equal(calls[0].url, '/images/generations');
    assert.equal(calls[0].headers.authorization, 'Bearer test-openai-key');
    assert.equal(calls[1].url, '/images/edits');
    assert.match(calls[1].body.images[0].image_url, /^data:image\/png;base64,/);
    assert.equal(calls[2].url, '/models/gemini-3.1-flash-image:generateContent');
    assert.equal(calls[2].headers['x-goog-api-key'], 'test-gemini-key');
    assert.equal(calls[2].body.contents[0].parts[1].inline_data.mime_type, 'image/png');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LangGraph planner uses a configured OpenAI-compatible endpoint', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'mock-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: '本地接口验证成功' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-agent-planner-'));
  try {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, `CHAT_MODEL_1_ID=mock\nCHAT_MODEL_1_PROVIDER=openai-compatible\nCHAT_MODEL_1_BASE_URL=http://127.0.0.1:${server.address().port}/v1\nCHAT_MODEL_1_MODEL=mock-chat\nCHAT_MODEL_1_API_KEY=mock-key\n`);
    const script = `require('./agent/runtime').runArchAgentTurn({userMessage:'你好',cleanPrompt:'你好',detectedFiles:[],brainModelId:'mock'}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exitCode=1})`;
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CHAT|IMAGE)_MODEL_\d+_/.test(key)));
    const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'), env: { ...cleanEnv, ARCH_AGENT_ENV_FILE: envFile }, timeout: 10000
    });
    assert.equal(JSON.parse(stdout).replyText, '本地接口验证成功');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].authorization, 'Bearer mock-key');
    assert.ok(requests[0].body.tools.length > 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
