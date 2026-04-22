// WISE Ai wordmark — WISE bold, Ai at a quarter of the size, aligned to top.
function Wordmark({ size = 28, color = "currentColor", className = "" }) {
  return (
    <span
      className={className}
      style={{
        fontFamily: "var(--font-display)",
        fontWeight: 900,
        letterSpacing: "-0.03em",
        color,
        lineHeight: 0.9,
        display: "inline-flex",
        alignItems: "flex-start",
        gap: size * 0.12,
      }}
    >
      <span style={{ fontSize: size, letterSpacing: "-0.04em" }}>WISE</span>
      <span
        style={{
          fontSize: size * 0.25,
          fontWeight: 800,
          marginTop: size * 0.08,
          letterSpacing: "-0.01em",
        }}
      >
        Ai
      </span>
    </span>
  );
}

window.Wordmark = Wordmark;
