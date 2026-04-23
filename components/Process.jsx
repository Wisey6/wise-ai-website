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
  const stats = [
    {
      topic: "Productivity",
      scope: "Knowledge work",
      stat: "66%",
      stat_label: "Avg. productivity lift on AI-assisted tasks",
      detail: "Meta-analysis across customer support, coding and professional writing — workers using generative AI completed tasks 66% faster on average.",
      source: "Nielsen Norman Group, 2024",
    },
    {
      topic: "Adoption",
      scope: "Enterprise",
      stat: "78%",
      stat_label: "Of organisations now use AI in ≥1 function",
      detail: "Up from 55% the year prior. Most common uses: marketing and sales, service operations, and software engineering.",
      source: "McKinsey State of AI, 2024",
    },
    {
      topic: "ROI",
      scope: "Implementation",
      stat: "3.7×",
      stat_label: "Return per dollar spent on generative AI",
      detail: "Leading implementers report average returns of $3.70 for every $1 invested, with top-quartile deployments reaching 10×+.",
      source: "IDC / Microsoft, 2024",
    },
  ];
  return (
    <section id="work" className="proof" data-screen-label="04 Proof">
      <div className="proof__head">
        <span className="section-kicker">The numbers</span>
        <h2 className="section-title">What the research<br/>actually says.</h2>
      </div>
      <div className="proof__grid">
        {stats.map((c, i) => (
          <article key={i} className="proof__card">
            <div className="proof__card-top">
              <span className="proof__client">{c.topic}</span>
              <span className="proof__sector">{c.scope}</span>
            </div>
            <div className="proof__stat">
              <span className="proof__stat-big">{c.stat}</span>
              <span className="proof__stat-small">{c.stat_label}</span>
            </div>
            <blockquote className="proof__quote">{c.detail}</blockquote>
            <div className="proof__card-bot">
              <span>Source · {c.source}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

window.Process = Process;
window.Proof = Proof;
