"""Докачивает картинки условий, которых нет в папке изображений.

Нужно для заданий, где ФИПИ вызывает ShowPictureQ("путь", "") со вторым
аргументом — старая версия парсера такие картинки пропускала.

    python fetch_images.py
"""
from __future__ import annotations

import time

import requests

from app import FIPI_ROOT, IMAGES_DIR, REMOTE_IMAGES, missing_images


def main() -> None:
    names = missing_images()
    print(f"Папка: {IMAGES_DIR}")
    print(f"Не хватает картинок: {len(names)}")
    if not names:
        return

    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0", "Referer": FIPI_ROOT + "bank/"})
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    ok = failed = 0
    for i, name in enumerate(names, 1):
        url = REMOTE_IMAGES[name]
        try:
            r = session.get(url, timeout=30)
            r.raise_for_status()
            (IMAGES_DIR / name).write_bytes(r.content)
            ok += 1
            print(f"[{i}/{len(names)}] {name}")
        except Exception as exc:
            failed += 1
            print(f"[{i}/{len(names)}] ОШИБКА {name}: {exc}")
        time.sleep(0.3)

    print(f"Готово: скачано {ok}, ошибок {failed}")


if __name__ == "__main__":
    main()
