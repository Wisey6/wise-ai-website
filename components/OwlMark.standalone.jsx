// Uses the real Wise Ai owl logo (cropped, background knocked out)
function OwlMark({ size = 64, variant = "coil", className = "" }) {
  const R = (window.__resources || {});
  const src =
    variant === "white" ? R.owlWhite :
    variant === "fire"  ? R.owlFire  :
                          R.owlTransparent;
  return (
    <img
      className={className}
      src={src}
      style={{ width: "60px", height: "auto", display: "block" }}
      alt="Wise Ai owl"
    />
  );
}

window.OwlMark = OwlMark;
