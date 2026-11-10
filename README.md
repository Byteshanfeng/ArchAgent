# ArchAgent · 建筑设计 AI Agent

对话式建筑设计助手：粘贴本地文件路径（`.skp` `.dwg` `.dxf` `.obj` 图片）或上传文件，用自然语言描述需求，Agent 调用工具产出可下载的二维/三维成果，支持多轮修改与自定义系统提示词。

## 能力

| 工具 | 作用 | 产出 |
|---|---|---|
| `inspect_arch_file` | 读取 CAD/SKP/OBJ/图片信息（版本、图元、坐标漂移、图幅范围等） | 诊断结果 |
| `calculate_planning_metrics` | 根据用户明确给定的用地面积估算容积率、密度、建面与参考车位 | 指标 |
| `generate_cad_dwg` | 参数化标准层平面，或保留已有 CAD 图元并平移坐标、叠加示意退线与体块 | `.dwg` `.dxf` + 预览 |
| `generate_3d_model` | 体块级三维模型（楼板、柱、核心筒、幕墙分格） | `.obj` 三维 `.dwg/.dxf` + 轴测图 |
| `render_arch_image` | 以 `.skp` 内置预览或 CAD 图纸预览为参考生成效果图、彩平图及日/夜景精修 | 图片 |

局限：三维为体块级而非 BIM；无法直接写出 `.skp`（用 `.obj` 导入 SketchUp）；SKP 渲染使用文件内置预览图；生图结果的几何须人工核对；强排按图幅范围示意，不是用地边界或规范校核。图幅外接范围不能作为用地面积。

## 运行

依赖：Node ≥ 20.12；Python 3（`ezdxf`、`Pillow`）；Homebrew `libredwg`（`dxf2dwg`/`dwg2dxf`）；至少一个支持工具调用的 OpenAI 兼容对话模型 API。生图功能需要另配生图模型 API。

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
cp .env.example .env # 首次配置时使用；已有 .env 不要覆盖
npm start          # http://127.0.0.1:3488
npm run check      # 语法与回归测试
```

项目启动时自动加载根目录的 `.env`。对话模型使用 `CHAT_MODEL_1_*`、`CHAT_MODEL_2_*` 等编号；生图模型使用 `IMAGE_MODEL_1_*`、`IMAGE_MODEL_2_*` 等编号，编号可以不连续。每项填写 `ID`、`LABEL`、`PROVIDER`、`BASE_URL`、`MODEL`，再选择 `API_KEY`（直接填写）或 `API_KEY_ENV`（引用同一 `.env` 中的密钥变量，如 `OPENAI_API_KEY`）。`API_KEY` 优先。未提供密钥或使用 `YOUR_` 占位符的条目不会出现在页面下拉框。`.env` 已加入 `.gitignore`，`/api/models` 只返回公开的模型信息，不返回密钥；修改后重启服务。

也可以连接本机 OpenAI 兼容反代：将相应条目的 `BASE_URL` 设为网关地址，`MODEL` 填网关实际提供的模型名。切换到厂商直连接口时，分别修改 `BASE_URL`、`MODEL` 和密钥。

对话接口类型 `openai-compatible` 使用 `/chat/completions` 和工具调用；官方 OpenAI、Gemini 的兼容接口及采用相同协议的服务可以分别配置。生图接口类型支持 `openai-images`（`/images/generations` 与 `/images/edits`）和 `gemini`（Google `generateContent`）。可按编号增加多家或多个模型，但仅填写模型名不能让不同协议的专有接口自动兼容。网关专用的模型别名不能直接用于厂商接口。

示例：若使用 OpenAI 与 Gemini，可复制 `.env.example`，填写 `OPENAI_API_KEY`、`GEMINI_API_KEY`，再将各项 `YOUR_...` 模型名改为账号可调用的名称。对话模型的 `PROVIDER` 为 `openai-compatible`；生图支持 `openai-images` 和 `gemini`。可选环境变量：`PORT`、`HOST`、`PYTHON_BIN`、`ARCH_AGENT_ENV_FILE`（可指定另一份环境变量文件）。已在 shell 中设置的同名变量优先。未配置对话模型时，历史会话仍可查看，发送新消息会提示配置模型。

## 结构

```
server.js            HTTP 路由（静态文件 + /api/*）
server/              store.js 会话与设置持久化 · files.js 路径提取/上传
agent/
  config.js          环境变量与常量
  models.js          多模型清单、密钥读取与公开清单
  image-api.js       OpenAI/Gemini 生图 API 适配
  prompts.js         系统提示词、回合上下文、渲染提示词模板（模型可见文本集中在此）
  tool-specs.js      工具 schema 单一来源（zod）
  tools.js           工具执行器
  runtime.js         LangGraph 状态图：intake → planner ⇄ tool_executor → synthesizer
scripts/             Python：cad_io · cad_dwg_generator · model_3d_generator · convert_arch_file · inspect_arch_file
public/              单页前端（Codex 风格，亮/暗主题）；public/uploads 为产出物
```

## 多轮记忆

`server/store.js#buildHistory` 取最近 12 条消息（含已产出文件路径）注入模型；系统提示词之外，用户自定义提示词（设置里编辑，≤4000 字）作为第二条 System 消息追加。

会话侧边栏按最后活动日期归档并排序。新消息保存完整 ISO 时间；旧记录只有时分时，从消息 ID 中恢复日期用于展示，不改写原有会话文件。

## 修改提示词

编辑 `agent/prompts.js`：`SYSTEM_PROMPT`（角色/工具选用/专业准则/诚实交付）、`buildTurnContext`（每轮附加上下文）、`buildRenderPrompt`（图像模型提示词）。工具描述在 `agent/tool-specs.js`。
