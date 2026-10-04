import { handleStudy } from "./sk-labeling.js";
import { serveVideo } from "./videos.js";
import clipPairs from "../backend/data/clip_pairs.json";
import goldPairs from "../backend/data/gold_pairs.json";

const GOLD_RATE = 0.07;
const REPEAT_GAP = 10;
const REPEAT_RATE = 0.05;
const MAX_REPEAT_QUEUE = 5;
const ATTENTION_RATE = 1.0;

const clipById = new Map(clipPairs.map((pair) => [pair.pair_id, pair]));
const goldById = new Map(goldPairs.map((pair) => [pair.pair_id, pair]));

async function getStudySettings(env) {
  const row = await env.DB.prepare("SELECT cant_tell, surprise, attention FROM study_settings WHERE id = 1").first();
  return { cantTell: Boolean(row.cant_tell), surprise: Boolean(row.surprise), attention: Boolean(row.attention) };
}

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message, status = 400) {
  return json({ error: message }, { status });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return null;

  const ownOrigin = new URL(request.url).origin;
  const configured = (env.CORS_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (origin === ownOrigin || configured.includes(origin)) return origin;

  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
  } catch {
    // Invalid Origin values are simply not allowed.
  }
  return null;
}

function addCors(response, request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("x-admin-token");
  return token === env.ADMIN_TOKEN;
}

function coerceSurprise(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 5 ? number : null;
}

function coerceSurpriseChoice(value) {
  return value === "left" || value === "right" || value === "none" ? value : null;
}

function coerceStageDurations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [key, duration] of Object.entries(value)) {
    const number = Number(duration);
    if (Number.isFinite(number) && number >= 0) result[key] = Math.floor(number);
  }
  return Object.keys(result).length ? result : null;
}

function coerceAttention(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attention = structuredClone(value);

  if (attention.side !== "left" && attention.side !== "right") delete attention.side;

  const clamp01 = (input) => Math.max(0, Math.min(1, Number(input)));
  if (attention.type === "point") {
    attention.coordSpace ||= "normalised";
    if (attention.coordSpace === "normalised") {
      if (Number.isFinite(Number(attention.x))) attention.x = clamp01(attention.x);
      if (Number.isFinite(Number(attention.y))) attention.y = clamp01(attention.y);
    }
    if (ATTENTION_RATE >= 1 && !(Number.isFinite(attention.x) && Number.isFinite(attention.y))) {
      throw new TypeError("attention point required");
    }
  } else if (attention.type === "pause-sampling") {
    if (!Array.isArray(attention.samples)) {
      throw new TypeError("attention.samples[] required");
    }
    attention.coordSpace ||= "normalised";
    attention.samples = attention.samples
      .filter((sample) => sample && Number.isFinite(Number(sample.tsMs)) && sample.tsMs >= 0)
      .map((sample) => ({
        tsMs: Math.round(Number(sample.tsMs)),
        points: Array.isArray(sample.points)
          ? sample.points
              .filter(
                (point) =>
                  point &&
                  Number.isFinite(Number(point.x)) &&
                  Number.isFinite(Number(point.y)),
              )
              .map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) }))
          : [],
      }));
  }
  return attention;
}

function parseStoredJson(value) {
  if (value == null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function progress(annotator) {
  return {
    annotatorId: annotator.annotator_id,
    completed: annotator.completed_count,
    total: clipPairs.length,
  };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function getAnnotatorByToken(env, token) {
  if (!token) return null;
  const mapping = await env.DB.prepare(
    "SELECT annotator_id FROM tokens WHERE token = ?1",
  )
    .bind(token)
    .first();
  if (!mapping) return null;

  await env.DB.prepare(
    "INSERT OR IGNORE INTO annotators (annotator_id) VALUES (?1)",
  )
    .bind(mapping.annotator_id)
    .run();

  return env.DB.prepare(
    "SELECT annotator_id, completed_count FROM annotators WHERE annotator_id = ?1",
  )
    .bind(mapping.annotator_id)
    .first();
}

async function serveNextPair(request, env) {
  const token = new URL(request.url).searchParams.get("token");
  const annotator = await getAnnotatorByToken(env, token);
  if (!annotator) return error("Invalid token", 403);
  const settings = await getStudySettings(env);

  const due = await env.DB.prepare(
    `SELECT id, pair_id
       FROM repeat_queue
      WHERE annotator_id = ?1 AND target_at_count <= ?2
      ORDER BY target_at_count, id
      LIMIT 1`,
  )
    .bind(annotator.annotator_id, annotator.completed_count)
    .first();

  if (due) {
    const deleted = await env.DB.prepare(
      "DELETE FROM repeat_queue WHERE id = ?1 AND annotator_id = ?2",
    )
      .bind(due.id, annotator.annotator_id)
      .run();
    const pair = clipById.get(due.pair_id);
    if (deleted.meta.changes > 0 && pair) {
      return json({
        ...pair,
        settings,
        progress: progress(annotator),
        _meta: { isRepeat: true, repeatOf: due.pair_id },
      });
    }
  }

  const seenGoldResult = await env.DB.prepare(
    "SELECT pair_id FROM seen_gold WHERE annotator_id = ?1",
  )
    .bind(annotator.annotator_id)
    .all();
  const seenGold = new Set(seenGoldResult.results.map((row) => row.pair_id));
  const unseenGold = goldPairs.filter((pair) => !seenGold.has(pair.pair_id));

  if (unseenGold.length && Math.random() < GOLD_RATE) {
    const pair = unseenGold[Math.floor(Math.random() * unseenGold.length)];
    await env.DB.prepare(
      "INSERT OR IGNORE INTO seen_gold (annotator_id, pair_id) VALUES (?1, ?2)",
    )
      .bind(annotator.annotator_id, pair.pair_id)
      .run();
    return json({
      ...pair,
      settings,
      progress: progress(annotator),
      _meta: { isGold: true, expected: pair.expected },
    });
  }

  const completedResult = await env.DB.prepare(
    "SELECT pair_id FROM completed_pairs WHERE annotator_id = ?1",
  )
    .bind(annotator.annotator_id)
    .all();
  const completed = new Set(completedResult.results.map((row) => row.pair_id));
  const pair = clipPairs.find((candidate) => !completed.has(candidate.pair_id));
  if (!pair) return json(null);

  return json({
    ...pair,
    settings,
    progress: progress(annotator),
    _meta: { requireRegion: settings.attention && Math.random() < ATTENTION_RATE },
  });
}

function annotationInsert(env, values) {
  return env.DB.prepare(
    `INSERT INTO annotations (
       id, annotator_id, pair_id, response, surprise_choice,
       left_url, right_url, left_surprise, right_surprise,
       attention_json, is_gold, gold_expected, gold_correct,
       is_repeat, repeat_of, presented_time, response_time_ms,
       stage_durations_json
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
     )`,
  ).bind(...values);
}

async function saveAnnotation(request, env) {
  const body = await readBody(request);
  if (!body) return error("A JSON request body is required");

  const annotator = await getAnnotatorByToken(env, body.token);
  if (!annotator) return error("Invalid token", 403);

  if (!clipById.has(body.pairId) && !goldById.has(body.pairId)) {
    return error("Unknown pairId");
  }
  if (!['left', 'right', 'cant_tell'].includes(body.response)) {
    return error("response must be left, right, or cant_tell");
  }
  const settings = await getStudySettings(env);
  if (body.response === "cant_tell" && !settings.cantTell) return error("Can't tell is disabled for this study");

  let attention;
  try {
    attention = settings.attention ? coerceAttention(body.attention) : null;
  } catch (caught) {
    return error(caught.message);
  }

  const pair = goldById.get(body.pairId) || clipById.get(body.pairId);
  const isGold = goldById.has(body.pairId);
  const completed = isGold
    ? null
    : await env.DB.prepare(
        "SELECT 1 AS found FROM completed_pairs WHERE annotator_id = ?1 AND pair_id = ?2",
      )
        .bind(annotator.annotator_id, body.pairId)
        .first();
  const isRepeat = !isGold && Boolean(completed);
  const surpriseChoice = settings.surprise ? coerceSurpriseChoice(body.surpriseChoice) : null;
  const stageDurations = coerceStageDurations(body.stageDurations);
  const leftSurprise = settings.surprise ? coerceSurprise(body.left?.surprise) : null;
  const rightSurprise = settings.surprise ? coerceSurprise(body.right?.surprise) : null;

  let presentedTime = null;
  if (body.presentedTime) {
    const timestamp = new Date(body.presentedTime);
    if (!Number.isNaN(timestamp.getTime())) presentedTime = timestamp.toISOString();
  }
  const suppliedResponseTime = Number(body.responseTimeMs);
  const computedResponseTime = presentedTime
    ? Math.max(0, Date.now() - new Date(presentedTime).getTime())
    : null;
  const responseTime = Number.isFinite(suppliedResponseTime) && suppliedResponseTime >= 0
    ? Math.floor(suppliedResponseTime)
    : computedResponseTime;

  const goldExpected = isGold ? pair.expected : null;
  const values = [
    crypto.randomUUID(),
    annotator.annotator_id,
    body.pairId,
    body.response,
    surpriseChoice,
    pair.left_clip,
    pair.right_clip,
    leftSurprise,
    rightSurprise,
    attention ? JSON.stringify(attention) : null,
    isGold ? 1 : 0,
    goldExpected,
    isGold ? (body.response === goldExpected ? 1 : 0) : null,
    isRepeat ? 1 : 0,
    isRepeat ? body.pairId : null,
    presentedTime,
    responseTime,
    stageDurations ? JSON.stringify(stageDurations) : null,
  ];

  const statements = [annotationInsert(env, values)];
  if (!isGold && !isRepeat) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO completed_pairs (annotator_id, pair_id) VALUES (?1, ?2)",
      ).bind(annotator.annotator_id, body.pairId),
      env.DB.prepare(
        "UPDATE annotators SET completed_count = completed_count + 1 WHERE annotator_id = ?1",
      ).bind(annotator.annotator_id),
    );

    const queued = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM repeat_queue WHERE annotator_id = ?1",
    )
      .bind(annotator.annotator_id)
      .first();
    if (Math.random() < REPEAT_RATE && Number(queued.count) < MAX_REPEAT_QUEUE) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO repeat_queue (annotator_id, pair_id, target_at_count)
           VALUES (?1, ?2, ?3)`,
        ).bind(annotator.annotator_id, body.pairId, annotator.completed_count + 1 + REPEAT_GAP),
      );
    }
  }

  try {
    await env.DB.batch(statements);
  } catch (caught) {
    if (/UNIQUE|constraint/i.test(String(caught?.message))) {
      return error("Already annotated this original pair", 409);
    }
    throw caught;
  }
  return new Response(null, { status: 200 });
}

function exportedAnnotation(row) {
  return {
    id: row.id,
    annotatorId: row.annotator_id,
    pairId: row.pair_id,
    response: row.response,
    surpriseChoice: row.surprise_choice ?? undefined,
    left: { url: row.left_url, surprise: row.left_surprise ?? undefined },
    right: { url: row.right_url, surprise: row.right_surprise ?? undefined },
    attention: parseStoredJson(row.attention_json),
    isGold: Boolean(row.is_gold),
    goldExpected: row.gold_expected ?? undefined,
    goldCorrect: row.gold_correct == null ? undefined : Boolean(row.gold_correct),
    isRepeat: Boolean(row.is_repeat),
    repeatOf: row.repeat_of ?? undefined,
    presentedTime: row.presented_time ?? undefined,
    timestamp: row.timestamp,
    responseTimeMs: row.response_time_ms ?? undefined,
    stageDurations: parseStoredJson(row.stage_durations_json),
  };
}

async function handleAdmin(request, env, path) {
  if (path === "/api/admin/login" && request.method === "POST") {
    if (!env.ADMIN_PASSWORD || !env.ADMIN_TOKEN) {
      return error("Admin secrets are not configured", 503);
    }
    const body = await readBody(request);
    if (!body || body.password !== env.ADMIN_PASSWORD) return error("Invalid password", 401);
    return json({ token: env.ADMIN_TOKEN });
  }

  if (!isAdmin(request, env)) return error("Forbidden", 403);

  if (path === "/api/admin/settings") {
    if (request.method === "GET") return json(await getStudySettings(env));
    if (request.method === "POST") {
      const body = await readBody(request);
      if (!body || ["cantTell", "surprise", "attention"].some(key => typeof body[key] !== "boolean")) {
        return error("cantTell, surprise, and attention must be booleans");
      }
      await env.DB.prepare("UPDATE study_settings SET cant_tell = ?1, surprise = ?2, attention = ?3 WHERE id = 1")
        .bind(Number(body.cantTell), Number(body.surprise), Number(body.attention)).run();
      return json(await getStudySettings(env));
    }
  }

  if (path === "/api/admin/progress" && request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT t.annotator_id, COALESCE(a.completed_count, 0) AS completed
         FROM tokens t
         LEFT JOIN annotators a ON a.annotator_id = t.annotator_id
        ORDER BY t.annotator_id`,
    ).all();
    return json(
      result.results.map((row) => ({
        annotatorId: row.annotator_id,
        completed: row.completed,
        total: clipPairs.length,
      })),
    );
  }

  if (path === "/api/admin/tokens" && request.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT annotator_id, token FROM tokens ORDER BY annotator_id",
    ).all();
    return json(
      result.results.map((row) => ({ annotatorId: row.annotator_id, token: row.token })),
    );
  }

  if (path === "/api/admin/export" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT * FROM annotations ORDER BY timestamp, id").all();
    return json(result.results.map(exportedAnnotation));
  }

  if (path === "/api/admin/flush" && request.method === "POST") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM annotations"),
      env.DB.prepare("DELETE FROM repeat_queue"),
      env.DB.prepare("DELETE FROM seen_gold"),
      env.DB.prepare("DELETE FROM completed_pairs"),
      env.DB.prepare("DELETE FROM annotators"),
    ]);
    return new Response(null, { status: 200 });
  }

  if (path === "/api/admin/add-annotator" && request.method === "POST") {
    const body = await readBody(request);
    const annotatorId = typeof body?.annotatorId === "string" ? body.annotatorId.trim() : "";
    if (!annotatorId) return error("annotatorId required");

    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    try {
      await env.DB.prepare(
        "INSERT INTO tokens (annotator_id, token) VALUES (?1, ?2)",
      )
        .bind(annotatorId, token)
        .run();
    } catch (caught) {
      if (/UNIQUE|constraint/i.test(String(caught?.message))) {
        return error("Annotator ID already exists", 409);
      }
      throw caught;
    }
    return json({ annotatorId, token });
  }

  if (path === "/api/admin/remove-annotator" && request.method === "POST") {
    const body = await readBody(request);
    const annotatorId = typeof body?.annotatorId === "string" ? body.annotatorId : null;
    const token = typeof body?.token === "string" ? body.token : null;
    if (!annotatorId && !token) return error("annotatorId or token required");

    if (annotatorId) {
      await env.DB.prepare("DELETE FROM tokens WHERE annotator_id = ?1").bind(annotatorId).run();
    } else {
      await env.DB.prepare("DELETE FROM tokens WHERE token = ?1").bind(token).run();
    }
    return new Response(null, { status: 200 });
  }

  return error("Not found", 404);
}

async function handleApi(request, env) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/study/") || path.startsWith("/api/admin/study/")) return handleStudy(request, env, isAdmin);
  if (path.startsWith("/api/admin/")) return handleAdmin(request, env, path);
  if (path === "/api/clip-pairs" && request.method === "GET") {
    return serveNextPair(request, env);
  }
  if (path === "/api/annotate" && request.method === "POST") {
    return saveAnnotation(request, env);
  }
  return error("Not found", 404);
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      const origin = allowedOrigin(request, env);
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Content-Type, X-Admin-Token",
          "access-control-max-age": "86400",
          vary: "Origin",
        },
      });
    }

    try {
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname.startsWith("/api/")) {
        return addCors(await handleApi(request, env), request, env);
      }
      if (url.pathname.startsWith("/videos/")) return serveVideo(request, env);
      return env.ASSETS.fetch(request);
    } catch (caught) {
      console.error(caught);
      return addCors(error("Internal server error", 500), request, env);
    }
  },
};
