from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter


root = Path(r"E:\A Network Project Codes\A Network")
logo_path = root / "my_app" / "assets" / "logo.png"
out_path = root / "docs" / "play-feature-graphic.png"

W, H = 1024, 500
img = Image.new("RGBA", (W, H), "#07111f")
draw = ImageDraw.Draw(img)

for y in range(H):
    t = y / max(H - 1, 1)
    r = int(7 + (16 - 7) * (1 - t) + 8 * t)
    g = int(17 + (40 - 17) * (1 - t) + 6 * t)
    b = int(31 + (74 - 31) * (1 - t) + 18 * t)
    draw.line([(0, y), (W, y)], fill=(r, g, b, 255))

overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
od = ImageDraw.Draw(overlay)
od.ellipse((40, 10, 560, 470), fill=(0, 190, 255, 50))
od.ellipse((450, -120, 1040, 360), fill=(0, 120, 255, 40))
overlay = overlay.filter(ImageFilter.GaussianBlur(70))
img.alpha_composite(overlay)

net = Image.new("RGBA", (W, H), (0, 0, 0, 0))
nd = ImageDraw.Draw(net)
lines = [
    ((40, 380), (260, 160), (420, 320), (700, 110), (950, 260)),
    ((80, 120), (280, 360), (520, 170), (760, 340), (980, 130)),
    ((120, 250), (320, 80), (560, 380), (790, 160), (940, 410)),
]
for pts in lines:
    nd.line(list(pts), fill=(80, 220, 255, 90), width=3)
for x, y in [
    (40, 380), (260, 160), (420, 320), (700, 110), (950, 260),
    (80, 120), (280, 360), (520, 170), (760, 340), (980, 130),
    (120, 250), (320, 80), (560, 380), (790, 160), (940, 410),
]:
    nd.ellipse((x - 6, y - 6, x + 6, y + 6), fill=(120, 240, 255, 180))
net = net.filter(ImageFilter.GaussianBlur(0.5))
img.alpha_composite(net)

panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
pd = ImageDraw.Draw(panel)
pd.rounded_rectangle((390, 70, 970, 430), radius=28, fill=(8, 18, 32, 168), outline=(90, 220, 255, 90), width=2)
panel = panel.filter(ImageFilter.GaussianBlur(0.3))
img.alpha_composite(panel)

logo = Image.open(logo_path).convert("RGBA")
logo = logo.resize((320, 320), Image.LANCZOS)
lg = Image.new("RGBA", (360, 360), (0, 0, 0, 0))
dlg = ImageDraw.Draw(lg)
dlg.ellipse((20, 20, 340, 340), fill=(0, 180, 255, 80))
lg = lg.filter(ImageFilter.GaussianBlur(35))
img.alpha_composite(lg, (40, 70))
img.alpha_composite(logo, (60, 90))

font_candidates = [
    Path(r"C:\Windows\Fonts\segoeuib.ttf"),
    Path(r"C:\Windows\Fonts\arialbd.ttf"),
    Path(r"C:\Windows\Fonts\bahnschrift.ttf"),
]
font_bold_path = next((p for p in font_candidates if p.exists()), None)
font_reg_candidates = [Path(r"C:\Windows\Fonts\segoeui.ttf"), Path(r"C:\Windows\Fonts\arial.ttf")]
font_reg_path = next((p for p in font_reg_candidates if p.exists()), font_bold_path)
if font_bold_path:
    title_font = ImageFont.truetype(str(font_bold_path), 62)
    sub_font = ImageFont.truetype(str(font_reg_path), 28)
    pill_font = ImageFont.truetype(str(font_bold_path), 22)
else:
    title_font = ImageFont.load_default()
    sub_font = ImageFont.load_default()
    pill_font = ImageFont.load_default()

text_x = 430
shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.text((text_x, 126), "A-Network", font=title_font, fill=(0, 195, 255, 180))
shadow = shadow.filter(ImageFilter.GaussianBlur(8))
img.alpha_composite(shadow)

draw = ImageDraw.Draw(img)
draw.text((text_x, 118), "A-Network", font=title_font, fill=(230, 248, 255, 255))
draw.text((text_x, 192), "Web2 + Web3 ecosystem with secure access,", font=sub_font, fill=(185, 214, 230, 255))
draw.text((text_x, 228), "mining sessions, stats, and wallet tools.", font=sub_font, fill=(185, 214, 230, 255))

pills = [
    ("Secure Accounts", (430, 300, 620, 346)),
    ("Mining Sessions", (635, 300, 840, 346)),
    ("Wallet Tools", (430, 364, 602, 410)),
]
for label, box in pills:
    draw.rounded_rectangle(box, radius=22, fill=(20, 47, 74, 230), outline=(96, 229, 255, 130), width=2)
    bbox = draw.textbbox((0, 0), label, font=pill_font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = box[0] + (box[2] - box[0] - tw) / 2
    y = box[1] + (box[3] - box[1] - th) / 2 - 2
    draw.text((x, y), label, font=pill_font, fill=(231, 251, 255, 255))

for inset, alpha in [(6, 40), (14, 22)]:
    draw.rounded_rectangle((inset, inset, W - inset, H - inset), radius=30, outline=(115, 209, 255, alpha), width=1)

img.convert("RGB").save(out_path, quality=96)
print(out_path)
