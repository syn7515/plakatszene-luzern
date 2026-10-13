// Colour belongs to what the eye reads as one face, not to a spot on the
// paper: the geometry numbers the visible faces from the anchored end (see
// StripGeometry.countFaces), and each gets one flat surface.
#define FACES 6

uniform vec3 uGround[FACES];
uniform vec3 uDots[FACES]; // dot ink as it prints over the ground
uniform float uTone[FACES];
uniform vec3 uInk[FACES]; // what text on the face is printed in
uniform float uSaturation; // 1 = printed as it is, 0 = drained and lifted
#define LIFT 0.5 // how far a drained colour's lightness rises towards white (in gamma space)

// The label (an alpha mask), printed on one side of the paper inside
// uLabelRect (u0, v0, u1, v1), fading in as a whole.
uniform sampler2D uLabel;
uniform vec4 uLabelRect;
uniform float uLabelSide; // 1 = the front, -1 = the back, 0 = no label
uniform float uReveal; // 0..1, its opacity

varying float vFace; // constant across a segment
varying vec2 vUv;

void main() {
  // Faces past the last one repeat the last pair.
  int face = int(vFace + 0.5);
  if (face >= FACES) face = FACES - 2 + face % 2;

  vec3 ink = mix(uGround[face], uDots[face], halftone(uTone[face]));

  // The label is on one side of the paper; seen from the other it is not
  // there. Seen from the back, the paper's length runs the other way across
  // the screen, so the mask is read mirrored to keep the text readable.
  float side = gl_FrontFacing ? 1.0 : -1.0;
  if (uLabelSide == side && uReveal > 0.0) {
    vec2 p = (vUv - uLabelRect.xy) / (uLabelRect.zw - uLabelRect.xy);
    if (side < 0.0) p.x = 1.0 - p.x;
    float inside = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
    float mask = texture2D(uLabel, clamp(p, 0.0, 1.0)).a * inside;
    ink = mix(ink, uInk[face], mask * uReveal);
  }
  // Out of focus, the colour drains away, and what lightness is left is
  // lifted a little towards white, so the sheet recedes rather than dulls.
  // The lift happens in gamma space, where equal steps look equal.
  float light = dot(ink, vec3(0.2126, 0.7152, 0.0722));
  float lifted = pow(mix(pow(light, 1.0 / 2.2), 1.0, LIFT), 2.2);
  gl_FragColor = vec4(mix(vec3(lifted), ink, uSaturation), 1.0);
  #include <colorspace_fragment>
}
