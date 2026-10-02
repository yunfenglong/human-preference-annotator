const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Node extends EventTarget {
    constructor() { super(); this.children = []; this.classList = {add(){},remove(){}}; }
    appendChild(node) { node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1); this.children.push(node); node.parentElement = this; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    replaceChildren() { this.children = []; }
}
class Video extends Node {
    constructor() { super(); this.paused = true; this.readyState = 4; this.currentTime = 0; this.error = null; }
    pause() { this.paused = true; }
    async play() { this.paused = false; this.dispatchEvent(new Event('play')); }
}
function fixture() {
    const nodes = Object.fromEntries(['videos','displayStatus','chooseDisplay','openDisplay','displayScreen','play-left','play-right','leftProgress','rightProgress'].map(id => [id,new Node()]));
    for (const side of ['left','right']) {
        const video = new Video(), wrap = new Node();
        wrap.appendChild(video); nodes.videos.appendChild(wrap); nodes[side+'Video'] = video;
    }
    const document = {getElementById: id => nodes[id],createElement:()=>new Node()};
    const window = new EventTarget();
    const ctx = vm.createContext({window,document,KeyboardEvent:Event});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../frontend/presentation.js'),'utf8')+'\nthis.Presentation = ExternalPresentation;',ctx);
    let sampling = false, collecting = false;
    const p = new ctx.Presentation({onPlayback(){},onChange(){},onClose(){},canSwitch:side=>!sampling||side===p.selected,isSampling:()=>sampling,isCollecting:()=>collecting});
    const stage = new Node();
    const popup = new EventTarget(); popup.closed = false;
    const doc = new EventTarget(); doc.getElementById = id=>id==='displayStage'?stage:new Node(); doc.querySelectorAll = ()=>[];
    popup.document = doc;
    popup.close = () => { popup.closed = true; popup.dispatchEvent(new Event('pagehide')); };
    p.popup = popup; p.screen = {label:'second screen'};
    stage.requestFullscreen = async options => { assert.equal(options.screen,p.screen); doc.fullscreenElement=stage; doc.dispatchEvent(new Event('fullscreenchange')); };
    p.connect(popup);
    const exit = () => {doc.fullscreenElement = null; doc.dispatchEvent(new Event('fullscreenchange'));};
    return {p,stage,doc,popup,nodes,exit,window,sample: (a,b=false)=>{sampling=a;collecting=b;}};
}

test('fullscreen targets the selected display and only one video plays',async()=>{
    const {p,nodes}=fixture();
    await p.play('left');
    assert.equal(p.isFullscreen(),true); assert.equal(nodes.leftVideo.paused,false); assert.equal(nodes.rightVideo.paused,true);
    nodes.rightVideo.currentTime = 8;
    await p.play('right');
    assert.equal(nodes.leftVideo.paused,true); assert.equal(nodes.rightVideo.paused,false); assert.equal(nodes.rightVideo.currentTime,0);
});

test('fullscreen rejection never falls back to windowed playback',async()=>{
    const {p,stage,nodes}=fixture(); stage.requestFullscreen=async()=>{throw new Error('Denied');};
    await p.play('left');
    assert.equal(p.canAnnotate(),false); assert.equal(nodes.leftVideo.paused,true); assert.equal(nodes.rightVideo.paused,true);
});

test('fullscreen exit pauses playback and blocks annotation until reentry',async()=>{
    const {p,nodes,exit}=fixture(); await p.play('left'); exit();
    assert.equal(nodes.leftVideo.paused,true); assert.equal(p.canAnnotate(),false);
    await p.play('right'); assert.equal(p.canAnnotate(),true);
});

test('a pair change cancels a pending fullscreen request',async()=>{
    const {p,stage,doc,nodes}=fixture(); let resolve;
    stage.requestFullscreen=()=>new Promise(r=>{resolve=r;});
    const pending=p.play('left'); p.resetPair(); doc.fullscreenElement=stage; resolve(); await pending;
    assert.equal(nodes.leftVideo.paused,true); assert.equal(p.selected,null);
});

test('attention reentry preserves sample time and waits for marks',async()=>{
    const {p,nodes,exit,sample}=fixture(); await p.play('left');
    nodes.leftVideo.currentTime=1.25; sample(true,true); exit(); await p.play('left');
    assert.equal(nodes.leftVideo.currentTime,1.25); assert.equal(nodes.leftVideo.paused,true);
    await p.play('right'); assert.equal(p.selected,'left');
    sample(true,false); await p.play('left'); assert.equal(nodes.leftVideo.paused,false); assert.equal(nodes.leftVideo.currentTime,1.25);
});

test('missing media cannot enable annotation, and closing restores both videos',async()=>{
    const {p,nodes,popup}=fixture(); await p.play('left'); nodes.leftVideo.error={code:4};
    assert.equal(p.canAnnotate(),false); popup.close();
    assert.equal(p.popup,null); assert.equal(nodes.videos.children.length,2); assert.equal(nodes.leftVideo.paused,true);
});

test('unsupported browser never opens a display or enables fullscreen',async()=>{
    const {p,nodes}=fixture(); p.popup=null; await p.chooseScreen();
    assert.match(nodes.displayStatus.textContent,/desktop Chrome/); assert.equal(p.isFullscreen(),false);
});

test('all eight feature settings select only enabled steps',()=>{
    const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../frontend/study-flow.js'),'utf8'),ctx);
    for(let mask=0;mask<8;mask++) {
        const settings={cantTell:Boolean(mask&1),surprise:Boolean(mask&2),attention:Boolean(mask&4)};
        const steps=Array.from(ctx.activeStudySteps(settings));
        assert.deepEqual(steps,[0,...(settings.surprise?[1]:[]),...(settings.attention?[2]:[])]);
        steps.forEach((step,i)=>assert.equal(ctx.nextStudyStep(settings,step),steps[i+1]??null));
    }
});
