"""Crop logo mark tightly, place at ~64% of icon (normal size), rounded ICO."""
from PIL import Image, ImageDraw
from pathlib import Path
import struct
import shutil


def find_logo_bbox(im: Image.Image, bright: int = 180, margin_bottom_ratio: float = 0.12):
    im = im.convert("RGBA")
    w, h = im.size
    y_limit = int(h * (1.0 - margin_bottom_ratio))
    px = im.load()
    minx, miny, maxx, maxy = w, h, 0, 0
    found = False
    for y in range(y_limit):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 20:
                continue
            if r >= bright and g >= bright and b >= bright:
                found = True
                minx = min(minx, x)
                miny = min(miny, y)
                maxx = max(maxx, x)
                maxy = max(maxy, y)
    if not found:
        return (0, 0, w, h)
    return (minx, miny, maxx + 1, maxy + 1)


def round_corners(img: Image.Image, radius_ratio: float = 0.22) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    r = max(1, int(min(w, h) * radius_ratio))
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(img, (0, 0))
    out.putalpha(mask)
    return out


def make_icon_master(logo: Image.Image, size: int = 512, fill: float = 0.64) -> Image.Image:
    """
    fill: logo max-side / canvas size.
    0.64 ≈ normal Windows icon (not tiny, not clipped by rounded corners).
    """
    logo = logo.convert("RGBA")
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    lw, lh = logo.size
    target = size * fill
    scale = target / max(lw, lh)
    nw, nh = max(1, int(round(lw * scale))), max(1, int(round(lh * scale)))
    logo_r = logo.resize((nw, nh), Image.Resampling.LANCZOS)
    x = (size - nw) // 2
    y = (size - nh) // 2
    canvas.paste(logo_r, (x, y), logo_r)
    return round_corners(canvas, 0.22)


def png_bytes(img: Image.Image) -> bytes:
    from io import BytesIO

    b = BytesIO()
    img.save(b, format="PNG")
    return b.getvalue()


def write_ico(path: Path, images: list) -> None:
    count = len(images)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries, blobs = [], []
    for im in images:
        blob = png_bytes(im)
        w, h = im.size
        wb = 0 if w >= 256 else w
        hb = 0 if h >= 256 else h
        entries.append(struct.pack("<BBBBHHII", wb, hb, 0, 0, 1, 32, len(blob), offset))
        blobs.append(blob)
        offset += len(blob)
    with open(path, "wb") as f:
        f.write(header)
        for e in entries:
            f.write(e)
        for b in blobs:
            f.write(b)


def main():
    src = list(Path(r"C:\Users\Flyashaw\Desktop\临1").glob("*.png"))[0]
    print("source:", src)

    im = Image.open(src).convert("RGBA")
    bbox = find_logo_bbox(im)
    print("bbox:", bbox)
    cropped = im.crop(bbox)
    print("cropped:", cropped.size)

    # Normal icon fill — change here if still wrong (0.55 smaller, 0.72 larger)
    FILL = 0.64
    master = make_icon_master(cropped, 512, fill=FILL)
    print("fill=", FILL)

    out_dir = Path(r"D:\Flyphoto\src-tauri\icons")
    preview = Path(r"C:\Users\Flyashaw\Desktop\FLYPHOTO-icon-preview.png")
    master.save(preview)
    print("preview:", preview)

    for name, s in {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }.items():
        master.resize((s, s), Image.Resampling.LANCZOS).save(out_dir / name, "PNG")
        print("wrote", name)

    ico_imgs = [master.resize((s, s), Image.Resampling.LANCZOS) for s in (16, 24, 32, 48, 64, 128, 256)]
    ico_path = out_dir / "icon.ico"
    write_ico(ico_path, ico_imgs)
    print("ico bytes", ico_path.stat().st_size)

    desk_ico = Path(r"C:\Users\Flyashaw\Desktop\FLYPHOTO.ico")
    shutil.copy2(ico_path, desk_ico)

    master.resize((256, 256), Image.Resampling.LANCZOS).save(
        Path(r"D:\Flyphoto\src\assets\logo.png")
    )
    print("DONE")


if __name__ == "__main__":
    main()
