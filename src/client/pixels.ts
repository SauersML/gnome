const PX = 18;

function hash(x: number, y: number, seed: number = 0): number {
	let h = (x + seed * 137) * 374761393 + (y + seed * 51) * 668265263;
	h = (h ^ (h >> 13)) * 1274126177;
	h = h ^ (h >> 16);
	return h;
}

const WAVELENGTHS = [420, 460, 500, 530, 560, 590, 630, 670];

function wavelengthToXYZ(nm: number): [number, number, number] {
	const t1 = (nm - 442.0) * (nm < 442 ? 0.0624 : 0.0374);
	const t2 = (nm - 599.8) * (nm < 599.8 ? 0.0264 : 0.0323);
	const t3 = (nm - 501.1) * (nm < 501.1 ? 0.0490 : 0.0382);
	const t4 = (nm - 568.8) * (nm < 568.8 ? 0.0213 : 0.0247);
	const t5 = (nm - 530.9) * (nm < 530.9 ? 0.0613 : 0.0322);
	const t6 = (nm - 437.0) * (nm < 437 ? 0.0845 : 0.0278);

	const x = 0.362 * Math.exp(-0.5 * t1 * t1)
		+ 1.056 * Math.exp(-0.5 * t2 * t2)
		- 0.065 * Math.exp(-0.5 * t3 * t3);
	const y = 0.821 * Math.exp(-0.5 * t4 * t4)
		+ 0.286 * Math.exp(-0.5 * t5 * t5);
	const z = 1.217 * Math.exp(-0.5 * t6 * t6)
		+ 0.681 * Math.exp(-0.5 * t3 * t3);
	return [Math.max(0, x), Math.max(0, y), Math.max(0, z)];
}

function xyzToRGB(x: number, y: number, z: number): [number, number, number] {
	return [
		3.2406 * x - 1.5372 * y - 0.4986 * z,
		-0.9689 * x + 1.8758 * y + 0.0415 * z,
		0.0557 * x - 0.2040 * y + 1.0570 * z,
	];
}

const WAVE_XYZ = WAVELENGTHS.map(wavelengthToXYZ);

interface PixelProps {
	ior: number;
	dispersion: number;
	baseAbsCenter: number;
	absWidth: number;
	absStrength: number;
	thickness: number;
	// unique phase offsets per pixel for complex motion
	p1: number;
	p2: number;
	p3: number;
	baseR: number;
	baseG: number;
	baseB: number;
}

function makePixel(col: number, row: number): PixelProps {
	const h1 = hash(col, row);
	const h2 = hash(col, row, 33);
	const h3 = hash(col, row, 66);
	const h4 = hash(col, row, 99);
	const h5 = hash(col, row, 150);

	const typeRoll = (Math.abs(h1) % 1000) / 1000;
	let ior: number;
	if (typeRoll < 0.05) ior = 1.9 + typeRoll * 3;
	else if (typeRoll < 0.2) ior = 1.55 + typeRoll;
	else ior = 1.3 + typeRoll * 0.3;

	const dispersion = 3000 + (Math.abs(h2) % 10000);
	const absCenter = 480 + (Math.abs(h3) % 200);
	const absWidth = 35 + (Math.abs(h3 >> 10) % 50);
	const absStrength = 1.8 + (Math.abs(h4) % 250) / 100;
	const thickness = 0.5 + (Math.abs(hash(col, row, 111)) % 100) / 100 * 0.9;

	const p1 = (Math.abs(h5) % 6283) / 1000;
	const p2 = (Math.abs(hash(col, row, 200)) % 6283) / 1000;
	const p3 = (Math.abs(hash(col, row, 250)) % 6283) / 1000;

	const palIdx = Math.abs(h1 >> 4) % 5;
	const bases: [number, number, number][] = [
		[4, 12, 6], [5, 15, 8], [3, 10, 10],
		[6, 14, 5], [4, 13, 9],
	];
	const [baseR, baseG, baseB] = bases[palIdx];
	const v = ((h1 >> 8) % 4) - 2;

	return {
		ior, dispersion, baseAbsCenter: absCenter, absWidth, absStrength, thickness,
		p1, p2, p3,
		baseR: baseR + v, baseG: baseG + v, baseB: baseB + v,
	};
}

const HALO = 5; // scatter radius in grid cells around text glyphs

export function initPixelCanvas(canvas: HTMLCanvasElement) {
	const ctx = canvas.getContext("2d")!;
	let animId: number;
	let pixels: PixelProps[][] = [];
	let cols = 0;
	let rows = 0;

	// Offscreen canvas to render DOM text and build a glyph mask
	const maskCanvas = document.createElement("canvas");
	const mctx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
	// mask at grid resolution (1 pixel per cell) — we only need per-cell info
	let mask: Uint8Array = new Uint8Array(0); // 0-255 proximity to text glyphs
	let maskW = 0;
	let maskH = 0;

	function buildTextMask() {
		maskW = cols;
		maskH = rows;
		if (maskW === 0 || maskH === 0) return;

		// render at full resolution to capture glyph shapes
		const fw = maskW * PX;
		const fh = maskH * PX;
		maskCanvas.width = fw;
		maskCanvas.height = fh;

		// draw all text from DOM onto offscreen canvas in white
		mctx.clearRect(0, 0, fw, fh);
		mctx.fillStyle = "#fff";

		const root = document.getElementById("root");
		if (!root) return;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			if (!node.textContent || !node.textContent.trim()) continue;
			const parent = node.parentElement;
			if (!parent) continue;
			const style = getComputedStyle(parent);
			mctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			// get per-character rects for accurate positioning
			for (let ci = 0; ci < node.textContent.length; ci++) {
				if (node.textContent[ci].trim() === "") continue;
				range.setStart(node, ci);
				range.setEnd(node, ci + 1);
				const rects = range.getClientRects();
				for (let ri = 0; ri < rects.length; ri++) {
					const rc = rects[ri];
					// fillText at the baseline position
					mctx.fillText(node.textContent[ci], rc.left, rc.bottom - parseFloat(style.fontSize) * 0.18);
				}
			}
		}

		// also render input values/placeholders
		const inputs = root.querySelectorAll("input") as NodeListOf<HTMLInputElement>;
		for (let i = 0; i < inputs.length; i++) {
			const inp = inputs[i];
			const text = inp.value || inp.placeholder;
			if (!text) continue;
			const rc = inp.getBoundingClientRect();
			const style = getComputedStyle(inp);
			mctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			mctx.fillText(text, rc.left, rc.bottom - parseFloat(style.fontSize) * 0.18);
		}

		// read full-res pixels, then build a grid-resolution proximity mask
		// first: binary glyph mask at full res
		const imgData = mctx.getImageData(0, 0, fw, fh).data;

		// for each grid cell, compute distance to nearest glyph pixel
		// step 1: find which cells contain glyph pixels
		const cellHasGlyph = new Uint8Array(maskW * maskH);
		for (let gy = 0; gy < maskH; gy++) {
			for (let gx = 0; gx < maskW; gx++) {
				// check if any full-res pixel in this cell is lit
				let found = false;
				const x0 = gx * PX;
				const y0 = gy * PX;
				for (let py = y0; py < y0 + PX && !found; py++) {
					for (let px = x0; px < x0 + PX && !found; px++) {
						if (imgData[(py * fw + px) * 4 + 3] > 30) found = true;
					}
				}
				if (found) cellHasGlyph[gy * maskW + gx] = 1;
			}
		}

		// step 2: distance field — for each cell, min distance to a glyph cell
		mask = new Uint8Array(maskW * maskH);
		const searchR = HALO;
		for (let gy = 0; gy < maskH; gy++) {
			for (let gx = 0; gx < maskW; gx++) {
				let minD = searchR + 1;
				const y0 = Math.max(0, gy - searchR);
				const y1 = Math.min(maskH - 1, gy + searchR);
				const x0 = Math.max(0, gx - searchR);
				const x1 = Math.min(maskW - 1, gx + searchR);
				for (let sy = y0; sy <= y1; sy++) {
					for (let sx = x0; sx <= x1; sx++) {
						if (cellHasGlyph[sy * maskW + sx]) {
							const dx = gx - sx;
							const dy = gy - sy;
							const d = Math.sqrt(dx * dx + dy * dy);
							if (d < minD) minD = d;
						}
					}
				}
				// encode: 255 = on glyph, fades to 0 at HALO distance
				if (minD <= 0) {
					mask[gy * maskW + gx] = 255;
				} else if (minD < searchR) {
					mask[gy * maskW + gx] = (255 * (1 - minD / searchR)) | 0;
				}
			}
		}
	}

	function build() {
		cols = Math.ceil(canvas.width / PX);
		rows = Math.ceil(canvas.height / PX);
		pixels = [];
		for (let row = 0; row < rows; row++) {
			const r: PixelProps[] = [];
			for (let col = 0; col < cols; col++) r.push(makePixel(col, row));
			pixels.push(r);
		}
	}

	function resize() {
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
		build();
	}

	function spectralPower(nm: number, tempK: number): number {
		const lambda = nm * 1e-9;
		return 1.0 / (Math.pow(lambda, 5) * (Math.exp(1.4388e-2 / (lambda * tempK)) - 1));
	}

	const TEMPS = [3000, 4200, 5500, 7000, 9000];
	const SPECTRA = TEMPS.map((temp) => {
		const sp = WAVELENGTHS.map((nm) => spectralPower(nm, temp));
		const mx = Math.max(...sp);
		return sp.map((s) => s / mx);
	});

	let lastMaskTime = 0;
	function draw(t: number) {
		if (cols === 0 || rows === 0) return;
		const w = canvas.width;
		const h = canvas.height;
		const s = t / 1000;

		// rebuild glyph mask every 200ms (text/scroll may change)
		if (t - lastMaskTime > 200) {
			buildTextMask();
			lastMaskTime = t;
		}

		// 4 lights at different color temperatures, sweeping wide orbits
		const lights = [
			{ x: 0.5 + 0.5 * Math.sin(s * 0.22), y: 0.5 + 0.4 * Math.cos(s * 0.17), power: 0.55, si: 1, radius: 0.6 },
			{ x: 0.5 + 0.45 * Math.cos(s * 0.19), y: 0.5 + 0.45 * Math.sin(s * 0.26), power: 0.45, si: 3, radius: 0.55 },
			{ x: 0.5 + 0.4 * Math.sin(s * 0.31), y: 0.5 + 0.35 * Math.cos(s * 0.24), power: 0.35, si: 0, radius: 0.45 },
			{ x: 0.5 + 0.35 * Math.cos(s * 0.28), y: 0.5 + 0.4 * Math.sin(s * 0.35), power: 0.3, si: 4, radius: 0.45 },
		];

		// 3 large-scale hue waves: rotating direction vectors sweep color bands across screen
		const w1a = s * 0.15, w1dx = Math.cos(w1a), w1dy = Math.sin(w1a);
		const w2a = s * 0.11 + 2.0, w2dx = Math.cos(w2a), w2dy = Math.sin(w2a);
		const w3a = s * 0.08 + 4.5, w3dx = Math.cos(w3a), w3dy = Math.sin(w3a);

		ctx.fillStyle = "#040a05";
		ctx.fillRect(0, 0, w, h);

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const px = pixels[row][col];
				const nx = col / cols;
				const ny = row / rows;

				// --- Complex hue modulation ---
				// Large spatial waves rotate over time, creating sweeping color bands
				const sw1 = Math.sin((nx * w1dx + ny * w1dy) * 8.0 + s * 0.3);
				const sw2 = Math.sin((nx * w2dx + ny * w2dy) * 6.0 + s * 0.25);
				const sw3 = Math.sin((nx * w3dx + ny * w3dy) * 10.0 + s * 0.2);

				// Per-pixel phase creates fine detail; spatial waves create large patterns
				const absShift =
					30 * Math.sin(s * 0.18 + px.p1 + nx * 4 + ny * 3) * (0.6 + 0.4 * sw1)
					+ 20 * Math.sin(s * 0.25 + px.p2 + nx * 2.5 - ny * 3.5) * (0.5 + 0.5 * sw2)
					+ 15 * Math.sin(s * 0.35 + px.p3 - nx * 3 + ny * 2) * (0.5 + 0.5 * sw3);

				const absCenter = px.baseAbsCenter + absShift;
				const thickMod = px.thickness * (0.85 + 0.15 * Math.sin(s * 0.12 + px.p2 + sw1 * 0.5));

				let totalX = 0;
				let totalY = 0;
				let totalZ = 0;

				for (let wi = 0; wi < WAVELENGTHS.length; wi++) {
					const nm = WAVELENGTHS[wi];
					const [wx, wy, wz] = WAVE_XYZ[wi];

					const ior = px.ior + px.dispersion / (nm * nm);

					const absDelta = (nm - absCenter) / px.absWidth;
					const alpha = px.absStrength * Math.exp(-0.5 * absDelta * absDelta);
					const transmission = Math.exp(-alpha * thickMod);

					let intensity = 0;

					for (let li = 0; li < lights.length; li++) {
						const l = lights[li];
						const dx = nx - l.x;
						const dy = ny - l.y;
						const d2 = dx * dx + dy * dy;

						const falloff = l.power * Math.exp(-d2 / (2 * l.radius * l.radius));
						if (falloff < 0.002) continue;

						const r0 = ((1 - ior) / (1 + ior)) ** 2;
						const ct = Math.max(0.01, 1 - Math.sqrt(d2) * 0.6);
						const fresnel = r0 + (1 - r0) * (1 - ct) ** 5;

						intensity += falloff * (1 - fresnel) * transmission * SPECTRA[l.si][wi];
					}

					if (ior > 1.7) {
						const phase = Math.sin(s * 0.5 + col * 0.8 * (ior - 1.3) + row * 1.1)
							* Math.sin(s * 0.3 - col * 0.35 + row * 0.6 * (ior - 1.3));
						if (phase > 0.2) {
							intensity += (ior - 1.5) * (phase - 0.2) * transmission * 0.4;
						}
					}

					totalX += intensity * wx;
					totalY += intensity * wy;
					totalZ += intensity * wz;
				}

				const scale = 65;
				let [lr, lg, lb] = xyzToRGB(totalX * scale, totalY * scale, totalZ * scale);

				let r = px.baseR + lr;
				let g = px.baseG + lg;
				let b = px.baseB + lb;

				r = Math.min(255, Math.max(0, r)) | 0;
				g = Math.min(255, Math.max(0, g)) | 0;
				b = Math.min(255, Math.max(0, b)) | 0;

				// scatter black pixels near text glyphs using mask
				if (mask.length > 0 && col < maskW && row < maskH) {
					const proximity = mask[row * maskW + col]; // 0-255, 255 = on glyph
					if (proximity > 0) {
						// probability of going black: based on proximity + noise
						const prob = proximity / 255;
						const noise = (Math.abs(hash(col, row, 919)) % 1000) / 1000;
						if (noise < prob * prob) {
							r = 0; g = 0; b = 0;
						}
					}
				}

				ctx.fillStyle = `rgb(${r},${g},${b})`;
				ctx.fillRect(col * PX, row * PX, PX, PX);
			}
		}

		animId = requestAnimationFrame(draw);
	}

	resize();
	animId = requestAnimationFrame(draw);
	window.addEventListener("resize", resize);

	return () => {
		cancelAnimationFrame(animId);
		window.removeEventListener("resize", resize);
	};
}
