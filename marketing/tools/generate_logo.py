#!/usr/bin/env python3
"""Generate the Bridge logo suite: icon, wordmark, lockups, og-image.

Design: the keystone arch. One arch (the Bridge compiler) holds six languages
together; the keystone at the crown is the contract — remove it and the arch
falls. Palette: navy #0B1026, teal #2DD4A8 -> indigo #6380E0 gradient.

All text is converted to SVG paths (fontTools), so every SVG is
self-contained and renders identically everywhere — no font dependency.

Outputs (committed):
  marketing/logo/bridge-icon-dark.svg      navy tile, for dark surfaces/avatar
  marketing/logo/bridge-icon-light.svg     paper tile, for light surfaces
  marketing/logo/bridge-wordmark-dark.svg  gradient wordmark, transparent
  marketing/logo/bridge-wordmark-light.svg
  marketing/logo/bridge-lockup-dark.svg    mark + wordmark, transparent (dark bg)
  marketing/logo/bridge-lockup-light.svg   mark + wordmark, transparent (light bg)
  marketing/logo/bridge-icon-512.png       avatar/app-icon render
  marketing/logo/bridge-avatar-192.png     GitHub avatar render
  marketing/images/bridge-og-image.png     1200x630 social preview

Run from repo root:  python3 marketing/tools/generate_logo.py
"""

import os
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOGO_DIR = os.path.join(ROOT, "marketing", "logo")
IMG_DIR = os.path.join(ROOT, "marketing", "images")

CARLITO_B = "/usr/share/fonts/truetype/english/Carlito-Bold.ttf"
CARLITO_R = "/usr/share/fonts/truetype/english/Carlito-Regular.ttf"

NAVY = "#0B1026"
NAVY_LIGHT = "#101736"
PAPER = "#F7F9FC"
TEAL = "#2DD4A8"
INDIGO = "#6380E0"
WHITE = "#F4F8FF"
INK = "#10162E"
SLATE = "#94A3C4"
SLATE_DARK = "#3D4A78"

GRAD_ID = "bg"


def text_paths(text, font_path, size, x0, baseline_y, fill, letter_spacing=0.0):
    """Return SVG markup for text converted to glyph outline paths."""
    font = TTFont(font_path)
    upem = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    scale = size / upem
    parts = []
    x = x0
    for ch in text:
        gname = cmap.get(ord(ch))
        if gname is None:
            x += size * 0.28
            continue
        pen = SVGPathPen(glyph_set)
        glyph_set[gname].draw(pen)
        d = pen.getCommands()
        if d:
            parts.append(
                f'<g transform="translate({x:.2f},{baseline_y:.2f}) '
                f'scale({scale:.6f},-{scale:.6f})"><path d="{d}" fill="{fill}"/></g>'
            )
        x += glyph_set[gname].width * scale + letter_spacing
    return "\n    ".join(parts), x


def text_width(text, font_path, size, letter_spacing=0.0):
    font = TTFont(font_path)
    upem = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    scale = size / upem
    w = 0.0
    for ch in text:
        gname = cmap.get(ord(ch))
        if gname is None:
            w += size * 0.28
            continue
        w += glyph_set[gname].width * scale + letter_spacing
    return w - (letter_spacing if text else 0.0)


DEFS = f"""
  <defs>
    <linearGradient id="{GRAD_ID}" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="{TEAL}"/>
      <stop offset="100%" stop-color="{INDIGO}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="46%" r="55%">
      <stop offset="0%" stop-color="{INDIGO}" stop-opacity="0.16"/>
      <stop offset="60%" stop-color="{TEAL}" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="{TEAL}" stop-opacity="0"/>
    </radialGradient>
    <!-- userSpaceOnUse: gradients on axis-aligned lines have zero-area bbox,
         so objectBoundingBox gradients silently paint nothing -->
    <linearGradient id="{GRAD_ID}US" gradientUnits="userSpaceOnUse" x1="78" y1="0" x2="434" y2="0">
      <stop offset="0%" stop-color="{TEAL}"/>
      <stop offset="100%" stop-color="{INDIGO}"/>
    </linearGradient>
    <linearGradient id="tile" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="{NAVY_LIGHT}"/>
      <stop offset="100%" stop-color="{NAVY}"/>
    </linearGradient>
  </defs>"""


def mark(x_off, y_off, scale, keystone_fill, keyline, deck_fill, water_fill):
    """The arch mark, parametric. Arch springs from the deck; keystone crowns it.

    Geometry (in 512-space): deck y=372 x 78..434 stroke 30; arch circle
    center (256,372) r=148 stroke 40; suspenders x=176,336 stroke 14;
    keystone diamond half-diagonal 48 at (256,224); two water lines below.
    """
    sx = 40 / 2  # arch stroke half
    sus_y = 372 - (148**2 - 80**2) ** 0.5  # arch surface at x=256+-80
    return f"""<g transform="translate({x_off:.2f},{y_off:.2f}) scale({scale:.6f})">
      <line x1="78" y1="372" x2="434" y2="372" stroke="url(#{GRAD_ID}US)" stroke-width="30" stroke-linecap="round"/>
      <line x1="150" y1="428" x2="248" y2="428" stroke="{water_fill}" stroke-width="12" stroke-linecap="round"/>
      <line x1="282" y1="428" x2="372" y2="428" stroke="{water_fill}" stroke-width="12" stroke-linecap="round"/>
      <line x1="188" y1="456" x2="330" y2="456" stroke="{water_fill}" stroke-width="10" stroke-linecap="round"/>
      <line x1="176" y1="{sus_y + 4:.1f}" x2="176" y2="352" stroke="url(#{GRAD_ID}US)" stroke-width="14" stroke-linecap="round"/>
      <line x1="336" y1="{sus_y + 4:.1f}" x2="336" y2="352" stroke="url(#{GRAD_ID}US)" stroke-width="14" stroke-linecap="round"/>
      <path d="M {108 + sx} 372 A {148 - sx} {148 - sx} 0 0 1 {404 - sx} 372 L 404 372 A 148 148 0 0 0 108 372 Z"
            fill="url(#{GRAD_ID})"/>
      <path d="M 256 176 L 302 224 L 256 272 L 210 224 Z" fill="{keystone_fill}" stroke="{keyline}" stroke-width="10" stroke-linejoin="round"/>
    </g>"""


def svg_icon(variant):
    """Square app icon / avatar: rounded tile + mark."""
    if variant == "dark":
        tile_fill, ks, keyline, water = "url(#tile)", WHITE, NAVY, "#26315C"
    else:
        tile_fill, ks, keyline, water = PAPER, NAVY, PAPER, "#D5DEEF"
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Bridge logo">
  {DEFS}
  <rect width="512" height="512" rx="112" fill="{tile_fill}"/>
  <rect width="512" height="512" rx="112" fill="url(#glow)"/>
  {mark(0, 0, 1.0, ks, keyline, f"url(#{GRAD_ID})", water)}
</svg>
"""


def svg_lockup(variant):
    """Transparent horizontal lockup: bare mark + gradient wordmark."""
    size = 289.0  # wordmark font size
    ls = 0.0
    # mark occupies a 512-box scaled to 400, vertically centered with text
    m_scale = 400 / 512
    text = "bridge"
    tw = text_width(text, CARLITO_B, size, ls)
    W = int(16 + 400 + 64 + tw + 20)
    H = 400
    xheight = 993 * size / 2048
    baseline = H / 2 + xheight / 2
    fill = f"url(#{GRAD_ID})"
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="bridge">
  {DEFS}
  {mark(16, -9, m_scale, WHITE if variant == "dark" else NAVY,
        "#0D1117" if variant == "dark" else "#FFFFFF",
        f"url(#{GRAD_ID})", "#26315C" if variant == "dark" else "#D5DEEF")}
  """ + text_paths(text, CARLITO_B, size, 16 + 400 + 64, baseline, fill, ls)[0] + f"""
</svg>
"""


def svg_wordmark(variant):
    size = 289.0
    text = "bridge"
    tw = text_width(text, CARLITO_B, size)
    asc = 1950 * size / 2048
    desc = 550 * size / 2048
    W = int(tw + 12)
    H = int(asc + desc + 12)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="bridge">
  {DEFS}
  """ + text_paths(text, CARLITO_B, size, 6, asc + 6, f"url(#{GRAD_ID})")[0] + f"""
</svg>
"""


def svg_og():
    """1200x630 social preview: lockup + tagline on navy with glow."""
    W, H = 1200, 630
    size = 240.0
    tw = text_width("bridge", CARLITO_B, size)
    m_scale = 380 / 512
    mark_w = 380
    gap = 56
    total = mark_w + gap + tw
    x0 = (W - total) / 2
    xheight = 993 * size / 2048
    baseline = 300 + xheight / 2
    tag_size = 44.0
    tag = "One contract. Every language."
    tag_w = text_width(tag, CARLITO_R, tag_size, 2.0)
    tag_svg, _ = text_paths(tag, CARLITO_R, tag_size, (W - tag_w) / 2, 452, SLATE, 2.0)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="Bridge — one contract, every language">
  {DEFS}
  <rect width="{W}" height="{H}" fill="{NAVY}"/>
  <rect width="{W}" height="{H}" fill="url(#glow)"/>
  <rect x="0" y="0" width="{W}" height="6" fill="url(#{GRAD_ID})"/>
  {mark(x0, 20, m_scale, WHITE, NAVY, f"url(#{GRAD_ID})", "#26315C")}
  """ + text_paths("bridge", CARLITO_B, size, x0 + mark_w + gap, baseline, f"url(#{GRAD_ID})")[0] + f"""
  {tag_svg}
  <rect x="{(W - 220) / 2:.0f}" y="512" width="220" height="5" rx="2.5" fill="url(#{GRAD_ID})"/>
</svg>
"""


def render(svg_str, png_path, out_w, out_h):
    import cairosvg

    cairosvg.svg2png(bytestring=svg_str.encode(), write_to=png_path,
                     output_width=out_w, output_height=out_h)


def main():
    os.makedirs(LOGO_DIR, exist_ok=True)
    os.makedirs(IMG_DIR, exist_ok=True)

    assets = {
        "bridge-icon-dark.svg": svg_icon("dark"),
        "bridge-icon-light.svg": svg_icon("light"),
        "bridge-lockup-dark.svg": svg_lockup("dark"),
        "bridge-lockup-light.svg": svg_lockup("light"),
        "bridge-wordmark-dark.svg": svg_wordmark("dark"),
        "bridge-wordmark-light.svg": svg_wordmark("light"),
    }
    for name, svg in assets.items():
        path = os.path.join(LOGO_DIR, name)
        with open(path, "w") as fh:
            fh.write(svg)
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")

    icon_dark = assets["bridge-icon-dark.svg"]
    render(icon_dark, os.path.join(LOGO_DIR, "bridge-icon-512.png"), 512, 512)
    render(icon_dark, os.path.join(IMG_DIR, "bridge-icon-1024.png"), 1024, 1024)
    # GitHub avatar: downscale from the 1024 render for clean resampling
    img = Image.open(os.path.join(IMG_DIR, "bridge-icon-1024.png")).convert("RGBA")
    img.resize((192, 192), Image.LANCZOS).save(os.path.join(LOGO_DIR, "bridge-avatar-192.png"))
    render(assets["bridge-lockup-light.svg"],
           os.path.join(IMG_DIR, "bridge-lockup-light.png"), 1600, 0)
    render(svg_og(), os.path.join(IMG_DIR, "bridge-og-image.png"), 1200, 630)
    print("rendered PNGs:")
    for p in ("bridge-icon-512.png", "bridge-avatar-192.png"):
        print("  ", os.path.join(LOGO_DIR, p), os.path.getsize(os.path.join(LOGO_DIR, p)))
    for p in ("bridge-icon-1024.png", "bridge-lockup-light.png", "bridge-og-image.png"):
        print("  ", os.path.join(IMG_DIR, p), os.path.getsize(os.path.join(IMG_DIR, p)))


if __name__ == "__main__":
    sys.exit(main())
