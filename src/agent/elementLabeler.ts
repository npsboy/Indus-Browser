import sharp from "sharp";

/** A labelled interactive element. Coordinates are in surface pixels: the space
 * agent:click's x/y and sendInputEvent use (guest DIPs for a webview, host CSS
 * pixels relative to the region for the renderer surface). */
export type LabeledElement = {
    label: string;
    x: number;
    y: number;
    w: number;
    h: number;
    /** A point inside the element that passed the hit-test at extraction time. */
    cx: number;
    cy: number;
    description: string;
};

/** Region of the WebContents' viewport that the screenshot covers. `null` = the whole viewport. */
export type SurfaceRegion = { x: number; y: number; w: number; h: number } | null;

export type ExtractionResult = {
    elements: LabeledElement[];
    /** Where each label lives, for resolveLabeledElementPoint / confirmLabeledClick. */
    labels: LabelMap;
    /** Size of the surface the elements are positioned in (what the screenshot shows). */
    surfaceW: number;
    surfaceH: number;
};

const MAX_ELEMENTS = 600;
// The scripts themselves take ~100-300ms, but they queue behind the page's own
// work, which during a heavy load can take seconds. Without the main frame there
// are no labels at all, so wait for it; ad iframes are skipped sooner.
const MAIN_FRAME_TIMEOUT_MS = 15000;
const SUBFRAME_TIMEOUT_MS = 1500;

/** Where each label of the most recent extraction lives, for re-resolving at click time. */
type LabelEntry = {
    frame: Electron.WebFrameMain;
    /** Index into that frame's window.__indusAgentEls. */
    index: number;
    /** Frame-local CSS px → region-relative CSS px of the top document. */
    ox: number;
    oy: number;
    /** Region-relative CSS px → surface px. */
    scale: number;
};
/** Label → where it lives. Each extraction returns its own, so agents never share one. */
export type LabelMap = Map<string, LabelEntry>;

/**
 * Shared in-page helpers. Injected ahead of every in-page script so they all
 * agree on tree-walking and hit-testing.
 */
const PAGE_HELPERS = `
    const HOOKS = window.__indusAgentHooks || null;

    // Includes closed roots captured by the guest preload's attachShadow hook.
    const getShadowRoot = (el) => el.shadowRoot || (HOOKS && HOOKS.shadowRoots.get(el)) || null;

    // Parent in the composed (rendered) tree: slotted nodes belong to their slot.
    const getParent = (el) => {
        if (el.assignedSlot) return el.assignedSlot;
        if (el.parentElement) return el.parentElement;
        const root = el.getRootNode && el.getRootNode();
        if (root && root.host) return root.host;
        return null;
    };

    // elementFromPoint that descends into shadow roots.
    const deepElementFromPoint = (doc, x, y) => {
        let el = doc.elementFromPoint(x, y);
        for (let depth = 0; el && depth < 30; depth++) {
            const root = getShadowRoot(el);
            if (!root) break;
            const inner = root.elementFromPoint(x, y);
            if (!inner || inner === el) break;
            el = inner;
        }
        return el;
    };

    const composedContains = (ancestor, node) => {
        let cur = node;
        while (cur) {
            if (cur === ancestor) return true;
            cur = getParent(cur);
        }
        return false;
    };

    // Bounding rect, falling back to the union of descendants' rects for boxes
    // that collapse to nothing (e.g. an inline <a> wrapping block content).
    const effectiveRect = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width >= 3 && r.height >= 3) return r;
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        const kids = el.querySelectorAll ? el.querySelectorAll('*') : [];
        for (let i = 0; i < kids.length && i < 60; i++) {
            const k = kids[i].getBoundingClientRect();
            if (k.width <= 0 || k.height <= 0) continue;
            left = Math.min(left, k.left); top = Math.min(top, k.top);
            right = Math.max(right, k.right); bottom = Math.max(bottom, k.bottom);
        }
        if (left === Infinity) return r;
        return { left, top, right, bottom, width: right - left, height: bottom - top };
    };

    // First sample point inside rect where the element is actually the topmost
    // thing under the pointer (i.e. not covered by a modal/overlay).
    const findHitPoint = (el, rect, doc, clip) => {
        const fx = [0.5, 0.25, 0.75, 0.5, 0.5, 0.15, 0.85, 0.15, 0.85, 0.15, 0.85];
        const fy = [0.5, 0.5, 0.5, 0.25, 0.75, 0.5, 0.5, 0.15, 0.15, 0.85, 0.85];
        for (let i = 0; i < fx.length; i++) {
            const x = rect.left + rect.width * fx[i];
            const y = rect.top + rect.height * fy[i];
            if (clip && (x < clip.left || x >= clip.right || y < clip.top || y >= clip.bottom)) continue;
            const hit = deepElementFromPoint(doc, x, y);
            // A point over a child frame belongs to that frame's document, not to el.
            const overChildFrame = hit && hit !== el && (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME');
            if (hit && !overChildFrame && composedContains(el, hit)) return { x, y };
        }
        return null;
    };

    // Rendered text, following slots to their assigned (light DOM) content.
    const composedText = (el) => {
        let text = '';
        const visit = (node, depth) => {
            if (depth > 25 || text.length > 200) return;
            if (node.nodeType === 3) { text += node.textContent + ' '; return; }
            if (node.nodeType !== 1) return;
            if (node.tagName === 'SLOT') {
                const assigned = node.assignedNodes({ flatten: true });
                for (const n of (assigned.length ? assigned : node.childNodes)) visit(n, depth + 1);
                return;
            }
            if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
            const root = getShadowRoot(node);
            for (const n of (root ? root.childNodes : node.childNodes)) visit(n, depth + 1);
        };
        visit(el, 0);
        return text;
    };

    // Every iframe/frame in the document, including inside shadow roots.
    const collectFrames = () => {
        const out = [];
        const stack = [document.documentElement];
        while (stack.length) {
            const el = stack.pop();
            if (!el || el.nodeType !== 1) continue;
            const tag = el.tagName.toLowerCase();
            if (tag === 'iframe' || tag === 'frame') out.push(el);
            const root = getShadowRoot(el);
            if (root) for (const k of root.children) stack.push(k);
            for (const k of el.children) stack.push(k);
        }
        return out;
    };
`;

/**
 * Pass 1 (every frame): listen for a probe token from the parent frame, then
 * post a unique token into each child frame. Matching tokens afterwards tells
 * us which <iframe> element each WebFrameMain lives in — needed for
 * cross-origin frames, which can't be inspected from their parent.
 */
function buildFrameProbeScript(frameKey: string): string {
    return `
        (() => {
            ${PAGE_HELPERS}
            if (!window.__indusProbeListener) {
                window.__indusProbeListener = true;
                window.addEventListener('message', (e) => {
                    const d = e.data;
                    if (d && typeof d === 'object' && typeof d.__indusFrameProbe === 'string' && e.source === window.parent) {
                        window.__indusFrameToken = d.__indusFrameProbe;
                    }
                }, true);
            }
            window.__indusFrameToken = null;
            window.__indusChildFrames = {};
            collectFrames().forEach((f, i) => {
                const token = ${JSON.stringify(frameKey)} + ':' + i;
                window.__indusChildFrames[token] = f;
                try { f.contentWindow.postMessage({ __indusFrameProbe: token }, '*'); } catch {}
            });
            return true;
        })()
    `;
}

/**
 * Pass 2 (per visible frame): label everything interactive inside `clip`
 * (frame-local CSS px). Returns elements in frame-local coordinates plus the
 * visible content box of each child frame so the caller can recurse into it.
 */
function buildExtractionScript(clip: { left: number; top: number; right: number; bottom: number }): string {
    return `
        (() => {
            ${PAGE_HELPERS}
            const CLIP = ${JSON.stringify(clip)};
            const clipArea = Math.max(1, (CLIP.right - CLIP.left) * (CLIP.bottom - CLIP.top));

            const NATIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'summary', 'label', 'option']);
            const INTERACTIVE_ROLES = new Set([
                'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox',
                'radio', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem'
            ]);
            const HANDLER_ATTRS = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'ontouchstart', 'jsaction', 'ng-click', '@click', 'v-on:click', 'x-on:click', 'hx-get', 'hx-post'];
            // Hints for handlers delegated to an ancestor (e.g. jQuery's $(document).on('click', '.close', ...)).
            const DELEGATION_ATTRS = ['data-dismiss', 'data-bs-dismiss', 'data-toggle', 'data-bs-toggle', 'data-action', 'data-target', 'data-bs-target', 'data-href', 'data-url', 'data-link', 'data-close'];
            const CLOSE_WORDS = /(^|[^a-z])(close|dismiss|cancel|exit|clear|remove|delete|hide|skip|no thanks|got it)([^a-z]|$)/i;
            const REACT_HANDLERS = ['onClick', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp', 'onTouchStart', 'onTouchEnd', 'onDoubleClick'];
            const VUE_HANDLERS = ['onClick', 'onMousedown', 'onMouseup', 'onPointerdown', 'onTouchstart', 'onDblclick'];
            const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'br', 'wbr']);

            const truncate = (s, n) => {
                s = (s || '').replace(/\\s+/g, ' ').trim();
                return s.length > n ? s.slice(0, n - 1) + '…' : s;
            };

            const classText = (el) => typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';

            // Click handlers attached in JS, which leave no trace in the markup.
            const hasJsHandler = (el) => {
                if (typeof el.onclick === 'function' || typeof el.onmousedown === 'function' || typeof el.onpointerdown === 'function') return true;
                if (HOOKS && HOOKS.listened.has(el)) return true;
                // React keeps props as own properties on the node; Object.keys avoids walking the prototype chain.
                for (const key of Object.keys(el)) {
                    if (key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$')) {
                        const props = el[key];
                        if (props && REACT_HANDLERS.some(h => typeof props[h] === 'function')) return true;
                    }
                }
                const vei = el._vei; // Vue 3 event invokers
                if (vei && VUE_HANDLERS.some(h => vei[h])) return true;
                return false;
            };

            const closeLike = (el) => {
                const text = [
                    el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.id, classText(el),
                ].filter(Boolean).join(' ');
                return CLOSE_WORDS.test(text);
            };

            // 'strong' = known interactive, 'weak' = heuristically clickable, null = not interactive.
            const classify = (el, style) => {
                const tag = el.tagName.toLowerCase();
                if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return null;
                if (NATIVE_TAGS.has(tag)) return 'strong';
                if (tag === 'a' && (el.hasAttribute('href') || el.hasAttribute('xlink:href'))) return 'strong';
                if ((tag === 'video' || tag === 'audio') && el.hasAttribute('controls')) return 'strong';
                if (INTERACTIVE_ROLES.has((el.getAttribute('role') || '').toLowerCase())) return 'strong';
                if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'strong';
                if (HANDLER_ATTRS.some(a => el.hasAttribute(a))) return 'strong';
                if (hasJsHandler(el)) return 'strong';
                const tabIndex = el.getAttribute('tabindex');
                if (tabIndex !== null && Number(tabIndex) >= 0) return 'weak';
                if (DELEGATION_ATTRS.some(a => el.hasAttribute(a))) return 'weak';
                if (style.cursor === 'pointer') {
                    // Cursor is inherited — only count the element where pointer starts.
                    const parent = getParent(el);
                    const parentCursor = parent && parent.nodeType === 1 ? getComputedStyle(parent).cursor : '';
                    if (parentCursor !== 'pointer') return 'weak';
                }
                if (closeLike(el) && el.children.length <= 3 && (el.textContent || '').trim().length <= 20) return 'weak';
                return null;
            };

            const labelledByText = (el) => {
                const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
                return ids.map(id => { const n = el.ownerDocument.getElementById(id); return n ? n.textContent : ''; }).join(' ');
            };

            const describe = (el) => {
                const tag = el.tagName.toLowerCase();
                const role = el.getAttribute('role');
                const type = (el.getAttribute('type') || '').toLowerCase();
                let head = tag;
                if (type && tag === 'input') head += '[type=' + type + ']';
                if (role) head += '[role=' + role + ']';
                const parts = [head];
                const aria = el.getAttribute('aria-label') || labelledByText(el);
                let text = '';
                if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                    text = aria || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '';
                    if (!text && el.labels && el.labels[0]) text = el.labels[0].innerText;
                } else {
                    text = aria || el.innerText || composedText(el) || el.getAttribute('title') || '';
                    if (!text.trim()) {
                        const inner = el.querySelector && el.querySelector('img[alt], [aria-label], svg title');
                        if (inner) text = inner.getAttribute('alt') || inner.getAttribute('aria-label') || inner.textContent || '';
                    }
                    if (!text.trim() && tag === 'img') text = el.getAttribute('alt') || '';
                }
                if (text && text.trim()) {
                    parts.push('"' + truncate(text, 60) + '"');
                } else {
                    // Icon-only control: give the model whatever naming hints exist.
                    const hint = el.getAttribute('data-testid') || el.id || classText(el);
                    parts.push(hint ? '(icon: ' + truncate(hint, 50) + ')' : '(icon)');
                }
                if ((tag === 'input' || tag === 'textarea') && el.value && !['password', 'checkbox', 'radio'].includes(type)) {
                    parts.push('value="' + truncate(el.value, 40) + '"');
                }
                if (tag === 'select' && el.selectedOptions && el.selectedOptions[0]) {
                    parts.push('selected="' + truncate(el.selectedOptions[0].text, 40) + '"');
                }
                if (el.isContentEditable && tag !== 'input' && tag !== 'textarea') parts.push('(editable)');
                if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') parts.push('(disabled)');
                if (el.checked === true || el.getAttribute('aria-checked') === 'true') parts.push('(checked)');
                if (el.getAttribute('aria-expanded') === 'true') parts.push('(expanded)');
                if (el.getAttribute('aria-selected') === 'true') parts.push('(selected)');
                return parts.join(' ');
            };

            const nearlySameRect = (a, b) =>
                Math.abs(a.left - b.left) < 4 && Math.abs(a.top - b.top) < 4 &&
                Math.abs(a.width - b.width) < 8 && Math.abs(a.height - b.height) < 8;

            // When el's centre is covered by another control of about the same size — e.g. a
            // transparent <input> laid over a button's visible label, as Amazon's a-button does —
            // that control is what a real click hits and what carries the action. Clicking el
            // somewhere it pokes out from under it would reach el but do nothing.
            const findCoveringControl = (el, rect) => {
                const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
                if (cx < CLIP.left || cx >= CLIP.right || cy < CLIP.top || cy >= CLIP.bottom) return null;
                const hit = deepElementFromPoint(document, cx, cy);
                if (!hit || composedContains(el, hit) || hit.tagName === 'IFRAME' || hit.tagName === 'FRAME') return null;
                const elArea = rect.width * rect.height;
                let cand = hit;
                for (let hops = 0; cand && hops < 4; hops++, cand = getParent(cand)) {
                    if (cand.nodeType !== 1 || cand === document.body || cand === document.documentElement) break;
                    const r = cand.getBoundingClientRect();
                    const area = r.width * r.height;
                    if (area > 4 * elArea) break; // a backdrop or container, not an overlay of el
                    const overlap = Math.max(0, Math.min(r.right, rect.right) - Math.max(r.left, rect.left)) *
                        Math.max(0, Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top));
                    if (overlap >= 0.6 * elArea && classify(cand, getComputedStyle(cand))) return cand;
                }
                return null;
            };

            const accepted = new Map(); // element -> rect
            const stored = [];
            const storedSet = new Set();
            const out = [];

            const stack = [document.documentElement];
            while (stack.length) {
                const el = stack.pop();
                if (!el || el.nodeType !== 1) continue;
                const tag = el.tagName.toLowerCase();
                if (SKIP_TAGS.has(tag)) continue;

                // Children pushed in reverse so we visit in document order.
                const root = getShadowRoot(el);
                const kids = root ? [...root.children, ...el.children] : [...el.children];
                for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);

                // Frames are labelled from inside (see the caller), not as a whole.
                if (tag === 'iframe' || tag === 'frame') continue;

                const style = getComputedStyle(el);
                if (style.visibility !== 'visible' || style.display === 'none' || style.display === 'contents') continue;

                const kind = classify(el, style);
                if (!kind) continue;

                const rect = effectiveRect(el);
                if (rect.width < 3 || rect.height < 3) continue;
                if (rect.right <= CLIP.left || rect.bottom <= CLIP.top || rect.left >= CLIP.right || rect.top >= CLIP.bottom) continue;

                // Page-sized wrappers (app roots, backdrops) aren't useful targets — but keep
                // large real controls (video players, big links) unless they fill the screen.
                const visibleArea = (Math.min(rect.right, CLIP.right) - Math.max(rect.left, CLIP.left)) *
                    (Math.min(rect.bottom, CLIP.bottom) - Math.max(rect.top, CLIP.top));
                const isTextEntry = tag === 'input' || tag === 'textarea' || el.isContentEditable;
                if (!isTextEntry && (visibleArea > 0.9 * clipArea || (kind === 'weak' && visibleArea > 0.5 * clipArea))) continue;

                // Skip a duplicate of an already-labelled ancestor (e.g. <a><button></button></a>).
                let anc = getParent(el);
                let duplicate = false;
                for (let hops = 0; anc && hops < 6; hops++, anc = getParent(anc)) {
                    const ancRect = accepted.get(anc);
                    if (ancRect && nearlySameRect(ancRect, rect)) { duplicate = true; break; }
                }
                if (duplicate) continue;

                const cover = findCoveringControl(el, rect);
                const target = cover || el;
                if (storedSet.has(target)) continue; // the overlay was already labelled on its own
                const hit = cover
                    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
                    : findHitPoint(el, rect, document, CLIP);
                if (!hit) continue;

                accepted.set(el, rect);
                const left = Math.max(rect.left, CLIP.left);
                const top = Math.max(rect.top, CLIP.top);
                const right = Math.min(rect.right, CLIP.right);
                const bottom = Math.min(rect.bottom, CLIP.bottom);
                // Overlays are often unnamed; el is what's visible, so it describes the control better.
                let description = describe(target);
                if (cover && description.includes('(icon')) description = describe(el);
                out.push({
                    index: stored.length,
                    weak: kind === 'weak' && !(cover && classify(cover, getComputedStyle(cover)) === 'strong'),
                    x: left, y: top, w: right - left, h: bottom - top,
                    cx: hit.x, cy: hit.y,
                    description,
                });
                stored.push(target);
                storedSet.add(target);
            }
            window.__indusAgentEls = stored;

            // Visible content box of each child frame, in this frame's coordinates.
            const frames = {};
            for (const [token, f] of Object.entries(window.__indusChildFrames || {})) {
                if (!f.isConnected) continue;
                const r = f.getBoundingClientRect();
                if (r.width < 3 || r.height < 3) continue;
                if (!findHitPoint(f, r, document, CLIP)) continue; // hidden or covered
                const cs = getComputedStyle(f);
                const padL = parseFloat(cs.paddingLeft || '0'), padT = parseFloat(cs.paddingTop || '0');
                const padR = parseFloat(cs.paddingRight || '0'), padB = parseFloat(cs.paddingBottom || '0');
                const originX = r.left + f.clientLeft + padL;
                const originY = r.top + f.clientTop + padT;
                const visible = {
                    left: Math.max(originX, CLIP.left),
                    top: Math.max(originY, CLIP.top),
                    right: Math.min(originX + f.clientWidth - padL - padR, CLIP.right),
                    bottom: Math.min(originY + f.clientHeight - padT - padB, CLIP.bottom),
                };
                if (visible.right - visible.left < 3 || visible.bottom - visible.top < 3) continue;
                frames[token] = { originX, originY, visible };
            }

            return { elements: out, frames };
        })()
    `;
}

// Uses WebFrameMain rather than WebContents.executeJavaScript, which waits for the
// page to finish loading — on ad-heavy pages that can be never.
async function runInFrame<T>(frame: Electron.WebFrameMain, code: string): Promise<T | null> {
    try {
        if (frame.detached) return null;
        let timer: NodeJS.Timeout | undefined;
        const ms = frame.parent ? SUBFRAME_TIMEOUT_MS : MAIN_FRAME_TIMEOUT_MS;
        const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); });
        const result = await Promise.race([frame.executeJavaScript(code) as Promise<T>, timeout]);
        clearTimeout(timer);
        return result;
    } catch {
        return null;
    }
}

type Rect = { left: number; top: number; right: number; bottom: number };
type RawElement = { index: number; weak: boolean; x: number; y: number; w: number; h: number; cx: number; cy: number; description: string };
type FrameGeometry = { originX: number; originY: number; visible: Rect };
type FrameResult = { elements: RawElement[]; frames: Record<string, FrameGeometry> };

/**
 * Finds every visible, unobstructed interactive element on the surface — in
 * the page, its shadow roots and all of its frames, cross-origin included —
 * and remembers where each one lives so a later click can re-resolve it.
 */
export async function extractInteractiveElements(
    wc: Electron.WebContents,
    region: SurfaceRegion
): Promise<ExtractionResult> {
    const mainFrame = wc.mainFrame;
    const frames = mainFrame.framesInSubtree.filter(f => !f.detached);
    const keyOf = (f: Electron.WebFrameMain) => String(f.frameTreeNodeId);

    // Region-relative CSS px → surface px. Guest sendInputEvent coordinates are
    // DIPs, i.e. CSS px × page zoom. The renderer region is already in surface px.
    const scale = region ? 1 : wc.getZoomFactor();

    // Pass 1: map child frames to their <iframe> elements.
    const tokens = new Map<Electron.WebFrameMain, string>();
    if (frames.length > 1) {
        await Promise.all(frames.map(f => runInFrame(f, buildFrameProbeScript(keyOf(f)))));
        await new Promise<void>(resolve => setTimeout(resolve, 80)); // let postMessage deliver
        await Promise.all(frames.filter(f => f !== mainFrame).map(async f => {
            const token = await runInFrame<string | null>(f, "window.__indusFrameToken || null");
            if (typeof token === "string") tokens.set(f, token);
        }));
    }

    // Pass 2: extract top-down, so each frame's offset/clip comes from its parent.
    const viewport = await runInFrame<{ w: number; h: number }>(mainFrame, "({ w: window.innerWidth, h: window.innerHeight })");
    if (!viewport) {
        return { elements: [], labels: new Map(), surfaceW: (region?.w ?? 1) * scale, surfaceH: (region?.h ?? 1) * scale };
    }
    const r = region ?? { x: 0, y: 0, w: viewport.w, h: viewport.h };
    type Job = { frame: Electron.WebFrameMain; ox: number; oy: number; clip: Rect };
    const queue: Job[] = [{
        frame: mainFrame,
        ox: -r.x,
        oy: -r.y,
        clip: { left: Math.max(0, r.x), top: Math.max(0, r.y), right: Math.min(viewport.w, r.x + r.w), bottom: Math.min(viewport.h, r.y + r.h) },
    }];

    const collected: { raw: RawElement; entry: LabelEntry }[] = [];
    while (queue.length) {
        const job = queue.shift()!;
        const result = await runInFrame<FrameResult>(job.frame, buildExtractionScript(job.clip));
        if (!result || !Array.isArray(result.elements)) continue;
        for (const raw of result.elements) {
            collected.push({
                raw: { ...raw, x: raw.x + job.ox, y: raw.y + job.oy, cx: raw.cx + job.ox, cy: raw.cy + job.oy },
                entry: { frame: job.frame, index: raw.index, ox: job.ox, oy: job.oy, scale },
            });
        }
        const parentKey = keyOf(job.frame);
        for (const [child, token] of tokens) {
            if (!token.startsWith(parentKey + ":")) continue;
            const geo = result.frames?.[token];
            if (!geo) continue;
            queue.push({
                frame: child,
                ox: job.ox + geo.originX,
                oy: job.oy + geo.originY,
                clip: {
                    left: geo.visible.left - geo.originX,
                    top: geo.visible.top - geo.originY,
                    right: geo.visible.right - geo.originX,
                    bottom: geo.visible.bottom - geo.originY,
                },
            });
        }
    }

    // Over the cap: drop heuristic-only matches first, keep page order otherwise.
    let kept = collected;
    if (kept.length > MAX_ELEMENTS) {
        const strongCount = kept.filter(c => !c.raw.weak).length;
        let weakBudget = Math.max(0, MAX_ELEMENTS - strongCount);
        kept = kept.filter(c => !c.raw.weak || weakBudget-- > 0).slice(0, MAX_ELEMENTS);
    }

    const labels: LabelMap = new Map();
    const elements: LabeledElement[] = kept.map((c, i) => {
        const label = String(i + 1);
        labels.set(label, c.entry);
        return {
            label,
            x: Math.round(c.raw.x * scale),
            y: Math.round(c.raw.y * scale),
            w: Math.round(c.raw.w * scale),
            h: Math.round(c.raw.h * scale),
            cx: Math.round(c.raw.cx * scale),
            cy: Math.round(c.raw.cy * scale),
            description: c.raw.description,
        };
    });
    return { elements, labels, surfaceW: r.w * scale, surfaceH: r.h * scale };
}

/**
 * Re-locates a labelled element right before clicking it, so small layout
 * shifts since the screenshot don't make the click miss, scrolling it into
 * view if needed. Also arms a probe that records whether the native click
 * actually reaches the element (see confirmLabeledClick).
 * Returns the point in surface px, or null if the element is gone.
 */
export async function resolveLabeledElementPoint(labels: LabelMap, label: string): Promise<{ x: number; y: number } | null> {
    const entry = labels.get(label);
    if (!entry) return null;
    const result = await runInFrame<{ x: number; y: number }>(entry.frame, `
        (() => {
            ${PAGE_HELPERS}
            const el = (window.__indusAgentEls || [])[${entry.index}];
            if (!el || !el.isConnected) return null;
            let rect = effectiveRect(el);
            if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) {
                el.scrollIntoView({ block: 'center', inline: 'center' });
                rect = effectiveRect(el);
            }
            const prev = window.__indusClickProbe;
            if (prev) for (const type of ['pointerdown', 'mousedown', 'click']) prev.el.removeEventListener(type, prev.handler, true);
            const hit = findHitPoint(el, rect, document, null);
            const point = { x: hit ? hit.x : rect.left + rect.width / 2, y: hit ? hit.y : rect.top + rect.height / 2 };
            // Any trusted press/click inside el counts: some controls act on mousedown.
            const probe = { el, point, reached: false, handler: null };
            probe.handler = (e) => { if (e.isTrusted) probe.reached = true; };
            for (const type of ['pointerdown', 'mousedown', 'click']) el.addEventListener(type, probe.handler, true);
            window.__indusClickProbe = probe;
            return point;
        })()
    `);
    if (!result || typeof result.x !== "number" || typeof result.y !== "number") return null;
    return {
        x: Math.round((result.x + entry.ox) * entry.scale),
        y: Math.round((result.y + entry.oy) * entry.scale),
    };
}

/**
 * Call after sending the native click for a label. If the trusted click never
 * reached the element (a transparent overlay ate it, or it is in a
 * cross-origin iframe that native input doesn't reach), replay the full
 * pointer/mouse sequence on the element from JS — so mousedown-driven
 * controls work too. Only the labelled element is targeted — never "whatever
 * is at that point now", which after closing a popup is the page underneath.
 * Returns true if the native click landed.
 */
export async function confirmLabeledClick(labels: LabelMap, label: string): Promise<boolean> {
    const entry = labels.get(label);
    if (!entry) return false;
    const reached = await runInFrame<boolean>(entry.frame, `
        (() => {
            ${PAGE_HELPERS}
            const probe = window.__indusClickProbe;
            if (!probe) return false;
            window.__indusClickProbe = null;
            for (const type of ['pointerdown', 'mousedown', 'click']) probe.el.removeEventListener(type, probe.handler, true);
            if (probe.reached) return true;
            const el = probe.el;
            if (!el.isConnected) return false;
            const { x, y } = probe.point;
            const under = deepElementFromPoint(document, x, y);
            const target = under && composedContains(el, under) ? under : el;
            const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
            const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
            target.dispatchEvent(new PointerEvent('pointerover', pointer));
            target.dispatchEvent(new MouseEvent('mouseover', base));
            target.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
            target.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
            if (typeof el.focus === 'function') el.focus({ preventScroll: true });
            target.dispatchEvent(new PointerEvent('pointerup', pointer));
            target.dispatchEvent(new MouseEvent('mouseup', base));
            // click() also runs default actions (follow links, toggle checkboxes) and is a no-op when disabled.
            if (typeof target.click === 'function') target.click();
            else target.dispatchEvent(new MouseEvent('click', base));
            return false;
        })()
    `);
    return reached === true;
}

/** Text list sent alongside the screenshot so the model can match labels to elements. */
export function formatElementList(elements: LabeledElement[]): string {
    if (elements.length === 0) return "No interactive elements were detected on the current screen.";
    return elements.map(e => `[${e.label}] ${e.description}`).join("\n");
}

const LABEL_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080", "#9a6324", "#800000", "#000075", "#d6007a"];
const TAG_FONT_SIZE = 12;
const TAG_HEIGHT = 15;

/** Draws a coloured box and a numbered tag over every element. `scale` maps
 * surface pixels to screenshot pixels. */
export async function drawElementLabels(
    base64Image: string,
    elements: LabeledElement[],
    scale: number
): Promise<string> {
    const raw = base64Image.replace(/^data:image\/\w+;base64,/, "");
    if (!raw) throw new Error("drawElementLabels: base64Image is empty");
    const buf = Buffer.from(raw, "base64");
    const meta = await sharp(buf).metadata();
    const W = meta.width!;
    const H = meta.height!;

    let boxes = "";
    let tags = "";
    const placedTags: { x: number; y: number; w: number }[] = [];
    elements.forEach((el, i) => {
        const color = LABEL_COLORS[i % LABEL_COLORS.length];
        const x = Math.round(el.x * scale);
        const y = Math.round(el.y * scale);
        const w = Math.max(2, Math.round(el.w * scale));
        const h = Math.max(2, Math.round(el.h * scale));
        boxes += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="1.5"/>`;

        const tagW = el.label.length * 7.5 + 6;
        // Sit the tag just above the box's top-left corner; inside the box if there's no room above.
        let tagX = Math.min(Math.max(0, x), W - tagW);
        const tagY = y >= TAG_HEIGHT ? y - TAG_HEIGHT : Math.min(y, H - TAG_HEIGHT);
        // Nudge right past any tag already drawn in the same spot so numbers stay readable.
        for (let tries = 0; tries < 4; tries++) {
            const clash = placedTags.find(t => tagX < t.x + t.w && tagX + tagW > t.x && tagY < t.y + TAG_HEIGHT && tagY + TAG_HEIGHT > t.y);
            if (!clash || clash.x + clash.w + 1 + tagW > W) break;
            tagX = clash.x + clash.w + 1;
        }
        placedTags.push({ x: tagX, y: tagY, w: tagW });
        tags += `<rect x="${tagX}" y="${tagY}" width="${tagW}" height="${TAG_HEIGHT}" fill="${color}"/>`;
        tags += `<text x="${tagX + tagW / 2}" y="${tagY + TAG_HEIGHT - 3.5}" font-size="${TAG_FONT_SIZE}" font-family="Arial, sans-serif" font-weight="bold" fill="#ffffff" text-anchor="middle">${el.label}</text>`;
    });

    // Tags drawn after all boxes so no box outline crosses a number.
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${boxes}${tags}</svg>`;
    const outputBuf = await sharp(buf)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .jpeg({ quality: 70 })
        .toBuffer();
    return `data:image/jpeg;base64,${outputBuf.toString("base64")}`;
}
