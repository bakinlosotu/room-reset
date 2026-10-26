// Vercel serverless function: POST /api/steps
// Sends one compressed room photo to a free vision model and returns up to 3 tiny steps:
// Cloudflare Workers AI first when set up, then Google Gemini.
// The photo is never written to disk or logged here.
// Env vars (Vercel > Project > Settings > Environment Variables), at least one provider:
//   CF_ACCOUNT_ID, CF_API_TOKEN  Cloudflare Workers AI (free daily allowance; token from the "Workers AI" template)
//   CF_MODEL        optional; defaults to @cf/mistralai/mistral-small-3.1-24b-instruct
//   GEMINI_API_KEY  from https://aistudio.google.com (no billing account = free tier only)
//   GEMINI_MODEL    optional; tried first, then the free Flash models below

// Tried in order until one answers. Model names change over time, busy models turn
// free-tier requests away, and each model has its own free quota, so any of those moves
// on to the next instead of failing the photo. Flash-Lite first: in live tests it was the
// one that answered (5-8s) while full Flash was overloaded.
const MODELS = [process.env.GEMINI_MODEL, 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.5-flash-lite']
  .filter((m, i, all) => m && all.indexOf(m) === i);
const RETRY_STATUSES = [404, 429, 500, 503];
const ATTEMPT_TIMEOUT_MS = 7000; // good answers took 2-7s; a slower try leaves time for one more
const EFFORTS = ['tiny', 'small', 'a bit more'];
const BANNED = /\b(clean|tidy|organi[sz]e|declutter|sort)\s+(up\s+)?(the\s+|your\s+)?(whole\s+|entire\s+)?(room|bedroom|everything|space|flat|house)\b|\btidy everything\b/i;
const MAX_IMAGE_CHARS = 2000000; // ~1.5 MB of JPEG; the app sends ~60-120 KB
const UPSTREAM_TIMEOUT_MS = 14000; // the app waits 15s before showing general steps
const STOPWORDS = new Set(['the', 'and', 'with', 'your', 'some', 'pair', 'pairs', 'set', 'pile', 'piles', 'bunch', 'small', 'large', 'big', 'little', 'few', 'two', 'three']);

// The model must name what it can see BEFORE it writes steps (propertyOrdering puts
// "objects" first), and every step must point at one of those objects. This stops it
// filling the 3 steps with things that are not in the photo.
const STEPS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    objects: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, where: { type: 'STRING' } },
        required: ['name', 'where'],
        propertyOrdering: ['name', 'where']
      }
    },
    status: { type: 'STRING', enum: ['ok', 'tidy', 'unclear'] },
    hasPerson: { type: 'BOOLEAN' },
    heavyClutter: { type: 'BOOLEAN' },
    steps: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          object: { type: 'STRING' },
          text: { type: 'STRING' },
          effort: { type: 'STRING', enum: EFFORTS },
          safety: { type: 'STRING', nullable: true }
        },
        required: ['object', 'text', 'effort'],
        propertyOrdering: ['object', 'text', 'effort', 'safety']
      }
    }
  },
  required: ['objects', 'status', 'hasPerson', 'heavyClutter', 'steps'],
  propertyOrdering: ['objects', 'status', 'hasPerson', 'heavyClutter', 'steps']
};

const CHECK_SCHEMA = {
  type: 'OBJECT',
  properties: { hasPerson: { type: 'BOOLEAN' } },
  required: ['hasPerson']
};

function stepsPrompt(easier, avoid, firstStep) {
  return [
    'You help someone who finds it hard to START tidying their room. Look carefully at this photo.',
    '',
    '1. objects: list up to 8 specific, movable things you can clearly see, and where each one is in the photo.',
    '   Only list things you are certain are visible. Do not guess what is out of frame or hidden.',
    '   Describe "where" only with surfaces or furniture that are actually visible.',
    '   If the photo shows no room contents (for example only a wall, ceiling, floor texture or a blur),',
    '   or is too dark or blurry, return an empty list.',
    '2. status: "unclear" if fewer than 2 objects are listed; "tidy" if the room already looks tidy; otherwise "ok".',
    '3. steps: up to 3 steps, each about ONE object from your list.',
    '   - "object" must be copied exactly from a name in your list.',
    '   - "text" names that object, says where it is now (using its "where"), and one specific place it belongs',
    '     that is different from where it is now (a drawer, the laundry basket, the bin, the kitchen, a shelf, a hook).',
    '   - Every step moves something to where it belongs. Never "straighten", "tidy up", "set aside" or "put nearby".',
    '   - Pick objects that are out of place first.',
    '   - Never use the words messy, mess, clutter, untidy, pile of junk.',
    '   - Each takes 2 minutes or less. Warm, plain UK English, under 20 words.',
    '   - Write numbers naturally: "the mug", "2 mugs", never "the 1 mug".',
    '   - Never suggest cleaning or tidying the whole room, everything, or a large area.',
    '   - No judgement and no comments on how messy it is.',
    '   - If status is "unclear", steps must be empty.',
    '   - If status is "tidy", give 1-minute maintenance steps, all "tiny".',
    'hasPerson: true if any person or part of a person is visible.',
    'Never describe people, faces, documents, screens or anything personal; steps are about objects only.',
    'heavyClutter: true only if the floor and surfaces are almost entirely covered. Then make every step "tiny".',
    'safety: a short caution if a step involves broken glass, mould, sharp objects, chemicals or heavy lifting, else null.',
    firstStep
      ? 'This is their very first step with the app. Every step must be "tiny": one object, done in under a minute.'
      : easier > 0
        ? 'The person asked for something easier ' + easier + ' time(s). Make every step smaller and quicker' + (easier >= 2 ? ', all "tiny"' : '') + '.'
        : 'Where possible, offer one "tiny", one "small" and one "a bit more" step.',
    avoid.length ? 'Do not repeat these steps: ' + JSON.stringify(avoid) : ''
  ].filter((line) => line !== null).join('\n');
}

const CHECK_PROMPT = 'Is any person, or any part of a person, visible in this photo?';

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

const words = (s) => String(s).toLowerCase().match(/[a-z]+/g) || [];

function cleanObjects(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((o) => ({ name: String((o && o.name) || '').trim().slice(0, 60), where: String((o && o.where) || '').trim().slice(0, 80) }))
    .filter((o) => o.name)
    .slice(0, 8);
}

// A step counts only if it points at a listed object AND its text actually mentions it.
function isGrounded(step, objects) {
  const name = String(step.object || '').trim().toLowerCase();
  const obj = objects.find((o) => o.name.toLowerCase() === name);
  if (!obj) return false;
  const text = step.text.toLowerCase();
  return words(obj.name)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .some((w) => text.includes(w.replace(/(es|s)$/, '')));
}

function cleanSteps(raw, objects) {
  return (Array.isArray(raw) ? raw : [])
    .map((s) => ({
      object: String((s && s.object) || ''),
      text: String((s && s.text) || '').trim().slice(0, 160),
      effort: EFFORTS.includes(s && s.effort) ? s.effort : 'small',
      safety: s && typeof s.safety === 'string' && s.safety.trim() && s.safety.trim().toLowerCase() !== 'null' ? s.safety.trim().slice(0, 160) : null
    }))
    .filter((s) => s.text && !BANNED.test(s.text) && isGrounded(s, objects))
    .slice(0, 3)
    .map(({ text, effort, safety }) => ({ text, effort, safety }));
}

// ---------- providers ----------
// Each call returns { status, text, modelVersion, message }. status 200 means text holds the reply.

// Gemma (on the Gemini API) and Cloudflare models don't take a JSON schema, so they get
// the shape in the prompt instead (parseJson copes with a fenced reply).
const STEPS_SHAPE = 'Reply with JSON only, no other text, in exactly this shape: ' +
  '{"objects":[{"name":"","where":""}],"status":"ok|tidy|unclear","hasPerson":false,"heavyClutter":false,' +
  '"steps":[{"object":"","text":"","effort":"tiny|small|a bit more","safety":null}]}';
const CHECK_SHAPE = 'Reply with JSON only, no other text: {"hasPerson":true} or {"hasPerson":false}';
const withShape = (prompt, mode) => prompt + '\n\n' + (mode === 'check' ? CHECK_SHAPE : STEPS_SHAPE);

async function callGemini(model, mode, image, prompt, signal) {
  const gemma = /^gemma-/.test(model);
  const generationConfig = gemma
    ? { temperature: 0.2 }
    : { responseMimeType: 'application/json', responseSchema: mode === 'check' ? CHECK_SCHEMA : STEPS_SCHEMA, temperature: 0.2 };
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: image } }, { text: gemma ? withShape(prompt, mode) : prompt }] }],
        generationConfig
      }),
      signal
    }
  );
  if (!r.ok) {
    // Google's message says why (bad key, quota, retired model); it never contains the key.
    let message = '';
    try { message = ((await r.json()).error || {}).message || ''; } catch (e) { /* not JSON */ }
    return { status: r.status, message };
  }
  const data = await r.json();
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return { status: 200, text: parts.map((p) => p.text || '').join(''), modelVersion: data.modelVersion || model };
}

// Cloudflare Workers AI (free daily allowance). Needs CF_ACCOUNT_ID and CF_API_TOKEN.
async function callCloudflare(model, mode, image, prompt, signal) {
  const r = await fetch(
    'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(CF_ACCOUNT()) + '/ai/run/' + model,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CF_TOKEN() },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: withShape(prompt, mode) },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image } }
          ]
        }],
        max_tokens: 900,
        temperature: 0.2
      }),
      signal
    }
  );
  let data = null;
  try { data = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok || !data || data.success === false) {
    const err = data && data.errors && data.errors[0];
    return { status: r.ok ? 502 : r.status, message: String((err && err.message) || '') };
  }
  const reply = data.result && data.result.response;
  return { status: 200, text: typeof reply === 'string' ? reply : JSON.stringify(reply || ''), modelVersion: model };
}

// Trimmed: a pasted value with a stray space or line break fails authentication.
const CF_ACCOUNT = () => String(process.env.CF_ACCOUNT_ID || '').trim();
const CF_TOKEN = () => String(process.env.CF_API_TOKEN || '').trim();
const CF_ON = () => !!(CF_ACCOUNT() && CF_TOKEN());
// Mistral Small 3.1 reads images without the licence step Meta's Llama vision model needs.
const CF_MODEL = () => process.env.CF_MODEL || '@cf/mistralai/mistral-small-3.1-24b-instruct';
const CF_ATTEMPT_TIMEOUT_MS = 12000; // Mistral Small 3.1 answered real room photos in 7-9.5s

// Cloudflare first when it's set up (Gemini's free tier was refusing every request),
// then the Gemini list. Any failure moves on to the next.
function attempts(only) {
  if (only) return [{ provider: only.startsWith('@cf/') ? 'cloudflare' : 'gemini', model: only }];
  const list = CF_ON() ? [{ provider: 'cloudflare', model: CF_MODEL() }] : [];
  if (process.env.GEMINI_API_KEY) MODELS.forEach((model) => list.push({ provider: 'gemini', model }));
  return list;
}

// ---------- diagnostics: GET /api/steps?models=1 ----------
// Lists the model names each provider offers this account (names only, never keys),
// so a retired or overloaded model can be swapped quickly.
async function listModels(res) {
  // Which settings this deployment can see: names and yes/no only, never values.
  const out = {
    config: {
      environment: process.env.VERCEL_ENV || 'unknown',
      CF_ACCOUNT_ID: !!process.env.CF_ACCOUNT_ID,
      CF_API_TOKEN: !!process.env.CF_API_TOKEN,
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
      otherNamesLikeCloudflare: Object.keys(process.env).filter((k) => /^(CF|CLOUDFLARE)|CF_/i.test(k) && !['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_MODEL'].includes(k))
    }
  };
  if (process.env.GEMINI_API_KEY) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } });
    out.gemini = r.ok
      ? ((await r.json()).models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter((n) => /^(gemini|gemma)-/.test(n))
      : 'error ' + r.status;
  }
  if (CF_ON()) {
    // Shape checks and Cloudflare's own token check; still no values returned.
    const rawToken = String(process.env.CF_API_TOKEN || '');
    out.config.cfAccountIdLooksRight = /^[0-9a-f]{32}$/.test(CF_ACCOUNT());
    out.config.cfTokenHadSpaces = rawToken !== rawToken.trim();
    out.config.cfTokenLength = CF_TOKEN().length;
    out.config.cfTokenLooksLikeGlobalKey = /^[0-9a-f]{37}$/.test(CF_TOKEN());
    const verify = async (url) => {
      const v = await fetch(url, { headers: { Authorization: 'Bearer ' + CF_TOKEN() } });
      const d = await v.json().catch(() => null);
      return v.ok && d && d.result ? d.result.status : 'error ' + v.status + (d && d.errors && d.errors[0] ? ' ' + d.errors[0].message : '');
    };
    out.config.cfTokenUserCheck = await verify('https://api.cloudflare.com/client/v4/user/tokens/verify');
    out.config.cfTokenAccountCheck = await verify('https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(CF_ACCOUNT()) + '/tokens/verify');
    const r = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(CF_ACCOUNT()) + '/ai/models/search?per_page=200',
      { headers: { Authorization: 'Bearer ' + CF_TOKEN() } }
    );
    const data = r.ok ? await r.json() : null;
    out.cloudflare = data && data.result
      ? data.result
        .filter((m) => /image|vision|multimodal/i.test(String(m.description || '')))
        .map((m) => m.name + ' (' + ((m.task && m.task.name) || '') + ')')
      : 'error ' + r.status;
    out.cloudflareDefault = CF_MODEL();
  }
  return res.status(200).json(out);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const configured = !!process.env.GEMINI_API_KEY || CF_ON();
  if (req.method === 'GET' && req.query && req.query.models) {
    if (!configured) return res.status(503).json({ error: 'not_configured' });
    return listModels(res);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!configured) return res.status(503).json({ error: 'not_configured' });

  const body = typeof req.body === 'string' ? (parseJson(req.body) || {}) : (req.body || {});
  const image = typeof body.image === 'string' ? body.image : '';
  if (!image || image.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return res.status(400).json({ error: 'bad_image' });
  }
  const mode = body.mode === 'check' ? 'check' : 'steps';
  const easier = Math.max(0, Math.min(3, parseInt(body.easier, 10) || 0));
  const firstStep = body.firstStep === true;
  const avoid = (Array.isArray(body.avoid) ? body.avoid : [])
    .filter((s) => typeof s === 'string')
    .slice(-12)
    .map((s) => s.slice(0, 160));

  const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;
  const prompt = mode === 'check' ? CHECK_PROMPT : stepsPrompt(easier, avoid, firstStep);
  // Testing only: {"model": "..."} tries just that model, with the whole time budget.
  const only = typeof body.model === 'string' && /^((gemini|gemma)-[\w.-]+|@cf\/[\w.\/-]+)$/.test(body.model) ? body.model : null;
  try {
    let reply = null;
    let model = null;
    const tried = [];
    for (const attempt of attempts(only)) {
      model = attempt.model;
      const cap = only ? UPSTREAM_TIMEOUT_MS : (attempt.provider === 'cloudflare' ? CF_ATTEMPT_TIMEOUT_MS : ATTEMPT_TIMEOUT_MS);
      const budget = Math.min(cap, deadline - Date.now());
      if (budget < 2000) break;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), budget);
      try {
        const call = attempt.provider === 'cloudflare' ? callCloudflare : callGemini;
        reply = await call(model, mode, image, prompt, ctrl.signal);
      } catch (err) {
        if (!err || err.name !== 'AbortError') throw err;
        tried.push(model + ':timeout');
        reply = null;
        continue;
      } finally {
        clearTimeout(timer);
      }
      tried.push(model + ':' + reply.status);
      if (reply.status === 200) break;
      console.error('Model unavailable', model, reply.status, reply.message);
      // Cloudflare failing (quota, licence, model name) always falls through to Gemini.
      if (attempt.provider === 'gemini' && !RETRY_STATUSES.includes(reply.status)) break;
    }
    if (!reply) return res.status(504).json({ error: 'timeout', model, tried });
    if (reply.status === 429) return res.status(429).json({ error: 'rate_limited', model, tried });
    if (reply.status !== 200) {
      return res.status(502).json({ error: 'upstream_error', status: reply.status, model, tried, message: String(reply.message || '').slice(0, 300) });
    }
    const out = parseJson(reply.text) || {};
    const meta = { model, modelVersion: reply.modelVersion || null, tried };

    if (mode === 'check') return res.status(200).json({ hasPerson: out.hasPerson !== false, ...meta });

    const objects = cleanObjects(out.objects);
    let steps = objects.length >= 2 ? cleanSteps(out.steps, objects) : [];
    // R10: on a first step keep only tiny ones, unless the model gave none (then keep what we have).
    if (firstStep && steps.some((s) => s.effort === 'tiny')) steps = steps.filter((s) => s.effort === 'tiny');
    const status = steps.length === 0 ? 'unclear' : (out.status === 'tidy' ? 'tidy' : 'ok');
    return res.status(200).json({
      status,
      hasPerson: out.hasPerson !== false,
      heavyClutter: !!out.heavyClutter,
      steps,
      seen: objects.map((o) => o.name),
      dropped: Array.isArray(out.steps) ? out.steps.length - steps.length : 0,
      ...meta
    });
  } catch (err) {
    console.error('steps failed', String(err && err.message));
    return res.status(500).json({ error: 'server_error' });
  }
};
