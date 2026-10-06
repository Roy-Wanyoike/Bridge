#!/usr/bin/env python3
"""Assemble the three Bridge marketing videos from composed frames.

Scenes are static PNGs joined by varied crossfades; the intro carries the TTS
narration (its duration is measured and the intro is timed to fit it, so the
narration never gets clipped). h264 + aac, yuv420p, +faststart.

Inputs:  marketing/.build/frames/*.png   (from compose_frames.py)
         marketing/videos/narration-intro.wav
Outputs: marketing/videos/bridge-intro.mp4
         marketing/videos/bridge-gate-demo.mp4
         marketing/videos/bridge-social-square.mp4
         marketing/images/bridge-video-intro-poster.png
         marketing/images/bridge-video-social-poster.png

Run from repo root:  python3 marketing/tools/assemble_videos.py
"""

import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FRAMES = os.path.join(ROOT, "marketing", ".build", "frames")
VIDEOS = os.path.join(ROOT, "marketing", "videos")
IMAGES = os.path.join(ROOT, "marketing", "images")
NARRATION = os.path.join(VIDEOS, "narration-intro.wav")


def ffprobe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def encode(scenes, out_path, narration=False):
    """scenes: list of (frame_filename, base_duration).

    Each clip is encoded with a baked dip-to-black fade in/out, then all clips
    are joined with the concat demuxer (-c copy) — chained xfade graphs hang on
    long inputs, while this path is fast and deterministic. The narration is
    muxed in a final pass; the intro's total is timed to fit it.
    """
    n = len(scenes)
    fade = 0.45
    if narration:
        narr_dur = ffprobe_duration(NARRATION)
        total = narr_dur + 0.9 + 2.2          # lead-in + closing tail
        static_total = sum(d for _, d in scenes)
        k = (total + n * 2 * fade) / static_total  # fades overlap the scenes
        durs = [d * k for _, d in scenes]
    else:
        durs = [d for _, d in scenes]
        total = sum(durs)

    clips = []
    for i, (fname, _) in enumerate(scenes):
        src = os.path.join(FRAMES, fname)
        clip = os.path.join(VIDEOS, f".clip-{i}.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", src,
             "-t", f"{durs[i]:.3f}",
             "-vf", (f"fade=t=in:st=0:d={fade},"
                     f"fade=t=out:st={durs[i] - fade:.3f}:d={fade},"
                     "format=yuv420p"),
             "-c:v", "libx264", "-crf", "17", "-preset", "veryfast",
             "-r", "30", "-an", clip],
            check=True)
        clips.append(clip)

    list_file = os.path.join(VIDEOS, ".concat.txt")
    with open(list_file, "w") as fh:
        for c in clips:
            fh.write(f"file '{c}'\n")
    merged = os.path.join(VIDEOS, ".merged.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat",
                    "-safe", "0", "-i", list_file, "-c", "copy", merged],
                   check=True)

    if narration:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", merged, "-i", NARRATION,
             "-filter_complex",
             (f"[1:a]adelay=900|900,apad,atrim=0:{total:.3f},"
              f"afade=t=out:st={total - 1.8:.3f}:d=1.8,"
              "loudnorm=I=-16:TP=-1.5:LRA=11[a]"),
             "-map", "0:v", "-map", "[a]", "-c:v", "copy",
             "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
             "-t", f"{total:.3f}", out_path],
            check=True)
    else:
        shutil.move(merged, out_path)

    for c in clips:
        os.remove(c)
    os.remove(list_file)
    if os.path.exists(merged):
        os.remove(merged)
    return total


def main():
    os.makedirs(VIDEOS, exist_ok=True)
    jobs = [
        ("bridge-intro.mp4", True,
         [("s0_logo.png", 4.5), ("s1_problem.png", 5.5), ("s2_validate.png", 4.5),
          ("s3_generate.png", 5.0), ("s4_diff.png", 5.5), ("s5_gate.png", 4.5),
          ("s6_features.png", 4.5), ("s7_end.png", 4.5)]),
        ("bridge-gate-demo.mp4", False,
         [("s2_validate.png", 3.5), ("s4_diff.png", 5.5), ("s5_gate.png", 5.0),
          ("s7_end.png", 4.0)]),
        ("bridge-social-square.mp4", False,
         [("q0_icon.png", 2.5), ("q1_contract.png", 3.0), ("q2_languages.png", 3.2),
          ("q3_verdict.png", 3.8), ("q4_end.png", 3.5)]),
    ]
    for name, narrated, scenes in jobs:
        out = os.path.join(VIDEOS, name)
        total = encode(scenes, out, narration=narrated)
        dur = ffprobe_duration(out)
        size = os.path.getsize(out)
        print(f"{name:28s} {dur:6.2f}s (planned {total:6.2f}s)  {size / 1048576:5.2f} MB")

    shutil.copyfile(os.path.join(FRAMES, "s0_logo.png"),
                    os.path.join(IMAGES, "bridge-video-intro-poster.png"))
    shutil.copyfile(os.path.join(FRAMES, "q0_icon.png"),
                    os.path.join(IMAGES, "bridge-video-social-poster.png"))
    print("posters written to marketing/images/")


if __name__ == "__main__":
    sys.exit(main())
