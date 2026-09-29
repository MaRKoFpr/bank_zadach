from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import xml.etree.ElementTree as ET
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

import requests
from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    render_template,
    request,
    send_from_directory,
    url_for,
)
from markupsafe import Markup

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = Path(os.environ.get("FIPI_DATA_FILE", BASE_DIR / "data" / "tasks.jsonl"))
REFERENCE_FILE = Path(
    os.environ.get("FIPI_REFERENCE_FILE", BASE_DIR / "data" / "reference_solutions.json")
)
SOLUTIONS_FILE = Path(os.environ.get("FIPI_SOLUTIONS_FILE", BASE_DIR / "data" / "solutions.json"))


def _default_images_dir() -> Path:
    for candidate in (BASE_DIR / "data" / "images", BASE_DIR.parent / "fipi_dump" / "images"):
        if candidate.is_dir():
            return candidate
    return BASE_DIR / "data" / "images"


IMAGES_DIR = Path(os.environ.get("FIPI_IMAGES_DIR", _default_images_dir()))
FIPI_ROOT = "https://ege.fipi.ru/"

# admin  — локальный запуск учителем: редактор решений, служебные поля разметки, PDF-файлом;
# public — сборка статического сайта для учеников (freeze.py): только чтение.
ADMIN = os.environ.get("FIPI_MODE", "admin").strip().lower() != "public"

app = Flask(__name__)
app.jinja_env.globals["admin"] = ADMIN


def load_tasks(path: Path) -> list[dict]:
    if not path.exists():
        raise FileNotFoundError(
            f"Не найден файл данных: {path}\n"
            "Укажи путь через переменную окружения FIPI_DATA_FILE."
        )

    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"Ошибка JSON в {path}, строка {line_number}: {exc}"
                ) from exc
    return rows


TASKS = load_tasks(DATA_FILE)
BY_GUID = {t.get("guid"): t for t in TASKS if t.get("guid")}


# ---------------------------------------------------------------------------
# Постоянные номера задач: на них ссылаются коды подборок, поэтому номер,
# однажды выданный задаче, никогда не меняется. Новые задачи получают
# следующие номера (в порядке файла), удалённые — свой номер не освобождают.
# ---------------------------------------------------------------------------

TASK_IDS_FILE = Path(os.environ.get("FIPI_TASK_IDS_FILE", BASE_DIR / "data" / "task_ids.json"))


def load_task_ids() -> tuple[dict[str, int], bool]:
    ids: dict[str, int] = {}
    if TASK_IDS_FILE.exists():
        ids = {guid: int(n) for guid, n in json.loads(TASK_IDS_FILE.read_text(encoding="utf-8")).items()}
    next_id = max(ids.values(), default=0) + 1
    changed = False
    for task in TASKS:
        guid = task.get("guid")
        if guid and guid not in ids:
            ids[guid] = next_id
            next_id += 1
            changed = True
    return ids, changed


TASK_IDS, _task_ids_changed = load_task_ids()
if _task_ids_changed and ADMIN:  # публичная сборка файл не трогает — см. предупреждение в freeze.py
    TASK_IDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    TASK_IDS_FILE.write_text(
        json.dumps(TASK_IDS, ensure_ascii=False, indent=0, sort_keys=False), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Решения: эталонные (read-only файл) + правки пользователя (solutions.json)
# ---------------------------------------------------------------------------

def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


REFERENCE = _read_json(REFERENCE_FILE)
USER_SOLUTIONS = _read_json(SOLUTIONS_FILE)
SOLUTIONS_LOCK = threading.Lock()


def get_solution(guid: str) -> dict | None:
    """Актуальное решение: правка пользователя поверх эталона."""
    user = USER_SOLUTIONS.get(guid)
    if user is not None:
        return {**user, "edited": True, "has_reference": guid in REFERENCE}
    ref = REFERENCE.get(guid)
    if ref is not None:
        return {**ref, "edited": False, "has_reference": True}
    return None


def has_solution(guid: str) -> bool:
    sol = get_solution(guid)
    return bool(sol and (sol.get("answer") or sol.get("solution")))


def save_user_solutions() -> None:
    SOLUTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SOLUTIONS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(USER_SOLUTIONS, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(SOLUTIONS_FILE)


# ---------------------------------------------------------------------------
# Условие задачи: MathML + картинки на своих местах
# ---------------------------------------------------------------------------

SCRIPT_RE = re.compile(r"<script\b[^>]*>(.*?)</script>", re.I | re.S)
SHOW_PICTURE_RE = re.compile(r"""ShowPictureQ\(\s*['"]([^'"]+)['"]\s*(?:,[^)]*)?\)""", re.I)
EVENT_ATTR_RE = re.compile(r"""\s+on[a-z]+\s*=\s*(['"]).*?\1""", re.I | re.S)
MATH_PREFIX_RE = re.compile(r"(<\/?)m:")


def task_picture_urls(task: dict) -> list[str]:
    """Все картинки условия в порядке появления (та же логика, что в fipi_parser)."""
    raw = task.get("statement_html") or ""
    urls = [urljoin(FIPI_ROOT, rel) for rel in SHOW_PICTURE_RE.findall(raw)]
    return list(dict.fromkeys(urls))


def local_image_name(task: dict, index: int, url: str) -> str:
    suffix = Path(url.split("?", 1)[0]).suffix or ".bin"
    return f"{task.get('guid')}_{index}{suffix}"


# Имя локального файла -> исходный URL на ФИПИ (для докачки отсутствующих картинок)
REMOTE_IMAGES = {
    local_image_name(task, i, url): url
    for task in TASKS
    for i, url in enumerate(task_picture_urls(task), 1)
}
FAILED_IMAGES: set[str] = set()
IMAGE_FETCH_LOCK = threading.Lock()
FIPI_RETRY_AFTER = 600  # сек: если ФИПИ не отвечает, не долбим его на каждую картинку
fipi_down_until = 0.0


def image_src(task: dict, url: str) -> str:
    # Всегда локальный адрес: внешние ссылки на недоступный ege.fipi.ru
    # подвешивают страницу (и headless-браузер при печати PDF).
    urls = task_picture_urls(task)
    if url in urls:
        return url_for("task_image", filename=local_image_name(task, urls.index(url) + 1, url))
    return url


def fetch_remote_image(name: str) -> bool:
    """Пробует один раз докачать картинку с ФИПИ в IMAGES_DIR."""
    global fipi_down_until
    url = REMOTE_IMAGES.get(name)
    if not url or name in FAILED_IMAGES or time.monotonic() < fipi_down_until:
        return False
    with IMAGE_FETCH_LOCK:
        target = IMAGES_DIR / name
        if target.exists():
            return True
        if time.monotonic() < fipi_down_until:
            return False
        try:
            r = requests.get(url, timeout=(3, 8), headers={"Referer": FIPI_ROOT + "bank/"})
            r.raise_for_status()
        except requests.HTTPError as exc:  # файла нет на сервере — больше не пытаемся
            FAILED_IMAGES.add(name)
            app.logger.warning("Не удалось скачать %s: %s", url, exc)
            return False
        except Exception as exc:  # сеть/таймаут — ФИПИ недоступен, пауза
            fipi_down_until = time.monotonic() + FIPI_RETRY_AFTER
            app.logger.warning("Не удалось скачать %s: %s", url, exc)
            return False
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        target.write_bytes(r.content)
        return True


MATH_BLOCK_RE = re.compile(r"<math\b.*?</math>", re.I | re.S)
MFENCED_INNER_RE = re.compile(r"<mfenced\b([^>]*)>((?:(?!<mfenced\b).)*?)</mfenced>", re.I | re.S)


def _fence_attr(attrs: str, name: str, default: str) -> str:
    m = re.search(rf"""\b{name}\s*=\s*(['"])(.*?)\1""", attrs)
    return m.group(2) if m else default


def _mfenced_element(el: ET.Element) -> None:
    """<mfenced open close separators> -> <mrow><mo>open</mo>…<mo>close</mo></mrow> (рекурсивно)."""
    for child in list(el):
        _mfenced_element(child)
    for i, child in enumerate(list(el)):
        if child.tag != "mfenced":
            continue
        opening = child.get("open", "(")
        closing = child.get("close", ")")
        separators = "".join(child.get("separators", ",").split())
        row = ET.Element("mrow")
        row.tail = child.tail
        parts = list(child)
        if opening:
            ET.SubElement(row, "mo", fence="true").text = opening
        for j, part in enumerate(parts):
            part.tail = None
            row.append(part)
            if j < len(parts) - 1 and separators:
                ET.SubElement(row, "mo", separator="true").text = separators[min(j, len(separators) - 1)]
        if closing:
            ET.SubElement(row, "mo", fence="true").text = closing
        el.remove(child)
        el.insert(i, row)


def expand_mfenced(raw: str) -> str:
    """Chromium не поддерживает устаревший <mfenced> — скобки пропадают."""
    if "mfenced" not in raw:
        return raw

    def fix_block(match: re.Match) -> str:
        block = match.group(0)
        if "mfenced" not in block:
            return block
        try:
            root = ET.fromstring(block.replace("&nbsp;", " "))
            _mfenced_element(root)
            return ET.tostring(root, encoding="unicode")
        except ET.ParseError:
            # Запасной вариант без разделителей для невалидного XML
            prev = None
            while prev != block:
                prev = block
                block = MFENCED_INNER_RE.sub(
                    lambda m: (
                        f"<mrow><mo>{_fence_attr(m.group(1), 'open', '(')}</mo>{m.group(2)}"
                        f"<mo>{_fence_attr(m.group(1), 'close', ')')}</mo></mrow>"
                    ),
                    block,
                )
            return block

    return MATH_BLOCK_RE.sub(fix_block, raw)


def missing_images() -> list[str]:
    return [name for name in REMOTE_IMAGES if not (IMAGES_DIR / name).exists()]


def human_statement_html(task: dict) -> Markup:
    """FIPI HTML -> чистый HTML: MathML без префиксов, картинки вместо скриптов."""
    raw = task.get("statement_html") or ""
    if not raw:
        return Markup.escape(task.get("statement_text") or "")

    def replace_script(match: re.Match) -> str:
        pic = SHOW_PICTURE_RE.search(match.group(1))
        if not pic:
            return ""
        src = image_src(task, urljoin(FIPI_ROOT, pic.group(1)))
        return f'<img class="fipi-img" src="{html.escape(src)}" alt="[рисунок не загружен]">'

    raw = SCRIPT_RE.sub(replace_script, raw)
    raw = EVENT_ATTR_RE.sub("", raw)

    # <m:math>, <m:mi> ... -> <math>, <mi> ...
    raw = MATH_PREFIX_RE.sub(r"\1", raw)
    raw = expand_mfenced(raw)
    raw = re.sub(
        r"<math(?![^>]*xmlns=)",
        '<math xmlns="http://www.w3.org/1998/Math/MathML"',
        raw,
        flags=re.I,
    )
    return Markup(raw)


# ---------------------------------------------------------------------------
# Текст решения: лёгкий markdown + LaTeX ($...$, $$...$$ — рендерит KaTeX)
# ---------------------------------------------------------------------------

MATH_SEGMENT_RE = re.compile(r"(\$\$.+?\$\$|\$[^$\n]+?\$)", re.S)
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
ITALIC_RE = re.compile(r"(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])")
LIST_ITEM_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")


def _inline(text: str) -> str:
    """Экранирует HTML и применяет **жирный**/*курсив* вне формул."""
    out = []
    for i, part in enumerate(MATH_SEGMENT_RE.split(text)):
        if i % 2:
            out.append(html.escape(part, quote=False))
        else:
            part = html.escape(part, quote=False)
            part = BOLD_RE.sub(r"<strong>\1</strong>", part)
            part = ITALIC_RE.sub(r"<em>\1</em>", part)
            out.append(part)
    return "".join(out)


def render_solution_text(text: str) -> Markup:
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        return Markup("")
    blocks = re.split(r"\n\s*\n", text)
    parts = []
    for block in blocks:
        lines = block.split("\n")
        if all(LIST_ITEM_RE.match(line) for line in lines):
            ordered = bool(re.match(r"^\s*\d", lines[0]))
            tag = "ol" if ordered else "ul"
            items = "".join(f"<li>{_inline(LIST_ITEM_RE.sub('', line))}</li>" for line in lines)
            parts.append(f"<{tag}>{items}</{tag}>")
        elif block.startswith("### ") or block.startswith("## "):
            parts.append(f"<h4>{_inline(block.lstrip('#').strip())}</h4>")
        else:
            parts.append("<p>" + "<br>".join(_inline(line) for line in lines) + "</p>")
    return Markup("\n".join(parts))


def plural(n: int, one: str, few: str, many: str) -> str:
    """plural(21, "задача", "задачи", "задач") -> "21 задача"."""
    if n % 10 == 1 and n % 100 != 11:
        word = one
    elif 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        word = few
    else:
        word = many
    return f"{n} {word}"


app.jinja_env.filters["plural"] = plural
app.jinja_env.globals.update(
    human_statement_html=human_statement_html,
    render_solution_text=render_solution_text,
    get_solution=get_solution,
)


# ---------------------------------------------------------------------------
# Фильтры
# ---------------------------------------------------------------------------

def status_label(task: dict) -> str:
    return task.get("classification_status") or "unknown"


def number_label(task: dict) -> str:
    if task.get("classification_category") == "ege_2026_12":
        return "ege_2026_12"
    number = task.get("ege_2027_number")
    return str(number) if number is not None else "uncertain"


def number_title(task: dict) -> str:
    label = number_label(task)
    if label == "ege_2026_12":
        return "12 ЕГЭ 2026"
    if label == "uncertain":
        return "Без номера"
    return f"№ {label}"


# Условие не меняется — HTML считаем один раз (ключ учитывает префикс сайта)
_STATEMENT_CACHE: dict[tuple[str, str], str] = {}


def cached_statement_html(task: dict) -> str:
    key = (request.script_root, task.get("guid"))
    if key not in _STATEMENT_CACHE:
        _STATEMENT_CACHE[key] = str(human_statement_html(task))
    return _STATEMENT_CACHE[key]


def task_payload(task: dict) -> dict:
    """Всё, что нужно браузеру, чтобы нарисовать карточку задачи и отфильтровать её."""
    guid = task.get("guid")
    props = task.get("properties") or {}
    sol = get_solution(guid) or {}
    item = {
        "id": TASK_IDS[guid],
        "guid": guid,
        "n": number_label(task),
        "title": number_title(task),
        "type": props.get("Тип ответа", ""),
        "kes": props.get("КЭС", ""),
        "html": cached_statement_html(task),
        "answer": sol.get("answer", ""),
        "solution": str(render_solution_text(sol.get("solution", ""))),
        "url": url_for("task_detail", guid=guid),
    }
    if ADMIN:
        item.update(
            status=task.get("classification_status") or "",
            confidence=task.get("classification_confidence"),
            reason=task.get("classification_reason") or "",
            edited=bool(sol.get("edited")),
        )
    return item


def number_options() -> list[tuple[str, str, int]]:
    counts = Counter(number_label(t) for t in TASKS)
    options = [(str(n), f"№{n}", counts.get(str(n), 0)) for n in range(1, 21)]
    options.append(("ege_2026_12", "12 ЕГЭ 2026", counts.get("ege_2026_12", 0)))
    if ADMIN or counts.get("uncertain"):
        options.append(("uncertain", "Без номера", counts.get("uncertain", 0)))
    return [o for o in options if o[2] or ADMIN]


def admin_only() -> None:
    if not ADMIN:
        abort(403)


@app.route("/")
def index():
    return render_template(
        "index.html",
        all_count=len(TASKS),
        solved_count=sum(1 for t in TASKS if has_solution(t.get("guid"))),
        edited_count=len(USER_SOLUTIONS),
        number_options=number_options(),
        status_counts=Counter(status_label(t) for t in TASKS),
        pdf_download=ADMIN and find_browser() is not None,
    )


@app.route("/data/tasks.json")
def tasks_json():
    body = json.dumps([task_payload(t) for t in TASKS], ensure_ascii=False, separators=(",", ":"))
    return Response(body, mimetype="application/json", headers={"Cache-Control": "no-cache"})


@app.route("/print/")
def print_page():
    """Версия для печати: задачи рисует JS по тем же фильтрам, что и в списке."""
    return render_template("print.html")


@app.route("/task/<guid>/")
def task_detail(guid: str):
    task = BY_GUID.get(guid)
    if not task:
        abort(404)
    return render_template(
        "task.html",
        task=task,
        task_id=TASK_IDS[guid],
        solution=get_solution(guid),
        title=number_title(task),
        statement=Markup(cached_statement_html(task)),
    )


@app.route("/images/<path:filename>")
def task_image(filename: str):
    if not (IMAGES_DIR / filename).is_file() and not fetch_remote_image(filename):
        abort(404)
    return send_from_directory(IMAGES_DIR, filename, max_age=86400)


# ---------------------------------------------------------------------------
# API решений
# ---------------------------------------------------------------------------

@app.post("/api/solutions/<guid>")
def save_solution(guid: str):
    admin_only()
    if guid not in BY_GUID:
        abort(404)
    data = request.get_json(silent=True) or {}
    answer = str(data.get("answer") or "").strip()
    solution = str(data.get("solution") or "").replace("\r\n", "\n").strip()
    with SOLUTIONS_LOCK:
        USER_SOLUTIONS[guid] = {
            "answer": answer,
            "solution": solution,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        save_user_solutions()
    return jsonify(ok=True, html=str(render_solution_text(solution)), solution=get_solution(guid))


@app.delete("/api/solutions/<guid>")
def reset_solution(guid: str):
    """Удаляет правку пользователя — снова показывается эталон."""
    admin_only()
    if guid not in BY_GUID:
        abort(404)
    with SOLUTIONS_LOCK:
        if USER_SOLUTIONS.pop(guid, None) is not None:
            save_user_solutions()
    sol = get_solution(guid) or {}
    return jsonify(
        ok=True,
        solution=sol,
        html=str(render_solution_text(sol.get("solution", ""))),
    )


@app.post("/api/preview")
def preview_solution():
    admin_only()
    data = request.get_json(silent=True) or {}
    return jsonify(html=str(render_solution_text(str(data.get("solution") or ""))))


# ---------------------------------------------------------------------------
# Экспорт в PDF
# ---------------------------------------------------------------------------

BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def find_browser() -> str | None:
    env = os.environ.get("FIPI_BROWSER")
    if env and Path(env).exists():
        return env
    for candidate in BROWSER_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    for name in ("google-chrome", "chromium", "chromium-browser", "chrome", "msedge"):
        found = shutil.which(name)
        if found:
            return found
    return None


@app.route("/export.pdf")
def export_pdf():
    """Только админка: готовый PDF-файл через headless Chrome/Edge.
    На публичном сайте PDF делает сам браузер ученика (печать → «Сохранить как PDF»)."""
    admin_only()
    params = {k: v for k, v in request.args.items() if k != "print"}
    browser = find_browser()
    print_url = request.host_url.rstrip("/") + url_for("print_page", **params)
    if not browser:
        return Response(status=302, headers={"Location": url_for("print_page", print="1", **params)})

    with tempfile.TemporaryDirectory(prefix="fipi_pdf_") as tmp:
        out = Path(tmp) / "out.pdf"
        cmd = [
            browser,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            f"--user-data-dir={Path(tmp) / 'profile'}",
            "--no-pdf-header-footer",
            "--run-all-compositor-stages-before-draw",
            "--virtual-time-budget=20000",
            f"--print-to-pdf={out}",
            print_url,
        ]
        try:
            subprocess.run(cmd, capture_output=True, timeout=300, check=False)
        except subprocess.TimeoutExpired:
            abort(504, "Браузер не успел сформировать PDF")
        if not out.exists() or out.stat().st_size == 0:
            abort(500, "Не удалось сформировать PDF через headless-браузер")
        data = out.read_bytes()

    name = "fipi_" + (params.get("number") or "all") + ("_solutions" if params.get("solutions") else "") + ".pdf"
    return Response(
        data,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


if __name__ == "__main__":
    print(f"Loaded {len(TASKS)} tasks from {DATA_FILE}")
    print(f"Images: {IMAGES_DIR} (нет локально: {len(missing_images())}, докачать: python fetch_images.py)")
    print(f"Reference solutions: {len(REFERENCE)}, user edits: {len(USER_SOLUTIONS)}")
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=True, threaded=True)
