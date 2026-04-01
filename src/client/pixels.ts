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

	// Two offscreen canvases: one for sharp text, one for blurred halo
	const glyphCanvas = document.createElement("canvas");
	const gctx = glyphCanvas.getContext("2d")!;
	const blurCanvas = document.createElement("canvas");
	const bctx = blurCanvas.getContext("2d", { willReadFrequently: true })!;
	let mask: Uint8Array = new Uint8Array(0);
	let maskW = 0;
	let maskH = 0;
	let lastFw = 0;
	let lastFh = 0;

	function buildTextMask() {
		maskW = cols;
		maskH = rows;
		if (maskW === 0 || maskH === 0) return;

		const fw = maskW * PX;
		const fh = maskH * PX;

		// only resize canvases when dimensions change
		if (fw !== lastFw || fh !== lastFh) {
			glyphCanvas.width = fw;
			glyphCanvas.height = fh;
			blurCanvas.width = fw;
			blurCanvas.height = fh;
			lastFw = fw;
			lastFh = fh;
		}

		// render text glyphs in white
		gctx.clearRect(0, 0, fw, fh);
		gctx.fillStyle = "#fff";

		const root = document.getElementById("root");
		if (!root) return;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			const text = node.textContent;
			if (!text || !text.trim()) continue;
			const parent = node.parentElement;
			if (!parent) continue;
			const style = getComputedStyle(parent);
			gctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			// render per text node line (fast), not per character
			range.selectNodeContents(node);
			const rects = range.getClientRects();
			for (let i = 0; i < rects.length; i++) {
				const rc = rects[i];
				const baseline = rc.bottom - rc.height * 0.18;
				gctx.fillText(text, rc.left, baseline, rc.width);
			}
		}

		// input values/placeholders
		const inputs = root.querySelectorAll("input") as NodeListOf<HTMLInputElement>;
		for (let i = 0; i < inputs.length; i++) {
			const inp = inputs[i];
			const text = inp.value || inp.placeholder;
			if (!text) continue;
			const rc = inp.getBoundingClientRect();
			const style = getComputedStyle(inp);
			gctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			gctx.fillText(text, rc.left, rc.bottom - rc.height * 0.18, rc.width);
		}

		// blur to create halo (GPU-accelerated)
		bctx.clearRect(0, 0, fw, fh);
		bctx.filter = `blur(${PX}px)`;
		bctx.drawImage(glyphCanvas, 0, 0);
		bctx.filter = "none";

		// sample blurred result at grid resolution
		const imgData = bctx.getImageData(0, 0, fw, fh).data;
		mask = new Uint8Array(maskW * maskH);
		const halfPX = PX >> 1;
		for (let gy = 0; gy < maskH; gy++) {
			const py = gy * PX + halfPX;
			for (let gx = 0; gx < maskW; gx++) {
				const px = gx * PX + halfPX;
				mask[gy * maskW + gx] = imgData[(py * fw + px) * 4]; // R channel
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

	function draw(t: number) {
		if (cols === 0 || rows === 0) return;
		const w = canvas.width;
		const h = canvas.height;
		const s = t / 1000;

		// rebuild glyph mask every frame so scrolling/text changes are smooth
		buildTextMask();

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

				// darken near text glyphs using mask
				if (mask.length > 0 && col < maskW && row < maskH) {
					const proximity = mask[row * maskW + col]; // 0-255, 255 = on glyph
					if (proximity > 0) {
						const p = proximity / 255; // 0-1
						const noise = (Math.abs(hash(col, row, 919)) % 1000) / 1000;
						if (noise < p * p) {
							// some pixels go full black (more likely near glyphs)
							r = 0; g = 0; b = 0;
						} else {
							// rest get dimmed proportionally — closer = darker
							const dim = 1.0 - p * 0.7;
							r = (r * dim) | 0;
							g = (g * dim) | 0;
							b = (b * dim) | 0;
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
