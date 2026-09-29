"use strict";

// ---------------------------------------------------------------------------
// Общее: формулы, экранирование, загрузка и фильтрация задач
// ---------------------------------------------------------------------------

const MATH_DELIMITERS = [
  { left: "$$", right: "$$", display: true },
  { left: "$", right: "$", display: false },
  { left: "\\(", right: "\\)", display: false },
  { left: "\\[", right: "\\]", display: true },
];

function renderMath(root) {
  if (!root || typeof renderMathInElement !== "function") return;
  const targets = root.classList && root.classList.contains("math-text")
    ? [root]
    : root.querySelectorAll(".math-text");
  targets.forEach((el) => renderMathInElement(el, { delimiters: MATH_DELIMITERS, throwOnError: false }));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  const word = n10 === 1 && n100 !== 11 ? one
    : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? few : many;
  return `${n} ${word}`;
}

const isAdmin = () => document.body.dataset.admin === "1";
const normalize = (text) => String(text || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

async function loadTasks(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const tasks = await response.json();
  tasks.forEach((task, index) => {
    task.order = index;
    task.haystack = normalize([
      task.guid, task.kes, task.answer, task.reason,
      task.html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "),
    ].join(" "));
  });
  return tasks;
}

const FILTER_KEYS = ["q", "number", "status", "type", "solution"];
const PRINT_OPTIONS = ["solutions", "answers", "grid"];
const NUMBER_ORDER = (n) => (/^\d+$/.test(n) ? Number(n) : n === "ege_2026_12" ? 100 : 200);

function readParams(search = location.search) {
  const params = new URLSearchParams(search);
  const out = {};
  FILTER_KEYS.forEach((key) => (out[key] = (params.get(key) || "").trim()));
  return out;
}

function filterTasks(tasks, f) {
  const words = normalize(f.q).split(" ").filter(Boolean);
  return tasks
    .filter((t) => !f.number || t.n === f.number)
    .filter((t) => !f.status || t.status === f.status)
    .filter((t) => !f.type || t.type === f.type)
    .filter((t) => {
      const has = Boolean(t.answer || t.solution);
      if (f.solution === "yes") return has;
      if (f.solution === "no") return !has;
      if (f.solution === "edited") return t.edited;
      return true;
    })
    .filter((t) => words.every((w) => t.haystack.includes(w)))
    .sort((a, b) => NUMBER_ORDER(a.n) - NUMBER_ORDER(b.n) || a.order - b.order);
}

function selectionTitle(f) {
  let title = !f.number ? "Подборка задач"
    : f.number === "ege_2026_12" ? "Задание 12 (ЕГЭ 2026)"
    : f.number === "uncertain" ? "Задачи без номера"
    : `Задание №${f.number}`;
  if (f.type) title += ` · ${f.type.toLowerCase()}`;
  if (f.q) title += ` · «${f.q}»`;
  return title;
}

// ---------------------------------------------------------------------------
// Код подборки
//
// Задача идентифицируется постоянным номером (data/task_ids.json), поэтому код
// не зависит от порядка задач в базе и переживает её обновление.
// Битовый формат (старшие биты первыми):
//   версия (5) | ширина номера W−1 (4) | число задач N−1 (11) | N номеров по W бит | контроль (15)
// дополнение нулями до кратного 5 и запись в base32 Крокфорда (без I, L, O, U),
// группами по 4 символа. Порядок задач сохраняется; опечатку ловит контрольная сумма.
// ---------------------------------------------------------------------------

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_VERSION = 1;
const CODE_MAX_TASKS = 2048;

const CODE_CHECK_BITS = 15;
const CODE_CHECK_MOD = 32749; // простое < 2^15

function codeChecksum(width, ids) {
  let hash = (CODE_VERSION * 31 + width) % CODE_CHECK_MOD;
  hash = (hash * 131 + ids.length) % CODE_CHECK_MOD;
  for (const id of ids) hash = (hash * 131 + id) % CODE_CHECK_MOD;
  return hash;
}

function encodePickCode(ids) {
  if (!ids.length) throw new Error("Подборка пуста");
  if (ids.length > CODE_MAX_TASKS) throw new Error(`В подборке больше ${CODE_MAX_TASKS} задач`);
  const width = Math.max(...ids.map((id) => id.toString(2).length));
  if (width > 16) throw new Error("Слишком большой номер задачи");

  const bits = [];
  const push = (value, size) => {
    for (let i = size - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(CODE_VERSION, 5);
  push(width - 1, 4);
  push(ids.length - 1, 11);
  ids.forEach((id) => push(id, width));
  push(codeChecksum(width, ids), CODE_CHECK_BITS);
  while (bits.length % 5) bits.push(0);

  let code = "";
  for (let i = 0; i < bits.length; i += 5) {
    code += CODE_ALPHABET[bits.slice(i, i + 5).reduce((acc, bit) => acc * 2 + bit, 0)];
  }
  return code.match(/.{1,4}/g).join("-");
}

function decodePickCode(raw) {
  const clean = String(raw || "").toUpperCase().replace(/[\s\-_.]/g, "")
    .replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!clean) throw new Error("Введите код");

  const bits = [];
  for (const ch of clean) {
    const value = CODE_ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`Недопустимый символ «${ch}»`);
    for (let i = 4; i >= 0; i--) bits.push((value >> i) & 1);
  }
  let pos = 0;
  const read = (size) => {
    if (pos + size > bits.length) throw new Error("Код обрезан — проверьте, что скопирован целиком");
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 2 + bits[pos++];
    return value;
  };

  if (read(5) !== CODE_VERSION) throw new Error("Неизвестная версия кода");
  const width = read(4) + 1;
  const count = read(11) + 1;
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(read(width));
  if (read(CODE_CHECK_BITS) !== codeChecksum(width, ids)) throw new Error("Код с ошибкой — проверьте символы");
  if (bits.length - pos >= 5 || bits.slice(pos).some(Boolean)) throw new Error("Код с ошибкой — лишние символы");
  if (ids.some((id) => id < 1) || new Set(ids).size !== ids.length) throw new Error("Код с ошибкой");
  return ids;
}

// ---------------------------------------------------------------------------
// Подборка: хранится в браузере (localStorage), синхронизируется между вкладками
// ---------------------------------------------------------------------------

const Pick = {
  key: "fipi.pick.v1",
  listeners: [],

  ids() {
    try {
      const data = JSON.parse(localStorage.getItem(this.key) || "[]");
      return Array.isArray(data) ? data.filter((n) => Number.isInteger(n) && n > 0) : [];
    } catch {
      return this._memory || [];
    }
  },

  set(ids) {
    try {
      localStorage.setItem(this.key, JSON.stringify([...new Set(ids)]));
    } catch {
      /* приватный режим и т. п. — подборка просто не сохранится между визитами */
      this._memory = [...new Set(ids)];
    }
    this.emit();
  },

  has(id) { return this.ids().includes(id); },

  toggle(id, on) {
    const ids = this.ids().filter((n) => n !== id);
    if (on) ids.push(id);
    this.set(ids);
  },

  code() { return encodePickCode(this.ids()); },
  onChange(fn) { this.listeners.push(fn); },
  emit() { this.listeners.forEach((fn) => fn(this.ids())); },
};

window.addEventListener("storage", (event) => event.key === Pick.key && Pick.emit());

function syncPickChecks(root = document) {
  const ids = new Set(Pick.ids());
  root.querySelectorAll("input[data-pick]").forEach((box) => {
    box.checked = ids.has(Number(box.dataset.pick));
  });
}

function pickCheckbox(id) {
  return `<label class="check pick-check"><input type="checkbox" data-pick="${id}"${Pick.has(id) ? " checked" : ""}> В подборку</label>`;
}

// ---------------------------------------------------------------------------
// Список задач (главная)
// ---------------------------------------------------------------------------

function taskCard(t) {
  const chips = [`<span class="chip ${t.n === "ege_2026_12" || t.n === "uncertain" ? "warning" : "number"}">${escapeHtml(t.title)}</span>`];
  if (t.type) chips.push(`<span class="chip">${escapeHtml(t.type)}</span>`);
  if (isAdmin() && t.confidence != null) {
    chips.push(`<span class="chip ${t.status === "uncertain" ? "warning" : "success"}">${Math.round(t.confidence * 100)}%</span>`);
  }
  if (t.edited) chips.push('<span class="chip accent-outline">решение изменено</span>');

  let solution = "";
  if (t.answer || t.solution) {
    solution = `
      <details class="solution-inline">
        <summary>${t.solution ? "Решение и ответ" : "Ответ"}</summary>
        <div class="solution-body math-text">
          ${t.solution}
          ${t.answer ? `<p><strong>Ответ:</strong> ${escapeHtml(t.answer)}</p>` : ""}
        </div>
      </details>`;
  }

  const meta = [`<div><span class="meta-label">Тема (КЭС)</span><span>${escapeHtml(t.kes || "—")}</span></div>`];
  if (isAdmin()) meta.push(`<div><span class="meta-label">Почему этот номер</span><span>${escapeHtml(t.reason)}</span></div>`);

  return `
    <article class="task-card ${t.status === "uncertain" ? "task-card-uncertain" : ""}">
      <div class="task-card-top">
        <div class="chips">${chips.join("")}</div>
        <a class="guid" href="${t.url}">${escapeHtml(t.guid)}</a>
      </div>
      <div class="statement">${t.html}</div>
      ${solution}
      <div class="meta-grid">${meta.join("")}</div>
      <div class="card-actions">
        ${pickCheckbox(t.id)}
        ${isAdmin() ? `<a class="button small ghost" href="${t.url}#solution">${t.answer || t.solution ? "Редактировать решение" : "Добавить решение"}</a>` : ""}
        <a class="button small" href="${t.url}">Открыть задачу</a>
      </div>
    </article>`;
}

function setupTaskList(form) {
  const list = document.getElementById("task-list");
  const pagination = document.getElementById("pagination");
  const totalEl = document.querySelector("[data-total]");
  const pageInfo = document.querySelector("[data-page-info]");
  const exportForm = document.getElementById("export");
  const exportCount = document.querySelector("[data-export-count]");
  const banner = document.getElementById("pick-banner");
  let tasks = [];
  let page = 1;
  let pickMode = false;

  function shownTasks() {
    if (!pickMode) return filterTasks(tasks, currentFilters());
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return Pick.ids().map((id) => byId.get(id)).filter(Boolean);
  }

  function setPickMode(on) {
    pickMode = on;
    page = 1;
    render({ scroll: on });
  }

  function currentFilters() {
    const f = {};
    FILTER_KEYS.forEach((key) => (f[key] = form.elements[key] ? form.elements[key].value.trim() : ""));
    return f;
  }

  function syncUrl(f) {
    const params = new URLSearchParams();
    FILTER_KEYS.forEach((key) => f[key] && params.set(key, f[key]));
    const perPage = form.elements.per_page.value;
    if (perPage !== "20") params.set("per_page", perPage);
    if (page > 1) params.set("page", page);
    if (pickMode) params.set("view", "pick");
    const query = params.toString();
    history.replaceState(null, "", query ? `?${query}` : location.pathname);
  }

  function render({ scroll = false } = {}) {
    const f = currentFilters();
    const filtered = shownTasks();
    const perPage = Number(form.elements.per_page.value) || 20;
    const pages = Math.max(Math.ceil(filtered.length / perPage), 1);
    page = Math.min(Math.max(page, 1), pages);
    const current = filtered.slice((page - 1) * perPage, page * perPage);
    const count = plural(filtered.length, "задача", "задачи", "задач");

    banner.hidden = !pickMode;
    form.classList.toggle("is-muted", pickMode);
    totalEl.textContent = pickMode ? `В подборке: ${filtered.length}` : `Найдено: ${filtered.length}`;
    pageInfo.textContent = `Страница ${page} из ${pages}`;
    exportCount.textContent = pickMode ? `${count} из подборки` : `${count} по текущим фильтрам`;
    exportForm.querySelectorAll("button").forEach((b) => (b.disabled = !filtered.length));

    const empty = pickMode
      ? '<div class="empty"><strong>Подборка пуста</strong><span>Отмечайте задачи галочкой «В подборку» или откройте подборку по коду.</span></div>'
      : '<div class="empty"><strong>Ничего не найдено</strong><span>Попробуй изменить фильтры или поисковый запрос.</span></div>';
    list.innerHTML = current.length ? current.map(taskCard).join("") : empty;
    renderMath(list);

    pagination.hidden = pages <= 1;
    pagination.querySelector("[data-pages]").textContent = `${page} / ${pages}`;
    pagination.querySelector('[data-page="prev"]').disabled = page <= 1;
    pagination.querySelector('[data-page="next"]').disabled = page >= pages;

    syncUrl(f);
    if (scroll) document.querySelector(".results-bar").scrollIntoView({ behavior: "smooth" });
  }

  // Восстанавливаем фильтры из адресной строки (ссылку с фильтром можно отправить ученикам)
  const initial = new URLSearchParams(location.search);
  [...FILTER_KEYS, "per_page"].forEach((key) => {
    if (form.elements[key] && initial.get(key)) form.elements[key].value = initial.get(key);
  });
  page = Number(initial.get("page")) || 1;
  pickMode = initial.get("view") === "pick";

  // Ссылка вида ?set=КОД открывает чужую подборку
  if (initial.get("set")) {
    try {
      const ids = decodePickCode(initial.get("set"));
      const current = Pick.ids();
      const same = current.length === ids.length && current.every((id, i) => id === ids[i]);
      if (!current.length || same ||
          confirm(`Заменить вашу подборку (${plural(current.length, "задача", "задачи", "задач")}) подборкой из ссылки (${plural(ids.length, "задача", "задачи", "задач")})?`)) {
        Pick.set(ids);
        pickMode = true;
        page = 1;
      }
    } catch (err) {
      alert("Не удалось открыть подборку из ссылки: " + err.message);
    }
  }

  // На телефоне второстепенные фильтры свёрнуты; раскрываем, если какой-то уже задан
  const toggle = form.querySelector("[data-filters-toggle]");
  const setOpen = (open) => {
    form.classList.toggle("filters-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Скрыть фильтры" : "Ещё фильтры";
  };
  toggle.addEventListener("click", () => setOpen(!form.classList.contains("filters-open")));
  setOpen(["status", "type", "solution"].some((key) => initial.get(key)));

  let searchTimer = null;
  form.addEventListener("input", (event) => {
    page = 1;
    pickMode = false; // тронули фильтр — значит, хотят искать по всей базе
    if (event.target.name === "q") {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(render, 200);
    } else {
      render();
    }
  });
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("reset", () => setTimeout(() => { page = 1; pickMode = false; render(); }));

  pagination.addEventListener("click", (event) => {
    const dir = event.target.closest("[data-page]")?.dataset.page;
    if (!dir) return;
    page += dir === "next" ? 1 : -1;
    render({ scroll: true });
  });

  Pick.onChange(() => (pickMode ? render() : syncPickChecks(list)));
  banner.querySelector('[data-action="show-all"]').addEventListener("click", () => setPickMode(false));

  exportForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const params = new URLSearchParams();
    if (pickMode) {
      params.set("set", Pick.code());
    } else {
      const f = currentFilters();
      FILTER_KEYS.forEach((key) => f[key] && params.set(key, f[key]));
    }
    PRINT_OPTIONS.forEach((key) => exportForm.elements[key].checked && params.set(key, "1"));
    const mode = event.submitter?.dataset.export || "print";
    let url;
    if (mode === "pdf") {
      url = exportForm.dataset.pdfUrl;
    } else {
      url = exportForm.action;
      if (!isAdmin()) params.set("print", "1");
    }
    window.open(`${url}?${params}`, "_blank", "noopener");
  });

  loadTasks(form.dataset.tasksUrl)
    .then((data) => { tasks = data; render(); })
    .catch((err) => {
      totalEl.textContent = "Не удалось загрузить задачи";
      list.innerHTML = `<div class="empty"><strong>Ошибка загрузки</strong><span>${escapeHtml(err.message)}</span></div>`;
    });

  return { showPick: () => setPickMode(true) };
}

// ---------------------------------------------------------------------------
// Версия для печати / PDF
// ---------------------------------------------------------------------------

// Клетка для решения: задачи с развёрнутым ответом (вторая часть) — целая страница,
// остальные (первая часть, краткий ответ) — половина страницы.
const isPartTwo = (t) => t.type === "Развернутый ответ";

function printTaskHtml(t, index, opts) {
  let solution = "";
  if (opts.solutions) {
    solution = t.answer || t.solution
      ? `<div class="solution">
           <div class="solution-title">Решение</div>
           <div class="math-text">${t.solution}</div>
           ${t.answer ? `<p class="answer"><strong>Ответ:</strong> <span class="math-text">${escapeHtml(t.answer)}</span></p>` : ""}
         </div>`
      : '<div class="solution"><p class="muted">Решение пока не добавлено.</p></div>';
  }
  const grid = opts.grid
    ? `<div class="work-grid ${isPartTwo(t) ? "work-grid-page" : "work-grid-half"}" aria-hidden="true"></div>`
    : "";
  return `
    <article class="task ${opts.grid ? (isPartTwo(t) ? "task-part-two" : "task-with-grid") : ""}">
      <div class="task-label">
        <strong>${index + 1}.</strong>
        ${opts.showNumber ? `<span>${escapeHtml(t.title)}</span>` : ""}
        <code>${escapeHtml(t.guid)}</code>
      </div>
      <div class="statement">${t.html}</div>
      ${grid}
      ${solution}
    </article>`;
}

async function setupPrintPage(body) {
  const params = new URLSearchParams(location.search);
  const container = document.getElementById("print-tasks");
  const subtitle = document.querySelector("[data-doc-sub]");
  const answersBlock = document.getElementById("print-answers");
  const optionsForm = document.querySelector("[data-print-options]");

  document.querySelector('[data-action="print"]').addEventListener("click", () => window.print());

  let all;
  try {
    all = await loadTasks(body.dataset.tasksUrl);
  } catch (err) {
    subtitle.textContent = "Не удалось загрузить задачи: " + err.message;
    return;
  }

  // Что печатаем: подборку по коду (в её порядке) или результат фильтров
  let tasks, title, code = "";
  const f = readParams();
  if (params.get("set")) {
    try {
      const ids = decodePickCode(params.get("set"));
      code = encodePickCode(ids); // нормализованный вид для подписи на листе
      const byId = new Map(all.map((t) => [t.id, t]));
      tasks = ids.map((id) => byId.get(id)).filter(Boolean);
      title = "Подборка задач";
    } catch (err) {
      subtitle.textContent = "Не удалось открыть подборку: " + err.message;
      return;
    }
  } else {
    tasks = filterTasks(all, f);
    title = selectionTitle(f);
  }
  const numbers = new Set(tasks.map((t) => t.n));

  PRINT_OPTIONS.forEach((key) => (optionsForm.elements[key].checked = params.get(key) === "1"));

  function render() {
    const opts = { showNumber: numbers.size > 1 };
    PRINT_OPTIONS.forEach((key) => (opts[key] = optionsForm.elements[key].checked));

    document.title = title + (opts.solutions ? " — с решениями" : "");
    document.querySelector("[data-doc-title]").textContent = title;
    subtitle.textContent = [
      plural(tasks.length, "задача", "задачи", "задач"),
      opts.solutions ? "с решениями" : "",
      code ? `код подборки ${code}` : "",
      "открытый банк ФИПИ",
      new Date().toLocaleDateString("ru-RU"),
    ].filter(Boolean).join(" · ");

    container.innerHTML = tasks.map((t, i) => printTaskHtml(t, i, opts)).join("");

    answersBlock.hidden = !opts.answers;
    answersBlock.querySelector("tbody").innerHTML = opts.answers
      ? tasks.map((t, i) =>
          `<tr><td class="num">${i + 1}</td><td class="math-text">${escapeHtml(t.answer || "—")}</td></tr>`
        ).join("")
      : "";

    renderMath(document.body);

    // Опции живут в адресе — ссылку на лист можно переслать как есть
    const next = new URLSearchParams(location.search);
    PRINT_OPTIONS.forEach((key) => (opts[key] ? next.set(key, "1") : next.delete(key)));
    next.delete("print");
    history.replaceState(null, "", `?${next}`);
  }

  optionsForm.addEventListener("change", render);
  render();

  // Ждём картинки и шрифты, чтобы в PDF ничего не пропало
  await Promise.all([...document.images].map((img) =>
    img.complete ? null : new Promise((resolve) => { img.onload = img.onerror = resolve; })
  ));
  if (document.fonts) await document.fonts.ready;
  body.dataset.ready = "1";
  if (params.get("print") === "1") window.print();
}

// ---------------------------------------------------------------------------
// Панель подборки (внизу экрана) и окно с кодом
// ---------------------------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Старые браузеры / http без clipboard API
    const area = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function setupPickBar(bar, { onShow } = {}) {
  const dialog = document.getElementById("pick-dialog");
  const countEl = bar.querySelector("[data-pick-count]");
  const codeEl = dialog.querySelector("[data-code]");
  const codeInput = dialog.querySelector('input[name="code"]');
  const codeError = dialog.querySelector("[data-code-error]");
  const copyStatus = dialog.querySelector("[data-copy-status]");
  const indexUrl = new URL(bar.dataset.indexUrl, location.href);
  const showUrl = (params) => `${indexUrl.pathname}?${params}`;

  function update(ids = Pick.ids()) {
    countEl.textContent = plural(ids.length, "задача", "задачи", "задач");
    bar.classList.toggle("is-empty", !ids.length);
    bar.querySelectorAll("[data-needs-pick]").forEach((b) => (b.disabled = !ids.length));
    syncPickChecks();
  }

  function openDialog(mode) {
    dialog.querySelector("[data-dialog-save]").hidden = mode !== "save";
    dialog.querySelector("[data-dialog-open]").hidden = mode !== "open";
    copyStatus.textContent = "";
    codeError.textContent = "";
    if (mode === "save") codeEl.textContent = Pick.code();
    if (mode === "open") codeInput.value = "";
    dialog.showModal();
    if (mode === "open") codeInput.focus();
  }

  function applyCode() {
    let ids;
    try {
      ids = decodePickCode(codeInput.value);
    } catch (err) {
      codeError.textContent = err.message;
      return;
    }
    const current = Pick.ids();
    if (current.length && !confirm(`Заменить текущую подборку (${plural(current.length, "задача", "задачи", "задач")}) новой (${plural(ids.length, "задача", "задачи", "задач")})?`)) {
      return;
    }
    Pick.set(ids);
    dialog.close();
    onShow ? onShow() : (location.href = showUrl("view=pick"));
  }

  document.addEventListener("change", (event) => {
    const box = event.target.closest("input[data-pick]");
    if (box) Pick.toggle(Number(box.dataset.pick), box.checked);
  });

  bar.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "pick-show") onShow ? onShow() : (location.href = showUrl("view=pick"));
    if (action === "pick-print") {
      const url = new URL(bar.dataset.printUrl, location.href);
      url.searchParams.set("set", Pick.code());
      window.open(url, "_blank", "noopener");
    }
    if (action === "pick-save") openDialog("save");
    if (action === "pick-open") openDialog("open");
    if (action === "pick-clear" && confirm("Очистить подборку?")) Pick.set([]);
  });

  dialog.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const code = codeEl.textContent;
    if (action === "copy-code") {
      copyStatus.textContent = (await copyText(code)) ? "Код скопирован" : "Не удалось скопировать";
    }
    if (action === "copy-link") {
      const link = new URL(indexUrl);
      link.search = `?set=${code}`;
      copyStatus.textContent = (await copyText(link.href)) ? "Ссылка скопирована" : "Не удалось скопировать";
    }
    if (action === "apply-code") applyCode();
    if (event.target === dialog) dialog.close(); // клик по фону
  });
  codeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyCode();
    }
  });

  Pick.onChange(update);
  update();
}

// ---------------------------------------------------------------------------
// Редактор решения (только режим учителя)
// ---------------------------------------------------------------------------

async function postJSON(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function setupSolutionEditor(card) {
  const editor = card.querySelector("[data-editor]");
  const views = card.querySelectorAll("[data-view]");
  const answerInput = editor.elements.answer;
  const textarea = editor.elements.solution;
  const preview = card.querySelector("[data-preview]");
  const status = card.querySelector("[data-status]");
  const solutionHtml = card.querySelector("[data-solution-html]");
  const answerLine = card.querySelector("[data-answer-line]");
  const answerEl = card.querySelector("[data-answer]");
  const editedChip = card.querySelector("[data-edited-chip]");
  const resetButton = card.querySelector('[data-action="reset"]');
  const editButton = card.querySelector('[data-action="edit"]');

  let saved = { answer: answerInput.value, solution: textarea.value };
  let previewTimer = null;

  const dirty = () => answerInput.value !== saved.answer || textarea.value !== saved.solution;

  async function refreshPreview() {
    try {
      const data = await postJSON(card.dataset.previewUrl, "POST", { solution: textarea.value });
      preview.innerHTML = data.html || '<p class="muted">Пусто</p>';
      renderMath(preview);
    } catch (err) {
      preview.textContent = "Не удалось построить предпросмотр: " + err.message;
    }
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 250);
  }

  function showView(solution, html) {
    answerEl.textContent = solution.answer || "";
    answerLine.hidden = !solution.answer;
    solutionHtml.innerHTML = html || '<p class="muted">Решения пока нет.</p>';
    editedChip.hidden = !solution.edited;
    resetButton.hidden = !(solution.edited && solution.has_reference);
    editButton.textContent = solution.answer || solution.solution ? "Редактировать" : "Добавить решение";
    renderMath(card);
  }

  function openEditor() {
    views.forEach((el) => (el.hidden = true));
    editor.hidden = false;
    status.textContent = "";
    refreshPreview();
    textarea.focus();
  }

  function closeEditor() {
    editor.hidden = true;
    views.forEach((el) => (el.hidden = false));
  }

  editButton.addEventListener("click", openEditor);
  textarea.addEventListener("input", schedulePreview);

  card.querySelector('[data-action="cancel"]').addEventListener("click", () => {
    if (dirty() && !confirm("Отменить несохранённые изменения?")) return;
    answerInput.value = saved.answer;
    textarea.value = saved.solution;
    closeEditor();
  });

  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "Сохраняю…";
    try {
      const data = await postJSON(card.dataset.saveUrl, "POST", {
        answer: answerInput.value,
        solution: textarea.value,
      });
      saved = { answer: data.solution.answer, solution: data.solution.solution };
      answerInput.value = saved.answer;
      textarea.value = saved.solution;
      showView(data.solution, data.html);
      status.textContent = "";
      closeEditor();
    } catch (err) {
      status.textContent = "Ошибка сохранения: " + err.message;
    }
  });

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      editor.requestSubmit();
    }
  });

  resetButton.addEventListener("click", async () => {
    if (!confirm("Удалить твою версию и вернуть эталонное решение?")) return;
    const data = await postJSON(card.dataset.saveUrl, "DELETE");
    saved = { answer: data.solution.answer || "", solution: data.solution.solution || "" };
    answerInput.value = saved.answer;
    textarea.value = saved.solution;
    showView(data.solution, data.html);
  });

  window.addEventListener("beforeunload", (event) => {
    if (!editor.hidden && dirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  if (location.hash === "#solution" && !saved.answer && !saved.solution) openEditor();
}

// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const filters = document.getElementById("filters");
  const taskList = filters ? setupTaskList(filters) : null;

  const pickBar = document.getElementById("pick-bar");
  if (pickBar) setupPickBar(pickBar, { onShow: taskList && taskList.showPick });

  if (document.body.classList.contains("print-page")) {
    setupPrintPage(document.body);
  } else {
    renderMath(document.body);
  }

  document.querySelectorAll(".solution-card[data-guid]").forEach(setupSolutionEditor);

  // «К списку» возвращает к тем же фильтрам и странице, если пришли из списка
  document.querySelectorAll("[data-back], [data-back-to-list]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (document.referrer.startsWith(location.origin) && history.length > 1) {
        event.preventDefault();
        history.back();
      }
    });
  });
});
