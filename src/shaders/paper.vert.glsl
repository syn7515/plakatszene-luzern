attribute float face;
varying float vFace;
varying vec2 vUv; // along the paper (by length), up the paper

void main() {
  vFace = face;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
