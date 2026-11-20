#!/usr/bin/env python3
"""从一张正方形源 PNG 生成 Artify / Comfy-Desktop 全套应用图标。

用法:
    python scripts/generate-icons.py <源图路径> [--dry-run]

源图要求: 正方形 PNG, 建议 >= 1024px, RGBA(带 alpha 更佳; 无 alpha 会自动补).

输出(相对仓库根, 文件名沿用 electron-builder / 主进程的既有引用路径,
所以换图不需要改任何代码或配置):
    assets/Comfy_Logo_x32.png           - 备用的小尺寸 (无硬引用, 保持全套一致)
    assets/Comfy_Logo_x64.png           - 同上
    assets/Comfy_Logo_x256.png          - win.icon (electron-builder -> exe 图标)
                                          同时被主进程 APP_ICON 用作 BrowserWindow 图标
    assets/Comfy_Logo_x512.png          - linux.icon + README + todesktop.json
    assets/Comfy_Logo_x1024.png         - 通用大图 (无硬引用)
    assets/Comfy_Logo_mac_x1024.png     - mac.icon + todesktop.json
    assets/Comfy_Logo.ico               - 归档用多尺寸 ico (无硬引用)
    resources/icon.png                  - buildResources 默认图标 (electron-builder 兜底)
    resources/installerIcon.ico         - NSIS 安装程序图标 (约定文件名, 自动采用)
    resources/uninstallerIcon.ico       - NSIS 卸载程序图标
    resources/installerHeaderIcon.ico   - NSIS 安装向导头部小图标
    packages/frontend/public/favicon.ico       - index.html 的 <link rel="icon">
    packages/frontend/public/favicon_rmbg.png  - 透明小图 (无硬引用, 保持成套)

刻意不碰:
    packages/frontend/public/comfyui.png  - ComfyUI 品牌图(App.vue alt="ComfyUI"), 非本项目 logo
    assets/Comfy_Logo.icns                - Pillow 不支持写 icns, 且该文件全仓无引用
                                            (mac 打包走 mac.icon 的 PNG)
    resources/installerHeader.bmp / installerSidebar.bmp / uninstallerSidebar.bmp
        - installer.nsh 已改用 NSIS 自带 nsis3-metro 位图, 这三个 BMP 不再显示
    resources/dmg/background*.png         - 仅 mac DMG, 与 Windows 流程无关

依赖: Pillow (pip install Pillow).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

# 仓库根 = 脚本所在目录的上一级
REPO_ROOT = Path(__file__).resolve().parent.parent

# Windows 图标标准尺寸全集 (Explorer / 任务栏 / Alt-Tab 各自挑不同档)
ICO_SIZES_FULL = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
# 安装向导头部图标只显示 16~48
ICO_SIZES_HEADER = [(16, 16), (32, 32), (48, 48)]
# 浏览器 favicon 三档足够
ICO_SIZES_FAVICON = [(16, 16), (32, 32), (48, 48)]

# (输出相对路径, 方式, 参数)
#   方式 "png" -> 缩放到 size
#   方式 "ico" -> 用 sizes 列表生成多尺寸 ico
TARGETS = [
    ("assets/Comfy_Logo_x32.png", "png", 32),
    ("assets/Comfy_Logo_x64.png", "png", 64),
    ("assets/Comfy_Logo_x256.png", "png", 256),
    ("assets/Comfy_Logo_x512.png", "png", 512),
    ("assets/Comfy_Logo_x1024.png", "png", 1024),
    ("assets/Comfy_Logo_mac_x1024.png", "png", 1024),
    ("assets/Comfy_Logo.ico", "ico", ICO_SIZES_FULL),
    ("resources/icon.png", "png", 256),
    ("resources/installerIcon.ico", "ico", ICO_SIZES_FULL),
    ("resources/uninstallerIcon.ico", "ico", ICO_SIZES_FULL),
    ("resources/installerHeaderIcon.ico", "ico", ICO_SIZES_HEADER),
    ("packages/frontend/public/favicon.ico", "ico", ICO_SIZES_FAVICON),
    ("packages/frontend/public/favicon_rmbg.png", "png", 256),
]


def load_source(path: Path) -> Image.Image:
    img = Image.open(path)
    if img.width != img.height:
        raise SystemExit(f"源图不是正方形: {img.width}x{img.height}")
    if img.width < 256:
        raise SystemExit(f"源图太小 ({img.width}px), 至少需要 256px 才能保证 ico 清晰度")
    # 统一成 RGBA, 避免 ico 保存时因调色板/灰度模式丢 alpha
    return img.convert("RGBA")


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 Artify 全套应用图标")
    ap.add_argument("source", help="正方形 PNG 源图路径")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要生成的文件, 不写入")
    args = ap.parse_args()

    src_path = Path(args.source).expanduser().resolve()
    if not src_path.is_file():
        raise SystemExit(f"源图不存在: {src_path}")

    src = load_source(src_path)
    print(f"源图: {src_path}  {src.width}x{src.height} {src.mode}\n")

    written = 0
    for rel, kind, param in TARGETS:
        out = REPO_ROOT / rel
        if kind == "png":
            size = param
            desc = f"{size}x{size} PNG"
            if not args.dry_run:
                out.parent.mkdir(parents=True, exist_ok=True)
                src.resize((size, size), Image.LANCZOS).save(out, format="PNG", optimize=True)
        else:
            sizes = param
            desc = "ICO " + "/".join(f"{w}" for w, _ in sizes)
            if not args.dry_run:
                out.parent.mkdir(parents=True, exist_ok=True)
                src.save(out, format="ICO", sizes=sizes)
        print(f"  {'[skip] ' if args.dry_run else '[write]'} {rel}  ({desc})")
        written += 1

    print(f"\n{'将生成' if args.dry_run else '已生成'} {written} 个文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
