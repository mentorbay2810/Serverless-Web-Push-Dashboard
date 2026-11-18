const fs = require('node:fs/promises');
const path = require('node:path');
async function main() {
  const [moduleRoot, directory] = process.argv.slice(2);
  if (!moduleRoot || !directory) throw new Error('Supply the bundled Node module directory and the SVG output directory.');
  const sharp = require(require.resolve('sharp', { paths: [path.resolve(moduleRoot)] }));
  const files = (await fs.readdir(directory)).filter(name => name.endsWith('.svg')).sort();
  for (const name of files) await sharp(path.join(directory, name), { density: 288 }).png().toFile(path.join(directory, name.replace(/\.svg$/, '.png')));
  console.log(`Rasterized ${files.length} document figures from their vector sources.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
