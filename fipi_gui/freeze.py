"""Собирает публичный статический сайт (без редактора) в папку dist/.

    python freeze.py                    # сайт в корне домена: https://example.ru/
    python freeze.py --base /fipi       # сайт в подпапке:   https://user.github.io/fipi/

Результат можно выложить на любой статический хостинг (GitHub Pages,
Cloudflare Pages, Netlify, Vercel, свой nginx). Проверить локально:

    python -m http.server 8000 --directory dist
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

os.environ["FIPI_MODE"] = "public"  # до импорта app: отключает редактор и служебные поля

import app as site  # noqa: E402

NOT_FOUND_HTML = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Страница не найдена</title>
<style>body{{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;
color:#15171a;background:#f4f5f7}}a{{color:#2857d6}}</style></head>
<body><div><h1>Страница не найдена</h1><p><a href="{home}">← К банку задач</a></p></div></body></html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(site.BASE_DIR / "dist"), help="папка результата")
    parser.add_argument("--base", default="", help="префикс пути сайта, например /fipi")
    args = parser.parse_args()

    if ":" in args.base or "\\" in args.base:
        # Git Bash на Windows превращает "/fipi" в "C:/Program Files/Git/fipi"
        raise SystemExit(f"Странный --base: {args.base!r}. Передай его без слэша: --base fipi")
    base = "/" + args.base.strip("/") if args.base.strip("/") else ""
    out = Path(args.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    client = site.app.test_client()
    base_url = f"http://localhost{base}/"

    def freeze(path: str, target: str) -> None:
        response = client.get(path, base_url=base_url)
        if response.status_code != 200:
            raise SystemExit(f"{path}: HTTP {response.status_code}")
        file = out / target
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(response.get_data())

    freeze("/", "index.html")
    freeze("/print/", "print/index.html")
    freeze("/data/tasks.json", "data/tasks.json")
    for guid in site.BY_GUID:
        freeze(f"/task/{guid}/", f"task/{guid}/index.html")

    shutil.copytree(site.BASE_DIR / "static", out / "static")

    images = out / "images"
    images.mkdir()
    missing = 0
    for name in site.REMOTE_IMAGES:
        source = site.IMAGES_DIR / name
        if source.exists():
            shutil.copy2(source, images / name)
        else:
            missing += 1

    (out / "404.html").write_text(NOT_FOUND_HTML.format(home=f"{base}/"), encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")  # GitHub Pages: отдавать файлы как есть

    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1e6
    print(f"Готово: {out}  ({len(site.BY_GUID)} задач, {size:.1f} МБ, префикс '{base or '/'}')")
    print(f"Решений: {sum(1 for g in site.BY_GUID if site.has_solution(g))}")
    if missing:
        print(f"Внимание: нет {missing} картинок — запусти `python fetch_images.py` там, где открывается ege.fipi.ru")
    return 0


if __name__ == "__main__":
    sys.exit(main())
