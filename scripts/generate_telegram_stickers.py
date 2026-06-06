from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter


def ensure_logo(root):
    candidates = [
        root / "docs" / "icon-512.png",
        root / "docs" / "logo.png",
        root / "my_app" / "assets" / "logo.png",
    ]
    for path in candidates:
        if path.exists():
            return Image.open(path).convert("RGBA")
    raise FileNotFoundError("No logo found in expected locations.")


def get_font(size):
    # Use explicit Windows font paths first for consistent crisp rendering.
    candidates = [
        r"C:/Windows/Fonts/arialbd.ttf",
        r"C:/Windows/Fonts/segoeuib.ttf",
        r"C:/Windows/Fonts/arial.ttf",
        r"C:/Windows/Fonts/segoeui.ttf",
        "arialbd.ttf",
        "arial.ttf",
    ]
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_neon_badge_sticker(logo, title, subtitle, accent, size=100, pulse=0.0):
    """Create a scalable neon badge sticker matching ANT POWER style."""
    scale = size / 100.0
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # Crisp neon ring effect with reduced blur.
    glow_alpha = int(70 + (55 * pulse))
    inner_alpha = int(245 + (10 * pulse))
    outer_width = max(2, int(3 * scale))
    inner_width = max(1, int(2 * scale))
    ring_pad_outer_x = int(8 * scale)
    ring_pad_outer_y = int(6 * scale)
    ring_pad_inner_x = int(10 * scale)
    ring_pad_inner_y = int(8 * scale)
    draw.ellipse(
        (
            ring_pad_outer_x,
            ring_pad_outer_y,
            size - ring_pad_outer_x,
            size - int(10 * scale),
        ),
        outline=(40, 200, 255, glow_alpha),
        width=outer_width,
    )
    draw.ellipse(
        (
            ring_pad_inner_x,
            ring_pad_inner_y,
            size - ring_pad_inner_x,
            size - int(12 * scale),
        ),
        outline=(60, 220, 255, inner_alpha),
        width=inner_width,
    )

    # Top logo bubble.
    bubble = (
        int(34 * scale),
        int(6 * scale),
        int(66 * scale),
        int(38 * scale),
    )
    draw.ellipse(
        bubble,
        fill=(8, 16, 35, 255),
        outline=(90, 210, 255, inner_alpha),
        width=max(1, int(2 * scale)),
    )
    logo_side = max(8, int(24 * scale))
    logo_x = int(38 * scale)
    logo_y = int(10 * scale)
    logo_small = logo.resize((logo_side, logo_side), Image.LANCZOS)
    logo_mask = Image.new("L", (logo_side, logo_side), 0)
    mask_draw = ImageDraw.Draw(logo_mask)
    mask_draw.ellipse((0, 0, logo_side - 1, logo_side - 1), fill=255)
    canvas.paste(logo_small, (logo_x, logo_y), logo_mask)

    # Headline text with stronger contrast and larger sizes.
    font_main = get_font(max(11, int(14 * scale)))
    font_sub = get_font(max(9, int(12 * scale)))
    font_brand = get_font(max(6, int(7 * scale)))
    center_x = int(50 * scale)
    draw.text(
        (center_x, int(50 * scale)),
        title,
        fill=(242, 247, 255, 255),
        font=font_main,
        anchor="mm",
        stroke_width=max(1, int(1 * scale)),
        stroke_fill=(15, 25, 45, 220),
    )
    draw.text(
        (center_x, int(65 * scale)),
        subtitle,
        fill=accent + (255,),
        font=font_sub,
        anchor="mm",
        stroke_width=max(1, int(1 * scale)),
        stroke_fill=(8, 24, 36, 210),
    )
    # Keep brand text only when there is enough room to avoid tiny blurry letters.
    if size >= 180:
        draw.text((center_x, int(82 * scale)), "A NETWORK", fill=(145, 175, 210, 230), font=font_brand, anchor="mm")

    return canvas


def make_telegram_sticker(title, subtitle, accent):
    """Create a crisp 100x100 sticker with minimal details for Telegram clarity."""
    size = 100
    scale = 3
    big = size * scale
    canvas_big = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas_big)

    def s(v):
        return int(v * scale)

    # Draw at 4x for smoother anti-aliased final output.
    draw.ellipse((s(8), s(8), s(92), s(92)), outline=(45, 210, 255, 255), width=s(3))
    draw.ellipse((s(12), s(12), s(88), s(88)), outline=(95, 230, 255, 210), width=s(1))

    # Minimal top icon badge.
    draw.ellipse((s(40), s(10), s(60), s(30)), fill=(8, 24, 48, 255), outline=(90, 220, 255, 240), width=s(1))
    font_a = get_font(s(12))
    draw.text((s(50), s(20)), "A", fill=(242, 248, 255, 255), font=font_a, anchor="mm")

    # Single bold word only for best 100x100 clarity.
    font_word = get_font(s(16))
    draw.text(
        (s(50), s(58)),
        subtitle,
        fill=accent + (255,),
        font=font_word,
        anchor="mm",
        stroke_width=s(1),
        stroke_fill=(8, 24, 36, 215),
    )

    final_img = canvas_big.resize((size, size), Image.LANCZOS)
    return final_img.filter(ImageFilter.UnsharpMask(radius=0.9, percent=180, threshold=2))


def rgba_to_gif_frame(frame):
    """Convert RGBA frame to palette image while keeping transparent background."""
    p = frame.convert("P", palette=Image.ADAPTIVE, colors=255, dither=Image.Dither.NONE)
    alpha = frame.getchannel("A")
    transparent_mask = alpha.point(lambda a: 255 if a == 0 else 0)
    p.paste(0, mask=transparent_mask)
    p.info["transparency"] = 0
    return p


def create_animated_gif(logo, title, subtitle, accent):
    """Create a pulsing neon GIF at 512x512."""
    pulses = [0.0, 0.35, 0.7, 1.0, 0.7, 0.35]
    frames_rgba = [
        make_neon_badge_sticker(logo, title, subtitle, accent, size=512, pulse=p)
        for p in pulses
    ]
    return [rgba_to_gif_frame(frame) for frame in frames_rgba]


def main():
    root = Path(__file__).resolve().parents[1]
    out_dir = root / "docs" / "telegram_sticker_pack"
    out_big_dir = root / "docs" / "telegram_sticker_pack_big"
    out_hd_dir = root / "docs" / "telegram_sticker_pack_hd"
    out_gif_dir = root / "docs" / "telegram_sticker_pack_gif"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_big_dir.mkdir(parents=True, exist_ok=True)
    out_hd_dir.mkdir(parents=True, exist_ok=True)
    out_gif_dir.mkdir(parents=True, exist_ok=True)

    logo = ensure_logo(root)
    
    # Define neon badge sticker pack in the style of the shared sample.
    sticker_specs = [
        ("ant_power", "ANT", "POWER", (24, 230, 200), "⚡"),
        ("ant_mine", "ANT", "MINE", (90, 225, 255), "⛏️"),
        ("ant_hash", "ANT", "HASH", (120, 255, 210), "🧠"),
        ("ant_boost", "ANT", "BOOST", (0, 255, 170), "🚀"),
        ("ant_hodl", "ANT", "HODL", (130, 235, 255), "💎"),
        ("ant_lfg", "ANT", "LFG", (28, 235, 168), "🔥"),
        ("ant_moon", "ANT", "MOON", (100, 220, 255), "🌙"),
        ("ant_rise", "ANT", "RISE", (90, 245, 190), "📈"),
        ("ant_node", "ANT", "NODE", (110, 225, 255), "🌐"),
        ("ant_chain", "ANT", "CHAIN", (20, 240, 220), "⛓️"),
        ("ant_force", "ANT", "FORCE", (90, 245, 240), "🛡️"),
        ("ant_omega", "ANT", "OMEGA", (50, 225, 255), "🏁"),
        ("ant_fire", "ANT", "FIRE", (0, 255, 180), "🔥"),
        ("ant_win", "ANT", "WIN", (90, 235, 255), "🏆"),
        ("ant_max", "ANT", "MAX", (50, 255, 215), "💥"),
        ("ant_prime", "ANT", "PRIME", (70, 225, 255), "⭐"),
    ]
    
    # Create mapping
    lines = ["filename,suggested_emoji"]
    
    # Generate normal PNG, big PNG, and GIF for each sticker.
    for key, title, subtitle, accent, emoji in sticker_specs:
        sticker_100 = make_telegram_sticker(title, subtitle, accent)
        sticker_512 = make_neon_badge_sticker(logo, title, subtitle, accent, size=512)

        out_file = out_dir / f"{key}.png"
        out_file_big = out_big_dir / f"{key}_512.png"
        out_file_hd = out_hd_dir / f"{key}.png"
        out_file_gif = out_gif_dir / f"{key}.gif"

        sticker_100.save(out_file, format="PNG", optimize=True)
        sticker_512.save(out_file_big, format="PNG", optimize=True)
        sticker_512.save(out_file_hd, format="PNG", optimize=True)

        gif_frames = create_animated_gif(logo, title, subtitle, accent)
        gif_frames[0].save(
            out_file_gif,
            format="GIF",
            save_all=True,
            append_images=gif_frames[1:],
            duration=110,
            loop=0,
            optimize=True,
            disposal=2,
        )

        lines.append(f"{key}.png,{emoji}")
        print(f"Created sticker: {out_file}")
        print(f"Created big PNG: {out_file_big}")
        print(f"Created HD upload PNG: {out_file_hd}")
        print(f"Created GIF: {out_file_gif}")
    
    # Save emoji mapping
    (out_dir / "emoji_mapping.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    
    # Update readme
    readme = (
        "A Network Neon Sticker Pack\n"
        "\n"
        "16 stickers generated in ANT POWER style\n"
        "- Telegram size PNG: docs/telegram_sticker_pack (100x100)\n"
        "- Big PNG: docs/telegram_sticker_pack_big (512x512)\n"
        "- HD Upload PNG: docs/telegram_sticker_pack_hd (512x512, original names)\n"
        "- Animated GIF: docs/telegram_sticker_pack_gif (512x512 pulse)\n"
        "\n"
        "Upload to Telegram:\n"
        "1. Open Telegram and message @Stickers\n"
        "2. Use /newpack and choose a pack name\n"
        "3. Add all 100x100 files from docs/telegram_sticker_pack\n"
        "4. Assign emoji as shown in emoji_mapping.csv\n"
        "5. Publish and set an optional short name\n"
    )
    (out_dir / "README.txt").write_text(readme, encoding="utf-8")

    print(f"\nCreated complete sticker pack with {len(sticker_specs)} designs in PNG+BIG+GIF formats!")


if __name__ == "__main__":
    main()
