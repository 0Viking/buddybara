// The desktop Buddybara's own picture (Settings → Customization, skin.rs):
// read back for the engine to draw in the capybara's place, and made from the
// picture the user chooses — scaled down to what he is drawn at and turned
// into a PNG, whatever it was.

import { Bridge } from "../core/bridge";

/** The kept picture's longer side: more than he is ever drawn at (about 150 px on a 200% display). */
const SKIN_PX = 512;

/** The picture he wears, or null for the capybara. */
export async function loadSkin(): Promise<ImageBitmap | null> {
  const bytes = await Bridge.skinGet();
  if (!bytes || bytes.byteLength === 0) return null;
  try {
    return await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  } catch {
    return null;
  }
}

/** A chosen picture as the PNG that is kept, at most SKIN_PX on its longer side. Throws if it can't be read. */
export async function skinPng(file: Blob): Promise<Uint8Array> {
  const picture = await createImageBitmap(file);
  const k = Math.min(1, SKIN_PX / Math.max(picture.width, picture.height));
  const w = Math.max(1, Math.round(picture.width * k));
  const ht = Math.max(1, Math.round(picture.height * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = ht;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(picture, 0, 0, w, ht);
  picture.close();
  const png = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
  if (!png) throw new Error("no PNG");
  return new Uint8Array(await png.arrayBuffer());
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A picture of the skins folder as the PNG that is kept: as it is when it
 * already is a PNG at most SKIN_PX on its longer side — its tile then knows it
 * is the one he wears — and scaled down like a chosen file otherwise.
 */
export async function asSkin(bytes: ArrayBuffer): Promise<Uint8Array> {
  const data = new Uint8Array(bytes);
  if (PNG_SIGNATURE.every((b, i) => data[i] === b)) {
    const picture = await createImageBitmap(new Blob([data], { type: "image/png" }));
    const fits = Math.max(picture.width, picture.height) <= SKIN_PX;
    picture.close();
    if (fits) return data;
  }
  return skinPng(new Blob([data]));
}
