const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');

test('card action keeps quoted titles as one JavaScript argument', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const context = vm.createContext({});
  vm.runInContext(script.replace(/\bloadModels\(\)\.catch\([^;]+;\s*loadChat\(\);\s*$/, ''), context);
  const title = `客户's \"建筑\" <img onerror=alert(1)>`;
  const attribute = context.jsArg(title);
  const decoded = attribute.replaceAll('&quot;', '"').replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  assert.equal(vm.runInNewContext(decoded), title);
});

test('simultaneous messages on one thread are both saved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-agent-chat-test-'));
  const copy = (name) => {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, name), target);
  };
  ['server.js', 'server/store.js', 'server/files.js', 'agent/models.js'].forEach(copy);
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public/uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public/index.html'), 'test');
  fs.writeFileSync(path.join(dir, 'agent/config.js'), `const path=require('path');const root=path.join(__dirname,'..');module.exports={PORT:Number(process.env.PORT),HOST:'127.0.0.1',ROOT_DIR:root,PUBLIC_DIR:path.join(root,'public'),UPLOADS_DIR:path.join(root,'public/uploads'),DATA_DIR:root,HISTORY_TURNS:12,MAX_SYSTEM_PROMPT_CHARS:4000};`);
  fs.writeFileSync(path.join(dir, 'agent/runtime.js'), `module.exports={runArchAgentTurn:async ({userMessage})=>{await new Promise(r=>setTimeout(r,40));return {replyText:userMessage,results:[],toolTraces:[],steps:[]}}};`);
  fs.writeFileSync(path.join(dir, 'agent/tool-specs.js'), 'module.exports={describeTools:()=>[]}');
  const { saveUploadedFile } = require(path.join(dir, 'server/files.js'));
  const dataUrl = 'data:text/plain;base64,YQ==';
  assert.notEqual(saveUploadedFile('sample.dxf', dataUrl), saveUploadedFile('sample.dxf', dataUrl));
  fs.writeFileSync(path.join(dir, 'chat_threads.json'), JSON.stringify({activeThreadId:'test-thread',threads:[{id:'test-thread',title:'Test',messages:[]}]}));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CHAT|IMAGE)_MODEL_\d+_/.test(key)));
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...cleanEnv, PORT: String(port),
    CHAT_MODEL_1_ID: 'test', CHAT_MODEL_1_LABEL: 'test', CHAT_MODEL_1_PROVIDER: 'openai-compatible',
    CHAT_MODEL_1_MODEL: 'test-model', CHAT_MODEL_1_BASE_URL: 'http://127.0.0.1:9/v1',
    CHAT_MODEL_1_API_KEY: 'test-secret' }, stdio: 'ignore' });
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(url + '/api/agent/tools')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(ready, 'isolated server started');
    const catalog = await (await fetch(url + '/api/models')).json();
    assert.equal(catalog.brains[0].model, 'test-model');
    assert.doesNotMatch(JSON.stringify(catalog), /test-secret|apiKey/);
    const post = message => fetch(url + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'test-thread', message })
    });
    const responses = await Promise.all([post('first'), post('second')]);
    assert.deepEqual(responses.map(r => r.status), [200, 200]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'chat_threads.json'), 'utf8'));
    assert.deepEqual(saved.threads[0].messages.filter(m => m.role === 'user').map(m => m.text).sort(), ['first', 'second']);
    assert.equal(saved.threads[0].messages.length, 4);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
