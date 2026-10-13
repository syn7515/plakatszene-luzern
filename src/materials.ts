import * as THREE from 'three';
import halftone from './shaders/halftone.glsl?raw';
import paperFrag from './shaders/paper.frag.glsl?raw';
import paperVert from './shaders/paper.vert.glsl?raw';
import { overprint, type Surface } from './poster.ts';

// Shared by every sheet, so the dot screen lines up across all of them.
export const printUniforms = {
  uDotPitch: { value: 6 },
  uDotAngle: { value: Math.PI / 4 },
};

export const FACES = 6; // keep in sync with paper.frag.glsl

export function createPaperMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...printUniforms,
      uGround: { value: Array.from({ length: FACES }, () => new THREE.Color()) },
      uDots: { value: Array.from({ length: FACES }, () => new THREE.Color()) },
      uTone: { value: Array.from({ length: FACES }, () => 0) },
    },
    vertexShader: paperVert,
    fragmentShader: halftone + paperFrag,
    side: THREE.DoubleSide,
  });
}

type PaperMaterial = ReturnType<typeof createPaperMaterial>;

// Faces are counted from the anchored end; see paper.frag.glsl.
export function setFace(material: PaperMaterial, face: number, surface: Surface) {
  const u = material.uniforms;
  u.uGround.value[face].set(surface.ground);
  u.uDots.value[face].set(surface.dots ? overprint(surface.ground, surface.dots) : surface.ground);
  u.uTone.value[face] = surface.dots ? (surface.tone ?? 0) : 0;
}
