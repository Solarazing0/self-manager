"""Build PNG fallbacks for the vector application icon with the Python standard library."""

from pathlib import Path
from struct import pack
from zlib import compress, crc32


def chunk(kind, data):
    return pack(">I", len(data)) + kind + data + pack(">I", crc32(kind + data))


def pixel(x, y):
    nearest_x = max(42, min(150, x))
    nearest_y = max(42, min(150, y))
    if (x - nearest_x) ** 2 + (y - nearest_y) ** 2 > 42 ** 2:
        return bytes((0, 0, 0, 0))
    if (64 <= x < 84 and 54 <= y < 142) or (84 <= x < 130 and 124 <= y < 142):
        return bytes((255, 255, 255, 255))
    if (x - 120) ** 2 + (y - 69) ** 2 <= 13 ** 2:
        return bytes((184, 221, 189, 255))
    return bytes((35, 91, 67, 255))


app = Path(__file__).resolve().parents[1] / "app"
for size in (192, 512):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            rows.extend(pixel((x + 0.5) * 192 / size, (y + 0.5) * 192 / size))
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", compress(rows, 9)) + chunk(b"IEND", b"")
    (app / f"icon-{size}.png").write_bytes(png)
