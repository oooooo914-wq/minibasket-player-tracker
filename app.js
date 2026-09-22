// Extends the original vanilla JS / MediaPipe / canvas MVP.
const $ = id => document.getElementById(id);
const videoInput=$('videoInput'),video=$('video'),overlay=$('overlay'),ctx=overlay.getContext('2d');
const loadAiBtn=$('loadAiBtn'),resetBtn=$('resetBtn'),statusEl=$('status');
const aiInfo=$('aiInfo'),detectInfo=$('detectInfo'),targetInfo=$('targetInfo');
let worker=null,ready=false,initializing=null,epoch=0,busy=false,frameTimer=null,initTimer=null;
let detections=[],target=null,trail=[],state='idle',objectUrl=null,lastVideoTime=-1,lastSent=0;
let analysisWidth=768,analysisHeight=432,rafId=null,selectionTime=-1,selectable=false;
let processingMs=0,lastFrameWall=0,detectionCount=0,rateStart=0,pendingForce=false,installPrompt=null;
let visualTracking=false,bridging=false,waitingWorker=null,reloadForUpdate=false;
let sequenceRunning=false,sequenceSeek=null,sequenceTimer=null;
let lastLostTime=null;
let latestDiagnostic=null,diagnosticRecords=[],diagnosticCounts={};
function recordDiagnostic(event,details={}){
  const row={event,videoTime:Number((video.currentTime||0).toFixed(3)),...details};
  diagnosticRecords.push(row);if(diagnosticRecords.length>1000)diagnosticRecords.shift();
  if(event==='analysis'&&details.code&&!['confirmed','flow','weak_detection'].includes(details.code))diagnosticCounts[details.code]=(diagnosticCounts[details.code]||0)+1;
  const labels={flow:'画像追跡',weak_detection:'弱い検出',low_confidence:'弱い検出の棄却',score:'総合条件',no_detection:'検出なし',position:'位置差',appearance:'外見差',size:'枠の変化',ambiguity:'候補競合',occlusion:'遮蔽',identity_ambiguous:'本人不明',recovery:'再確認',gap:'確認抜け'};
  const summary=Object.entries(diagnosticCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,n])=>`${labels[k]||k} ${n}回`).join(' / ');
  $('diagnosticInfo').textContent=`記録 ${diagnosticRecords.length}件${summary?'：'+summary:''}`;
}
function diagnosticJson(){
  const report={schema:1,appVersion:'0.6',description:'判定ログ。原因の推定であり、実際の本人確認の正誤は保証しません。動画・画像・ファイル名は含みません。',
    settings:{mode:$('analysisMode').value,detectFps:Number($('detectFps').value),holdSeconds:Number($('holdSeconds').value)||2},
    frameSize:{width:analysisWidth,height:analysisHeight},counts:diagnosticCounts,records:diagnosticRecords};
  return JSON.stringify(report,null,2);
}
$('showDiagnosticBtn').addEventListener('click',()=>{
  const output=$('diagnosticText');output.value=diagnosticJson();output.hidden=false;
});
$('exportDiagnosticBtn').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([diagnosticJson()],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='minibasket-diagnostic-0.6.json';document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
const isRunning=()=>sequenceRunning||!video.paused;
function stopSequence(){sequenceRunning=false;clearTimeout(sequenceTimer);sequenceTimer=null;}
function advanceSequence(ms=0){
  if(!sequenceRunning||busy||document.hidden||state!=='tracking')return;
  if(video.currentTime>=(video.duration||0)-.005){stopSequence();updatePlayback();setStatus('この区間の追跡が終わりました。');return;}
  const step=1/Math.min(15,Number($('detectFps').value)*2);
  const delay=Math.max(0,1000*step/Number($('speed').value)-ms);
  clearTimeout(sequenceTimer);
  sequenceTimer=setTimeout(()=>{
    sequenceTimer=null;
    if(!sequenceRunning||busy||document.hidden||state!=='tracking')return;
    sequenceSeek=Math.min(video.duration-.001,video.currentTime+step);
    video.currentTime=sequenceSeek;
  },delay);
}
function pausePlayback(){stopSequence();video.pause();updatePlayback();requestFrame(true);}

const capture=document.createElement('canvas');
const captureCtx=capture.getContext('2d');
function setStatus(text) {statusEl.textContent=text;statusEl.classList.toggle('warning',state==='lost');}
function syncCanvas() {
  const rect=video.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1);
  const width=Math.max(1,Math.round(rect.width*dpr)),height=Math.max(1,Math.round(rect.height*dpr));
  if(overlay.width!==width||overlay.height!==height){overlay.width=width;overlay.height=height;}
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
function videoToScreen(box) {
  const rect=video.getBoundingClientRect(),sx=rect.width/analysisWidth,sy=rect.height/analysisHeight;
  return {x:box.originX*sx,y:box.originY*sy,width:box.width*sx,height:box.height*sy};
}
function draw() {
  syncCanvas();const rect=video.getBoundingClientRect();ctx.clearRect(0,0,rect.width,rect.height);
  // A short screen-coordinate trail, explicitly not a court path or distance.
  const visible=trail.filter(p=>p.time>=video.currentTime-8);
  if(visible.length>1) {
    ctx.beginPath();visible.forEach((p,i)=>{const s=videoToScreen({originX:p.x,originY:p.y,width:0,height:0});
      if(i===0)ctx.moveTo(s.x,s.y);else ctx.lineTo(s.x,s.y);});ctx.lineWidth=2;ctx.strokeStyle='#fbbf24';ctx.stroke();
  }
  if(video.paused&&!sequenceRunning) detections.forEach((d,i)=>{
    const b=videoToScreen(d.boundingBox);ctx.strokeStyle='#60a5fa';ctx.lineWidth=2;ctx.strokeRect(b.x,b.y,b.width,b.height);
    ctx.fillStyle='#172554';ctx.fillRect(b.x,b.y,56,22);ctx.fillStyle='#fff';ctx.font='bold 12px system-ui';ctx.fillText('候補'+(i+1),b.x+3,b.y+16);
  });
  if(target&&state==='tracking') {
    const b=videoToScreen(target);ctx.setLineDash(bridging?[6,4]:[]);ctx.strokeStyle=bridging?'#fbbf24':visualTracking?'#22d3ee':'#4ade80';ctx.lineWidth=3;ctx.strokeRect(b.x,b.y,b.width,b.height);
    ctx.setLineDash([]);ctx.fillStyle=bridging?'#fbbf24':visualTracking?'#22d3ee':'#4ade80';ctx.font='bold 13px system-ui';
    ctx.fillText(bridging?'対象の予測・未確認':visualTracking?'対象・画像追跡':'対象',Math.max(0,b.x),Math.max(15,b.y-5));
    if(!bridging){ctx.beginPath();ctx.arc(b.x+b.width/2,b.y+b.height,5,0,Math.PI*2);ctx.fill();}
    if(bridging&&latestDiagnostic?.gate){
      const gate=latestDiagnostic.gate,search=videoToScreen({originX:target.originX+target.width/2-gate,originY:target.originY+target.height/2-gate,width:gate*2,height:gate*2});
      ctx.setLineDash([2,6]);ctx.lineWidth=1;ctx.strokeRect(search.x,search.y,search.width,search.height);ctx.setLineDash([]);
    }
  }
}
function updateTime() {
  const format=t=>`${Math.floor((t||0)/60)}:${String(Math.floor((t||0)%60)).padStart(2,'0')}`;
  $('timeInfo').textContent=`${format(video.currentTime)} / ${format(video.duration)}`;
  if(!$('seek').matches(':active')) $('seek').value=video.currentTime||0;
}
function updateLiveRate(){
  const requested=Number($('speed').value)||1;
  const capacity=processingMs?1000/(Math.min(10,Number($('detectFps').value)||7)*processingMs*1.3):requested;
  video.playbackRate=$('analysisMode').value==='realtime'&&ready&&state==='tracking'?Math.max(.1,Math.min(requested,capacity)):requested;
  $('playbackInfo').textContent=`${video.playbackRate.toFixed(2)}倍${video.playbackRate<requested-.02?'（端末に合わせて調整）':''}`;
}
function updatePlayback() {$('playBtn').textContent=isRunning()?'❚❚ 一時停止':'▶ 再生';updateTime();draw();}
function clearTracking(message='停止して、青い枠の選手をタップしてください。') {
  stopSequence();sequenceSeek=null;epoch++;worker?.postMessage({type:'reset'});state='idle';target=null;trail=[];detections=[];
  bridging=false;visualTracking=false;latestDiagnostic=null;$('skipLostBtn').hidden=true;$('trackingInfo').textContent='未選択';recordDiagnostic('reset');
  selectable=false;lastVideoTime=-1;targetInfo.textContent='未選択';detectInfo.textContent='0人';
  $('playerChoices').replaceChildren();setStatus(message);draw();
}
function lose(message) {
  if(state==='lost') return;
  lastLostTime=video.currentTime;$('skipLostBtn').hidden=false;$('reviewLostBtn').hidden=false;
  recordDiagnostic('stop',{reason:message,diagnostic:latestDiagnostic});stopSequence();state='lost';target=null;trail=[];targetInfo.textContent='再指定が必要';$('stopInfo').textContent=message;video.pause();
  setStatus(message);updatePlayback();if(video.paused)requestFrame(true);
}
function failAi(message) {
  const wasTracking=state==='tracking';stopSequence();worker?.terminate();worker=null;ready=false;busy=false;
  clearTimeout(frameTimer);clearTimeout(initTimer);loadAiBtn.disabled=false;aiInfo.textContent='読込・実行エラー';
  if(wasTracking) lose('AIが停止しました。再準備後に選手を再指定してください。');
  video.pause();setStatus(`AIを準備できませんでした。「AIを準備」で再試行してください。${message}`);
}
async function initDetector() {
  if(ready) {requestFrame(true);return;}
  if(initializing) return initializing;
  loadAiBtn.disabled=true;aiInfo.textContent='読込中';setStatus('AIを準備しています。初回は通信が必要です…');
  initializing=new Promise(resolve=>{
    if(!window.Worker||!window.OffscreenCanvas||!window.createImageBitmap) {
      failAi('AndroidのChromeを更新してください。');resolve();return;
    }
    worker=new Worker(new URL('./detector-worker.js',import.meta.url));
    initTimer=setTimeout(()=>{failAi('通信状態を確認してください。');resolve();},90000);
    worker.onerror=()=>{failAi('通信状態とブラウザを確認してください。');resolve();};
    worker.onmessage=({data:m})=>{
      if(m.type==='ready') {
        clearTimeout(initTimer);ready=true;loadAiBtn.disabled=false;aiInfo.textContent=`準備完了（端末内・${m.backend||'CPU'}）`;
        setStatus(video.src?'停止して、青い枠の選手をタップしてください。':'動画を選んでください。');
        resolve();requestFrame(true);return;
      }
      if(m.type==='error') {failAi(m.message);resolve();return;}
      if(m.type==='selected') {
        if(m.epoch!==epoch)return;
        recordDiagnostic('select',{box:m.box});$('skipLostBtn').hidden=true;
        target=m.box;state='tracking';bridging=false;trail=[];targetInfo.textContent='選択済み';$('trackingInfo').textContent='人物検出で確認';
        setStatus('緑の枠を確認し、再生してください。違う場合は停止して選び直せます。');draw();return;
      }
      if(m.type!=='result')return;
      busy=false;clearTimeout(frameTimer);
      if(m.epoch!==epoch) {if(pendingForce)requestFrame(true);return;}
      const wasBridging=bridging;
      if(m.diagnostic){
        latestDiagnostic=m.diagnostic;
        if(m.detected&&state!=='idle'&&state!=='lost')recordDiagnostic('analysis',{frameTime:m.time,lag:video.currentTime-m.time,ms:m.ms,sequence:!!m.sequence,...m.diagnostic});
      }
      processingMs=processingMs ? .8*processingMs+.2*m.ms : m.ms;updateLiveRate();
      if(video.currentTime-m.time>.35 && !video.paused) {
        if(state==='tracking')lose('処理が動画に追いつきません。再生速度を下げ、選手を再指定してください。');
        requestFrame(true);return;
      }
      analysisWidth=m.width;analysisHeight=m.height;
      detections=m.detections;selectionTime=m.time;selectable=video.paused&&!sequenceRunning&&Math.abs(video.currentTime-m.time)<.08;
      detectInfo.textContent=`${detections.length}人`;target=m.box;
      if(m.state==='lost')lose(m.reason);
      else if(state!=='lost')state=m.state;
      bridging=!!m.bridge;visualTracking=!!m.visual;
      if(state!=='lost')$('trackingInfo').textContent=m.note||'人物検出で確認';
      if(state==='tracking') {
        targetInfo.textContent=bridging?'予測保留（未確認）':visualTracking?'画像の動きで追跡中':'追跡中';const b=m.box;
        if(bridging||wasBridging)trail=[];
        if(b&&!bridging)trail.push({x:b.originX+b.width/2,y:b.originY+b.height,time:m.time});
        if(trail.length>600)trail.splice(0,trail.length-600);
      }
      if(m.detected)detectionCount++;
      const now=performance.now();if(!rateStart)rateStart=now;
      if(now-rateStart>1500){$('fpsInfo').textContent=`${(detectionCount*1000/(now-rateStart)).toFixed(1)} 回/秒 · ${Math.round(m.ms)} ms`;rateStart=now;detectionCount=0;}
      $('cameraInfo').textContent=m.camera;
      renderChoices();draw();
      if(pendingForce)requestFrame(true);
      else if(sequenceRunning&&m.sequence)advanceSequence(m.ms);
    };
    worker.postMessage({type:'init'});
  });
  try {await initializing;} catch(e) {failAi(e.message);} finally {initializing=null;}
}
function renderChoices() {
  const root=$('playerChoices');root.replaceChildren();
  if(isRunning()||!selectable)return;
  detections.forEach((_,i)=>{const b=document.createElement('button');b.type='button';b.textContent='候補 '+(i+1);
    b.setAttribute('aria-label',`候補 ${i+1} を選択`);b.addEventListener('click',()=>selectPlayer(i));root.append(b);});
}
function selectPlayer(index) {
  if(!selectable||isRunning()||busy||Math.abs(video.currentTime-selectionTime)>.08){setStatus('停止画面の検出を待ってから、もう一度タップしてください。');requestFrame(true);return;}
  worker.postMessage({type:'select',epoch,index,time:selectionTime});
}
async function requestFrame(force=false) {
  if(!ready||video.readyState<2||video.seeking||document.hidden)return;
  if(busy){pendingForce ||= force;return;}
  if(!force&&video.currentTime===lastVideoTime)return;
  const now=performance.now(),interval=1000/(state==='lost'?2:15);
  if(!force&&!sequenceRunning&&now-lastSent<interval)return;
  busy=true;pendingForce=false;lastSent=now;lastVideoTime=video.currentTime;
  const token=epoch,time=video.currentTime;
  const scale=Math.min(1,768/Math.max(video.videoWidth,video.videoHeight));
  const width=Math.max(1,Math.round(video.videoWidth*scale)),height=Math.max(1,Math.round(video.videoHeight*scale));
  if(capture.width!==width||capture.height!==height){capture.width=width;capture.height=height;}
  try {
    captureCtx.drawImage(video,0,0,width,height);
    const bitmap=await createImageBitmap(capture);
    if(token!==epoch||!worker){bitmap.close();busy=false;if(pendingForce)requestFrame(true);return;}
    frameTimer=setTimeout(()=>failAi('解析が応答しません。再試行してください。'),15000);
    worker.postMessage({type:'frame',bitmap,epoch,time,force,sequence:sequenceRunning,holdSeconds:Number($('holdSeconds').value)||2,fps:Number($('detectFps').value)},[bitmap]);
  } catch(e){busy=false;failAi(e.message);}
}
function tick(now) {
  rafId=null;
  if(video.paused||video.ended||document.hidden)return;
  if(lastFrameWall&&now-lastFrameWall>1500&&state==='tracking')lose('画面が中断されました。選手を再指定してください。');
  lastFrameWall=now;requestFrame();updateTime();draw();
  if(!video.paused)rafId=requestAnimationFrame(tick);
}
videoInput.addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  diagnosticRecords=[];diagnosticCounts={};lastLostTime=null;$('reviewLostBtn').hidden=true;$('diagnosticText').value='';$('diagnosticText').hidden=true;video.pause();clearTracking(`動画を読み込みました：${file.name}`);
  video.removeAttribute('src');video.load();if(objectUrl)URL.revokeObjectURL(objectUrl);
  objectUrl=URL.createObjectURL(file);video.src=objectUrl;video.playbackRate=Number($('speed').value);
  $('fileInfo').textContent=`${file.name} · ${(file.size/1024/1024).toFixed(0)} MB · 端末内のみ`;
  videoInput.value='';await initDetector();
});
loadAiBtn.addEventListener('click',initDetector);
resetBtn.addEventListener('click',()=>{video.pause();clearTracking();requestFrame(true);});
$('detectBtn').addEventListener('click',pausePlayback);
$('playBtn').addEventListener('click',async()=>{
  if(!video.src)return;
  if(isRunning()){pausePlayback();return;}
  if(state==='lost'){setStatus('青い枠から選手を再指定するか、時間を移動してください。');return;}
  if($('analysisMode').value==='accuracy'&&ready&&state==='tracking'){
    sequenceRunning=true;selectable=false;renderChoices();updatePlayback();
    setStatus('精度優先で追跡中。解析を待ちながら進みます（音声なし）。');
    requestFrame(true);return;
  }
  try{updateLiveRate();await video.play();}catch{setStatus('動画を再生できません。MP4（H.264）で試してください。');}
});
$('skipLostBtn').addEventListener('click',async()=>{
  if(state!=='lost'||!video.src)return;
  stopSequence();updateLiveRate();
  recordDiagnostic('skip_missing');targetInfo.textContent='画面外・未確認（欠測）';
  setStatus('未確認の区間は記録しません。戻ってきたら停止して対象を選んでください。');
  try{await video.play();}catch{setStatus('再生できませんでした。もう一度押してください。');}
});
$('reviewLostBtn').addEventListener('click',()=>{if(lastLostTime!==null)seekTo(Math.max(0,lastLostTime-.5));});
function seekTo(time){stopSequence();sequenceSeek=null;video.pause();video.currentTime=Math.max(0,Math.min(video.duration||0,time));}
$('seek').addEventListener('input',()=>seekTo(Number($('seek').value)));
$('backBtn').addEventListener('click',()=>seekTo(video.currentTime-1));
$('forwardBtn').addEventListener('click',()=>seekTo(video.currentTime+1));
$('fineBackBtn').addEventListener('click',()=>seekTo(video.currentTime-.1));
$('fineForwardBtn').addEventListener('click',()=>seekTo(video.currentTime+.1));
$('speed').addEventListener('change',updateLiveRate);
$('detectFps').addEventListener('change',updateLiveRate);
// Only our exact, outstanding step is an internal seek. User seeks still reset identity.
video.addEventListener('seeking',()=>{
  if(sequenceSeek!==null&&Math.abs(video.currentTime-sequenceSeek)<.002)return;
  clearTracking(ready?'移動先を検出しています。選手を選び直してください。':'時間を移動しました。人物検出にはAIの準備が必要です。');
});
video.addEventListener('seeked',()=>{
  const internal=sequenceSeek!==null&&Math.abs(video.currentTime-sequenceSeek)<.002;
  sequenceSeek=null;updatePlayback();
  requestFrame(!internal||!sequenceRunning);
});
$('analysisMode').addEventListener('change',()=>{pausePlayback();setStatus('追跡モードを変更しました。再生で開始します。');});
video.addEventListener('loadedmetadata',()=>{
  $('seek').max=Number.isFinite(video.duration)?video.duration:0;
  document.querySelectorAll('[data-video-control]').forEach(b=>b.disabled=false);updatePlayback();
});
video.addEventListener('loadeddata',()=>requestFrame(true));
video.addEventListener('error',()=>{video.pause();clearTracking('この動画を再生できません。MP4（H.264）など、Chromeが対応する動画を選んでください。');});
video.addEventListener('play',()=>{selectable=false;renderChoices();lastFrameWall=0;rateStart=0;detectionCount=0;updatePlayback();if(!rafId)rafId=requestAnimationFrame(tick);});
video.addEventListener('pause',()=>{if(rafId)cancelAnimationFrame(rafId);rafId=null;updatePlayback();requestFrame(true);});
video.addEventListener('ended',()=>{updatePlayback();setStatus('動画の終わりです。別の位置で試すには時間を移動してください。');});
video.addEventListener('timeupdate',updateTime);
// Canvas never sits over playback controls: all controls are outside the stage.
// During playback a tap pauses first; selecting is only allowed on a fresh still frame.
overlay.addEventListener('pointerdown',event=>{
  if(isRunning()){pausePlayback();return;}
  if(!selectable||busy)return;
  const rect=overlay.getBoundingClientRect(),px=(event.clientX-rect.left)*analysisWidth/rect.width,py=(event.clientY-rect.top)*analysisHeight/rect.height;
  const hits=detections.map((d,i)=>({d,i})).filter(({d:{boundingBox:b}})=>px>=b.originX&&px<=b.originX+b.width&&py>=b.originY&&py<=b.originY+b.height);
  if(hits.length===1)selectPlayer(hits[0].i);
  else if(hits.length>1)setStatus('枠が重なっています。下の番号ボタンで選ぶか、時間を少し移動してください。');
});
window.addEventListener('resize',draw);
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopSequence();video.pause();if(state==='tracking')lose('別の画面に移動しました。戻ったら選手を再指定してください。');}else requestFrame(true);});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('installBtn').hidden=false;});
$('installBtn').addEventListener('click',async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;$('installBtn').hidden=true;}});
if('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('./sw.js',import.meta.url),{scope:'./',updateViaCache:'none'}).then(reg=>{
    $('pwaInfo').textContent=reg.active?'ホーム画面追加対応':'オフライン用画面を準備中';
    const update=()=>{waitingWorker=reg.waiting;$('updateBtn').hidden=false;$('pwaInfo').textContent='更新あり：更新ボタンで反映';};
    if(reg.waiting)update();
    reg.addEventListener('updatefound',()=>reg.installing?.addEventListener('statechange',()=>{if(reg.waiting)update();}));
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloadForUpdate){window.location.reload();return;}$('pwaInfo').textContent='ホーム画面追加対応';});
  }).catch(()=>{$('pwaInfo').textContent='ホーム画面追加の準備に失敗。オンラインでは利用できます。';});
}

$('updateBtn').addEventListener('click',()=>{if(waitingWorker){stopSequence();video.pause();reloadForUpdate=true;waitingWorker.postMessage({type:'activateUpdate'});}});
