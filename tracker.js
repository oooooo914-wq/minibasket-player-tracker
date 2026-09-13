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
export function targetRegion(box,width,height,gap=0,margin=0) {
  const side=Math.min(Math.max(width,height),Math.max(128,box.height*(2.8+Math.min(3,gap)*2)+margin*2));
  const rw=Math.min(width,Math.max(side,box.width*3)),rh=Math.min(height,side),c=centerOf(box);
  return {originX:Math.max(0,Math.min(width-rw,c.x-rw/2)),originY:Math.max(0,Math.min(height-rh,c.y-rh/2)),width:rw,height:rh};
}
export const HOLD_REASONS={
  no_detection:'人物検出なし',score:'総合条件を満たさない',position:'予測位置から遠い',appearance:'外見の差が大きい',size:'枠の形が大きく変化',
  ambiguity:'似た候補が競合',occlusion:'遮蔽の疑い',recovery:'候補を連続確認中',gap:'確認が途切れた',
  identity_ambiguous:'密集後の本人を区別できない',discontinuity:'動画時間の飛び',confirmed:'人物検出で確認',
};
export class PlayerTracker {
  constructor({maxGap=2}={}){this.maxGap=maxGap;this.reset();}
  reset(){
    this.state='idle';this.box=null;this.anchor=null;this.recent=null;this.reason='';
    this.time=null;this.lastDetection=null;this.bridge=false;this.note='未選択';this.code='idle';
    this.localReliable=false;this.ambiguitySince=null;this.recovery=null;this.identityUnresolved=false;this.gate=0;this.ranking=[];
    this.cameraSum={x:0,y:0};this.lastAccepted=null;this.lastDt=0;
  }
  select(d,time){
    this.reset();this.box={...d.boundingBox};this.anchor=[...d.appearance];this.recent=[...d.appearance];
    const c=centerOf(this.box);this.kx=new KalmanAxis(c.x);this.ky=new KalmanAxis(c.y);
    this.state='tracking';this.time=time;this.lastDetection=time;this.lastAccepted={...c,time};
    this.code='confirmed';this.note=HOLD_REASONS.confirmed;
  }
  lose(reason,code=this.code){
    if(this.state==='tracking'){this.state='lost';this.reason=reason;this.note=reason;this.code=code;}
    return null;
  }
  advance(time,motion){
    if(this.state!=='tracking')return;
    const dt=time-this.time;
    if(dt<0||dt>.55)return this.lose('動画時間が飛びました。再指定してください。','discontinuity');
    this.lastDt=dt;
    const camera=motion?.camera,old=centerOf(this.box);
    const dx=camera?.reliable?camera.dx:0,dy=camera?.reliable?camera.dy:0;
    this.cameraSum.x+=dx;this.cameraSum.y+=dy;
    this.kx.predict(dt,dx);this.ky.predict(dt,dy);
    // Validate the proposed flow patch BEFORE applying it. A crowd's flow must
    // not move our box onto a rival and then contaminate the appearance anchor.
    this.localReliable=!!motion?.local?.reliable&&!this.identityUnresolved&&!['ambiguity','occlusion'].includes(this.code)&&
      appearanceDistance(this.anchor,motion.local.appearance)<.5;
    if(this.localReliable){this.kx.correct(old.x+motion.local.dx);this.ky.correct(old.y+motion.local.dy);}
    this.box.originX=this.kx.x-this.box.width/2;this.box.originY=this.ky.x-this.box.height/2;this.time=time;
  }
  hold(time,code='gap'){
    if(this.state!=='tracking')return null;
    this.bridge=true;this.code=this.identityUnresolved?'identity_ambiguous':code;
    const gap=Math.max(0,time-this.lastDetection),label=HOLD_REASONS[this.code]||this.code;
    if(gap>this.maxGap)return this.lose(`${this.maxGap}秒確認できませんでした（${label}）。再指定してください。`);
    this.note=`予測保留 ${gap.toFixed(1)} / ${this.maxGap}秒：${label}`;return null;
  }
  finishFrame(time){
    if(this.state==='tracking'&&(this.bridge||time-this.lastDetection>.3))this.hold(time,this.code==='confirmed'?'gap':this.code);
  }
  match(candidates,time){
    if(this.state!=='tracking')return null;
    if(time-this.lastDetection>this.maxGap)return this.hold(time,this.code);
    const predicted=centerOf(this.box),gap=Math.max(0,time-this.lastDetection),speed=Math.hypot(this.kx.v,this.ky.v);
    // Velocity + uncertainty determine the search gate, rather than one fixed
    // fraction of a small player's height. Shape relies more on height than arms.
    const uncertainty=Math.min(this.box.height*1.5,Math.sqrt(this.kx.a+this.ky.a)+speed*gap*.25);
    this.gate=Math.min(this.box.height*3,Math.max(18,this.box.height*.6)+speed*this.lastDt+uncertainty);
    const scored=candidates.map((d,index)=>{
      const b=d.boundingBox,c=centerOf(b),spatial=Math.hypot(c.x-predicted.x,c.y-predicted.y)/this.gate;
      const size=.7*Math.abs(Math.log(b.height/this.box.height))+.3*Math.abs(Math.log(b.width/this.box.width));
      const appearance=.7*appearanceDistance(this.anchor,d.appearance)+.3*appearanceDistance(this.recent,d.appearance);
      const rejected=[];if(spatial>1)rejected.push('position');if(size>1.1)rejected.push('size');if(appearance>.6)rejected.push('appearance');
      return {d,index,spatial,size,appearance,rejected,score:.45*spatial+.15*size+.75*appearance+.08*(1-iou(this.box,b))};
    }).sort((a,b)=>a.score-b.score);
    this.ranking=scored.slice(0,3).map(({d,index,spatial,size,appearance,rejected,score})=>({index,box:{...d.boundingBox},confidence:d.score??null,spatial,size,appearance,rejected,score}));
    const ranked=scored.filter(r=>!r.rejected.length),best=ranked[0],second=ranked[1];
    if(!best||best.score>.9){
      this.recovery=null;
      return this.hold(time,!candidates.length?'no_detection':scored[0]?.rejected[0]||'score');
    }
    const similarOverlap=candidates.some(d=>d!==best.d&&iou(d.boundingBox,best.d.boundingBox)>.28&&appearanceDistance(this.anchor,d.appearance)<.55);
    if((second&&second.score-best.score<.14)||similarOverlap){
      // Once identical-looking candidates overlap persistently, a lone later detection
      // is not sufficient proof of identity. Keep the prediction visible, but
      // require the user to resolve that identity conflict rather than swapping.
      this.ambiguitySince??=time;
      if(time-this.ambiguitySince>=.25)this.identityUnresolved=true;
      this.recovery=null;return this.hold(time,'ambiguity');
    }
    this.ambiguitySince=null;
    if(candidates.some(d=>d!==best.d&&iou(d.boundingBox,best.d.boundingBox)>.65)){
      this.recovery=null;return this.hold(time,'occlusion');
    }
    if(this.identityUnresolved)return this.hold(time,'identity_ambiguous');
    if(this.bridge){
      const dt=time-(this.recovery?.time??time),c=centerOf(best.d.boundingBox);
      const consistent=this.recovery&&dt>0&&dt<.4&&Math.hypot(c.x-this.recovery.x,c.y-this.recovery.y)<Math.max(12,this.box.height*.6)+speed*dt;
      // Recovery needs three distinct timestamps, a clear margin and strong
      // appearance. Neither duplicate paused frames nor coasting count as proof.
      const strong=best.appearance<.42&&best.spatial<.8&&(!second||second.score-best.score>.22);
      if(!strong){this.recovery=null;return this.hold(time,'recovery');}
      if(!this.recovery||dt>0)this.recovery={...c,time,count:consistent?this.recovery.count+1:1,start:consistent?this.recovery.start:time};
      if(this.recovery.count<3||time-this.recovery.start<.18)return this.hold(time,'recovery');
    }
    const c=centerOf(best.d.boundingBox),dt=time-this.lastAccepted.time;
    if(dt>.02&&!this.bridge){
      const cap=this.box.height*8;
      const vx=Math.max(-cap,Math.min(cap,(c.x-this.lastAccepted.x-this.cameraSum.x)/dt));
      const vy=Math.max(-cap,Math.min(cap,(c.y-this.lastAccepted.y-this.cameraSum.y)/dt));
      this.kx.v=.45*this.kx.v+.55*vx;this.ky.v=.45*this.ky.v+.55*vy;
    }
    this.kx.correct(c.x);this.ky.correct(c.y);this.kx.x=c.x;this.ky.x=c.y;this.box={...best.d.boundingBox};
    if(best.score<.3)this.recent=this.recent.map((v,i)=>.96*v+.04*best.d.appearance[i]);
    this.lastDetection=time;this.lastAccepted={...c,time};this.cameraSum={x:0,y:0};
    this.bridge=false;this.recovery=null;this.code='confirmed';this.note=HOLD_REASONS.confirmed;return best.d;
  }
  diagnostics(){
    return {code:this.code,label:HOLD_REASONS[this.code]||this.code,pending:this.bridge,
      gap:this.lastDetection===null?0:Math.max(0,this.time-this.lastDetection),maxGap:this.maxGap,
      box:this.box?{...this.box}:null,speed:this.kx?Math.hypot(this.kx.v,this.ky.v):0,gate:this.gate,flowUsed:this.localReliable,
      identityUnresolved:this.identityUnresolved,recoveryCount:this.recovery?.count||0,candidates:this.ranking};
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
export function sparseFlow(previous,current,w,h,box=null,excluded=[],hint={dx:0,dy:0}) {
  if(!previous || previous.length!==current.length) return {dx:0,dy:0,reliable:false};
  const vectors=[];
  const hx=Math.round(Math.max(-w/4,Math.min(w/4,hint.dx||0))),hy=Math.round(Math.max(-h/4,Math.min(h/4,hint.dy||0)));
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
    for(let dy=hy-8;dy<=hy+8;dy+=2) for(let dx=hx-8;dx<=hx+8;dx+=2){if(x+dx<3||x+dx>=w-3||y+dy<3||y+dy>=h-3)continue;const e=patchError(previous,current,w,x,y,dx,dy);if(e<best){second=best;best=e;bx=dx;by=dy;}else second=Math.min(second,e);}
    const cx=bx,cy=by;
    for(let dy=cy-1;dy<=cy+1;dy++) for(let dx=cx-1;dx<=cx+1;dx++){if(x+dx<3||x+dx>=w-3||y+dy<3||y+dy>=h-3)continue;const e=patchError(previous,current,w,x,y,dx,dy);if(e<best){best=e;bx=dx;by=dy;}}
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
