function Process() {
  const steps = [
    { n: "01", t: "Listen", d: "Two weeks shadowing your team to understand how work actually happens — no slides, just questions." },
    { n: "02", t: "Map", d: "We show you where hours are lost, where money leaks, and where AI can actually help." },
    { n: "03", t: "Prioritise", d: "Together we pick the three highest-value wins. No boil-the-ocean projects." },
    { n: "04", t: "Deploy", d: "Agents ship in 2–3 week sprints. Each one has a name, a role, and clear KPIs." },
    { n: "05", t: "Govern", d: "Evals, guardrails, audit logs, human oversight. The essentials, done properly." },
    { n: "06", t: "Grow", d: "Hours saved get reinvested into the next agent. The programme pays for itself." },
  ];
  return (
    <section id="process" className="process" data-screen-label="03 Process">
      <div className="process__head">
        <span className="section-kicker section-kicker--light">Process</span>
        <h2 className="section-title">Six steps. No jargon.</h2>
      </div>
      <ol className="process__list">
        {steps.map((s) => (
          <li key={s.n} className="process__item">
            <span className="process__n">{s.n}</span>
            <h3 className="process__t">{s.t}</h3>
            <p className="process__d">{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Proof() {
  const cases = [
    { client: "Ledger Mills", sector: "Manufacturing", stat: "41%", stat_label: "Hours returned to ops", quote: "They replaced the spreadsheet, not the team. We got our Friday afternoons back.", person: "COO" },
    { client: "Harcourt & Vine", sector: "Professional services", stat: "3.2×", stat_label: "Throughput per associate", quote: "The audit was the best money we spent last year. The agents came second.", person: "Managing Partner" },
    { client: "Cobalt Logistics", sector: "Logistics", stat: "£480k", stat_label: "Annual savings", quote: "A clear, honest read on what AI can and can't do for us.", person: "CFO" },
  ];
  return (
    <section id="work" className="proof" data-screen-label="04 Proof">
      <div className="proof__head">
        <span className="section-kicker">Selected work</span>
        <h2 className="section-title">Real clients.<br/>Real numbers.</h2>
      </div>
      <div className="proof__grid">
        {cases.map((c, i) => (
          <article key={i} className="proof__card">
            <div className="proof__card-top">
              <span className="proof__client">{c.client}</span>
              <span className="proof__sector">{c.sector}</span>
            </div>
            <div className="proof__stat">
              <span className="proof__stat-big">{c.stat}</span>
              <span className="proof__stat-small">{c.stat_label}</span>
            </div>
            <blockquote className="proof__quote">{c.quote}</blockquote>
            <div className="proof__card-bot">
              <span>— {c.person}</span>
              <a href="#" className="proof__link">Read case <Arrow /></a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

window.Process = Process;
window.Proof = Proof;
