function Nav({ onNav }) {
  const [open, setOpen] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  const [visible, setVisible] = React.useState(() => {
    try { return sessionStorage.getItem("wiseai_intro_done") === "1"; } catch (e) { return false; }
  });

  React.useEffect(() => {
    if (visible) return;
    const onReady = () => setVisible(true);
    window.addEventListener("wiseai:intro-done", onReady);
    return () => window.removeEventListener("wiseai:intro-done", onReady);
  }, [visible]);

  const items = [
    ["work", "Work"],
    ["services", "Services"],
    ["process", "Process"],
    ["manifesto", "Manifesto"],
    ["contact", "Contact"],
  ];
  const showMenu = hover || open;
  return (
    <nav
      className={`nav-bubble ${showMenu ? "is-open" : ""} ${visible ? "is-visible" : ""}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-hidden={!visible}
    >
      <button
        className="nav-bubble__icon"
        aria-label="Menu"
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
      >
        <img src={window.__resources && window.__resources.owlTransparent} alt="Wise Ai" />
      </button>

      <div className="nav-bubble__menu" role="menu">
        {items.map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            role="menuitem"
            onClick={(e) => {
              e.preventDefault();
              onNav(id);
              setOpen(false);
              setHover(false);
            }}
          >
            {label}
          </a>
        ))}
        <a
          className="nav-bubble__cta"
          href="#contact"
          onClick={(e) => {
            e.preventDefault();
            onNav("contact");
            setOpen(false);
            setHover(false);
          }}
        >
          Book a call →
        </a>
      </div>
    </nav>
  );
}

window.Nav = Nav;
