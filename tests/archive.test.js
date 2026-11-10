const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const store = require('../server/store');

test('legacy threads are archived by message date, not their bare HH:mm label', () => {
  const oldTime = Date.parse('2026-11-09T17:21:13+08:00');
  const newTime = Date.parse('2026-11-10T09:51:24+08:00');
  const data = {
    activeThreadId: 'old',
    threads: [
      { id: 'old', title: '昨天的会话', updatedAt: '17:19', messages: [
        { id: `msg-a-${oldTime}`, role: 'assistant', createdAt: '17:21' }
      ] },
      { id: 'new', title: '今天的会话', updatedAt: '09:51', messages: [
        { id: `msg-a-${newTime}`, role: 'assistant', createdAt: '09:51' }
      ] }
    ]
  };
  const original = JSON.stringify(data);
  const payload = store.formatStatePayload(data);
  assert.deepEqual(payload.threads.map(t => t.id), ['new', 'old']);
  assert.equal(payload.threads[0].updatedAtIso, new Date(newTime).toISOString());
  assert.equal(payload.threads[1].updatedAtIso, new Date(oldTime).toISOString());
  assert.equal(payload.messages[0].createdAtIso, new Date(oldTime).toISOString());
  assert.equal(JSON.stringify(data), original, 'archive formatting must not rewrite history');
});

test('new threads persist a full timestamp', () => {
  const thread = store.newThread();
  assert.ok(Number.isFinite(Date.parse(thread.createdAtIso)));
  assert.equal(thread.updatedAtIso, thread.createdAtIso);
});

test('sidebar groups old and new sessions by date and uses recovered clock time', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const list = { innerHTML: '' };
  const context = vm.createContext({ document: { getElementById: id => id === 'threadList' ? list : null } });
  vm.runInContext(script.replace(/\bloadModels\(\)\.catch\([^;]+;\s*loadChat\(\);\s*$/, ''), context);
  vm.runInContext(`threads = ${JSON.stringify([
    { id: 'new', title: '今日会话', updatedAtIso: '2026-11-10T01:51:24.000Z' },
    { id: 'old', title: '旧会话', updatedAt: '17:19', updatedAtIso: '2026-11-09T09:21:13.000Z' }
  ])}; activeThreadId = 'new'; renderThreads();`, context);
  assert.ok(list.innerHTML.indexOf('今日会话') < list.innerHTML.indexOf('旧会话'));
  assert.match(list.innerHTML, /2026年11月10日/);
  assert.match(list.innerHTML, /2026年11月9日/);
  assert.match(list.innerHTML, />17:21<\/time>/);
  assert.doesNotMatch(list.innerHTML, />17:19<\/time>/);
});
