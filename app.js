'use strict';

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

const STEPS = ['', 'Комплекс', 'Тема', 'Вопросы', 'Запись', 'Подтверждение', 'Готово'];
// Столько вопросов видно сразу — длинный список утомляет, особенно в VIP на 10 вопросов.
const VISIBLE_QUESTIONS = 7;
const BOOKING_DAYS = 14;      // на сколько дней вперёд предлагаем запись
const DRAFT_KEY = 'taro-draft-v3';
const DRAFT_TTL_MS = 24 * 3600 * 1000;

const state = {
  step: 0,
  pack: null,         // выбранный комплекс
  theme: null,        // тема, открытая на экране вопросов
  picked: [],         // [{theme_id, theme, text}] — отмеченные вопросы
  own: '',            // свой вопрос текстом
  ownMode: false,     // свой вопрос занимает место в комплексе
  name: '',
  bdate: '',
  slotDate: '',
  slotTime: '',
  consent: false,
  sending: false,
  showAll: false,     // список вопросов раскрыт целиком
  query: '',          // строка поиска
};

let CATALOG = null;
let CONFIG = Object.assign({ contact: null, api: true }, window.TARO_CONFIG || {});

const $ = (s) => document.querySelector(s);
const steps = [...document.querySelectorAll('.step')];

/* ——————————————————— Telegram ——————————————————— */

function haptic(type = 'light') {
  try { tg.HapticFeedback.impactOccurred(type); } catch (_) {}
}
function notify(type) {
  try { tg.HapticFeedback.notificationOccurred(type); } catch (_) {}
}

function initTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor('#0d0b1a'); tg.setBackgroundColor('#0d0b1a'); } catch (_) {}
  try { tg.disableVerticalSwipes(); } catch (_) {}
  tg.BackButton.onClick(back);
  tg.MainButton.onClick(next);
  tg.MainButton.setParams({ color: '#e2cda0', text_color: '#1a1430' });
  const u = tg.initDataUnsafe && tg.initDataUnsafe.user;
  if (u && u.first_name) state.name = u.first_name;
}

/* ——————————————————— Черновик ——————————————————— */

function saveDraft() {
  if (state.step === 6) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      ts: Date.now(),
      step: state.step,
      packId: state.pack ? state.pack.id : null,
      themeId: state.theme ? state.theme.id : null,
      picked: state.picked,
      own: state.own,
      ownMode: state.ownMode,
      name: state.name,
      bdate: state.bdate,
      slotDate: state.slotDate,
      slotTime: state.slotTime,
    }));
  } catch (_) {
    // Приватный режим или запрет на хранение — черновик просто не работает.
  }
}

function dropDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
}

function restoreDraft() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  } catch (_) {
    return false;
  }
  if (!saved || !saved.step || Date.now() - saved.ts > DRAFT_TTL_MS) return false;

  const pack = CATALOG.packages.find((p) => p.id === saved.packId);
  if (!pack) return false;
  state.pack = pack;
  state.theme = CATALOG.themes.find((t) => t.id === saved.themeId) || null;

  // Вопросы сверяем с каталогом: он мог измениться со прошлого раза.
  const known = new Map();
  CATALOG.themes.forEach((t) => t.questions.forEach((q) => known.set(t.id + '|' + q, t)));
  state.picked = (saved.picked || []).filter((p) => known.has(p.theme_id + '|' + p.text));

  state.own = saved.own || '';
  state.ownMode = !!saved.ownMode && state.own.length > 0;
  state.name = saved.name || state.name;
  state.bdate = saved.bdate || '';
  state.slotDate = isDateOffered(saved.slotDate) ? saved.slotDate : '';
  state.slotTime = CATALOG.time_slots.includes(saved.slotTime) ? saved.slotTime : '';
  state.step = Math.min(saved.step, 5);
  return true;
}

function isDateOffered(iso) {
  return !!iso && offeredDates().some((d) => d.iso === iso);
}

/* ——————————————————— Правила заявки ——————————————————— */

function limit() {
  return state.pack ? state.pack.questions : 1;
}

function multiTheme() {
  return !!(state.pack && state.pack.multi_theme);
}

function ownFilled() {
  return state.ownMode && state.own.trim().length >= 5;
}

function chosenCount() {
  return state.picked.length + (state.ownMode ? 1 : 0);
}

function needsBirth() {
  return !!(state.pack && state.pack.needs_birth);
}

function isPicked(themeId, text) {
  return state.picked.some((p) => p.theme_id === themeId && p.text === text);
}

/* ——————————————————— Рендер ——————————————————— */

function render() {
  steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== state.step; });
  $('#bar').style.width = (state.step / (STEPS.length - 1)) * 100 + '%';
  $('#crumbs').textContent = STEPS[state.step];
  window.scrollTo({ top: 0, behavior: 'smooth' });
  syncButtons();
  saveDraft();
}

function mainLabel() {
  if (state.step === 0) return 'Записаться на расклад';
  if (state.step === 5) return state.sending ? 'Отправляем…' : 'Отправить заявку';
  if (state.step === 3 && chosenCount() > 0 && chosenCount() < limit()) {
    return `Далее · выбрано ${chosenCount()} из ${limit()}`;
  }
  return 'Далее';
}

function syncButtons() {
  if (!tg) { syncFallbackButton(); return; }
  if (state.step > 0 && state.step < 6) tg.BackButton.show(); else tg.BackButton.hide();
  if (state.step === 6) { tg.MainButton.hide(); return; }

  tg.MainButton.setText(mainLabel());
  tg.MainButton.show();
  if (canGoNext()) tg.MainButton.enable(); else tg.MainButton.disable();
  if (state.sending) tg.MainButton.showProgress(true); else tg.MainButton.hideProgress();
}

/* Вне Telegram (превью в браузере) рисуем свою нижнюю кнопку. */
function syncFallbackButton() {
  let bar = document.getElementById('fallbackBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fallbackBar';
    bar.innerHTML = '<button type="button" id="fallbackBack">Назад</button>'
                  + '<button type="button" id="fallbackNext"></button>';
    document.body.appendChild(bar);
    document.getElementById('fallbackBack').onclick = back;
    document.getElementById('fallbackNext').onclick = next;
  }
  const nextBtn = document.getElementById('fallbackNext');
  bar.hidden = state.step === 6;
  document.getElementById('fallbackBack').hidden = state.step === 0;
  nextBtn.textContent = mainLabel();
  nextBtn.disabled = !canGoNext();
}

function canGoNext() {
  switch (state.step) {
    case 1: return !!state.pack;
    case 2: return !!state.theme;
    case 3: return chosenCount() > 0 && chosenCount() <= limit()
                && (!state.ownMode || ownFilled());
    case 4: return state.name.trim().length >= 2 && !!state.slotDate && !!state.slotTime
                && (!needsBirth() || !!state.bdate);
    case 5: return state.consent && !state.sending;
    default: return true;
  }
}

/* ——————————————————— Навигация ——————————————————— */

function next() {
  if (!canGoNext()) {
    if (state.step === 5 && !state.consent) {
      $('.consent').classList.add('shake');
      setTimeout(() => $('.consent').classList.remove('shake'), 400);
    }
    return;
  }
  haptic();
  if (state.step === 5) { submit(); return; }
  state.step += 1;
  enterStep();
  render();
}

function back() {
  if (state.step === 0) { if (tg) tg.close(); return; }
  haptic();
  state.step -= 1;
  enterStep();
  render();
}

function enterStep() {
  if (state.step === 1) buildPacks();
  if (state.step === 2) buildThemes();
  if (state.step === 3) buildQuestions();
  if (state.step === 4) buildAbout();
  if (state.step === 5) buildSummary();
}

/* ——————————————————— Комплексы и темы ——————————————————— */

function money(value) {
  return value.toLocaleString('ru-RU') + ' ₽';
}

// 1 вопрос, 2-4 вопроса, 5-20 вопросов.
function questionWord(n) {
  const hundreds = Math.abs(n) % 100;
  const ones = hundreds % 10;
  if (hundreds > 10 && hundreds < 20) return 'вопросов';
  if (ones === 1) return 'вопрос';
  if (ones >= 2 && ones <= 4) return 'вопроса';
  return 'вопросов';
}

function questions(n) {
  return `${n} ${questionWord(n)}`;
}

function buildPacks() {
  const wrap = $('#packs');
  wrap.innerHTML = '';
  CATALOG.packages.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pack' + (p.needs_birth ? ' vip' : '')
                + (state.pack && state.pack.id === p.id ? ' sel' : '');
    b.innerHTML =
      `<span class="price">${money(p.price)}</span>` +
      `<b>${p.title}</b>` +
      `<i>${p.desc}</i>` +
      `<u>${questions(p.questions)} · ${p.duration}</u>` +
      (p.multi_theme ? '<u>можно смешивать темы</u>' : '');
    b.onclick = () => {
      if (state.pack && state.pack.id !== p.id) {
        // Лимит и правила изменились — отбор вопросов начинаем заново.
        state.picked = [];
        state.ownMode = false;
        state.own = '';
      }
      state.pack = p;
      [...wrap.children].forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      haptic();
      syncButtons();
      saveDraft();
    };
    wrap.appendChild(b);
  });
}

function buildThemes() {
  $('#themeSub').textContent = multiTheme()
    ? 'С чего начнём? В этом комплексе вопросы можно брать из нескольких тем.'
    : 'Выберите тему — внутри готовые формулировки.';
  const wrap = $('#themes');
  wrap.innerHTML = '';
  CATALOG.themes.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme' + (state.theme && state.theme.id === t.id ? ' sel' : '');
    const mine = state.picked.filter((p) => p.theme_id === t.id).length;
    b.innerHTML = `<em>${t.emoji}</em><b>${t.title}</b><i>${t.hint}</i>`
                + (mine ? `<span class="badge">${mine}</span>` : '');
    b.onclick = () => {
      // В младших комплексах смена темы обнуляет выбор: вопросы должны быть из одной темы.
      if (!multiTheme() && state.theme && state.theme.id !== t.id) state.picked = [];
      state.theme = t;
      [...wrap.children].forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      haptic();
      syncButtons();
      saveDraft();
    };
    wrap.appendChild(b);
  });
}

/* ——————————————————— Вопросы: поиск, темы, выбор ——————————————————— */

function buildQuestions() {
  state.showAll = false;
  state.query = '';
  $('#search').value = '';
  $('#searchClear').hidden = true;
  buildThemeChips();
  $('#ownToggle').classList.toggle('sel', state.ownMode);
  $('#ownBox').hidden = !state.ownMode;
  $('#ownText').value = state.own;
  $('#ownCount').textContent = state.own.length;
  renderQuestionList();
}

function buildThemeChips() {
  const wrap = $('#themeChips');
  wrap.hidden = !multiTheme();
  if (!multiTheme()) return;
  wrap.innerHTML = '';
  CATALOG.themes.forEach((t) => {
    const c = document.createElement('button');
    c.type = 'button';
    const mine = state.picked.filter((p) => p.theme_id === t.id).length;
    c.className = 'chip' + (state.theme.id === t.id ? ' sel' : '');
    c.innerHTML = `${t.emoji} ${t.title}` + (mine ? `<span class="dot">${mine}</span>` : '');
    c.onclick = () => {
      state.theme = t;
      state.showAll = false;
      haptic();
      buildThemeChips();
      renderQuestionList();
      syncButtons();
    };
    wrap.appendChild(c);
  });
}

/* Что показываем: результаты поиска по всем доступным темам либо вопросы текущей темы. */
function visibleItems() {
  const q = state.query.trim().toLowerCase();
  if (q.length >= 2) {
    const pool = multiTheme() ? CATALOG.themes : [state.theme];
    const found = [];
    pool.forEach((t) => {
      t.questions.forEach((text) => {
        if (text.toLowerCase().includes(q)) found.push({ theme: t, text });
      });
    });
    return { items: found, searching: true };
  }
  return {
    items: state.theme.questions.map((text) => ({ theme: state.theme, text })),
    searching: false,
  };
}

function renderQuestionList() {
  const wrap = $('#questions');
  const { items, searching } = visibleItems();
  wrap.innerHTML = '';

  $('#qTitle').textContent = searching
    ? 'Результаты поиска'
    : `${state.theme.emoji} ${state.theme.title}`;
  $('#qSub').textContent = searching
    ? `Найдено ${questions(items.length)}`
    : (limit() === 1
        ? 'Выберите один вопрос — или задайте свой.'
        : `В комплексе «${state.pack.title}» — до ${questions(limit())}. Отметьте нужные.`);

  const full = chosenCount() >= limit();
  items.forEach((item, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    const on = isPicked(item.theme.id, item.text);
    b.className = 'q' + (on ? ' sel' : '') + (full && !on && limit() > 1 ? ' locked' : '');
    // При поиске по нескольким темам показываем, откуда вопрос.
    b.innerHTML = (searching && multiTheme() ? `<small>${item.theme.emoji} ${item.theme.title}</small>` : '')
                + escapeHtml(item.text);
    // Отмеченный вопрос виден всегда, даже когда список свёрнут.
    if (!state.showAll && !searching && i >= VISIBLE_QUESTIONS && !on) b.classList.add('folded');
    b.onclick = () => toggleQuestion(item.theme, item.text);
    wrap.appendChild(b);
  });

  $('#noResults').hidden = items.length > 0;

  const folded = [...wrap.children].filter((b) => b.classList.contains('folded')).length;
  const more = $('#moreToggle');
  if (searching) {
    more.hidden = true;
  } else if (state.showAll) {
    more.textContent = 'Свернуть список';
    more.hidden = items.length <= VISIBLE_QUESTIONS;
  } else {
    more.textContent = `Показать ещё ${questions(folded)}`;
    more.hidden = folded === 0;
  }

  $('#ownToggle').disabled = full && !state.ownMode && limit() > 1;
  renderPicked();
  renderTally();
}

function toggleQuestion(theme, text) {
  const at = state.picked.findIndex((p) => p.theme_id === theme.id && p.text === text);
  if (at >= 0) {
    state.picked.splice(at, 1);
  } else if (chosenCount() >= limit()) {
    if (limit() === 1) {
      // Для «Экспресса» удобнее менять выбор, а не снимать прежний вручную.
      state.picked = [{ theme_id: theme.id, theme: `${theme.emoji} ${theme.title}`, text }];
      state.ownMode = false;
      $('#ownBox').hidden = true;
      $('#ownToggle').classList.remove('sel');
    } else {
      notify('warning');
      flashTally();
      return;
    }
  } else {
    state.picked.push({ theme_id: theme.id, theme: `${theme.emoji} ${theme.title}`, text });
  }
  haptic();
  if (multiTheme()) buildThemeChips();
  renderQuestionList();
  syncButtons();
  saveDraft();
}

/* Выбранное из других тем иначе не видно — держим список под рукой. */
function renderPicked() {
  const box = $('#pickedList');
  const others = state.picked.filter((p) => p.theme_id !== state.theme.id);
  const show = multiTheme() && others.length > 0;
  box.hidden = !show;
  if (!show) return;
  box.innerHTML = '<div class="picked-head">Выбрано в других темах</div>'
    + others.map((p) =>
        `<button type="button" class="picked-item" data-theme="${p.theme_id}" data-text="${escapeHtml(p.text)}">`
        + `<small>${escapeHtml(p.theme)}</small>${escapeHtml(p.text)}<i>✕</i></button>`
      ).join('');
  [...box.querySelectorAll('.picked-item')].forEach((b) => {
    b.onclick = () => {
      const theme = CATALOG.themes.find((t) => t.id === b.dataset.theme);
      if (theme) toggleQuestion(theme, b.dataset.text);
    };
  });
}

function renderTally() {
  const left = limit() - chosenCount();
  const tally = $('#tally');
  if (chosenCount() === 0) {
    tally.textContent = limit() === 1 ? 'Выберите вопрос' : `Выберите до ${questions(limit())}`;
    tally.className = 'tally';
  } else if (left > 0) {
    tally.textContent = `Выбрано ${chosenCount()} из ${limit()} — можно добавить ещё ${questions(left)}`;
    tally.className = 'tally on';
  } else {
    tally.textContent = `Выбрано ${chosenCount()} из ${limit()} — комплекс заполнен`;
    tally.className = 'tally full';
  }
}

function flashTally() {
  const t = $('#tally');
  t.classList.add('shake');
  setTimeout(() => t.classList.remove('shake'), 400);
}

/* ——————————————————— Запись: день и время ——————————————————— */

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн',
                'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function offeredDates() {
  const out = [];
  const today = new Date();
  for (let i = 0; i < BOOKING_DAYS; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({
      iso,
      label: i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : `${d.getDate()} ${MONTHS[d.getMonth()]}`,
      weekday: WEEKDAYS[d.getDay()],
    });
  }
  return out;
}

function buildAbout() {
  $('#birthField').hidden = !needsBirth();
  $('#aboutSub').textContent = needsBirth()
    ? 'Для комплекса VIP нужна дата рождения — по ней считается аркан матрицы судьбы.'
    : 'Как к вам обращаться и когда удобно получить ответ.';
  if (!needsBirth()) state.bdate = '';
  $('#name').value = state.name;
  $('#bdate').value = state.bdate;
  buildDays();
  buildSlots();
}

function buildDays() {
  const wrap = $('#days');
  wrap.innerHTML = '';
  offeredDates().forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day' + (state.slotDate === d.iso ? ' sel' : '');
    b.innerHTML = `<b>${d.label}</b><i>${d.weekday}</i>`;
    b.onclick = () => {
      state.slotDate = d.iso;
      [...wrap.children].forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      haptic();
      syncButtons();
      saveDraft();
    };
    wrap.appendChild(b);
  });
}

function buildSlots() {
  const wrap = $('#slots');
  wrap.innerHTML = '';
  CATALOG.time_slots.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot' + (state.slotTime === s ? ' sel' : '');
    b.textContent = s;
    b.onclick = () => {
      state.slotTime = s;
      [...wrap.children].forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      haptic();
      syncButtons();
      saveDraft();
    };
    wrap.appendChild(b);
  });
}

function slotLabel() {
  const day = offeredDates().find((d) => d.iso === state.slotDate);
  if (!day) return state.slotTime;
  return `${day.label.toLowerCase()} (${day.weekday}), ${state.slotTime}`;
}

/* ——————————————————— Сводка и отправка ——————————————————— */

function allQuestions() {
  const list = state.picked.slice();
  if (ownFilled()) list.push({ theme_id: '', theme: 'Свой вопрос', text: state.own.trim() });
  return list;
}

function buildSummary() {
  const themes = [];
  state.picked.forEach((p) => { if (!themes.includes(p.theme)) themes.push(p.theme); });

  const rows = [
    ['Комплекс', `${state.pack.title} — ${money(state.pack.price)}`],
    ['Тема', themes.length ? themes.join(' + ') : 'Свой вопрос'],
  ];
  const many = themes.length > 1;

  let html = rows
    .map(([k, v]) => `<dl class="row"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></dl>`)
    .join('');
  html += '<dl class="row"><dt>Вопросы</dt><dd><ol class="qlist">'
    + allQuestions()
        .map((q) => `<li>${many ? `<small>${escapeHtml(q.theme)}</small>` : ''}${escapeHtml(q.text)}</li>`)
        .join('')
    + '</ol></dd></dl>';
  html += [
    ['Имя', state.name.trim()],
    ...(needsBirth() ? [['Дата рождения', formatDate(state.bdate)]] : []),
    ['Запись', slotLabel()],
  ]
    .map(([k, v]) => `<dl class="row"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></dl>`)
    .join('');
  $('#summary').innerHTML = html;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function payload() {
  return {
    package_id: state.pack.id,
    picked: state.picked.map((p) => ({ theme_id: p.theme_id, q: p.text })),
    own: ownFilled() ? [state.own.trim()] : [],
    name: state.name.trim(),
    birth_date: needsBirth() ? state.bdate : '',
    slot_date: state.slotDate,
    slot_time: state.slotTime,
    consent: true,
  };
}

async function submit() {
  state.sending = true;
  syncButtons();
  const body = payload();

  // Статический хостинг (GitHub Pages): своего сервера нет, отдаём заявку
  // боту через Telegram. Telegram сам закроет мини-апп, подтверждение
  // пришлёт бот сообщением в чат.
  if (CONFIG.api === false) {
    if (tg && tg.initData) {
      try { dropDraft(); tg.sendData(JSON.stringify(body)); return; } catch (_) {}
    }
    state.sending = false;
    notify('error');
    const msg = 'Форму нужно открыть кнопкой «Записаться» в чате с ботом — только так заявка дойдёт.';
    if (tg) tg.showAlert(msg); else alert(msg);
    syncButtons();
    return;
  }

  try {
    const res = await fetch('api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ init_data: tg ? tg.initData : '', order: body }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(json.error || 'Не удалось отправить заявку');
    state.sending = false;
    state.step = 6;
    dropDraft();
    notify('success');
    render();
  } catch (e) {
    state.sending = false;
    if (tg && tg.initData) {
      try { dropDraft(); tg.sendData(JSON.stringify(body)); return; } catch (_) {}
    }
    notify('error');
    if (tg) tg.showAlert(String(e.message || e)); else alert(e.message || e);
    syncButtons();
  }
}

/* ——————————————————— Инициализация ——————————————————— */

function bindStaticControls() {
  $('#search').oninput = (e) => {
    state.query = e.target.value;
    $('#searchClear').hidden = !state.query;
    renderQuestionList();
  };
  $('#searchClear').onclick = () => {
    state.query = '';
    $('#search').value = '';
    $('#searchClear').hidden = true;
    renderQuestionList();
  };
  $('#moreToggle').onclick = () => {
    state.showAll = !state.showAll;
    haptic();
    renderQuestionList();
  };
  $('#ownToggle').onclick = () => {
    if (!state.ownMode && chosenCount() >= limit()) {
      if (limit() === 1) {
        state.picked = [];
      } else {
        notify('warning');
        flashTally();
        return;
      }
    }
    state.ownMode = !state.ownMode;
    $('#ownToggle').classList.toggle('sel', state.ownMode);
    $('#ownBox').hidden = !state.ownMode;
    if (state.ownMode) $('#ownText').focus();
    haptic();
    renderQuestionList();
    syncButtons();
    saveDraft();
  };
  $('#ownText').oninput = (e) => {
    state.own = e.target.value;
    $('#ownCount').textContent = e.target.value.length;
    syncButtons();
    saveDraft();
  };
  $('#name').oninput = (e) => { state.name = e.target.value; syncButtons(); saveDraft(); };
  $('#bdate').oninput = (e) => { state.bdate = e.target.value; syncButtons(); saveDraft(); };
  $('#consent').onchange = (e) => { state.consent = e.target.checked; haptic(); syncButtons(); };
  $('#policyLink').onclick = (e) => { e.preventDefault(); $('#sheet').hidden = false; };
  $('#sheetClose').onclick = () => { $('#sheet').hidden = true; };
  $('#sheet').onclick = (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; };
  $('#dropDraft').onclick = () => {
    dropDraft();
    location.reload();
  };
  $('#directBtn').onclick = () => {
    const link = CONFIG.contact ? `https://t.me/${CONFIG.contact}` : null;
    if (!link) { if (tg) tg.close(); return; }
    if (tg) tg.openTelegramLink(link); else window.open(link, '_blank');
  };

  $('#bdate').max = new Date().toISOString().slice(0, 10);
}

async function init() {
  initTelegram();
  bindStaticControls();
  const requests = [fetch('catalog.json').then((r) => r.json())];
  // Контакт таролога знает сервер; на статике он приходит из config.js.
  if (CONFIG.api !== false) {
    requests.push(fetch('api/config').then((r) => r.json()).catch(() => ({})));
  }
  const [cat, cfg] = await Promise.all(requests);
  CATALOG = cat;
  if (cfg && cfg.contact) CONFIG.contact = cfg.contact;

  if (restoreDraft()) {
    $('#resumed').hidden = false;
    enterStep();
  } else {
    buildPacks();
    buildThemes();
  }
  render();
}

init();
