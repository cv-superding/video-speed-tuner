"""生成 shields 风格 for-the-badge 徽章（本地 SVG，不依赖外部服务）"""
import os
from PIL import ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'badges')
os.makedirs(OUT, exist_ok=True)

# for-the-badge 规格
H = 28
FS = 10.5
LS = 1.0        # letter-spacing
PAD = 11        # 左右内边距
LABEL_BG = '#2d333b'

BADGES = [
    ('license', 'MIT', '#16a34a'),
    ('platform', 'Edge · Chrome', '#2563eb'),
    ('manifest', 'v3', '#8b5cf6'),
    ('privacy', 'no data collected', '#22c55e'),
    ('version', '1.0.1', '#f59e0b'),
    ('shortcuts', '13', '#0ea5e9'),
]

# 优先 Verdana Bold，回退 Arial Bold
font = None
for path in (r'C:\Windows\Fonts\verdanab.ttf', r'C:\Windows\Fonts\arialbd.ttf'):
    if os.path.exists(path):
        font = ImageFont.truetype(path, int(round(FS * 1.6)))  # 放大测量再换算，减少误差
        ratio = FS / (FS * 1.6)
        break

def text_width(s):
    """按 1.6 倍字号测量后换算回 10.5px，再加上 letter-spacing"""
    w = font.getlength(s) * ratio
    return w + max(0, len(s) - 1) * LS

def esc(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

count = 0
for label, value, color in BADGES:
    lw = text_width(label.upper()) + PAD * 2
    vw = text_width(value) + PAD * 2
    total = lw + vw

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{total:.1f}" height="{H}" role="img" aria-label="{esc(label)}: {esc(value)}">
  <title>{esc(label)}: {esc(value)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".08"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <rect width="{total:.1f}" height="{H}" rx="3" fill="{color}"/>
  <rect width="{lw:.1f}" height="{H}" rx="3" fill="{LABEL_BG}"/>
  <rect x="{lw - 3:.1f}" width="3" height="{H}" fill="{LABEL_BG}"/>
  <rect width="{total:.1f}" height="{H}" rx="3" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="{FS}" font-weight="bold" letter-spacing="{LS}">
    <text x="{lw / 2:.1f}" y="18.5">{esc(label.upper())}</text>
    <text x="{lw + vw / 2:.1f}" y="18.5">{esc(value)}</text>
  </g>
</svg>
'''
    name = label + '.svg'
    with open(os.path.join(OUT, name), 'w', encoding='utf-8', newline='\n') as f:
        f.write(svg)
    print('%-14s %5.1f x %d' % (name, total, H))
    count += 1

print('total', count, 'badges ->', os.path.abspath(OUT))
