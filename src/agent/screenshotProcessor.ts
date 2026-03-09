import sharp from "sharp";

// Single-image layout: LABEL_BORDER strips on all 4 sides.
const LABEL_BORDER = 24;   // px strip for labels (top, bottom, left, right)
const FONT_SIZE    = 11;
const BG           = "#d8d8d8";
const GRID_COLOR   = "rgba(255,255,255,0.85)";
const GRID_WIDTH   = 0.7;
const BRIGHTNESS   = 0.85;

/** Convert a 0-based grid-line index to a label.
 * Each letter group spans 10 raw indices (0-9→a, 10-19→b, …).
 * Labeled lines step by 2, producing a1,a3,a5,a7,a9,b1,b3,… */
function gridLabel(index: number): string {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    return `${letters[Math.floor(index / 10)]}${(index % 10) + 1}`;
}

export async function processScreenshotForAgent(base64Image: string, cursorPos?: { x: number; y: number }): Promise<string> {
    const raw = base64Image.replace(/^data:image\/\w+;base64,/, "");
    if (!raw) throw new Error("processScreenshotForAgent: base64Image is empty");
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 0) throw new Error("processScreenshotForAgent: decoded buffer is empty");

    const meta = await sharp(buf).metadata();
    const W = meta.width!;
    const H = meta.height!;

    // ── 1. Darken ──────────────────────────────────────────────────────────────
    const darkenedBuf = await sharp(buf).modulate({ brightness: BRIGHTNESS }).toBuffer();

    // ── 2. Grid lines ──────────────────────────────────────────────────────────
    const colStep = W * 0.015;
    const rowStep = H * 0.015;
    const numCols = Math.ceil(1 / 0.015) + 1;
    const numRows = Math.ceil(1 / 0.015) + 1;

    let gridSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
    for (let i = 0; i <= numCols; i++) {
        const x = Math.round(i * colStep);
        gridSvg += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${GRID_COLOR}" stroke-width="${GRID_WIDTH}"/>`;
    }
    for (let i = 0; i <= numRows; i++) {
        const y = Math.round(i * rowStep);
        gridSvg += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${GRID_COLOR}" stroke-width="${GRID_WIDTH}"/>`;
    }
    gridSvg += "</svg>";

    const gridBuf = await sharp(darkenedBuf)
        .composite([{ input: Buffer.from(gridSvg), blend: "over" }])
        .toBuffer();

    // ── 3. Output canvas layout ────────────────────────────────────────────────
    //
    //  LABEL_BORDER  |  image (W × H)  |  LABEL_BORDER
    //  top/bottom strips hold column labels
    //  left/right strips hold row labels
    //
    const outW = LABEL_BORDER + W + LABEL_BORDER;
    const outH = LABEL_BORDER + H + LABEL_BORDER;

    // Top-left corner of the image within the output canvas
    const imgX = LABEL_BORDER;
    const imgY = LABEL_BORDER;

    // ── 4. Label SVG ───────────────────────────────────────────────────────────
    const ts = `font-size="${FONT_SIZE}" font-family="monospace" fill="#222"`;

    let lsvg = `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">`;
    // Background fill for all border strips
    lsvg += `<rect x="0" y="0" width="${outW}" height="${outH}" fill="${BG}"/>`;

    // Column labels — every other grid line, on top and bottom
    for (let i = 0; i <= numCols; i += 2) {
        const imgPx = Math.round(i * colStep);
        if (imgPx > W) break;
        const cx = imgX + imgPx;
        // Top
        lsvg += `<text ${ts} x="${cx}" y="${imgY - 6}" text-anchor="middle">${gridLabel(i)}</text>`;
        // Bottom
        lsvg += `<text ${ts} x="${cx}" y="${imgY + H + LABEL_BORDER - 6}" text-anchor="middle">${gridLabel(i)}</text>`;
    }

    // Row labels — every other grid line, on left and right
    for (let i = 0; i <= numRows; i += 2) {
        const imgPy = Math.round(i * rowStep);
        if (imgPy > H) break;
        const cy = imgY + imgPy;
        // Left
        lsvg += `<text ${ts} x="${LABEL_BORDER / 2}" y="${cy}" text-anchor="middle" dominant-baseline="middle">${gridLabel(i)}</text>`;
        // Right
        lsvg += `<text ${ts} x="${imgX + W + LABEL_BORDER / 2}" y="${cy}" text-anchor="middle" dominant-baseline="middle">${gridLabel(i)}</text>`;
    }

    lsvg += "</svg>";

    // ── 5. Cursor overlay ──────────────────────────────────────────────────────
    // cursorPos is in original W×H screenshot space.
    // In the output canvas it is simply offset by LABEL_BORDER on each side.
    let cursorSvgBuf: Buffer | null = null;
    if (cursorPos) {
        const outCX = imgX + cursorPos.x;
        const outCY = imgY + cursorPos.y;
        const R   = 14;
        const r   = 4;
        const arm = R + 10;
        const cursorSvg =
            `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">` +
            `<circle cx="${outCX}" cy="${outCY}" r="${R + 2}" fill="none" stroke="black" stroke-width="3" opacity="0.55"/>` +
            `<line x1="${outCX - arm}" y1="${outCY}" x2="${outCX + arm}" y2="${outCY}" stroke="black" stroke-width="3" opacity="0.55"/>` +
            `<line x1="${outCX}" y1="${outCY - arm}" x2="${outCX}" y2="${outCY + arm}" stroke="black" stroke-width="3" opacity="0.55"/>` +
            `<circle cx="${outCX}" cy="${outCY}" r="${R}" fill="none" stroke="#ff4444" stroke-width="2"/>` +
            `<line x1="${outCX - arm}" y1="${outCY}" x2="${outCX + arm}" y2="${outCY}" stroke="#ff4444" stroke-width="2"/>` +
            `<line x1="${outCX}" y1="${outCY - arm}" x2="${outCX}" y2="${outCY + arm}" stroke="#ff4444" stroke-width="2"/>` +
            `<circle cx="${outCX}" cy="${outCY}" r="${r}" fill="#ff4444"/>` +
            `</svg>`;
        cursorSvgBuf = Buffer.from(cursorSvg);
    }

    // ── 6. Composite ──────────────────────────────────────────────────────────
    const compositeInputs: sharp.OverlayOptions[] = [
        { input: Buffer.from(lsvg), top: 0, left: 0 },
        { input: gridBuf, top: imgY, left: imgX },
    ];
    if (cursorSvgBuf) {
        compositeInputs.push({ input: cursorSvgBuf, top: 0, left: 0 });
    }

    const outputBuf = await sharp({
        create: {
            width:  outW,
            height: outH,
            channels: 3,
            background: { r: 216, g: 216, b: 216 },
        },
    })
        .composite(compositeInputs)
        .jpeg({ quality: 65 })
        .toBuffer();

    return `data:image/jpeg;base64,${outputBuf.toString("base64")}`;
}
