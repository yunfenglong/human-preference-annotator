import { validBatch } from './study-batches.js';

export async function serveVideo(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  let key;
  try {
    key = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ""));
  } catch {
    return new Response("Invalid video path", { status: 400 });
  }
  if (!key.startsWith("videos/") || key.includes("..")) {
    return new Response("Invalid video path", { status: 400 });
  }
  if (key.startsWith("videos/batches/")) {
    const match = /^videos\/batches\/([^/]+)\/(stimuli\/[a-f0-9]{16}_[AB](?:_[A-Za-z0-9-]+)*\.mp4)$/.exec(key);
    if (!match || !validBatch(match[1])) return new Response("Invalid video path", { status: 400 });
    key = `${match[1]}/${match[2]}`;
  }

  let object;
  try {
    object = request.method === "HEAD"
      ? await env.VIDEOS.head(key)
      : await env.VIDEOS.get(key, { range: request.headers });
  } catch {
    return new Response("Requested range not satisfiable", {
      status: 416,
      headers: { "accept-ranges": "bytes" },
    });
  }
  if (!object) return new Response("Video not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (!headers.has("content-type")) headers.set("content-type", "video/mp4");

  let status = 200;
  if (object.range && request.method === 'GET' && request.headers.has('range')) {
    const offset = object.range.offset ?? Math.max(0, object.size - object.range.suffix);
    const length = object.range.length ?? object.range.suffix;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    status = 206;
  } else {
    headers.set("content-length", String(object.size));
  }

  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}
