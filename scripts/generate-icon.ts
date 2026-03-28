import sharp from "sharp";
import path from "path";
import fs from "fs";

// Filament DB icon: a filament spool front-view with the hub replaced by
// a database cylinder (stacked disks). Filament wraps around the outside,
// and the center shows the classic DB symbol.
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a1a2e"/>
      <stop offset="100%" stop-color="#16213e"/>
    </linearGradient>
    <linearGradient id="filament" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FF8C00"/>
      <stop offset="50%" stop-color="#FF6600"/>
      <stop offset="100%" stop-color="#E85D00"/>
    </linearGradient>
    <linearGradient id="flange" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#5a5a6a"/>
      <stop offset="100%" stop-color="#3a3a4a"/>
    </linearGradient>
    <linearGradient id="db-body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4ECDC4"/>
      <stop offset="100%" stop-color="#2AB7AD"/>
    </linearGradient>
    <linearGradient id="db-top" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#6EE7DF"/>
      <stop offset="100%" stop-color="#4ECDC4"/>
    </linearGradient>
  </defs>

  <!-- Background rounded square -->
  <rect x="0" y="0" width="1024" height="1024" rx="200" fill="url(#bg)"/>

  <!-- Outer flange ring -->
  <circle cx="512" cy="512" r="390" fill="url(#flange)" opacity="0.5"/>
  <circle cx="512" cy="512" r="390" fill="none" stroke="#6a6a7a" stroke-width="6" opacity="0.6"/>

  <!-- Filament wrap band -->
  <circle cx="512" cy="512" r="370" fill="url(#filament)" opacity="0.95"/>

  <!-- Filament wrap texture rings -->
  <circle cx="512" cy="512" r="360" fill="none" stroke="#FF9933" stroke-width="5" opacity="0.35"/>
  <circle cx="512" cy="512" r="340" fill="none" stroke="#FF7700" stroke-width="4" opacity="0.3"/>
  <circle cx="512" cy="512" r="320" fill="none" stroke="#FF9933" stroke-width="5" opacity="0.25"/>
  <circle cx="512" cy="512" r="300" fill="none" stroke="#FF7700" stroke-width="4" opacity="0.2"/>
  <circle cx="512" cy="512" r="280" fill="none" stroke="#FF9933" stroke-width="3" opacity="0.15"/>

  <!-- Inner flange ring -->
  <circle cx="512" cy="512" r="260" fill="url(#flange)" opacity="0.7"/>
  <circle cx="512" cy="512" r="260" fill="none" stroke="#6a6a7a" stroke-width="5" opacity="0.5"/>

  <!-- Hub background -->
  <circle cx="512" cy="512" r="240" fill="url(#bg)" opacity="0.9"/>

  <!-- === Database icon in the center hub === -->

  <!-- DB cylinder body -->
  <path d="M 392 420 L 392 610 Q 392 660 512 660 Q 632 660 632 610 L 632 420"
        fill="url(#db-body)" opacity="0.9"/>

  <!-- DB cylinder body side strokes -->
  <line x1="392" y1="420" x2="392" y2="610" stroke="#2AB7AD" stroke-width="3" opacity="0.6"/>
  <line x1="632" y1="420" x2="632" y2="610" stroke="#2AB7AD" stroke-width="3" opacity="0.6"/>

  <!-- DB bottom ellipse -->
  <ellipse cx="512" cy="610" rx="120" ry="50" fill="url(#db-body)" opacity="0.8"/>
  <ellipse cx="512" cy="610" rx="120" ry="50" fill="none" stroke="#2AB7AD" stroke-width="3" opacity="0.5"/>

  <!-- DB middle disk (data tier line) -->
  <ellipse cx="512" cy="515" rx="120" ry="40" fill="url(#db-body)" opacity="0.5"/>
  <ellipse cx="512" cy="515" rx="120" ry="40" fill="none" stroke="#6EE7DF" stroke-width="2.5" opacity="0.7"/>

  <!-- DB top ellipse (lid) -->
  <ellipse cx="512" cy="420" rx="120" ry="50" fill="url(#db-top)" opacity="0.95"/>
  <ellipse cx="512" cy="420" rx="120" ry="50" fill="none" stroke="#6EE7DF" stroke-width="3" opacity="0.6"/>

  <!-- Data dots on DB face for detail -->
  <circle cx="460" cy="470" r="8" fill="#6EE7DF" opacity="0.6"/>
  <circle cx="490" cy="470" r="8" fill="#6EE7DF" opacity="0.6"/>
  <circle cx="520" cy="470" r="8" fill="#6EE7DF" opacity="0.4"/>

  <circle cx="460" cy="560" r="8" fill="#6EE7DF" opacity="0.5"/>
  <circle cx="490" cy="560" r="8" fill="#6EE7DF" opacity="0.5"/>
  <circle cx="520" cy="560" r="8" fill="#6EE7DF" opacity="0.3"/>
  <circle cx="550" cy="560" r="8" fill="#6EE7DF" opacity="0.5"/>

  <!-- Loose filament end trailing off the spool -->
  <path d="M 852 512 Q 900 470 915 400 Q 930 340 900 290"
        fill="none" stroke="url(#filament)" stroke-width="14" stroke-linecap="round" opacity="0.85"/>

  <!-- Subtle highlight/shine on the spool -->
  <ellipse cx="420" cy="380" rx="100" ry="60" fill="white" opacity="0.05" transform="rotate(-30 420 380)"/>
</svg>
`;

async function generate() {
  const assetsDir = path.join(__dirname, "..", "assets");
  const publicDir = path.join(__dirname, "..", "public");

  // Save SVG
  fs.writeFileSync(path.join(assetsDir, "icon.svg"), SVG.trim());

  // Generate PNGs at various sizes
  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    await sharp(Buffer.from(SVG))
      .resize(size, size)
      .png()
      .toFile(path.join(assetsDir, `icon-${size}.png`));
    console.log(`  ✓ icon-${size}.png`);
  }

  // Generate favicon.ico (use 256px as source)
  await sharp(Buffer.from(SVG))
    .resize(256, 256)
    .png()
    .toFile(path.join(publicDir, "icon-256.png"));

  // Generate the main icon.png for electron-builder (1024px)
  await sharp(Buffer.from(SVG))
    .resize(1024, 1024)
    .png()
    .toFile(path.join(assetsDir, "icon.png"));

  // Generate .ico for Windows (256px PNG works as ico input)
  await sharp(Buffer.from(SVG))
    .resize(256, 256)
    .png()
    .toFile(path.join(assetsDir, "icon.ico.png"));

  // Generate macOS .icns source (1024px is fine, electron-builder handles conversion)

  console.log("\nIcon generation complete!");
  console.log("Assets saved to: assets/");
  console.log("Favicon saved to: public/icon-256.png");
}

generate().catch(console.error);
