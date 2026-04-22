function Nav({ onNav }) {
  const [open, setOpen] = React.useState(false);
  const [hover, setHover] = React.useState(false);
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
      className={`nav-bubble ${showMenu ? "is-open" : ""}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
