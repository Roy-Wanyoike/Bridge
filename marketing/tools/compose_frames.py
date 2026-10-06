#!/usr/bin/env python3
"""Compose 1920x1080 (and 1080x1080) frames for the Bridge marketing videos.

Every terminal scene is REAL output captured at compose time by running the
repo's own CLI against the repo's own examples — the videos show the actual
product behaving, never invented transcripts. Requires `npm run build` first.

Frames are written to marketing/.build/frames/ (git-ignored working dir);
marketing/tools/assemble_videos.py encodes them into marketing/videos/.

Run from repo root:  python3 marketing/tools/compose_frames.py
"""

import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = os.path.join(ROOT, "packages", "bridge-cli", "dist", "bin", "bridge.js")
BUILD = os.path.join(ROOT, "marketing", ".build")
FRAMES = os.path.join(BUILD, "frames")
EXAMPLES = os.path.join(ROOT, "examples")

NAVY = (11, 16, 38)
PANEL = (17, 24, 52)
TERMINAL_BG = (13, 17, 38)
TITLEBAR = (23, 30, 60)
BORDER = (52, 66, 110)
TEAL = (45, 212, 168)
INDIGO = (99, 128, 224)
RED = (248, 113, 113)
AMBER = (251, 191, 36)
WHITE = (236, 242, 255)
SLATE = (148, 163, 196)
DIM = (96, 110, 148)
GLOW_RED = (36, 20, 30)
GLOW_TEAL = (18, 34, 46)

CARLITO_B = "/usr/share/fonts/truetype/english/Carlito-Bold.ttf"
CARLITO_R = "/usr/share/fonts/truetype/english/Carlito-Regular.ttf"
DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

W, H = 1920, 1080
Q = 1080


def lerp(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def font(path, size):
    return ImageFont.truetype(path, size)


def gradient_text(img, xy, text, fnt, c1=TEAL, c2=INDIGO):
    """Draw text with a horizontal teal->indigo gradient. Returns bbox."""
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).text(xy, text, font=fnt, fill=255)
    bbox = mask.getbbox()
    grad = Image.new("RGB", img.size, c1)
    gd = ImageDraw.Draw(grad)
    x0, _, x1, _ = bbox
    span = max(1, x1 - x0)
    for x in range(x0, x1 + 1):
        gd.line([(x, 0), (x, img.size[1])], fill=lerp(c1, c2, (x - x0) / span))
    img.paste(grad, (0, 0), mask)
    return bbox


def centered_text(img, cx, y, text, fnt, fill):
    d = ImageDraw.Draw(img)
    b = d.textbbox((0, 0), text, font=fnt)
    d.text((cx - (b[2] - b[0]) // 2, y), text, font=fnt, fill=fill)


def navy_bg(w=W, h=H, glow_center=None, glow_color=(20, 32, 70), glow_radius=560):
    img = Image.new("RGB", (w, h), NAVY)
    if glow_center:
        d = ImageDraw.Draw(img)
        cx, cy = glow_center
        for r in range(glow_radius, 0, -6):
            d.ellipse([cx - r, cy - r * 0.82, cx + r, cy + r * 0.82],
                      fill=lerp(NAVY, glow_color, 1 - r / glow_radius))
    return img


def paste_feathered(canvas, tile, center, size):
    """Paste a square tile with a soft circular feather so it melts into navy."""
    t = tile.resize((size, size), Image.LANCZOS).convert("RGB")
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    m = size // 2
    for i in range(m, 0, -1):
        alpha = int(255 * min(1.0, (m - i) / (size * 0.12)))
        md.ellipse([m - i, m - i, m + i, m + i], fill=alpha)
    canvas.paste(t, (center[0] - m, center[1] - m), mask)


# ---------------------------------------------------------------- CLI capture

def run_cli(example_dir, args):
    """Run the built bridge CLI from an examples dir; return combined output."""
    proc = subprocess.run(
        ["node", CLI] + args,
        cwd=os.path.join(EXAMPLES, example_dir),
        capture_output=True, text=True,
    )
    out = (proc.stdout + proc.stderr).rstrip("\n")
    return out.split("\n")


def capture_transcripts():
    os.makedirs(BUILD, exist_ok=True)
    # generate into a RELATIVE out dir inside the example (matching the README's
    # canonical `wrote generated/...` transcript — never machine-absolute paths)
    gen_dir = os.path.join(EXAMPLES, "payments", "generated")
    shutil.rmtree(gen_dir, ignore_errors=True)
    caps = {
        "validate": run_cli("payments", ["validate", "payments.bridge"]),
        "generate": run_cli("payments",
                            ["generate", "payments.bridge", "--language", "go",
                             "--out", "generated"]),
        "diff": run_cli("versioning", ["diff", "v1.payments.bridge", "v2.payments.bridge"]),
        "check": run_cli("versioning", ["check", "v1.payments.bridge", "v2.payments.bridge"]),
    }
    for name, lines in caps.items():
        with open(os.path.join(BUILD, f"cap-{name}.txt"), "w") as fh:
            fh.write("\n".join(lines))
        print(f"captured {name}: {len(lines)} lines (exit-verified)")
    return caps


def load_icon():
    path = os.path.join(ROOT, "marketing", "logo", "bridge-icon-512.png")
    if not os.path.exists(path):
        sys.exit("marketing/logo/bridge-icon-512.png missing — run generate_logo.py first")
    return Image.open(path).convert("RGB")


# ------------------------------------------------------------ terminal frames

def line_style(ln):
    """Color rule for real CLI output lines."""
    if ln.startswith("✓"):
        return TEAL, False
    if "❌" in ln or "Breaking:" in ln or "FAILED" in ln or ln.startswith("bridge:"):
        return RED, "Breaking" in ln or "FAILED" in ln or ln.startswith("bridge:")
    if "⚠" in ln:
        return AMBER, False
    if ln.startswith(("Verdict:", "verdict:", "passed:")):
        return RED, True
    if ln.startswith(("Summary:", "package:", "baseline:", "mode:", "changes:")):
        return SLATE, False
    return WHITE, False


def terminal_frame(lines, cmd, cwd="~/payments", caption=None, title="bridge — zsh"):
    img = navy_bg()
    d = ImageDraw.Draw(img)
    wx0, wy0, wx1, wy1 = 180, 130, W - 180, 880
    d.rounded_rectangle([wx0, wy0, wx1, wy1], radius=22, fill=TERMINAL_BG,
                        outline=BORDER, width=2)
    d.rounded_rectangle([wx0, wy0, wx1, wy0 + 64], radius=22, fill=TITLEBAR)
    d.rectangle([wx0, wy0 + 34, wx1, wy0 + 64], fill=TITLEBAR)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([wx0 + 28 + i * 44, wy0 + 20, wx0 + 52 + i * 44, wy0 + 44], fill=c)
    f_title = font(DEJAVU, 26)
    d.text(((wx0 + wx1) // 2 - 110, wy0 + 17), title, font=f_title, fill=DIM)

    f_mono = font(MONO, 30)
    f_mono_b = font(MONO_B, 30)
    x, y = wx0 + 40, wy0 + 100
    prompt = f"{cwd} $ "
    d.text((x, y), prompt, font=f_mono_b, fill=SLATE)
    pw = d.textbbox((0, 0), prompt, font=f_mono_b)[2]
    d.text((x + pw, y), cmd, font=f_mono_b, fill=WHITE)
    y += 58
    for ln in lines:
        ln = ln.replace("❌", "✗").replace("⚠", "⚠")
        color, bold = line_style(ln)
        fnt = f_mono_b if bold else f_mono
        d.text((x, y), ln, font=fnt, fill=color)
        y += 48
    if caption:
        centered_text(img, W // 2, 950, caption, font(DEJAVU, 46), SLATE)
    return img


# ------------------------------------------------------------- 1920x1080 scenes

def scene_logo(icon):
    s = navy_bg(glow_center=(W // 2, 460), glow_color=GLOW_TEAL)
    paste_feathered(s, icon, (W // 2, 460), 470)
    f_word = font(CARLITO_B, 170)
    d = ImageDraw.Draw(s)
    b = d.textbbox((0, 0), "bridge", font=f_word)
    gradient_text(s, ((W - (b[2] - b[0])) // 2, 730), "bridge", f_word)
    centered_text(s, W // 2, 952, "One contract. Every language.", font(DEJAVU, 44), SLATE)
    return s


def scene_problem():
    s = navy_bg(glow_center=(W // 2, H // 2), glow_color=GLOW_RED)
    f_h1 = font(CARLITO_B, 104)
    line1 = "Your contract lives six lives at once."
    d = ImageDraw.Draw(s)
    b = d.textbbox((0, 0), line1, font=f_h1)
    gradient_text(s, ((W - (b[2] - b[0])) // 2, 320), line1, f_h1)
    f_body = font(DEJAVU, 50)
    subs = ["Hand-copied into Go, TypeScript, Python, Java, C#, Rust.",
            "Nothing keeps the copies honest.",
            "A \u201charmless\u201d field rename ships \u2014 and a consumer finds it in production."]
    y = 540
    for i, t in enumerate(subs):
        centered_text(s, W // 2, y, t, f_body, WHITE if i == 0 else SLATE)
        y += 96
    return s


def scene_features():
    s = navy_bg(glow_center=(W // 2, 320), glow_color=GLOW_TEAL)
    f_h = font(CARLITO_B, 80)
    head = "What ships in the box"
    d = ImageDraw.Draw(s)
    b = d.textbbox((0, 0), head, font=f_h)
    gradient_text(s, ((W - (b[2] - b[0])) // 2, 130), head, f_h)
    cards = [
        ("Generate", ["Go \u00b7 Rust \u00b7 TypeScript", "Python \u00b7 Java \u00b7 C#",
                      "validators for every", "constraint, every runtime"]),
        ("Detect", ["bridge diff classifies", "SAFE / WARNING /", "BREAKING / UNKNOWN",
                    "\u2014 fails CI, never silent"]),
        ("Govern", ["content-addressed registry", "SHA-256 identity,", "immutable versions,",
                    "who-consumes-what graph"]),
    ]
    cw, ch, gap = 500, 470, 60
    x = (W - 3 * cw - 2 * gap) // 2
    f_card = font(CARLITO_B, 54)
    f_sub = font(DEJAVU, 31)
    for title, subs in cards:
        d.rounded_rectangle([x, 300, x + cw, 300 + ch], radius=24, fill=PANEL,
                            outline=BORDER, width=2)
        b = d.textbbox((0, 0), title, font=f_card)
        # card title uses the accent color at the card's own hue position
        accent = lerp(TEAL, INDIGO, (x + cw / 2) / W)
        d.text((x + (cw - (b[2] - b[0])) // 2, 350), title, font=f_card, fill=accent)
        yy = 470
        for sub in subs:
            centered_text(s, x + cw // 2, yy, sub, f_sub, SLATE)
            yy += 66
        x += cw + gap
    return s


def scene_end(icon):
    s = navy_bg(glow_center=(W // 2, 430), glow_color=GLOW_TEAL)
    paste_feathered(s, icon, (W // 2, 430), 400)
    f_h = font(CARLITO_B, 92)
    d = ImageDraw.Draw(s)
    b = d.textbbox((0, 0), "One contract. Every language.", font=f_h)
    gradient_text(s, ((W - (b[2] - b[0])) // 2, 680), "One contract. Every language.", f_h)
    centered_text(s, W // 2, 860, "github.com/Roy-Wanyoike/bridge \u00b7 MIT", font(DEJAVU, 42), SLATE)
    return s


# --------------------------------------------------------------- 1080x1080 scenes

def q_logo(icon):
    s = navy_bg(Q, Q, glow_center=(Q // 2, Q // 2 - 40), glow_color=GLOW_TEAL, glow_radius=420)
    paste_feathered(s, icon, (Q // 2, Q // 2 - 40), 560)
    return s


def wrap_words(text, maxch):
    """Greedy word-wrap; returns list of lines."""
    words, lines, cur = text.split(), [], ""
    for w in words:
        cand = (cur + " " + w).strip()
        if len(cand) <= maxch:
            cur = cand
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def q_contract():
    s = navy_bg(Q, Q, glow_center=(Q // 2, 260), glow_color=GLOW_TEAL, glow_radius=380)
    centered_text(s, Q // 2, 50, "ONE CONTRACT", font(CARLITO_B, 44), SLATE)
    with open(os.path.join(EXAMPLES, "payments", "payments.bridge")) as fh:
        src = fh.read().split("\n")
    # real excerpt: package + Money + Payment (currency is the field the diff catches)
    i_pkg = next(i for i, l in enumerate(src) if l.startswith("package"))
    i_money = next(i for i, l in enumerate(src) if l.startswith("type Money"))
    i_money_end = next(i for i in range(i_money, len(src)) if src[i] == "}")
    i_pay = next(i for i, l in enumerate(src) if l.startswith("type Payment"))
    i_pay_end = next(i for i in range(i_pay, len(src)) if src[i] == "}")
    excerpt = (src[i_pkg:i_pkg + 1] + [""] + src[i_money:i_money_end + 1]
               + [""] + src[i_pay:i_pay_end + 1])
    px0, py0, px1 = 120, 150, Q - 120
    d = ImageDraw.Draw(s)
    lh = 42
    py1 = py0 + 80 + lh * len(excerpt) + 30
    d.rounded_rectangle([px0, py0, px1, py1], radius=22, fill=TERMINAL_BG,
                        outline=BORDER, width=2)
    d.rounded_rectangle([px0, py0, px1, py0 + 56], radius=22, fill=TITLEBAR)
    d.rectangle([px0, py0 + 30, px1, py0 + 56], fill=TITLEBAR)
    d.text((px0 + 28, py0 + 14), "payments.bridge", font=font(DEJAVU, 24), fill=DIM)
    f_m = font(MONO, 27)
    f_mb = font(MONO_B, 27)
    y = py0 + 82
    for ln in excerpt:
        is_block = ln.startswith(("type ", "enum ", "service ")) or ln == "}"
        d.text((px0 + 40, y), ln, font=f_mb if is_block else f_m,
               fill=WHITE if is_block else (TEAL if "currency" in ln or "@length" in ln else SLATE))
        y += lh
    centered_text(s, Q // 2, py1 + 56, "Define it once.", font(CARLITO_B, 64), WHITE)
    return s


def q_languages():
    s = navy_bg(Q, Q, glow_center=(Q // 2, 300), glow_color=GLOW_TEAL, glow_radius=380)
    f_h = font(CARLITO_B, 96)
    d = ImageDraw.Draw(s)
    head = "Every language."
    b = d.textbbox((0, 0), head, font=f_h)
    gradient_text(s, ((Q - (b[2] - b[0])) // 2, 110), head, f_h)
    langs = ["Go", "Rust", "TypeScript", "Python", "Java", "C#"]
    chw, chh, gx, gy = 270, 130, 30, 36
    total_w = 3 * chw + 2 * gx
    x0 = (Q - total_w) // 2
    f_c = font(CARLITO_B, 52)
    for i, name in enumerate(langs):
        row, col = divmod(i, 3)
        x = x0 + col * (chw + gx)
        y = 300 + row * (chh + gy)
        d.rounded_rectangle([x, y, x + chw, y + chh], radius=26, fill=PANEL,
                            outline=BORDER, width=2)
        b = d.textbbox((0, 0), name, font=f_c)
        d.text((x + (chw - (b[2] - b[0])) // 2, y + (chh - (b[3] - b[1])) // 2 - b[1]),
               name, font=f_c, fill=lerp(TEAL, INDIGO, i / 5))
    centered_text(s, Q // 2, 760, "generated from one canonical IR \u2014 byte-deterministic",
                  font(DEJAVU, 36), SLATE)
    return s


def q_verdict(caps):
    s = navy_bg(Q, Q, glow_center=(Q // 2, 300), glow_color=GLOW_RED, glow_radius=380)
    f_h = font(CARLITO_B, 96)
    d = ImageDraw.Draw(s)
    head = "Caught before merge."
    b = d.textbbox((0, 0), head, font=f_h)
    gradient_text(s, ((Q - (b[2] - b[0])) // 2, 110), head, f_h)
    # the heart of the real diff report: the findings + the verdict, word-wrapped
    findings = [ln for ln in caps["diff"] if ("❌" in ln or "⚠" in ln)]
    tail = [ln for ln in caps["diff"] if ln.startswith(("Verdict:", "Compatibility:"))]
    panel_lines = [""]
    styles = []
    for ln in findings:
        # continuation lines inherit the finding's style (findings are red/amber)
        style = line_style(ln)
        for sub in wrap_words(ln.replace("❌", "✗"), 46):
            panel_lines.append(sub)
            styles.append(style)
    panel_lines += [""] + tail
    styles += [None] * (len(panel_lines) - len(styles))
    px0, py0, px1 = 100, 300, Q - 100
    lh = 56
    py1 = py0 + 70 + lh * len(panel_lines) + 36
    d.rounded_rectangle([px0, py0, px1, py1], radius=22, fill=TERMINAL_BG,
                        outline=BORDER, width=2)
    y = py0 + 70
    f_m = font(MONO, 27)
    f_mb = font(MONO_B, 27)
    for i, ln in enumerate(panel_lines):
        if not ln:
            y += lh // 2
            continue
        color, bold = styles[i] if styles[i] else line_style(ln)
        d.text((px0 + 44, y), ln, font=f_mb if bold else f_m, fill=color)
        y += lh
    centered_text(s, Q // 2, py1 + 52, "bridge check exits non-zero \u2014 the merge is blocked.",
                  font(DEJAVU, 38), SLATE)
    return s


def q_end(icon):
    s = navy_bg(Q, Q, glow_center=(Q // 2, 380), glow_color=GLOW_TEAL, glow_radius=400)
    paste_feathered(s, icon, (Q // 2, 380), 380)
    f_w = font(CARLITO_B, 130)
    d = ImageDraw.Draw(s)
    b = d.textbbox((0, 0), "bridge", font=f_w)
    gradient_text(s, ((Q - (b[2] - b[0])) // 2, 600), "bridge", f_w)
    centered_text(s, Q // 2, 830, "github.com/Roy-Wanyoike/bridge \u00b7 MIT",
                  font(DEJAVU, 36), SLATE)
    return s


def main():
    caps = capture_transcripts()
    icon = load_icon()
    os.makedirs(FRAMES, exist_ok=True)

    wides = {
        "s0_logo.png": scene_logo(icon),
        "s1_problem.png": scene_problem(),
        "s2_validate.png": terminal_frame(caps["validate"], "bridge validate payments.bridge",
                                          caption="Compile it once. The hash is its identity."),
        "s3_generate.png": terminal_frame(caps["generate"], "bridge generate payments.bridge --language go",
                                          caption="Idiomatic Go \u2014 also Rust, TypeScript, Python, Java, C#"),
        "s4_diff.png": terminal_frame(caps["diff"], "bridge diff v1.payments.bridge v2.payments.bridge",
                                      cwd="~/payments/versioning",
                                      caption="The rename a reviewer would wave through \u2014 caught."),
        "s5_gate.png": terminal_frame(caps["check"], "bridge check v1.payments.bridge v2.payments.bridge",
                                      cwd="~/payments/versioning",
                                      caption="The merge is blocked. That's the point."),
        "s6_features.png": scene_features(),
        "s7_end.png": scene_end(icon),
    }
    squares = {
        "q0_icon.png": q_logo(icon),
        "q1_contract.png": q_contract(),
        "q2_languages.png": q_languages(),
        "q3_verdict.png": q_verdict(caps),
        "q4_end.png": q_end(icon),
    }
    for name, img in {**wides, **squares}.items():
        img.save(os.path.join(FRAMES, name))
        print("frame", name, img.size)
    shutil.rmtree(os.path.join(EXAMPLES, "payments", "generated"), ignore_errors=True)
    print("done:", len(wides), "widescreen +", len(squares), "square frames")


if __name__ == "__main__":
    sys.exit(main())
