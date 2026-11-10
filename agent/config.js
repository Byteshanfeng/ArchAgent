const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const ENV_FILE = process.env.ARCH_AGENT_ENV_FILE || path.join(ROOT_DIR, '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

module.exports = {
  PORT: Number(process.env.PORT) || 3488,
  HOST: process.env.HOST || '127.0.0.1',

  ROOT_DIR,
  PUBLIC_DIR,
  UPLOADS_DIR: path.join(PUBLIC_DIR, 'uploads'),
  SCRIPTS_DIR: path.join(ROOT_DIR, 'scripts'),
  DATA_DIR: ROOT_DIR,

  PYTHON_BIN: process.env.PYTHON_BIN || 'python3',

  MAX_TOOL_ROUNDS: 5,
  HISTORY_TURNS: 12,
  MAX_SYSTEM_PROMPT_CHARS: 4000
};
