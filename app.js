'use strict';

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

const STEPS = ['', 'Тема', 'Вопрос', 'Формат', 'О вас', 'Подтверждение', 'Готово'];
const SLOTS = ['Утро', 'День', 'Вечер', 'Поздний вечер', 'Любое'];

const state = {
  step: 0,
  theme: null,        // {id,title,emoji}
  question: null,     // строка из каталога
  own: '',            // свой вопрос
  ownMode: false,
  format: null,       // {id,title}
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

/* ——————————————————— Рендер ——————————————————— */

function render() {
  steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== state.step; });
  $('#bar').style.width = (state.step / (STEPS.length - 1)) * 100 + '%';
  $('#crumbs').textContent = STEPS[state.step];
  window.scrollTo({ top: 0, behavior: 'smooth' });
  syncButtons();
}

function syncButtons() {
  const labels = {
    0: 'Записаться на расклад',
    1: 'Далее',
    2: 'Далее',
    3: 'Далее',
    4: 'Далее',
    5: state.sending ? 'Отправляем…' : 'Отправить заявку',
  };
  if (!tg) { syncFallbackButton(labels); return; }
  if (state.step > 0 && state.step < 6) tg.BackButton.show(); else tg.BackButton.hide();

  if (state.step === 6) { tg.MainButton.hide(); return; }

  tg.MainButton.setText(labels[state.step]);
  tg.MainButton.show();
  if (canGoNext()) tg.MainButton.enable(); else tg.MainButton.disable();
  if (state.sending) tg.MainButton.showProgress(true); else tg.MainButton.hideProgress();
}

/* Вне Telegram (превью в браузере) рисуем свою нижнюю кнопку. */
function syncFallbackButton(labels) {
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
  nextBtn.textContent = labels[state.step] || '';
  nextBtn.disabled = !canGoNext();
}

function canGoNext() {
  switch (state.step) {
    case 1: return !!state.theme;
    case 2: return state.ownMode ? state.own.trim().length >= 5 : !!state.question;
    case 3: return !!state.format;
    case 4: return state.name.trim().length >= 2 && !!state.bdate && !!state.slot;
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
  if (state.step === 2) buildQuestions();
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

function buildThemes() {
  const wrap = $('#themes');
  wrap.innerHTML = '';
  CATALOG.themes.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme';
    b.innerHTML = `<em>${t.emoji}</em><b>${t.title}</b><i>${t.hint}</i>`;
    b.onclick = () => {
      state.theme = t;
      state.question = null;
      state.own = '';
      state.ownMode = false;
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
  state.theme.questions.forEach((q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'q' + (state.question === q ? ' sel' : '');
    b.textContent = q;
    b.onclick = () => {
      state.question = q;
      state.ownMode = false;
      $('#ownBox').hidden = true;
      $('#ownToggle').classList.remove('sel');
      [...wrap.children].forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      haptic();
      syncButtons();
    };
    wrap.appendChild(b);
  });
  $('#ownToggle').classList.toggle('sel', state.ownMode);
  $('#ownBox').hidden = !state.ownMode;
  $('#ownText').value = state.own;
  $('#ownCount').textContent = state.own.length;
}

function buildFormats() {
  const wrap = $('#formats');
  wrap.innerHTML = '';
  const items = CATALOG.formats.concat([
    { id: 'ask', title: 'Подскажите сами', desc: 'Обсудим в переписке, что подойдёт', duration: '' },
  ]);
  items.forEach((f) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fmt';
    b.innerHTML = `${f.duration ? `<u>${f.duration}</u>` : ''}<b>${f.title}</b><i>${f.desc}</i>`;
    b.onclick = () => {
      state.format = f;
      [...wrap.children].forEach((c) => c.classList.remove('sel'));
      b.classList.add('sel');
      haptic();
      setTimeout(next, 140);
    };
    wrap.appendChild(b);
  });
}

function buildSlots() {
  const wrap = $('#slots');
  SLOTS.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot';
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

function questionText() {
  return state.ownMode ? state.own.trim() : state.question;
}

function buildSummary() {
  const d = [
    ['Тема', `${state.theme.emoji} ${state.theme.title}`],
    ['Вопрос', questionText()],
    ['Формат', state.format.title],
    ['Имя', state.name.trim()],
    ['Дата рождения', formatDate(state.bdate)],
    ['Связь', state.slot],
  ];
  $('#summary').innerHTML = d
    .map(([k, v]) => `<dl class="row"><dt>${k}</dt><dd>${escapeHtml(v)}</dd></dl>`)
    .join('');
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, dd] = iso.split('-');
  return `${dd}.${m}.${y}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ——————————————————— Отправка ——————————————————— */

function payload() {
  return {
    theme_id: state.theme.id,
    theme: state.theme.title,
    question: questionText(),
    is_own: state.ownMode,
    format_id: state.format.id,
    format: state.format.title,
    name: state.name.trim(),
    birth_date: state.bdate,
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
    let reason;
    if (!tg) {
      reason = 'Эта страница — форма Telegram-бота. Откройте её в Telegram: '
             + 'напишите боту /start и нажмите «🔮 Записаться».';
    } else if (!tg.initData) {
      reason = 'Telegram не передал данные пользователя. Закройте форму и откройте её '
             + 'заново кнопкой «🔮 Записаться» внизу чата.';
    } else {
      try { tg.sendData(JSON.stringify(body)); return; } catch (e) {
        reason = 'Telegram не принял заявку: ' + (e && e.message ? e.message : e) + '. '
               + 'Откройте форму кнопкой «🔮 Записаться» внизу чата, а не из меню бота.';
      }
    }
    state.sending = false;
    notify('error');
    if (tg) tg.showAlert(reason); else alert(reason);
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
    // Запасной путь: отдать данные боту напрямую (закроет мини-апп).
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
    state.ownMode = !state.ownMode;
    $('#ownToggle').classList.toggle('sel', state.ownMode);
    $('#ownBox').hidden = !state.ownMode;
    if (state.ownMode) {
      state.question = null;
      [...$('#questions').children].forEach((c) => c.classList.remove('sel'));
      $('#ownText').focus();
    }
    haptic();
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

  const today = new Date();
  $('#bdate').max = today.toISOString().slice(0, 10);
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
  buildThemes();
  buildFormats();
  buildSlots();
  if (state.name) $('#name').value = state.name;
  render();
}

init();
