const PX = 18;

// deterministic hash for static pixel properties
function hash(x: number, y: number, seed: number = 0): number {
	let h = (x + seed * 137) * 374761393 + (y + seed * 51) * 668265263;
	h = (h ^ (h >> 13)) * 1274126177;
	h = h ^ (h >> 16);
	return h;
}

// forest palette — base RGB + per-pixel refractive index
const PALETTE: [number, number, number][] = [
	[10, 22, 12],
	[14, 28, 16],
	[18, 35, 20],
	[22, 42, 26],
	[27, 50, 30],
	[16, 38, 22],
	[20, 32, 18],
	[32, 56, 34],
	[12, 26, 15],
	[25, 46, 28],
	[30, 52, 32],
	[14, 30, 19],
];

// each pixel is a little "gem" with fixed optical properties
interface Pixel {
	baseR: number;
	baseG: number;
	baseB: number;
	// refractive index: how much this pixel bends/concentrates light
	// Snell's law inspired — higher index = more light concentrated
	ior: number;
	// absorption spectrum: how much of each wavelength (RGB) this pixel absorbs
	// 0 = fully transparent to that wavelength, 1 = fully absorbs
	absR: number;
	absG: number;
	absB: number;
	// thickness variation — thicker pixels absorb more (Beer-Lambert)
	thickness: number;
}

export function initPixelCanvas(canvas: HTMLCanvasElement) {
	const ctx = canvas.getContext("2d")!;
	let animId: number;
	let pixels: Pixel[][] = [];
	let cols = 0;
	let rows = 0;

	function buildPixels() {
		cols = Math.ceil(canvas.width / PX);
		rows = Math.ceil(canvas.height / PX);
		pixels = [];

		for (let row = 0; row < rows; row++) {
			const pixelRow: Pixel[] = [];
			for (let col = 0; col < cols; col++) {
				const h1 = hash(col, row);
				const colorIdx = Math.abs(h1) % PALETTE.length;
				const [br, bg, bb] = PALETTE[colorIdx];
				const v = ((h1 >> 8) % 12) - 6;

				// refractive index: most pixels ~1.5 (glass), some are crystal (2.4 like diamond)
				const crystalRoll = (Math.abs(hash(col, row, 42)) % 1000) / 1000;
				let ior: number;
				if (crystalRoll < 0.03) ior = 2.2 + crystalRoll * 8;       // rare diamond-like
				else if (crystalRoll < 0.12) ior = 1.7 + crystalRoll * 2;  // crystal
				else ior = 1.3 + (crystalRoll - 0.12) * 0.5;              // glass

				// absorption — green pixels absorb less green (they transmit it)
				// this creates chromatic color when light passes through
				const absBase = (Math.abs(hash(col, row, 77)) % 100) / 100;
				const absR = 0.6 + absBase * 0.35;     // absorb most red
				const absG = 0.15 + absBase * 0.25;    // transmit green
				const absB = 0.45 + absBase * 0.3;     // absorb moderate blue

				// thickness: Beer-Lambert path length
				const thickness = 0.8 + ((Math.abs(hash(col, row, 99)) % 100) / 100) * 0.6;

				pixelRow.push({
					baseR: br + v,
					baseG: bg + v,
					baseB: bb + v,
					ior,
					absR,
					absG,
					absB,
					thickness,
				});
			}
			pixels.push(pixelRow);
		}
	}

	function resize() {
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
		buildPixels();
	}

	function draw(t: number) {
		const w = canvas.width;
		const h = canvas.height;
		if (cols === 0 || rows === 0) return;

		// time in seconds
		const s = t / 1000;

		// -- light sources: smooth continuous motion --
		// positions drift on Lissajous-like curves
		const lights = [
			{
				x: 0.25 + 0.18 * Math.sin(s * 0.13),
				y: 0.35 + 0.12 * Math.cos(s * 0.17),
				intensity: 1.0,
				// light color temperature — warm white
				r: 1.0, g: 0.95, b: 0.8,
			},
			{
				x: 0.72 + 0.12 * Math.cos(s * 0.09),
				y: 0.6 + 0.18 * Math.sin(s * 0.11),
				intensity: 0.7,
				// cooler, greener light
				r: 0.7, g: 1.0, b: 0.75,
			},
			{
				x: 0.5 + 0.22 * Math.sin(s * 0.07),
				y: 0.2 + 0.1 * Math.cos(s * 0.19),
				intensity: 0.5,
				// golden light
				r: 1.0, g: 0.85, b: 0.5,
			},
		];

		const imageData = ctx.createImageData(w, h);
		const data = imageData.data;

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const px = pixels[row][col];
				const nx = col / cols;
				const ny = row / rows;

				// -- accumulate light from all sources --
				let incidentR = 0;
				let incidentG = 0;
				let incidentB = 0;

				for (const light of lights) {
					const dx = nx - light.x;
					const dy = ny - light.y;
					const dist = Math.sqrt(dx * dx + dy * dy);

					// inverse-square falloff (real physics)
					const falloff = light.intensity / (1 + dist * dist * 12);

					// Fresnel approximation: how much light enters the pixel
					// at normal incidence, reflectance R0 = ((n1-n2)/(n1+n2))^2
					// n1 = 1 (air), n2 = pixel ior
					const n = px.ior;
					const r0 = ((1 - n) / (1 + n)) ** 2;
					// angle-dependent: Schlick's approximation
					// use distance as proxy for angle (farther from light = more oblique)
					const cosTheta = Math.max(0, 1 - dist * 1.5);
					const fresnel = r0 + (1 - r0) * (1 - cosTheta) ** 5;
					const transmitted = 1 - fresnel;

					// Beer-Lambert absorption: I = I0 * e^(-α * d)
					const transmitR = Math.exp(-px.absR * px.thickness);
					const transmitG = Math.exp(-px.absG * px.thickness);
					const transmitB = Math.exp(-px.absB * px.thickness);

					// light that makes it through this pixel
					incidentR += falloff * transmitted * transmitR * light.r;
					incidentG += falloff * transmitted * transmitG * light.g;
					incidentB += falloff * transmitted * transmitB * light.b;
				}

				// caustic sparkle: high-IOR pixels focus light, creating bright spots
				// modulated by time for continuous shimmer
				const causticPhase = Math.sin(s * 0.5 + col * 0.7 + row * 1.1)
					* Math.sin(s * 0.3 + col * 0.3 - row * 0.5);
				const causticStrength = (px.ior > 1.8) ? (px.ior - 1.5) * causticPhase * 0.4 : 0;

				// combine: base color + transmitted light + caustics
				const lightScale = 3.5;
				let r = px.baseR + (incidentR * lightScale + Math.max(0, causticStrength)) * 60;
				let g = px.baseG + (incidentG * lightScale + Math.max(0, causticStrength) * 0.8) * 60;
				let b = px.baseB + (incidentB * lightScale + Math.max(0, causticStrength) * 0.3) * 60;

				r = Math.min(255, Math.max(0, Math.round(r)));
				g = Math.min(255, Math.max(0, Math.round(g)));
				b = Math.min(255, Math.max(0, Math.round(b)));

				// fill the pixel block
				const startX = col * PX;
				const startY = row * PX;
				const endX = Math.min(startX + PX, w);
				const endY = Math.min(startY + PX, h);

				for (let py = startY; py < endY; py++) {
					const rowOffset = py * w;
					for (let ppx = startX; ppx < endX; ppx++) {
						const idx = (rowOffset + ppx) * 4;
						data[idx] = r;
						data[idx + 1] = g;
						data[idx + 2] = b;
						data[idx + 3] = 255;
					}
				}
			}
		}

		ctx.putImageData(imageData, 0, 0);
		animId = requestAnimationFrame(draw);
	}

	resize();
	animId = requestAnimationFrame(draw);

	const onResize = () => { resize(); };
	window.addEventListener("resize", onResize);

	return () => {
		cancelAnimationFrame(animId);
		window.removeEventListener("resize", onResize);
	};
}
