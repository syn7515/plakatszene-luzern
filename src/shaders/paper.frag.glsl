// Colour belongs to what the eye reads as one face, not to a spot on the
// paper: the geometry numbers the visible faces from the anchored end (see
// StripGeometry.countFaces), and each gets one flat surface.
#define FACES 6

uniform vec3 uGround[FACES];
uniform vec3 uDots[FACES]; // dot ink as it prints over the ground
uniform float uTone[FACES];

varying float vFace; // constant across a segment

void main() {
  // Faces past the last one repeat the last pair.
  int face = int(vFace + 0.5);
  if (face >= FACES) face = FACES - 2 + face % 2;

  gl_FragColor = vec4(mix(uGround[face], uDots[face], halftone(uTone[face])), 1.0);
  #include <colorspace_fragment>
}
