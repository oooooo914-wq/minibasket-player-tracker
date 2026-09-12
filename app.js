import { FilesetResolver, ObjectDetector } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs';

const videoInput = document.getElementById('videoInput');
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const loadAiBtn = document.getElementById('loadAiBtn');
const resetBtn = document.getElementById('resetBtn');
const statusEl = document.getElementById('status');
const aiInfo = document.getElementById('aiInfo');
const detectInfo = document.getElementById('detectInfo');
const targetInfo = document.getElementById('targetInfo');

let detector = null;
let lastVideoTime = -1;
let detections = [];
let target = null;
let trail = [];
let rafId = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function syncCanvas() {
  const rect = video.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.max(1, Math.round(rect.width * dpr));
  overlay.height = Math.max(1, Math.round(rect.height * dpr));
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function videoToScreen(box) {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const rect = video.getBoundingClientRect();
  const sx = rect.width / vw;
  const sy = rect.height / vh;
  return {
    x: box.originX * sx,
    y: box.originY * sy,
    width: box.width * sx,
    height: box.height * sy,
  };
}

function centerOf(box) {
  return {
    x: box.originX + box.width / 2,
    y: box.originY + box.height / 2,
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pickClosestTarget(candidates) {
  if (!target || candidates.length === 0) return null;
  const prev = centerOf(target.boundingBox);
  let best = null;
  let bestScore = Infinity;

  for (const d of candidates) {
    const c = centerOf(d.boundingBox);
    const spatial = distance(prev, c);
    const prevArea = target.boundingBox.width * target.boundingBox.height;
    const area = d.boundingBox.width * d.boundingBox.height;
    const areaPenalty = prevArea > 0 ? Math.abs(Math.log(Math.max(area, 1) / prevArea)) * 120 : 0;
    const score = spatial + areaPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }

  const gate = Math.max(video.videoWidth, video.videoHeight) * 0.18;
  return bestScore <= gate ? best : null;
}

function draw() {
  syncCanvas();
  const rect = video.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);

  for (const d of detections) {
    const b = videoToScreen(d.boundingBox);
    ctx.lineWidth = 2;
    ctx.strokeStyle = target === d ? '#22c55e' : '#60a5fa';
    ctx.strokeRect(b.x, b.y, b.width, b.height);
  }

  if (trail.length > 1) {
    ctx.beginPath();
    const first = videoToScreen({ originX: trail[0].x, originY: trail[0].y, width: 0, height: 0 });
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < trail.length; i++) {
      const p = videoToScreen({ originX: trail[i].x, originY: trail[i].y, width: 0, height: 0 });
      ctx.lineTo(p.x, p.y);
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#f59e0b';
    ctx.stroke();
  }
}

async function initDetector() {
  if (detector) return;
  loadAiBtn.disabled = true;
  setStatus('AIモデルを読み込んでいます…');
  aiInfo.textContent = '読込中';

  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm'
    );
    detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite',
      },
      runningMode: 'VIDEO',
      scoreThreshold: 0.35,
      maxResults: 20,
    });
    aiInfo.textContent = '準備完了';
    setStatus('AI準備完了。動画を再生し、追いたい選手をタップしてください。');
  } catch (err) {
    console.error(err);
    aiInfo.textContent = 'エラー';
    setStatus('AIの読み込みに失敗しました。通信状態を確認してください。');
  } finally {
    loadAiBtn.disabled = false;
  }
}

function personOnly(result) {
  return (result?.detections || []).filter((d) => {
    const category = d.categories?.[0]?.categoryName?.toLowerCase();
    return category === 'person';
  });
}

async function analyzeFrame() {
  if (!detector || video.readyState < 2 || video.paused || video.ended) {
    rafId = requestAnimationFrame(analyzeFrame);
    return;
  }

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      const result = detector.detectForVideo(video, performance.now());
      detections = personOnly(result);
      detectInfo.textContent = `${detections.length}人`;

      if (target) {
        const matched = pickClosestTarget(detections);
        if (matched) {
          target = matched;
          const b = target.boundingBox;
          trail.push({ x: b.originX + b.width / 2, y: b.originY + b.height });
          if (trail.length > 600) trail.shift();
          targetInfo.textContent = '追跡中';
        } else {
          targetInfo.textContent = '見失い';
        }
      }
      draw();
    } catch (err) {
      console.error(err);
    }
  }

  rafId = requestAnimationFrame(analyzeFrame);
}

videoInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  target = null;
  trail = [];
  detections = [];
  targetInfo.textContent = '未選択';
  setStatus(`動画を読み込みました: ${file.name}`);
  await initDetector();
});

loadAiBtn.addEventListener('click', initDetector);

resetBtn.addEventListener('click', () => {
  target = null;
  trail = [];
  targetInfo.textContent = '未選択';
  setStatus('追跡をリセットしました。選手をタップしてください。');
  draw();
});

overlay.addEventListener('pointerdown', (event) => {
  if (!video.videoWidth || detections.length === 0) return;
  const rect = overlay.getBoundingClientRect();
  const px = (event.clientX - rect.left) * (video.videoWidth / rect.width);
  const py = (event.clientY - rect.top) * (video.videoHeight / rect.height);

  const hit = detections.find((d) => {
    const b = d.boundingBox;
    return px >= b.originX && px <= b.originX + b.width && py >= b.originY && py <= b.originY + b.height;
  });

  if (hit) {
    target = hit;
    trail = [];
    targetInfo.textContent = '選択済み';
    setStatus('対象を選択しました。再生して追跡を確認してください。');
    draw();
  }
});

video.addEventListener('loadedmetadata', () => {
  syncCanvas();
  draw();
});

video.addEventListener('play', () => {
  if (!rafId) rafId = requestAnimationFrame(analyzeFrame);
});

window.addEventListener('resize', draw);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}
