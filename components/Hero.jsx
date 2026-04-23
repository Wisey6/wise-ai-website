// Loads the real MacBook GLTF model from the Wise Ai GitHub repo.
// Files (scene.gltf, scene.bin, textures/) must sit alongside the HTML when deployed.
const MODEL_BASE_URLS = [
  "", // same directory as the deployed HTML (prod)
  "https://cdn.jsdelivr.net/gh/Wisey6/wise-ai-website@main/", // fallback for preview
];

function HeroLaptop3D({ showOwlOnScreen = false, lidClose = 0, onScreenRect = null, idleEnabled = true, spinProgress = 0 }) {
  const mountRef = React.useRef(null);
  const rafRef = React.useRef(0);
  const cameraRef = React.useRef(null);
  const onScreenRectRef = React.useRef(onScreenRect);
  React.useEffect(() => { onScreenRectRef.current = onScreenRect; }, [onScreenRect]);
  const idleEnabledRef = React.useRef(idleEnabled);
  React.useEffect(() => { idleEnabledRef.current = idleEnabled; }, [idleEnabled]);
  const spinProgressRef = React.useRef(spinProgress);
  React.useEffect(() => { spinProgressRef.current = spinProgress; }, [spinProgress]);
  const showOwlRef = React.useRef(showOwlOnScreen);
  React.useEffect(() => { showOwlRef.current = showOwlOnScreen; }, [showOwlOnScreen]);
  const lidCloseRef = React.useRef(lidClose);
  React.useEffect(() => { lidCloseRef.current = lidClose; }, [lidClose]);
  const [status, setStatus] = React.useState("Loading MacBook…");

  React.useEffect(() => {
    if (!window.THREE) return;
    const THREE = window.THREE;
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);
    cameraRef.current = camera;
    // Camera sits at its resting composition for the entire page life.
    // The intro reveal is handled entirely in the DOM (white panel + owl PNG)
    // so the 3D model never scales/distorts — it's always at its natural aspect.
    const restingPos = new THREE.Vector3(0, 0.8, 5.0);
    const restingLookAt = new THREE.Vector3(0, 0, 0);
    camera.position.copy(restingPos);
    camera.lookAt(restingLookAt);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    // lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(4, 6, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffd9c2, 0.6);
    fill.position.set(-5, 3, -2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.4);
    rim.position.set(0, 4, -6);
    scene.add(rim);

    let model = null;
    let disposed = false;

    const loader = new THREE.GLTFLoader();

    // owl screen overlay texture
    const texLoader = new THREE.TextureLoader();
    texLoader.crossOrigin = "anonymous";
    // Screen texture starts BLANK WHITE. paintOwlOnScreen() is called later
    // (when the flying PNG lands) to swap in the owl wallpaper — a clean texture
    // handoff instead of pixel-matched animation.
    const size = 1024;
    const aspect = 16 / 10;
    const texW = size, texH = Math.round(size / aspect);
    let screenCanvas = document.createElement("canvas");
    screenCanvas.width = texW;
    screenCanvas.height = texH;
    let screenCtx = screenCanvas.getContext("2d");
    screenCtx.fillStyle = "#ffffff";
    screenCtx.fillRect(0, 0, texW, texH);
    const owlTex = new THREE.CanvasTexture(screenCanvas);
    owlTex.encoding = THREE.sRGBEncoding;
    owlTex.flipY = false;
    owlTex.wrapS = THREE.ClampToEdgeWrapping;
    owlTex.wrapT = THREE.ClampToEdgeWrapping;
    let owlPaintedOnScreen = false;
    const paintOwlOnScreen = () => {
      if (owlPaintedOnScreen) return;
      const owlSrc = (window.__resources && window.__resources.owlTransparent) || "assets/owl-transparent.png";
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const targetH = texH * 0.6;
        const targetW = targetH * (img.width / img.height);
        const x = (texW - targetW) / 2;
        const y = (texH - targetH) / 2;
        screenCtx.fillStyle = "#ffffff";
        screenCtx.fillRect(0, 0, texW, texH);
        screenCtx.drawImage(img, x, y, targetW, targetH);
        owlTex.needsUpdate = true;
        owlPaintedOnScreen = true;
      };
      img.src = owlSrc;
    };

    let screenMesh = null;
    let lidGroup = null;
    let lidPivot = null;
    const applyOwlToScreen = (root) => {
      root.traverse((child) => {
        if (!child.isMesh) return;
        const matName = (child.material && child.material.name) || "";
        if (matName !== "HlQwFCAPWzetDQy") return;
        screenMesh = child;
        const m = child.material;
        if (m.emissiveMap && m.emissiveMap.dispose) m.emissiveMap.dispose();
        m.emissiveMap = owlTex;
        m.emissive = new THREE.Color(0xffffff);
        m.emissiveIntensity = 1.0;
        if (m.map && m.map.dispose) m.map.dispose();
        m.map = owlTex;
        m.color = new THREE.Color(0xffffff);
        m.needsUpdate = true;
      });
      // Find the lid subtree. In the Sketchfab MacBook model, the parent node
      // "nIhhmAXgzOpXafM_62" has exactly 2 children: base (EhCmdLAMoLoXcIA_43)
      // and lid (RcexTyyhpuJYATQ_61). The lid's local AABB gives us the hinge
      // location — bottom-front edge (y = min_y, z = max_z).
      // NOTE: lid-close animation disabled — the Sketchfab GLTF hierarchy has
      // meshes with baked-in transforms that don't respond to a hinge-pivot
      // rotation on their parent group. Leaving the laptop open for now.
      let lidParent = null;
      // eslint-disable-next-line no-constant-condition
      if (false && lidParent && lidParent.children.length >= 2) {
        // Pick the child whose AABB is TALLER (bigger Y extent) = the lid.
        let tallest = null, tallestH = 0;
        for (const c of lidParent.children) {
          const b = new THREE.Box3().setFromObject(c);
          const h = b.max.y - b.min.y;
          if (h > tallestH) { tallestH = h; tallest = c; }
        }
        if (tallest) {
          lidGroup = tallest;
          const lidBox = new THREE.Box3().setFromObject(lidGroup);
          // Hinge on a MacBook: the BACK-BOTTOM edge of the lid. That point
          // stays fixed as the lid rotates forward to close. Lid sits at
          // negative z (screen faces +z toward camera), so back = min.z.
          const hingeWorld = new THREE.Vector3(0, lidBox.min.y, lidBox.min.z);
          // Convert to lidParent local space
          lidParent.updateWorldMatrix(true, false);
          const hingeLocal = lidParent.worldToLocal(hingeWorld.clone());
          lidPivot = new THREE.Group();
          lidPivot.position.copy(hingeLocal);
          lidParent.add(lidPivot);
          lidPivot.updateWorldMatrix(true, false);
          // `attach` reparents while preserving world transform. This is the
          // correct API for arbitrary-pivot rotation.
          lidPivot.attach(lidGroup);
        }
      }
    };

    const tryLoad = (i) => {
      if (i >= MODEL_BASE_URLS.length || disposed) {
        setStatus("Using fallback display");
        // fallback: show a stylised placeholder block
        const g = new THREE.Group();
        const metal = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.85, roughness: 0.35 });
        const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 1.6), metal);
        base.position.y = -0.04;
        const lid = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.5, 0.06), metal);
        lid.position.set(0, 0.75, -0.78);
        lid.rotation.x = -0.15;
        g.add(base, lid);
        model = g;
        scene.add(model);
        return;
      }
      const base = MODEL_BASE_URLS[i];
      const url = base + "scene.gltf";
      loader.setResourcePath(base);
      loader.load(
        url,
        (gltf) => {
          if (disposed) return;
          model = gltf.scene;
          // normalise scale + centre
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);
          // Scale target — a touch smaller so it sits calmer in the layout.
          const target = 1.55;
          const scale = target / maxDim;
          model.scale.setScalar(scale);
          const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
          model.position.sub(center);
          // Drop the laptop a bit below centre — top of the lid lands
          // around the mid-line of the "E" in the WISE wordmark.
          model.position.y += -0.55;
          applyOwlToScreen(model);
          scene.add(model);
          setStatus("");
          // DEBUG: expose model for inspection
          window.__wiseModel = model;
          window.__wiseScreenMesh = screenMesh;
          window.__wiseTHREE = THREE;
        },
        undefined,
        (err) => {
          console.warn("gltf load failed from", base, err);
          tryLoad(i + 1);
        }
      );
    };
    tryLoad(0);

    let t0 = performance.now();
    let idleAmpCur = 0;
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      const close = Math.max(0, Math.min(1, lidCloseRef.current || 0));
      const idleTarget = idleEnabledRef.current ? 1 : 0;
      // smoothly ramp the idle amplitude in/out so sway doesn't snap on
      idleAmpCur += (idleTarget - idleAmpCur) * 0.04;
      const spin = Math.max(0, Math.min(1, spinProgressRef.current || 0));
      if (model) {
        const idleAmount = (1 - close) * idleAmpCur;
        // Pure hover — no Y rotation, just a pronounced vertical float.
        model.rotation.y = 0;
        model.position.y = -0.55 + Math.sin(t * 1.05) * 0.09 * idleAmount;
      }
      // REAL lid close: rotate the lid pivot about its X axis. At close=0
      // the lid is at its default open angle (~110°). At close=1 the lid
      // is flat closed (parallel to keyboard). The lid sits at the back with
      // its normal pointing roughly -Z (toward camera), so a POSITIVE X rotation
      // folds it forward onto the keyboard.
      if (lidPivot) {
        // MacBook lid open angle ≈ 110° from keyboard plane. The model already
        // ships with lid open, so rotation 0 = open. Close by rotating forward
        // (+X) by ~110° → ~1.92 rad.
        lidPivot.rotation.x = close * 1.92;
      }
      if (showOwlRef.current) {
        paintOwlOnScreen();
      }
      // Project the screen mesh's world AABB into viewport-pixel coords so the
      // flying PNG owl can land exactly on top of the 3D on-screen owl.
      if (screenMesh && onScreenRectRef.current) {
        const box = new THREE.Box3().setFromObject(screenMesh);
        const corners = [
          new THREE.Vector3(box.min.x, box.min.y, box.min.z),
          new THREE.Vector3(box.max.x, box.min.y, box.min.z),
          new THREE.Vector3(box.min.x, box.max.y, box.min.z),
          new THREE.Vector3(box.max.x, box.max.y, box.min.z),
          new THREE.Vector3(box.min.x, box.min.y, box.max.z),
          new THREE.Vector3(box.max.x, box.min.y, box.max.z),
          new THREE.Vector3(box.min.x, box.max.y, box.max.z),
          new THREE.Vector3(box.max.x, box.max.y, box.max.z),
        ];
        const rect = mount.getBoundingClientRect();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const c of corners) {
          const v = c.clone().project(camera);
          const px = rect.left + (v.x + 1) * 0.5 * rect.width;
          const py = rect.top + (1 - (v.y + 1) * 0.5) * rect.height;
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        }
        onScreenRectRef.current({
          x: minX, y: minY,
          w: maxX - minX, h: maxY - minY,
          cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
        });
      }
      renderer.render(scene, camera);
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div className="hero__3d" aria-hidden>
      <div ref={mountRef} className="hero__3d-mount" />
      {status && <div className="hero__3d-status">{status}</div>}
    </div>
  );
}

function Hero({ variant = "orange" }) {
  // Cinematic auto-play reveal. No scroll lock.
  // phase progress: 0..1 over INTRO_MS; drives opacities and the owl flight.
  const INTRO_MS = 2400;
  const [phase, setPhase] = React.useState(() => {
    try { return sessionStorage.getItem("wiseai_intro_done") === "1" ? 1 : 0; } catch (e) { return 0; }
  });
  const phaseRef = React.useRef(phase);
  phaseRef.current = phase;

  // Live screen-mesh bounds — legacy; no longer required for pixel-accurate
  // handoff since we now texture-swap the 3D laptop screen instead. Kept as a
  // rough flight target.
  const [screenRect, setScreenRect] = React.useState(null);
  const [viewport, setViewport] = React.useState({
    w: typeof window !== "undefined" ? window.innerWidth : 1440,
    h: typeof window !== "undefined" ? window.innerHeight : 900,
  });

  const handleScreenBounds = React.useCallback((b) => {
    if (typeof window !== "undefined") window.__wiseScreenRect = b;
    setScreenRect(b);
  }, []);

  // Scroll choreography (revised):
  //   1. Owl-flight intro plays (laptop frozen — no sway, no bobbing).
  //   2. 500 ms after owl lands, laptop idle float begins and persists —
  //      no scroll-driven spin, no lid close. Just a stationary, gently
  //      floating laptop that normal page scroll passes by.
  const heroRef = React.useRef(null);
  const lidClose = 0;
  const spinProgress = 0;

  // Laptop idle-sway gate — 500 ms AFTER the owl lands on-screen.
  const [idleEnabled, setIdleEnabled] = React.useState(false);
  React.useEffect(() => {
    if (phase >= 0.62 && !idleEnabled) {
      const id = setTimeout(() => setIdleEnabled(true), 500);
      return () => clearTimeout(id);
    }
  }, [phase, idleEnabled]);

  React.useEffect(() => {
    const measure = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Laptop sits still once it lands — idle hover only, no scroll-driven spin.

  React.useEffect(() => {
    if (phase >= 1) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      const elapsed = performance.now() - t0;
      const p = Math.min(1, elapsed / INTRO_MS);
      setPhase(p);
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        try { sessionStorage.setItem("wiseai_intro_done", "1"); } catch (e) {}
        try { window.dispatchEvent(new Event("wiseai:intro-done")); } catch (e) {}
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // easing helpers
  const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
  const easeInOutCubic = (x) => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

  // phase breakdown:
  //   0.00 – 0.30  owl rises in, wordmark traces (white fullscreen)
  //   0.30 – 0.65  owl flies from viewport centre to laptop-screen position; laptop canvas fades in; white panel recedes
  //   0.65 – 1.00  copy + topbar + CTAs rise into place; PNG owl fades (3D on-screen owl takes over)
  const p = phase;
  const owlRevealT = easeOutCubic(Math.min(1, p / 0.30));           // 0..1 during first segment
  const owlFlightT = easeInOutCubic(Math.max(0, Math.min(1, (p - 0.30) / 0.35))); // 0..1 during middle
  const copyT      = easeOutCubic(Math.max(0, Math.min(1, (p - 0.65) / 0.35)));   // 0..1 during last
  const whiteFadeT = easeInOutCubic(Math.max(0, Math.min(1, (p - 0.30) / 0.30))); // white panel dissolves mid-animation
  const laptopFadeT= easeOutCubic(Math.max(0, Math.min(1, (p - 0.35) / 0.35)));    // laptop fades in during middle

  // PNG owl position/size interpolation
  // starting state: centred in viewport, ~min(56vmin, 480px)
  const startSize = Math.min(viewport.w, viewport.h) * 0.56;
  const startSizeClamped = Math.min(startSize, 480);
  const startCx = viewport.w / 2;
  const startCy = viewport.h / 2;
  // end state: MATCH the 3D on-screen owl exactly. It's drawn at 60% of the
  // screen-mesh height, centred. The screen mesh projects to screenRect, so:
  //   endCy = screenRect.cy
  //   endSize = 0.60 * screenRect.height  (the PNG owl is a square-ish box; size = side length)
  // If bounds haven't arrived yet, fall back to a sensible approximation.
  // Flight target: center of the right-column laptop area. Roughly 75% across
  // the viewport, 45% down. Pixel-perfect landing no longer required since the
  // 3D laptop screen texture-swaps to the owl at p≈0.62.
  // end state: match the 3D on-screen owl exactly. The owl is drawn at 60%
  // of the screen-canvas height, centred within the 16:10 screen. The screen
  // mesh projects into viewport pixels via `screenRect`. If the rect hasn't
  // arrived yet, fall back to a reasonable approximation.
  let endSize, endCx, endCy;
  if (screenRect && screenRect.w > 0 && screenRect.h > 0) {
    endSize = screenRect.h * 0.72;
    endCx = screenRect.cx;
    endCy = screenRect.cy + screenRect.h * 0.09;
  } else {
    endSize = Math.min(viewport.w, viewport.h) * 0.19;
    endCx = viewport.w * 0.72;
    endCy = viewport.h * 0.30;
  }

  const owlCx = startCx + (endCx - startCx) * owlFlightT;
  const owlCy = startCy + (endCy - startCy) * owlFlightT;
  const owlSize = startSizeClamped + (endSize - startSizeClamped) * owlFlightT;
  // reveal scale/opacity during first segment
  const owlRevealScale = 0.92 + owlRevealT * 0.08;
  const owlBaseOpacity = owlRevealT;
  // once flight reaches the laptop, cross-fade out — the 3D screen texture
  // has just been painted with the owl, so this is a seamless handoff.
  const owlHandoffOpacity = Math.max(0, 1 - Math.max(0, (p - 0.60) / 0.08));
  const pngOwlOpacity = Math.min(owlBaseOpacity, owlHandoffOpacity);

  const whiteOpacity = 1 - whiteFadeT;
  // show introductory wordmark only during the opening beat
  const introWordmarkOpacity = Math.max(0, owlRevealT - Math.max(0, (p - 0.22) / 0.15));

  // copy fade / rise
  const copyOpacity = copyT;
  const copyShiftY = (1 - copyT) * 18;

  const [time, setTime] = React.useState(
    new Date().toLocaleTimeString("en-AU", { hour12: false, timeZone: "Australia/Brisbane" })
  );
  React.useEffect(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString("en-AU", { hour12: false, timeZone: "Australia/Brisbane" })), 1000);
    return () => clearInterval(t);
  }, []);

  // rightColRef kept as a ref for potential layout math but we no longer
  // pin the laptop — it scrolls naturally with the hero.
  const rightColRef = React.useRef(null);

  const owlSrc = (typeof window !== "undefined" && window.__resources && window.__resources.owlTransparent) || "assets/owl-transparent.png";

  return (
    <section
      id="top"
      ref={heroRef}
      className={`hero hero--${variant} hero--v2`}
      data-screen-label="01 Hero"
      style={{
        // gentle fade only — the real drama is the 3D lid closing
        opacity: 1 - lidClose * 0.5,
      }}
    >
      <div
        className="hero__topbar"
        style={{ opacity: copyOpacity, transform: `translateY(${(1 - copyOpacity) * 8}px)` }}
      >
        <span className="hero__kicker">
          <span className="dot" /> Available — Accepting new clients
        </span>
        <span className="hero__clock">Brisbane · {time}</span>
      </div>

      <div className="hero__stage hero__stage--split">
        <div
          className="hero__left"
          style={{
            opacity: copyOpacity,
            transform: `translateY(${copyShiftY}px)`,
            pointerEvents: copyOpacity > 0.5 ? "auto" : "none",
          }}
        >
          <div className="hero__wordmark">
            <span className="hero__wise" style={{ color: "rgb(242, 120, 47)", fontWeight: 700 }}>WISE</span>
            <span className="hero__ai" style={{ color: "rgb(242, 120, 47)", height: "177px", fontSize: "35px", display: "inline-block" }}> AI</span>
          </div>
          <p className="hero__tag" style={{ fontWeight: 500, color: "rgb(0, 0, 0)", maxWidth: "500px" }}>
            From AI confusion to competitive advantage.
          </p>
          <div className="hero__actions">
            <a href="#services" className="btn btn--primary btn--lg">
              <span>See services</span>
              <Arrow />
            </a>
            <a href="#contact" className="btn btn--ghost btn--lg">
              Book a call
            </a>
          </div>
        </div>

        <div
          ref={rightColRef}
          className="hero__right hero__right--responsive"
          style={{ width: "100%", position: "relative" }}
        >
          {/* 3D laptop canvas — stays in its column. Scroll-driven spin
              turns the model a half-turn as you move toward Services;
              the whole element simply scrolls out of view with the hero,
              which is cleaner than trying to pin it over the page. */}
          <div
            className="hero__3d-wrap"
            style={{
              position: "absolute",
              // expand beyond the column a touch so the screen corner
              // never clips when the model tilts / rotates.
              left: "-12%",
              top: "-18%",
              width: "124%",
              height: "136%",
              opacity: laptopFadeT,
              transform: `translateY(${(1 - laptopFadeT) * 24}px)`,
              transition: "none",
              pointerEvents: "none",
            }}
          >
            <HeroLaptop3D
              showOwlOnScreen={p > 0.62}
              lidClose={lidClose}
              onScreenRect={handleScreenBounds}
              idleEnabled={idleEnabled}
              spinProgress={spinProgress}
            />
          </div>
        </div>
      </div>

      {/* White intro panel — fades out mid-animation */}
      {whiteOpacity > 0.001 && (
        <div
          className="hero-intro-white"
          style={{
            opacity: whiteOpacity,
            pointerEvents: whiteOpacity > 0.5 ? "auto" : "none",
          }}
          aria-hidden
        >
          {/* intro wordmark under the owl — only during the opening beat */}
          <div
            className="hero-intro-wordmark"
            style={{ opacity: introWordmarkOpacity }}
          >
            <span style={{ color: "rgb(242, 120, 47)", fontWeight: 700 }}>WISE</span>
            <span style={{ color: "rgb(242, 120, 47)", fontWeight: 700 }}> AI</span>
          </div>
        </div>
      )}

      {/* Owl PNG — rises centre-screen, then flies to the laptop screen */}
      {pngOwlOpacity > 0.001 && (
        <img
          className="hero-intro-owl-flight"
          src={owlSrc}
          alt=""
          aria-hidden
          style={{
            position: "fixed",
            left: `${owlCx - owlSize / 2}px`,
            top:  `${owlCy - owlSize / 2}px`,
            width: `${owlSize}px`,
            height: "auto",
            opacity: pngOwlOpacity,
            transform: `scale(${owlRevealScale})`,
            transformOrigin: "center center",
            pointerEvents: "none",
            zIndex: 30,
            willChange: "transform, left, top, width, opacity",
          }}
        />
      )}
    </section>
  );
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 13 L13 3 M6 3 H13 V10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

window.Hero = Hero;
