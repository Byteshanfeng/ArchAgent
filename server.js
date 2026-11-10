const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./agent/config');
const { publicCatalog, selectModel } = require('./agent/models');
const { runArchAgentTurn } = require('./agent/runtime');
const { describeTools } = require('./agent/tool-specs');
const store = require('./server/store');
const { extractFilePathsFromText, saveUploadedFile, resolveLighting } = require('./server/files');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.dwg': 'application/acad',
  '.dxf': 'application/dxf',
  '.obj': 'model/obj'
};

const MAX_BODY_BYTES = 80 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let exceeded = false;
    req.on('data', chunk => {
      if (exceeded) return;
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        exceeded = true;
        data = '';
        const error = new Error('上传内容超过 80 MB 限制');
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on('end', () => {
      if (exceeded) return;
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(pathname, res) {
  const filePath = path.normalize(path.join(cfg.PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (filePath !== cfg.PUBLIC_DIR && !filePath.startsWith(cfg.PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    return fs.createReadStream(filePath).pipe(res);
  }
  res.writeHead(404);
  res.end('Not Found');
}

const chatQueues = new Map();

function queueChat(threadId, body, res) {
  const previous = chatQueues.get(threadId) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => handleChat(body, res));
  chatQueues.set(threadId, task);
  task.finally(() => {
    if (chatQueues.get(threadId) === task) chatQueues.delete(threadId);
  }).catch(() => {});
  return task;
}

async function handleChat(body, res) {
  const {
    threadId = '',
    message = '',
    model = '',
    brainModel = '',
    sceneLighting = 'day',
    uploadedFiles = [],
    targetImageUrl = ''
  } = body;

  if (!String(message).trim() && uploadedFiles.length === 0) {
    return sendJson(res, 400, { error: '消息不能为空' });
  }
  selectModel('brains', brainModel);
  if (model) selectModel('images', model);

  const { filePaths, cleanPrompt } = extractFilePathsFromText(message);
  for (const uf of uploadedFiles) filePaths.push(saveUploadedFile(uf.name, uf.dataUrl));

  const detectedFiles = filePaths.map(fp => ({
    name: path.basename(fp).replace(/^raw_\d+_/, ''),
    path: fp,
    ext: path.extname(fp).toLowerCase()
  }));
  const lighting = resolveLighting(cleanPrompt, sceneLighting);

  const snapshot = store.loadStore();
  const thread = snapshot.threads.find(t => t.id === threadId);
  if (!thread) throw new Error('会话不存在或已删除');
  const messages = thread.messages || [];

  const history = store.buildHistory(messages);
  const lastAssistantImageUrl = store.findLastImage(messages);

  const userMsg = {
    id: `msg-u-${Date.now()}`,
    role: 'user',
    text: message,
    sceneLighting: lighting,
    detectedFiles,
    createdAt: store.nowHHMM(),
    createdAtIso: store.nowIso()
  };

  const outcome = await runArchAgentTurn({
    threadId: thread.id,
    brainModelId: brainModel,
    userMessage: message,
    cleanPrompt,
    detectedFiles,
    targetImageUrl,
    lastAssistantImageUrl,
    imageModel: model,
    defaultLighting: lighting,
    customSystemPrompt: store.loadSettings().systemPrompt,
    history
  });

  const assistantMsg = {
    id: `msg-a-${Date.now()}`,
    role: 'assistant',
    text: outcome.replyText,
    toolTraces: outcome.toolTraces,
    steps: outcome.steps,
    results: outcome.results,
    createdAt: store.nowHHMM(),
    createdAtIso: store.nowIso()
  };
  // Reload before committing: other threads and thread controls may have changed while the model ran.
  const data = store.loadStore();
  const currentThread = data.threads.find(t => t.id === threadId);
  if (!currentThread) throw new Error('会话在生成期间被删除，结果未写入历史');
  if ((currentThread.messages || []).length === 0) {
    if (detectedFiles.length > 0) currentThread.title = `${detectedFiles[0].name} ${cleanPrompt.slice(0, 10) || '工程加工'}`.trim();
    else if (cleanPrompt) currentThread.title = cleanPrompt.slice(0, 16);
  }
  currentThread.updatedAt = store.nowHHMM();
  currentThread.updatedAtIso = assistantMsg.createdAtIso;
  currentThread.messages.push(userMsg, assistantMsg);
  store.saveStore(data);

  return sendJson(res, 200, { ok: true, userMsg, assistantMsg, ...store.formatStatePayload(data) });
}

async function route(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const { method } = req;

  if (pathname === '/api/agent/tools' && method === 'GET') {
    return sendJson(res, 200, {
      brainModel: publicCatalog().brains[0]?.model || null,
      nodes: ['intake_node', 'planner_node', 'tool_executor_node', 'synthesizer_node'],
      tools: describeTools()
    });
  }

  if (pathname === '/api/models' && method === 'GET') return sendJson(res, 200, publicCatalog());

  if (pathname === '/api/settings' && method === 'GET') return sendJson(res, 200, store.loadSettings());
  if (pathname === '/api/settings' && method === 'POST') {
    return sendJson(res, 200, store.saveSettings(await readJsonBody(req)));
  }

  if (pathname === '/api/chat' && method === 'GET') return sendJson(res, 200, store.formatStatePayload(store.loadStore()));
  if (pathname === '/api/chat' && method === 'POST') {
    const body = await readJsonBody(req);
    const threadId = body.threadId || store.loadStore().activeThreadId;
    return queueChat(threadId, { ...body, threadId }, res);
  }

  if (pathname === '/api/threads/new' && method === 'POST') {
    const data = store.loadStore();
    const t = store.newThread();
    data.threads.unshift(t);
    data.activeThreadId = t.id;
    store.saveStore(data);
    return sendJson(res, 200, store.formatStatePayload(data));
  }

  if (pathname === '/api/threads/select' && method === 'POST') {
    const { threadId } = await readJsonBody(req);
    const data = store.loadStore();
    if (data.threads.some(t => t.id === threadId)) {
      data.activeThreadId = threadId;
      store.saveStore(data);
    }
    return sendJson(res, 200, store.formatStatePayload(data));
  }

  if (pathname === '/api/threads/delete' && method === 'POST') {
    const { threadId } = await readJsonBody(req);
    const data = store.loadStore();
    data.threads = data.threads.filter(t => t.id !== threadId);
    if (data.threads.length === 0) data.threads.push(store.newThread());
    if (!data.threads.some(t => t.id === data.activeThreadId)) data.activeThreadId = data.threads[0].id;
    store.saveStore(data);
    return sendJson(res, 200, store.formatStatePayload(data));
  }

  if (method === 'GET') return serveStatic(pathname, res);
  res.writeHead(404);
  res.end('Not Found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => {
    console.error(`[${req.method} ${req.url}]`, err);
    if (!res.headersSent) sendJson(res, err.statusCode || 500, { error: err.message });
    else res.end();
  });
});

server.listen(cfg.PORT, cfg.HOST, () => {
  console.log(`筑境 ArchAgent 已启动: http://${cfg.HOST}:${cfg.PORT}`);
});
