import sharp from "sharp";

// Each quadrant gets its own label border strip on its top (columns) and left (rows).
// The gap between quadrant columns = SMALL_GAP + LABEL_BORDER (room for the right quadrant's row-label strip).
// The gap between quadrant rows    = SMALL_GAP + LABEL_BORDER (room for the bottom quadrant's col-label strip).
const LABEL_BORDER = 24;   // px strip for labels
const SMALL_GAP    = 4;    // px whitespace between quadrant image edges
const FONT_SIZE    = 11;
const BG           = "#d8d8d8";
const GRID_COLOR   = "rgba(255,255,255,0.85)";
const GRID_WIDTH   = 0.7;
const BRIGHTNESS   = 0.85;

/** Convert a 0-based grid-line index to a label like 1a, 1c, 2a … */
function gridLabel(index: number): string {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    return `${Math.floor(index / 26) + 1}${letters[index % 26]}`;
}

export async function processScreenshotForAgent(base64Image: string, cursorPos?: { x: number; y: number }): Promise<string> {
    const raw = base64Image.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(raw, "base64");

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

    // ── 3. Extract 4 quadrants ─────────────────────────────────────────────────
    const qW  = Math.floor(W / 2);
    const qH  = Math.floor(H / 2);
    const qW2 = W - qW;   // right-quadrant width  (handles odd pixels)
    const qH2 = H - qH;   // bottom-quadrant height

    const [q1, q2, q3, q4] = await Promise.all([
        sharp(gridBuf).extract({ left: 0,  top: 0,  width: qW,  height: qH  }).toBuffer(),
        sharp(gridBuf).extract({ left: qW, top: 0,  width: qW2, height: qH  }).toBuffer(),
        sharp(gridBuf).extract({ left: 0,  top: qH, width: qW,  height: qH2 }).toBuffer(),
        sharp(gridBuf).extract({ left: qW, top: qH, width: qW2, height: qH2 }).toBuffer(),
    ]);

    // ── 4. Output canvas layout ────────────────────────────────────────────────
    //
    //  [LB]  Q1-cols  [SG][LB]  Q2-cols
    //  [LB]  Q1-img   [SG][LB]  Q2-img
    //  [SG]
    //  [LB]  Q3-cols  [SG][LB]  Q4-cols
    //  [LB]  Q3-img   [SG][LB]  Q4-img
    //
    //  LB = LABEL_BORDER, SG = SMALL_GAP
    //
    const HGAP = SMALL_GAP + LABEL_BORDER;   // horizontal gap between left and right quadrant groups
    const VGAP = SMALL_GAP + LABEL_BORDER;   // vertical   gap between top  and bottom quadrant groups

    const outW = LABEL_BORDER + qW  + HGAP + qW2;
    const outH = LABEL_BORDER + qH  + VGAP + qH2;

    // Top-left corner of each quadrant image
    const q1x = LABEL_BORDER,              q1y = LABEL_BORDER;
    const q2x = LABEL_BORDER + qW + HGAP,  q2y = LABEL_BORDER;
    const q3x = LABEL_BORDER,              q3y = LABEL_BORDER + qH + VGAP;
    const q4x = LABEL_BORDER + qW + HGAP,  q4y = LABEL_BORDER + qH + VGAP;

    // ── 5. Label SVG ───────────────────────────────────────────────────────────
    let lsvg = `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">`;

    // Fill all non-image areas with BG (entire canvas, images composite on top)
    lsvg += `<rect x="0" y="0" width="${outW}" height="${outH}" fill="${BG}"/>`;

    const ts = `font-size="${FONT_SIZE}" font-family="monospace" fill="#222"`;

    // ── Column labels above each quadrant ──────────────────────────────────────
    for (let i = 0; i <= numCols; i += 2) {
        const imgX = Math.round(i * colStep);
        if (imgX >= W) break;

        if (imgX < qW) {
            // left half → above Q1 and above Q3
            const localX = imgX;
            lsvg += `<text ${ts} x="${q1x + localX}" y="${q1y - 6}" text-anchor="middle">${gridLabel(i)}</text>`;
            lsvg += `<text ${ts} x="${q3x + localX}" y="${q3y - 6}" text-anchor="middle">${gridLabel(i)}</text>`;
        } else {
            // right half → above Q2 and above Q4
            const localX = imgX - qW;
            lsvg += `<text ${ts} x="${q2x + localX}" y="${q2y - 6}" text-anchor="middle">${gridLabel(i)}</text>`;
            lsvg += `<text ${ts} x="${q4x + localX}" y="${q4y - 6}" text-anchor="middle">${gridLabel(i)}</text>`;
        }
    }

    // ── Row labels left of each quadrant ───────────────────────────────────────
    const rowLabelX1 = q1x - 8;                     // left of Q1 and Q3
    const rowLabelX2 = q2x - LABEL_BORDER + (LABEL_BORDER / 2); // centre of Q2/Q4 row-label strip

    for (let i = 0; i <= numRows; i += 2) {
        const imgY = Math.round(i * rowStep);
        if (imgY >= H) break;

        if (imgY < qH) {
            // top half → left of Q1 and left of Q2
            const localY = imgY;
            lsvg += `<text ${ts} x="${rowLabelX1}" y="${q1y + localY}" `
                + `text-anchor="middle" dominant-baseline="middle">${gridLabel(i)}</text>`;
            lsvg += `<text ${ts} x="${rowLabelX2}" y="${q2y + localY}" `
                + `text-anchor="middle" dominant-baseline="middle">${gridLabel(i)}</text>`;
        } else {
            // bottom half → left of Q3 and left of Q4
            const localY = imgY - qH;
            lsvg += `<text ${ts} x="${rowLabelX1}" y="${q3y + localY}" `
                + `text-anchor="middle" dominant-baseline="middle">${gridLabel(i)}</text>`;
            lsvg += `<text ${ts} x="${rowLabelX2}" y="${q4y + localY}" `
                + `text-anchor="middle" dominant-baseline="middle">${gridLabel(i)}</text>`;
        }
    }

    lsvg += "</svg>";

    // ── 6. Cursor overlay ──────────────────────────────────────────────────────
    // If a cursor position is provided (in original W×H screenshot space),
    // transform it into the output canvas space (accounting for quadrant split
    // and label borders) and draw a visible crosshair+circle marker.
    let cursorSvgBuf: Buffer | null = null;
    if (cursorPos) {
        const cx = cursorPos.x;
        const cy = cursorPos.y;
        // Determine which quadrant the cursor falls in and compute output coords.
        let outCX: number;
        let outCY: number;
        if (cx < qW && cy < qH) {
            outCX = q1x + cx;       outCY = q1y + cy;
        } else if (cx >= qW && cy < qH) {
            outCX = q2x + cx - qW;  outCY = q2y + cy;
        } else if (cx < qW && cy >= qH) {
            outCX = q3x + cx;       outCY = q3y + cy - qH;
        } else {
            outCX = q4x + cx - qW;  outCY = q4y + cy - qH;
        }
        const R = 14;  // outer ring radius
        const r = 4;   // inner dot radius
        const arm = R + 10; // crosshair arm length beyond ring
        const cursorSvg =
            `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">` +
            // Shadow/outline for contrast on any background
            `<circle cx="${outCX}" cy="${outCY}" r="${R + 2}" fill="none" stroke="black" stroke-width="3" opacity="0.55"/>` +
            `<line x1="${outCX - arm}" y1="${outCY}" x2="${outCX + arm}" y2="${outCY}" stroke="black" stroke-width="3" opacity="0.55"/>` +
            `<line x1="${outCX}" y1="${outCY - arm}" x2="${outCX}" y2="${outCY + arm}" stroke="black" stroke-width="3" opacity="0.55"/>` +
            // Bright ring + crosshair
            `<circle cx="${outCX}" cy="${outCY}" r="${R}" fill="none" stroke="#ff4444" stroke-width="2"/>` +
            `<line x1="${outCX - arm}" y1="${outCY}" x2="${outCX + arm}" y2="${outCY}" stroke="#ff4444" stroke-width="2"/>` +
            `<line x1="${outCX}" y1="${outCY - arm}" x2="${outCX}" y2="${outCY + arm}" stroke="#ff4444" stroke-width="2"/>` +
            // Inner filled dot
            `<circle cx="${outCX}" cy="${outCY}" r="${r}" fill="#ff4444"/>` +
            `</svg>`;
        // Store cursor SVG buffer for the composite step below.
        cursorSvgBuf = Buffer.from(cursorSvg);
    }

    // ── 7. Composite ──────────────────────────────────────────────────────────
    const compositeInputs: sharp.OverlayOptions[] = [
        { input: Buffer.from(lsvg), top: 0, left: 0 },   // BG + labels first
        { input: q1, top: q1y, left: q1x },
        { input: q2, top: q2y, left: q2x },
        { input: q3, top: q3y, left: q3x },
        { input: q4, top: q4y, left: q4x },
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
