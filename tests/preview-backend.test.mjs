import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../node_modules/wrangler/package.json', import.meta.url));
const { build } = require('esbuild');
// Bundle the same JSON catalogue imports Wrangler bundles for deployment.
const bundle = await build({entryPoints:[fileURLToPath(new URL('../worker/index.js', import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser'});
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('preview admin requests reach main with their authentication and body intact', async () => {
  const request = new Request('https://quest.example/api/admin/study/viewer-group', {
    method: 'POST', headers: {'content-type':'application/json', 'x-admin-token':'main-admin-token'},
    body: JSON.stringify({batch:'batch',viewer_id:'viewer',group_id:'R1'}),
  });
  let calls=0;
  const response = await worker.fetch(request, {MAIN_BACKEND:{async fetch(forwarded) {
    calls++;
    assert.equal(forwarded.url,request.url);
    assert.equal(forwarded.method,'POST');
    assert.equal(forwarded.headers.get('x-admin-token'),'main-admin-token');
    assert.deepEqual(await forwarded.json(),{batch:'batch',viewer_id:'viewer',group_id:'R1'});
    return new Response('main response',{status:409});
  }}});
  assert.equal(calls,1);
  assert.equal(response.status,409);
  assert.equal(await response.text(),'main response');
});

test('preview media preserves byte ranges and streaming response metadata', async () => {
  const response=await worker.fetch(new Request('https://quest.example/videos/batch/stimuli/clip.mp4',{
    headers:{Range:'bytes=0-99'},
  }),{MAIN_BACKEND:{async fetch(request) {
    assert.equal(request.headers.get('Range'),'bytes=0-99');
    return new Response(new Uint8Array(100),{status:206,headers:{'content-range':'bytes 0-99/1000','content-type':'video/mp4'}});
  }}});
  assert.equal(response.status,206);
  assert.equal(response.headers.get('content-range'),'bytes 0-99/1000');
  assert.equal((await response.arrayBuffer()).byteLength,100);
});

test('main handles preview CORS and health while preview assets remain local', async () => {
  const env={MAIN_BACKEND:{async fetch(request){
    return new Response(request.method==='OPTIONS'?null:'main health',{
      status:request.method==='OPTIONS'?204:200,headers:{'access-control-allow-origin':'https://quest.example'},
    });
  }},ASSETS:{async fetch(){return new Response('Quest frontend');}}};
  const preflight=await worker.fetch(new Request('https://quest.example/api/study/config',{method:'OPTIONS',headers:{Origin:'https://quest.example'}}),env);
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),'https://quest.example');
  assert.equal(await (await worker.fetch(new Request('https://quest.example/healthz'),env)).text(),'main health');
  assert.equal(await (await worker.fetch(new Request('https://quest.example/study.js'),env)).text(),'Quest frontend');
});

test('preview backend failure does not fall back to a separate local database', async () => {
  await assert.rejects(worker.fetch(new Request('https://quest.example/api/study/config'),{
    MAIN_BACKEND:{async fetch(){throw new Error('Main unavailable');}},
    DB:{prepare(){throw new Error('Unexpected local database access');}},
  }),/Main unavailable/);
});
