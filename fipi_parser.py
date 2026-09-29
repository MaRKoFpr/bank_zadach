import argparse
import json
import math
import re
import time
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE = "https://ege.fipi.ru/bank/"
DEFAULT_PROJECT = "AC437B34557F88EA4115D2F374B0A07B"

# ShowPictureQ('path') и ShowPictureQ("path","") — второй аргумент встречается в части заданий
SHOW_PICTURE_RE = re.compile(r"""ShowPictureQ\(\s*['"]([^'"]+)['"]\s*(?:,[^)]*)?\)""", re.I)
COUNT_RE = re.compile(r"setQCount\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)")


def make_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/150.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        "Referer": BASE,
    })
    return s


def get_page(session, project, page=0, pagesize=10, timeout=30):
    r = session.get(
        urljoin(BASE, "questions.php"),
        params={"proj": project, "page": page, "pagesize": pagesize},
        timeout=timeout,
    )
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    return r.text


def parse_count(html):
    m = COUNT_RE.search(html)
    if not m:
        return None
    return {
        "count": int(m.group(1)),
        "page_1based": int(m.group(2)),
        "pagesize": int(m.group(3)),
    }


def extract_info(info_block):
    result = {}
    if not info_block:
        return result
    for tr in info_block.select(".task-info-content tr"):
        tds = tr.find_all("td")
        if len(tds) >= 2:
            key = tds[0].get_text(" ", strip=True).rstrip(":")
            value = tds[1].get_text(" ", strip=True)
            result[key] = value
    return result


def extract_picture_urls(task_html):
    urls = []
    for rel in SHOW_PICTURE_RE.findall(task_html):
        # ShowPictureQ receives paths relative to https://ege.fipi.ru/
        urls.append(urljoin("https://ege.fipi.ru/", rel))
    return urls


def parse_tasks(html):
    soup = BeautifulSoup(html, "html.parser")
    out = []

    blocks = [
        div for div in soup.find_all("div", class_="qblock")
        if div.get("id", "").startswith("q")
    ]

    for block in blocks:
        form = block.find("form", id=re.compile(r"^checkform"))
        guid_input = form.find("input", {"name": "guid"}) if form else None
        guid = guid_input.get("value") if guid_input else None

        cell = block.find(class_="cell_0")
        statement_html = cell.decode_contents() if cell else ""
        statement_text = cell.get_text(" ", strip=True) if cell else ""

        info = block.find_next_sibling("div")
        while info is not None and not info.get("id", "").startswith("i"):
            info = info.find_next_sibling("div")

        params = extract_info(info)

        answer_inputs = []
        if form:
            for inp in form.find_all(["input", "textarea", "select"]):
                name = inp.get("name")
                if name and name != "guid":
                    answer_inputs.append({
                        "tag": inp.name,
                        "name": name,
                        "type": inp.get("type"),
                    })

        image_urls = extract_picture_urls(statement_html)

        # На случай обычных <img src=...>
        if cell:
            for img in cell.find_all("img"):
                src = img.get("src")
                if src:
                    image_urls.append(urljoin("https://ege.fipi.ru/", src))

        # Убираем дубли, сохраняя порядок
        image_urls = list(dict.fromkeys(image_urls))

        out.append({
            "guid": guid,
            "statement_text": statement_text,
            "statement_html": statement_html,
            "properties": params,
            "answer_inputs": answer_inputs,
            "image_urls": image_urls,
        })

    return out


def download_image(session, url, target, timeout=30):
    target.parent.mkdir(parents=True, exist_ok=True)
    r = session.get(url, timeout=timeout)
    r.raise_for_status()
    target.write_bytes(r.content)


def crawl(project, output_dir, delay=0.7, pagesize=10, download_images=True):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    session = make_session()

    first_html = get_page(session, project, page=0, pagesize=pagesize)
    meta = parse_count(first_html)
    if not meta:
        raise RuntimeError("Не удалось определить количество заданий через setQCount().")

    total = meta["count"]
    total_pages = math.ceil(total / pagesize)

    print(f"Найдено заданий: {total}")
    print(f"Страниц: {total_pages}")

    jsonl_path = output_dir / "tasks.jsonl"
    metadata_path = output_dir / "metadata.json"
    images_dir = output_dir / "images"

    metadata_path.write_text(
        json.dumps(
            {
                "project": project,
                "count": total,
                "pagesize": pagesize,
                "pages": total_pages,
                "source": urljoin(BASE, f"index.php?proj={project}"),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    with jsonl_path.open("w", encoding="utf-8") as fout:
        for page in range(total_pages):
            html = first_html if page == 0 else get_page(
                session, project, page=page, pagesize=pagesize
            )
            tasks = parse_tasks(html)

            print(f"[{page + 1}/{total_pages}] заданий на странице: {len(tasks)}")

            for task in tasks:
                if download_images:
                    local_images = []
                    for idx, url in enumerate(task["image_urls"], start=1):
                        suffix = Path(url.split("?", 1)[0]).suffix or ".bin"
                        guid = task["guid"] or f"page{page}"
                        filename = f"{guid}_{idx}{suffix}"
                        target = images_dir / filename
                        try:
                            download_image(session, url, target)
                            local_images.append(str(target.relative_to(output_dir)))
                        except Exception as exc:
                            local_images.append({
                                "url": url,
                                "error": str(exc),
                            })
                    task["local_images"] = local_images

                fout.write(json.dumps(task, ensure_ascii=False) + "\n")

            if page + 1 < total_pages:
                time.sleep(delay)

    print(f"Готово: {jsonl_path}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--project", default=DEFAULT_PROJECT)
    p.add_argument("--output", default="fipi_dump")
    p.add_argument("--delay", type=float, default=0.7)
    p.add_argument("--pagesize", type=int, default=10)
    p.add_argument("--no-images", action="store_true")
    args = p.parse_args()

    crawl(
        project=args.project,
        output_dir=args.output,
        delay=args.delay,
        pagesize=args.pagesize,
        download_images=not args.no_images,
    )


if __name__ == "__main__":
    main()
