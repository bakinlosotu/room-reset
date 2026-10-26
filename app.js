// Room Reset MVP: one photo (or one spot) in, three tiny steps out.
(function () {
  'use strict';

  const CONFIG = {
    DAILY_PHOTO_CAP: 5,        // free photo starts per day (protects the free AI quota)
    CLIENT_TIMEOUT_MS: 15000,  // after this, show built-in starter steps instead (free-tier Gemini can take 10s+)
    MAX_EASIER: 3,             // "Something easier" can be used this many times
    TIMER_SECONDS: 120,
    RESUME_HOURS: 12,
    // Optional, free: paste a PostHog project API key to collect events from all testers.
    // Leave empty and events are only kept on each device (see ?debug=1).
    POSTHOG_KEY: '',
    POSTHOG_HOST: 'https://eu.i.posthog.com'
  };

  const WINS = [
    'You did it. That one counts.',
    'Done. Your room is a little lighter already.',
    'Nice. Starting is the hardest part, and you started.',
    'That’s a real win. Well done.'
  ];

  const app = document.getElementById('app');
  const openedAt = Date.now();
  const params = new URLSearchParams(location.search);

  // ---------- storage (never trusted to be available) ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    del(key) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }
  };

  const randomId = () => (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);

  // ---------- identity and photo-first vs picker-first test (R8) ----------
  let uid = store.get('rr_uid', null);
  const isNewUser = !uid;
  if (!uid) { uid = randomId(); store.set('rr_uid', uid); }

  let arm = store.get('rr_arm', null);
  if (arm !== 'photo_first' && arm !== 'picker_first') {
    arm = Math.random() < 0.5 ? 'photo_first' : 'picker_first';
    store.set('rr_arm', arm);
  }
  // For your own testing only: ?arm=photo_first or ?arm=picker_first
  if (params.get('arm') === 'photo_first' || params.get('arm') === 'picker_first') {
    arm = params.get('arm');
    store.set('rr_arm', arm);
  }

  const sessionId = randomId();
  let screenName = 'start';

  // ---------- analytics ----------
  function track(event, props) {
    const properties = Object.assign({ arm, session: sessionId, screen: screenName, new_user: isNewUser }, props || {});
    const log = store.get('rr_events', []);
    log.push({ event, t: new Date().toISOString(), properties });
    store.set('rr_events', log.slice(-500));
    if (CONFIG.POSTHOG_KEY) {
      fetch(CONFIG.POSTHOG_HOST + '/capture/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: CONFIG.POSTHOG_KEY, event, distinct_id: uid, properties }),
        keepalive: true
      }).catch(() => {});
    }
  }

  // ---------- daily free photo cap (R9) ----------
  const today = () => new Date().toISOString().slice(0, 10);
  function photosLeft() {
    const cap = store.get('rr_cap', { day: today(), used: 0 });
    return Math.max(0, CONFIG.DAILY_PHOTO_CAP - (cap.day === today() ? cap.used : 0));
  }
  function usePhoto() {
    const cap = store.get('rr_cap', { day: today(), used: 0 });
    store.set('rr_cap', { day: today(), used: (cap.day === today() ? cap.used : 0) + 1 });
  }

  // ---------- Add to Home Screen (offered only after a win, on the stop screen) ----------
  let installPrompt = null; // Android Chrome's install prompt, when the browser offers one
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  window.addEventListener('appinstalled', () => { store.set('rr_install_dismissed', true); track('app_installed'); });
  const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function installHtml() {
    if (isInstalled() || store.get('rr_install_dismissed', false)) return '';
    const lead = '<p class="note">Want Room Reset one tap away next time?';
    if (installPrompt) {
      return '<div class="install">' + lead + '</p>' +
        '<button class="btn quiet" id="install">Add to home screen</button>' +
        '<button class="btn link" id="install-no">Not now</button></div>';
    }
    if (isIOS) {
      return '<div class="install">' + lead + ' In Safari, tap the Share button, then <strong>Add to Home Screen</strong>.</p>' +
        '<button class="btn link" id="install-no">Got it</button></div>';
    }
    return '';
  }

  function bindInstall() {
    const hint = app.querySelector('.install');
    if (!hint) return;
    track('install_hint_shown', { kind: installPrompt ? 'prompt' : 'ios' });
    on('#install', async () => {
      const prompt = installPrompt;
      installPrompt = null;
      prompt.prompt();
      const choice = await prompt.userChoice;
      track('install_prompt_result', { outcome: choice.outcome });
      hint.remove();
    });
    on('#install-no', () => {
      store.set('rr_install_dismissed', true);
      track('install_hint_dismissed');
      hint.remove();
    });
  }

  // ---------- first step (R10): until someone finishes a step, offer only tiny ones ----------
  // Testers from before this flag existed already have a step_done event on their device.
  if (!store.get('rr_has_done', false) && store.get('rr_events', []).some((e) => e.event === 'step_done')) {
    store.set('rr_has_done', true);
  }
  const isFirstStep = () => !store.get('rr_has_done', false);
  // Library level 2 = all tiny (see steps-library.js).
  const libraryLevel = (easier) => (isFirstStep() ? Math.max(easier, 2) : easier);

  // ---------- session state (photos stay in memory only) ----------
  const state = {
    source: null,        // 'photo' | 'spot'
    spot: null,
    image: null,         // base64 JPEG sent to /api/steps
    thumb: null,         // small data URL, saved on this device only if Kate opts in
    hasPerson: true,     // assume a person until the model says otherwise (safe default)
    heavyClutter: false,
    tidy: false,
    steps: [],
    stepsSource: null,
    easier: 0,
    seen: [],
    current: null,
    stepsDone: 0
  };
  let timerId = null;

  // ---------- rendering helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function show(name, html) {
    stopTimer();
    screenName = name;
    app.innerHTML = '<section class="screen">' + html + '</section>';
    const h = app.querySelector('h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    window.scrollTo(0, 0);
  }
  function on(selector, handler) {
    app.querySelectorAll(selector).forEach((el) => el.addEventListener('click', handler));
  }
  function pickFile(onFile) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => onFile(input.files && input.files[0]));
    input.click();
  }

  // ---------- image prep: compress in the browser before upload (R2) ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }
  function resize(img, max, quality) {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  }
  async function prepareImage(file) {
    const img = await loadImage(file);
    // 768px fits in one Gemini image tile: faster and still enough to see objects.
    return { data: resize(img, 768, 0.75).split(',')[1], thumb: resize(img, 480, 0.6) };
  }

  // ---------- API ----------
  async function callApi(body) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), CONFIG.CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch('/api/steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!res.ok) {
        let detail = {};
        try { detail = await res.json(); } catch (e) { /* not JSON */ }
        throw new Error(['http_' + res.status, detail.error, detail.status, detail.model, (detail.tried || []).join(','), detail.message].filter(Boolean).join(' | '));
      }
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchPhotoSteps() {
    loading('Looking for one small place to start…');
    try {
      const data = await callApi({ image: state.image, easier: state.easier, avoid: state.seen, firstStep: isFirstStep() });
      state.hasPerson = data.hasPerson !== false;
      state.heavyClutter = !!data.heavyClutter;
      if (data.status === 'unclear' || !Array.isArray(data.steps) || data.steps.length === 0) {
        // After a finished step, "nothing new" means she's done what the photo showed, not a bad photo.
        if (state.stepsDone > 0) { track('photo_steps_finished', { done: state.stepsDone }); return allDone(); }
        track('photo_unclear');
        return unclear();
      }
      state.tidy = data.status === 'tidy';
      // Show only steps grounded in the photo; topping up with generic ones made photos look ignored.
      setSteps(data.steps.slice(0, 3), 'ai');
    } catch (err) {
      track('steps_fallback', { reason: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err) });
      state.tidy = false;
      setSteps(Library.starter(libraryLevel(state.easier), state.seen), 'fallback');
    }
  }

  function setSteps(steps, source) {
    state.steps = steps;
    state.stepsSource = source;
    state.seen = state.seen.concat(steps.map((s) => s.text)).slice(-24);
    track('steps_shown', { source, easier: state.easier, tidy: state.tidy });
    choose();
  }

  // ---------- screens ----------
  function home() {
    const left = photosLeft();
    const photoPrimary = arm === 'photo_first' && left > 0;
    const snapBtn = left > 0
      ? '<button class="btn ' + (photoPrimary ? 'primary' : 'quiet') + '" id="snap">' + (photoPrimary ? 'Snap your room' : 'Or snap a photo') + '</button>'
      : '';
    const spotBtn = '<button class="btn ' + (photoPrimary ? 'quiet' : 'primary') + '" id="spot">' + (photoPrimary ? 'Or pick a spot' : 'Pick a spot') + '</button>';
    const lead = photoPrimary
      ? 'Snap your room. We’ll find one small place to start.'
      : 'Pick one spot. We’ll find one small place to start.';
    const capNote = left > 0
      ? left + ' free photo ' + (left === 1 ? 'start' : 'starts') + ' left today. Picking a spot is always free.'
      : 'You’ve used today’s free photo starts. Picking a spot is always free, and more photo starts are coming with Room Reset Plus.';

    show('home',
      '<p class="brand">Room Reset</p>' +
      '<h1>No plan needed. Just one small thing.</h1>' +
      '<p class="lead">' + lead + '</p>' +
      '<div class="actions">' + (photoPrimary ? snapBtn + spotBtn : spotBtn + snapBtn) + '</div>' +
      '<p class="note">' + capNote + '</p>' +
      (left > 0 ? '<p class="note">Your photo is sent to Google Gemini to suggest steps. Room Reset doesn’t keep it. Try to leave people and private papers out of the shot.</p>' : '') +
      progressHtml() +
      debugHtml()
    );
    on('#snap', () => { track('snap_tapped'); pickFile(handlePhoto); });
    on('#spot', spotPicker);
    on('#delete-photos', () => { store.del('rr_progress'); track('progress_deleted'); home(); });
    on('#export-events', exportEvents);
  }

  async function handlePhoto(file) {
    if (!file) return;
    loading('Getting your photo ready…');
    let prepared;
    try {
      prepared = await prepareImage(file);
    } catch (e) {
      track('photo_unclear', { reason: 'decode' });
      return unclear();
    }
    usePhoto();
    Object.assign(state, {
      source: 'photo', spot: null, image: prepared.data, thumb: prepared.thumb,
      hasPerson: true, heavyClutter: false, tidy: false, easier: 0, seen: []
    });
    track('photo_submitted', { kb: Math.round(prepared.data.length * 0.75 / 1024) });
    fetchPhotoSteps();
  }

  function spotPicker() {
    track('spot_picker_shown');
    const chips = Library.spots.map((s) =>
      '<button class="btn quiet" data-spot="' + s.key + '">' + esc(s.label) + '</button>'
    ).join('');
    show('spot_picker',
      '<p class="brand">Room Reset</p>' +
      '<h1>Where’s one spot you could start?</h1>' +
      '<p class="lead">Just pick one. You don’t have to do the rest.</p>' +
      '<div class="spot-grid">' + chips + '</div>' +
      '<div class="spacer"></div>' +
      '<button class="btn link" id="back">Back</button>'
    );
    on('[data-spot]', (e) => {
      const spot = e.currentTarget.getAttribute('data-spot');
      Object.assign(state, { source: 'spot', spot, image: null, thumb: null, hasPerson: true, heavyClutter: false, tidy: false, easier: 0, seen: [] });
      track('spot_picked', { spot });
      setSteps(Library.forSpot(spot, libraryLevel(0), []), 'library');
    });
    on('#back', home);
  }

  function choose() {
    const intro = state.tidy
      ? 'Looks pretty good! Want a 1-minute reset?'
      : 'Pick the one that feels doable right now.';
    const cards = state.steps.map((s, i) =>
      '<li><button class="step" data-i="' + i + '">' +
        '<span class="tag' + (s.effort === 'a bit more' ? ' more' : '') + '">' + esc(s.effort) + '</span>' +
        '<span>' + esc(s.text) + '</span>' +
        (s.safety ? '<span class="safety">Careful: ' + esc(s.safety) + '</span>' : '') +
      '</button></li>'
    ).join('');
    const easier = state.easier < CONFIG.MAX_EASIER
      ? '<button class="btn link" id="easier">Something easier</button>'
      : '<p class="note">That’s all the easier sets for now. You could <button class="inline-link" id="spot">pick a spot</button> instead.</p>';
    const support = state.heavyClutter
      ? '<p class="note">Some rooms need more than small steps, and that’s okay. If you’d like support, <a href="https://hoardinguk.org/" target="_blank" rel="noopener">Hoarding UK</a> offers free, private help.</p>'
      : '';

    show('choose',
      '<p class="brand">Room Reset</p>' +
      '<h1>' + intro + '</h1>' +
      (state.stepsSource === 'fallback'
        ? '<p class="note">We couldn’t read your photo just now, so these are general starting steps.</p>'
        : '<p class="note">' + (isFirstStep() ? 'Each one takes under a minute.' : 'Each one takes 2 minutes or less.') + '</p>') +
      '<ul class="steps">' + cards + '</ul>' +
      easier + support +
      '<div class="spacer"></div>' +
      (state.stepsDone > 0 ? endButton('quiet') : '') +
      '<button class="btn link" id="home">Start over</button>'
    );
    bindEnd();
    on('[data-i]', (e) => doStep(state.steps[Number(e.currentTarget.getAttribute('data-i'))]));
    on('#easier', () => {
      state.easier += 1;
      track('step_easier', { n: state.easier });
      if (state.source === 'photo' && state.image) fetchPhotoSteps();
      else setSteps(Library.forSpot(state.spot || 'anywhere', libraryLevel(state.easier), state.seen), 'library');
    });
    on('#spot', spotPicker);
    on('#home', home);
  }

  function doStep(step, resumed) {
    state.current = step;
    store.set('rr_current', { step, at: Date.now(), source: state.source, spot: state.spot });
    track('step_chosen', { effort: step.effort, source: state.stepsSource, resumed: !!resumed });
    show('do',
      '<p class="brand">Your one step</p>' +
      '<h1 class="focus-card">' + esc(step.text) + '</h1>' +
      (step.safety ? '<p class="note">Careful: ' + esc(step.safety) + '</p>' : '') +
      '<p class="timer" id="timer" hidden></p>' +
      '<p class="note" id="timer-note" hidden></p>' +
      '<div class="spacer"></div>' +
      '<div class="actions">' +
        '<button class="btn primary" id="done">Done</button>' +
        '<button class="btn quiet" id="start-timer">Start a 2-minute timer</button>' +
      '</div>' +
      '<button class="btn link" id="back">Choose a different step</button>'
    );
    on('#done', finishStep);
    on('#start-timer', startTimer);
    on('#back', () => {
      store.del('rr_current');
      track('step_backed_out');
      if (state.steps.length) choose(); else home();
    });
  }

  function startTimer() {
    const timerEl = document.getElementById('timer');
    const note = document.getElementById('timer-note');
    const btn = document.getElementById('start-timer');
    if (btn) btn.hidden = true;
    let left = CONFIG.TIMER_SECONDS;
    const paint = () => {
      timerEl.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    };
    timerEl.hidden = false;
    paint();
    track('timer_started');
    timerId = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        stopTimer();
        timerEl.hidden = true;
        note.hidden = false;
        note.textContent = 'Take your time. Tap Done whenever you’re ready.';
        return;
      }
      paint();
    }, 1000);
  }
  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function finishStep() {
    store.del('rr_current');
    state.stepsDone += 1;
    const firstEver = isFirstStep();
    store.set('rr_has_done', true);
    track('step_done', {
      n: state.stepsDone,
      first: state.stepsDone === 1,
      first_ever: firstEver,
      ms_since_open: Date.now() - openedAt,
      effort: state.current && state.current.effort,
      source: state.stepsSource
    });
    state.steps = state.steps.filter((s) => s !== state.current);
    celebrate();
  }

  function celebrate() {
    const win = WINS[Math.floor(Math.random() * WINS.length)];
    show('celebrate',
      '<p class="brand">Room Reset</p>' +
      '<h1>' + win + '</h1>' +
      '<p class="note">Was that a good step for you?</p>' +
      '<div class="chips">' +
        '<button class="chip" data-fb="up" aria-pressed="false">Good step</button>' +
        '<button class="chip" data-fb="down" aria-pressed="false">Not for me</button>' +
      '</div>' +
      '<div class="spacer"></div>' +
      '<div class="actions pair">' +
        '<button class="btn primary" id="more">One more small step</button>' +
        '<button class="btn primary" id="enough">That’s enough for now</button>' +
      '</div>'
    );
    on('[data-fb]', (e) => {
      const value = e.currentTarget.getAttribute('data-fb');
      app.querySelectorAll('[data-fb]').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      track('step_feedback', { value, step: state.current && state.current.text, source: state.stepsSource });
    });
    on('#more', () => {
      track('one_more', { done: state.stepsDone });
      state.easier = 0;
      if (state.source === 'photo' && state.image) fetchPhotoSteps();
      else setSteps(Library.forSpot(state.spot || 'anywhere', 0, state.seen), 'library');
    });
    on('#enough', stopWell);
  }

  function stopWell() {
    track('stop', { done: state.stepsDone });
    const canSave = state.source === 'photo' && state.thumb && !state.hasPerson;
    const saveBlock = canSave
      ? '<p class="note">Want to see your progress next time? Take an “after” photo. Both stay on this phone only.</p>' +
        '<button class="btn quiet" id="after">Save before and after on this phone</button>'
      : (state.source === 'photo' && state.hasPerson
        ? '<p class="note">We didn’t offer to save this photo because it may show a person.</p>'
        : '');
    show('stop',
      '<p class="brand">Room Reset</p>' +
      '<h1>You started. That’s the hard part.</h1>' +
      '<p class="note">How do you feel now?</p>' +
      '<div class="chips">' +
        '<button class="chip" data-feel="better" aria-pressed="false">Better</button>' +
        '<button class="chip" data-feel="same" aria-pressed="false">Same</button>' +
        '<button class="chip" data-feel="worse" aria-pressed="false">Worse</button>' +
      '</div>' +
      saveBlock +
      '<p class="note" id="save-msg" hidden></p>' +
      installHtml() +
      '<div class="spacer"></div>' +
      '<button class="btn primary" id="finish">Done for now</button>'
    );
    on('[data-feel]', (e) => {
      app.querySelectorAll('[data-feel]').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      track('feeling', { value: e.currentTarget.getAttribute('data-feel') });
    });
    on('#after', () => pickFile(saveAfterPhoto));
    bindInstall();
    on('#finish', () => {
      Object.assign(state, { image: null, thumb: null, steps: [], seen: [], stepsDone: 0 });
      home();
    });
  }

  async function saveAfterPhoto(file) {
    const msg = document.getElementById('save-msg');
    const btn = document.getElementById('after');
    if (!file || !msg) return;
    msg.hidden = false;
    msg.textContent = 'Checking your photo…';
    try {
      const prepared = await prepareImage(file);
      const check = await callApi({ image: prepared.data, mode: 'check' });
      if (check.hasPerson !== false) {
        msg.textContent = 'This photo may show a person, so we didn’t save it.';
        track('after_photo', { saved: false, reason: 'person' });
        return;
      }
      const ok = store.set('rr_progress', { before: state.thumb, after: prepared.thumb, date: today() });
      msg.textContent = ok ? 'Saved on this phone. You’ll see them next time.' : 'Your phone didn’t have room to save these.';
      if (ok && btn) btn.hidden = true;
      track('after_photo', { saved: ok });
    } catch (e) {
      msg.textContent = 'We couldn’t check that photo just now, so we didn’t save it.';
      track('after_photo', { saved: false, reason: 'error' });
    }
  }

  // ---------- ending a session whenever she wants ----------
  function endButton(style) {
    return '<button class="btn ' + style + '" id="end">I’m done for now</button>';
  }
  function bindEnd() {
    on('#end', () => {
      track('end_tapped', { from: screenName, done: state.stepsDone });
      // With a finished step she gets the "You started" wrap-up; without one, just home, no guilt.
      if (state.stepsDone > 0) stopWell(); else home();
    });
  }

  function allDone() {
    show('all_done',
      '<p class="brand">Room Reset</p>' +
      '<h1>That’s everything we spotted in your photo.</h1>' +
      '<p class="lead">You did ' + state.stepsDone + (state.stepsDone === 1 ? ' step' : ' steps') + '. That’s a real start.</p>' +
      '<div class="spacer"></div>' +
      '<div class="actions">' +
        endButton('primary') +
        '<button class="btn quiet" id="spot">Pick a spot to keep going</button>' +
        (photosLeft() > 0 ? '<button class="btn quiet" id="snap">Take a new photo</button>' : '') +
      '</div>'
    );
    bindEnd();
    on('#spot', spotPicker);
    on('#snap', () => pickFile(handlePhoto));
  }

  function unclear() {
    show('unclear',
      '<p class="brand">Room Reset</p>' +
      '<h1>We couldn’t quite see the room.</h1>' +
      '<p class="lead">That happens with dark or blurry photos. Pick a spot instead and we’ll find a small start.</p>' +
      '<div class="actions">' +
        '<button class="btn primary" id="spot">Pick a spot</button>' +
        (photosLeft() > 0 ? '<button class="btn quiet" id="snap">Try another photo</button>' : '') +
        endButton('link') +
      '</div>'
    );
    bindEnd();
    on('#spot', spotPicker);
    on('#snap', () => pickFile(handlePhoto));
  }

  function loading(message) {
    show('loading',
      '<p class="brand">Room Reset</p>' +
      '<h1>' + esc(message) + '</h1>' +
      '<div class="dots" aria-hidden="true"><span></span><span></span><span></span></div>'
    );
  }

  function resume(saved) {
    track('resume_shown');
    show('resume',
      '<p class="brand">Room Reset</p>' +
      '<h1>Welcome back. Pick up where you left off?</h1>' +
      '<p class="focus-card">' + esc(saved.step.text) + '</p>' +
      '<div class="spacer"></div>' +
      '<div class="actions">' +
        '<button class="btn primary" id="resume">Pick up where I left off</button>' +
        '<button class="btn quiet" id="fresh">Start fresh</button>' +
      '</div>'
    );
    on('#resume', () => {
      Object.assign(state, { source: saved.source === 'photo' ? 'spot' : saved.source, spot: saved.spot || 'anywhere', steps: [] });
      doStep(saved.step, true);
    });
    on('#fresh', () => { store.del('rr_current'); track('resume_declined'); home(); });
  }

  // ---------- progress (on-device only, R7) ----------
  function progressHtml() {
    const p = store.get('rr_progress', null);
    if (!p || !p.before || !p.after) return '';
    return '<div class="progress">' +
      '<h2>Your progress</h2>' +
      '<div class="pics">' +
        '<figure><img src="' + esc(p.before) + '" alt="Your room before"><figcaption>Before</figcaption></figure>' +
        '<figure><img src="' + esc(p.after) + '" alt="Your room after"><figcaption>After, ' + esc(p.date || '') + '</figcaption></figure>' +
      '</div>' +
      '<button class="btn link" id="delete-photos">Delete these photos</button>' +
    '</div>';
  }

  // ---------- debug view for moderated tests: add ?debug=1 to the URL ----------
  function debugHtml() {
    if (params.get('debug') !== '1') return '';
    const log = store.get('rr_events', []);
    const counts = {};
    log.forEach((e) => { counts[e.event] = (counts[e.event] || 0) + 1; });
    const rows = Object.keys(counts).sort().map((k) => '<tr><td>' + esc(k) + '</td><td>' + counts[k] + '</td></tr>').join('');
    return '<div class="debug"><strong>Debug</strong> · arm: ' + esc(arm) + ' · photo starts left: ' + photosLeft() +
      '<table>' + (rows || '<tr><td>No events yet</td></tr>') + '</table>' +
      '<button class="btn link" id="export-events">Download events (JSON)</button></div>';
  }
  function exportEvents() {
    const blob = new Blob([JSON.stringify(store.get('rr_events', []), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'room-reset-events-' + today() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- start ----------
  window.addEventListener('pagehide', () => track('page_hide', { done: state.stepsDone, easier: state.easier }));

  track('app_open', { installed: isInstalled(), from_homescreen: params.get('source') === 'homescreen', first_step: isFirstStep() });
  const saved = store.get('rr_current', null);
  if (saved && saved.step && Date.now() - saved.at < CONFIG.RESUME_HOURS * 3600 * 1000) resume(saved);
  else { store.del('rr_current'); home(); }
})();
