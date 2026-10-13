// Colour belongs to what the eye reads as one face, not to a spot on the
// paper: the geometry numbers the visible faces from the anchored end (see
// StripGeometry.countFaces), and each gets one flat surface.
#define FACES 6

uniform vec3 uGround[FACES];
uniform vec3 uDots[FACES]; // dot ink as it prints over the ground
uniform float uTone[FACES];
uniform float uSaturation; // 1 = printed as it is, 0 = drained and lifted
#define LIFT 0.3 // how far a drained colour's lightness rises towards white (in gamma space)

varying float vFace; // constant across a segment

void main() {
  // Faces past the last one repeat the last pair.
  int face = int(vFace + 0.5);
  if (face >= FACES) face = FACES - 2 + face % 2;

  vec3 ink = mix(uGround[face], uDots[face], halftone(uTone[face]));
  // Out of focus, the colour drains away, and what lightness is left is
  // lifted a little towards white, so the sheet recedes rather than dulls.
  // The lift happens in gamma space, where equal steps look equal.
  float light = dot(ink, vec3(0.2126, 0.7152, 0.0722));
  float lifted = pow(mix(pow(light, 1.0 / 2.2), 1.0, LIFT), 2.2);
  gl_FragColor = vec4(mix(vec3(lifted), ink, uSaturation), 1.0);
  #include <colorspace_fragment>
}
