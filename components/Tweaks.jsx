function Tweaks({ state, setState }) {
  const [visible, setVisible] = React.useState(false);
  const [open, setOpen] = React.useState(true);

  React.useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === "__activate_edit_mode") setVisible(true);
      if (e.data?.type === "__deactivate_edit_mode") setVisible(false);
    };
    window.addEventListener("message", handler);
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
    return () => window.removeEventListener("message", handler);
  }, []);

  if (!visible) return null;

  const update = (patch) => {
    const next = { ...state, ...patch };
    setState(next);
    window.parent.postMessage({ type: "__edit_mode_set_keys", edits: patch }, "*");
  };

  const accents = [
    { name: "Fire", v: "#FF4D00" },
    { name: "Ocean", v: "#256AFF" },
    { name: "Sand", v: "#C5A474" },
    { name: "Coil", v: "#1A1A1A" },
  ];

  return (
    <div className="tweaks">
      <div className="tweaks__head">
        <span className="tweaks__title">◆ Tweaks</span>
        <button className="tweaks__close" onClick={() => setOpen(!open)}>{open ? "+" : "+"}</button>
      </div>
      {open && (
        <>
          <div className="tweaks__row">
            <span className="tweaks__label">Accent</span>
            <div className="tweaks__swatches">
              {accents.map((a) => (
                <button
                  key={a.v}
                  className={`tweaks__swatch ${state.accent === a.v ? "is-on" : ""}`}
                  style={{ background: a.v }}
                  onClick={() => update({ accent: a.v })}
                  title={a.name}
                />
              ))}
            </div>
          </div>
          <div className="tweaks__row">
            <span className="tweaks__label">Hero variant</span>
            <div className="tweaks__seg">
              {["orange", "snow", "coil"].map((v) => (
                <button
                  key={v}
                  className={state.heroVariant === v ? "is-on" : ""}
                  onClick={() => update({ heroVariant: v })}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div className="tweaks__row">
            <span className="tweaks__label">Headline italic</span>
            <div className="tweaks__seg">
              {["serif", "stroke"].map((v) => (
                <button
                  key={v}
                  className={state.italic === v ? "is-on" : ""}
                  onClick={() => update({ italic: v })}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

window.Tweaks = Tweaks;
