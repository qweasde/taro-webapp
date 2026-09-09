'use strict';

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

const STEPS = ['', 'Комплекс', 'Тема', 'Вопросы', 'О вас', 'Подтверждение', 'Готово'];
const SLOTS = ['Утро', 'День', 'Вечер', 'Поздний вечер', 'Любое'];

const state = {
  step: 0,
  pack: null,         // выбранный комплекс из каталога
  theme: null,        // выбранная тема
  picked: [],         // отмеченные вопросы из каталога
  own: '',            // свой вопрос текстом
  ownMode: false,     // свой вопрос учитывается в лимите комплекса
  name: '',
  bdate: '',
  slot: '',
  consent: false,
  sending: false,
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

/* ——————————————————— Правила заявки ——————————————————— */

// Сколько вопросов можно отметить — определяет комплекс.
function limit() {
  return state.pack ? state.pack.questions : 1;
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

function allQuestions() {
  const list = state.picked.slice();
  if (ownFilled()) list.push(state.own.trim());
  return list;
}

/* ——————————————————— Рендер ——————————————————— */

function render() {
  steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== state.step; });
  $('#bar').style.width = (state.step / (STEPS.length - 1)) * 100 + '%';
  $('#crumbs').textContent = STEPS[state.step];
  window.scrollTo({ top: 0, behavior: 'smooth' });
  syncButtons();
}

function mainLabel() {
  if (state.step === 0) return 'Записаться на расклад';
  if (state.step === 5) return state.sending ? 'Отправляем…' : 'Отправить заявку';
  if (state.step === 3) {
    const left = limit() - chosenCount();
    if (left > 0 && chosenCount() > 0) return `Далее · выбрано ${chosenCount()} из ${limit()}`;
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
    case 4: return state.name.trim().length >= 2 && !!state.slot
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
  if (state.step === 3) buildQuestions();
  if (state.step === 4) buildAbout();
  if (state.step === 5) buildSummary();
  render();
}

function back() {
  if (state.step === 0) { if (tg) tg.close(); return; }
  haptic();
  state.step -= 1;
  render();
}

/* ——————————————————— Экраны ——————————————————— */

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
    b.className = 'pack' + (p.needs_birth ? ' vip' : '');
    b.innerHTML =
      `<span class="price">${money(p.price)}</span>` +
      `<b>${p.title}</b>` +
      `<i>${p.desc}</i>` +
      `<u>${questions(p.questions)} · ${p.duration}</u>`;
    b.onclick = () => {
      if (state.pack && state.pack.id !== p.id) {
        // Лимит изменился — начинаем отбор вопросов заново.
        state.picked = [];
        state.ownMode = false;
        state.own = '';
      }
      state.pack = p;
      [...wrap.children].forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      haptic();
      setTimeout(next, 140);
    };
    if (state.pack && state.pack.id === p.id) b.classList.add('sel');
    wrap.appendChild(b);
  });
}

function buildThemes() {
  const wrap = $('#themes');
  wrap.innerHTML = '';
  CATALOG.themes.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme' + (state.theme && state.theme.id === t.id ? ' sel' : '');
    b.innerHTML = `<em>${t.emoji}</em><b>${t.title}</b><i>${t.hint}</i>`;
    b.onclick = () => {
      if (state.theme && state.theme.id !== t.id) state.picked = [];
      state.theme = t;
      [...wrap.children].forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      haptic();
      setTimeout(next, 140);
    };
    wrap.appendChild(b);
  });
}

function buildQuestions() {
  const wrap = $('#questions');
  wrap.innerHTML = '';
  $('#qTitle').textContent = `${state.theme.emoji} ${state.theme.title}`;
  $('#qSub').textContent = limit() === 1
    ? 'Выберите один вопрос — или задайте свой.'
    : `В комплексе «${state.pack.title}» — до ${questions(limit())}. Отметьте нужные.`;

  state.theme.questions.forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'q';
    b.textContent = q;
    b.onclick = () => toggleQuestion(q, b);
    wrap.appendChild(b);
  });

  $('#ownToggle').classList.toggle('sel', state.ownMode);
  $('#ownBox').hidden = !state.ownMode;
  $('#ownText').value = state.own;
  $('#ownCount').textContent = state.own.length;
  paintQuestions();
}

function toggleQuestion(q, btn) {
  const at = state.picked.indexOf(q);
  if (at >= 0) {
    state.picked.splice(at, 1);
  } else if (chosenCount() >= limit()) {
    if (limit() === 1) {
      // Для «Экспресса» удобнее менять выбор, а не снимать прежний вручную.
      state.picked = [q];
      state.ownMode = false;
      $('#ownBox').hidden = true;
      $('#ownToggle').classList.remove('sel');
    } else {
      notify('warning');
      flashTally();
      return;
    }
  } else {
    state.picked.push(q);
  }
  haptic();
  paintQuestions();
  syncButtons();
}

function paintQuestions() {
  const nodes = [...$('#questions').children];
  const full = chosenCount() >= limit();
  nodes.forEach((b) => {
    const on = state.picked.includes(b.textContent);
    b.classList.toggle('sel', on);
    b.classList.toggle('locked', full && !on && limit() > 1);
  });
  $('#ownToggle').disabled = full && !state.ownMode && limit() > 1;

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

function buildAbout() {
  $('#birthField').hidden = !needsBirth();
  $('#aboutSub').textContent = needsBirth()
    ? 'Для комплекса VIP нужна дата рождения — по ней считается аркан матрицы судьбы.'
    : 'Как к вам обращаться и когда удобно получить ответ.';
  if (!needsBirth()) state.bdate = '';
  if (state.name) $('#name').value = state.name;
}

function buildSlots() {
  const wrap = $('#slots');
  wrap.innerHTML = '';
  SLOTS.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot' + (state.slot === s ? ' sel' : '');
    b.textContent = s;
    b.onclick = () => {
      state.slot = s;
      [...wrap.children].forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      haptic();
      syncButtons();
    };
    wrap.appendChild(b);
  });
}

function buildSummary() {
  const rows = [
    ['Комплекс', `${state.pack.title} — ${money(state.pack.price)}`],
    ['Тема', `${state.theme.emoji} ${state.theme.title}`],
  ];
  const html = rows
    .map(([k, v]) => `<dl class="row"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></dl>`)
    .join('')
    + `<dl class="row"><dt>Вопросы</dt><dd><ol class="qlist">`
    + allQuestions().map((q) => `<li>${escapeHtml(q)}</li>`).join('')
    + `</ol></dd></dl>`
    + [
        ['Имя', state.name.trim()],
        ...(needsBirth() ? [['Дата рождения', formatDate(state.bdate)]] : []),
        ['Связь', state.slot],
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

/* ——————————————————— Отправка ——————————————————— */

function payload() {
  return {
    package_id: state.pack.id,
    theme_id: state.theme.id,
    questions: state.picked.slice(),
    own: ownFilled() ? [state.own.trim()] : [],
    name: state.name.trim(),
    birth_date: needsBirth() ? state.bdate : '',
    slot: state.slot,
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
      try { tg.sendData(JSON.stringify(body)); return; } catch (_) {}
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
    notify('success');
    render();
  } catch (e) {
    state.sending = false;
    if (tg && tg.initData) {
      try { tg.sendData(JSON.stringify(body)); return; } catch (_) {}
    }
    notify('error');
    if (tg) tg.showAlert(String(e.message || e)); else alert(e.message || e);
    syncButtons();
  }
}

/* ——————————————————— Инициализация ——————————————————— */

function bindStaticControls() {
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
    paintQuestions();
    syncButtons();
  };
  $('#ownText').oninput = (e) => {
    state.own = e.target.value;
    $('#ownCount').textContent = e.target.value.length;
    syncButtons();
  };
  $('#name').oninput = (e) => { state.name = e.target.value; syncButtons(); };
  $('#bdate').oninput = (e) => { state.bdate = e.target.value; syncButtons(); };
  $('#consent').onchange = (e) => { state.consent = e.target.checked; haptic(); syncButtons(); };
  $('#policyLink').onclick = (e) => { e.preventDefault(); $('#sheet').hidden = false; };
  $('#sheetClose').onclick = () => { $('#sheet').hidden = true; };
  $('#sheet').onclick = (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; };
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
  buildPacks();
  buildThemes();
  buildSlots();
  if (state.name) $('#name').value = state.name;
  render();
}

init();
