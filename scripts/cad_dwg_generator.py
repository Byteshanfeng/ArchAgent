#!/usr/bin/env python3
import sys
import os
import json
import math
import subprocess
import shutil
import ezdxf
from ezdxf import transform
from ezdxf.math import Matrix44
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, os.path.dirname(__file__))
from cad_io import load_cad_document, drawing_bounds

def dxf_to_dwg(dxf_path, dwg_path, expected_entities):
    if os.path.exists(dwg_path):
        os.remove(dwg_path)
    converter = os.environ.get('DXF2DWG_BIN') or shutil.which('dxf2dwg')
    if not converter:
        raise RuntimeError('未找到 dxf2dwg，请安装 LibreDWG')
    try:
        run = subprocess.run(
            [converter, '-y', '-o', dwg_path, dxf_path],
            capture_output=True, text=True, errors='replace', timeout=180
        )
    except subprocess.TimeoutExpired as exc:
        if os.path.exists(dwg_path):
            os.remove(dwg_path)
        raise RuntimeError('DXF 转 DWG 超时（180 秒），图纸可能过大或含转换器不支持的图元') from exc
    if run.returncode != 0 or not os.path.exists(dwg_path) or os.path.getsize(dwg_path) <= 100:
        if os.path.exists(dwg_path):
            os.remove(dwg_path)
        raise RuntimeError(f"DXF 转 DWG 失败: {(run.stderr or run.stdout).strip()[-300:]}")
    try:
        actual = len(load_cad_document(dwg_path).modelspace())
        if actual != expected_entities:
            raise RuntimeError(f'DWG 回读图元数 {actual} 与 DXF 的 {expected_entities} 不一致')
    except Exception as exc:
        os.remove(dwg_path)
        raise RuntimeError(f'DWG 输出无法验证，已删除不完整成果: {exc}') from exc


def save_verified_dxf(doc, dxf_path):
    expected = len(doc.modelspace())
    doc.saveas(dxf_path)
    try:
        actual = len(load_cad_document(dxf_path).modelspace())
        if actual != expected:
            raise RuntimeError(f'DXF 回读图元数 {actual} 与原图的 {expected} 不一致')
    except Exception as exc:
        os.remove(dxf_path)
        raise RuntimeError(f'DXF 输出无法验证，已删除不完整成果: {exc}') from exc
    return expected

def render_dxf_preview(doc, out_png, title_text="AI Generated CAD Drawing (.DWG)"):
    msp = doc.modelspace()
    lines = [] # (pts, rgb, width)

    ACI_COLORS = {
        1: (255, 85, 85),    # Red (Axis / Redline / AI New)
        2: (250, 215, 60),   # Yellow (Partitions / Highlights)
        3: (80, 235, 130),   # Green (Doors / Windows / Landscape)
        4: (70, 210, 245),   # Cyan (Glass / Stairs / Water)
        5: (100, 160, 255),  # Blue
        6: (235, 110, 245),  # Magenta (Setback / Design)
        7: (235, 240, 245),  # White (Walls)
        8: (140, 150, 165),  # Grey (Grid / Hatch)
        9: (180, 190, 205),
    }

    layer_colors = {}
    for layer in doc.layers:
        layer_colors[layer.dxf.name] = ACI_COLORS.get(abs(layer.color), (225, 232, 240))

    texts = [] # (x, y, text, rgb)

    for e in msp:
        etype = e.dxftype()
        lname = e.dxf.layer if e.dxf.hasattr('layer') else '0'
        col = ACI_COLORS.get(e.dxf.color, layer_colors.get(lname, (225, 232, 240))) if e.dxf.hasattr('color') and e.dxf.color != 256 else layer_colors.get(lname, (225, 232, 240))
        w = 3 if 'WALL' in lname or 'REDLINE' in lname or 'AI-BLDG' in lname else 2

        if etype == 'LINE':
            s, end = e.dxf.start, e.dxf.end
            lines.append(([(s.x, s.y), (end.x, end.y)], col, w))
        elif etype == 'LWPOLYLINE':
            pts = [(p[0], p[1]) for p in e.get_points()]
            if e.closed and len(pts) > 2:
                pts.append(pts[0])
            if len(pts) >= 2:
                lines.append((pts, col, w))
        elif etype == 'CIRCLE':
            cx, cy, r = e.dxf.center.x, e.dxf.center.y, e.dxf.radius
            pts = [(cx + r * math.cos(a), cy + r * math.sin(a)) for a in [i * 2 * math.pi / 32 for i in range(33)]]
            lines.append((pts, col, 2))
        elif etype == 'ARC':
            cx, cy, r = e.dxf.center.x, e.dxf.center.y, e.dxf.radius
            sa = math.radians(e.dxf.start_angle)
            ea = math.radians(e.dxf.end_angle)
            if ea < sa:
                ea += 2 * math.pi
            steps = 20
            pts = [(cx + r * math.cos(sa + (ea - sa) * i / steps), cy + r * math.sin(sa + (ea - sa) * i / steps)) for i in range(steps + 1)]
            lines.append((pts, col, 2))
        elif etype == 'TEXT':
            ins = e.dxf.insert
            texts.append((ins.x, ins.y, e.dxf.text, col))

    all_x = [x for pts, _, _ in lines for x, y in pts]
    all_y = [y for pts, _, _ in lines for x, y in pts]
    if not all_x:
        return

    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)
    span_x = max(max_x - min_x, 1.0)
    span_y = max(max_y - min_y, 1.0)

    min_x -= span_x * 0.08
    max_x += span_x * 0.08
    min_y -= span_y * 0.08
    max_y += span_y * 0.08
    span_x = max_x - min_x
    span_y = max_y - min_y

    W = 1920
    H = int(W * (span_y / span_x))
    H = max(1150, min(1920, H))
    scale = min((W - 100) / span_x, (H - 120) / span_y)
    pad_x = (W - span_x * scale) / 2
    pad_y = (H - span_y * scale) / 2

    img = Image.new('RGB', (W, H), (14, 18, 24))
    draw = ImageDraw.Draw(img)

    # Subtle CAD viewport grid
    for gx in range(0, W, 80):
        draw.line([(gx, 0), (gx, H)], fill=(22, 28, 38), width=1)
    for gy in range(0, H, 80):
        draw.line([(0, gy), (W, gy)], fill=(22, 28, 38), width=1)

    for pts, col, w in lines:
        px_pts = [(pad_x + (x - min_x) * scale, H - (pad_y + (y - min_y) * scale)) for x, y in pts]
        if len(px_pts) >= 2:
            draw.line(px_pts, fill=col, width=w)

    try:
        font = ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc", 16)
        title_font = ImageFont.truetype("/System/Library/Fonts/STHeiti Medium.ttc", 22)
    except Exception:
        font = ImageFont.load_default()
        title_font = font

    for tx, ty, tstr, col in texts[:200]:
        sx = pad_x + (tx - min_x) * scale
        sy = H - (pad_y + (ty - min_y) * scale) - 10
        draw.text((sx, sy), tstr, fill=col, font=font)

    # Top CAD Title Bar
    draw.rectangle([(24, 20), (W - 24, 64)], fill=(20, 26, 36), outline=(55, 65, 85), width=1)
    draw.text((40, 30), f"AutoCAD DWG/DXF Vector Output  |  {title_text}", fill=(230, 238, 248), font=title_font)

    img.save(out_png)

def build_parametric_floorplan_dxf(spec, dxf_path, dwg_path, preview_png):
    """
    Creates a genuine multi-layer architectural AutoCAD .dwg/.dxf floor plan
    with column grids, double walls, core elevators/stairs, doors/windows, rooms & dimensions.
    """
    doc = ezdxf.new('R2010')
    doc.header['$INSUNITS'] = 4  # millimeters
    msp = doc.modelspace()

    # Standard Architectural CAD Layers (AIA / TArch standard)
    layers_cfg = [
        ('A-AXIS', 1),        # Red: Column grid axis
        ('A-WALL', 7),        # White: Structural & exterior walls
        ('A-WALL-PART', 2),   # Yellow: Interior partition walls
        ('A-WIND', 4),        # Cyan: Windows & glass curtain wall
        ('A-DOOR', 3),        # Green: Doors & swing arcs
        ('A-CORE-STAIR', 4),  # Cyan: Stairs & elevators
        ('A-DIM', 3),         # Green: Dimensions & axis bubbles
        ('A-TEXT', 2),        # Yellow: Room names & area tags
        ('A-REDLINE', 6),     # Magenta: Site setback / boundary
    ]
    for name, color in layers_cfg:
        if name not in doc.layers:
            doc.layers.add(name, color=color)

    b_width = float(spec.get('width_mm', 33600))   # default 33.6m (4 bays x 8.4m)
    b_depth = float(spec.get('depth_mm', 18000))   # default 18.0m
    bays_x = int(spec.get('bays_x', 4))
    bays_y = int(spec.get('bays_y', 2))
    wall_t = 240.0
    title = spec.get('title', 'AI 生成标准层建筑平面图')

    dx = b_width / bays_x
    dy = b_depth / bays_y

    # 1. Column Grid Axis (A-AXIS) + Axis Numbers & Bubbles
    ext = 3200.0
    for i in range(bays_x + 1):
        x = i * dx
        msp.add_line((x, -ext), (x, b_depth + ext), dxfattribs={'layer': 'A-AXIS'})
        msp.add_circle((x, -ext - 700), 500, dxfattribs={'layer': 'A-DIM'})
        msp.add_text(str(i + 1), dxfattribs={'layer': 'A-TEXT', 'height': 450, 'insert': (x - 160, -ext - 880)})
        if i < bays_x:
            # Bay dimension line
            msp.add_line((x, -ext * 0.65), (x + dx, -ext * 0.65), dxfattribs={'layer': 'A-DIM'})
            msp.add_text(f"{int(dx)}", dxfattribs={'layer': 'A-DIM', 'height': 360, 'insert': (x + dx * 0.38, -ext * 0.60)})

    axis_letters = ['A', 'B', 'C', 'D', 'E', 'F']
    for j in range(bays_y + 1):
        y = j * dy
        msp.add_line((-ext, y), (b_width + ext, y), dxfattribs={'layer': 'A-AXIS'})
        msp.add_circle((-ext - 700, y), 500, dxfattribs={'layer': 'A-DIM'})
        lbl = axis_letters[j] if j < len(axis_letters) else f"Y{j+1}"
        msp.add_text(lbl, dxfattribs={'layer': 'A-TEXT', 'height': 450, 'insert': (-ext - 860, y - 180)})
        if j < bays_y:
            msp.add_line((-ext * 0.65, y), (-ext * 0.65, y + dy), dxfattribs={'layer': 'A-DIM'})
            msp.add_text(f"{int(dy)}", dxfattribs={'layer': 'A-DIM', 'height': 360, 'insert': (-ext * 0.95, y + dy * 0.45)})

    # Total outer dimension
    msp.add_line((0, -ext * 0.90), (b_width, -ext * 0.90), dxfattribs={'layer': 'A-DIM'})
    msp.add_text(f"总长 {int(b_width)}mm", dxfattribs={'layer': 'A-DIM', 'height': 420, 'insert': (b_width * 0.44, -ext * 0.86)})

    # 2. Structural Columns (600x600mm at grid intersections)
    col_r = 300.0
    for i in range(bays_x + 1):
        for j in range(bays_y + 1):
            cx, cy = i * dx, j * dy
            msp.add_lwpolyline(
                [(cx - col_r, cy - col_r), (cx + col_r, cy - col_r), (cx + col_r, cy + col_r), (cx - col_r, cy + col_r)],
                close=True,
                dxfattribs={'layer': 'A-WALL'}
            )

    # 3. Double-Line Exterior Perimeter Wall + Curtain Wall Windows
    msp.add_lwpolyline([(0, 0), (b_width, 0), (b_width, b_depth), (0, b_depth)], close=True, dxfattribs={'layer': 'A-WALL'})
    msp.add_lwpolyline(
        [(wall_t, wall_t), (b_width - wall_t, wall_t), (b_width - wall_t, b_depth - wall_t), (wall_t, b_depth - wall_t)],
        close=True,
        dxfattribs={'layer': 'A-WALL'}
    )

    # Window glazing lines along South (y=0) and North (y=b_depth) facades
    for i in range(bays_x):
        wx1 = i * dx + 900
        wx2 = (i + 1) * dx - 900
        if wx2 > wx1:
            for offset in (80, 160):
                msp.add_line((wx1, offset), (wx2, offset), dxfattribs={'layer': 'A-WIND'})
                msp.add_line((wx1, b_depth - offset), (wx2, b_depth - offset), dxfattribs={'layer': 'A-WIND'})

    # 4. Central Circulation Corridor (2.4m wide along center)
    corr_y1 = b_depth * 0.5 - 1200
    corr_y2 = b_depth * 0.5 + 1200
    msp.add_line((wall_t, corr_y1), (b_width - wall_t, corr_y1), dxfattribs={'layer': 'A-WALL-PART'})
    msp.add_line((wall_t, corr_y2), (b_width - wall_t, corr_y2), dxfattribs={'layer': 'A-WALL-PART'})

    # 5. Room Partitions, Doors (with 90-deg swing arcs), Core Stairs & Elevators
    rooms = spec.get('rooms', [])
    for i in range(bays_x):
        x1 = i * dx
        x2 = (i + 1) * dx
        if i > 0:
            # Partition wall South & North
            msp.add_line((x1, wall_t), (x1, corr_y1), dxfattribs={'layer': 'A-WALL-PART'})
            msp.add_line((x1 + 120, wall_t), (x1 + 120, corr_y1), dxfattribs={'layer': 'A-WALL-PART'})
            msp.add_line((x1, corr_y2), (x1, b_depth - wall_t), dxfattribs={'layer': 'A-WALL-PART'})
            msp.add_line((x1 + 120, corr_y2), (x1 + 120, b_depth - wall_t), dxfattribs={'layer': 'A-WALL-PART'})

        # Door on South room opening into South room
        door_x = x1 + 1200
        door_w = 1000
        msp.add_line((door_x, corr_y1), (door_x, corr_y1 - door_w), dxfattribs={'layer': 'A-DOOR'})
        msp.add_arc((door_x, corr_y1), door_w, 270, 360, dxfattribs={'layer': 'A-DOOR'})

        # North zone: if middle bay, draw Core Staircase & Elevator shafts!
        if i == bays_x // 2:
            # Staircase steps
            st_x1 = x1 + 600
            st_x2 = x1 + dx * 0.48
            for s_idx in range(10):
                sy = corr_y2 + 600 + s_idx * ((b_depth - corr_y2 - 1400) / 10.0)
                msp.add_line((st_x1, sy), (st_x2, sy), dxfattribs={'layer': 'A-CORE-STAIR'})
            msp.add_lwpolyline([(st_x1, corr_y2 + 600), (st_x2, corr_y2 + 600), (st_x2, b_depth - 800), (st_x1, b_depth - 800)], close=True, dxfattribs={'layer': 'A-CORE-STAIR'})
            msp.add_text("防烟楼梯间", dxfattribs={'layer': 'A-TEXT', 'height': 320, 'insert': (st_x1 + 200, corr_y2 + 250)})

            # Elevator shaft with X cross
            el_x1 = x1 + dx * 0.55
            el_x2 = x2 - 600
            el_y1 = corr_y2 + 600
            el_y2 = corr_y2 + 3000
            msp.add_lwpolyline([(el_x1, el_y1), (el_x2, el_y1), (el_x2, el_y2), (el_x1, el_y2)], close=True, dxfattribs={'layer': 'A-CORE-STAIR'})
            msp.add_line((el_x1, el_y1), (el_x2, el_y2), dxfattribs={'layer': 'A-CORE-STAIR'})
            msp.add_line((el_x1, el_y2), (el_x2, el_y1), dxfattribs={'layer': 'A-CORE-STAIR'})
            msp.add_text("电梯厅/井道", dxfattribs={'layer': 'A-TEXT', 'height': 320, 'insert': (el_x1 + 200, el_y2 + 350)})
        else:
            # Door on North room
            msp.add_line((door_x, corr_y2), (door_x, corr_y2 + door_w), dxfattribs={'layer': 'A-DOOR'})
            msp.add_arc((door_x, corr_y2), door_w, 0, 90, dxfattribs={'layer': 'A-DOOR'})
            n_label = rooms[i % len(rooms)] if rooms else f"北向空间 N-{i+1}"
            area_n = round((dx / 1000.0) * ((b_depth - corr_y2) / 1000.0), 1)
            msp.add_text(f"{n_label} ({area_n}m2)", dxfattribs={'layer': 'A-TEXT', 'height': 360, 'insert': (x1 + dx * 0.20, corr_y2 + (b_depth - corr_y2) * 0.48)})

        s_label = rooms[(i + 2) % len(rooms)] if rooms else f"南向主空间 S-{i+1}"
        area_s = round((dx / 1000.0) * (corr_y1 / 1000.0), 1)
        msp.add_text(f"{s_label} ({area_s}m2)", dxfattribs={'layer': 'A-TEXT', 'height': 360, 'insert': (x1 + dx * 0.20, corr_y1 * 0.48)})

    # Setback Redline around building
    sb = 3000.0
    msp.add_lwpolyline([(-sb, -sb), (b_width + sb, -sb), (b_width + sb, b_depth + sb), (-sb, b_depth + sb)], close=True, dxfattribs={'layer': 'A-REDLINE'})
    msp.add_text(f"图纸名称: {title}  (比例 1:100, 单位 mm)", dxfattribs={'layer': 'A-TEXT', 'height': 520, 'insert': (0, b_depth + ext + 900)})

    expected_entities = save_verified_dxf(doc, dxf_path)
    dxf_to_dwg(dxf_path, dwg_path, expected_entities)
    render_dxf_preview(doc, preview_png, title_text=title)

def process_and_enhance_existing_dwg(src_dwg, dxf_path, dwg_path, preview_png, title_text="CAD 坐标归零修复与 AI 建筑强排加工图"):
    """Shift source entities to a local origin and add clearly illustrative overlays."""
    doc = load_cad_document(src_dwg)
    min_x, min_y, max_x, max_y = drawing_bounds(doc)
    span_x, span_y = max_x - min_x, max_y - min_y
    msp = doc.modelspace()
    errors = transform.inplace(msp, Matrix44.translate(-min_x, -min_y, 0))
    if len(errors):
        raise RuntimeError(f"源图有 {len(errors)} 个图元无法安全平移，已停止加工")
    for name, color in [('AI-REDLINE-SETBACK', 1), ('AI-BLDG-MASSING', 2),
                        ('AI-GRID-AXIS', 4), ('AI-ANNOTATION', 3)]:
        if name not in doc.layers:
            doc.layers.add(name, color=color)

    # Illustrative layout within the drawing bounds, not a legal site boundary.
    pad_x, pad_y = span_x * 0.08, span_y * 0.08
    msp.add_lwpolyline(
        [(pad_x, pad_y), (span_x - pad_x, pad_y), (span_x - pad_x, span_y - pad_y), (pad_x, span_y - pad_y)],
        close=True,
        dxfattribs={'layer': 'AI-REDLINE-SETBACK'}
    )

    # Add 3 AI-planned architectural building footprints + grid lines in center
    bw = span_x * 0.18
    bh = span_y * 0.12
    for idx in range(3):
        bx = span_x * (0.22 + idx * 0.22)
        by = span_y * 0.42
        msp.add_lwpolyline(
            [(bx, by), (bx + bw, by), (bx + bw, by + bh), (bx, by + bh)],
            close=True,
            dxfattribs={'layer': 'AI-BLDG-MASSING'}
        )
        msp.add_line((bx, by), (bx + bw, by + bh), dxfattribs={'layer': 'AI-GRID-AXIS'})
        msp.add_text(f"AI-排布楼栋 #{idx+1}", dxfattribs={'layer': 'AI-ANNOTATION', 'height': max(span_x * 0.015, 300), 'insert': (bx, by + bh * 1.15)})

    msp.add_text(
        "方案示意：原图图元整体平移至局部原点；退线与楼栋仅按图幅范围布置，未经用地边界或规范校核",
        dxfattribs={'layer': 'AI-ANNOTATION', 'height': max(span_x * 0.016, 400), 'insert': (0, span_y * 1.03)}
    )

    expected_entities = save_verified_dxf(doc, dxf_path)
    dwg_error = ''
    try:
        dxf_to_dwg(dxf_path, dwg_path, expected_entities)
    except RuntimeError as exc:
        dwg_error = str(exc)
    render_dxf_preview(doc, preview_png, title_text=title_text)
    return dwg_error

if __name__ == '__main__':
    mode = sys.argv[1] # 'parametric' or 'enhance_dwg'
    if mode == 'parametric':
        spec_json = json.loads(sys.argv[2])
        build_parametric_floorplan_dxf(spec_json, sys.argv[3], sys.argv[4], sys.argv[5])
        print("OK")
    elif mode == 'enhance_dwg':
        dwg_error = process_and_enhance_existing_dwg(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])
        print(f"DXF_ONLY:{dwg_error}" if dwg_error else "OK")
