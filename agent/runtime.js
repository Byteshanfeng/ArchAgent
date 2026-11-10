const { StateGraph, Annotation, START, END, MemorySaver } = require('@langchain/langgraph');
const { ChatOpenAI } = require('@langchain/openai');
const { SystemMessage, HumanMessage, AIMessage, ToolMessage } = require('@langchain/core/messages');
const { executeToolCall } = require('./tools');
const { TOOLS } = require('./tool-specs');
const { SYSTEM_PROMPT, CUSTOM_PROMPT_HEADER, buildTurnContext } = require('./prompts');
const cfg = require('./config');
const { selectModel } = require('./models');

// ============================================================================
// 1. LangGraph State Schema via Annotation.Root
// ============================================================================
const ArchGraphState = Annotation.Root({
  userMessage: Annotation({ reducer: (_, y) => y, default: () => '' }),
  brainModelId: Annotation({ reducer: (_, y) => y, default: () => '' }),
  cleanPrompt: Annotation({ reducer: (_, y) => y, default: () => '' }),
  detectedFiles: Annotation({ reducer: (_, y) => y, default: () => [] }),
  targetImageUrl: Annotation({ reducer: (_, y) => y, default: () => '' }),
  lastAssistantImageUrl: Annotation({ reducer: (_, y) => y, default: () => '' }),
  imageModel: Annotation({ reducer: (_, y) => y, default: () => '' }),
  defaultLighting: Annotation({ reducer: (_, y) => y, default: () => 'day' }),
  customSystemPrompt: Annotation({ reducer: (_, y) => y, default: () => '' }),
  history: Annotation({ reducer: (_, y) => y, default: () => [] }),

  lcMessages: Annotation({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
    default: () => []
  }),
  pendingToolCalls: Annotation({ reducer: (_, y) => y, default: () => [] }),
  iteration: Annotation({ reducer: (_, y) => y, default: () => 0 }),
  plannerError: Annotation({ reducer: (_, y) => y, default: () => '' }),

  results: Annotation({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
    default: () => []
  }),
  toolTraces: Annotation({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
    default: () => []
  }),
  steps: Annotation({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
    default: () => []
  }),
  finalReplyText: Annotation({ reducer: (_, y) => y, default: () => '' })
});

// ============================================================================
// 2. Nodes
// ============================================================================

// Node 1: intake_node
async function intakeNode(state) {
  const startMs = Date.now();
  const { detectedFiles, targetImageUrl, lastAssistantImageUrl, userMessage, defaultLighting } = state;

  const referenceImage = targetImageUrl || lastAssistantImageUrl;

  const initMessages = [
    new SystemMessage(SYSTEM_PROMPT),
    ...(state.customSystemPrompt && state.customSystemPrompt.trim()
      ? [new SystemMessage(`${CUSTOM_PROMPT_HEADER}\n${state.customSystemPrompt.trim()}`)]
      : []),
    ...(state.history || []).map(h => h.role === 'user'
      ? new HumanMessage(h.content)
      : new AIMessage(h.content)),
    new HumanMessage(buildTurnContext({ userMessage, detectedFiles, referenceImage, lighting: defaultLighting }))
  ];

  const intakeSummary = detectedFiles.length > 0
    ? `识别到 ${detectedFiles.length} 个本地工程文件 (${detectedFiles.map(f => f.name).join(', ')})`
    : (targetImageUrl || lastAssistantImageUrl)
      ? `锁定上下文参考底图 ${targetImageUrl || lastAssistantImageUrl}`
      : `解析纯文本建筑设计指令`;

  return {
    lcMessages: initMessages,
    iteration: 0,
    toolTraces: [{
      node: 'intake_node',
      tool: 'StateGraph:intake',
      label: '上下文与文件路径解析',
      summary: intakeSummary,
      durationMs: Math.max(1, Date.now() - startMs)
    }],
    steps: [`🔵 [intake] ${intakeSummary}`]
  };
}

// Node 2: planner_node (Invokes ChatOpenAI.bindTools)
async function plannerNode(state) {
  const startMs = Date.now();
  const nextIter = (state.iteration || 0) + 1;

  try {
    const brain = selectModel('brains', state.brainModelId);
    const plannerModel = new ChatOpenAI({
      model: brain.model,
      apiKey: brain.apiKey,
      configuration: { baseURL: brain.baseUrl },
      temperature: 0.2
    }).bindTools(TOOLS);
    const aiMsg = await plannerModel.invoke(state.lcMessages);
    const toolCalls = aiMsg.tool_calls || [];
    const durationMs = Date.now() - startMs;

    if (toolCalls.length === 0) {
      const contentStr = typeof aiMsg.content === 'string'
        ? aiMsg.content.trim()
        : Array.isArray(aiMsg.content)
          ? aiMsg.content.map(c => c.text || '').join('\n').trim()
          : '';
      return {
        lcMessages: [aiMsg],
        pendingToolCalls: [],
        iteration: nextIter,
        finalReplyText: contentStr,
        toolTraces: [{
          node: 'planner_node',
          tool: `ChatOpenAI#${nextIter}`,
          label: nextIter === 1 ? '建筑师直接回复' : '决策节点 (完成推理)',
          summary: nextIter === 1 ? '无需调用外部工具，直接回答' : '工具调用已完成，汇总建筑师分析报告',
          durationMs
        }]
      };
    }

    const plannedNames = toolCalls.map(tc => tc.name).join(', ');
    return {
      lcMessages: [aiMsg],
      pendingToolCalls: toolCalls,
      iteration: nextIter,
      toolTraces: [{
        node: 'planner_node',
        tool: `ChatOpenAI#${nextIter}`,
        label: `决策节点 (第 ${nextIter} 轮)`,
        summary: `分派工具调用: ${plannedNames}`,
        durationMs
      }],
      steps: [`🟣 [planner #${nextIter}] 决策调用工具: ${plannedNames} (${durationMs}ms)`]
    };
  } catch (err) {
    const message = err.message || String(err);
    console.error('[planner_node] LLM call failed:', message);
    return {
      pendingToolCalls: [],
      iteration: nextIter,
      plannerError: message,
      toolTraces: [{
        node: 'planner_node',
        tool: `ChatOpenAI#${nextIter}`,
        label: '决策节点 (模型调用失败)',
        summary: message.slice(0, 160),
        durationMs: Date.now() - startMs,
        error: true
      }],
      steps: [`🔴 [planner_node #${nextIter}] 模型调用失败，已降级为关键词路由: ${message.slice(0, 120)}`]
    };
  }
}

// Node 3: tool_executor_node (Executes tools & appends LangChain ToolMessage)
async function toolExecutorNode(state) {
  const newResults = [];
  const newTraces = [];
  const newSteps = [];
  const toolMessages = [];

  const execContext = {
    detectedFiles: state.detectedFiles,
    targetImageUrl: state.targetImageUrl,
    lastAssistantImageUrl: state.lastAssistantImageUrl,
    imageModel: state.imageModel,
    defaultLighting: state.defaultLighting,
    results: newResults
  };

  for (const tc of state.pendingToolCalls || []) {
    const fnName = tc.name;
    const fnArgs = tc.args || {};

    try {
      const { output, trace } = await executeToolCall(fnName, fnArgs, execContext);
      trace.node = 'tool_executor_node';
      newTraces.push(trace);
      newSteps.push(`🛠️ [tool] \`${trace.tool}\` → ${trace.summary} (${trace.durationMs}ms)`);

      toolMessages.push(new ToolMessage({
        tool_call_id: tc.id,
        name: fnName,
        content: JSON.stringify(output)
      }));
    } catch (toolErr) {
      const errMsg = toolErr.message || String(toolErr);
      newTraces.push({
        node: 'tool_executor_node',
        tool: fnName,
        label: '工具执行异常',
        args: fnArgs,
        summary: errMsg,
        durationMs: 0,
        error: true
      });
      toolMessages.push(new ToolMessage({
        tool_call_id: tc.id,
        name: fnName,
        content: JSON.stringify({ status: 'error', message: errMsg })
      }));
    }
  }

  return {
    lcMessages: toolMessages,
    pendingToolCalls: [],
    results: newResults,
    toolTraces: newTraces,
    steps: newSteps
  };
}

// Node 4: synthesizer_node
async function synthesizerNode(state) {
  const newResults = [];
  const newTraces = [];
  const newSteps = [];
  let fallbackError = '';

  // Keyword routing is a degraded mode: only used when the LLM planner itself failed and nothing was produced.
  if (state.plannerError && state.results.length === 0) {
    const execContext = {
      detectedFiles: state.detectedFiles,
      targetImageUrl: state.targetImageUrl,
      lastAssistantImageUrl: state.lastAssistantImageUrl,
      imageModel: state.imageModel,
      defaultLighting: state.defaultLighting,
      results: newResults
    };

    const action = /生成|制作|输出|绘制|建模|修复|加工|渲染|修图|切换|改成|调整/i.test(state.cleanPrompt);
    const wantsDwg = action && /dwg|dxf|cad|图纸|强排|坐标|轴网/i.test(state.cleanPrompt);
    const wants3d = action && /三维|3d|模型|体块|obj/i.test(state.cleanPrompt);
    const wantsRender = action && /效果图|彩平|渲染|修图|图片|图像|日景|夜景|亮景|暗景/i.test(state.cleanPrompt);
    try {
    if (wants3d) {
      const { trace } = await executeToolCall(
        'generate_3d_model',
        { title: state.cleanPrompt.slice(0, 30) || 'AI 三维建筑模型' },
        execContext
      );
      trace.node = 'synthesizer_node';
      newTraces.push(trace);
      newSteps.push(`🛠️ [fallback] \`${trace.tool}\` → ${trace.summary} (${trace.durationMs}ms)`);
    } else if (wantsDwg) {
      const dwgFile = state.detectedFiles.find(f => f.ext === '.dwg' || f.ext === '.dxf');
      const { trace } = await executeToolCall(
        'generate_cad_dwg',
        dwgFile
          ? { mode: 'enhance_dwg', source_dwg_path: dwgFile.path }
          : { mode: 'parametric', title: 'AI 生成标准层 CAD 平面图' },
        execContext
      );
      trace.node = 'synthesizer_node';
      newTraces.push(trace);
      newSteps.push(`🛠️ [fallback] \`${trace.tool}\` → ${trace.summary} (${trace.durationMs}ms)`);
    } else if (wantsRender) {
      const targetFiles = state.detectedFiles.length > 0 ? state.detectedFiles : [null];
      for (const f of targetFiles) {
        const { trace } = await executeToolCall(
          'render_arch_image',
          {
            source_file_path: f ? f.path : '',
            render_instruction: state.cleanPrompt || '写实大师级建筑摄影效果图',
            scene_lighting: state.defaultLighting
          },
          execContext
        );
        trace.node = 'synthesizer_node';
        newTraces.push(trace);
        newSteps.push(`🛠️ [fallback] \`${trace.tool}\` → ${trace.summary} (${trace.durationMs}ms)`);
      }
    }
    } catch (err) {
      fallbackError = err.message || String(err);
      newTraces.push({ node: 'synthesizer_node', tool: 'fallback', label: '降级执行失败',
        summary: fallbackError, durationMs: 0, error: true });
    }
  }

  const totalResults = (state.results?.length || 0) + newResults.length;

  let finalReply = state.finalReplyText;
  if (!finalReply) {
    if (state.plannerError) {
      finalReply = fallbackError
        ? `智能规划模型暂时不可用，降级执行也失败：${fallbackError.slice(0, 180)}。请检查输入后重试。`
        : totalResults > 0
        ? `智能规划模型暂时不可用，已按关键词直接执行并产出 ${totalResults} 项成果，参数均为默认值，可告诉我需要调整的地方。`
        : `智能规划模型暂时不可用（${state.plannerError.slice(0, 80)}），请检查 .env 中的模型、接口地址与密钥后重试。`;
    } else {
      finalReply = totalResults > 0 ? '已完成，成果见下方卡片。' : '已处理完毕。';
    }
  }

  return {
    results: newResults,
    toolTraces: newTraces,
    steps: newSteps,
    finalReplyText: finalReply
  };
}

// ============================================================================
// 3. Routing
// ============================================================================
function routeAfterPlanner(state) {
  if (state.pendingToolCalls && state.pendingToolCalls.length > 0 && state.iteration <= cfg.MAX_TOOL_ROUNDS) {
    return 'tool_executor_node';
  }
  return 'synthesizer_node';
}

// ============================================================================
// 4. Compile
// ============================================================================
const memoryCheckpointer = new MemorySaver();

const workflow = new StateGraph(ArchGraphState)
  .addNode('intake_node', intakeNode)
  .addNode('planner_node', plannerNode)
  .addNode('tool_executor_node', toolExecutorNode)
  .addNode('synthesizer_node', synthesizerNode)
  .addEdge(START, 'intake_node')
  .addEdge('intake_node', 'planner_node')
  .addConditionalEdges('planner_node', routeAfterPlanner, {
    tool_executor_node: 'tool_executor_node',
    synthesizer_node: 'synthesizer_node'
  })
  .addEdge('tool_executor_node', 'planner_node')
  .addEdge('synthesizer_node', END);

const compiledArchGraph = workflow.compile({ checkpointer: memoryCheckpointer });

async function runArchAgentTurn({
  threadId = 'default-thread',
  brainModelId = '',
  userMessage,
  cleanPrompt,
  detectedFiles,
  targetImageUrl,
  lastAssistantImageUrl,
  imageModel = '',
  defaultLighting = 'day',
  customSystemPrompt = '',
  history = []
}) {
  const finalState = await compiledArchGraph.invoke(
    {
      userMessage,
      brainModelId,
      cleanPrompt,
      detectedFiles,
      targetImageUrl,
      lastAssistantImageUrl,
      imageModel,
      defaultLighting,
      customSystemPrompt,
      history,
      results: [],
      toolTraces: [],
      steps: [],
      finalReplyText: ''
    },
    {
      // Fresh thread_id per turn: conversation memory comes from `history`, not the checkpointer.
      configurable: { thread_id: `${threadId}_${Date.now()}` }
    }
  );

  return {
    replyText: finalState.finalReplyText,
    steps: finalState.steps || [],
    toolTraces: finalState.toolTraces || [],
    results: finalState.results || []
  };
}

module.exports = {
  runArchAgentTurn,
  compiledArchGraph
};
