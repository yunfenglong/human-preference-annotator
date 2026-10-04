import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

class Node extends EventTarget {
  disabled=false; hidden=false; checked=false; textContent=''; style={}; dataset={};
  removeAttribute(name) { delete this[name]; }
}
const flush = async () => { for(let i=0;i<8;i++) await new Promise(setImmediate); };
async function fixture({ setup=true, fits=true }={}) {
  const nodes=Object.fromEntries(['stage','video','app','status','playA','playB','setupConfirmed','progress','judgment','chooseScreen','screens','openScreen','exitFullscreen','question','setupInstructions','fixture','setup'].map(id=>[id,new Node()]));
  nodes.setupConfirmed.checked=setup;
  const choices=['A','B','tie','uncertain','technical_failure'].map(choice=>{const node=new Node();node.dataset.choice=choice;return node;});
  const video=nodes.video;
  Object.assign(video,{hidden:true,paused:true,videoWidth:640,videoHeight:180,currentTime:0,playbackRate:1,loads:0});
  video.pause=()=>{video.paused=true;};
  video.load=()=>{video.loads++;if(video.src) queueMicrotask(()=>video.onloadedmetadata?.());};
  video.play=async()=>{video.paused=false;video.dispatchEvent(new Event('playing'));};
  const document=new EventTarget();
  Object.assign(document,{getElementById:id=>nodes[id],querySelectorAll:()=>choices,hidden:false,exitFullscreen:async()=>{document.fullscreenElement=null;document.dispatchEvent(new Event('fullscreenchange'));}});
  const window=new EventTarget();
  Object.assign(window,{document,devicePixelRatio:1,innerWidth:fits?1280:300,innerHeight:720,fullscreenCalls:0,popupCalls:0,open(){this.popupCalls++;return null;}});
  nodes.stage.requestFullscreen=async options=>{window.fullscreenCalls++;window.fullscreenOptions=options;document.fullscreenElement=nodes.stage;document.dispatchEvent(new Event('fullscreenchange'));};
  const bytes=new Uint8Array([1,2,3]);
  const sha256=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');
  let nextCalls=0;
  const fetch=async path=>({ok:true,json:async()=>path.endsWith('config')?{question:'Fixture',setup_instructions:'Confirm setup'}:path.endsWith('session')?{session_id:'s1'}:path.endsWith('respond')?{}:{trial_id:`t${++nextCalls}`,progress:{completed:nextCalls-1,total:2},task:{video:{eye_width:320,eye_height:180},stimuli:{A:{file:'/A.mp4',sha256},B:{file:'/B.mp4',sha256}}}},arrayBuffer:async()=>bytes.buffer});
  const context=vm.createContext({window,document,location:{search:'?token=fixture'},URLSearchParams,URL,Blob,fetch,crypto:webcrypto,AbortSignal,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync('frontend/study.js','utf8'),context);
  await flush();
  const finish=()=>{video.currentTime=3;video.dispatchEvent(new Event('ended'));};
  return {nodes,choices,window,document,video,context,finish};
}

test('entering fullscreen uses the study window even before setup is confirmed',async()=>{
  const {nodes,window,document,video}=await fixture({setup:false});
  await nodes.openScreen.onclick(); await flush();
  assert.equal(window.popupCalls,0);
  assert.equal(document.fullscreenElement,nodes.stage);
  assert.equal(window.fullscreenOptions.navigationUI,'hide');
  assert.equal(video.paused,true);
  assert.match(nodes.status.textContent,/confirm.*setup/i);
});

test('Play A enters fullscreen in the same document and plays verified bytes',async()=>{
  const {nodes,window,document,video}=await fixture();
  await nodes.playA.onclick(); await flush();
  assert.equal(window.popupCalls,0);
  assert.equal(document.fullscreenElement,nodes.stage);
  assert.equal(video.paused,false);
  assert.equal(nodes.app.hidden,true);
});

test('A, B and replay reuse one video and preserve the fullscreen stage',async()=>{
  const {nodes,window,document,video,finish}=await fixture();
  await nodes.playA.onclick(); await flush(); finish();
  assert.equal(nodes.app.hidden,false);
  assert.equal(nodes.playB.disabled,false);
  for(const label of ['B','A','B']) {
    await nodes[`play${label}`].onclick(); await flush();
    assert.equal(document.fullscreenElement,nodes.stage);
    assert.equal(nodes.video,video);
    assert.equal(video.paused,false);
    assert.equal(video.currentTime,0);
    finish();
  }
  assert.equal(window.fullscreenCalls,1);
  assert.equal(window.popupCalls,0);
});

test('answering and loading the next trial preserve the window and fullscreen',async()=>{
  const {nodes,choices,window,document,context,finish}=await fixture();
  await nodes.playA.onclick(); await flush(); finish();
  await nodes.playB.onclick(); await flush(); finish();
  assert.equal(choices[0].disabled,false);
  await choices[0].onclick(); await flush();
  assert.equal(vm.runInContext('trial.trial_id',context),'t2');
  assert.equal(document.fullscreenElement,nodes.stage);
  assert.equal(nodes.app.hidden,false);
  assert.equal(nodes.playB.disabled,true);
  await nodes.playA.onclick(); await flush();
  assert.equal(window.fullscreenCalls,1);
  assert.equal(window.popupCalls,0);
});

test('fullscreen rejection stays visible and never falls back to windowed video',async()=>{
  const {nodes,video}=await fixture();
  nodes.stage.requestFullscreen=async()=>{throw new Error('Permissions check failed');};
  await nodes.playA.onclick(); await flush();
  assert.match(nodes.status.textContent,/fullscreen/i);
  assert.equal(video.paused,true);
  assert.equal(nodes.app.hidden,false);
});

test('exiting fullscreen pauses and restores controls without counting interrupted playback',async()=>{
  const {nodes,document,video}=await fixture();
  await nodes.playA.onclick(); await flush();
  await document.exitFullscreen();
  assert.equal(video.paused,true);
  assert.equal(nodes.app.hidden,false);
  assert.equal(nodes.playB.disabled,true);
});

test('display size failure shows controls and preserves fullscreen for retry',async()=>{
  const {nodes,document,video}=await fixture({fits:false});
  await nodes.playA.onclick(); await flush();
  assert.match(nodes.status.textContent,/won’t fit/i);
  assert.equal(nodes.app.hidden,false);
  assert.equal(video.hidden,true);
  assert.equal(video.paused,true);
  assert.equal(document.fullscreenElement,nodes.stage);
});

test('a changed trial cancels playback waiting for fullscreen permission',async()=>{
  const {nodes,document,video,context}=await fixture();
  let resolve;
  nodes.stage.requestFullscreen=()=>new Promise(r=>{resolve=r;});
  const pending=nodes.playA.onclick();
  await vm.runInContext('next()',context);
  document.fullscreenElement=nodes.stage;
  document.dispatchEvent(new Event('fullscreenchange'));
  resolve(); await pending; await flush();
  assert.equal(video.paused,true);
  assert.equal(nodes.app.hidden,false);
});
