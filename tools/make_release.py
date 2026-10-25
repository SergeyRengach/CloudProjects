#!/usr/bin/env python3
"""Builds release/graphnote-app.zip (prebuilt, with launchers) and release/graphnote-source.zip."""
import os, subprocess, zipfile

root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
out = os.path.join(root, "release")
os.makedirs(out, exist_ok=True)

def add(z, src, arc, mode=0o644):
    info = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
    info.external_attr = (0o100000 | mode) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    with open(src, "rb") as f:
        z.writestr(info, f.read())

with zipfile.ZipFile(os.path.join(out, "graphnote-app.zip"), "w") as z:
    top = "Graphnote"
    for name, mode in [("serve.py", 0o755), ("start.command", 0o755), ("start.bat", 0o644), ("ЧИТАЙ_МЕНЕ.txt", 0o644)]:
        add(z, os.path.join(root, "tools", name), f"{top}/{name}", mode)
    dist = os.path.join(root, "web", "dist")
    for d, _, files in os.walk(dist):
        for f in sorted(files):
            p = os.path.join(d, f)
            add(z, p, f"{top}/app/{os.path.relpath(p, dist)}")

subprocess.check_call(["git", "archive", "--format=zip", "--prefix=graphnote-source/", "-o", os.path.join(out, "graphnote-source.zip"), "HEAD"], cwd=root)
print("ok")
