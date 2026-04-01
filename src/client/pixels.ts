const PX = 18;

function hash(x: number, y: number, seed: number = 0): number {
	let h = (x + seed * 137) * 374761393 + (y + seed * 51) * 668265263;
	h = (h ^ (h >> 13)) * 1274126177;
	h = h ^ (h >> 16);
	return h;
}

// ---- Spectral rendering ----
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
	const r = 3.2406 * x - 1.5372 * y - 0.4986 * z;
	const g = -0.9689 * x + 1.8758 * y + 0.0415 * z;
	const b = 0.0557 * x - 0.2040 * y + 1.0570 * z;
	return [r, g, b];
}

const WAVE_XYZ = WAVELENGTHS.map(wavelengthToXYZ);

interface Material {
	cauchyA: number;
	cauchyB: number;
	absCenter: number;
	absWidth: number;
	absStrength: number;
	thickness: number;
	baseR: number;
	baseG: number;
	baseB: number;
}

function randomMaterial(col: number, row: number): Material {
	const h1 = hash(col, row);
	const h2 = hash(col, row, 33);
	const h3 = hash(col, row, 66);
	const h4 = hash(col, row, 99);

	const typeRoll = (Math.abs(h1) % 1000) / 1000;
	let cauchyA: number;
	if (typeRoll < 0.04) cauchyA = 2.0 + typeRoll * 5;
	else if (typeRoll < 0.15) cauchyA = 1.65 + typeRoll * 2;
	else cauchyA = 1.3 + typeRoll * 0.35;

	const cauchyB = 3000 + (Math.abs(h2) % 12000);

	const absCenter = 420 + (Math.abs(h3) % 280);
	const absWidth = 40 + (Math.abs(h3 >> 10) % 60);
	const biasedCenter = absCenter * 0.45 + 620 * 0.55;
	const absStrength = 2.2 + (Math.abs(h4) % 300) / 100;

	const thickness = 0.6 + (Math.abs(hash(col, row, 111)) % 100) / 100 * 0.8;

	const palIdx = Math.abs(h1 >> 4) % 6;
	const bases: [number, number, number][] = [
		[5, 16, 8], [6, 20, 10], [4, 14, 14],
		[8, 18, 6], [5, 18, 12], [7, 22, 9],
	];
	const [baseR, baseG, baseB] = bases[palIdx];
	const v = ((h1 >> 8) % 6) - 3;

	return {
		cauchyA, cauchyB,
		absCenter: biasedCenter, absWidth, absStrength, thickness,
		baseR: baseR + v, baseG: baseG + v, baseB: baseB + v,
	};
}

// How many pixels of stochastic falloff at region edges
const FRINGE = 4; // in grid cells

export function initPixelCanvas(canvas: HTMLCanvasElement) {
	const ctx = canvas.getContext("2d")!;
	let animId: number;
	let materials: Material[][] = [];
	let cols = 0;
	let rows = 0;

	// Query individual text elements and return their bounds in grid-cell coords
	const TEXT_SELECTORS = [
		".brand", ".header-right",
		".msg-who", ".msg-body",
		".empty-text",
		".compose-input", ".compose-send", ".compose-meta",
		".sidebar-label", ".sidebar-item-title", ".sidebar-item-desc",
		".article-back", ".article-title", ".article-abstract",
		".article-body p", ".tex-block",
	];
	const textQuery = TEXT_SELECTORS.join(",");

	function getTextRegions(): { c0: number; r0: number; c1: number; r1: number }[] {
		const els = document.querySelectorAll(textQuery);
		const regions: { c0: number; r0: number; c1: number; r1: number }[] = [];
		for (let i = 0; i < els.length; i++) {
			const rect = els[i].getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) continue;
			regions.push({
				c0: rect.left / PX,
				r0: rect.top / PX,
				c1: rect.right / PX,
				r1: rect.bottom / PX,
			});
		}
		return regions;
	}

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

	// precompute blackbody spectra for fixed temps
	function spectralPower(nm: number, tempK: number): number {
		const lambda = nm * 1e-9;
		const c2 = 1.4388e-2;
		return 1.0 / (Math.pow(lambda, 5) * (Math.exp(c2 / (lambda * tempK)) - 1));
	}

	const TEMPS = [3500, 5000, 6500];
	const PRECOMP_SPECTRA = TEMPS.map((temp) => {
		const spectrum = WAVELENGTHS.map((nm) => spectralPower(nm, temp));
		const maxS = Math.max(...spectrum);
		return spectrum.map((s) => s / maxS);
	});

	function draw(t: number) {
		if (cols === 0 || rows === 0) return;
		const w = canvas.width;
		const h = canvas.height;
		const s = t / 1000;

		// two big sweeping lights — large visible movement
		const lights = [
			{
				x: 0.5 + 0.6 * Math.sin(s * 0.25),
				y: 0.5 + 0.5 * Math.cos(s * 0.18),
				power: 0.7,
				spectrum: 1,
				radius: 0.55,
			},
			{
				x: 0.5 + 0.6 * Math.cos(s * 0.2),
				y: 0.5 + 0.5 * Math.sin(s * 0.3),
				power: 0.55,
				spectrum: 0,
				radius: 0.5,
			},
		];

		ctx.fillStyle = "#050c07";
		ctx.fillRect(0, 0, w, h);

		const regions = getTextRegions();

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const mat = materials[row][col];
				const nx = col / cols;
				const ny = row / rows;

				let totalX = 0;
				let totalY = 0;
				let totalZ = 0;

				for (let wi = 0; wi < WAVELENGTHS.length; wi++) {
					const nm = WAVELENGTHS[wi];
					const [wx, wy, wz] = WAVE_XYZ[wi];

					const ior = mat.cauchyA + mat.cauchyB / (nm * nm);

					const absDelta = (nm - mat.absCenter) / mat.absWidth;
					const alpha = mat.absStrength * Math.exp(-0.5 * absDelta * absDelta);
					const transmission = Math.exp(-alpha * mat.thickness);

					let spectralIntensity = 0;

					for (let li = 0; li < lights.length; li++) {
						const light = lights[li];
						const dx = nx - light.x;
						const dy = ny - light.y;
						const dist2 = dx * dx + dy * dy;

						const sigma = light.radius;
						const falloff = light.power * Math.exp(-dist2 / (2 * sigma * sigma));
						if (falloff < 0.002) continue;

						const r0 = ((1 - ior) / (1 + ior)) ** 2;
						const cosTheta = Math.max(0.01, 1 - Math.sqrt(dist2) * 0.8);
						const fresnel = r0 + (1 - r0) * (1 - cosTheta) ** 5;
						const admitted = 1 - fresnel;

						const power = PRECOMP_SPECTRA[light.spectrum][wi];

						spectralIntensity += falloff * admitted * transmission * power;
					}

					if (ior > 1.7) {
						const phase = Math.sin(s * 0.6 + col * 0.9 * (ior - 1.3) + row * 1.2)
							* Math.sin(s * 0.35 - col * 0.4 + row * 0.7 * (ior - 1.3));
						if (phase > 0.25) {
							spectralIntensity += (ior - 1.5) * (phase - 0.25) * transmission * 0.5;
						}
					}

					totalX += spectralIntensity * wx;
					totalY += spectralIntensity * wy;
					totalZ += spectralIntensity * wz;
				}

				const scale = 55;
				let [lr, lg, lb] = xyzToRGB(totalX * scale, totalY * scale, totalZ * scale);

				let r = mat.baseR + lr;
				let g = mat.baseG + lg;
				let b = mat.baseB + lb;

				r = Math.min(255, Math.max(0, r)) | 0;
				g = Math.min(255, Math.max(0, g)) | 0;
				b = Math.min(255, Math.max(0, b)) | 0;

				// darken pixels under text regions with stochastic fringe
				let darken = 1.0;
				for (let ri = 0; ri < regions.length; ri++) {
					const reg = regions[ri];
					// signed distance inward from each edge (positive = inside)
					const dLeft = col - reg.c0;
					const dRight = reg.c1 - col;
					const dTop = row - reg.r0;
					const dBottom = reg.r1 - row;
					const dMin = Math.min(dLeft, dRight, dTop, dBottom);

					if (dMin > FRINGE) {
						// fully inside
						darken = Math.min(darken, 0.18);
					} else if (dMin > -FRINGE) {
						// in the fringe zone: probability of darkening based on depth
						const t = (dMin + FRINGE) / (2 * FRINGE); // 0 at outer edge, 1 at inner
						const noise = (Math.abs(hash(col, row, 777 + ri)) % 1000) / 1000;
						if (noise < t) {
							darken = Math.min(darken, 0.18);
						}
					}
				}

				r = (r * darken) | 0;
				g = (g * darken) | 0;
				b = (b * darken) | 0;

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
