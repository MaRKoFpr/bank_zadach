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
  let tasks = [];
  let page = 1;

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
    const query = params.toString();
    history.replaceState(null, "", query ? `?${query}` : location.pathname);
  }

  function render({ scroll = false } = {}) {
    const f = currentFilters();
    const filtered = filterTasks(tasks, f);
    const perPage = Number(form.elements.per_page.value) || 20;
    const pages = Math.max(Math.ceil(filtered.length / perPage), 1);
    page = Math.min(Math.max(page, 1), pages);
    const current = filtered.slice((page - 1) * perPage, page * perPage);

    totalEl.textContent = `Найдено: ${filtered.length}`;
    pageInfo.textContent = `Страница ${page} из ${pages}`;
    exportCount.textContent = `${plural(filtered.length, "задача", "задачи", "задач")} по текущим фильтрам`;
    exportForm.querySelectorAll("button").forEach((b) => (b.disabled = !filtered.length));

    list.innerHTML = current.length
      ? current.map(taskCard).join("")
      : '<div class="empty"><strong>Ничего не найдено</strong><span>Попробуй изменить фильтры или поисковый запрос.</span></div>';
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
    if (event.target.name === "q") {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(render, 200);
    } else {
      render();
    }
  });
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("reset", () => setTimeout(() => { page = 1; render(); }));

  pagination.addEventListener("click", (event) => {
    const dir = event.target.closest("[data-page]")?.dataset.page;
    if (!dir) return;
    page += dir === "next" ? 1 : -1;
    render({ scroll: true });
  });

  exportForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const params = new URLSearchParams();
    const f = currentFilters();
    FILTER_KEYS.forEach((key) => f[key] && params.set(key, f[key]));
    ["solutions", "answers"].forEach((key) => exportForm.elements[key].checked && params.set(key, "1"));
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
}

// ---------------------------------------------------------------------------
// Версия для печати / PDF
// ---------------------------------------------------------------------------

async function setupPrintPage(body) {
  const params = new URLSearchParams(location.search);
  const f = readParams();
  const withSolutions = params.get("solutions") === "1";
  const withAnswers = params.get("answers") === "1";
  const container = document.getElementById("print-tasks");
  const subtitle = document.querySelector("[data-doc-sub]");

  document.querySelector('[data-action="print"]').addEventListener("click", () => window.print());

  let tasks;
  try {
    tasks = filterTasks(await loadTasks(body.dataset.tasksUrl), f);
  } catch (err) {
    subtitle.textContent = "Не удалось загрузить задачи: " + err.message;
    return;
  }

  const title = selectionTitle(f);
  document.title = title + (withSolutions ? " — с решениями" : "");
  document.querySelector("[data-doc-title]").textContent = title;
  subtitle.textContent = [
    plural(tasks.length, "задача", "задачи", "задач"),
    withSolutions ? "с решениями" : "",
    "открытый банк ФИПИ",
    new Date().toLocaleDateString("ru-RU"),
  ].filter(Boolean).join(" · ");

  const showNumber = !f.number;
  container.innerHTML = tasks.map((t, i) => {
    let solution = "";
    if (withSolutions) {
      solution = t.answer || t.solution
        ? `<div class="solution">
             <div class="solution-title">Решение</div>
             <div class="math-text">${t.solution}</div>
             ${t.answer ? `<p class="answer"><strong>Ответ:</strong> <span class="math-text">${escapeHtml(t.answer)}</span></p>` : ""}
           </div>`
        : '<div class="solution"><p class="muted">Решение пока не добавлено.</p></div>';
    }
    return `
      <article class="task">
        <div class="task-label">
          <strong>${i + 1}.</strong>
          ${showNumber ? `<span>${escapeHtml(t.title)}</span>` : ""}
          <code>${escapeHtml(t.guid)}</code>
        </div>
        <div class="statement">${t.html}</div>
        ${solution}
      </article>`;
  }).join("");

  if (withAnswers) {
    const answers = document.getElementById("print-answers");
    answers.querySelector("tbody").innerHTML = tasks.map((t, i) =>
      `<tr><td class="num">${i + 1}</td><td class="math-text">${escapeHtml(t.answer || "—")}</td></tr>`
    ).join("");
    answers.hidden = false;
  }

  renderMath(document.body);

  // Ждём картинки и шрифты, чтобы в PDF ничего не пропало
  await Promise.all([...document.images].map((img) =>
    img.complete ? null : new Promise((resolve) => { img.onload = img.onerror = resolve; })
  ));
  if (document.fonts) await document.fonts.ready;
  body.dataset.ready = "1";
  if (params.get("print") === "1") window.print();
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
  if (filters) setupTaskList(filters);

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
