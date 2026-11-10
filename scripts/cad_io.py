"""Read CAD entities without treating an SVG preview as engineering geometry."""

import math
import os
import re
import shutil
import subprocess
import tempfile
import codecs
from pathlib import Path

import ezdxf
from ezdxf import bbox


def _repair_zero_handles(source, target):
    """LibreDWG can emit an entity handle of 0, which ezdxf rejects."""
    data = Path(source).read_bytes()
    pattern = rb"(?m)(^ *(?:5|105)\r?\n)([0-9A-Fa-f]+)(?=\r?\n)"
    handles = [int(match.group(2), 16) for match in re.finditer(pattern, data)]
    next_handle = max(handles, default=0) + 1
    repaired = False
    def replace(match):
        nonlocal next_handle, repaired
        if match.group(2) == b"0":
            next_handle += 1
            repaired = True
            return match.group(1) + f"{next_handle - 1:X}".encode()
        return match.group(0)
    result = re.sub(pattern, replace, data)
    if repaired:
        Path(target).write_bytes(result)
    return repaired


def _dxf_encoding(source):
    """Respect Chinese DWG code pages; use UTF-8 for mislabelled LibreDWG output."""
    with open(source, 'rb') as stream:
        header = stream.read(16384)
    match = re.search(rb'\$DWGCODEPAGE\r?\n\s*3\r?\n([^\r\n]+)', header)
    if not match or match.group(1).strip() != b'ANSI_1252':
        return None
    decoder = codecs.getincrementaldecoder('utf-8')()
    try:
        with open(source, 'rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                decoder.decode(chunk)
        decoder.decode(b'', final=True)
        return 'utf-8'
    except UnicodeDecodeError:
        return None


def load_cad_document(filepath):
    path = Path(filepath)
    ext = path.suffix.lower()
    if ext not in (".dwg", ".dxf"):
        raise ValueError(f"不支持的 CAD 格式: {ext}")
    if not path.is_file():
        raise FileNotFoundError(filepath)

    with tempfile.TemporaryDirectory(prefix="arch-agent-cad-") as temp_dir:
        source = path
        if ext == ".dwg":
            converter = os.environ.get("DWG2DXF_BIN") or shutil.which("dwg2dxf")
            if not converter:
                raise RuntimeError("未找到 dwg2dxf，请安装 LibreDWG")
            source = Path(temp_dir) / "converted.dxf"
            run = subprocess.run([converter, "-y", "-o", str(source), str(path)],
                                 capture_output=True, text=True, errors="replace", timeout=90)
            if run.returncode != 0 or not source.is_file() or source.stat().st_size == 0:
                raise RuntimeError(f"DWG 转 DXF 失败: {(run.stderr or run.stdout).strip()[-300:]}")

        encoding = _dxf_encoding(source)
        try:
            doc = ezdxf.readfile(source, encoding=encoding, errors="replace")
        except ValueError as exc:
            if "Invalid handle 0" not in str(exc):
                raise RuntimeError(f"CAD 图纸读取失败: {exc}") from exc
            repaired = Path(temp_dir) / "repaired.dxf"
            if not _repair_zero_handles(source, repaired):
                raise RuntimeError(f"CAD 图纸读取失败: {exc}") from exc
            doc = ezdxf.readfile(repaired, encoding=encoding, errors="replace")
        except Exception as exc:
            raise RuntimeError(f"CAD 图纸读取失败: {exc}") from exc
        if len(doc.modelspace()) == 0:
            raise RuntimeError("CAD 图纸没有可读取的模型空间图元")
        return doc


def drawing_bounds(doc):
    box = bbox.extents(doc.modelspace(), fast=True)
    if not box.has_data:
        raise RuntimeError("CAD 图纸没有可测量的几何范围")
    values = (box.extmin.x, box.extmin.y, box.extmax.x, box.extmax.y)
    if not all(math.isfinite(v) and abs(v) < 1e15 for v in values):
        raise RuntimeError("CAD 图纸的几何坐标无效")
    min_x, min_y, max_x, max_y = values
    if max_x <= min_x or max_y <= min_y:
        raise RuntimeError("CAD 图纸的几何范围为空")
    return min_x, min_y, max_x, max_y
