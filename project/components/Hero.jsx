// Three.js powered 3D laptop floating on the orange hero.
// Uses primitive geometry (no external GLTF needed).
function HeroLaptop3D() {
  const mountRef = React.useRef(null);
  const rafRef = React.useRef(0);

  React.useEffect(() => {
    if (!window.THREE) return;
    const THREE = window.THREE;
    const mount = mountRef.current;
    if (!mount) return;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    camera.position.set(0, 1.2, 5.5);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    // lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(3, 5, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffd9c2, 0.8);
    rim.position.set(-4, 2, -3);
    scene.add(rim);

    // laptop group
    const laptop = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a,
      metalness: 0.85,
      roughness: 0.35,
    });
    const screenMat = new THREE.MeshStandardMaterial({
      color: 0xff4d00,
      emissive: 0xff4d00,
      emissiveIntensity: 0.35,
      metalness: 0.1,
      roughness: 0.4,
    });

    // base
    const baseGeo = new THREE.BoxGeometry(3.2, 0.12, 2.1);
    const base = new THREE.Mesh(baseGeo, metal);
    base.position.y = -0.06;
    laptop.add(base);

    // lid
    const lid = new THREE.Group();
    const lidGeo = new THREE.BoxGeometry(3.2, 2.0, 0.08);
    const lidMesh = new THREE.Mesh(lidGeo, metal);
    lid.add(lidMesh);
    // screen panel (slightly in front)
    const screenGeo = new THREE.PlaneGeometry(2.95, 1.8);
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.position.z = 0.045;
    lid.add(screen);
    // tiny owl dot
    const dotGeo = new THREE.CircleGeometry(0.05, 24);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.position.set(0, 0, 0.05);
    lid.add(dot);

    lid.position.set(0, 0, -1.0);
    lid.rotation.x = -Math.PI * 0.14; // slightly open tilt
    // pivot lid on its bottom edge
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 0, -1.0);
    lid.position.set(0, 1.0, 0);
    lidPivot.add(lid);
    laptop.add(lidPivot);

    scene.add(laptop);

    let t0 = performance.now();
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      laptop.rotation.y = t * 0.5;
      laptop.rotation.x = Math.sin(t * 0.7) * 0.18;
      laptop.position.y = Math.sin(t * 1.1) * 0.08;
      renderer.render(scene, camera);
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} className="hero__3d" aria-hidden />;
}

function Hero({ variant = "orange" }) {
  const [time, setTime] = React.useState(
    new Date().toLocaleTimeString("en-AU", { hour12: false, timeZone: "Australia/Brisbane" })
  );
  React.useEffect(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString("en-AU", { hour12: false, timeZone: "Australia/Brisbane" })), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <section
      id="top"
      className={`hero hero--${variant} hero--v2`}
      data-screen-label="01 Hero"
    >
      <div className="hero__topbar">
        <span className="hero__kicker">
          <span className="dot" /> Available — Accepting Q3 engagements
        </span>
        <span className="hero__clock">Brisbane · {time}</span>
      </div>

      <div className="hero__stage hero__stage--split">
        <div className="hero__left">
          <div className="hero__wordmark" style={{ fontFamily: "sans-serif" }}>
            <span className="hero__wise" style={{ width: "585px" }}>WISE</span>
            <span className="hero__ai" style={{ fontWeight: 600, textAlign: "right" }}>Ai</span>
          </div>
          <p className="hero__tag">
            AI that saves your team hours, not headlines.
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

        <div className="hero__right">
          <HeroLaptop3D />
        </div>
      </div>
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
function Dot() {
  return <span className="ticker-dot">◆</span>;
}

window.Hero = Hero;
