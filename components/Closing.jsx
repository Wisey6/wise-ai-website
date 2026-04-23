function Manifesto() {
  return (
    <section id="manifesto" className="manifesto" data-screen-label="05 Manifesto">
      <div className="manifesto__kicker">
        <span className="section-kicker">Our promise</span>
        <span className="manifesto__sig">Wise Ai · 2024</span>
      </div>
      <p className="manifesto__body">
        AI should buy you <em>time</em>, not headlines.
        We stay until your team actually gets their hours back —
        with an <mark>audit</mark> before deployment, a clear <mark>owner</mark> for every agent,
        and a real <mark>number</mark> on every hour saved.
      </p>
      <div className="manifesto__grid">
        {[
          ["Independent", "No vendor lock-in, no kickbacks. We pick what works for you."],
          ["Outcome-priced", "Pay for hours saved, not for showing up."],
          ["Safe by default", "Guardrails, audit logs, human oversight — always on."],
          ["Plain English", "Clear reports your board can read. No AI jargon."],
        ].map(([t, d], i) => (
          <div key={i} className="manifesto__tenet">
            <span className="manifesto__tenet-n">0{i + 1}</span>
            <h4>{t}</h4>
            <p>{d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Contact() {
  const [sent, setSent] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", company: "", email: "", interest: "Audit", message: "" });
  const submit = (e) => {
    e.preventDefault();
    setSent(true);
  };
  return (
    <section id="contact" className="contact" data-screen-label="06 Contact">
      <div className="contact__lhs">
        <span className="section-kicker section-kicker--light">Contact</span>
        <h2 className="contact__title">
          Book a free<br/>
          <span className="italic">15-minute call.</span>
        </h2>
        <p className="contact__lede">
          Tell us what's taking up your team's time. We'll tell you — honestly —
          whether AI can help, and what it would cost.
        </p>
        <div className="contact__meta">
          <div>
            <span className="contact__meta-k">STUDIO</span>
            <span>Brisbane, QLD, AUS</span>
          </div>
          <div>
            <span className="contact__meta-k">General</span>
            <span>Tyler@wiseai.website<br/>+44 20 7946 0112</span>
          </div>
          <div>
            <span className="contact__meta-k">Hours</span>
            <span>9AM-5PM Mon-Sat</span>
          </div>
        </div>
      </div>

      <form className={`contact__form ${sent ? "is-sent" : ""}`} onSubmit={submit}>
        {sent ? (
          <div className="contact__thanks">
            <span className="contact__check">✓</span>
            <h3>Noted, {form.name.split(" ")[0] || "friend"}.</h3>
            <p>
              We'll be in touch within one working day. In the meantime — the owl
              is watching.
            </p>
            <button type="button" className="btn btn--ghost" onClick={() => { setSent(false); setForm({ name: "", company: "", email: "", interest: "Audit", message: "" }); }}>
              Send another
            </button>
          </div>
        ) : (
          <>
            <div className="form-row">
              <label>
                <span>Your name</span>
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ada Lovelace" />
              </label>
              <label>
                <span>Company</span>
                <input required value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Analytical Engines Ltd" />
              </label>
            </div>
            <label>
              <span>Email</span>
              <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="ada@engines.co" />
            </label>
            <div className="form-chips">
              <span>Interested in</span>
              {["Audit", "Agent Officer", "Both", "Just curious"].map((o) => (
                <button
                  type="button"
                  key={o}
                  className={`chip ${form.interest === o ? "is-on" : ""}`}
                  onClick={() => setForm({ ...form, interest: o })}
                >
                  {o}
                </button>
              ))}
            </div>
            <label>
              <span>What are you tired of doing?</span>
              <textarea rows="4" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="Reconciling invoices. Drafting RFPs. Answering tier-1 support. Everything." />
            </label>
            <button type="submit" className="btn btn--primary btn--full">
              <span>Send message</span>
              <Arrow />
            </button>
            <p className="form-fine">We reply within one working day. No spam, ever.</p>
          </>
        )}
      </form>
    </section>
  );
}

function Footer() {
  const [time, setTime] = React.useState("");
  React.useEffect(() => {
    const u = () => setTime(new Date().toLocaleTimeString("en-GB", { hour12: false }));
    u();
    const t = setInterval(u, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <footer className="footer">
      <div className="footer__big">
        <Wordmark size={180} />
      </div>
      <div className="footer__cols">
        <div>
          <span className="footer__k">Index</span>
          <a href="#services">Services</a>
          <a href="#process">Process</a>
          <a href="#work">Work</a>
          <a href="#manifesto">Manifesto</a>
          <a href="#contact">Contact</a>
        </div>
        <div>
          <span className="footer__k">Elsewhere</span>
          <a href="https://www.linkedin.com/company/wise-ai-solutions" target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>
        </div>
        <div>
          <span className="footer__k">LOCATION</span>
          <span>Brisbane, QLD, Austrlia</span>
          <span>Tyler@wiseai.website</span>
          <span>+61 438560606</span>
        </div>
        <div>
          <span className="footer__k">Now</span>
          <span>BNE · {time}</span>
          <span>Accepting Clients</span>
          <span>{"\n"}</span>
        </div>
      </div>
      <div className="footer__base">
        <span>© Wise Ai Ltd. 2024–{new Date().getFullYear()}. Made quietly in London.</span>
        <span>Registered 14829920 · VAT GB 441 2200 98</span>
      </div>
    </footer>
  );
}

window.Manifesto = Manifesto;
window.Contact = Contact;
window.Footer = Footer;
