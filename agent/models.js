require('./config'); // Load .env before collecting model settings.

function loadModelConfig(env = process.env) {
  const ids = new Set();
  const parseEntries = (prefix, kind) => {
    const numbers = [...new Set(Object.keys(env)
      .map(key => new RegExp(`^${prefix}_(\\d+)_(?:ID|LABEL|PROVIDER|BASE_URL|MODEL|API_KEY|API_KEY_ENV)$`).exec(key)?.[1])
      .filter(Boolean).map(Number))].sort((a, b) => a - b);

    return numbers.map(number => {
      const field = name => String(env[`${prefix}_${number}_${name}`] || '').trim();
      const id = field('ID');
      const label = field('LABEL') || id;
      const provider = field('PROVIDER');
      const baseUrl = field('BASE_URL').replace(/\/+$/, '');
      const model = field('MODEL');
      const apiKeyEnv = field('API_KEY_ENV');
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new Error(`模型 ID 无效或重复: ${id || `${prefix}_${number}`}`);
      ids.add(id);
      if (!model || !baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error(`模型 ${id} 缺少有效的 MODEL 或 BASE_URL`);
      if (kind === 'brains' && provider !== 'openai-compatible') throw new Error(`对话模型 ${id} 目前需要 openai-compatible 接口`);
      if (kind === 'images' && !['openai-images', 'gemini'].includes(provider)) throw new Error(`生图模型 ${id} 的 PROVIDER 不受支持`);
      if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error(`模型 ${id} 的 API_KEY_ENV 无效`);
      const apiKey = field('API_KEY') || (apiKeyEnv ? String(env[apiKeyEnv] || '').trim() : '');
      return { id, label, model, baseUrl, provider, apiKey };
    }).filter(item => item.apiKey && !/^YOUR_|^填入/.test(item.apiKey)
      && !/^YOUR_/.test(item.model) && !item.baseUrl.includes('your-provider.example'));
  };
  return { brains: parseEntries('CHAT_MODEL', 'brains'), images: parseEntries('IMAGE_MODEL', 'images') };
}

const catalog = loadModelConfig();

function publicCatalog(config = catalog) {
  const pick = item => ({ id: item.id, label: item.label, model: item.model, provider: item.provider });
  return { brains: config.brains.map(pick), images: config.images.map(pick) };
}

function selectModel(kind, id) {
  const models = catalog[kind];
  if (!models || models.length === 0) {
    const error = new Error(`${kind === 'brains' ? '对话' : '生图'}模型未配置，请填写 .env 并重启服务`);
    error.statusCode = 503;
    throw error;
  }
  const selected = id ? models.find(item => item.id === id) : models[0];
  if (!selected) {
    const error = new Error(`未配置的模型: ${id}`);
    error.statusCode = 400;
    throw error;
  }
  return selected;
}

module.exports = { loadModelConfig, publicCatalog, selectModel };
