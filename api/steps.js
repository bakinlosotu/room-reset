// Vercel serverless function: POST /api/steps
// Sends one compressed room photo to Google Gemini (free tier) and returns 3 tiny steps.
// The photo is never written to disk or logged here.
// Env vars (Vercel > Project > Settings > Environment Variables):
//   GEMINI_API_KEY  required, from https://aistudio.google.com (no billing account = free tier only)
//   GEMINI_MODEL    optional; tried first, then the free Flash models below

// Tried in order until one exists for this key. Model names change over time,
// so a "not found" moves on to the next instead of failing the photo.
const MODELS = [process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite']
  .filter((m, i, all) => m && all.indexOf(m) === i);
const EFFORTS = ['tiny', 'small', 'a bit more'];
const BANNED = /\b(clean|tidy|organi[sz]e|declutter|sort)\s+(up\s+)?(the\s+|your\s+)?(whole\s+|entire\s+)?(room|bedroom|everything|space|flat|house)\b|\btidy everything\b/i;
const MAX_IMAGE_CHARS = 2000000; // ~1.5 MB of JPEG; the app sends ~100-200 KB
const UPSTREAM_TIMEOUT_MS = 9000;

function stepsPrompt(easier, avoid) {
  return [
    'You help someone who finds it hard to START tidying their room. Look at the photo.',
    'Reply with JSON only, in this shape:',
    '{"status":"ok"|"tidy"|"unclear","hasPerson":boolean,"heavyClutter":boolean,',
    ' "steps":[{"text":string,"effort":"tiny"|"small"|"a bit more","safety":string|null}]}',
    'Rules:',
    '- Exactly 3 steps, each something you can actually see in this photo.',
    '- Each step takes 2 minutes or less and names ONE object type, ONE action and ONE place to put it,',
    '  e.g. "Put the 3 mugs on your desk by the door for the kitchen".',
    '- Never suggest cleaning or tidying the whole room, everything, or a large area.',
    '- Warm, plain UK English, under 20 words per step. No judgement, no comments on how messy it is.',
    '- Never describe people, faces, documents, screens or anything personal. Steps are about objects only.',
    '- hasPerson: true if any person or part of a person is visible, else false.',
    '- If it is not a room, or too dark or blurry to see objects: status "unclear", steps [].',
    '- If the room already looks tidy: status "tidy" and 3 one-minute maintenance steps, all "tiny".',
    '- heavyClutter: true only if the floor and surfaces are almost entirely covered. Then make every step "tiny".',
    '- If a step involves broken glass, mould, sharp objects, chemicals or heavy lifting, set "safety" to a short caution, else null.',
    easier > 0
      ? '- The person asked for something easier ' + easier + ' time(s). Make all 3 steps smaller and quicker than usual' + (easier >= 2 ? ', all "tiny"' : '') + '.'
      : '- Offer one "tiny", one "small" and one "a bit more" step.',
    avoid.length ? '- Do not repeat these steps: ' + JSON.stringify(avoid) : ''
  ].filter(Boolean).join('\n');
}

const CHECK_PROMPT = 'Is any person, or any part of a person, visible in this photo? Reply with JSON only: {"hasPerson":boolean}';

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (e) { return null; }
}

function cleanSteps(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((s) => ({
      text: String((s && s.text) || '').trim().slice(0, 160),
      effort: EFFORTS.includes(s && s.effort) ? s.effort : 'small',
      safety: s && typeof s.safety === 'string' && s.safety.trim() ? s.safety.trim().slice(0, 160) : null
    }))
    .filter((s) => s.text && !BANNED.test(s.text))
    .slice(0, 3);
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
    generationConfig: { responseMimeType: 'application/json', temperature: 0.6 }
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
      if (upstream.status !== 404) break;
      console.error('Gemini model not found', model);
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

    if (mode === 'check') return res.status(200).json({ hasPerson: out.hasPerson !== false });

    const steps = cleanSteps(out.steps);
    const status = ['ok', 'tidy', 'unclear'].includes(out.status) ? out.status : (steps.length ? 'ok' : 'unclear');
    return res.status(200).json({
      status,
      hasPerson: out.hasPerson !== false,
      heavyClutter: !!out.heavyClutter,
      steps: status === 'unclear' ? [] : steps
    });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    console.error('steps failed', timedOut ? 'timeout' : String(err && err.message));
    return res.status(timedOut ? 504 : 500).json({ error: timedOut ? 'timeout' : 'server_error' });
  } finally {
    clearTimeout(timeout);
  }
};
