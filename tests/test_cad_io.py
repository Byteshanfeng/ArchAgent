import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import ezdxf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from cad_io import drawing_bounds, load_cad_document
from cad_dwg_generator import process_and_enhance_existing_dwg


class CadIoRegression(unittest.TestCase):
    def test_dxf_uses_entity_geometry(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "sample.dxf"
            doc = ezdxf.new("R2010")
            doc.modelspace().add_line((0, 0), (10000, 8000))
            doc.saveas(source)
            loaded = load_cad_document(source)
            self.assertEqual(len(loaded.modelspace()), 1)
            self.assertEqual(drawing_bounds(loaded), (0.0, 0.0, 10000.0, 8000.0))

    def test_chinese_dxf_layer_names_survive_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "chinese.dxf"
            saved = Path(tmp) / "saved.dxf"
            doc = ezdxf.new("R2004")
            doc.layers.add("EQUIP_地漏")
            doc.modelspace().add_line((0, 0), (10, 10), dxfattribs={"layer": "EQUIP_地漏"})
            doc.header["$DWGCODEPAGE"] = "ANSI_936"
            doc.saveas(source, encoding="gbk")
            source.write_bytes(source.read_bytes().replace(b"ANSI_1252", b"ANSI_936", 1))
            loaded = load_cad_document(source)
            self.assertEqual(loaded.modelspace()[0].dxf.layer, "EQUIP_地漏")
            loaded.saveas(saved)
            self.assertEqual(load_cad_document(saved).modelspace()[0].dxf.layer, "EQUIP_地漏")

    def test_libredwg_zero_handle_can_be_recovered(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "zero.dxf"
            doc = ezdxf.new("R2010")
            doc.modelspace().add_line((0, 0), (10, 10))
            doc.saveas(source)
            raw = source.read_bytes()
            marker = b"  5\n"
            self.assertIn(marker, raw)
            pos = raw.index(marker) + len(marker)
            end = raw.index(b"\n", pos)
            source.write_bytes(raw[:pos] + b"0" + raw[end:])
            loaded = load_cad_document(source)
            self.assertEqual(len(loaded.modelspace()), 1)

    def test_converter_diagnostic_bytes_do_not_block_valid_dwg(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_dxf = Path(tmp) / "source.dxf"
            doc = ezdxf.new("R2010")
            doc.modelspace().add_line((0, 0), (10, 10))
            doc.saveas(source_dxf)
            source_dwg = Path(tmp) / "source.dwg"
            source_dwg.write_bytes(b"test")
            converter = Path(tmp) / "fake-converter"
            converter.write_text(
                f"#!{sys.executable}\n"
                "import pathlib,sys\n"
                f"pathlib.Path(sys.argv[sys.argv.index('-o')+1]).write_bytes(pathlib.Path({str(source_dxf)!r}).read_bytes())\n"
                "sys.stderr.buffer.write(b'warning: \\x89\\n')\n"
            )
            converter.chmod(0o755)
            with patch.dict(os.environ, {"DWG2DXF_BIN": str(converter)}):
                self.assertEqual(len(load_cad_document(source_dwg).modelspace()), 1)

    def test_failed_dwg_conversion_keeps_verified_dxf_and_preview(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "input.dxf"
            dxf = Path(tmp) / "result.dxf"
            dwg = Path(tmp) / "result.dwg"
            png = Path(tmp) / "result.png"
            doc = ezdxf.new("R2010")
            doc.modelspace().add_line((0, 0), (1000, 800))
            doc.saveas(source)
            with patch.dict(os.environ, {"DXF2DWG_BIN": "/usr/bin/false"}):
                warning = process_and_enhance_existing_dwg(source, dxf, dwg, png)
            self.assertIn("DXF 转 DWG 失败", warning)
            self.assertFalse(dwg.exists())
            self.assertTrue(png.is_file())
            self.assertEqual(len(load_cad_document(dxf).modelspace()), 12)


if __name__ == "__main__":
    unittest.main()
