// All coordinates refer to the bounded analysis frame, never metres.
export const centerOf = b => ({ x: b.originX + b.width / 2, y: b.originY + b.height / 2 });
export function iou(a, b) {
  const w = Math.max(0, Math.min(a.originX+a.width,b.originX+b.width)-Math.max(a.originX,b.originX));
  const h = Math.max(0, Math.min(a.originY+a.height,b.originY+b.height)-Math.max(a.originY,b.originY));
  return w*h / Math.max(1,a.width*a.height+b.width*b.height-w*h);
}
export function appearanceDistance(a,b) {
  if (!a || !b || a.length !== b.length) return 1;
  return a.reduce((v,x,i)=>v+Math.abs(x-b[i]),0)/2;
}
// Separate torso/shorts colour distributions retain some spatial appearance.
// This is a small descriptor, not learned Re-ID or a player identity guarantee.
export function describe(data, width, height, b) {
  const hist = new Array(128).fill(0);
  for (let region=0;region<2;region++) {
    let n=0;
    for(let j=0;j<12;j++) for(let i=0;i<10;i++) {
      const x=Math.max(0,Math.min(width-1,Math.floor(b.originX+b.width*(.2+.6*i/10))));
      const y=Math.max(0,Math.min(height-1,Math.floor(b.originY+b.height*(region===0?.18+.34*j/12:.54+.28*j/12))));
      const p=(y*width+x)*4;
      const bin=(data[p]>>6)*16+(data[p+1]>>6)*4+(data[p+2]>>6);
      hist[region*64+bin]++; n++;
    }
    for(let k=0;k<64;k++) hist[region*64+k]/=2*n;
  }
  return hist;
}
// Constant-velocity Kalman state [position, velocity], scalar observation.
export class KalmanAxis {
  constructor(x) { this.x=x; this.v=0; this.a=25; this.b=0; this.c=100; }
  predict(dt,shift=0) {
    this.x+=this.v*dt+shift;
    this.a+=2*dt*this.b+dt*dt*this.c+4;
    this.b+=dt*this.c; this.c+=20*dt;
    return this.x;
  }
  correct(z) {
    const s=this.a+9, k=this.a/s, kv=this.b/s, residual=z-this.x;
    this.x+=k*residual; this.v+=kv*residual;
    const b=this.b;
    this.a*=1-k; this.b*=1-k; this.c-=kv*b;
  }
}
// A bounded crop makes a small selected player larger at the detector input.
export function targetRegion(box,width,height,gap=0) {
  const side=Math.min(Math.max(width,height),Math.max(128,box.height*(2.8+Math.min(1,gap)*2)));
  const rw=Math.min(width,Math.max(side,box.width*3)),rh=Math.min(height,side),c=centerOf(box);
  return {originX:Math.max(0,Math.min(width-rw,c.x-rw/2)),originY:Math.max(0,Math.min(height-rh,c.y-rh/2)),width:rw,height:rh};
}
export class PlayerTracker {
  constructor() { this.reset(); }
  reset() {
    this.state='idle';this.box=null;this.anchor=null;this.recent=null;this.reason='';
    this.time=null;this.lastDetection=null;this.lastEvidence=null;this.bridge=false;this.note='未選択';this.localReliable=false;
  }
  select(d,time) {
    this.box={...d.boundingBox};this.anchor=[...d.appearance];this.recent=[...d.appearance];
    const c=centerOf(this.box);this.kx=new KalmanAxis(c.x);this.ky=new KalmanAxis(c.y);
    this.state='tracking';this.reason='';this.time=time;this.lastDetection=time;this.lastEvidence=time;
    this.bridge=false;this.note='人物検出で確認';this.localReliable=false;
  }
  lose(reason) {if(this.state==='tracking'){this.state='lost';this.reason=reason;this.note=reason;}return null;}
  advance(time,motion) {
    if(this.state!=='tracking')return;
    const dt=time-this.time;
    if(dt<0||dt>.55)return this.lose('時間が飛びました。選手を再指定してください。');
    const old=centerOf(this.box),camera=motion?.camera;
    this.kx.predict(dt,camera?.reliable?camera.dx:0);this.ky.predict(dt,camera?.reliable?camera.dy:0);
    this.localReliable=!!motion?.local?.reliable;
    if(this.localReliable){this.kx.correct(old.x+motion.local.dx);this.ky.correct(old.y+motion.local.dy);}
    this.box.originX=this.kx.x-this.box.width/2;this.box.originY=this.ky.x-this.box.height/2;
    this.time=time;
    // Expiry is checked after this frame's detection, so a valid fresh detection
    // is not discarded before it has a chance to confirm the player.
  }
  observeAppearance(feature,time) {
    if(this.state==='tracking'&&this.localReliable&&appearanceDistance(this.anchor,feature)<.5)this.lastEvidence=time;
  }
  hold(time,reason='人物検出が一時的に抜けています') {
    const gap=time-this.lastDetection;
    // Flow must also agree with the fixed appearance. No unbounded coasting.
    if(gap>.8||time-this.lastEvidence>.28)return this.lose('対象を確認できません：'+reason+'。再指定してください。');
    this.bridge=true;this.note='検出補間中（'+gap.toFixed(1)+'秒）';return null;
  }
  finishFrame(time) {
    if(this.state==='tracking'&&time-this.lastDetection>.25)this.hold(time);
  }
  match(candidates,time) {
    if(this.state!=='tracking')return null; // Lost stays latched until an explicit tap.
    if(time-this.lastDetection>.8)return this.lose('人物検出での確認が途切れました。再指定してください。');
    const predicted=centerOf(this.box);
    const ranked=candidates.map(d=>{
      const b=d.boundingBox,c=centerOf(b);
      const spatial=Math.hypot(c.x-predicted.x,c.y-predicted.y)/Math.max(18,this.box.height*.65);
      const size=Math.abs(Math.log(Math.max(1,b.width*b.height)/(this.box.width*this.box.height)));
      const appearance=.7*appearanceDistance(this.anchor,d.appearance)+.3*appearanceDistance(this.recent,d.appearance);
      return {d,spatial,size,appearance,score:.45*spatial+.2*size+.8*appearance+.15*(1-iou(this.box,b))};
    }).filter(r=>r.spatial<1&&r.size<.85&&r.appearance<.55).sort((a,b)=>a.score-b.score);
    const best=ranked[0],second=ranked[1];
    if(!best||best.score>.85) {
      // A foreign appearance on top of the predicted player is an occlusion,
      // not a simple detector dropout. Do not transfer identity to it.
      if(candidates.some(d=>iou(this.box,d.boundingBox)>.4&&appearanceDistance(this.anchor,d.appearance)>.65))
        return this.lose('対象の位置に別の外見の選手がいます。再指定してください。');
      return this.hold(time);
    }
    if(second&&second.score-best.score<.14)return this.lose('似た選手を区別できません。再指定してください。');
    // Box overlap alone is common in basketball. Require a real identity conflict;
    // preserve clear matches across modest overlap with a different uniform.
    const conflict=candidates.some(d=>d!==best.d&&(
      (iou(d.boundingBox,best.d.boundingBox)>.28&&appearanceDistance(this.anchor,d.appearance)<.55)||
      iou(d.boundingBox,best.d.boundingBox)>.65));
    if(conflict)return this.lose('遮蔽で選手を区別できません。再指定してください。');
    this.box={...best.d.boundingBox};const c=centerOf(this.box);this.kx.correct(c.x);this.ky.correct(c.y);
    if(best.score<.35)this.recent=this.recent.map((v,i)=>.95*v+.05*best.d.appearance[i]);
    this.lastDetection=time;this.lastEvidence=time;this.bridge=false;this.note='人物検出で確認';
    return best.d;
  }
}
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)] || 0;
function patchError(a,b,w,x,y,dx,dy) {
  let error=0;
  for(let j=-2;j<=2;j++) for(let i=-2;i<=2;i++) error+=Math.abs(a[(y+j)*w+x+i]-b[(y+j+dy)*w+x+i+dx]);
  return error/25;
}
// Sparse block optical flow, bounded search; robust median rejects outliers.
// Pan/hand shake translation only. Zoom/rotation are not calibrated here.
export function sparseFlow(previous,current,w,h,box=null,excluded=[]) {
  if(!previous || previous.length!==current.length) return {dx:0,dy:0,reliable:false};
  const vectors=[];
  const region=box || {originX:12,originY:12,width:w-24,height:h-24};
  const cols=box?5:9,rows=box?5:6;
  for(let gy=0;gy<rows;gy++) for(let gx=0;gx<cols;gx++) {
    const x=Math.round(region.originX+region.width*(gx+.5)/cols), y=Math.round(region.originY+region.height*(gy+.5)/rows);
    if(x<12 || x>=w-12 || y<12 || y>=h-12) continue;
    if(!box && excluded.some(b=>x>b.originX-3&&x<b.originX+b.width+3&&y>b.originY-3&&y<b.originY+b.height+3)) continue;
    let lo=255,hi=0;
    for(let j=-2;j<=2;j++) for(let i=-2;i<=2;i++){const v=previous[(y+j)*w+x+i];lo=Math.min(lo,v);hi=Math.max(hi,v);}
    if(hi-lo<25) continue;
    let best=Infinity,second=Infinity,bx=0,by=0;
    for(let dy=-8;dy<=8;dy+=2) for(let dx=-8;dx<=8;dx+=2){const e=patchError(previous,current,w,x,y,dx,dy);if(e<best){second=best;best=e;bx=dx;by=dy;}else second=Math.min(second,e);}
    const cx=bx,cy=by;
    for(let dy=cy-1;dy<=cy+1;dy++) for(let dx=cx-1;dx<=cx+1;dx++){const e=patchError(previous,current,w,x,y,dx,dy);if(e<best){best=e;bx=dx;by=dy;}}
    if(best>28 || second-best<1.2) continue;
    // Forward/backward consistency rejects many occlusions and texture aliases.
    let reverse=Infinity,rx=0,ry=0;
    for(let dy=-by-2;dy<=-by+2;dy++) for(let dx=-bx-2;dx<=-bx+2;dx++){
      const e=patchError(current,previous,w,x+bx,y+by,dx,dy);if(e<reverse){reverse=e;rx=dx;ry=dy;}
    }
    if(Math.hypot(bx+rx,by+ry)>1.5) continue;
    vectors.push({dx:bx,dy:by});
  }
  const dx=median(vectors.map(v=>v.dx)),dy=median(vectors.map(v=>v.dy));
  const inliers=vectors.filter(v=>Math.hypot(v.dx-dx,v.dy-dy)<=2.5);
  return {dx,dy,reliable:inliers.length>=(box?4:8)&&inliers.length/Math.max(1,vectors.length)>.6,points:inliers.length};
}
