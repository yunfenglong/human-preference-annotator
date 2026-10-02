const API_BASE = "/api";
const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get("token");
if (!token) {
    document.body.innerHTML = "<h2>Invalid or missing token. Access denied.</h2>";
    throw new Error("Missing token");
}
localStorage.setItem("token", token);
const ATTN_TIMEOUT = 10000; // 10s
// Pause-sampling config: default 1000 ms; override via ?ps=NNN
const PAUSE_SAMPLE_MS = Math.max(200, Number(urlParams.get("ps") || 1000)); // clamp min 200ms

function logout() {
    localStorage.removeItem("token");
    window.location.href = window.location.pathname;
}

let currentPair = null;
let annotatorId = "";
let presentedTime = null;
let requireRegion = false;
let awaitingRegion = false;
let pendingChoice = null;
let decisionAtMs = null;
let regionTimeoutId = null;
let submitting = false;
let pairLoading = true;
let studySettings = { cantTell: true, surprise: true, attention: true };
let attentionCleanup = null;

const presentation = new ExternalPresentation({
    onPlayback: () => { presentedTime ||= new Date(); },
    canSwitch: side => Boolean(currentPair && !pairLoading && !submitting &&
        (!psActive || side === presentation.selected)),
    isSampling: () => psActive,
    isCollecting: () => awaitingRegion,
    onClose: () => {
        const wasSampling = psActive;
        cancelPauseSampling();
        if (wasSampling) renderStepUI();
    },
    onChange: () => updateAnnotationAvailability(),
});
window.connectPresentation = popup => presentation.connect(popup);
const getVideo = side => presentation.videos[side];
const removeVideoOverlay = id => {
    Object.values(presentation.wrappers).forEach(wrap => wrap.querySelector(`#${id}`)?.remove());
};

function updateAnnotationAvailability() {
    const enabled = presentation.canAnnotate() && !submitting && !pairLoading;
    document.querySelectorAll('#buttons button').forEach(button => {
        button.disabled = !enabled || (psActive && (button.id === 'startPS' || button.id === 'skipPS'));
    });
}


// Pause-sampling (PS) lifecycle control
let psAbort = null; // AbortController used to fence all PS listeners
let psActive = false; // true while a PS session is in progress

function cancelPauseSampling() {
    // Abort all PS event listeners and reset flags/UI
    try {
        psAbort?.abort();
    } catch (_) {}
    psAbort = null;
    psActive = false;
    awaitingRegion = false;
    attentionCleanup?.();
    // remove any lingering overlays
    removeVideoOverlay("multiOverlay");
    removeVideoOverlay("pointOverlay");
}

// 3-step annotation state (Preference, Surprise, Attention)
const STEPS = { PREF: 0, SURPRISE: 1, ATTENTION: 2 };
const STEP_LABELS = ["Preference", "Surprise", "Attention"];
let step = STEPS.PREF;
let staged = null;

function ensureTopStepperEl() {
    let el = document.getElementById("stepper");
    if (!el) {
        const host = document.getElementById("topbar-center");
        el = document.createElement("div");
        el.id = "stepper";
        el.style.marginTop = "6px";
        host && host.appendChild(el);
    }
    return el;
}

function updateTopStepper(activeStepIdx = 0) {
    const el = ensureTopStepperEl();
    if (!el) return;

    const enabledSteps = activeStudySteps(studySettings);
    activeStepIdx = enabledSteps.indexOf(activeStepIdx);
    const steps = enabledSteps.map((stepId, idx) => {
        const label = STEP_LABELS[stepId];
        const status = idx < activeStepIdx ? "done" : idx === activeStepIdx ? "active" : "todo";
        const circleBg =
            status === "done" ? "#2ecc71" : status === "active" ? "#2980b9" : "#d0d7de";
        const circleColor = status === "todo" ? "#555" : "#fff";
        const border = status === "todo" ? "1px solid #9aa4ae" : "1px solid transparent";
        const connectorColor = idx < activeStepIdx ? "#2ecc71" : "#d0d7de";

        return `
      <div style="position:relative; display:flex; align-items:center;">
        <div style="
          width:22px;height:22px;border-radius:999px;
          background:${circleBg}; color:${circleColor};
          display:flex;align-items:center;justify-content:center;
          font:600 12px system-ui; border:${border};
          box-shadow: ${status !== "todo" ? "0 0 0 2px rgba(0,0,0,0.06) inset" : "none"};
        ">${idx + 1}</div>
        <div style="margin-left:8px; min-width:88px; font:600 12px system-ui; color:#111;">
          ${label}
        </div>
        ${
            idx < enabledSteps.length - 1
                ? `<div style="flex:1;height:2px;background:${connectorColor};margin:0 14px 0 0;border-radius:2px;">\u00A0\u00A0</div>`
                : ``
        }
      </div>
    `;
    }).join("");

    el.innerHTML = `
    <div style="display:flex;align-items:center;gap:0; padding:6px 8px;">
      ${steps}
    </div>
  `;
}

function resetStepperForPair() {
    step = STEPS.PREF;
    staged = {
        preference: null,
        decisionAtMs: null,
        surpriseChoice: null,
        surprise: { left: null, right: null },
        attention: null,
        startedAt: Date.now(),
        stepT0: Date.now(),
        stepDurations: {},
    };
    renderStepUI();
    updateTopStepper(0);
    updateAnnotationAvailability();
}

function markStepAdvance(nextStep) {
    if (!presentation.requireFullscreen() || submitting || pairLoading) return;
    const now = Date.now();
    staged.stepDurations[step] = (staged.stepDurations[step] || 0) + (now - (staged.stepT0 || now));
    step = nextStep;
    staged.stepT0 = now;
    renderStepUI();
    updateTopStepper(nextStep);
    updateAnnotationAvailability();
}

function advanceStudyStep() {
    const next = nextStudyStep(studySettings, step);
    if (next === null) submitStagedAnnotation();
    else markStepAdvance(next);
}

function renderStepUI() {
    const notes = document.getElementById("notes");
    const buttons = document.getElementById("buttons");
    const chosen = staged?.preference;
    notes.innerHTML =
        // `<p id="instructions"><strong>${stepName}</strong></p>` +
        step === STEPS.PREF
            ? `<p id="instructions">Press 1 or 2 to watch. Choose your preference: ↑ = Up, ↓ = Down${studySettings.cantTell ? ", C = Can't tell" : ""}.</p>`
            : step === STEPS.SURPRISE
            ? `<p id="instructions">Which clip surprised you more? ↑ = Up, ↓ = Down, N = No surprising event. Press 1 or 2 to replay.</p>`
            : `<p id="instructions">Mark the spot that drove your choice on the <b>${
                  chosen === "left" ? "Up" : "Down"
              }</b> clip. Press X to place (or click the video). Esc cancels.</p>`;

    if (step === STEPS.PREF) {
        buttons.innerHTML = `
      <button onclick="handleChoice('left')">↑ Prefer Up</button>
      <button onclick="handleChoice('right')">↓ Prefer Down</button>
      ${studySettings.cantTell ? '<button onclick="handleChoice(\'cant_tell\')">C Can\'t Tell</button>' : ''}`;
    }

    else if (step === STEPS.SURPRISE) {
        buttons.innerHTML = `
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <button id="surL">Up surprised me more</button>
            <button id="surR">Down surprised me more</button>
            <button id="surNone">No surprising event</button>
            <button id="advToggle" style="margin-left:12px;display:none">Advanced 1-5</button>
            <div id="advWrap" style="display:none; width:100%; padding-top:6px;">
                <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
                <div><div style="font-weight:600;margin-bottom:4px">Up clip</div>
                    ${[1, 2, 3, 4, 5]
                        .map(
                            (v) =>
                                `<button data-side="left" data-val="${v}" class="surBtn">${v}</button>`
                        )
                        .join(" ")}
                    <span id="leftSurVal" style="margin-left:8px">${
                        staged.surprise.left ?? "—"
                    }</span>
                </div>
                <div><div style="font-weight:600;margin-bottom:4px">Down clip</div>
                    ${[1, 2, 3, 4, 5]
                        .map(
                            (v) =>
                                `<button data-side="right" data-val="${v}" class="surBtn">${v}</button>`
                        )
                        .join(" ")}
                    <span id="rightSurVal" style="margin-left:8px">${
                        staged.surprise.right ?? "—"
                    }</span>
                </div>
                </div>
            </div>
            <div style="flex:1"></div>
            <button id="surpriseNext" style="display:none" disabled>Next</button>
            </div>`;

        const canNext = () => !!staged.surpriseChoice; // binary choice required
        const updateNext = () => {
            const n = document.getElementById("surpriseNext");
            if (n) n.disabled = !canNext();
        };

        document.getElementById("surL").addEventListener("click", () => {
            staged.surpriseChoice = "left";
            // updateNext();
            advanceStudyStep();
        });
        document.getElementById("surR").addEventListener("click", () => {
            staged.surpriseChoice = "right";
            // updateNext();
            advanceStudyStep();
        });
        document.getElementById("surNone").addEventListener("click", () => {
            staged.surpriseChoice = "none";
            // updateNext();
            advanceStudyStep();
        });

        const adv = document.getElementById("advWrap");
        document.getElementById("advToggle").addEventListener("click", () => {
            const open = adv.style.display !== "none";
            adv.style.display = open ? "none" : "block";
        });

        buttons.querySelectorAll(".surBtn").forEach((b) => {
            b.addEventListener("click", () => {
                const side = b.dataset.side,
                    val = Number(b.dataset.val);
                staged.surprise[side] = val;
                document.getElementById(
                    side === "left" ? "leftSurVal" : "rightSurVal"
                ).textContent = val;
            });
        });

        document.getElementById("surpriseNext").addEventListener("click", () => {
            if (canNext()) advanceStudyStep();
        });
    } else if (step === STEPS.ATTENTION) {
        const side = staged?.preference; // "left" | "right"
        const label = side === "left" ? "Up" : "Down";
        notes.innerHTML = `<p id="instructions">Replay in pause-sampling: we'll pause every <b>${PAUSE_SAMPLE_MS}ms</b>. Add <em>multiple</em> points at each stop, then press Space/Enter to continue.</p>`;
        buttons.innerHTML = `
      <button id="startPS">Start pause-sampling on ${label}</button>
      <button id="skipPS">Skip (no attention)</button>
    `;
        document.getElementById("startPS").addEventListener("click", () => {
            if (!presentation.requireFullscreen() || psActive) return;
            document.getElementById("startPS").disabled = true;
            document.getElementById("skipPS").disabled = true;
            startPauseSampling(side, (attention) => {
                staged.attention = attention;
                submitStagedAnnotation(); // auto-continue when done
            });
        });
        document.getElementById("skipPS").addEventListener("click", () => {
            staged.attention = null;
            submitStagedAnnotation();
        });
    }
}

function updateProgress(video, bar) {
    const percentage = video.duration > 0 ? (video.currentTime / video.duration) * 100 : 0;
    bar.style.width = `${percentage}%`;
    const vidProgressElm = document.getElementById("videoStatus");
    if (vidProgressElm && percentage > 85) {
        vidProgressElm.innerText = "Video Replaying...";
    } else {
        vidProgressElm.innerText = "\u00A0";
    }
}

function attachProgress(videoId, barId) {
    const side = videoId === "leftVideo" ? "left" : "right";
    const video = getVideo(side);
    const bar = presentation.bars[side];
    video.addEventListener("timeupdate", () => updateProgress(video, bar));
}

function renderPair(pair) {
    currentPair = pair;
    studySettings = pair.settings;
    presentation.cantTell = studySettings.cantTell;
    document.getElementById("cantTellHint").hidden = !studySettings.cantTell;
    const popupHint = presentation.popup?.document.getElementById("cantTellHint");
    if (popupHint) popupHint.hidden = !studySettings.cantTell;
    annotatorId = pair.progress?.annotatorId || "anonymous";
    document.getElementById("annotatorIdDisplay").innerText = `Annotator ID: ${annotatorId}`;
    requireRegion = !!pair._meta?.requireRegion;

    document.getElementById("description").innerText =
        `Task: ${pair.description}` +
        (pair._meta?.isGold ? "  (GOLD)" : "") +
        (pair._meta?.isRepeat ? "  (REPEAT)" : "");
    document.getElementById(
        "progress"
    ).innerText = `Progress: ${pair.progress.completed}/${pair.progress.total} pairs`;

    const leftVideo = getVideo("left");
    const rightVideo = getVideo("right");

    presentation.resetPair();
    presentedTime = null;
    for (const [side, video] of Object.entries(presentation.videos)) {
        video.muted = true;
        video.autoplay = false;
        video.loop = true;
        video.controls = false;
        video.preload = "auto";
        // Absolute URLs keep the same source when adopted into the display document.
        video.src = new URL(side === "left" ? pair.left_clip : pair.right_clip, location.href).href;
        video.load();
        presentation.bars[side].style.width = "0%";
    }
    pairLoading = false;
    resetStepperForPair();
}

function getNormalisedCoords(evt, el) {
    const rect = el.getBoundingClientRect();
    const clientX = (evt.touches && evt.touches[0]?.clientX) ?? evt.clientX;
    const clientY = (evt.touches && evt.touches[0]?.clientY) ?? evt.clientY;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

// Place marks on the actual image, excluding the letterbox bars.
function positionVideoOverlay(overlay, video) {
    const wrap = video.parentElement;
    const frame = video.getBoundingClientRect();
    const parent = wrap.getBoundingClientRect();
    const scale = Math.min(frame.width / video.videoWidth, frame.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    Object.assign(overlay.style, {
        inset: "auto",
        left: `${frame.left - parent.left + (frame.width - width) / 2}px`,
        top: `${frame.top - parent.top + (frame.height - height) / 2}px`,
        width: `${width}px`,
        height: `${height}px`,
    });
}

/**
 * showMultiPointCollector(side, onDone)
 * - Lets user add multiple points on the chosen video frame.
 * - Toolbar: Add by click/tap; Z to undo last; C to clear; Space/Enter to continue (finish this stop).
 * - Returns array of {x,y} in normalised coords via onDone(points).
 */
function showMultiPointCollector(side, onDone) {
    awaitingRegion = true;
    const video = getVideo(side);
    const wrap = video.parentElement;
    wrap.style.position = wrap.style.position || "relative";

    // Ensure only one overlay at a time
    removeVideoOverlay("multiOverlay");

    const overlay = document.createElement("div");
    overlay.id = "multiOverlay";
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.cursor = "crosshair";
    overlay.style.zIndex = "10";
    overlay.style.background = "rgba(0,0,0,0.10)";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Mark multiple points of interest");

    // Toolbar
    const bar = document.createElement("div");
    bar.style.position = "absolute";
    bar.style.left = "50%";
    bar.style.bottom = "8px";
    bar.style.transform = "translateX(-50%)";
    bar.style.padding = "6px 10px";
    bar.style.background = "rgba(0,0,0,0.65)";
    bar.style.color = "#fff";
    bar.style.borderRadius = "6px";
    bar.style.font = "600 12px system-ui";
    bar.textContent = "Click to add points | Z=Undo | C=Clear | Space/Enter=Next";
    overlay.appendChild(bar);

    const points = [];
    const markers = [];
    const addMarker = (x, y) => {
        const m = document.createElement("div");
        m.style.position = "absolute";
        m.style.left = `${x * 100}%`;
        m.style.top = `${y * 100}%`;
        m.style.transform = "translate(-50%, -50%)";
        m.style.width = "12px";
        m.style.height = "12px";
        m.style.borderRadius = "50%";
        m.style.border = "2px solid #fff";
        m.style.boxShadow = "0 1px 2px rgba(0,0,0,.6)";
        m.style.pointerEvents = "none";
        overlay.appendChild(m);
        markers.push(m);
    };

    const click = (evt) => {
        if (!presentation.isFullscreen()) return;
        const { x, y } = getNormalisedCoords(evt, overlay);
        points.push({ x, y });
        addMarker(x, y);
    };
    const undo = () => {
        points.pop();
        const m = markers.pop();
        if (m) m.remove();
    };
    const clearAll = () => {
        points.length = 0;
        while (markers.length) markers.pop().remove();
    };
    const finish = () => {
        if (!presentation.isFullscreen()) return;
        cleanup();
        onDone(points.slice());
    };
    const onKey = (e) => {
        if (!presentation.isFullscreen()) return;
        if (e.key === "z" || e.key === "Z") {
            e.preventDefault();
            undo();
        } else if (e.key === "c" || e.key === "C") {
            e.preventDefault();
            clearAll();
        } else if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            finish();
        }
    };

    overlay.addEventListener("click", click);
    window.addEventListener("keydown", onKey);
    wrap.appendChild(overlay);
    positionVideoOverlay(overlay, video);
    const resizeOverlay = () => positionVideoOverlay(overlay, video);
    video.ownerDocument.defaultView.addEventListener("resize", resizeOverlay);
    attentionCleanup = cleanup;

    function cleanup() {
        video.ownerDocument.defaultView.removeEventListener("resize", resizeOverlay);
        if (attentionCleanup === cleanup) attentionCleanup = null;
        window.removeEventListener("keydown", onKey);
        overlay.remove();
        awaitingRegion = false;
    }
}

/**
 * startPauseSampling(side, onDone)
 * Pauses every N ms, collects multiple points per stop, resumes until end.
 * All listeners are attached with an AbortController to guarantee teardown.
 */
function startPauseSampling(side, onDone) {
    if (!presentation.requireFullscreen()) return;
    if (getVideo(side).readyState < 2 || getVideo(side).error) {
        presentation.setStatus("Watch the preferred video before starting attention marks. If it cannot play, contact the administrator.");
        renderStepUI();
        updateAnnotationAvailability();
        return;
    }
    presentation.select(side);
    const chosenVideo = getVideo(side);
    const otherVideo = getVideo(side === "left" ? "right" : "left");

    // Ensure previous sessions are fully stopped
    cancelPauseSampling();
    psAbort = new AbortController();
    const { signal } = psAbort;
    psActive = true;

    // Prepare playback
    otherVideo.pause();
    chosenVideo.loop = false;
    chosenVideo.controls = false;
    chosenVideo.currentTime = 0;
    chosenVideo.muted = true;

    const step = Math.max(200, Number(new URLSearchParams(location.search).get("ps") || 1000));
    const durMs = () => Math.floor((chosenVideo.duration || 0) * 1000);
    const breaks = [];
    for (let t = step; t < durMs() + 50; t += step) breaks.push(t);

    const samples = [];
    let idx = 0;
    let armed = true;

    const ensurePlaying = async () => {
        try {
            if (presentation.isFullscreen() && !awaitingRegion) await chosenVideo.play();
        } catch (_) {}
    };

    const finish = () => {
        if (!psActive) return;
        psActive = false;
        // Build payload and hand off
        const attention = {
            type: "pause-sampling",
            side,
            coordSpace: "normalised",
            samples,
            decisionAtMs: staged?.decisionAtMs ?? null,
        };
        cancelPauseSampling(); // tear down listeners/overlays
        onDone(attention);
    };

    const pauseAndCollect = (tsMs) => {
        if (!psActive || signal.aborted) return;
        chosenVideo.pause();
        showMultiPointCollector(side, (points) => {
            if (signal.aborted) return;
            samples.push({ tsMs, points: points || [] });
            idx += 1;
            if (idx >= breaks.length) {
                // Either we're at end already, or we need to coast to ended
                if (chosenVideo.ended || chosenVideo.duration - chosenVideo.currentTime < 0.05) {
                    finish();
                } else {
                    armed = false; // rely on 'ended' to finish
                    ensurePlaying();
                }
            } else {
                armed = true;
                ensurePlaying();
            }
        });
    };

    const onTime = () => {
        if (!psActive || signal.aborted || !presentation.isFullscreen() || !armed || idx >= breaks.length) return;
        const nowMs = Math.floor(chosenVideo.currentTime * 1000);
        const target = breaks[idx];
        if (nowMs >= target) {
            armed = false;
            pauseAndCollect(target);
        }
    };

    chosenVideo.addEventListener("timeupdate", onTime, { signal });
    chosenVideo.addEventListener(
        "ended",
        () => {
            if (!signal.aborted) finish();
        },
        { signal }
    );

    // Kick-off
    ensurePlaying();
}

function handleChoice(response) {
    if (step !== STEPS.PREF || submitting || pairLoading || !presentation.requireFullscreen()) return;
    if (response === "cant_tell" && !studySettings.cantTell) return;
    const leftVideo = getVideo("left");
    const rightVideo = getVideo("right");
    const chosenVideo = response === "left" ? leftVideo : response === "right" ? rightVideo : null;

    pendingChoice = response;
    decisionAtMs = chosenVideo ? Math.round(chosenVideo.currentTime * 1000) : null;

    if (!staged) resetStepperForPair();
    staged.preference = response;
    staged.decisionAtMs = decisionAtMs;

    if (response === "cant_tell") {
        // Skip Surprise/Attention when annotator can't tell
        staged.surprise = { left: null, right: null };
        staged.attention = null;
        submitStagedAnnotation();
        return;
    }
    advanceStudyStep();
}

async function loadNextPair() {
    pairLoading = true;
    presentation.resetPair();
    cancelPauseSampling();
    removeVideoOverlay("multiOverlay");
    removeVideoOverlay("pointOverlay");
    let res;
    try { res = await fetch(`${API_BASE}/clip-pairs?token=${token}`); }
    catch {
        presentation.setStatus("Could not load the next pair. Check your connection and refresh to retry.");
        return;
    }
    if (!res.ok) {
        presentation.close();
        if (res.status === 403) {
            document.getElementById("app").innerHTML =
                "<h2>Invalid token. Please check your link or contact the administrator.</h2>";
        } else {
            document.getElementById("app").innerHTML =
                "<h2>Server error. Please try again later.</h2>";
        }
        return;
    }

    const data = await res.json();
    if (!data) {
        presentation.close();
        document.getElementById("app").innerHTML = "<h2>All annotations complete. Thank you!</h2>";
        return;
    }
    renderPair(data);
}

window.onload = () => {
    loadNextPair();
    attachProgress("leftVideo", "leftProgress");
    attachProgress("rightVideo", "rightProgress");
};

async function submitStagedAnnotation() {
    if (submitting || pairLoading || !presentation.requireFullscreen()) return;
    submitting = true;
    updateAnnotationAvailability();
    cancelPauseSampling();
    // close current step timing
    if (staged) {
        const now = Date.now();
        staged.stepDurations[step] =
            (staged.stepDurations[step] || 0) + (now - (staged.stepT0 || now));
    }

    const response = staged.preference;
    const attention = staged.attention; // may be null
    const surprise = staged.surprise;
    const stageDurations = staged.stepDurations;

    const nowDate = new Date();
    const responseTimeMs = presentedTime ? nowDate - presentedTime : undefined;

    let result;
    try {
        result = await fetch(`${API_BASE}/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            token,
            pairId: currentPair.pair_id,
            response, // "left" | "right" | "cant_tell"
            surpriseChoice: staged.surpriseChoice,
            left: { url: currentPair.left_clip, surprise: surprise?.left ?? null },
            right: { url: currentPair.right_clip, surprise: surprise?.right ?? null },
            presentedTime,
            responseTimeMs,
            isGold: currentPair._meta?.isGold || false,
            isRepeat: currentPair._meta?.isRepeat || false,
            repeatOf: currentPair._meta?.repeatOf,
            attention,
            stageDurations, // optional; backend can ignore
        }),
    });
    } catch {
        // Retain staged answers for retry.
    }
    submitting = false;
    if (!result?.ok) {
        presentation.setStatus("Could not save your annotation. Please try again.");
        if (!document.getElementById("retrySave")) {
            const retry = document.createElement("button");
            retry.id = "retrySave";
            retry.textContent = "Retry saving annotation";
            retry.addEventListener("click", submitStagedAnnotation);
            document.getElementById("buttons").appendChild(retry);
        }
        updateAnnotationAvailability();
        return;
    }
    loadNextPair();
}

// Both windows share shortcuts; 1 / 2 always select playback, never ratings.
window.addEventListener("keydown", event => {
    if (event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    const el = document.activeElement;
    if (el?.matches("input, textarea, select, [contenteditable=true]")) return;
    if (event.key === "1" || event.key === "2") {
        event.preventDefault();
        presentation.play(event.key === "1" ? "left" : "right");
        return;
    }
    if (awaitingRegion || pairLoading || submitting) return;
    if (step === STEPS.PREF) {
        if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key.toLowerCase() === "c") {
            event.preventDefault();
            if (event.key.toLowerCase() === "c" && !studySettings.cantTell) return;
            handleChoice(event.key === "ArrowUp" ? "left" : event.key === "ArrowDown" ? "right" : "cant_tell");
        }
    } else if (step === STEPS.SURPRISE) {
        const id = event.key === "ArrowUp" ? "surL" : event.key === "ArrowDown" ? "surR" :
            event.key.toLowerCase() === "n" ? "surNone" : null;
        if (id) { event.preventDefault(); document.getElementById(id)?.click(); }
    } else if (step === STEPS.ATTENTION && event.key.toLowerCase() === "x") {
        event.preventDefault();
        document.getElementById("startPS")?.click();
    }
}, { passive: false });
