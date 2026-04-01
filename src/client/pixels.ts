const PX = 18;

function hash(x: number, y: number, seed: number = 0): number {
	let h = (x + seed * 137) * 374761393 + (y + seed * 51) * 668265263;
	h = (h ^ (h >> 13)) * 1274126177;
	h = h ^ (h >> 16);
	return h;
}

// ---- Spectral rendering ----
// We sample 8 wavelengths across visible spectrum (400-700nm)
const WAVELENGTHS = [420, 460, 500, 530, 560, 590, 630, 670]; // nm

// CIE 1931 2-degree observer approximation (simplified Gaussian fit)
// Maps wavelength -> XYZ tristimulus
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
		+ 0.681 * Math.exp(-0.5 * t3 * t3); // reuse t3
	return [Math.max(0, x), Math.max(0, y), Math.max(0, z)];
}

// XYZ -> linear sRGB
function xyzToRGB(x: number, y: number, z: number): [number, number, number] {
	let r = 3.2406 * x - 1.5372 * y - 0.4986 * z;
	let g = -0.9689 * x + 1.8758 * y + 0.0415 * z;
	let b = 0.0557 * x - 0.2040 * y + 1.0570 * z;
	return [r, g, b];
}

// precompute XYZ for our sampled wavelengths
const WAVE_XYZ = WAVELENGTHS.map(wavelengthToXYZ);

// Cauchy dispersion equation: n(λ) = A + B/λ² + C/λ⁴
// different materials have different Cauchy coefficients
interface Material {
	// Cauchy coefficients
	cauchyA: number;
	cauchyB: number; // in nm² units
	// absorption: extinction coefficient per nm, Gaussian absorption band
	absCenter: number;  // center wavelength of absorption band (nm)
	absWidth: number;   // width of absorption band (nm)
	absStrength: number; // peak absorption coefficient
	// thickness in arbitrary units
	thickness: number;
	// base color (the dark unlit appearance)
	baseR: number;
	baseG: number;
	baseB: number;
}

// generate a random glass/crystal material
function randomMaterial(col: number, row: number): Material {
	const h1 = hash(col, row);
	const h2 = hash(col, row, 33);
	const h3 = hash(col, row, 66);
	const h4 = hash(col, row, 99);

	// Cauchy A: base IOR (1.3 for water, 1.5 for glass, 2.4 for diamond)
	const typeRoll = (Math.abs(h1) % 1000) / 1000;
	let cauchyA: number;
	if (typeRoll < 0.04) cauchyA = 2.0 + typeRoll * 5;       // diamond/zircon
	else if (typeRoll < 0.15) cauchyA = 1.65 + typeRoll * 2;  // crystal/flint glass
	else cauchyA = 1.3 + typeRoll * 0.35;                      // crown glass

	// Cauchy B: dispersion strength (higher = more rainbow separation)
	// flint glass ~10000, crown glass ~4000, diamond ~8000
	const cauchyB = 3000 + (Math.abs(h2) % 12000);

	// absorption band — this is what gives each pixel its COLOR
	// center anywhere in visible spectrum
	const absCenter = 420 + (Math.abs(h3) % 280); // 420-700nm
	const absWidth = 40 + (Math.abs(h3 >> 10) % 60); // 40-100nm
	// strength: how opaque. forest = absorb red, transmit green
	// bias toward absorbing red (center ~620) for forest feel
	const biasedCenter = absCenter * 0.7 + 600 * 0.3; // pull toward red
	const absStrength = 1.5 + (Math.abs(h4) % 300) / 100;

	const thickness = 0.6 + (Math.abs(hash(col, row, 111)) % 100) / 100 * 0.8;

	// dark base palette
	const palIdx = Math.abs(h1 >> 4) % 6;
	const bases: [number, number, number][] = [
		[8, 18, 10], [12, 24, 14], [6, 16, 20],
		[16, 12, 8], [10, 22, 18], [14, 20, 12],
	];
	const [baseR, baseG, baseB] = bases[palIdx];
	const v = ((h1 >> 8) % 8) - 4;

	return {
		cauchyA,
		cauchyB,
		absCenter: biasedCenter,
		absWidth,
		absStrength,
		thickness,
		baseR: baseR + v,
		baseG: baseG + v,
		baseB: baseB + v,
	};
}

export function initPixelCanvas(canvas: HTMLCanvasElement) {
	const ctx = canvas.getContext("2d")!;
	let animId: number;
	let materials: Material[][] = [];
	let cols = 0;
	let rows = 0;

	function buildMaterials() {
		cols = Math.ceil(canvas.width / PX);
		rows = Math.ceil(canvas.height / PX);
		materials = [];
		for (let row = 0; row < rows; row++) {
			const matRow: Material[] = [];
			for (let col = 0; col < cols; col++) {
				matRow.push(randomMaterial(col, row));
			}
			materials.push(matRow);
		}
	}

	function resize() {
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
		buildMaterials();
	}

	function draw(t: number) {
		if (cols === 0 || rows === 0) return;
		const w = canvas.width;
		const h = canvas.height;
		const s = t / 1000;

		// light sources — each emits white-ish light (all wavelengths)
		// but with a color temperature (spectral power distribution)
		const lights = [
			{
				x: 0.3 + 0.25 * Math.sin(s * 0.15),
				y: 0.4 + 0.2 * Math.cos(s * 0.19),
				power: 1.4,
				temp: 4500, // warm
				radius: 0.25,
			},
			{
				x: 0.7 + 0.15 * Math.cos(s * 0.11),
				y: 0.55 + 0.25 * Math.sin(s * 0.13),
				power: 1.1,
				temp: 6500, // daylight
				radius: 0.22,
			},
			{
				x: 0.45 + 0.3 * Math.sin(s * 0.08),
				y: 0.15 + 0.12 * Math.cos(s * 0.22),
				power: 0.9,
				temp: 8000, // cool blue
				radius: 0.2,
			},
			{
				x: 0.15 + 0.1 * Math.cos(s * 0.17),
				y: 0.8 + 0.1 * Math.sin(s * 0.14),
				power: 0.7,
				temp: 3200, // very warm/amber
				radius: 0.18,
			},
		];

		// approximate blackbody spectral power at wavelength for a given temperature
		// Planck's law simplified (relative, not absolute)
		function spectralPower(nm: number, tempK: number): number {
			const lambda = nm * 1e-9;
			const c2 = 1.4388e-2; // hc/k in m*K
			return 1.0 / (Math.pow(lambda, 5) * (Math.exp(c2 / (lambda * tempK)) - 1));
		}

		// precompute normalized spectral power for each light
		const lightSpectra = lights.map((light) => {
			const spectrum = WAVELENGTHS.map((nm) => spectralPower(nm, light.temp));
			const maxS = Math.max(...spectrum);
			return spectrum.map((s) => s / maxS); // normalize to 0-1
		});

		ctx.fillStyle = "#050a06";
		ctx.fillRect(0, 0, w, h);

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const mat = materials[row][col];
				const nx = col / cols;
				const ny = row / rows;

				// accumulate XYZ tristimulus from all wavelengths and lights
				let totalX = 0;
				let totalY = 0;
				let totalZ = 0;

				for (let wi = 0; wi < WAVELENGTHS.length; wi++) {
					const nm = WAVELENGTHS[wi];
					const [wx, wy, wz] = WAVE_XYZ[wi];

					// IOR at this wavelength: Cauchy dispersion
					const ior = mat.cauchyA + mat.cauchyB / (nm * nm);

					// Beer-Lambert absorption at this wavelength
					// Gaussian absorption band
					const absDelta = (nm - mat.absCenter) / mat.absWidth;
					const alpha = mat.absStrength * Math.exp(-0.5 * absDelta * absDelta);
					const transmission = Math.exp(-alpha * mat.thickness);

					// accumulate light from all sources
					let spectralIntensity = 0;

					for (let li = 0; li < lights.length; li++) {
						const light = lights[li];
						const dx = nx - light.x;
						const dy = ny - light.y;
						const dist = Math.sqrt(dx * dx + dy * dy);

						// gaussian beam profile
						const sigma = light.radius;
						const falloff = light.power * Math.exp(-(dist * dist) / (2 * sigma * sigma));
						if (falloff < 0.003) continue;

						// Fresnel at this wavelength (IOR is wavelength-dependent!)
						const r0 = ((1 - ior) / (1 + ior)) ** 2;
						const cosTheta = Math.max(0.01, 1 - dist * 1.3);
						const fresnel = r0 + (1 - r0) * (1 - cosTheta) ** 5;
						const admitted = 1 - fresnel;

						// spectral power of this light at this wavelength
						const power = lightSpectra[li][wi];

						spectralIntensity += falloff * admitted * transmission * power;
					}

					// caustics: wavelength-dependent focusing from high-dispersion pixels
					if (ior > 1.7) {
						const phase = Math.sin(s * 0.6 + col * 0.9 * (ior - 1.3) + row * 1.2)
							* Math.sin(s * 0.35 - col * 0.4 + row * 0.7 * (ior - 1.3));
						if (phase > 0.25) {
							spectralIntensity += (ior - 1.5) * (phase - 0.25) * transmission * 0.8;
						}
					}

					// add to XYZ using color matching functions
					totalX += spectralIntensity * wx;
					totalY += spectralIntensity * wy;
					totalZ += spectralIntensity * wz;
				}

				// XYZ -> RGB
				const scale = 90;
				let [lr, lg, lb] = xyzToRGB(totalX * scale, totalY * scale, totalZ * scale);

				// add base color
				let r = mat.baseR + lr;
				let g = mat.baseG + lg;
				let b = mat.baseB + lb;

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
