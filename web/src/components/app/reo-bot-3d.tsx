import * as React from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { BrandAvatar } from "@/components/app/brand";
import { cn } from "@/lib/utils";

export type BotMood = "idle" | "typing" | "thinking" | "happy";

export interface ReoBot3DProps {
  /** Whether the Workspace view is currently visible. */
  active?: boolean;
  /** True when the user has typed text in the composer; bot looks attentively toward input. */
  typing?: boolean;
  /** Optional horizontal gaze hint (-1 left, 0 center, 1 right), e.g. hovering preset cards. */
  gazeX?: number;
  /** True when the bot should hover/fly continuously (e.g. while responding). */
  floating?: boolean;
  /** Acting mood for eyes, head tilt, arms, and antenna glow. */
  mood?: BotMood;
  /** Omit the ambient glow halo for compact/peeking placements. */
  compact?: boolean;
  /** Optional className for the outer container. */
  className?: string;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function prefersReducedMotionNow(): boolean {
  if (typeof window === "undefined") return false;
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const attr = document.documentElement.hasAttribute("data-reduce-motion");
  return media || attr;
}

/** Draw glowing pure-white eyes + mood expressions onto a transparent canvas. */
function drawBotEyes(
  ctx: CanvasRenderingContext2D,
  gazeX: number,
  gazeY: number,
  mood: BotMood,
  thinkPhase: number,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w * 0.5 + gazeX * 34;
  const cy = h * 0.5 + gazeY * 20;
  const eyeGap = 112;

  ctx.save();
  // Subtle deep-blue OLED ambient glow behind the eyes for screen depth
  const oledGlow = ctx.createRadialGradient(cx, cy, 18, cx, cy, 240);
  oledGlow.addColorStop(0, "rgba(38, 105, 220, 0.24)");
  oledGlow.addColorStop(0.6, "rgba(18, 52, 130, 0.1)");
  oledGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = oledGlow;
  ctx.fillRect(0, 0, w, h);

  ctx.shadowColor = "rgba(145, 210, 255, 0.95)";
  ctx.shadowBlur = 28;

  if (mood === "happy") {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 24;
    ctx.lineCap = "round";
    for (const side of [-1, 1] as const) {
      const ex = cx + side * eyeGap;
      ctx.beginPath();
      ctx.moveTo(ex - 48, cy + 16);
      ctx.quadraticCurveTo(ex, cy - 42, ex + 48, cy + 16);
      ctx.stroke();
    }
  } else {
    const eyeRadius = mood === "thinking" ? 60 : 68;
    const eyeY = mood === "thinking" ? cy - 16 : cy;

    ctx.fillStyle = "#ffffff";
    for (const side of [-1, 1] as const) {
      ctx.beginPath();
      ctx.arc(cx + side * eyeGap, eyeY, eyeRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Crisp pure-white inner core
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    for (const side of [-1, 1] as const) {
      ctx.beginPath();
      ctx.arc(cx + side * eyeGap, eyeY, eyeRadius - 3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (mood === "thinking") {
      // Gentle 3-dot pulse along the bottom of the screen while answering
      for (let i = -1; i <= 1; i++) {
        const wave = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(thinkPhase * 3.8 - (i + 1) * 0.9));
        ctx.fillStyle = `rgba(220, 242, 255, ${wave.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(w * 0.5 + i * 32, h - 54, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Subtle curved glossy reflection arc at upper-right of the screen
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.32)";
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(w - 58, 56, 30, -Math.PI * 0.42, 0.05);
  ctx.stroke();

  ctx.restore();
}

export function ReoBot3D({
  active = true,
  typing = false,
  gazeX = 0,
  floating = false,
  mood,
  compact = false,
  className,
}: ReoBot3DProps) {
  const effectiveMood: BotMood = mood ?? (floating ? "thinking" : typing ? "typing" : "idle");

  const mountRef = React.useRef<HTMLDivElement | null>(null);
  const [webglFailed, setWebglFailed] = React.useState(false);

  const activeRef = React.useRef(active);
  activeRef.current = active;
  const typingRef = React.useRef(typing);
  typingRef.current = typing;
  const gazeHintRef = React.useRef(gazeX);
  gazeHintRef.current = gazeX;
  const floatingRef = React.useRef(floating);
  floatingRef.current = floating;
  const moodRef = React.useRef<BotMood>(effectiveMood);
  moodRef.current = effectiveMood;

  const wakeLoopRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      setWebglFailed(true);
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.setClearColor(0x000000, 0);

    const canvas = renderer.domElement;
    canvas.className = "block h-full w-full select-none";
    container.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 40);
    camera.position.set(0, 0.16, 4.95);
    camera.lookAt(0, 0.05, 0);

    // Studio IBL environment + high-contrast 3-point + warm amber bounce lighting
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envRT = pmrem.fromScene(roomEnv, 0.04);
    scene.environment = envRT.texture;

    const hemi = new THREE.HemisphereLight(0xfff4d6, 0x241002, 0.52);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xfff6e0, 2.25);
    keyLight.position.set(2.4, 3.8, 3.8);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x9ecaff, 0.85);
    rimLight.position.set(-2.8, 1.6, -2.0);
    scene.add(rimLight);

    const warmBounce = new THREE.PointLight(0xff6b00, 1.6, 7);
    warmBounce.position.set(-1.6, -1.5, 1.8);
    scene.add(warmBounce);

    // Track disposable resources
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const textures: THREE.Texture[] = [];
    const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
      geometries.push(g);
      return g;
    };
    const trackMat = <T extends THREE.Material>(m: T): T => {
      materials.push(m);
      return m;
    };
    const trackTex = <T extends THREE.Texture>(t: T): T => {
      textures.push(t);
      return t;
    };

    // Rich, contrasted amber-yellow shell & deep pitch-navy screen materials
    const yellowMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0xff9d00,
        emissive: 0x2a0e00,
        emissiveIntensity: 0.16,
        roughness: 0.22,
        metalness: 0.02,
        clearcoat: 0.72,
        clearcoatRoughness: 0.14,
        envMapIntensity: 0.42,
      }),
    );

    const antennaBallMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0xffa600,
        emissive: 0x381400,
        emissiveIntensity: 0.22,
        roughness: 0.18,
        metalness: 0.03,
        clearcoat: 0.85,
        clearcoatRoughness: 0.1,
        envMapIntensity: 0.55,
      }),
    );

    const charcoalMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0x1d1f26,
        roughness: 0.28,
        metalness: 0.14,
        clearcoat: 0.5,
        clearcoatRoughness: 0.15,
        envMapIntensity: 0.95,
      }),
    );

    const silverMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xcbd2db,
        roughness: 0.24,
        metalness: 0.84,
        envMapIntensity: 1.3,
      }),
    );

    const screenBezelMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0x040712,
        roughness: 0.1,
        metalness: 0.08,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        envMapIntensity: 0.35,
      }),
    );

    // Dynamic eye screen texture
    const eyeCanvas = document.createElement("canvas");
    eyeCanvas.width = 512;
    eyeCanvas.height = 356;
    const eyeCtx = eyeCanvas.getContext("2d");
    const eyeTexture = trackTex(new THREE.CanvasTexture(eyeCanvas));
    eyeTexture.colorSpace = THREE.SRGBColorSpace;
    eyeTexture.anisotropy = 4;

    const eyePlaneMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: eyeTexture,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );

    // Root Rig
    const rootGroup = new THREE.Group();
    rootGroup.position.set(0, -0.02, 0);
    scene.add(rootGroup);

    // Head Pivot
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 0.36, 0);
    rootGroup.add(headPivot);

    const headShell = new THREE.Mesh(
      trackGeo(new RoundedBoxGeometry(1.48, 1.08, 0.88, 10, 0.28)),
      yellowMat,
    );
    headPivot.add(headShell);

    const screenBox = new THREE.Mesh(
      trackGeo(new RoundedBoxGeometry(1.12, 0.78, 0.14, 8, 0.14)),
      screenBezelMat,
    );
    screenBox.position.set(0, 0, 0.42);
    headPivot.add(screenBox);

    const eyePlane = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(1.02, 0.68)), eyePlaneMat);
    eyePlane.position.set(0, 0, 0.496);
    headPivot.add(eyePlane);

    for (const side of [-1, 1] as const) {
      const ear = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.22, 24, 18)), charcoalMat);
      ear.scale.set(0.48, 0.96, 0.9);
      ear.position.set(side * 0.75, -0.02, 0);
      headPivot.add(ear);
    }

    const antennaBase = new THREE.Mesh(
      trackGeo(new THREE.SphereGeometry(0.18, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55)),
      charcoalMat,
    );
    antennaBase.scale.set(1.1, 0.55, 1.1);
    antennaBase.position.set(0, 0.52, 0);
    headPivot.add(antennaBase);

    const antennaStalk = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.036, 0.042, 0.24, 16)),
      charcoalMat,
    );
    antennaStalk.position.set(0, 0.68, 0);
    headPivot.add(antennaStalk);

    const antennaBall = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.155, 28, 22)), antennaBallMat);
    antennaBall.position.set(0, 0.87, 0);
    headPivot.add(antennaBall);

    // Tapered rounded yellow floating torso
    const torsoGroup = new THREE.Group();
    torsoGroup.position.set(0, -0.54, 0);
    rootGroup.add(torsoGroup);

    const torsoGeo = trackGeo(new RoundedBoxGeometry(0.84, 0.68, 0.62, 10, 0.24));
    const posAttr = torsoGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i);
      const t = clamp((0.34 - y) / 0.68, 0, 1);
      const taper = 1 - t * 0.2;
      posAttr.setX(i, posAttr.getX(i) * taper);
      posAttr.setZ(i, posAttr.getZ(i) * (1 - t * 0.14));
    }
    torsoGeo.computeVertexNormals();
    const torsoMesh = new THREE.Mesh(torsoGeo, yellowMat);
    torsoGroup.add(torsoMesh);

    // Articulated silver & charcoal claw arms
    const armPivots: THREE.Group[] = [];
    for (const side of [-1, 1] as const) {
      const armPivot = new THREE.Group();
      armPivot.position.set(side * 0.39, 0.12, 0.02);
      armPivot.rotation.z = side * -0.58;
      armPivot.rotation.x = 0.12;
      torsoGroup.add(armPivot);
      armPivots.push(armPivot);

      const upperArm = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.085, 0.088, 0.24, 20)),
        silverMat,
      );
      upperArm.rotation.z = side * Math.PI * 0.5;
      upperArm.position.set(side * 0.11, 0, 0);
      armPivot.add(upperArm);

      const elbow = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.088, 18, 14)), silverMat);
      elbow.position.set(side * 0.23, 0, 0);
      armPivot.add(elbow);

      const forearmGroup = new THREE.Group();
      forearmGroup.position.set(side * 0.23, 0, 0);
      forearmGroup.rotation.z = side * -0.42;
      armPivot.add(forearmGroup);

      const cuff = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.142, 24, 18)), charcoalMat);
      cuff.scale.set(1.08, 0.92, 0.94);
      cuff.position.set(side * 0.15, 0, 0);
      forearmGroup.add(cuff);

      const wrist = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.082, 18, 14)), yellowMat);
      wrist.position.set(side * 0.28, 0, 0);
      forearmGroup.add(wrist);

      const claw = new THREE.Mesh(
        trackGeo(new THREE.TorusGeometry(0.125, 0.036, 14, 28, Math.PI * 1.38)),
        silverMat,
      );
      claw.position.set(side * 0.42, 0, 0);
      claw.rotation.z = side === 1 ? -Math.PI * 0.69 : Math.PI * 0.31;
      forearmGroup.add(claw);
    }

    // Pointer-tracking & acting state
    let pointerNormX = 0;
    let pointerNormY = 0;
    let currentYaw = 0;
    let currentPitch = 0;
    let currentRoll = 0;
    let currentEyeX = 0;
    let currentEyeY = 0;
    let currentPosY = -0.02;
    let currentBankZ = 0;
    let actTime = 0;
    let lastEyeKey = "";
    let reducedMotion = prefersReducedMotionNow();

    const updateEyesIfNeeded = (gx: number, gy: number, m: BotMood, thinkPhase: number) => {
      if (!eyeCtx) return;
      const quantPhase = m === "thinking" ? Math.round(thinkPhase * 12) : 0;
      const key = `${m}|${gx.toFixed(3)}|${gy.toFixed(3)}|${quantPhase}`;
      if (key === lastEyeKey) return;
      lastEyeKey = key;
      drawBotEyes(eyeCtx, gx, gy, m, thinkPhase);
      eyeTexture.needsUpdate = true;
    };

    const getTargets = (m: BotMood, isActing: boolean) => {
      if (reducedMotion) {
        return { yaw: 0, pitch: 0, roll: 0, eyeX: 0, eyeY: 0 };
      }
      if (m === "thinking" && isActing) {
        return {
          yaw: Math.sin(actTime * 1.1) * 0.22,
          pitch: -0.1 + Math.sin(actTime * 1.7) * 0.05,
          roll: Math.sin(actTime * 1.6) * 0.14,
          eyeX: Math.sin(actTime * 1.1) * 0.35,
          eyeY: -0.42,
        };
      }
      const hintX = gazeHintRef.current;
      const hasHint = Math.abs(hintX) > 0.05;
      const desiredX = hasHint ? hintX : pointerNormX;
      const desiredY = typingRef.current ? 0.4 : hasHint ? 0.25 : pointerNormY;

      return {
        yaw: clamp(desiredX * 0.36, -0.38, 0.38),
        pitch: clamp(desiredY * 0.22, -0.24, 0.26),
        roll: clamp(-desiredX * 0.08, -0.09, 0.09),
        eyeX: clamp(desiredX, -1, 1),
        eyeY: clamp(desiredY, -1, 1),
      };
    };

    const applyAndRender = (dt: number, snap: boolean): boolean => {
      const m = moodRef.current;
      const isContinuous = !reducedMotion && (floatingRef.current || m === "thinking" || m === "happy");
      if (isContinuous && !snap) {
        actTime += dt;
      }

      const target = getTargets(m, isContinuous);
      const targetPosY = !isContinuous
        ? -0.02
        : m === "happy"
          ? -0.02 + Math.abs(Math.sin(actTime * 3.8)) * 0.09
          : -0.02 + Math.sin(actTime * 2.6) * 0.11;
      const targetBankZ = !isContinuous ? 0 : Math.sin(actTime * 1.7) * 0.07;

      if (snap) {
        currentYaw = target.yaw;
        currentPitch = target.pitch;
        currentRoll = target.roll;
        currentEyeX = target.eyeX;
        currentEyeY = target.eyeY;
        currentPosY = targetPosY;
        currentBankZ = targetBankZ;
      } else {
        currentYaw = damp(currentYaw, target.yaw, 9.5, dt);
        currentPitch = damp(currentPitch, target.pitch, 9.5, dt);
        currentRoll = damp(currentRoll, target.roll, 8.5, dt);
        currentEyeX = damp(currentEyeX, target.eyeX, 12.5, dt);
        currentEyeY = damp(currentEyeY, target.eyeY, 12.5, dt);
        currentPosY = damp(currentPosY, targetPosY, 8.5, dt);
        currentBankZ = damp(currentBankZ, targetBankZ, 8.5, dt);
      }

      const settled =
        !isContinuous &&
        Math.abs(target.yaw - currentYaw) < 0.0005 &&
        Math.abs(target.pitch - currentPitch) < 0.0005 &&
        Math.abs(target.roll - currentRoll) < 0.0005 &&
        Math.abs(target.eyeX - currentEyeX) < 0.0005 &&
        Math.abs(target.eyeY - currentEyeY) < 0.0005 &&
        Math.abs(targetPosY - currentPosY) < 0.0005 &&
        Math.abs(targetBankZ - currentBankZ) < 0.0005;

      if (settled && !snap) {
        currentYaw = target.yaw;
        currentPitch = target.pitch;
        currentRoll = target.roll;
        currentEyeX = target.eyeX;
        currentEyeY = target.eyeY;
        currentPosY = targetPosY;
        currentBankZ = targetBankZ;
      }

      rootGroup.position.y = currentPosY;
      rootGroup.rotation.z = currentBankZ;
      headPivot.rotation.y = currentYaw;
      headPivot.rotation.x = currentPitch;
      headPivot.rotation.z = currentRoll;
      torsoGroup.rotation.y = currentYaw * 0.32;
      torsoGroup.rotation.z = currentRoll * 0.45;

      // Subtle arm & antenna acting
      const armWave = isContinuous ? Math.sin(actTime * 3.1) * 0.14 : 0;
      const happyRaise = m === "happy" && isContinuous ? 0.26 : 0;
      if (armPivots[0]) {
        armPivots[0].rotation.z = 0.58 - happyRaise + armWave;
      }
      if (armPivots[1]) {
        armPivots[1].rotation.z = -0.58 + happyRaise + armWave;
      }
      antennaBallMat.emissiveIntensity =
        m === "thinking" && isContinuous ? 0.72 + Math.sin(actTime * 2.4) * 0.28 : 0.28;

      updateEyesIfNeeded(currentEyeX, currentEyeY, m, actTime);
      renderer.render(scene, camera);

      return !settled && !snap;
    };

    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      rafId = 0;
      if (document.hidden || !activeRef.current) return;
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const needsMore = applyAndRender(dt, false);
      if (needsMore) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const wakeLoop = () => {
      if (document.hidden || !activeRef.current) return;
      if (reducedMotion) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        applyAndRender(0.016, true);
        return;
      }
      if (!rafId) {
        lastTime = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    };
    wakeLoopRef.current = wakeLoop;

    const handleResize = () => {
      const w = Math.max(container.clientWidth, 1);
      const h = Math.max(container.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      applyAndRender(0.016, true);
    };
    const resizeObs = new ResizeObserver(handleResize);
    resizeObs.observe(container);
    handleResize();

    const onWindowPointerMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const cx = rect.left + rect.width * 0.5;
      const cy = rect.top + rect.height * 0.45;
      pointerNormX = clamp((e.clientX - cx) / Math.max(window.innerWidth * 0.42, 260), -1, 1);
      pointerNormY = clamp((e.clientY - cy) / Math.max(window.innerHeight * 0.42, 240), -1, 1);
      wakeLoop();
    };

    const onMotionPrefChange = () => {
      reducedMotion = prefersReducedMotionNow();
      wakeLoop();
    };
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    mq?.addEventListener("change", onMotionPrefChange);
    const attrObs = new MutationObserver(onMotionPrefChange);
    attrObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });

    const onVisibility = () => {
      if (document.hidden && rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      } else {
        wakeLoop();
      }
    };

    const onContextLost = (e: Event) => {
      e.preventDefault();
    };

    window.addEventListener("pointermove", onWindowPointerMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", onContextLost);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", onWindowPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      mq?.removeEventListener("change", onMotionPrefChange);
      attrObs.disconnect();
      resizeObs.disconnect();
      wakeLoopRef.current = null;

      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      envRT.dispose();
      roomEnv.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (canvas.parentNode === container) {
        container.removeChild(canvas);
      }
    };
  }, []);

  React.useEffect(() => {
    if (active) {
      wakeLoopRef.current?.();
    }
  }, [active, typing, gazeX, floating, effectiveMood]);

  if (webglFailed) {
    return <BrandAvatar className={compact ? "size-8" : "size-16"} />;
  }

  return (
    <div
      ref={mountRef}
      aria-label="SPIL REO 3D assistant"
      className={cn(
        !compact && "reo-bot-stage",
        "relative flex h-44 w-56 items-center justify-center sm:h-48 sm:w-64",
        className,
      )}
    />
  );
}

export default ReoBot3D;
