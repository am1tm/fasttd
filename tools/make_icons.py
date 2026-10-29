"""Render the fasttD toolbar icons (no dependencies): python3 tools/make_icons.py"""

import os
import struct
import zlib

SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4
RADIUS = 0.22  # corner radius, as a fraction of the icon size
TOP, BOTTOM = (0xFF, 0x9F, 0x1C), (0xF2, 0x4E, 0x0B)  # orange gradient
BOLT = [(0.62, 0.07), (0.25, 0.56), (0.47, 0.56), (0.38, 0.93), (0.76, 0.43), (0.54, 0.43), (0.66, 0.07)]


def in_rounded_square(x, y):
    cx = min(max(x, RADIUS), 1 - RADIUS)
    cy = min(max(y, RADIUS), 1 - RADIUS)
    return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2


def in_polygon(x, y, points):
    inside = False
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def render(size):
    rows = []
    n = SUPERSAMPLE
    for py in range(size):
        row = bytearray([0])  # PNG filter type: none
        for px in range(size):
            bg = bolt = 0
            for sy in range(n):
                for sx in range(n):
                    x, y = (px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size
                    if in_rounded_square(x, y):
                        bg += 1
                        bolt += in_polygon(x, y, BOLT)
            t = py / max(1, size - 1)
            orange = [round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)]
            alpha = bg / n ** 2
            mix = bolt / bg if bg else 0
            rgb = [round(c + (255 - c) * mix) for c in orange]
            row += bytes(rgb + [round(alpha * 255)])
        rows.append(bytes(row))
    return b''.join(rows)


def png(size, pixels):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(pixels, 9)) + chunk(b'IEND', b'')


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(__file__), '..', 'icons')
    for size in SIZES:
        with open(os.path.join(out, f'icon-{size}.png'), 'wb') as f:
            f.write(png(size, render(size)))
