import test from 'node:test';
import assert from 'node:assert/strict';
import {PlayerTracker,KalmanAxis,sparseFlow,describe,appearanceDistance,targetRegion} from '../tracker.js';
const red=[1,0,0,0],blue=[0,1,0,0];
const person=(x,appearance=red,w=30,h=70)=>({boundingBox:{originX:x,originY:50,width:w,height:h},appearance});
test('follows a moving player and rejects a closer different uniform',()=>{
  const t=new PlayerTracker();t.select(person(100),0);
  t.advance(.14,{local:{dx:8,dy:0,reliable:true}});
  const correct=person(110),wrong=person(95,blue);
  // No geometric overlap with alternate player in this identity test.
  wrong.boundingBox.originY=125;
  assert.equal(t.match([wrong,correct],.14),correct);
  assert.equal(t.state,'tracking');
});
const step=(t,time,candidates=[],motion={})=>{t.advance(time,motion);const result=t.match(candidates,time);t.finishFrame(time);return result;};
test('missing target coasts past old limits, expires at two seconds and never auto reacquires',()=>{
  const t=new PlayerTracker();t.select(person(100),0);t.kx.v=30;
  for(const time of [.2,.4,.6,.8,1,1.2,1.4,1.6,1.8,2]){
    step(t,time);assert.equal(t.state,'tracking');assert.equal(t.bridge,true);
  }
  assert.ok(t.box.originX>150);assert.deepEqual(t.anchor,red);
  step(t,2.1);assert.equal(t.state,'lost');assert.equal(t.match([person(163)],2.2),null);
  t.select(person(163),2.2);assert.equal(t.state,'tracking');
});
test('persistent same-uniform crowd holds prediction but never accepts a lone later rival',()=>{
  const t=new PlayerTracker();t.select(person(100),0);
  for(const time of [.1,.25,.4])step(t,time,[person(94),person(106)]);
  assert.equal(t.state,'tracking');assert.equal(t.identityUnresolved,true);
  for(const time of [.6,.8,1,1.2,1.4,1.6,1.8])assert.equal(step(t,time,[person(100)]),null);
  assert.equal(t.code,'identity_ambiguous');assert.equal(t.bridge,true);
  step(t,2.1,[person(100)]);assert.equal(t.state,'lost');
});
test('moderate overlap with a distinguishable uniform preserves identity',()=>{
  const t=new PlayerTracker();t.select(person(100),0);
  const correct=person(100);assert.equal(step(t,.14,[correct,person(110,blue)]),correct);
});
test('rejected position, size and appearance are recorded without immediately stopping',()=>{
  const giant=person(-35,red,300,700);giant.boundingBox.originY=-265;
  for(const [candidate,code] of [[person(500),'position'],[giant,'size'],[person(100,blue),'appearance']]){
    const t=new PlayerTracker();t.select(person(100),0);step(t,.14,[candidate]);
    assert.equal(t.state,'tracking');assert.equal(t.bridge,true);assert.equal(t.code,code);
    const diag=t.diagnostics();assert.ok(diag.candidates[0].rejected.includes(code));assert.equal(diag.gap,.14);
    assert.equal('appearance' in diag.candidates[0].box,false);
  }
});
test('seek and discontinuity still invalidate a track immediately',()=>{
  for(const time of [-1,1]){const t=new PlayerTracker();t.select(person(100),0);t.advance(time,{});assert.equal(t.state,'lost');assert.equal(t.code,'discontinuity');}
});
test('detector starvation expires without needing another match call',()=>{
  const t=new PlayerTracker();t.select(person(100),0);
  for(const time of [.4,.8,1.2,1.6,2,2.1]){t.advance(time,{});t.finishFrame(time);}
  assert.equal(t.state,'lost');t.reset();assert.equal(t.state,'idle');
});
test('Kalman learns velocity and accepts camera translation separately',()=>{
  const k=new KalmanAxis(0);for(let i=1;i<=30;i++){k.predict(.1);k.correct(i*2);}
  assert.ok(k.v>10);const x=k.x;k.predict(.1,15);assert.ok(k.x>x+15);
});
test('sparse optical flow measures a known camera pan and rejects textureless images',()=>{
  const w=160,h=100,a=new Uint8Array(w*h),b=new Uint8Array(w*h);
  let seed=42;
  for(let i=0;i<a.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;a[i]=seed>>>24;}
  for(let y=0;y<h-2;y++)for(let x=0;x<w-4;x++)b[(y+2)*w+x+4]=a[y*w+x];
  const f=sparseFlow(a,b,w,h);assert.equal(f.reliable,true);assert.equal(f.dx,4);assert.equal(f.dy,2);
  assert.equal(sparseFlow(new Uint8Array(w*h),new Uint8Array(w*h),w,h).reliable,false);
});
test('appearance describes torso and shorts without storing image history',()=>{
  const data=new Uint8ClampedArray(40*80*4);for(let i=0;i<data.length;i+=4){data[i]=255;data[i+3]=255;}
  const desc=describe(data,40,80,{originX:-2,originY:0,width:42,height:80});
  assert.equal(desc.length,128);assert.ok(Math.abs(desc.reduce((a,b)=>a+b,0)-1)<1e-6);
  assert.equal(appearanceDistance(desc,desc),0);
});

test('recovery requires three distinct strong frames and does not count duplicate paused frames',()=>{
 const t=new PlayerTracker();t.select(person(100),0);step(t,.15);
 for(const time of [.3,.3,.3]){assert.equal(step(t,time,[person(100)]),null);assert.equal(t.recovery.count,1);}
 assert.equal(step(t,.4,[person(100)]),null);assert.equal(t.recovery.count,2);
 assert.ok(step(t,.5,[person(100)]));assert.equal(t.bridge,false);assert.equal(t.code,'confirmed');
});
test('wrong appearance flow is rejected before it can move the predicted box',()=>{
 const t=new PlayerTracker();t.select(person(100),0);
 t.advance(.15,{local:{dx:30,dy:0,reliable:true,appearance:blue}});
 assert.equal(t.box.originX,100);assert.equal(t.localReliable,false);assert.deepEqual(t.anchor,red);
 t.advance(.3,{local:{dx:5,dy:0,reliable:true,appearance:red}});
 assert.ok(t.box.originX>100);assert.equal(t.localReliable,true);
});
test('valid flow cannot extend the selected one-second confirmation deadline',()=>{
 const t=new PlayerTracker({maxGap:1});t.select(person(100),0);
 for(const time of [.2,.4,.6,.8,1,1.01])step(t,time,[],{local:{dx:1,dy:0,reliable:true,appearance:red}});
 assert.equal(t.state,'lost');assert.equal(t.match([person(106)],1.1),null);
});
test('transient crowd disables local flow, then recovers after consecutive clear observations',()=>{
 const t=new PlayerTracker();t.select(person(100),0);step(t,.1,[person(94),person(106)]);
 t.advance(.2,{local:{dx:30,dy:0,reliable:true,appearance:red}});
 assert.equal(t.localReliable,false);assert.equal(t.box.originX,100);
 for(const time of [.2,.3])assert.equal(step(t,time,[person(100)]),null);
 assert.ok(step(t,.4,[person(100)]));assert.equal(t.identityUnresolved,false);
});
test('heavy occlusion waits rather than stopping immediately and can recover',()=>{
 const t=new PlayerTracker();t.select(person(100),0);
 step(t,.15,[person(100),person(103,blue)]);assert.equal(t.state,'tracking');assert.equal(t.code,'occlusion');
 for(const time of [.3,.45])assert.equal(step(t,time,[person(100)]),null);
 assert.ok(step(t,.6,[person(100)]));assert.equal(t.bridge,false);
});
test('learns fast movement quickly, predicts through missing detection and widens search',()=>{
 const t=new PlayerTracker();t.select(person(100),0);
 for(let i=1;i<=3;i++)assert.ok(step(t,i*.1,[person(100+i*20)]));
 assert.ok(t.kx.v>170);const initialGate=t.gate;
 step(t,.5);assert.ok(t.box.originX>190);assert.ok(t.gate>initialGate);
 assert.equal(t.bridge,true);assert.equal(t.code,'no_detection');
});
test('camera translation is removed when learning player velocity',()=>{
 const t=new PlayerTracker();t.select(person(100),0);
 for(let i=1;i<=4;i++)step(t,i*.1,[person(100+i*15)],{camera:{dx:15,dy:0,reliable:true}});
 assert.ok(Math.abs(t.kx.v)<.001);
});
test('changing arm width does not alone reject an otherwise consistent player',()=>{
 const t=new PlayerTracker();t.select(person(100),0);
 assert.ok(step(t,.1,[person(85,red,60,70)]));assert.equal(t.bridge,false);
});
test('optical flow uses a velocity hint to find displacement outside the original search radius',()=>{
 const w=160,h=100,a=new Uint8Array(w*h),b=new Uint8Array(w*h);let seed=99;
 for(let i=0;i<a.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;a[i]=seed>>>24;}
 for(let y=0;y<h-4;y++)for(let x=0;x<w-20;x++)b[(y+4)*w+x+20]=a[y*w+x];
 const f=sparseFlow(a,b,w,h,null,[],{dx:18,dy:2});
 assert.equal(f.reliable,true);assert.equal(f.dx,20);assert.equal(f.dy,4);
 assert.equal(sparseFlow(a,b,w,h).reliable,false);
});
test('fresh detection is considered before expiring a stale track',()=>{
 const t=new PlayerTracker();t.select(person(100),0);t.advance(.3,{});
 t.match([person(100)],.3);t.finishFrame(.3);assert.equal(t.state,'tracking');
});
test('target crop magnifies small players, grows during gaps and stays in the frame',()=>{
 const b=person(100).boundingBox,a=targetRegion(b,768,432,0),wide=targetRegion(b,768,432,.6);
 assert.ok(a.width<768);assert.ok(wide.width>a.width);
 for(const x of [-50,0,760])for(const y of [-30,420]){
   const r=targetRegion({...b,originX:x,originY:y},768,432,.5);
   assert.ok(r.originX>=0&&r.originY>=0&&r.originX+r.width<=768&&r.originY+r.height<=432);
 }
});
