#!/usr/bin/env python3
# Merge cover + body into the final QA report PDF.
from pypdf import PdfReader, PdfWriter

A4_W, A4_H = 595.28, 841.89

def normalize(page):
    w, h = float(page.mediabox.width), float(page.mediabox.height)
    if abs(w - A4_W) > 0.1 or abs(h - A4_H) > 0.1:
        page.scale_to(A4_W, A4_H)
    return page

writer = PdfWriter()
writer.add_page(normalize(PdfReader('/home/z/my-project/scripts/qa-report-cover.pdf').pages[0]))
for p in PdfReader('/home/z/my-project/scripts/qa-report-body.pdf').pages:
    writer.add_page(normalize(p))
writer.add_metadata({
    '/Title': 'BRIDGE Platform QA and Production Readiness Report',
    '/Author': 'Z.ai', '/Creator': 'Z.ai',
    '/Subject': 'QA report covering the full audit cycle of the BRIDGE contract compiler platform',
})
out = '/home/z/my-project/download/BRIDGE-QA-Report-v0.2.0.pdf'
with open(out, 'wb') as f:
    writer.write(f)
print('merged:', out, 'pages:', len(writer.pages))
