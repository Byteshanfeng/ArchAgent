import sys
import os

skp_path = sys.argv[1]
out_png = sys.argv[2]

with open(skp_path, 'rb') as f:
    data = f.read()

png_start = data.find(b'\x89PNG\r\n\x1a\n')
if png_start != -1:
    iend = data.find(b'IEND', png_start)
    if iend != -1:
        png_data = data[png_start:iend+8]
        with open(out_png, 'wb') as out:
            out.write(png_data)
        print(f"Extracted PNG from SKP: {len(png_data)} bytes -> {out_png}")
else:
    print("No PNG found in SKP")
