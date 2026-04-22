function Marquee() {
  return (
    <div className="marquee" aria-hidden>
      <div className="marquee__track">
        {Array.from({ length: 2 }).map((_, i) => (
          <span key={i} className="marquee__group">
            <span>Audit</span><i>◆</i>
            <span>Deploy</span><i>◆</i>
            <span>Govern</span><i>◆</i>
            <span>Measure</span><i>◆</i>
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
      title: "AI Audit",
      kicker: "Know exactly where AI will save you time — before you spend a penny.",
      body: "Two weeks inside your business. We map your workflows, spot the bottlenecks, and return a clear, prioritised plan for where AI will pay off — and where it won't.",
      items: [
        "Full workflow &amp; stack review",
        "Team time-study across 3–5 roles",
        "Prioritised 90-day roadmap",
        "Executive-ready summary deck",
      ],
      kpi: [["14", "days"], ["38%", "hours freed"], ["£", "fixed fee"]],
    },
    {
      tag: "02",
      title: "Agent Officer",
      kicker: "A deployed AI agent, doing real work — on payroll, on day one.",
      body: "We build and run production AI agents for your team. Each one has a job description, a budget, and measurable KPIs — just like any other hire. Outcome-based pricing available.",
      items: [
        "Agent scoped like a role, not a tool",
        "Guardrails &amp; human oversight built-in",
        "Monthly performance reports",
        "30-day cancellation on any agent",
      ],
      kpi: [["6 wks", "to live"], ["24/7", "on shift"], ["100%", "auditable"]],
    },
  ];
  const s = services[active];

  return (
    <section id="services" className="services" data-screen-label="02 Services">
      <div className="services__header">
        <span className="section-kicker">Services</span>
        <h2 className="section-title">Two services.<br/>One simple promise.</h2>
        <p className="section-lede">
          We find the hours AI can save you, then we build the agents that save them.
          Start with an audit, scale with agents — or both.
        </p>
      </div>

      <div className="services__switch">
        {services.map((sv, i) => (
          <button
            key={i}
            className={`services__tab ${active === i ? "is-active" : ""}`}
            onClick={() => setActive(i)}
          >
            <span className="services__tab-num">0{i+1}</span>
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
            <ServiceDiagram kind={active === 0 ? "audit" : "agent"} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ServiceDiagram({ kind }) {
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
