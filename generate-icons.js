const sharp = require("sharp");
const fs = require("fs");

const SVG = fs.readFileSync("./icon.svg");

const sizes = [192, 512];

Promise.all(
  sizes.flatMap((size) => [
    // Regular icon
    sharp(SVG)
      .png()
      .resize(size, size)
      .toFile(`icon-${size}.png`)
      .then(() => console.log(`✓ icon-${size}.png created`)),

    // Maskable icon (with safe zone padding)
    sharp(SVG)
      .png()
      .resize(Math.floor(size * 0.8), Math.floor(size * 0.8))
      .extend({
        top: Math.floor(size * 0.1),
        bottom: Math.floor(size * 0.1),
        left: Math.floor(size * 0.1),
        right: Math.floor(size * 0.1),
        background: { r: 7, g: 8, b: 15, alpha: 1 }, // #07080f
      })
      .toFile(`icon-${size}-maskable.png`)
      .then(() => console.log(`✓ icon-${size}-maskable.png created`)),
  ])
)
  .then(() => {
    console.log("\n✔️  All icons generated!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
