attribute float face;
varying float vFace;

void main() {
  vFace = face;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
