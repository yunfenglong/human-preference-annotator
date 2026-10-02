// The original video elements live in the display window so playback, pause
// sampling, and attention marks all refer to the same frames.
class ExternalPresentation {
    constructor({ onPlayback, canSwitch, onChange, isSampling, isCollecting, onClose }) {
        this.videos = {
            left: document.getElementById("leftVideo"),
            right: document.getElementById("rightVideo"),
        };
        this.wrappers = Object.fromEntries(Object.entries(this.videos)
            .map(([side, video]) => [side, video.parentElement]));
        this.bars = {
            left: document.getElementById("leftProgress"),
            right: document.getElementById("rightProgress"),
        };
        this.home = document.getElementById("videos");
        this.onPlayback = onPlayback;
        this.canSwitch = canSwitch;
        this.onChange = onChange;
        this.isSampling = isSampling;
        this.isCollecting = isCollecting;
        this.onClose = onClose;
        this.selected = null;
        this.popup = null;
        this.stage = null;
        this.busy = false;
        this.generation = 0;
        this.setStatus("Connect an extended display, then choose your video screen.");
        document.getElementById("chooseDisplay").addEventListener("click", () => this.chooseScreen());
        document.getElementById("openDisplay").addEventListener("click", () => this.open());
        document.getElementById("displayScreen").addEventListener("change", () => this.close());
        for (const [side, video] of Object.entries(this.videos)) {
            document.getElementById(`play-${side}`).addEventListener("click", () => this.play(side));
            video.addEventListener("play", () => {
                if (!this.isFullscreen() || side !== this.selected) video.pause();
            });
            video.addEventListener("error", () => {
                if (side === this.selected) this.setStatus("Video unavailable. Ask the administrator to check the video upload.");
            });
        }
        window.addEventListener("pagehide", () => this.close());
    }

    setStatus(message) {
        const status = document.getElementById("displayStatus");
        if (status) status.textContent = message;
        const help = this.popup && !this.popup.closed && this.popup.document.getElementById("displayMessage");
        if (help) help.textContent = message;
    }

    isFullscreen() {
        return Boolean(this.popup && !this.popup.closed && this.stage &&
            this.popup.document.fullscreenElement === this.stage);
    }

    canAnnotate() {
        return this.isFullscreen() && !this.busy && this.selected &&
            this.videos[this.selected].readyState >= 2 && !this.videos[this.selected].error;
    }

    requireFullscreen() {
        if (this.canAnnotate()) return true;
        this.setStatus("Press 1 or 2 in the video window to play in fullscreen before continuing.");
        return false;
    }

    pause() {
        Object.values(this.videos).forEach(video => video.pause());
    }

    async chooseScreen() {
        if (!("getScreenDetails" in window)) {
            this.setStatus("This browser cannot select a second screen. Open your annotation link in desktop Chrome.");
            return;
        }
        try {
            this.details = await window.getScreenDetails();
            if (!this.watchScreens) {
                this.watchScreens = () => { this.close(); this.populateScreens(); };
                this.details.addEventListener("screenschange", this.watchScreens);
                this.details.addEventListener("currentscreenchange", this.watchScreens);
            }
            this.populateScreens();
        } catch {
            this.setStatus("Screen access was denied. Allow window management in your browser's site settings and try again.");
        }
    }

    populateScreens() {
        const select = document.getElementById("displayScreen");
        select.replaceChildren();
        this.screens = this.details.screens.filter(screen => screen !== this.details.currentScreen);
        this.screens.forEach((screen, index) => {
            const option = document.createElement("option");
            option.value = String(index);
            option.textContent = `${screen.label || `Display ${index + 2}`} · ${screen.width} × ${screen.height}`;
            select.appendChild(option);
        });
        select.hidden = this.screens.length === 0;
        document.getElementById("openDisplay").disabled = this.screens.length === 0;
        this.setStatus(this.screens.length ? "Choose a screen, then open the video window." :
            "No second screen detected. Set your displays to Extend, then try again.");
    }

    open() {
        if (!this.screens?.length) return;
        if (this.popup && !this.popup.closed) { this.popup.focus(); return; }
        const screen = this.screens[Number(document.getElementById("displayScreen").value)];
        if (!screen || screen === this.details.currentScreen) return;
        this.screen = screen;
        this.popup = window.open("/display.html", "annotation-video-display",
            `popup,left=${screen.availLeft},top=${screen.availTop},width=${screen.availWidth},height=${screen.availHeight}`);
        if (!this.popup) {
            this.setStatus("The video window was blocked. Allow pop-ups for this site, then try again.");
            return;
        }
        this.setStatus("In the video window, press 1 or 2 to enter fullscreen and play.");
    }

    connect(popup) {
        if (popup !== this.popup) return;
        this.pause();
        this.stage = popup.document.getElementById("displayStage");
        this.selected = null;
        for (const wrap of Object.values(this.wrappers)) {
            wrap.hidden = true;
            this.stage.appendChild(wrap);
        }
        popup.document.addEventListener("fullscreenchange", () => {
            if (popup !== this.popup) return;
            if (!this.isFullscreen()) {
                this.generation++;
                this.pause();
                this.stage.classList.remove("has-video");
                Object.values(this.wrappers).forEach(wrap => { wrap.hidden = true; });
                this.setStatus("Fullscreen exited. Press 1 or 2 in the video window to resume.");
            }
            this.onChange();
        });
        popup.addEventListener("pagehide", () => {
            if (popup === this.popup) this.restore();
        });
        popup.addEventListener("keydown", event => {
            if (event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey ||
                event.target.closest?.("input, textarea, select, [contenteditable=true]")) return;
            if (event.key === "1" || event.key === "2") {
                event.preventDefault();
                this.play(event.key === "1" ? "left" : "right");
                return;
            }
            // Preference and attention shortcuts work while either window has focus.
            const forwarded = new KeyboardEvent("keydown", { key: event.key, code: event.code, cancelable: true });
            window.dispatchEvent(forwarded);
            if (forwarded.defaultPrevented) event.preventDefault();
        });
        popup.document.querySelectorAll("[data-play]").forEach(button => {
            button.addEventListener("click", () => this.play(button.dataset.play));
        });
        document.getElementById("play-left").disabled = false;
        document.getElementById("play-right").disabled = false;
        const hint = popup.document.getElementById("cantTellHint");
        if (hint) hint.hidden = !this.cantTell;
        this.setStatus("In the video window, press 1 for Up or 2 for Down. ↑ / ↓ chooses your preference.");
        this.onChange();
    }

    select(side) {
        this.pause();
        this.selected = side;
        for (const [key, wrap] of Object.entries(this.wrappers)) wrap.hidden = key !== side;
        if (this.stage) this.stage.classList.add("has-video");
        const label = this.popup?.document.getElementById("displayLabel");
        if (label) label.textContent = side === "left" ? "1 · Up" : "2 · Down";
    }

    async play(side) {
        if (!this.canSwitch(side)) {
            this.setStatus("Finish the attention marks on this video before switching.");
            return;
        }
        if (!this.stage || !this.popup || this.popup.closed) {
            this.setStatus("Choose your second screen and open the video window first.");
            return;
        }
        if (this.busy) return;
        this.busy = true;
        const generation = ++this.generation;
        this.pause();
        this.onChange();
        try {
            if (!this.isFullscreen()) {
                // Call immediately from the key/click gesture; no asynchronous work first.
                await this.stage.requestFullscreen({ screen: this.screen, navigationUI: "hide" });
            }
            if (generation !== this.generation || !this.isFullscreen()) return;
            const sampling = this.isSampling();
            this.select(side);
            const video = this.videos[side];
            if (!sampling) video.currentTime = 0;
            this.setStatus(`Playing ${side === "left" ? "Up (1)" : "Down (2)"} · ↑ prefer Up · ↓ prefer Down${this.cantTell ? " · C can't tell" : ""}`);
            if (sampling && this.isCollecting()) return;
            await video.play();
            if (generation !== this.generation || !this.isFullscreen()) { video.pause(); return; }
            this.onPlayback();
        } catch {
            this.pause();
            this.stage?.classList.remove("has-video");
            Object.values(this.wrappers).forEach(wrap => { wrap.hidden = true; });
            this.setStatus(this.isFullscreen() ? "Video unavailable. Ask the administrator to check the video upload." :
                "Click the video window, then press 1 or 2 to enter fullscreen. Playback stays paused until fullscreen is allowed.");
        } finally {
            this.busy = false;
            this.onChange();
        }
    }

    resetPair() {
        this.generation++;
        this.pause();
        this.selected = null;
        Object.values(this.wrappers).forEach(wrap => { wrap.hidden = true; });
        this.stage?.classList.remove("has-video");
        this.setStatus("Press 1 for Up or 2 for Down to watch the next pair in fullscreen.");
        this.onChange();
    }

    restore() {
        this.onClose();
        this.resetPair();
        for (const wrap of Object.values(this.wrappers)) this.home.appendChild(wrap);
        this.popup = null;
        this.stage = null;
        document.getElementById("play-left").disabled = true;
        document.getElementById("play-right").disabled = true;
        this.setStatus("Video window closed. Open it again to continue.");
        this.onChange();
    }

    close() {
        const popup = this.popup;
        if (popup) this.restore();
        if (popup && !popup.closed) popup.close();
    }
}
