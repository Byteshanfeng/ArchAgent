// Single source of truth for tool schemas (name / description / zod params).
// runtime.js binds these to the LLM; server.js exposes them at GET /api/agent/tools.
const { tool } = require('@langchain/core/tools');
const { z } = require('zod');

const noop = async () => '';

const inspectArchFile = tool(noop, {
  name: 'inspect_arch_file',
  description:
    '读取本地工程文件信息：.dwg/.dxf 的 CAD 版本、图元数量、坐标漂移及图幅外接范围；.skp 的版本；.obj 的顶点和面数量；图片尺寸。图幅范围不是用地面积。' +
    '用户给出文件路径并要分析、修复或加工时，应先调用本工具，再决定后续动作。只读，不产出文件；无本地路径时不要调用。',
  schema: z.object({
    file_path: z.string().describe('文件绝对路径，原样取自用户消息，如 /Users/xxx/Downloads/项目用地图.dwg')
  })
});

const calculatePlanningMetrics = tool(noop, {
  name: 'calculate_planning_metrics',
  description:
    '规划技术经济指标核算：由用地面积、容积率、建筑密度、层数得出总计容建筑面积、最大基底面积、推荐楼栋数、单栋标准层面积与参考车位数。' +
    '用地面积必须由用户明确给定；不得使用 inspect_arch_file 的图幅外接范围推算。缺失时先向用户确认。车位数仅供方案参考，不等同规范校核。',
  schema: z.object({
    site_area_sqm: z.number().positive().describe('用户明确提供的用地面积，单位 ㎡'),
    far: z.number().positive().optional().describe('目标容积率，默认 2.5'),
    building_density: z.number().positive().max(1).optional().describe('建筑密度上限，0~1 的小数，默认 0.35'),
    floors: z.number().int().positive().optional().describe('主体平均层数，默认 8')
  })
});

const generateCadDwg = tool(noop, {
  name: 'generate_cad_dwg',
  description:
    '生成原生 AutoCAD 图纸（.dwg + .dxf + 预览图）。' +
    'mode="parametric"：从零生成标准层平面（轴网、双线墙、柱网、楼梯电梯核心筒、门窗、尺寸与房间标注），参数单位毫米。' +
    'mode="enhance_dwg"：保留已有 .dwg/.dxf 图元和图层，整体平移至局部原点，叠加按图幅范围内缩约 8% 的示意退线与 3 栋示意体块；不基于真实用地边界、容积率或日照反算。' +
    '要三维模型时请用 generate_3d_model，不要用本工具。',
  schema: z.object({
    mode: z.enum(['parametric', 'enhance_dwg']).describe('parametric 新建标准层；enhance_dwg 加工已有图纸'),
    source_dwg_path: z.string().optional().describe('mode=enhance_dwg 时必填：原图绝对路径'),
    title: z.string().optional().describe('图纸标题'),
    width_mm: z.number().optional().describe('总面宽，mm，默认 33600'),
    depth_mm: z.number().optional().describe('总进深，mm，默认 18000'),
    bays_x: z.number().optional().describe('横向柱网跨数（3~6），默认 4'),
    bays_y: z.number().optional().describe('纵向柱网跨数（2~3），默认 2'),
    rooms: z.array(z.string()).optional().describe('房间功能名称列表，按用户业态命名，如 ["门厅","开放办公","会议室"]')
  })
});

const generate3dModel = tool(noop, {
  name: 'generate_3d_model',
  description:
    '生成可下载的三维建筑体块模型：.obj（SketchUp/Rhino/Blender 可导入）、三维线框 .dwg/.dxf、轴测预览图。' +
    '输出为单栋矩形体块级模型（楼板、柱、核心筒、幕墙分格、场地底板），不支持异形、坡屋顶或精细立面。参数单位为米。' +
    '用户要“三维/模型/体块/obj”，或在上一版模型上改层数、尺寸时调用；改动时沿用上一轮未被修改的参数。',
  schema: z.object({
    title: z.string().optional().describe('模型标题'),
    width_m: z.number().optional().describe('面宽，m，默认 33.6'),
    depth_m: z.number().optional().describe('进深，m，默认 18'),
    floors: z.number().optional().describe('层数，默认 7'),
    floor_height_m: z.number().optional().describe('层高，m，默认 4.2'),
    bays_x: z.number().optional().describe('横向柱网跨数，默认 4'),
    bays_y: z.number().optional().describe('纵向柱网跨数，默认 2')
  })
});

const renderArchImage = tool(noop, {
  name: 'render_arch_image',
  description:
    '建筑视觉生成与锁结构修图（图像模型）：.skp 白模 → 写实效果图；.dwg/.dxf 平面 → 彩色平面图（彩平图）；对上一张成图做材质/光影/氛围精修；无源文件时可文生概念图。' +
    '会以原图为参考并尽量保持几何结构，结果需人工核对。仅有修图指令且无新文件时，不传 source_file_path，系统自动使用上一张图。生成需要约 10~60 秒。',
  schema: z.object({
    source_file_path: z.string().optional().describe('源文件绝对路径（.skp/.dwg/.dxf/图片）或 /uploads/xxx 形式的上一张成图；留空则自动使用上下文参考图'),
    render_instruction: z.string().describe('具体的材质、铺装、立面、环境或修改指令，保持建筑师口吻，越具体越好'),
    scene_lighting: z.enum(['day', 'night']).optional().describe('day 晴朗日景；night 傍晚蓝调夜景。用户明确说了夜景/日景时必须设置')
  })
});

// Order matters little for the model; keep logical flow: inspect → compute → 2D → 3D → visual
const TOOLS = [inspectArchFile, calculatePlanningMetrics, generateCadDwg, generate3dModel, renderArchImage];

function describeTools() {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: Object.keys(t.schema.shape || {})
  }));
}

module.exports = { TOOLS, describeTools };
