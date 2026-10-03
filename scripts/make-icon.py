#!/usr/bin/env python3
"""Generates images/icon.png: a 256x256 green (#0b7a4b) rounded square with a white lightning bolt.
Original artwork drawn from plain polygons; no third-party art. Needs Pillow."""
import os
from PIL import Image, ImageDraw

SIZE = 256
SCALE = 4                     # draw at 1024 px, then downsample for clean edges
S = SIZE * SCALE
GREEN = (0x0B, 0x7A, 0x4B, 255)
WHITE = (255, 255, 255, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=GREEN)

# Bolt, in a 256-unit design grid (y grows downward).
bolt = [(148, 28), (68, 142), (118, 142), (96, 228), (190, 106), (138, 106), (164, 28)]
d.polygon([(x * SCALE, y * SCALE) for x, y in bolt], fill=WHITE)

out = img.resize((SIZE, SIZE), Image.LANCZOS)
dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "images", "icon.png")
out.save(dest, "PNG", optimize=True)
print("wrote", os.path.normpath(dest), out.size)
