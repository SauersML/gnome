const PX = 18;

function hash(x: number, y: number, seed: number = 0): number {
	let h = (x + seed * 137) * 374761393 + (y + seed * 51) * 668265263;
	h = (h ^ (h >> 13)) * 1274126177;
	h = h ^ (h >> 16);
	return h;
}

// varied palette — not all green. emeralds, teals, mossy golds, deep blues, warm earth
const PALETTE: [number, number, number][] = [
	[8, 20, 10],     // deep forest
	[12, 32, 18],    // dark emerald
	[6, 18, 22],     // deep teal
	[22, 44, 20],    // bright moss
	[14, 26, 30],    // night water
	[28, 38, 12],    // olive
	[10, 36, 28],    // jade
	[18, 14, 10],    // dark earth
	[24, 48, 22],    // fern
	[16, 22, 34],    // deep blue
	[32, 28, 10],    // amber shadow
	[8, 30, 24],     // dark cyan
	[20, 40, 16],    // leaf
	[12, 16, 26],    // midnight
	[26, 50, 30],    // bright forest
	[30, 22, 14],    // bark warm
];

interface Pixel {
	baseR: number;
	baseG: number;
	baseB: number;
	ior: number;
	// per-channel transmission (0-1): how much of each color passes through
	txR: number;
	txG: number;
	txB: number;
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
				const v = ((h1 >> 8) % 10) - 5;

				// refractive index
				const roll = (Math.abs(hash(col, row, 42)) % 1000) / 1000;
				let ior: number;
				if (roll < 0.05) ior = 2.0 + roll * 10;        // diamond
				else if (roll < 0.15) ior = 1.7 + roll * 3;    // crystal
				else ior = 1.3 + roll * 0.4;                    // glass

				// transmission spectrum — determines what COLOR light comes through
				// this is what creates the colorful refraction
				const spectrumType = Math.abs(hash(col, row, 88)) % 5;
				let txR: number, txG: number, txB: number;
				switch (spectrumType) {
					case 0: txR = 0.15; txG = 0.85; txB = 0.3;  break; // green filter
					case 1: txR = 0.2;  txG = 0.6;  txB = 0.8;  break; // teal filter
					case 2: txR = 0.7;  txG = 0.75; txB = 0.15; break; // golden filter
					case 3: txR = 0.1;  txG = 0.9;  txB = 0.5;  break; // emerald filter
					default: txR = 0.5; txG = 0.5;  txB = 0.7;  break; // blue-ish
				}

				pixelRow.push({
					baseR: br + v,
					baseG: bg + v,
					baseB: bb + v,
					ior,
					txR,
					txG,
					txB,
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
		if (cols === 0 || rows === 0) return;
		const w = canvas.width;
		const h = canvas.height;

		const s = t / 1000;

		// light sources — smooth continuous orbits, colored, focused
		const lights = [
			{
				x: 0.3 + 0.25 * Math.sin(s * 0.15),
				y: 0.4 + 0.2 * Math.cos(s * 0.19),
				power: 1.2,
				r: 1.0, g: 0.9, b: 0.6,   // warm gold
				radius: 0.28,
			},
			{
				x: 0.7 + 0.15 * Math.cos(s * 0.11),
				y: 0.55 + 0.25 * Math.sin(s * 0.13),
				power: 1.0,
				r: 0.5, g: 1.0, b: 0.7,   // emerald
				radius: 0.25,
			},
			{
				x: 0.45 + 0.3 * Math.sin(s * 0.08),
				y: 0.15 + 0.12 * Math.cos(s * 0.22),
				power: 0.8,
				r: 0.6, g: 0.7, b: 1.0,   // cool blue
				radius: 0.22,
			},
			{
				x: 0.15 + 0.1 * Math.cos(s * 0.17),
				y: 0.8 + 0.1 * Math.sin(s * 0.14),
				power: 0.6,
				r: 1.0, g: 0.6, b: 0.3,   // amber
				radius: 0.2,
			},
		];

		// clear to near-black
		ctx.fillStyle = "#050a06";
		ctx.fillRect(0, 0, w, h);

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const px = pixels[row][col];
				const nx = col / cols;
				const ny = row / rows;

				let litR = 0;
				let litG = 0;
				let litB = 0;

				for (const light of lights) {
					const dx = nx - light.x;
					const dy = ny - light.y;
					const dist = Math.sqrt(dx * dx + dy * dy);

					// sharp gaussian falloff (not inverse-square, more focused pools)
					const sigma = light.radius;
					const falloff = light.power * Math.exp(-(dist * dist) / (2 * sigma * sigma));

					if (falloff < 0.005) continue; // skip negligible contribution

					// Fresnel: Schlick's approximation
					const n = px.ior;
					const r0 = ((1 - n) / (1 + n)) ** 2;
					const cosTheta = Math.max(0.01, 1 - dist * 1.2);
					const fresnel = r0 + (1 - r0) * (1 - cosTheta) ** 5;
					const transmitted = 1 - fresnel;

					// color filtering: light * transmission spectrum of this pixel
					litR += falloff * transmitted * px.txR * light.r;
					litG += falloff * transmitted * px.txG * light.g;
					litB += falloff * transmitted * px.txB * light.b;
				}

				// caustics: high-IOR pixels concentrate and flash
				if (px.ior > 1.7) {
					const caustic = Math.sin(s * 0.7 + col * 0.8 + row * 1.3)
						* Math.sin(s * 0.4 - col * 0.3 + row * 0.6);
					if (caustic > 0.3) {
						const strength = (px.ior - 1.5) * (caustic - 0.3) * 1.5;
						litR += strength * px.txR;
						litG += strength * px.txG;
						litB += strength * px.txB;
					}
				}

				// final color: base + light contribution
				const boost = 120;
				let r = px.baseR + litR * boost;
				let g = px.baseG + litG * boost;
				let b = px.baseB + litB * boost;

				r = Math.min(255, Math.max(0, r)) | 0;
				g = Math.min(255, Math.max(0, g)) | 0;
				b = Math.min(255, Math.max(0, b)) | 0;

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
