import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const publicDir = join(process.cwd(), 'public');
const svgPath = join(publicDir, 'icon-pin.svg');

// הגדלים הנדרשים
const sizes = [
  { name: 'icon-pin-120.png', size: 120 },
  { name: 'icon-pin-152.png', size: 152 },
  { name: 'icon-pin-180.png', size: 180 },
  { name: 'icon-pin-192.png', size: 192 },
  { name: 'icon-pin-512.png', size: 512 },
];

try {
  console.log('קורא את קובץ ה-SVG...');
  const svg = readFileSync(svgPath, 'utf-8');
  
  console.log('יוצר קבצי PNG...');
  
  for (const { name, size } of sizes) {
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: 'width',
        value: size,
      },
    });
    
    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();
    
    const outputPath = join(publicDir, name);
    writeFileSync(outputPath, pngBuffer);
    
    console.log(`✓ נוצר: ${name} (${size}x${size})`);
  }
  
  console.log('\n✅ כל הקבצים נוצרו בהצלחה!');
} catch (error) {
  console.error('❌ שגיאה:', error.message);
  process.exit(1);
}


