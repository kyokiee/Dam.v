        (() => {
            "use strict";

            const DAM = { lat: 30.3778, lng: 78.4806 };
            const EXTENT = { south: 30.20, north: 30.44, west: 78.36, east: 78.64 };
            const NX = 120;
            const NY = 120;
            const G = 9.81;
            const DRY = 0.0001;
            const WET_THRESHOLD = 0.1;
            const CELLS = NX * NY;
            const indexOf = (x, y) => y * NX + x;
            const damX = Math.max(0, Math.min(NX - 1, Math.round((DAM.lng - EXTENT.west) / (EXTENT.east - EXTENT.west) * (NX - 1))));
            const damY = Math.max(0, Math.min(NY - 1, Math.round((EXTENT.north - DAM.lat) / (EXTENT.north - EXTENT.south) * (NY - 1))));
            const downstreamProbeY = Math.min(NY - 1, damY + 8);
            const downstreamProbe = indexOf(damX, downstreamProbeY);
            const dx = 6371000 * Math.cos(DAM.lat * Math.PI / 180) * (EXTENT.east - EXTENT.west) * Math.PI / 180 / NX;
            const dy = 6371000 * (EXTENT.north - EXTENT.south) * Math.PI / 180 / NY;
            const cellArea = dx * dy;

            const map = L.map("map", { center: [DAM.lat - 0.045, DAM.lng + 0.025], zoom: 11, zoomControl: false });
            L.control.zoom({ position: "bottomright" }).addTo(map);
            L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
                maxZoom: 19,
                attribution: "Tiles &copy; Esri"
            }).addTo(map);
            L.circleMarker([DAM.lat, DAM.lng], {
                radius: 7, color: "#fff", weight: 2, fillColor: "#ee625e", fillOpacity: 1
            }).addTo(map).bindPopup("<strong>Tehri Dam</strong><br>30.3778° N, 78.4806° E");

            const bed = new Float32Array(CELLS);
            const depth = new Float32Array(CELLS);
            const qx = new Float32Array(CELLS);
            const qy = new Float32Array(CELLS);
            const nextDepth = new Float32Array(CELLS);
            const nextQx = new Float32Array(CELLS);
            const nextQy = new Float32Array(CELLS);
            const fxH = new Float64Array(NY * (NX + 1));
            const fxX = new Float64Array(NY * (NX + 1));
            const fxY = new Float64Array(NY * (NX + 1));
            const fxCorrectionLeft = new Float64Array(NY * (NX + 1));
            const fxCorrectionRight = new Float64Array(NY * (NX + 1));
            const fyH = new Float64Array((NY + 1) * NX);
            const fyX = new Float64Array((NY + 1) * NX);
            const fyY = new Float64Array((NY + 1) * NX);
            const fyCorrectionNorth = new Float64Array((NY + 1) * NX);
            const fyCorrectionSouth = new Float64Array((NY + 1) * NX);
            if (!(window.TEHRI_DEM_GRID instanceof Int16Array) || window.TEHRI_DEM_GRID.length !== CELLS) {
                throw new Error("The bundled Tehri DEM grid is missing or has an invalid size.");
            }
            bed.set(window.TEHRI_DEM_GRID);

            let demLayer = null;
            let demSampler = null;
            const offscreen = document.createElement("canvas");
            offscreen.width = NX;
            offscreen.height = NY;
            const offCtx = offscreen.getContext("2d", { alpha: true });
            let floodCanvasLayer;

            const FloodCanvas = L.Layer.extend({
                onAdd(leafletMap) {
                    this._map = leafletMap;
                    this._canvas = L.DomUtil.create("canvas", "leaflet-flood-canvas");
                    this._canvas.style.cssText = "position:absolute;pointer-events:none;z-index:450";
                    leafletMap.getPanes().overlayPane.appendChild(this._canvas);
                    leafletMap.on("moveend zoomend resize", this._reset, this);
                    this._reset();
                },
                onRemove(leafletMap) {
                    L.DomUtil.remove(this._canvas);
                    leafletMap.off("moveend zoomend resize", this._reset, this);
                },
                _reset() {
                    const origin = this._map.containerPointToLayerPoint([0, 0]);
                    L.DomUtil.setPosition(this._canvas, origin);
                    const size = this._map.getSize();
                    this._canvas.width = size.x;
                    this._canvas.height = size.y;
                    this.render();
                },
                render() {
                    if (!this._map || !this._canvas) return;
                    const ctx = this._canvas.getContext("2d");
                    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
                    const img = offCtx.createImageData(NX, NY);
                    for (let i = 0; i < CELLS; i++) {
                        const h = depth[i];
                        if (h < WET_THRESHOLD) continue;
                        const x = i % NX;
                        const y = Math.floor(i / NX);
                        const rgba = colorForDepth(h, x, y);
                        const p = i * 4;
                        img.data[p] = rgba[0];
                        img.data[p + 1] = rgba[1];
                        img.data[p + 2] = rgba[2];
                        img.data[p + 3] = rgba[3];
                    }
                    offCtx.putImageData(img, 0, 0);
                    const northwest = this._map.latLngToContainerPoint([EXTENT.north, EXTENT.west]);
                    const southeast = this._map.latLngToContainerPoint([EXTENT.south, EXTENT.east]);
                    ctx.imageSmoothingEnabled = true;
                    ctx.drawImage(offscreen, northwest.x, northwest.y, southeast.x - northwest.x, southeast.y - northwest.y);
                    ctx.save();
                    ctx.beginPath();
                    ctx.strokeStyle = "#ff3b30";
                    ctx.lineWidth = 2.5;
                    ctx.lineJoin = "round";
                    ctx.lineCap = "round";
                    ctx.shadowColor = "#280000";
                    ctx.shadowBlur = 3;
                    for (let y = 0; y < NY; y++) {
                        const north = EXTENT.north - y / NY * (EXTENT.north - EXTENT.south);
                        const south = EXTENT.north - (y + 1) / NY * (EXTENT.north - EXTENT.south);
                        for (let x = 0; x < NX; x++) {
                            const i = indexOf(x, y);
                            if (depth[i] < WET_THRESHOLD) continue;
                            const west = EXTENT.west + x / NX * (EXTENT.east - EXTENT.west);
                            const east = EXTENT.west + (x + 1) / NX * (EXTENT.east - EXTENT.west);
                            if (x === 0 || depth[i - 1] < WET_THRESHOLD) {
                                const a = this._map.latLngToContainerPoint([north, west]);
                                const b = this._map.latLngToContainerPoint([south, west]);
                                ctx.moveTo(a.x, a.y);
                                ctx.lineTo(b.x, b.y);
                            }
                            if (x === NX - 1 || depth[i + 1] < WET_THRESHOLD) {
                                const a = this._map.latLngToContainerPoint([north, east]);
                                const b = this._map.latLngToContainerPoint([south, east]);
                                ctx.moveTo(a.x, a.y);
                                ctx.lineTo(b.x, b.y);
                            }
                            if (y === 0 || depth[i - NX] < WET_THRESHOLD) {
                                const a = this._map.latLngToContainerPoint([north, west]);
                                const b = this._map.latLngToContainerPoint([north, east]);
                                ctx.moveTo(a.x, a.y);
                                ctx.lineTo(b.x, b.y);
                            }
                            if (y === NY - 1 || depth[i + NX] < WET_THRESHOLD) {
                                const a = this._map.latLngToContainerPoint([south, west]);
                                const b = this._map.latLngToContainerPoint([south, east]);
                                ctx.moveTo(a.x, a.y);
                                ctx.lineTo(b.x, b.y);
                            }
                        }
                    }
                    ctx.stroke();
                    ctx.restore();
                }
            });

            function colorForDepth(h, x, y) {
                const intensity = Math.min(1, h / 8);
                const shimmer = 0.5 + 0.5 * Math.sin((x * 0.31 + y * 0.19 + simulationTime * 0.09));
                return [
                    Math.round(15 + intensity * 10),
                    Math.round(112 + intensity * 72 + shimmer * 9),
                    Math.round(190 + intensity * 55),
                    Math.round(Math.min(218, 90 + intensity * 105))
                ];
            }

            floodCanvasLayer = new FloodCanvas();
            floodCanvasLayer.addTo(map);

            const hydrograph = new Chart(document.getElementById("hydrograph"), {
                type: "line",
                data: {
                    labels: [],
                    datasets: [{
                        label: "Water depth (m)",
                        data: [],
                        borderColor: "#62d4e8",
                        backgroundColor: "rgba(35, 155, 203, .18)",
                        fill: true,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.25
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
                    scales: {
                        x: { title: { display: true, text: "Simulation time (h)", color: "#91a4af", font: { size: 10 } },
                            ticks: { color: "#91a4af", maxTicksLimit: 6, font: { size: 9 } }, grid: { color: "#2a3a45" } },
                        y: { beginAtZero: true, title: { display: true, text: "Depth (m)", color: "#91a4af", font: { size: 10 } },
                            ticks: { color: "#91a4af", maxTicksLimit: 5, font: { size: 9 } }, grid: { color: "#2a3a45" } }
                    }
                }
            });

            let simulationTime = 0;
            let animationId = null;
            let running = false;
            let lastChartTime = -Infinity;
            const runButton = document.getElementById("run-button");
            const demStatus = document.getElementById("dem-status");
            const mapNote = document.getElementById("map-note");
            document.getElementById("probe-note").textContent =
                `Fixed model-cell probe ${((downstreamProbeY - damY) * dy / 1000).toFixed(1)} km south of the dam (diagnostic point, not a gauging station).`;
            const roughness = 0.04;

            function readInputs() {
                const values = {
                    reservoir: Number(document.getElementById("reservoir-level").value),
                    discharge: Number(document.getElementById("discharge").value),
                    width: Number(document.getElementById("breach-width").value),
                    breachDepth: Number(document.getElementById("breach-depth").value),
                    duration: Number(document.getElementById("duration").value)
                };
                if (Object.values(values).some(value => !Number.isFinite(value)) ||
                    values.reservoir < 600 || values.reservoir > 900 ||
                    values.discharge < 100 || values.discharge > 100000 ||
                    values.width < 10 || values.width > 1000 ||
                    values.breachDepth < 1 || values.breachDepth > 200 ||
                    values.duration < 0.25 || values.duration > 24) {
                    throw new Error("Check the simulation values: each field must be within its allowed range.");
                }
                return values;
            }

            function hydrographDischarge(time, inputs) {
                if (time >= inputs.duration * 3600) return 0;
                const damBed = bed[indexOf(damX, damY)];
                const headRatio = Math.max(0, inputs.reservoir - damBed) / Math.max(1, 812 - damBed);
                const recession = Math.pow(Math.max(0, 1 - time / (inputs.duration * 3600)), 1.15);
                return inputs.discharge * Math.sqrt(headRatio) * recession;
            }

            function downstreamDepth() {
                return depth[downstreamProbe];
            }

            function rusanovBed(left, right, xDirection, outH, outX, outY, correctionLeft, correctionRight, k) {
                // Copy the interior state at the domain edge for a zero-gradient outflow boundary.
                const interior = left < 0 ? right : left;
                let hL = left < 0 ? depth[interior] : depth[left];
                let xL = left < 0 ? qx[interior] : qx[left];
                let yL = left < 0 ? qy[interior] : qy[left];
                let hR = right < 0 ? depth[interior] : depth[right];
                let xR = right < 0 ? qx[interior] : qx[right];
                let yR = right < 0 ? qy[interior] : qy[right];
                if (hL < DRY) { hL = 0; xL = 0; yL = 0; }
                if (hR < DRY) { hR = 0; xR = 0; yR = 0; }
                const zL = left < 0 ? bed[right] : bed[left];
                const zR = right < 0 ? bed[left] : bed[right];
                const faceBed = Math.max(zL, zR);
                const originalHL = hL;
                const originalHR = hR;
                hL = Math.max(0, hL + zL - faceBed);
                hR = Math.max(0, hR + zR - faceBed);
                if (originalHL > DRY) {
                    const scale = hL / originalHL;
                    xL *= scale;
                    yL *= scale;
                } else {
                    xL = 0;
                    yL = 0;
                }
                if (originalHR > DRY) {
                    const scale = hR / originalHR;
                    xR *= scale;
                    yR *= scale;
                } else {
                    xR = 0;
                    yR = 0;
                }
                const uL = hL > 0 ? xL / hL : 0;
                const vL = hL > 0 ? yL / hL : 0;
                const uR = hR > 0 ? xR / hR : 0;
                const vR = hR > 0 ? yR / hR : 0;
                const waveL = Math.sqrt(G * hL);
                const waveR = Math.sqrt(G * hR);
                const speed = xDirection
                    ? Math.max(Math.abs(uL) + waveL, Math.abs(uR) + waveR)
                    : Math.max(Math.abs(vL) + waveL, Math.abs(vR) + waveR);
                let f0L, f1L, f2L, f0R, f1R, f2R;
                if (xDirection) {
                    f0L = xL; f1L = xL * uL + 0.5 * G * hL * hL; f2L = xL * vL;
                    f0R = xR; f1R = xR * uR + 0.5 * G * hR * hR; f2R = xR * vR;
                } else {
                    f0L = yL; f1L = yL * uL; f2L = yL * vL + 0.5 * G * hL * hL;
                    f0R = yR; f1R = yR * uR; f2R = yR * vR + 0.5 * G * hR * hR;
                }
                outH[k] = 0.5 * (f0L + f0R) - 0.5 * speed * (hR - hL);
                outX[k] = 0.5 * (f1L + f1R) - 0.5 * speed * (xR - xL);
                outY[k] = 0.5 * (f2L + f2R) - 0.5 * speed * (yR - yL);
                const correctionL = 0.5 * G * Math.max(0, originalHL * originalHL - hL * hL);
                const correctionR = 0.5 * G * Math.max(0, originalHR * originalHR - hR * hR);
                correctionLeft[k] = correctionL;
                correctionRight[k] = correctionR;
            }

            function solverStep(inputs) {
                let maxSignal = 8;
                for (let i = 0; i < CELLS; i++) {
                    const h = depth[i];
                    if (h > DRY) {
                        const speed = Math.hypot(qx[i] / h, qy[i] / h) + Math.sqrt(G * h);
                        if (speed > maxSignal) maxSignal = speed;
                    }
                }
                const dt = Math.min(3, 0.32 * Math.min(dx, dy) / maxSignal, inputs.duration * 3600 - simulationTime);

                for (let y = 0; y < NY; y++) {
                    for (let x = 0; x <= NX; x++) {
                        const left = x > 0 ? indexOf(x - 1, y) : -1;
                        const right = x < NX ? indexOf(x, y) : -1;
                        const k = y * (NX + 1) + x;
                        rusanovBed(left, right, true, fxH, fxX, fxY,
                            fxCorrectionLeft, fxCorrectionRight, k);
                    }
                }
                for (let y = 0; y <= NY; y++) {
                    for (let x = 0; x < NX; x++) {
                        const north = y > 0 ? indexOf(x, y - 1) : -1;
                        const south = y < NY ? indexOf(x, y) : -1;
                        const k = y * NX + x;
                        rusanovBed(north, south, false, fyH, fyX, fyY,
                            fyCorrectionNorth, fyCorrectionSouth, k);
                    }
                }

                const qIn = hydrographDischarge(simulationTime, inputs);
                const widthCells = Math.max(1, Math.ceil(inputs.width / dx));
                const sourceCells = [];
                const firstSourceX = damX - Math.floor((widthCells - 1) / 2);
                for (let sx = 0; sx < widthCells; sx++) {
                    const x = firstSourceX + sx;
                    if (x >= 0 && x < NX) sourceCells.push(indexOf(x, damY));
                }
                const sourceRate = qIn / (sourceCells.length * cellArea);
                const breachVelocity = Math.sqrt(2 * G * Math.min(inputs.breachDepth,
                    Math.max(0, inputs.reservoir - bed[indexOf(damX, damY)])));
                for (let y = 0; y < NY; y++) {
                    for (let x = 0; x < NX; x++) {
                        const i = indexOf(x, y);
                        let h = depth[i] - (fxH[y * (NX + 1) + x + 1] - fxH[y * (NX + 1) + x]) * dt / dx
                            - (fyH[(y + 1) * NX + x] - fyH[y * NX + x]) * dt / dy;
                        let mx = qx[i] - ((fxX[y * (NX + 1) + x + 1] + fxCorrectionLeft[y * (NX + 1) + x + 1])
                            - (fxX[y * (NX + 1) + x] + fxCorrectionRight[y * (NX + 1) + x])) * dt / dx
                            - (fyX[(y + 1) * NX + x] - fyX[y * NX + x]) * dt / dy;
                        let my = qy[i] - (fxY[y * (NX + 1) + x + 1] - fxY[y * (NX + 1) + x]) * dt / dx
                            - ((fyY[(y + 1) * NX + x] + fyCorrectionNorth[(y + 1) * NX + x])
                            - (fyY[y * NX + x] + fyCorrectionSouth[y * NX + x])) * dt / dy;

                        if (h > DRY) {
                            const u = mx / h;
                            const v = my / h;
                            const speed = Math.hypot(u, v);
                            if (speed > 0) {
                                const dragCoefficient = G * roughness * roughness * speed / Math.pow(Math.max(h, 0.05), 4 / 3);
                                const factor = 1 / (1 + dt * dragCoefficient);
                                mx *= factor;
                                my *= factor;
                            }
                            const boundedSpeed = Math.hypot(mx / h, my / h);
                            if (boundedSpeed > 35) {
                                const scale = 35 / boundedSpeed;
                                mx *= scale;
                                my *= scale;
                            }
                        } else {
                            h = 0;
                            mx = 0;
                            my = 0;
                        }
                        nextDepth[i] = Math.max(0, h);
                        nextQx[i] = mx;
                        nextQy[i] = my;
                    }
                }

                for (const i of sourceCells) {
                    nextDepth[i] += sourceRate * dt;
                    nextQy[i] += sourceRate * breachVelocity * dt;
                }
                depth.set(nextDepth);
                qx.set(nextQx);
                qy.set(nextQy);
                simulationTime += dt;
                return dt;
            }

            function formatClock(seconds) {
                const total = Math.floor(seconds);
                const hours = Math.floor(total / 3600);
                const minutes = Math.floor((total % 3600) / 60);
                const secs = total % 60;
                return [hours, minutes, secs].map(value => String(value).padStart(2, "0")).join(":");
            }

            function updateTelemetry(inputs) {
                let maxDepth = 0;
                let wetCells = 0;
                for (let i = 0; i < CELLS; i++) {
                    if (depth[i] > maxDepth) maxDepth = depth[i];
                    if (depth[i] >= WET_THRESHOLD) wetCells++;
                }
                document.getElementById("stat-time").textContent = formatClock(simulationTime);
                document.getElementById("stat-depth").textContent = `${maxDepth.toFixed(2)} m`;
                document.getElementById("stat-area").textContent = `${(wetCells * cellArea / 1e6).toFixed(2)} km²`;
                const chartInterval = Math.max(60, inputs.duration * 3600 / 119);
                if (simulationTime - lastChartTime >= chartInterval || simulationTime === 0) {
                    hydrograph.data.labels.push((simulationTime / 3600).toFixed(2));
                    hydrograph.data.datasets[0].data.push(Number(downstreamDepth().toFixed(3)));
                    if (hydrograph.data.labels.length > 120) {
                        hydrograph.data.labels.shift();
                        hydrograph.data.datasets[0].data.shift();
                    }
                    hydrograph.update("none");
                    lastChartTime = simulationTime;
                }
                floodCanvasLayer.render();
            }

            function setRunning(isRunning) {
                running = isRunning;
                runButton.textContent = running ? "Ⅱ  Pause simulation" : "▶  Run simulation";
                if (!running && animationId !== null) {
                    cancelAnimationFrame(animationId);
                    animationId = null;
                }
            }

            function animateFrame() {
                if (!running) return;
                let inputs;
                try {
                    inputs = readInputs();
                    for (let n = 0; n < 4; n++) {
                        if (simulationTime >= inputs.duration * 3600) break;
                        solverStep(inputs);
                    }
                    updateTelemetry(inputs);
                    if (simulationTime >= inputs.duration * 3600) {
                        setRunning(false);
                        return;
                    }
                    animationId = requestAnimationFrame(animateFrame);
                } catch (error) {
                    setRunning(false);
                    window.alert(error.message);
                }
            }

            function resetSimulation() {
                setRunning(false);
                simulationTime = 0;
                depth.fill(0);
                qx.fill(0);
                qy.fill(0);
                hydrograph.data.labels = [];
                hydrograph.data.datasets[0].data = [];
                hydrograph.update();
                lastChartTime = -Infinity;
                const safeInputs = readInputs();
                updateTelemetry(safeInputs);
            }

            runButton.addEventListener("click", () => {
                if (running) {
                    setRunning(false);
                    return;
                }
                try {
                    readInputs();
                    setRunning(true);
                    animationId = requestAnimationFrame(animateFrame);
                } catch (error) {
                    window.alert(error.message);
                }
            });
            document.getElementById("reset-button").addEventListener("click", resetSimulation);

            function rasterCoordinates(raster, lat, lng) {
                let projection = raster.projection;
                if (typeof projection === "string" && projection.toUpperCase().startsWith("EPSG:")) projection = Number(projection.split(":")[1]);
                if (!projection && Math.abs(raster.xmin) <= 180 && Math.abs(raster.xmax) <= 180 &&
                    Math.abs(raster.ymin) <= 90 && Math.abs(raster.ymax) <= 90) return [lng, lat];
                if (Number(projection) === 4326) return [lng, lat];
                if (Number(projection) === 3857) return proj4("EPSG:4326", "EPSG:3857", [lng, lat]);
                const code = Number(projection);
                if (code >= 32601 && code <= 32660) {
                    const crs = `EPSG:${code}`;
                    proj4.defs(crs, `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`);
                    return proj4("EPSG:4326", crs, [lng, lat]);
                }
                if (code >= 32701 && code <= 32760) {
                    const crs = `EPSG:${code}`;
                    proj4.defs(crs, `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`);
                    return proj4("EPSG:4326", crs, [lng, lat]);
                }
                throw new Error(`Unsupported GeoTIFF coordinate system (EPSG:${projection || "unknown"}). Use a geographic, Web Mercator, or WGS84 UTM GeoTIFF.`);
            }

            function makeDemSampler(raster) {
                const values = raster.values && raster.values[0];
                if (!values || !raster.width || !raster.height) throw new Error("The GeoTIFF has no readable first elevation band.");
                return (lat, lng) => {
                    const [x, y] = rasterCoordinates(raster, lat, lng);
                    const col = (x - raster.xmin) / (raster.xmax - raster.xmin) * raster.width;
                    const row = (raster.ymax - y) / (raster.ymax - raster.ymin) * raster.height;
                    if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || col < 0 ||
                        row >= raster.height || col >= raster.width) return NaN;
                    const r = Math.min(raster.height - 1, Math.floor(row));
                    const c = Math.min(raster.width - 1, Math.floor(col));
                    const value = values[r] && values[r][c];
                    if (!Number.isFinite(value) || value === raster.noDataValue) return NaN;
                    return value;
                };
            }

            function rebuildTerrain() {
                const terrain = new Float32Array(CELLS);
                for (let y = 0; y < NY; y++) {
                    const lat = EXTENT.north - (y + 0.5) / NY * (EXTENT.north - EXTENT.south);
                    for (let x = 0; x < NX; x++) {
                        const lng = EXTENT.west + (x + 0.5) / NX * (EXTENT.east - EXTENT.west);
                        const i = indexOf(x, y);
                        const value = demSampler ? demSampler(lat, lng) : NaN;
                        terrain[i] = Number.isFinite(value) ? value : NaN;
                    }
                }
                if (terrain.some(value => !Number.isFinite(value))) {
                    throw new Error("The DEM must contain valid elevation data at every model-cell center.");
                }
                bed.set(terrain);
                resetSimulation();
            }

            document.getElementById("dem-file").addEventListener("change", async event => {
                const file = event.target.files && event.target.files[0];
                if (!file) return;
                demStatus.textContent = "Reading GeoTIFF and sampling elevation grid…";
                let candidateLayer = null;
                try {
                    const raster = await parseGeoraster(await file.arrayBuffer());
                    const sampler = makeDemSampler(raster);
                    const candidateTerrain = new Float32Array(CELLS);
                    let validSamples = 0;
                    for (let y = 0; y < NY; y++) {
                        for (let x = 0; x < NX; x++) {
                            const lat = EXTENT.north - (y + 0.5) / NY * (EXTENT.north - EXTENT.south);
                            const lng = EXTENT.west + (x + 0.5) / NX * (EXTENT.east - EXTENT.west);
                            const value = sampler(lat, lng);
                            const i = indexOf(x, y);
                            if (Number.isFinite(value)) {
                                candidateTerrain[i] = value;
                                validSamples++;
                            }
                        }
                    }
                    if (validSamples !== CELLS) {
                        throw new Error(`The DEM covers only ${validSamples.toLocaleString()} of ${CELLS.toLocaleString()} model-cell centers. Supply a valid DEM covering the full simulation area; partial uploads are not mixed with another terrain source.`);
                    }
                    readInputs();
                    candidateLayer = new GeoRasterLayer({ georaster: raster, opacity: 0.42, resolution: 128 });
                    candidateLayer.addTo(map);
                    const previousLayer = demLayer;
                    bed.set(candidateTerrain);
                    demSampler = sampler;
                    demLayer = candidateLayer;
                    if (previousLayer) map.removeLayer(previousLayer);
                    resetSimulation();
                    demStatus.textContent = `Loaded ${file.name} · all ${CELLS.toLocaleString()} model-cell centers covered · band 1`;
                    mapNote.textContent = `Uploaded DEM active · blue shading shows water depth; red outline shows the inundation boundary`;
                } catch (error) {
                    if (candidateLayer && map.hasLayer(candidateLayer)) map.removeLayer(candidateLayer);
                    demStatus.textContent = `Could not load DEM: ${error.message}`;
                    window.alert(`GeoTIFF error: ${error.message}`);
                }
            });

            resetSimulation();
        })();
