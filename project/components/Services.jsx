function Marquee() {
  return (
    <div className="marquee" aria-hidden>
      <div className="marquee__track">
        {Array.from({ length: 2 }).map((_, i) => (
          <span key={i} className="marquee__group">
            <span>Pre-made</span><i>◆</i>
            <span>Audit</span><i>◆</i>
            <span>Custom</span><i>◆</i>
            <span>Deploy</span><i>◆</i>
            <span>Save hours</span><i>◆</i>
          </span>
        ))}
      </div>
    </div>
  );
}

function Services() {
  const [active, setActive] = React.useState(0);
  const services = [
    {
      tag: "01",
      title: "Pre-made Solutions",
      kicker: "Ready-to-deploy AI for Brisbane SMBs — start saving hours today.",
      body: "No custom builds, no waiting. Pick from our battle-tested playbook: automated lead capture, quote generators, website creation without the hefty SaaS fees, and more. Deploy in days. Pay for results.",
      items: [
        "Automated lead capture &amp; nurture",
        "Smart quote &amp; proposal generators",
        "Website creation (no $300/month fees)",
        "Email automation &amp; scheduling",
        "Customer intake &amp; qualification",
        "Invoice &amp; document processing",
      ],
      kpi: [["7", "days to go live"], ["50-70%", "time saved"], ["Starting", "from $500/mo"]],
    },
    {
      tag: "02",
      title: "AI Audit",
      kicker: "Know exactly where AI will save you time — before you commit any budget.",
      body: "Two weeks inside your business. We map your workflows, spot the bottlenecks, and return a clear, prioritised plan for where AI will pay off — and where it won't.",
      items: [
        "Full workflow &amp; stack review",
        "Team time-study across 3–5 roles",
        "Prioritised 90-day roadmap",
        "Executive-ready summary deck",
      ],
      kpi: [["14", "days"], ["38%", "hours freed"], ["Tailored", "roadmap"]],
    },
    {
      tag: "03",
      title: "Custom Solutions",
      kicker: "AI built exactly for your business — bespoke agents doing your unique work.",
      body: "We build production AI agents tailored to your specific workflows and industry. Each one has clear KPIs, human oversight, and runs on your infrastructure. Scale with agents that fit your business, not the other way around.",
      items: [
        "Custom agent architecture",
        "Guardrails &amp; human oversight",
        "Monthly performance reports",
        "Flexible pricing &amp; cancellation",
      ],
      kpi: [["6 wks", "to live"], ["24/7", "on shift"], ["100%", "auditable"]],
    },
  ];
  const s = services[active];

  return (
    <section id="services" className="services" data-screen-label="02 Services">
      <div className="services__header">
        <span className="section-kicker">Services</span>
        <h2 className="section-title">Three ways to win with AI.<br/>One simple promise.</h2>
        <p className="section-lede">
          Start with pre-made solutions, audit your potential, or go custom.
          We find the hours AI can save you, then we build what saves them.
        </p>
      </div>

      <div className="services__switch">
        {services.map((sv, i) => (
          <button
            key={i}
            className={`services__tab ${active === i ? "is-active" : ""}`}
            onClick={() => setActive(i)}
          >
            <span className="services__tab-num">{String(i+1).padStart(2, '0')}</span>
            <span className="services__tab-name">{sv.title}</span>
          </button>
        ))}
      </div>

      <div className="services__panel">
        <div className="services__panel-lhs">
          <div className="services__panel-label">
            <span className="blink-dot" /> {s.title}
          </div>
          <h3 className="services__panel-kicker">{s.kicker}</h3>
          <p className="services__panel-body">{s.body}</p>
          <ul className="services__panel-list">
            {s.items.map((it, i) => (
              <li key={i}>
                <span className="services__panel-bullet">✓</span>
                <span dangerouslySetInnerHTML={{ __html: it }} />
              </li>
            ))}
          </ul>
          <a href="#contact" className="btn btn--outline">
            Start with {s.title} <Arrow />
          </a>
        </div>
        <div className="services__panel-rhs">
          <div className="services__kpi-stack">
            {s.kpi.map(([big, small], i) => (
              <div key={i} className="services__kpi">
                <span className="services__kpi-big">{big}</span>
                <span className="services__kpi-small">{small}</span>
              </div>
            ))}
          </div>
          <div className="services__diagram">
            <ServiceDiagram kind={active === 0 ? "premade" : active === 1 ? "audit" : "custom"} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ServiceDiagram({ kind }) {
  if (kind === "premade") {
    return (
      <svg viewBox="0 0 400 220" className="diagram">
        {["Email","Documents","Support","Workflows"].map((lbl, i) => (
          <g key={i} transform={`translate(${50 + i*85},${60})`}>
            <rect width="60" height="60" fill="none" stroke="currentColor" strokeWidth="1.2" rx="6"/>
            <text x="30" y="35" textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="currentColor">{lbl}</text>
          </g>
        ))}
        <path d="M80 150 L320 150" stroke="var(--fire)" strokeWidth="2" fill="none" />
        <circle cx="80" cy="150" r="6" fill="var(--fire)" />
        <circle cx="320" cy="150" r="6" fill="var(--fire)" />
        <text x="200" y="190" textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="currentColor" opacity="0.6">
          PICK &amp; DEPLOY · READY IN DAYS
        </text>
      </svg>
    );
  }
  if (kind === "audit") {
    return (
      <svg viewBox="0 0 400 220" className="diagram">
        {["People","Process","Tools","Data","Risk"].map((lbl, i) => (
          <g key={i} transform={`translate(${30 + i*70},${40})`}>
            <rect width="56" height="56" fill="none" stroke="currentColor" strokeWidth="1.2" rx="8"/>
            <text x="28" y="32" textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="currentColor">{lbl}</text>
          </g>
        ))}
        <path d="M60 140 Q 200 190 360 140" stroke="var(--fire)" strokeWidth="2" fill="none" />
        <circle cx="360" cy="140" r="6" fill="var(--fire)" />
        <text x="30" y="205" fontSize="10" fontFamily="var(--font-mono)" fill="currentColor" opacity="0.6">
          INPUT · 5 DOMAINS → OUTPUT · 1 ROADMAP
        </text>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 400 220" className="diagram">
      <g stroke="currentColor" strokeWidth="1.2" fill="none">
        <circle cx="200" cy="110" r="50" />
        <circle cx="200" cy="110" r="90" strokeDasharray="4 4" />
      </g>
      <text x="200" y="114" textAnchor="middle" fontSize="13" fontFamily="var(--font-display)" fontWeight="700" fill="currentColor">AGENT</text>
      {[
        [60, 50, "Intake"],
        [340, 50, "Tools"],
        [60, 180, "Logs"],
        [340, 180, "Humans"],
      ].map(([x, y, l], i) => (
        <g key={i}>
          <line x1="200" y1="110" x2={x} y2={y} stroke="var(--fire)" strokeWidth="1.6" />
          <circle cx={x} cy={y} r="6" fill="var(--fire)" />
          <text x={x} y={y - 12} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="currentColor">{l}</text>
        </g>
      ))}
    </svg>
  );
}

window.Marquee = Marquee;
window.Services = Services;
