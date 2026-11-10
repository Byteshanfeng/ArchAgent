const fs = require('fs');
const path = require('path');
const { DATA_DIR, ROOT_DIR, HISTORY_TURNS, MAX_SYSTEM_PROMPT_CHARS } = require('../agent/config');

const THREADS_FILE = path.join(DATA_DIR, 'chat_threads.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'agent_settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const nowHHMM = () => new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
const nowIso = () => new Date().toISOString();

function timestampFromId(id, prefix) {
  const match = new RegExp(`^${prefix}-(\\d{13})$`).exec(String(id || ''));
  const timestamp = match ? Number(match[1]) : NaN;
  return timestamp >= Date.UTC(2020, 0, 1) && timestamp < Date.UTC(2100, 0, 1) ? timestamp : 0;
}

function messageTime(message) {
  const saved = Date.parse(message.createdAtIso || '');
  return Number.isFinite(saved) ? saved : timestampFromId(message.id, 'msg-[ua]');
}

function threadTime(thread) {
  const saved = Date.parse(thread.updatedAtIso || '');
  if (Number.isFinite(saved)) return saved;
  return (thread.messages || []).reduce(
    (latest, message) => Math.max(latest, messageTime(message)),
    timestampFromId(thread.id, 'thread')
  );
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error(`Failed to read ${path.basename(file)}:`, e.message);
  }
  return fallback;
}

// Atomic write: avoid truncated JSON if the process dies mid-write.
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---- Settings (user-defined system prompt) --------------------------------
function loadSettings() {
  return { systemPrompt: '', ...readJson(SETTINGS_FILE, {}) };
}

function saveSettings(input) {
  const settings = { systemPrompt: String(input.systemPrompt || '').slice(0, MAX_SYSTEM_PROMPT_CHARS) };
  writeJson(SETTINGS_FILE, settings);
  return settings;
}

// ---- Threads ----------------------------------------------------------------
function newThread() {
  const createdAtIso = nowIso();
  return { id: `thread-${Date.now()}`, title: '新建筑设计会话', createdAtIso, updatedAtIso: createdAtIso, updatedAt: nowHHMM(), messages: [] };
}

function getInitialStore() {
  const thread = newThread();
  return {
    activeThreadId: thread.id,
    threads: [thread]
  };
}

function loadStore() {
  const parsed = readJson(THREADS_FILE, null);
  if (parsed && Array.isArray(parsed.threads) && parsed.threads.length > 0) return parsed;
  const init = getInitialStore();
  writeJson(THREADS_FILE, init);
  return init;
}

const saveStore = store => writeJson(THREADS_FILE, store);

function formatStatePayload(store) {
  const active = store.threads.find(t => t.id === store.activeThreadId) || store.threads[0];
  store.activeThreadId = active.id;
  const sortedThreads = [...store.threads].sort((a, b) => threadTime(b) - threadTime(a));
  return {
    activeThreadId: active.id,
    activeThreadTitle: active.title,
    threads: sortedThreads.map(t => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      updatedAtIso: threadTime(t) ? new Date(threadTime(t)).toISOString() : null,
      messageCount: (t.messages || []).length
    })),
    messages: (active.messages || []).map(message => ({
      ...message,
      createdAtIso: messageTime(message) ? new Date(messageTime(message)).toISOString() : null
    }))
  };
}

// Condense a thread's recent messages into role/content turns (with uploaded & produced file paths) for multi-turn memory.
function buildHistory(messages) {
  return messages.slice(-HISTORY_TURNS).map(m => {
    if (m.role === 'user') {
      const files = (m.detectedFiles || []).map(f => f.path).filter(Boolean).join(', ');
      return { role: 'user', content: `${m.text || ''}${files ? `\n[本轮上传文件: ${files}]` : ''}` };
    }
    const outputs = (m.results || [])
      .map(r => `${r.title || ''} → ${[r.objFile, r.dwgFile, r.dxfFile, r.afterImage].filter(Boolean).join(', ')}`)
      .join('; ');
    return { role: 'assistant', content: `${m.text || ''}${outputs ? `\n[本轮已产出: ${outputs}]` : ''}` };
  });
}

// Most recent produced preview image in a thread (so "改成夜景" can lock onto it).
function findLastImage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.results && m.results.length > 0) {
      const pick = m.results.find(r => !r.dwgFile) || m.results[0];
      if (pick && pick.afterImage) return pick.afterImage;
    }
  }
  return '';
}

// One-time migration: data files used to live in the project root.
for (const name of ['chat_threads.json', 'agent_settings.json']) {
  const legacy = path.join(ROOT_DIR, name);
  const target = path.join(DATA_DIR, name);
  if (DATA_DIR !== ROOT_DIR && fs.existsSync(legacy) && !fs.existsSync(target)) fs.renameSync(legacy, target);
}

module.exports = {
  nowHHMM, nowIso, loadSettings, saveSettings, newThread,
  loadStore, saveStore, formatStatePayload, buildHistory, findLastImage
};
