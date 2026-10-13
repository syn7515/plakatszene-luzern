import * as THREE from 'three';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { findCollisions } from './collisions.ts';
import { serialize } from './composition.ts';
import { FACES } from './materials.ts';
import { POSTER_SIZE, SURFACES, type SurfaceName } from './poster.ts';
import type { PosterScene } from './poster-scene.ts';
import type { Sheet, SheetSpec } from './sheet.ts';
import { TOP_LAG, paperLength } from './strip-geometry.ts';
import type { Stage } from './stage.ts';

// Dev-only tool for tracing the original: open the page with ?edit.
// Click a sheet to select it, drag to move it, arrow keys to nudge (Shift ×10).
// A sheet that follows another cannot be dragged: left and right move its
// start along the sheet it follows instead.
// A sheet standing on the floor keeps its height: moving it up or down on the
// poster pushes it back or brings it forward instead.
// R toggles the original, ⌘D duplicates. Every change saves itself into
// src/composition.json through the dev server (see vite.config.ts), and is
// checked for paper passing through paper (red dots, count at the top).

// Shown straight from 100 Beste Plakate; nothing is copied into the project.
const REFERENCE_URL = 'https://100-beste-plakate.de/wp-content/uploads/2026/06/100bp25_29176-1200x1697.jpg';
const SAVE_DELAY = 400; // ms after the last change
const NUDGE = 0.5; // cm per arrow key
const snap = (cm: number) => Math.round(cm * 10) / 10; // positions keep 0.1 cm
const OUTLINE = '#1a8cff';
const COLLISION = '#ff0000';

const surfaceOptions = Object.fromEntries(
  Object.entries(SURFACES).map(([name, surface]) => [surface.label, name as SurfaceName]),
);

export function startEditor(poster: PosterScene, stage: Stage, pull: { enabled: boolean }) {
  const { camera, renderer, scene } = stage;
  const canvas = renderer.domElement;
  const composition = poster.composition;
  document.body.classList.add('editing');

  const view = { reference: true, opacity: 0.5, blend: 'normal', mode: 'arrange' as 'arrange' | 'pull' };
  const gui = new GUI({ title: '편집기' });

  // --- Saving ---------------------------------------------------------------

  let pending = 0;
  const setStatus = (text: string) => gui.title(`편집기 · ${text}`);

  async function save() {
    pending = 0;
    setStatus('저장 중…');
    try {
      const res = await fetch('/__composition', { method: 'POST', body: serialize(composition) });
      setStatus(res.ok ? '저장됨' : `저장 실패 (${res.status})`);
    } catch {
      setStatus('저장 실패');
    }
  }

  function changed() {
    setStatus('바뀜');
    clearTimeout(pending);
    pending = window.setTimeout(save, SAVE_DELAY);
    recheck = true;
  }

  // A reload within the save delay would otherwise drop the last change.
  addEventListener('pagehide', () => {
    if (pending) navigator.sendBeacon('/__composition', serialize(composition));
  });

  // --- Original laid over the canvas ----------------------------------------

  const reference = document.createElement('img');
  reference.className = 'reference';
  reference.src = REFERENCE_URL;
  reference.alt = '';
  canvas.parentElement!.append(reference);

  const showReference = () => {
    reference.hidden = !view.reference;
    reference.style.opacity = String(view.opacity);
    reference.style.mixBlendMode = view.blend;
  };
  showReference();

  // --- Selection --------------------------------------------------------------

  let selected: Sheet | null = null;
  let outline: THREE.BoxHelper | null = null;

  // --- Paper through paper --------------------------------------------------
  // Checked on the frame after a change, once the sheets have been rebuilt.

  let recheck = true;
  const markers = new THREE.Group();
  scene.add(markers);
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 12, 8),
    new THREE.MeshBasicMaterial({ color: COLLISION, depthTest: false }),
  );
  marker.renderOrder = 2;
  const checks = { result: '' };

  function checkCollisions() {
    recheck = false;
    const found = findCollisions(poster.sheets, composition.floor);
    markers.clear();
    for (const { at } of found) markers.add(marker.clone().translateX(at.x).translateY(at.y).translateZ(at.z));
    const pairs = found.map(({ a, b, floor }) =>
      floor ? `${a.spec.id} (바닥 아래)` : a === b ? `${a.spec.id} (스스로)` : `${a.spec.id} × ${b.spec.id}`,
    );
    checks.result = found.length ? `${found.length}쌍 · ${pairs.join(', ')}` : '없음';
    collisionRow.updateDisplay();
    collisionRow.domElement.style.color = found.length ? COLLISION : '';
  }

  poster.onUpdate = () => {
    // The editor shows the selected sheet's label all the time, to place it.
    for (const s of poster.sheets) s.reveal = s === selected ? 1 : 0;
    outline?.update();
    if (recheck) checkCollisions();
  };

  const raycaster = new THREE.Raycaster();
  const sheetAt = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const [hit] = raycaster.intersectObjects(poster.sheets.map((s) => s.mesh), false);
    return hit && poster.sheets.find((s) => s.mesh === hit.object);
  };

  function select(sheet: Sheet | null) {
    selected = sheet;
    state.id = sheet?.spec.id ?? '';
    picker.updateDisplay();
    if (sheet && !outline) {
      outline = new THREE.BoxHelper(sheet.mesh, OUTLINE);
      outline.material.depthTest = false;
      outline.renderOrder = 1;
      scene.add(outline);
    }
    if (outline) {
      if (sheet) outline.setFromObject(sheet.mesh);
      outline.visible = !!sheet && view.mode === 'arrange';
    }
    buildSheetFolder();
  }

  // --- Moving sheets ----------------------------------------------------------

  let drag: { sheet: Sheet; x: number; y: number; from: [number, number, number] } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (view.mode !== 'arrange') return;
    const sheet = sheetAt(e);
    if (!sheet) return;
    select(sheet);
    if (sheet.follows) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { sheet, x: e.clientX, y: e.clientY, from: [...sheet.spec.position] };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (view.mode !== 'arrange') return;
    if (!drag) {
      const under = sheetAt(e);
      canvas.style.cursor = under ? (under.follows ? 'pointer' : 'move') : '';
      return;
    }
    // Screen px to cm on the poster. The camera looks down, so a vertical
    // move on screen is a longer move in the world.
    const cmPerPx = POSTER_SIZE.width / canvas.clientWidth;
    const tilt = Math.cos(THREE.MathUtils.degToRad(composition.view.elevation));
    const position = drag.sheet.spec.position;
    const down = (e.clientY - drag.y) * cmPerPx;
    position[0] = snap(drag.from[0] + (e.clientX - drag.x) * cmPerPx);
    if (drag.sheet.spec.grounded) position[2] = snap(drag.from[2] + down / Math.sin(THREE.MathUtils.degToRad(composition.view.elevation)));
    else position[1] = snap(drag.from[1] - down / tilt);
    drag.sheet.apply();
    changed();
  });

  const endDrag = () => (drag = null);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  // --- Adding and removing ----------------------------------------------------

  const nextId = () => {
    const numbers = composition.sheets.map((s) => Number(s.id.replace(/\D/g, '')) || 0);
    return `sheet-${Math.max(0, ...numbers) + 1}`;
  };

  const actions = {
    add() {
      const spec: SheetSpec = {
        id: nextId(),
        position: [-15, -15, 0],
        rotation: [0, 0, 0],
        curl: 1,
        shape: { height: 30, bends: [{ length: 20, turn: 0 }, { length: 40, turn: 300 }] },
        faces: ['green', 'pink', 'yellow', 'beige', 'darkGreen', 'pink'],
      };
      select(poster.add(spec));
      refreshPicker();
      changed();
    },
    duplicate() {
      if (!selected) return;
      const spec = structuredClone(selected.spec);
      spec.id = nextId();
      spec.position[0] += 4;
      spec.position[1] -= 4;
      select(poster.add(spec));
      refreshPicker();
      changed();
    },
    remove() {
      if (!selected || !confirm(`${selected.spec.id}를 지울까요?`)) return;
      poster.remove(selected);
      select(poster.sheets[0] ?? null);
      refreshPicker();
      changed();
    },
  };

  // --- Panel ------------------------------------------------------------------

  gui
    .add(view, 'mode', { 배치: 'arrange', 당기기: 'pull' })
    .name('모드')
    .onChange(() => {
      pull.enabled = view.mode === 'pull';
      if (outline) outline.visible = !!selected && view.mode === 'arrange';
      markers.visible = view.mode === 'arrange';
    });
  pull.enabled = false;
  const collisionRow = gui.add(checks, 'result').name('관통').disable();

  const original = gui.addFolder('원본 겹쳐 보기');
  original.add(view, 'reference').name('보이기 (R)').onChange(showReference);
  original.add(view, 'opacity', 0, 1, 0.05).name('투명도').onChange(showReference);
  original.add(view, 'blend', { 보통: 'normal', 차이: 'difference' }).name('겹치는 방식').onChange(showReference);

  const list = gui.addFolder('종이');
  list.add(actions, 'add').name('새 종이');
  list.add(actions, 'duplicate').name('복제 (⌘D)');
  list.add(actions, 'remove').name('삭제');
  const state = { id: '' };
  const ids = () => composition.sheets.map((s) => s.id);
  const onPick = (id: string) => select(poster.sheets.find((s) => s.spec.id === id) ?? null);
  // Stays the last row of the folder, so replacing it keeps the order.
  let picker = list.add(state, 'id', ids()).name('선택').onChange(onPick);
  const refreshPicker = () => {
    picker.destroy();
    picker = list.add(state, 'id', ids()).name('선택').onChange(onPick);
  };

  const all = gui.addFolder('전체');
  all.add(composition.view, 'elevation', 0, 60, 1).name('내려다보는 각도');
  all.add(composition, 'floor', -100, 0, 0.5).name('바닥 높이 (cm)');
  all.add(composition.print, 'dotPitch', 0.2, 2, 0.01).name('망점 간격 (cm)');
  all.add(composition.print, 'dotAngle', 0, 90, 1).name('망점 각도');
  all.add(composition.print, 'lavender', 0.05, 0.95, 0.01).name('연보라 농도');
  all.add(composition.print, 'darkGreen', 0.05, 0.95, 0.01).name('짙은 초록 농도');
  all.add(composition.spring, 'stiffness', 20, 400, 1).name('스프링 강성');
  all.add(composition.spring, 'damping', 2, 40, 0.5).name('스프링 감쇠');
  all.onChange(() => {
    poster.applyGlobals();
    changed();
  });
  all.close();

  let sheetFolder: GUI | null = null;
  function buildSheetFolder() {
    sheetFolder?.destroy();
    sheetFolder = null;
    if (!selected) return;
    const sheet = selected;
    const s = sheet.spec;
    const folder = (sheetFolder = gui.addFolder(`선택: ${s.id}`));

    const place = folder.addFolder('위치 · 회전');
    const position: number[] = s.position;
    const rotation: number[] = s.rotation;
    const state = { grounded: !!s.grounded };
    place
      .add(state, 'grounded')
      .name('바닥에 서 있음')
      .onChange((on: boolean) => {
        s.grounded = on || undefined;
        queueMicrotask(buildSheetFolder); // height and tilts lock or unlock
      });
    // On the floor a sheet keeps its height and stands upright.
    const floating = !s.grounded;
    const following = sheet.follows; // x, z and the turn come from the followed sheet
    place.add(position, 0, -80, 80, 0.1).name('x (좌우)').listen().enable(!following);
    place.add(position, 1, -100, 100, 0.1).name('y (위아래)').listen().enable(floating);
    place.add(position, 2, -150, 150, 0.1).name('z (앞뒤)').listen().enable(!following);
    place.add(rotation, 1, -180, 180, 1).name('돌리기 (y축)').enable(!following);
    place.add(rotation, 0, -90, 90, 0.5).name('앞뒤로 기울이기 (x축)').enable(floating && !following);
    place.add(rotation, 2, -90, 90, 0.5).name('옆으로 기울이기 (z축)').enable(floating && !following);

    // Lying against another sheet: which one, which side, and how the paper
    // behaves there. One bend is marked as the stretch that follows.
    const follow = folder.addFolder('따라가기');
    const followState = { on: !!s.follow };
    follow
      .add(followState, 'on')
      .name('다른 종이를 따라감')
      .onChange((on: boolean) => {
        if (on) {
          const other = composition.sheets.find((o) => o !== s)?.id ?? s.id;
          s.follow = { sheet: other, side: 'back', from: 0, gap: 2, stiffness: 0.5, restTurn: 0, tension: 0.5 };
          if (!s.shape.bends.some((b) => b.follow)) s.shape.bends[0].follow = true;
        } else {
          delete s.follow;
          for (const b of s.shape.bends) delete b.follow;
        }
        queueMicrotask(buildSheetFolder);
      });
    if (s.follow) {
      const f = s.follow;
      const others = Object.fromEntries(composition.sheets.filter((o) => o !== s).map((o) => [o.id, o.id]));
      follow.add(f, 'sheet', others).name('따라갈 종이');
      follow.add(f, 'side', { '앞면 쪽': 'front', '뒷면 쪽': 'back' }).name('어느 면 쪽');
      follow.add(f, 'from', 0, 250, 0.5).name('시작 지점 (cm)').listen();
      follow.add(f, 'gap', 0, 12, 0.1).name('간격 (cm)');
      follow.add(f, 'stiffness', 0, 1, 0.01).name('빳빳함');
      follow.add(f, 'restTurn', -40, 40, 0.5).name('말림 기억 (°/cm)');
      follow.add(f, 'tension', 0, 1, 0.01).name('장력');
      const dirState = { reverse: !!f.reverse };
      follow
        .add(dirState, 'reverse')
        .name('반대 방향으로')
        .onChange((on: boolean) => {
          if (on) f.reverse = true;
          else delete f.reverse;
        });
    }

    // What pays out when the sheet is pulled: a stretch of the paper, from one
    // end of it towards the other, and how much the top edge holds its curl.
    const pulling = folder.addFolder('당기기');
    const pullState = { on: !!s.pull };
    const total = paperLength(s.shape);
    pulling
      .add(pullState, 'on')
      .name('풀리는 구간 지정')
      .onChange((on: boolean) => {
        if (on) s.pull = { from: 0, to: total, topLag: TOP_LAG };
        else delete s.pull;
        queueMicrotask(buildSheetFolder);
      });
    if (s.pull) {
      pulling.add(s.pull, 'from', 0, total, 0.5).name('시작 (cm)');
      pulling.add(s.pull, 'to', 0, total, 0.5).name('끝 (cm)');
      s.pull.topLag ??= TOP_LAG;
      pulling.add(s.pull as { topLag: number }, 'topLag', 0, 1, 0.05).name('윗선 말림 유지');
    }

    // The label shown on hover: its words, and where it is printed if the
    // sheet's own choice is not wanted.
    const labelling = folder.addFolder('라벨 (호버 때 보임)');
    const labelState = {
      on: !!s.label,
      orientation: s.label?.vertical === undefined ? 'auto' : s.label.vertical ? 'v' : 'h',
      manual: s.label?.at !== undefined,
    };
    labelling
      .add(labelState, 'on')
      .name('라벨 있음')
      .onChange((on: boolean) => {
        if (on) s.label = { title: `Poster ${String(poster.sheets.indexOf(sheet) + 1).padStart(3, '0')}`, year: 2020 };
        else delete s.label;
        queueMicrotask(buildSheetFolder);
      });
    if (s.label) {
      const label = s.label;
      labelling.add(label, 'title').name('제목');
      labelling.add(label, 'year', 2020, 2025, 1).name('연도');
      labelling
        .add(labelState, 'orientation', { 자동: 'auto', 가로: 'h', 세로: 'v' })
        .name('방향')
        .onChange((v: string) => {
          if (v === 'auto') delete label.vertical;
          else label.vertical = v === 'v';
        });
      labelling
        .add(labelState, 'manual')
        .name('위치 직접 지정')
        .onChange((on: boolean) => {
          if (on) {
            label.at = sheet.placed?.at ?? 0;
            label.y = sheet.placed?.y ?? 0;
            label.side = sheet.placed?.side ?? 'front';
          } else {
            delete label.at;
            delete label.y;
            delete label.side;
          }
          queueMicrotask(buildSheetFolder);
        });
      if (labelState.manual) {
        const fixed = label as { at: number; y: number };
        labelling.add(fixed, 'at', 0, total, 0.5).name('시작 (cm)');
        labelling.add(fixed, 'y', 0, s.shape.height, 0.5).name('높이 (cm)');
        labelling.add(label, 'side', { 앞면: 'front', 뒷면: 'back' }).name('면');
      }
    }

    const form = folder.addFolder('형태');
    form.add(s, 'curl', 0, 1, 0.01).name('말림');
    form.add(s.shape, 'height', 2, 130, 0.5).name('높이 (cm)');

    // Each bend: how much paper, and how far it turns (+ towards the front face).
    // With the bottom edge bending on its own, that stretch stands on a slant.
    const bends = folder.addFolder('구간 (고정된 끝부터)');
    const split = { on: s.shape.bends.some((b) => b.bottomTurn !== undefined) };
    bends
      .add(split, 'on')
      .name('아랫선 따로 휘기')
      .onChange((on: boolean) => {
        for (const b of s.shape.bends) b.bottomTurn = on ? b.turn : undefined;
        queueMicrotask(buildSheetFolder);
      });
    s.shape.bends.forEach((bend, i) => {
      if (s.follow) {
        const mark = { on: !!bend.follow };
        bends
          .add(mark, 'on')
          .name(`${i + 1} · 따라가는 구간`)
          .onChange((on: boolean) => {
            for (const b of s.shape.bends) delete b.follow;
            if (on) bend.follow = true;
            queueMicrotask(buildSheetFolder);
          });
      }
      bends.add(bend, 'length', 0.5, 200, 0.5).name(`${i + 1} · 길이 (cm)`);
      if (bend.follow) return; // its turn comes from the followed sheet
      bends.add(bend, 'turn', -720, 720, 1).name(split.on ? `${i + 1} · 윗선 각도 (°)` : `${i + 1} · 휘는 각도 (°)`);
      if (split.on) {
        bend.bottomTurn ??= bend.turn; // a bend added while the split was on may lack it
        bends.add(bend as { bottomTurn: number }, 'bottomTurn', -720, 720, 1).name(`${i + 1} · 아랫선 각도 (°)`);
      }
    });
    const reshape = (change: () => void) => () => {
      change();
      sheet.apply();
      changed();
      queueMicrotask(buildSheetFolder); // rows changed; rebuild once this click is done
    };
    const edits = {
      add: reshape(() => s.shape.bends.push(split.on ? { length: 10, turn: 0, bottomTurn: 0 } : { length: 10, turn: 0 })),
      removeLast: reshape(() => s.shape.bends.length > 1 && s.shape.bends.pop()),
    };
    bends.add(edits, 'add').name('구간 추가');
    bends.add(edits, 'removeLast').name('마지막 구간 삭제');

    const faces = folder.addFolder('면 (고정된 끝부터)');
    for (let i = 0; i < FACES; i++) faces.add(s.faces, i, surfaceOptions).name(`${i + 1}번`);

    folder.onChange(() => {
      sheet.apply();
      changed();
    });
  }

  // --- Keys -------------------------------------------------------------------

  addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
      e.preventDefault();
      actions.duplicate();
      return;
    }
    if (typing) return;
    if (e.key === 'r') {
      view.reference = !view.reference;
      showReference();
      original.controllers.forEach((c) => c.updateDisplay());
    }
    const step = e.shiftKey ? NUDGE * 10 : NUDGE;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (selected && move) {
      e.preventDefault();
      const position = selected.spec.position;
      if (selected.follows) {
        selected.spec.follow!.from = snap(Math.max(0, selected.spec.follow!.from + move[0]));
        if (!selected.spec.grounded) position[1] = snap(position[1] + move[1]);
      } else {
        position[0] = snap(position[0] + move[0]);
        if (selected.spec.grounded) position[2] = snap(position[2] - move[1]);
        else position[1] = snap(position[1] + move[1]);
      }
      selected.apply();
      changed();
    }
  });

  select(poster.sheets[0] ?? null);
  setStatus('저장됨');
}
