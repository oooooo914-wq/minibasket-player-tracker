// Pin JS and WASM to the same published MediaPipe release.
export const AI_VERSION = '0.10.21';
export const AI_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${AI_VERSION}`;
export const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';
