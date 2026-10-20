// Copies the packages Tauri buries in target/release/bundle/ into
// windows/release/, with the names they ship under. Used by `npm run pack` and
// by the release workflows, so both produce exactly the same file names.
//
// An edition is the same app built with something more in its bundle, given
// by a config file of its own that is kept out of this repository — skins
// that may not be published, say:
//
//   npx tauri build --config <edition.json> && node scripts/pack.mjs --edition <Name>
//
// with, in edition.json: { "bundle": { "resources": { "<dir>/*.png": "skins/" } } }
// (Tauri merges it over tauri.conf.json; skin.rs lists `skins/`). Its packages
// are named Buddybara-<Name>-…, beside the plain ones.

import { readFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = join(root, "target", "release", "bundle");
const outDir = join(root, "release");

const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

const editionAt = process.argv.indexOf("--edition");
const edition = editionAt > 0 ? process.argv[editionAt + 1] ?? "" : "";
if (editionAt > 0 && !/^[A-Za-z0-9]+$/.test(edition)) {
  console.error("--edition takes a name of letters and digits.");
  process.exit(1);
}
/** "Buddybara" or "Buddybara-<edition>": what every package name starts with. */
const app = edition ? `Buddybara-${edition}` : "Buddybara";

// What each platform ships: where Tauri puts it, how to recognise it, and the
// names it is published under (the rolling name, when there is one, always
// points at the latest release).
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const debArch = process.arch === "arm64" ? "arm64" : "amd64";
const PACKAGES = {
  win32: [
    {
      dir: "nsis",
      suffix: "-setup.exe",
      names: [`${app}-Windows-${version}-setup.exe`, `${app}-Windows-setup.exe`],
    },
  ],
  linux: [
    {
      dir: "appimage",
      suffix: ".AppImage",
      names: [`${app}-Linux-${version}-${arch}.AppImage`, `${app}-Linux-${arch}.AppImage`],
    },
    { dir: "deb", suffix: ".deb", names: [`${app}-Linux-${version}-${debArch}.deb`] },
    { dir: "rpm", suffix: ".rpm", names: [`${app}-Linux-${version}-${arch}.rpm`] },
  ],
};

const packages = PACKAGES[process.platform];
if (!packages) {
  console.error(`Nothing to pack on ${process.platform}.`);
  process.exit(1);
}

/** The newest file in `dir` ending with `suffix`, in case an older build is still lying around. */
function newest(dir, suffix) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(suffix));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return files
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

mkdirSync(outDir, { recursive: true });
const written = [];
for (const { dir, suffix, names } of packages) {
  const built = newest(join(bundleRoot, dir), suffix);
  if (!built) {
    console.error(`No *${suffix} in ${join(bundleRoot, dir)} — run \`npm run tauri build\` first.`);
    process.exit(1);
  }
  for (const name of names) {
    const dest = join(outDir, name);
    copyFileSync(built, dest);
    written.push(dest);
  }
}

console.log("\n  Packages ready\n");
for (const f of written) {
  const mb = (statSync(f).size / 1024 / 1024).toFixed(2);
  console.log(`  ${f}  (${mb} MB)`);
}
console.log();
