// Vercel serverless function: POST /api/steps
// Sends one compressed room photo to Google Gemini (free tier) and returns up to 3 tiny steps.
// The photo is never written to disk or logged here.
// Env vars (Vercel > Project > Settings > Environment Variables):
//   GEMINI_API_KEY  required, from https://aistudio.google.com (no billing account = free tier only)
//   GEMINI_MODEL    optional; tried first, then the free Flash models below

// Tried in order until one answers. Model names change over time and busy models
// turn free-tier requests away, so either moves on to the next instead of failing the photo.
const MODELS = [process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite']
  .filter((m, i, all) => m && all.indexOf(m) === i);
const EFFORTS = ['tiny', 'small', 'a bit more'];
const BANNED = /\b(clean|tidy|organi[sz]e|declutter|sort)\s+(up\s+)?(the\s+|your\s+)?(whole\s+|entire\s+)?(room|bedroom|everything|space|flat|house)\b|\btidy everything\b/i;
const MAX_IMAGE_CHARS = 2000000; // ~1.5 MB of JPEG; the app sends ~60-120 KB
const UPSTREAM_TIMEOUT_MS = 13000;
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

function stepsPrompt(easier, avoid) {
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
    '   - "text" names that object, says where it is now (using its "where"), and one place to put it.',
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
    easier > 0
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'not_configured' });

  const body = typeof req.body === 'string' ? (parseJson(req.body) || {}) : (req.body || {});
  const image = typeof body.image === 'string' ? body.image : '';
  if (!image || image.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return res.status(400).json({ error: 'bad_image' });
  }
  const mode = body.mode === 'check' ? 'check' : 'steps';
  const easier = Math.max(0, Math.min(3, parseInt(body.easier, 10) || 0));
  const avoid = (Array.isArray(body.avoid) ? body.avoid : [])
    .filter((s) => typeof s === 'string')
    .slice(-12)
    .map((s) => s.slice(0, 160));

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  const request = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: image } },
        { text: mode === 'check' ? CHECK_PROMPT : stepsPrompt(easier, avoid) }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: mode === 'check' ? CHECK_SCHEMA : STEPS_SCHEMA,
      temperature: 0.2
    }
  });
  try {
    let upstream = null;
    let model = null;
    for (model of MODELS) {
      upstream = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: request,
          signal: ctrl.signal
        }
      );
      // Not found, or overloaded (free-tier requests are the first turned away): try the next model.
      if (![404, 500, 503].includes(upstream.status)) break;
      console.error('Gemini model unavailable', model, upstream.status);
    }
    if (upstream.status === 429) return res.status(429).json({ error: 'rate_limited', model });
    if (!upstream.ok) {
      // Google's message says why (bad key, API not enabled, region, model); it never contains the key.
      let message = '';
      try { message = ((await upstream.json()).error || {}).message || ''; } catch (e) { /* not JSON */ }
      console.error('Gemini error', upstream.status, model, message);
      return res.status(502).json({ error: 'upstream_error', status: upstream.status, model, message: message.slice(0, 300) });
    }
    const data = await upstream.json();
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const out = parseJson(parts.map((p) => p.text || '').join('')) || {};
    const meta = { model, modelVersion: data.modelVersion || null };

    if (mode === 'check') return res.status(200).json({ hasPerson: out.hasPerson !== false, ...meta });

    const objects = cleanObjects(out.objects);
    const steps = objects.length >= 2 ? cleanSteps(out.steps, objects) : [];
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
    const timedOut = err && err.name === 'AbortError';
    console.error('steps failed', timedOut ? 'timeout' : String(err && err.message));
    return res.status(timedOut ? 504 : 500).json({ error: timedOut ? 'timeout' : 'server_error' });
  } finally {
    clearTimeout(timeout);
  }
};
