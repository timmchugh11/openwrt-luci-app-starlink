import * as THREE from './vendor/three/build/three.module.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';

console.log('[obstruction-3d] module loaded', {
  threeRevision: THREE.REVISION,
  hasGLTFLoader: typeof GLTFLoader === 'function',
});

window.__starlinkObstruction3D = { THREE, GLTFLoader };
console.log('[obstruction-3d] bridge published');
window.dispatchEvent(new Event('starlink-obstruction-3d-ready'));
