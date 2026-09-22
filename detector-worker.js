// Classic Worker intentionally: MediaPipe's WASM loader uses importScripts.
let detector, tracker, motionTracker, describe, aiBase, frame, frameCtx, small, smallCtx, crop, cropCtx, targetRegion, trackingIou;
let candidates=[], displayCandidates=[], lastDetection=-Infinity, lastTime=-Infinity;
let lastStamp=0,detectionSerial=0,backend='CPU';
function clear() {tracker.reset();motionTracker?.reset();candidates=[];displayCandidates=[];lastDetection=-Infinity;lastTime=-Infinity;detectionSerial=0;}
function reply(type,extra={}) {self.postMessage({type,...extra});}
self.onmessage=async ({data:m})=>{
  if(m.type==='init') {
    try {
      const [config,tracking,motion]=await Promise.all([import('./ai-config.js'),import('./tracker.js'),import('./motion.js')]);
      aiBase=config.AI_BASE; motionTracker=new motion.FeatureMotion();describe=tracking.describe;targetRegion=tracking.targetRegion;trackingIou=tracking.iou;
      tracker=new tracking.PlayerTracker();
      const {FilesetResolver,ObjectDetector}=await import(`${aiBase}/vision_bundle.mjs`);
      const vision=await FilesetResolver.forVisionTasks(`${aiBase}/wasm`);
      // Prefer a working GPU delegate, with a warm-up and CPU fallback.
      let initError;
      for(const delegate of ['GPU','CPU']){
        try {
          const inferenceCanvas=new OffscreenCanvas(1,1);
          if(!inferenceCanvas.getContext('webgl2'))throw new Error('このブラウザではAIに必要なWebGL 2を利用できません。AndroidのChromeで開いてください。');
          detector=await ObjectDetector.createFromOptions(vision,{
            canvas:inferenceCanvas,baseOptions:{modelAssetPath:config.MODEL_URL,delegate},runningMode:'VIDEO',
            categoryAllowlist:['person'],scoreThreshold:.18,maxResults:40,
          });
          lastStamp=Math.max(lastStamp+1,performance.now());
          detector.detectForVideo(new ImageData(32,32),lastStamp);backend=delegate;initError=null;break;
        }catch(e){initError=e;try{detector?.close();}catch{}detector=null;}
      }
      if(initError)throw initError;
      frame=new OffscreenCanvas(1,1);frameCtx=frame.getContext('2d',{willReadFrequently:true});
      crop=new OffscreenCanvas(320,320);cropCtx=crop.getContext('2d');
      small=new OffscreenCanvas(640,360);smallCtx=small.getContext('2d',{willReadFrequently:true});
      reply('ready',{backend});
    } catch(e) {reply('error',{message:String(e.message||e)});}
    return;
  }
  if(!detector) {m.bitmap?.close(); return;}
  if(m.type==='reset') {clear();return;}
  if(m.type==='select') {
    const candidate=displayCandidates[m.index];
    if(candidate) {tracker.select(candidate,m.time);const ratio=small.width/frame.width;const scale=b=>({originX:b.originX*ratio,originY:b.originY*ratio,width:b.width*ratio,height:b.height*ratio});motionTracker.seed(scale(candidate.boundingBox),m.time,candidates.filter(d=>d!==candidate&&d.score>=.35).map(d=>scale(d.boundingBox))); reply('selected',{epoch:m.epoch,box:tracker.box});}
    return;
  }
  if(m.type!=='frame') return;
  const start=performance.now();
  tracker.maxGap=Math.max(1,Math.min(3,Number(m.holdSeconds)||2));
  try {
    if(frame.width!==m.bitmap.width||frame.height!==m.bitmap.height) {
      frame.width=m.bitmap.width;frame.height=m.bitmap.height;clear();
      small.width=Math.min(640,frame.width);small.height=Math.max(1,Math.round(frame.height*small.width/frame.width));
    }
    frameCtx.drawImage(m.bitmap,0,0);m.bitmap.close();
    const w=frame.width,h=frame.height,fw=small.width,fh=small.height,ratio=fw/w;
    smallCtx.drawImage(frame,0,0,fw,fh);
    const rgba=smallCtx.getImageData(0,0,fw,fh).data,gray=new Uint8Array(fw*fh);
    for(let i=0;i<gray.length;i++) gray[i]=(rgba[i*4]*77+rgba[i*4+1]*150+rgba[i*4+2]*29)>>8;
    const scale=b=>({originX:b.originX*ratio,originY:b.originY*ratio,width:b.width*ratio,height:b.height*ratio});
    const flowStart=performance.now();
    const motion=motionTracker.update(gray,fw,fh,m.time,tracker.state==='tracking'?scale(tracker.box):null,candidates.filter(d=>d.score>=.35).map(d=>scale(d.boundingBox)));
    if(tracker.state==='tracking'&&m.time!==lastTime){
      if(motion.camera.reliable){
        const c={x:(tracker.box.originX+tracker.box.width/2)*ratio,y:(tracker.box.originY+tracker.box.height/2)*ratio};
        motion.camera.dx=((motion.camera.a-1)*c.x-motion.camera.b*c.y+motion.camera.tx)/ratio;
        motion.camera.dy=(motion.camera.b*c.x+(motion.camera.a-1)*c.y+motion.camera.ty)/ratio;
      }
      motion.local.dx/=ratio;motion.local.dy/=ratio;
      const proposal={...tracker.box,originX:tracker.box.originX+motion.local.dx,originY:tracker.box.originY+motion.local.dy};
      motion.local.appearance=describe(rgba,fw,fh,scale(proposal));tracker.advance(m.time,motion);
    }
    const flowMs=performance.now()-flowStart;let inferenceMs=0;
    const detected=m.force || m.time-lastDetection>=1/m.fps-1e-6 || m.time<lastDetection;
    let search='flow';
    if(detected) {
      detectionSerial++;
      lastStamp=Math.max(lastStamp+1,performance.now());
      // Exactly one inference: selected-player crop, or full frame while selecting.
      const wideSearch=tracker.bridge&&m.time-tracker.lastDetection>.4&&detectionSerial%3===0;
      const region=tracker.state==='tracking'&&(!m.force||m.sequence)&&!wideSearch?targetRegion(tracker.box,w,h,m.time-tracker.lastDetection,tracker.gate*.4):null;
      search=region?'周辺拡大':'全画面';
      let input=frame;
      if(region){
        crop.width=320;crop.height=Math.max(1,Math.round(320*region.height/region.width));
        cropCtx.drawImage(frame,region.originX,region.originY,region.width,region.height,0,0,crop.width,crop.height);input=crop;
      }
      const inferenceStart=performance.now(),result=detector.detectForVideo(input,lastStamp);inferenceMs=performance.now()-inferenceStart;
      const pixels=frameCtx.getImageData(0,0,w,h).data;
      candidates=result.detections.filter(d=>d.categories?.[0]?.categoryName==='person').map(d=>({
        boundingBox:region?{originX:region.originX+d.boundingBox.originX*region.width/crop.width,
          originY:region.originY+d.boundingBox.originY*region.height/crop.height,
          width:d.boundingBox.width*region.width/crop.width,height:d.boundingBox.height*region.height/crop.height}:d.boundingBox,
        score:d.categories[0].score,
      }));
      candidates=candidates.filter(d=>d.boundingBox.width>0&&d.boundingBox.height>0);
      for(const d of candidates)d.appearance=describe(pixels,w,h,d.boundingBox);
      const supports=motionTracker.support(candidates,ratio);candidates.forEach((d,i)=>d.flowSupport=supports[i]);
      if(tracker.state==='tracking'){
        const matched=tracker.match(candidates,m.time);
        const overlaps=matched&&candidates.some(d=>d!==matched&&d.score>=.35&&trackingIou(d.boundingBox,matched.boundingBox)>.2);
        if(matched&&matched.score>=.35&&!overlaps&&(!motionTracker.chain||m.time-motionTracker.seedTime>.7))motionTracker.seed(scale(matched.boundingBox),m.time,candidates.filter(d=>d!==matched&&d.score>=.35).map(d=>scale(d.boundingBox)));
      }
      displayCandidates=candidates.filter(d=>d.score>=.35);
      lastDetection=m.time;
    }
    tracker.finishFrame(m.time);
    lastTime=m.time;
    reply('result',{epoch:m.epoch,sequence:!!m.sequence,time:m.time,width:w,height:h,detected,
      detections:displayCandidates.map(d=>({boundingBox:d.boundingBox,score:d.score})),
      box:tracker.box,state:tracker.state,reason:tracker.reason,bridge:tracker.bridge,visual:tracker.visual,note:tracker.note,
      diagnostic:{...tracker.diagnostics(),backend,flowMs,inferenceMs,features:motion.local.points,search,camera:motion.camera?{dx:motion.camera.dx,dy:motion.camera.dy,reliable:motion.camera.reliable}:null},
      camera:motion.camera?.reliable?`背景補正 ×${motion.camera.scale.toFixed(3)}`:'補正未確定',ms:performance.now()-start,
    });
  } catch(e) {m.bitmap.close();reply('error',{epoch:m.epoch,message:String(e.message||e)});}
};
