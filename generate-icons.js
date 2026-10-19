const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, 'public', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

const regularSvg = path.join(iconsDir, 'logo.svg');
const maskableSvg = path.join(iconsDir, 'logo-maskable.svg');

async function generate() {
  await sharp(regularSvg).resize(192, 192).png().toFile(path.join(iconsDir, 'icon-192.png'));
  await sharp(regularSvg).resize(512, 512).png().toFile(path.join(iconsDir, 'icon-512.png'));
  await sharp(maskableSvg).resize(512, 512).png().toFile(path.join(iconsDir, 'icon-512-maskable.png'));
  await sharp(regularSvg).resize(180, 180).flatten({ background: '#3B7DD8' }).png().toFile(path.join(iconsDir, 'apple-touch-icon.png'));
  await sharp(regularSvg).resize(32, 32).png().toFile(path.join(iconsDir, 'favicon.png'));
  console.log('Иконки сгенерированы в public/icons/');
}

generate().catch(err => { console.error(err); process.exit(1); });