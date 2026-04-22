// Uses the real Wise Ai owl logo (cropped, background knocked out)
function OwlMark({ size = 64, variant = "coil", className = "" }) {
  const src =
    variant === "white" ? "assets/owl-white.png" :
    variant === "fire"  ? "assets/owl-fire.png"  :
                          "assets/owl-transparent.png";
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
