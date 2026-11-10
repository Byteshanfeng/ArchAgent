import re
import sys
from PIL import Image, ImageDraw

svg_path = sys.argv[1]
out_png = sys.argv[2]
bg_color = (18, 22, 28)

segments = []
coord_re = re.compile(r'([ML])\s*(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)')
circle_re = re.compile(r'<circle[^>]*cx="(-?\d+(?:\.\d+)?)"[^>]*cy="(-?\d+(?:\.\d+)?)"[^>]*r="(-?\d+(?:\.\d+)?)"')
stroke_re = re.compile(r'stroke:([^;"]+)')

xs, ys = [], []

with open(svg_path, 'r', encoding='utf-8', errors='ignore') as f:
    in_defs = False
    for line in f:
        if '<defs>' in line:
            in_defs = True
        elif '</defs>' in line:
            in_defs = False
        if in_defs:
            continue

        if '<path ' in line or 'd="M' in line:
            pts = coord_re.findall(line)
            if len(pts) >= 2:
                sm = stroke_re.search(line)
                color = sm.group(1).strip() if sm else 'white'
                poly = []
                for cmd, x_s, y_s in pts:
                    x, y = float(x_s), float(y_s)
                    if abs(x) > 1e-3 or abs(y) > 1e-3:
                        xs.append(x)
                        ys.append(y)
                    poly.append((x, y))
                segments.append((poly, color))

print(f"Loaded {len(segments)} paths, {len(xs)} points from {svg_path}")
if not xs:
    sys.exit(1)

xs_sorted = sorted(xs)
ys_sorted = sorted(ys)
n = len(xs_sorted)

# Find dense cluster (5th to 95th percentile around median)
q10_x, q50_x, q90_x = xs_sorted[int(n*0.05)], xs_sorted[int(n*0.5)], xs_sorted[int(n*0.95)]
q10_y, q50_y, q90_y = ys_sorted[int(n*0.05)], ys_sorted[int(n*0.5)], ys_sorted[int(n*0.95)]

# Filter points near the main site cluster
inlier_x = [x for x in xs_sorted if q10_x <= x <= q90_x]
inlier_y = [y for y in ys_sorted if q10_y <= y <= q90_y]

min_x, max_x = min(inlier_x), max(inlier_x)
min_y, max_y = min(inlier_y), max(inlier_y)
span_x = max(max_x - min_x, 1.0)
span_y = max(max_y - min_y, 1.0)

# Expand margin by 8%
min_x -= span_x * 0.08
max_x += span_x * 0.08
min_y -= span_y * 0.08
max_y += span_y * 0.08
span_x = max_x - min_x
span_y = max_y - min_y

print(f"Cluster bounds: X=[{min_x:.1f}, {max_x:.1f}], Y=[{min_y:.1f}, {max_y:.1f}]")

W = 2000
H = int(W * (span_y / span_x))
H = max(1200, min(2400, H))

scale = min((W - 80) / span_x, (H - 80) / span_y)
pad_x = (W - span_x * scale) / 2
pad_y = (H - span_y * scale) / 2

img = Image.new('RGB', (W, H), bg_color)
draw = ImageDraw.Draw(img)

COLOR_MAP = {
    'black': (220, 230, 242),
    'white': (235, 240, 245),
    'red': (248, 113, 113),
    'yellow': (250, 204, 21),
    'green': (74, 222, 128),
    'cyan': (56, 189, 248),
    'blue': (96, 165, 250),
    'magenta': (232, 121, 249),
}

def parse_color(c):
    c = c.lower()
    if c in COLOR_MAP:
        return COLOR_MAP[c]
    if c.startswith('#') and len(c) == 7:
        try:
            r = int(c[1:3], 16)
            g = int(c[3:5], 16)
            b = int(c[5:7], 16)
            if r < 40 and g < 40 and b < 40:
                return (210, 220, 230)
            return (r, g, b)
        except Exception:
            pass
    return (200, 215, 230)

drawn = 0
for poly, col in segments:
    # Check if segment is within cluster bounds
    px0, py0 = poly[0]
    if not (min_x <= px0 <= max_x and min_y <= py0 <= max_y):
        continue
    pts_px = []
    for x, y in poly:
        if not (min_x - span_x*0.5 <= x <= max_x + span_x*0.5 and min_y - span_y*0.5 <= y <= max_y + span_y*0.5):
            continue
        sx = pad_x + (x - min_x) * scale
        sy = H - (pad_y + (y - min_y) * scale)
        pts_px.append((sx, sy))
    if len(pts_px) >= 2:
        draw.line(pts_px, fill=parse_color(col), width=2)
        drawn += 1

print(f"Drawn {drawn} polylines -> {out_png}")
img.save(out_png)
