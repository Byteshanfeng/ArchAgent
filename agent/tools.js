const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { UPLOADS_DIR, SCRIPTS_DIR, PYTHON_BIN } = require('./config');
const { buildRenderPrompt } = require('./prompts');
const { generateImage } = require('./image-api');

const expandHome = p => String(p || '').trim().replace(/^~\//, `${process.env.HOME}/`);
const displayFileName = p => path.basename(String(p || '')).replace(/^raw_\d+_/, '');

function numberArg(args, name, fallback, { min = 0, max = Infinity, integer = false } = {}) {
  const value = args[name] == null ? fallback : Number(args[name]);
  if (!Number.isFinite(value) || value <= min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} 参数无效，需为${integer ? '整数且' : ''}大于 ${min}${Number.isFinite(max) ? `、不超过 ${max}` : ''}`);
  }
  return value;
}

function uploadedImagePath(url) {
  if (!/^\/uploads\/[a-zA-Z0-9_\u4e00-\u9fa5.-]+\.(png|jpe?g|webp)$/i.test(url || '')) return null;
  const file = path.join(UPLOADS_DIR, path.basename(url));
  return fs.existsSync(file) ? file : null;
}

function execPython(scriptName, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    execFile(PYTHON_BIN, ['-I', scriptPath, ...args], { timeout }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || stdout || err.message));
      }
      resolve((stdout || '').trim());
    });
  });
}

async function convertArchFileToPng(filepath) {
  const out = await execPython('convert_arch_file.py', [filepath, UPLOADS_DIR]);
  if (!out.startsWith('OK:')) {
    throw new Error(out.replace(/^ERROR:/, '') || '文件解析失败');
  }
  const filename = out.slice(3).trim();
  return {
    diskPath: path.join(UPLOADS_DIR, filename),
    publicUrl: `/uploads/${filename}`
  };
}

// ============================================================================
// Tool Executors
// ============================================================================
async function executeToolCall(toolName, args, context) {
  const startTime = Date.now();

  if (toolName === 'inspect_arch_file') {
    const filePath = expandHome(args.file_path);
    const rawJson = await execPython('inspect_arch_file.py', [filePath]);
    const info = JSON.parse(rawJson);
    const durationMs = Date.now() - startTime;

    const dispFile = displayFileName(info.file_name || filePath);
    const summary = info.status === 'ok'
      ? (info.coord_drift_detected !== undefined
          ? `${dispFile} (${info.format}, ${info.entity_count} 图元, 图幅范围 ${info.estimated_dimensions_m}, 坐标漂移=${info.coord_drift_detected ? '是' : '否'})`
          : `${dispFile} (${info.format})`)
      : `读取失败: ${info.message}`;

    return {
      output: info,
      trace: {
        tool: 'inspect_arch_file',
        label: '工程文件几何侦测',
        args: { file_path: dispFile },
        summary,
        durationMs
      }
    };
  }

  if (toolName === 'calculate_planning_metrics') {
    const siteArea = numberArg(args, 'site_area_sqm', undefined);
    const far = numberArg(args, 'far', 2.5);
    const density = numberArg(args, 'building_density', 0.35, { max: 1 });
    const floors = numberArg(args, 'floors', 8, { integer: true });

    const totalGfa = Math.round(siteArea * far);
    const maxFootprint = Math.round(siteArea * density);
    const stdFloorTotal = Math.round(totalGfa / floors);
    const minFloorsForDensity = Math.ceil(far / density);
    const suggestedBldgs = Math.max(1, Math.round(stdFloorTotal / 1200));
    const singleFloorArea = Math.round(stdFloorTotal / suggestedBldgs);
    const parkingCount = Math.ceil(totalGfa / 100);

    const metrics = {
      status: 'ok',
      site_area_sqm: siteArea,
      far,
      building_density_limit: `${(density * 100).toFixed(0)}%`,
      total_gfa_sqm: totalGfa,
      max_footprint_sqm: maxFootprint,
      planned_floors: floors,
      feasible_under_density: far / floors <= density,
      minimum_floors_for_density: minFloorsForDensity,
      recommended_buildings: suggestedBldgs,
      single_building_floor_plate_sqm: singleFloorArea,
      parking_spaces_reference: parkingCount
    };

    const durationMs = Date.now() - startTime;
    return {
      output: metrics,
      trace: {
        tool: 'calculate_planning_metrics',
        label: '规划强排指标核算',
        args: { site_area_sqm: siteArea, far, floors },
        summary: `总计容建面 ${totalGfa.toLocaleString()}㎡ · ${far / floors <= density ? '密度初步可行' : `按密度至少需 ${minFloorsForDensity} 层`} · 参考车位 ${parkingCount} 个`,
        durationMs
      }
    };
  }

  if (toolName === 'generate_cad_dwg') {
    const mode = args.mode || 'parametric';
    const stamp = `${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;

    if (mode === 'enhance_dwg' && !args.source_dwg_path) throw new Error('加工 CAD 图纸时必须提供源文件路径');
    if (mode === 'enhance_dwg' && args.source_dwg_path) {
      const srcPath = expandHome(args.source_dwg_path);
      const outDxf = path.join(UPLOADS_DIR, `cad_out_${stamp}.dxf`);
      const outDwg = path.join(UPLOADS_DIR, `cad_out_${stamp}.dwg`);
      const outPng = path.join(UPLOADS_DIR, `cad_out_${stamp}.png`);
      const srcName = displayFileName(srcPath);
      const title = args.title || `${srcName} · 坐标归零与强排总图`;

      const parsedOrig = await convertArchFileToPng(srcPath);
      const generation = await execPython('cad_dwg_generator.py', ['enhance_dwg', srcPath, outDxf, outDwg, outPng, title], 420000);
      const dwgWarning = generation.startsWith('DXF_ONLY:') ? generation.slice('DXF_ONLY:'.length) : '';
      if (!dwgWarning && generation !== 'OK') throw new Error(generation || 'CAD 图纸加工失败');

      const card = {
        title: `${srcName} · 坐标归零与强排总图`,
        sourceFile: srcPath,
        taskType: 'CAD 图纸加工',
        beforeImage: parsedOrig.publicUrl,
        afterImage: `/uploads/cad_out_${stamp}.png`,
        dwgFile: dwgWarning ? null : `/uploads/cad_out_${stamp}.dwg`,
        dxfFile: `/uploads/cad_out_${stamp}.dxf`,
        sceneMode: 'day',
        agentNote: `已保留原图图层与图元，并将图幅平移到局部原点。新增的退线和楼栋仅是按图幅范围绘制的方案示意，需按实际用地边界及规范复核。${dwgWarning ? ` DWG 转换未完成：${dwgWarning}；可下载已验证的 DXF。` : ''}`
      };
      context.results.push(card);

      const durationMs = Date.now() - startTime;
      return {
        output: {
          status: dwgWarning ? 'partial' : 'ok',
          dwg_url: card.dwgFile,
          dxf_url: card.dxfFile,
          preview_url: card.afterImage,
          layers_added: ['AI-REDLINE-SETBACK', 'AI-BLDG-MASSING', 'AI-GRID-AXIS', 'AI-ANNOTATION']
        },
        trace: {
          tool: 'generate_cad_dwg',
          label: dwgWarning ? 'CAD 坐标归零与强排 .DXF 生产' : 'AutoCAD 坐标归零与强排 .DWG 生产',
          args: { mode: 'enhance_dwg', source: srcName },
          summary: `产出 cad_out_${stamp}.${dwgWarning ? 'dxf（DWG 转换失败）' : 'dwg'} (保留原图图元并整体平移，叠加示意图层)`,
          durationMs
        }
      };
    } else {
      const spec = {
        title: args.title || 'AI 生成建筑标准层 CAD 平面图',
        width_mm: numberArg(args, 'width_mm', 33600, { min: 999 }),
        depth_mm: numberArg(args, 'depth_mm', 18000, { min: 999 }),
        bays_x: numberArg(args, 'bays_x', 4, { min: 1, max: 6, integer: true }),
        bays_y: numberArg(args, 'bays_y', 2, { min: 0, max: 3, integer: true }),
        rooms: Array.isArray(args.rooms) && args.rooms.length > 0
          ? args.rooms
          : ['主展厅', '开放办公区', '经理室', '多媒体会议室', '茶水休闲区', '设备机房']
      };

      const outDxf = path.join(UPLOADS_DIR, `plan_${stamp}.dxf`);
      const outDwg = path.join(UPLOADS_DIR, `plan_${stamp}.dwg`);
      const outPng = path.join(UPLOADS_DIR, `plan_${stamp}.png`);

      await execPython('cad_dwg_generator.py', ['parametric', JSON.stringify(spec), outDxf, outDwg, outPng]);

      const card = {
        title: spec.title,
        sourceFile: context.detectedFiles[0]?.path || 'Agent 参数化 CAD 生产',
        taskType: 'CAD 标准层平面',
        beforeImage: null,
        afterImage: `/uploads/plan_${stamp}.png`,
        dwgFile: `/uploads/plan_${stamp}.dwg`,
        dxfFile: `/uploads/plan_${stamp}.dxf`,
        sceneMode: 'day',
        agentNote: `已生成含轴网 (${spec.width_mm}×${spec.depth_mm}mm, ${spec.bays_x}×${spec.bays_y}跨)、240双线外墙、防烟楼梯间、电梯核心筒及房间面积标注的原生 .DWG / .DXF 矢量图纸。`
      };
      context.results.push(card);

      const durationMs = Date.now() - startTime;
      return {
        output: {
          status: 'ok',
          dwg_url: card.dwgFile,
          dxf_url: card.dxfFile,
          preview_url: card.afterImage,
          dimensions_mm: `${spec.width_mm}x${spec.depth_mm}`,
          grid: `${spec.bays_x}x${spec.bays_y}`,
          layers: ['A-AXIS', 'A-WALL', 'A-WALL-PART', 'A-WIND', 'A-DOOR', 'A-CORE-STAIR', 'A-DIM', 'A-TEXT', 'A-REDLINE']
        },
        trace: {
          tool: 'generate_cad_dwg',
          label: 'AutoCAD 参数化标准层 .DWG 生产',
          args: { mode: 'parametric', size: `${spec.width_mm}×${spec.depth_mm}mm`, grid: `${spec.bays_x}×${spec.bays_y}跨` },
          summary: `产出 9 图层 AutoCAD 原生图纸 plan_${stamp}.dwg`,
          durationMs
        }
      };
    }
  }

  if (toolName === 'generate_3d_model') {
    const stamp = `${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    const spec = {
      title: args.title || 'AI 生成三维建筑体块与幕墙模型',
      width_m: numberArg(args, 'width_m', 33.6),
      depth_m: numberArg(args, 'depth_m', 18),
      floors: numberArg(args, 'floors', 7, { integer: true }),
      floor_height_m: numberArg(args, 'floor_height_m', 4.2),
      bays_x: numberArg(args, 'bays_x', 4, { integer: true }),
      bays_y: numberArg(args, 'bays_y', 2, { integer: true })
    };
    const outObj = path.join(UPLOADS_DIR, `model3d_${stamp}.obj`);
    const outDxf = path.join(UPLOADS_DIR, `model3d_${stamp}.dxf`);
    const outDwg = path.join(UPLOADS_DIR, `model3d_${stamp}.dwg`);
    const outPng = path.join(UPLOADS_DIR, `model3d_${stamp}.png`);

    await execPython('model_3d_generator.py', [JSON.stringify(spec), outObj, outDxf, outDwg, outPng]);

    const totalH = (spec.floors * spec.floor_height_m).toFixed(1);
    const card = {
      title: spec.title,
      sourceFile: context.detectedFiles[0]?.path || 'Agent 三维建模',
      taskType: '三维体块模型',
      beforeImage: null,
      afterImage: `/uploads/model3d_${stamp}.png`,
      objFile: `/uploads/model3d_${stamp}.obj`,
      dwgFile: fs.existsSync(outDwg) ? `/uploads/model3d_${stamp}.dwg` : null,
      dxfFile: `/uploads/model3d_${stamp}.dxf`,
      sceneMode: 'day',
      agentNote: `已生成 ${spec.width_m}×${spec.depth_m}m、${spec.floors} 层（总高 ${totalH}m）的三维建筑模型，.obj 可导入 SketchUp / Rhino / Blender，.dxf 为三维线框${fs.existsSync(outDwg) ? '，同时提供 .dwg' : ''}。`
    };
    context.results.push(card);

    return {
      output: {
        status: 'ok',
        obj_url: card.objFile,
        dwg_url: card.dwgFile,
        dxf_url: card.dxfFile,
        preview_url: card.afterImage,
        size: `${spec.width_m}x${spec.depth_m}x${totalH}m`,
        floors: spec.floors
      },
      trace: {
        tool: 'generate_3d_model',
        label: '三维建筑模型生产 (.OBJ / 3D .DWG)',
        args: { size: `${spec.width_m}×${spec.depth_m}m`, floors: spec.floors },
        summary: `产出三维模型 model3d_${stamp}.obj${fs.existsSync(outDwg) ? ' / .dwg' : ''} (${spec.floors}F, 总高 ${totalH}m)`,
        durationMs: Date.now() - startTime
      }
    };
  }

  if (toolName === 'render_arch_image') {
    const lighting = args.scene_lighting || context.defaultLighting || 'day';
    const imageModel = context.imageModel || '';
    const rawSource = (args.source_file_path || '').trim();
    const instruction = args.render_instruction || 'photorealistic architectural visualization with realistic materials and natural light';

    let beforePublicUrl = null;
    let referenceDiskPath = null;
    let sourceLabel = '纯文字概念生成';
    let fileExt = '';
    let isFollowUpEdit = false;

    if (rawSource) {
      if (rawSource.startsWith('/uploads/')) {
        const candidate = uploadedImagePath(rawSource);
        if (candidate) {
          referenceDiskPath = candidate;
          beforePublicUrl = rawSource;
          sourceLabel = rawSource;
          isFollowUpEdit = true;
        }
      } else {
        const resolvedPath = expandHome(rawSource);
        if (fs.existsSync(resolvedPath)) {
          fileExt = path.extname(resolvedPath).toLowerCase();
          sourceLabel = resolvedPath;
          const parsed = await convertArchFileToPng(resolvedPath);
          referenceDiskPath = parsed.diskPath;
          beforePublicUrl = parsed.publicUrl;
        }
      }
      if (!referenceDiskPath) throw new Error(`参考文件不存在或格式不支持: ${rawSource}`);
    } else if (context.targetImageUrl) {
      const candidate = uploadedImagePath(context.targetImageUrl);
      if (candidate) {
        referenceDiskPath = candidate;
        beforePublicUrl = context.targetImageUrl;
        sourceLabel = context.targetImageUrl;
        isFollowUpEdit = true;
      }
      else throw new Error('指定的参考图片不存在或格式不支持');
    } else if (context.detectedFiles.length > 0) {
      const f = context.detectedFiles[0];
      if (fs.existsSync(f.path)) {
        fileExt = f.ext;
        sourceLabel = f.path;
        const parsed = await convertArchFileToPng(f.path);
        referenceDiskPath = parsed.diskPath;
        beforePublicUrl = parsed.publicUrl;
      }
    } else if (context.lastAssistantImageUrl && !/新建|从头生成|文生图|再来一张全新/.test(instruction)) {
      const candidate = uploadedImagePath(context.lastAssistantImageUrl);
      if (candidate) {
        referenceDiskPath = candidate;
        beforePublicUrl = context.lastAssistantImageUrl;
        sourceLabel = context.lastAssistantImageUrl;
        isFollowUpEdit = true;
      }
    }

    const taskCategory = (fileExt === '.dwg' || fileExt === '.dxf')
      ? 'CAD图纸 → 彩色平面图'
      : (fileExt === '.skp')
        ? `SU白模 → ${lighting === 'night' ? '暗景实景' : '亮景实景'}`
        : isFollowUpEdit
          ? `AI 锁结构精修 (${lighting === 'night' ? '暗景' : '亮景'})`
          : `建筑效果图 (${lighting === 'night' ? '暗景' : '亮景'})`;

    const isPlan = fileExt === '.dwg' || fileExt === '.dxf';
    const enhancedPrompt = buildRenderPrompt({
      instruction,
      hasReference: Boolean(referenceDiskPath),
      isPlan,
      lighting
    });

    const gen = await generateImage({
      modelId: imageModel,
      prompt: enhancedPrompt,
      referenceDiskPath
    });

    const actualModel = gen.modelUsed;
    const shortName = sourceLabel.startsWith('/') ? displayFileName(sourceLabel) : sourceLabel;
    const card = {
      title: `${shortName} · ${taskCategory}`,
      sourceFile: sourceLabel,
      taskType: taskCategory,
      beforeImage: beforePublicUrl,
      afterImage: gen.publicUrl,
      dayImage: lighting === 'day' ? gen.publicUrl : null,
      nightImage: lighting === 'night' ? gen.publicUrl : null,
      sceneMode: lighting,
      agentNote: `由 ${gen.modelLabel}（${actualModel}）生成${lighting === 'night' ? '夜景' : '日景'}图像${referenceDiskPath ? '；以原图为参考，请核对几何与尺寸' : ''}。`,
      promptUsed: enhancedPrompt
    };
    context.results.push(card);

    const durationMs = Date.now() - startTime;
    return {
      output: {
        status: 'ok',
        rendered_image_url: gen.publicUrl,
        before_image_url: beforePublicUrl,
        scene_lighting: lighting,
        model_used: actualModel
      },
      trace: {
        tool: 'render_arch_image',
        label: '建筑视觉渲染 / PS 修图引擎',
        args: { source: shortName, lighting, model: actualModel.split('/').pop() },
        summary: `产出高清渲染图 ${path.basename(gen.publicUrl)} (${taskCategory})`,
        durationMs
      }
    };
  }

  throw new Error(`未知的 Agent 工具: ${toolName}`);
}

module.exports = {
  executeToolCall,
  convertArchFileToPng
};
