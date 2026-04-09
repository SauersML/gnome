const PX = 18;

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform float u_time;
uniform vec2 u_res;
uniform float u_px;
uniform sampler2D u_halo;
uniform vec2 u_gridSize;
uniform vec2 u_mouse;

float hash(vec2 p, float seed) {
    vec3 p3 = fract(vec3(p.xyx + seed) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec3 wavelengthToXYZ(float nm) {
    float t1 = (nm - 442.0) * (nm < 442.0 ? 0.0624 : 0.0374);
    float t2 = (nm - 599.8) * (nm < 599.8 ? 0.0264 : 0.0323);
    float t3 = (nm - 501.1) * (nm < 501.1 ? 0.0490 : 0.0382);
    float t4 = (nm - 568.8) * (nm < 568.8 ? 0.0213 : 0.0247);
    float t5 = (nm - 530.9) * (nm < 530.9 ? 0.0613 : 0.0322);
    float t6 = (nm - 437.0) * (nm < 437.0 ? 0.0845 : 0.0278);
    float x = 0.362*exp(-0.5*t1*t1) + 1.056*exp(-0.5*t2*t2) - 0.065*exp(-0.5*t3*t3);
    float y = 0.821*exp(-0.5*t4*t4) + 0.286*exp(-0.5*t5*t5);
    float z = 1.217*exp(-0.5*t6*t6) + 0.681*exp(-0.5*t3*t3);
    return max(vec3(0.0), vec3(x, y, z));
}

vec3 xyzToRGB(vec3 xyz) {
    return vec3(
        3.2406*xyz.x - 1.5372*xyz.y - 0.4986*xyz.z,
       -0.9689*xyz.x + 1.8758*xyz.y + 0.0415*xyz.z,
        0.0557*xyz.x - 0.2040*xyz.y + 1.0570*xyz.z
    );
}

float planck(float nm, float tempK) {
    float lam = nm * 1.0e-9;
    return 1.0 / (pow(lam, 5.0) * (exp(1.4388e-2 / (lam * tempK)) - 1.0));
}
float spectrum(float nm, float tempK) {
    return planck(nm, tempK) / planck(560.0, tempK);
}

float fresnelSchlick(float cosTheta, float r0) {
    float x = 1.0 - cosTheta;
    float x2 = x * x;
    return r0 + (1.0 - r0) * x2 * x2 * x;
}

// Voronoi caustic network
float caustics(vec2 p, float t) {
    float c = 0.0;
    for (int layer = 0; layer < 2; layer++) {
        float scale = (layer == 0) ? 6.0 : 10.0;
        float speed = (layer == 0) ? 0.12 : 0.08;
        vec2 uv = p * scale + vec2(t * speed, t * speed * 0.7);
        vec2 ip = floor(uv);
        float minD1 = 10.0;
        float minD2 = 10.0;
        for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
                vec2 neighbor = vec2(float(dx), float(dy));
                vec2 cellId = ip + neighbor;
                vec2 offset = vec2(
                    hash(cellId, 1.0) + 0.3*sin(t*0.2 + hash(cellId, 2.0)*6.28),
                    hash(cellId, 3.0) + 0.3*cos(t*0.15 + hash(cellId, 4.0)*6.28)
                );
                float d = length(fract(uv) - neighbor - offset);
                if (d < minD1) { minD2 = minD1; minD1 = d; }
                else if (d < minD2) { minD2 = d; }
            }
        }
        float edge = minD2 - minD1;
        float causticLine = exp(-edge * 12.0);
        float glow = exp(-minD1 * 3.0) * 0.3;
        float w = (layer == 0) ? 0.6 : 0.4;
        c += (causticLine + glow) * w;
    }
    return c;
}

void main() {
    vec2 pixel = gl_FragCoord.xy;
    pixel.y = u_res.y - pixel.y;

    vec2 cell = floor(pixel / u_px);
    float col = cell.x;
    float row = cell.y;
    float cols = u_gridSize.x;
    float rows = u_gridSize.y;
    float nx = col / cols;
    float ny = row / rows;
    float s = u_time / 1000.0;

    // Per-pixel material (deterministic)
    float h1 = hash(cell, 0.0);
    float h2 = hash(cell, 33.0);
    float h3 = hash(cell, 66.0);
    float h4 = hash(cell, 99.0);
    float h5 = hash(cell, 150.0);
    float h6 = hash(cell, 200.0);
    float h7 = hash(cell, 250.0);

    float ior = h1 < 0.05 ? 1.9 + h1*3.0 :
                h1 < 0.2  ? 1.55 + h1 :
                            1.3 + h1*0.3;

    float dispersion = 3000.0 + h2 * 10000.0;
    float absCenter = 510.0 + h3 * 180.0;
    float absWidth = 35.0 + hash(cell, 77.0) * 50.0;
    float absStrength = 1.8 + h4 * 2.5;
    float thickness = 0.5 + hash(cell, 111.0) * 0.9;

    float p1 = h5 * 6.283;
    float p2 = h6 * 6.283;
    float p3 = h7 * 6.283;

    // Base dark pixel color (same palette as original)
    int palIdx = int(mod(h1 * 5.0, 5.0));
    vec3 baseColor;
    if (palIdx == 0) baseColor = vec3(3.0, 12.0, 8.0);
    else if (palIdx == 1) baseColor = vec3(4.0, 14.0, 10.0);
    else if (palIdx == 2) baseColor = vec3(3.0, 10.0, 11.0);
    else if (palIdx == 3) baseColor = vec3(5.0, 13.0, 7.0);
    else baseColor = vec3(3.0, 11.0, 11.0);
    float bv = hash(cell, 400.0) * 4.0 - 2.0;
    baseColor += bv;

    // ─── Mouse proximity boost ───
    float mouseDist = length(vec2(nx, ny) - u_mouse);
    float mouseBoost = exp(-mouseDist * mouseDist / (2.0 * 0.06));  // smooth ~0.25 radius falloff
    float speedMul = 1.0 + mouseBoost * 0.6;   // up to 1.6x speed near cursor
    float ampMul = 1.0 + mouseBoost * 0.8;     // up to 1.8x intensity near cursor

    // ─── Sweeping hue waves ───
    // 4 rotating wave fronts at irrational-ratio speeds so they never repeat
    float w1a = s * 0.17 * speedMul;
    float w2a = s * 0.13 * speedMul + 2.1;
    float w3a = s * 0.09 * speedMul + 4.3;
    float w4a = s * 0.23 * speedMul + 1.0;
    vec2 w1d = vec2(cos(w1a), sin(w1a));
    vec2 w2d = vec2(cos(w2a), sin(w2a));
    vec2 w3d = vec2(cos(w3a), sin(w3a));
    vec2 w4d = vec2(cos(w4a), sin(w4a));

    // Each wave has different spatial frequency for complex interference
    float sw1 = sin(dot(vec2(nx, ny), w1d) * 7.0 + s * 0.35 * speedMul) * ampMul;
    float sw2 = sin(dot(vec2(nx, ny), w2d) * 5.0 + s * 0.28 * speedMul) * ampMul;
    float sw3 = sin(dot(vec2(nx, ny), w3d) * 11.0 + s * 0.22 * speedMul) * ampMul;
    float sw4 = sin(dot(vec2(nx, ny), w4d) * 3.5 + s * 0.40 * speedMul) * ampMul;

    // Absorption center: 4 wave components + per-pixel phase for rich shifting
    float hueMul = 1.0 + mouseBoost * 1.2;  // wider hue range near cursor
    float absShift = 35.0*hueMul*sin(s*0.18 + p1 + nx*4.0 + ny*3.0) * (0.5 + 0.5*sw1)
                   + 25.0*hueMul*sin(s*0.25 + p2 + nx*2.5 - ny*3.5) * (0.5 + 0.5*sw2)
                   + 18.0*hueMul*sin(s*0.35 + p3 - nx*3.0 + ny*2.0) * (0.5 + 0.5*sw3)
                   + 12.0*hueMul*cos(s*0.42 + p1*0.7 + nx*5.0 + ny*1.5) * (0.5 + 0.5*sw4);
    float absC = absCenter + absShift;
    float thickMod = thickness * (0.75 + 0.25*sin(s*0.12 + p2 + sw1*0.5 + sw3*0.3));

    // ─── 4 lights: Lissajous paths ───
    vec2 lightPos[4];
    float lightPower[4];
    float lightRadius[4];
    float lightTempK[4];

    lightPos[0] = vec2(
        0.5 + 0.55*sin(s*0.19*3.0),
        0.5 + 0.50*sin(s*0.19*2.0 + 1.2)
    );
    lightPower[0] = 0.50; lightRadius[0] = 0.65; lightTempK[0] = 6000.0;

    lightPos[1] = vec2(
        0.5 + 0.50*sin(s*0.14*5.0 + 0.8),
        0.5 + 0.45*sin(s*0.14*3.0 + 2.5)
    );
    lightPower[1] = 0.45; lightRadius[1] = 0.55; lightTempK[1] = 8000.0;

    lightPos[2] = vec2(
        0.5 + 0.48*sin(s*0.22*2.0 + 3.7),
        0.5 + 0.42*sin(s*0.22*1.0 + 0.4)
    );
    lightPower[2] = 0.38; lightRadius[2] = 0.5; lightTempK[2] = 3500.0;

    lightPos[3] = vec2(
        0.5 + 0.40*sin(s*0.11) + 0.15*sin(s*0.37 + 1.0),
        0.5 + 0.40*cos(s*0.13) + 0.12*cos(s*0.43 + 2.0)
    );
    lightPower[3] = 0.35; lightRadius[3] = 0.5; lightTempK[3] = 5200.0;

    vec3 totalXYZ = vec3(0.0);
    float caust = caustics(vec2(nx, ny), s) * 0.12;

    for (int wi = 0; wi < 5; wi++) {
        float nm;
        if      (wi == 0) nm = 440.0;
        else if (wi == 1) nm = 500.0;
        else if (wi == 2) nm = 560.0;
        else if (wi == 3) nm = 620.0;
        else              nm = 670.0;

        vec3 cmf = wavelengthToXYZ(nm);
        float n = ior + dispersion / (nm * nm);

        // Beer-Lambert absorption
        float absDelta = (nm - absC) / absWidth;
        float alpha = absStrength * exp(-0.5 * absDelta * absDelta);
        float transmission = exp(-alpha * thickMod);

        float filmMod = 1.0;

        float intensity = 0.0;

        for (int li = 0; li < 4; li++) {
            vec2 lp = lightPos[li];
            float lPow = lightPower[li];
            float lRad = lightRadius[li];
            float lTemp;
            if      (li == 0) lTemp = lightTempK[0];
            else if (li == 1) lTemp = lightTempK[1];
            else if (li == 2) lTemp = lightTempK[2];
            else              lTemp = lightTempK[3];

            vec2 dv = vec2(nx, ny) - lp;
            float d2 = dot(dv, dv);
            float dist = sqrt(d2);

            float falloff = lPow * exp(-d2 / (2.0*lRad*lRad));
            if (falloff < 0.002) continue;

            float spec = spectrum(nm, lTemp);
            float cosI = max(0.01, 1.0 - dist*0.6);

            // Snell's law
            float sinI = sqrt(max(0.0, 1.0 - cosI*cosI));
            float sinR = sinI / n;

            float r0 = pow((1.0 - n)/(1.0 + n), 2.0);
            float fres = fresnelSchlick(cosI, r0);

            if (sinR >= 1.0) {
                // Total internal reflection
                intensity += falloff * spec * 0.6 * transmission;
            } else {
                float cosR = sqrt(max(0.0, 1.0 - sinR*sinR));

                // Caustic focusing from refraction
                float causticBoost = 1.0 + caust * (n - 1.0) * 3.0;

                // Primary transmission
                intensity += falloff * (1.0 - fres) * transmission * spec * filmMod * causticBoost;

                // Internal reflection (single bounce)
                float intFres = fresnelSchlick(cosR, r0);
                intensity += falloff * fres * intFres * transmission * transmission * spec * 0.3;
            }
        }

        // Crystal sparkle for high-IOR pixels
        if (n > 1.7) {
            float phase = sin(s*0.5 + col*0.8*(n - 1.3) + row*1.1)
                        * sin(s*0.3 - col*0.35 + row*0.6*(n - 1.3));
            if (phase > 0.2) {
                intensity += (n - 1.5) * (phase - 0.2) * transmission * 0.4;
            }
        }

        totalXYZ += intensity * cmf;
    }

    // XYZ to RGB — same scale as original (0-255 space)
    float scale = 100.0;
    vec3 lr = xyzToRGB(totalXYZ * scale);

    float r = baseColor.x + lr.x;
    float g = baseColor.y + lr.y;
    float b = baseColor.z + lr.z;

    // Clamp to 0-255
    r = clamp(r, 0.0, 255.0);
    g = clamp(g, 0.0, 255.0);
    b = clamp(b, 0.0, 255.0);

    // Text halo dimming
    vec2 haloUV = (cell + 0.5) / u_gridSize;
    float dim = texture2D(u_halo, haloUV).r;
    r *= dim;
    g *= dim;
    b *= dim;

    gl_FragColor = vec4(r/255.0, g/255.0, b/255.0, 1.0);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
	const sh = gl.createShader(type)!;
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		console.error(gl.getShaderInfoLog(sh));
		gl.deleteShader(sh);
		throw new Error("Shader compile failed");
	}
	return sh;
}

function hash(x: number, y: number, seed: number = 0): number {
	let h = (x + seed * 137) * 374761393 + (y + seed * 51) * 668265263;
	h = (h ^ (h >> 13)) * 1274126177;
	h = h ^ (h >> 16);
	return h;
}

export function initPixelCanvas(canvas: HTMLCanvasElement) {
	const gl = canvas.getContext("webgl", { antialias: false, alpha: false })!;
	if (!gl) {
		console.error("WebGL not available");
		return () => {};
	}

	const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
	const prog = gl.createProgram()!;
	gl.attachShader(prog, vs);
	gl.attachShader(prog, fs);
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
		console.error(gl.getProgramInfoLog(prog));
		throw new Error("Program link failed");
	}
	gl.useProgram(prog);

	const buf = gl.createBuffer()!;
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
	const aPos = gl.getAttribLocation(prog, "a_pos");
	gl.enableVertexAttribArray(aPos);
	gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

	const uTime = gl.getUniformLocation(prog, "u_time")!;
	const uRes = gl.getUniformLocation(prog, "u_res")!;
	const uPx = gl.getUniformLocation(prog, "u_px")!;
	const uGridSize = gl.getUniformLocation(prog, "u_gridSize")!;
	const uMouse = gl.getUniformLocation(prog, "u_mouse")!;
	const uHalo = gl.getUniformLocation(prog, "u_halo")!;

	const haloTex = gl.createTexture()!;
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, haloTex);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.uniform1i(uHalo, 0);

	let animId: number;
	let cols = 0;
	let rows = 0;
	let haloData: Uint8Array = new Uint8Array(0);
	const HALO = 5;
	let cachedRects: Rect[] = [];
	let haloStale = true;
	let mouseX = 0.5;
	let mouseY = 0.5;

	// Only recompute halo when DOM actually changes, debounced
	let mutationTimer = 0;
	const observer = new MutationObserver(() => {
		clearTimeout(mutationTimer);
		mutationTimer = window.setTimeout(() => { haloStale = true; }, 150);
	});
	observer.observe(document.getElementById("root")!, { childList: true, subtree: true, characterData: true });

	type Rect = { c0: number; r0: number; c1: number; r1: number };

	function updateTextRects(): Rect[] {
		const root = document.getElementById("root");
		if (!root) return [];
		const rects: Rect[] = [];
		const range = document.createRange();

		// Walk actual text nodes and measure each word for tight per-character halo
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			const txt = node.textContent;
			if (!txt || !txt.trim()) continue;
			const wordRegex = /\S+/g;
			let match: RegExpExecArray | null;
			while ((match = wordRegex.exec(txt)) !== null) {
				range.setStart(node, match.index);
				range.setEnd(node, match.index + match[0].length);
				const crs = range.getClientRects();
				for (let i = 0; i < crs.length; i++) {
					const r = crs[i];
					if (r.width < 1 || r.height < 1) continue;
					rects.push({ c0: r.left / PX, r0: r.top / PX, c1: r.right / PX, r1: r.bottom / PX });
				}
			}
		}
		// Input elements
		const inputs = root.querySelectorAll("input") as NodeListOf<HTMLInputElement>;
		for (let i = 0; i < inputs.length; i++) {
			const r = inputs[i].getBoundingClientRect();
			if (r.width < 1 || r.height < 1) continue;
			rects.push({ c0: r.left / PX, r0: r.top / PX, c1: r.right / PX, r1: r.bottom / PX });
		}
		return rects;
	}

	function buildHaloTexture(textRects: Rect[]) {
		for (let i = 0; i < cols * rows; i++) haloData[i] = 255;

		// For each text rect, only touch the cells within HALO distance
		for (let ri = 0; ri < textRects.length; ri++) {
			const tr = textRects[ri];
			const r0 = Math.max(0, Math.floor(tr.r0 - HALO));
			const r1 = Math.min(rows - 1, Math.ceil(tr.r1 + HALO));
			const c0 = Math.max(0, Math.floor(tr.c0 - HALO));
			const c1 = Math.min(cols - 1, Math.ceil(tr.c1 + HALO));
			for (let row = r0; row <= r1; row++) {
				for (let col = c0; col <= c1; col++) {
					const dx = Math.max(tr.c0 - col, 0, col - tr.c1);
					const dy = Math.max(tr.r0 - row, 0, row - tr.r1);
					const d = Math.sqrt(dx * dx + dy * dy);
					if (d < HALO) {
						const p = 1.0 - d / HALO;
						const noise = (Math.abs(hash(col, row, 919)) % 1000) / 1000;
						const sensitivity = 0.3 + noise * 0.7;
						const dim = Math.max(0, 1.0 - (p * p) / (sensitivity * sensitivity));
						const v = (dim * 255) | 0;
						const idx = row * cols + col;
						if (v < haloData[idx]) haloData[idx] = v;
					}
				}
			}
		}
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, haloTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, cols, rows, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, haloData);
	}

	function resize() {
		cols = Math.ceil(window.innerWidth / PX);
		rows = Math.ceil(window.innerHeight / PX);
		// Render at cell resolution — 1 pixel per grid cell, CSS scales up
		canvas.width = cols;
		canvas.height = rows;
		canvas.style.imageRendering = "pixelated";
		haloData = new Uint8Array(cols * rows);
		gl.viewport(0, 0, cols, rows);
		haloStale = true;
	}

	function draw(t: number) {
		if (cols === 0 || rows === 0) { animId = requestAnimationFrame(draw); return; }
		if (haloStale) {
			cachedRects = updateTextRects();
			buildHaloTexture(cachedRects);
			haloStale = false;
		}
		gl.uniform1f(uTime, t);
		gl.uniform2f(uRes, cols, rows);
		gl.uniform1f(uPx, 1.0);
		gl.uniform2f(uGridSize, cols, rows);
		gl.uniform2f(uMouse, mouseX, mouseY);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		animId = requestAnimationFrame(draw);
	}

	const markStale = () => { haloStale = true; };
	const onMouseMove = (e: MouseEvent) => {
		mouseX = e.clientX / window.innerWidth;
		mouseY = e.clientY / window.innerHeight;
	};
	resize();
	animId = requestAnimationFrame(draw);
	window.addEventListener("resize", resize);
	window.addEventListener("scroll", markStale, true); // capture phase for inner scrolls
	window.addEventListener("mousemove", onMouseMove);

	return () => {
		cancelAnimationFrame(animId);
		window.removeEventListener("resize", resize);
		window.removeEventListener("scroll", markStale, true);
		window.removeEventListener("mousemove", onMouseMove);
		observer.disconnect();
	};
}
