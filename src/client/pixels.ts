const PX = 18;

// deterministic hash for color variation
function hash(x: number, y: number, seed: number = 0): number {
	let h = (x + seed * 137) * 374761393 + (y + seed * 51) * 668265263;
	h = (h ^ (h >> 13)) * 1274126177;
	h = h ^ (h >> 16);
	return h;
}

// forest palette — base RGB values
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

export function initPixelCanvas(canvas: HTMLCanvasElement) {
	const ctx = canvas.getContext("2d")!;
	let frame = 0;
	let animId: number;
	let timer: ReturnType<typeof setInterval>;

	function resize() {
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
	}

	function draw() {
		const w = canvas.width;
		const h = canvas.height;
		const cols = Math.ceil(w / PX);
		const rows = Math.ceil(h / PX);

		// -- light sources that drift behind the mosaic --
		// two sources, positions shift per frame (stepped)
		const l1x = 0.25 + 0.15 * Math.sin(frame * 0.4);
		const l1y = 0.35 + 0.1 * Math.cos(frame * 0.3);
		const l2x = 0.7 + 0.1 * Math.cos(frame * 0.25);
		const l2y = 0.65 + 0.15 * Math.sin(frame * 0.35);
		const l3x = 0.5 + 0.2 * Math.sin(frame * 0.15);
		const l3y = 0.2 + 0.1 * Math.cos(frame * 0.45);

		const imageData = ctx.createImageData(w, h);
		const data = imageData.data;

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				// base color from hash
				const h1 = hash(col, row);
				const colorIdx = Math.abs(h1) % PALETTE.length;
				const [br, bg, bb] = PALETTE[colorIdx];

				// subtle per-pixel variation
				const v = ((h1 >> 8) % 12) - 6;

				// distance to each light source (normalized 0-1)
				const nx = col / cols;
				const ny = row / rows;
				const d1 = Math.sqrt((nx - l1x) ** 2 + (ny - l1y) ** 2);
				const d2 = Math.sqrt((nx - l2x) ** 2 + (ny - l2y) ** 2);
				const d3 = Math.sqrt((nx - l3x) ** 2 + (ny - l3y) ** 2);

				// light intensity (closer = brighter, falloff)
				const light1 = Math.max(0, 1 - d1 * 2.5) ** 2;
				const light2 = Math.max(0, 1 - d2 * 2.8) ** 2;
				const light3 = Math.max(0, 1 - d3 * 3.2) ** 2;

				// combined light
				const light = light1 * 0.7 + light2 * 0.5 + light3 * 0.4;

				// some pixels are more "crystalline" — they refract more light
				const crystal = ((hash(col, row, 42) % 100) / 100);
				const refract = crystal < 0.08 ? 2.5 : crystal < 0.2 ? 1.4 : 1.0;

				// shimmer: certain pixels catch extra light this frame
				const shimmerHash = hash(col, row, frame);
				const shimmerVal = (Math.abs(shimmerHash) % 1000) / 1000;
				const shimmer = shimmerVal < 0.02 ? 0.35 : shimmerVal < 0.06 ? 0.15 : 0;

				// final brightness multiplier
				const bright = 1.0 + light * refract * 1.8 + shimmer;

				// green tint from light passing through
				const lightGreenBoost = light * refract * 18;
				// gold tint from secondary light
				const goldBoost = light2 * refract * 8;

				// compute final color
				let r = Math.round((br + v) * bright + goldBoost);
				let g = Math.round((bg + v) * bright + lightGreenBoost);
				let b = Math.round((bb + v) * bright);

				// clamp
				r = Math.min(255, Math.max(0, r));
				g = Math.min(255, Math.max(0, g));
				b = Math.min(255, Math.max(0, b));

				// fill entire PX x PX block with this color
				const startX = col * PX;
				const startY = row * PX;
				const endX = Math.min(startX + PX, w);
				const endY = Math.min(startY + PX, h);

				for (let py = startY; py < endY; py++) {
					for (let px = startX; px < endX; px++) {
						const idx = (py * w + px) * 4;
						data[idx] = r;
						data[idx + 1] = g;
						data[idx + 2] = b;
						data[idx + 3] = 255;
					}
				}
			}
		}

		ctx.putImageData(imageData, 0, 0);
	}

	resize();
	draw();

	// stepped shimmer: redraw every 2s
	timer = setInterval(() => {
		frame++;
		draw();
	}, 2000);

	const onResize = () => {
		resize();
		draw();
	};
	window.addEventListener("resize", onResize);

	return () => {
		clearInterval(timer);
		cancelAnimationFrame(animId);
		window.removeEventListener("resize", onResize);
	};
}
