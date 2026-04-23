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
  const phases = [
    {
      tag: "01",
      title: "Audit",
      kicker: "Every engagement starts here — know where AI actually fits, before you spend a dollar.",
      body: "Two weeks inside your business. We shadow your team, map the workflows, and measure where hours are being lost. You get a clear, honest read on where AI will pay off — and where it won't.",
      items: [
        "Full workflow &amp; stack review",
        "Time-study across 3–5 key roles",
        "Honest read on where AI fits (and where it doesn't)",
        "Evidence-backed findings document",
      ],
      kpi: [["14", "days"], ["3–5", "roles shadowed"], ["$", "fixed fee"]],
    },
    {
      tag: "02",
      title: "Opportunities",
      kicker: "A prioritised shortlist of the wins that actually matter.",
      body: "We turn the audit into a ranked list of opportunities — scored by hours saved, cost, risk and time-to-value. You decide which ones to pursue; we help you pick.",
      items: [
        "Ranked opportunity register",
        "Effort vs. impact scoring",
        "Clear go / no-go recommendation per item",
        "90-day roadmap with owners &amp; dates",
      ],
      kpi: [["8–12", "opportunities"], ["Top 3", "recommended"], ["90d", "roadmap"]],
    },
    {
      tag: "03",
      title: "Build",
      kicker: "The right AI systems for the job — tools, agents, or both.",
      body: "We design and deploy the systems that fit each opportunity. Sometimes it's an agent on payroll. Sometimes it's a workflow tool, a prompt library, or just better evals. We build what the evidence says you need — nothing more.",
      items: [
        "Agents, tools or workflow automation",
        "Guardrails &amp; human oversight built-in",
        "Evals, audit logs and monthly reporting",
        "Handover to your team when ready",
      ],
      kpi: [["2–3 wks", "per sprint"], ["24/7", "on shift"], ["100%", "auditable"]],
    },
  ];
  const s = phases[active];

  return (
    <section id="services" className="services" data-screen-label="02 Services">
      <div className="services__header">
        <span className="section-kicker">Service</span>
        <h2 className="section-title">One service.<br/>Three phases.</h2>
        <p className="section-lede">
          Every engagement starts with an audit. We then surface the opportunities worth pursuing,
          and build the AI systems — tools, agents, workflows — best suited to each one.
        </p>
      </div>

      <div className="services__switch">
        {phases.map((sv, i) => (
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
            <span className="blink-dot" /> Phase {s.tag} · {s.title}
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
            Start with an audit <Arrow />
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
            <ServiceDiagram kind={["audit","opps","build"][active]} />
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
          INPUT · 5 DOMAINS → OUTPUT · 1 FINDINGS DOC
        </text>
      </svg>
    );
  }
  if (kind === "opps") {
    const rows = [
      { label: "Invoice triage",      impact: 0.92, effort: 0.25 },
      { label: "Sales follow-up",     impact: 0.78, effort: 0.40 },
      { label: "Report generation",   impact: 0.70, effort: 0.30 },
      { label: "Inbox routing",       impact: 0.55, effort: 0.20 },
      { label: "Forecast drafting",   impact: 0.40, effort: 0.60 },
    ];
    return (
      <svg viewBox="0 0 400 220" className="diagram">
        <text x="20" y="22" fontSize="10" fontFamily="var(--font-mono)" fill="currentColor" opacity="0.6">RANKED · IMPACT vs. EFFORT</text>
        {rows.map((r, i) => {
          const y = 44 + i * 30;
          return (
            <g key={i}>
              <text x="20" y={y + 10} fontSize="10" fontFamily="var(--font-mono)" fill="currentColor">{r.label}</text>
              <rect x="150" y={y} width="220" height="14" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3" rx="2"/>
              <rect x="150" y={y} width={220 * r.impact} height="14" fill={i < 3 ? "var(--fire)" : "currentColor"} opacity={i < 3 ? 1 : 0.35} rx="2"/>
              {i < 3 && <text x={378} y={y + 11} fontSize="9" fontFamily="var(--font-mono)" fill="var(--fire)">✓</text>}
            </g>
          );
        })}
      </svg>
    );
  }
  // build
  return (
    <svg viewBox="0 0 400 220" className="diagram">
      <g stroke="currentColor" strokeWidth="1.2" fill="none">
        <circle cx="200" cy="110" r="50" />
        <circle cx="200" cy="110" r="90" strokeDasharray="4 4" />
      </g>
      <text x="200" y="114" textAnchor="middle" fontSize="13" fontFamily="var(--font-display)" fontWeight="700" fill="currentColor">SYSTEM</text>
      {[
        [60, 50, "Agent"],
        [340, 50, "Tools"],
        [60, 180, "Workflow"],
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
