import sharp from "sharp";

export interface ScaledImage {
  data: Buffer;
  scaleX: number;
  scaleY: number;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
}

export interface SoMOverlayMark {
  id: string;
  bounds: { left: number; top: number; right: number; bottom: number };
}

/**
 * Determine the scaling strategy based on the model name.
 * - Anthropic/Claude: scale longest side to 1568px
 * - OpenAI (default): scale shortest side to 768px
 */
function getScaleTarget(modelName: string): { side: "short" | "long"; pixels: number } {
  const lower = modelName.toLowerCase();
  if (lower.includes("claude") || lower.includes("anthropic")) {
    return { side: "long", pixels: 1568 };
  }
  // Default: OpenAI-style (short side = 768)
  return { side: "short", pixels: 768 };
}

/**
 * Scale a PNG screenshot for optimal model consumption.
 * When modelName is provided, picks the right strategy per provider:
 * - OpenAI: shortest side → 768px
 * - Anthropic/Claude: longest side → 1568px
 * Returns the scaled image buffer and the scale factors needed to map
 * coordinates from the scaled image back to the original resolution.
 */
export async function scaleScreenshot(
  pngBuffer: Buffer,
  modelName?: string,
): Promise<ScaledImage> {
  const metadata = await sharp(pngBuffer).metadata();
  const origWidth = metadata.width!;
  const origHeight = metadata.height!;

  const target = getScaleTarget(modelName ?? "");
  const referenceSide =
    target.side === "short"
      ? Math.min(origWidth, origHeight)
      : Math.max(origWidth, origHeight);

  // Skip scaling if already at or below target size.
  if (referenceSide <= target.pixels) {
    return {
      data: pngBuffer,
      scaleX: 1,
      scaleY: 1,
      originalWidth: origWidth,
      originalHeight: origHeight,
      width: origWidth,
      height: origHeight,
    };
  }

  const ratio = target.pixels / referenceSide;
  const newWidth = Math.round(origWidth * ratio);
  const newHeight = Math.round(origHeight * ratio);

  const data = await sharp(pngBuffer)
    .resize(newWidth, newHeight, { fit: "inside" })
    .png()
    .toBuffer();

  return {
    data,
    // scaleX/Y: multiply model coordinates by these to get original-resolution coordinates.
    scaleX: origWidth / newWidth,
    scaleY: origHeight / newHeight,
    originalWidth: origWidth,
    originalHeight: origHeight,
    width: newWidth,
    height: newHeight,
  };
}

/**
 * Scale coordinates returned by the model (in scaled-image space)
 * back to the original device resolution, clamping to valid bounds.
 */
/**
 * Draw a debug marker on a scaled screenshot to visualize where the model
 * wants to tap or swipe. Returns annotated PNG buffer.
 */
export async function drawDebugMarker(
  pngBuffer: Buffer,
  action: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number },
): Promise<Buffer> {
  const meta = await sharp(pngBuffer).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const boxSize = 40;
  const half = boxSize / 2;

  let svg: string;

  if (action.type === "tap" && action.x != null && action.y != null) {
    const cx = action.x;
    const cy = action.y;
    svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${cx - half}" y="${cy - half}" width="${boxSize}" height="${boxSize}"
            fill="none" stroke="red" stroke-width="3"/>
      <line x1="${cx}" y1="${cy - half - 10}" x2="${cx}" y2="${cy + half + 10}"
            stroke="red" stroke-width="2"/>
      <line x1="${cx - half - 10}" y1="${cy}" x2="${cx + half + 10}" y2="${cy}"
            stroke="red" stroke-width="2"/>
    </svg>`;
  } else if (
    (action.type === "swipe" || action.type === "drag" || action.type === "long_press_drag") &&
    action.x1 != null && action.y1 != null &&
    action.x2 != null && action.y2 != null
  ) {
    svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${action.x1 - half}" y="${action.y1 - half}" width="${boxSize}" height="${boxSize}"
            fill="none" stroke="red" stroke-width="3"/>
      <rect x="${action.x2 - half}" y="${action.y2 - half}" width="${boxSize}" height="${boxSize}"
            fill="none" stroke="blue" stroke-width="3"/>
      <line x1="${action.x1}" y1="${action.y1}" x2="${action.x2}" y2="${action.y2}"
            stroke="yellow" stroke-width="2" stroke-dasharray="8,4"/>
    </svg>`;
  } else {
    return pngBuffer;
  }

  return sharp(pngBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function drawSetOfMarkOverlay(
  pngBuffer: Buffer,
  marks: SoMOverlayMark[],
): Promise<Buffer> {
  if (!marks.length) {
    return pngBuffer;
  }
  const meta = await sharp(pngBuffer).metadata();
  const width = meta.width!;
  const height = meta.height!;
  const lines: string[] = [];
  const palette = ["#00E5FF", "#FFEE58", "#81C784", "#FF8A65", "#CE93D8", "#4DD0E1"];

  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    const color = palette[i % palette.length];
    const left = Math.max(0, Math.min(width - 1, Math.round(mark.bounds.left)));
    const top = Math.max(0, Math.min(height - 1, Math.round(mark.bounds.top)));
    const right = Math.max(0, Math.min(width - 1, Math.round(mark.bounds.right)));
    const bottom = Math.max(0, Math.min(height - 1, Math.round(mark.bounds.bottom)));
    const boxWidth = Math.max(1, right - left);
    const boxHeight = Math.max(1, bottom - top);
    const label = escapeXml(mark.id);
    const badgeW = Math.max(22, 8 + label.length * 9);
    const badgeH = 20;
    const badgeX = left;
    const badgeY = Math.max(0, top - badgeH);
    lines.push(
      `<rect x="${left}" y="${top}" width="${boxWidth}" height="${boxHeight}" fill="${color}" fill-opacity="0.15" stroke="${color}" stroke-width="2"/>`,
    );
    lines.push(
      `<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="4" ry="4" fill="${color}" stroke="#001018" stroke-width="1"/>`,
    );
    lines.push(
      `<text x="${badgeX + 6}" y="${badgeY + 14}" font-family="Menlo, monospace" font-size="12" font-weight="700" fill="#001018">${label}</text>`,
    );
  }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${lines.join("")}</svg>`;
  return sharp(pngBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

export function scaleCoordinates(
  x: number,
  y: number,
  scaleX: number,
  scaleY: number,
  origWidth: number,
  origHeight: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(Math.round(x * scaleX), origWidth - 1)),
    y: Math.max(0, Math.min(Math.round(y * scaleY), origHeight - 1)),
  };
}
