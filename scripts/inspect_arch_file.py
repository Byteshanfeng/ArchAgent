#!/usr/bin/env python3
import sys
import os
import re
import json
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from cad_io import load_cad_document, drawing_bounds

DWG_VERSIONS = {
    'AC1012': 'AutoCAD R13',
    'AC1014': 'AutoCAD R14',
    'AC1015': 'AutoCAD 2000',
    'AC1018': 'AutoCAD 2004',
    'AC1021': 'AutoCAD 2007',
    'AC1024': 'AutoCAD 2010',
    'AC1027': 'AutoCAD 2013',
    'AC1032': 'AutoCAD 2018+',
}

def inspect_dwg(filepath):
    size_kb = round(os.path.getsize(filepath) / 1024.0, 1)
    doc = load_cad_document(filepath)
    min_x, min_y, max_x, max_y = drawing_bounds(doc)
    span_x = round(max_x - min_x, 1)
    span_y = round(max_y - min_y, 1)
    has_drift = abs(min_x) > 500000 or abs(min_y) > 500000

    # Estimate meters (if span > 2000, units are likely mm; else meters)
    unit_guess = "mm" if max(span_x, span_y) > 2500 else "m"
    width_m = round(span_x / 1000.0, 1) if unit_guess == "mm" else round(span_x, 1)
    depth_m = round(span_y / 1000.0, 1) if unit_guess == "mm" else round(span_y, 1)

    return {
        "status": "ok",
        "file_name": os.path.basename(filepath),
        "format": DWG_VERSIONS.get(doc.dxfversion, doc.acad_release),
        "size_kb": size_kb,
        "entity_count": len(doc.modelspace()),
        "coord_drift_detected": has_drift,
        "coord_origin_sample": [round(min_x, 1), round(min_y, 1)],
        "span_raw": [span_x, span_y],
        "unit_guess": unit_guess,
        "estimated_dimensions_m": f"{width_m}m × {depth_m}m",
        "measurement_note": "尺寸为图中所有图元的外接范围，不是建筑轮廓或用地红线面积"
    }

def inspect_skp(filepath):
    size_mb = round(os.path.getsize(filepath) / (1024.0 * 1024.0), 2)
    with open(filepath, 'rb') as f:
        data = f.read(256)
        full = data + f.read()

    ver_str = "SketchUp Model"
    # Extract UTF-16LE version string like {26.0.428}
    decoded = data.decode('utf-16le', errors='ignore')
    m = re.search(r'\{(\d+\.\d+\.\d+)\}', decoded)
    if m:
        ver_num = m.group(1)
        major = int(ver_num.split('.')[0])
        yr = 2000 + major if major >= 20 else major
        ver_str = f"SketchUp {yr} ({ver_num})"

    png_start = full.find(b'\x89PNG\r\n\x1a\n')
    has_preview = png_start != -1

    return {
        "status": "ok",
        "file_name": os.path.basename(filepath),
        "format": ver_str,
        "size_mb": size_mb,
        "has_embedded_viewport": has_preview,
        "recommendation": "可提取文件内置预览图作为效果图参考；不读取 SKP 三维构件，生成结果需核对"
    }

def inspect_obj(filepath):
    vertices = []
    faces = 0
    with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            if line.startswith('v '):
                parts = line.split()
                if len(parts) >= 4:
                    vertices.append(tuple(float(v) for v in parts[1:4]))
            elif line.startswith('f '):
                faces += 1
    if not vertices:
        raise ValueError("OBJ 文件没有顶点")
    bounds = [[round(min(p[i] for p in vertices), 3), round(max(p[i] for p in vertices), 3)] for i in range(3)]
    return {"status": "ok", "file_name": os.path.basename(filepath), "format": "Wavefront OBJ",
            "vertex_count": len(vertices), "face_count": faces, "bounds_raw": bounds,
            "measurement_note": "OBJ 单位由建模软件决定，文件本身未声明单位"}

def inspect_image(filepath):
    im = Image.open(filepath)
    return {
        "status": "ok",
        "file_name": os.path.basename(filepath),
        "format": f"Image ({im.format})",
        "resolution": f"{im.width}×{im.height}",
        "mode": im.mode
    }

if __name__ == '__main__':
    fp = sys.argv[1]
    if not os.path.exists(fp):
        print(json.dumps({"status": "error", "message": f"文件不存在: {fp}"}, ensure_ascii=False))
        sys.exit(0)
    ext = os.path.splitext(fp)[1].lower()
    try:
        if ext in ('.dwg', '.dxf'):
            res = inspect_dwg(fp)
        elif ext == '.skp':
            res = inspect_skp(fp)
        elif ext == '.obj':
            res = inspect_obj(fp)
        else:
            res = inspect_image(fp)
    except Exception as exc:
        res = {"status": "error", "message": str(exc), "file_name": os.path.basename(fp)}
    print(json.dumps(res, ensure_ascii=False))
