// Amplitude-modulated halftone on a grid fixed to the poster, not to the
// paper: a dotted face reads as a flat tint, as in the print, where the grid
// stays even across curved sheets.
uniform float uDotPitch; // device px between dot centres
uniform float uDotAngle; // radians

const float HALFTONE_PI = 3.141592653589793;

// Ink coverage (0..1) at this fragment for a tone (0..1).
float halftone(float tone) {
  if (tone <= 0.0) return 0.0;
  float c = cos(uDotAngle);
  float s = sin(uDotAngle);
  vec2 p = mat2(c, s, -s, c) * gl_FragCoord.xy / uDotPitch;
  float aa = 0.75 / uDotPitch;

  if (tone < 0.5) {
    float r = sqrt(tone / HALFTONE_PI);
    return 1.0 - smoothstep(r - aa, r + aa, length(fract(p) - 0.5));
  }
  // Past 50% the dots merge, so draw holes of ground colour between them.
  float r = sqrt((1.0 - tone) / HALFTONE_PI);
  return smoothstep(r - aa, r + aa, length(fract(p + 0.5) - 0.5));
}
