(() => {
"use strict";

const JOINTS = ["BASE","SHOULDER","ELBOW","WRIST ROLL","WRIST YAW","GRIPPER"];
const $ = id => document.getElementById(id);

const jointColumn = $("joints");
const connect = $("connect");
const disconnect = $("disconnect");
const dot = $("dot");
const connText = $("connText");
const count = $("count");
const importFile = $("importFile");
const toast = $("toast");

const sliders = [];
const values = [];

let saved = [];
let undoStack = [];
let redoStack = [];
let stopped = false;
let playing = false;
let mode = "DIGITAL TWIN"; // SIMULATION | HARDWARE | DIGITAL TWIN
let operatorMode = "MANUAL"; // MANUAL | AUTO
let speedPercent = 55;
let selectedJoint = 0;
let jogStep = 5;
let loopCount = 1;
let sequenceStep = 0;
let robotState = "IDLE";
let activeProfile = "LAB";

const PRESETS = {
    HOME:  [0,0,0,0,0,0],
    READY: [0,-10,15,0,0,-10],
    PICK:  [0,-20,25,0,0,15],
    PLACE: [25,-15,20,0,0,15],
    REST:  [0,10,-10,0,0,-20]
};

const PROFILE_STORE_KEY = "robotCreatorV3Profiles";
const SETTINGS_STORE_KEY = "robotCreatorV3Settings";

function msg(text) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function formatAngle(v) {
    const n = Number(v);
    return n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

function progress(s) {
    const p = ((+s.value - +s.min) / (+s.max - +s.min)) * 100;
    s.style.setProperty("--p", `${p}%`);
}

function current() {
    return sliders.map(s => +s.value);
}

function clonePose(p) {
    return p.map(Number);
}

function setRobotState(next) {
    robotState = next;
    const badge = $("stateBadge");
    if (badge) badge.textContent = next;
    updateDiagnostics();
}

function robotLog(message, level="info") {
    const c = $("robotConsole");
    const row = document.createElement("div");
    const stamp = new Date().toLocaleTimeString();

    if (c) {
        row.className =
            level === "error" ? "logError" :
            level === "warn" ? "logWarn" :
            "logInfo";
        row.textContent = `[${stamp}] ${message}`;
        c.appendChild(row);
        c.scrollTop = c.scrollHeight;
    }
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](message);
    updateDiagnostics();
}
window.robotLog = robotLog;

function pushUndo() {
    undoStack.push(current());
    if (undoStack.length > 30) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
}

function updateHistoryButtons() {
    const undoBtn = $("undoPose");
    const redoBtn = $("redoPose");
    if (undoBtn) undoBtn.disabled = !undoStack.length;
    if (redoBtn) redoBtn.disabled = !redoStack.length;
}

function shouldSendPhysical(force=false) {
    if (mode === "SIMULATION") return false;
    if (force) return true;
    return mode === "HARDWARE" || mode === "DIGITAL TWIN";
}

async function apply(i, value, send=true, force=false) {
    const cfg = window.getRobotCalibration?.()?.[i];
    const min = Number(cfg?.uiMin ?? -90);
    const max = Number(cfg?.uiMax ?? 90);
    const v = Math.max(min, Math.min(max, Number(value)));

    sliders[i].value = String(v);
    values[i].textContent = formatAngle(v);
    progress(sliders[i]);

    // Digital twin always updates locally.
    window.setRobotJoint?.(i, v);

    if (send && shouldSendPhysical(force) && (operatorMode === "MANUAL" || force)) {
        await window.sendServoCommand?.(i + 1, v);
    }

    updateTelemetry();
}

async function moveTo(target, physical=true, label="TARGET") {
    stopped = false;
    window.emergencyStopped = false;
    setRobotState("MOVING");

    const start = current();
    const maxDelta = Math.max(...start.map((v,i) => Math.abs(target[i] - v)));
    const steps = Math.max(1, Math.ceil(maxDelta / 3));
    const frameDelay = Math.max(18, Math.round(125 - speedPercent));

    for (let step=1; step<=steps; step++) {
        if (stopped || window.emergencyStopped) break;
        const t = step / steps;

        for (let i=0;i<6;i++) {
            const v = start[i] + (target[i] - start[i]) * t;
            await apply(i, v, physical, physical);
        }

        await new Promise(r => setTimeout(r, frameDelay));
    }

    setRobotState(stopped || window.emergencyStopped ? "PAUSED" : "IDLE");
    robotLog(`${label} reached${stopped ? " (interrupted)" : ""}.`, stopped ? "warn" : "info");
}

function connection(on) {
    dot.classList.toggle("on", on);
    connText.textContent = on ? "ARDUINO ONLINE" : "ARDUINO OFFLINE";
    connect.disabled = on;
    disconnect.disabled = !on;
    updateDiagnostics();
}

function emergencyStop() {
    stopped = true;
    playing = false;
    window.emergencyStopped = true;
    setRobotState("E-STOP");
    robotLog("EMERGENCY STOP ACTIVE", "error");
    msg("Emergency stop activated");
}

function resumeRobot() {
    stopped = false;
    playing = false;
    window.emergencyStopped = false;
    setRobotState("IDLE");
    robotLog("Emergency stop reset. Controls resumed.", "warn");
    msg("Robot controls resumed");
}

function saveSettings() {
    localStorage.setItem(SETTINGS_STORE_KEY, JSON.stringify({
        mode, operatorMode, speedPercent, selectedJoint, jogStep, loopCount, activeProfile
    }));
}

function loadSettings() {
    try {
        const data = JSON.parse(localStorage.getItem(SETTINGS_STORE_KEY) || "{}");
        mode = data.mode || mode;
        operatorMode = data.operatorMode || operatorMode;
        speedPercent = Number(data.speedPercent ?? speedPercent);
        selectedJoint = Number(data.selectedJoint ?? selectedJoint);
        jogStep = Number(data.jogStep ?? jogStep);
        loopCount = Number(data.loopCount ?? loopCount);
        activeProfile = data.activeProfile || activeProfile;
    } catch {}
}

function installStyles() {
    const style = document.createElement("style");
    style.textContent = `
    #stateBadge{
        position:fixed;
        left:16px;
        bottom:16px;
        z-index:45;
        padding:8px 12px;
        border:1px solid #333;
        border-radius:8px;
        background:#111;
        color:#fff;
        font:700 11px Segoe UI,Arial,sans-serif;
        letter-spacing:1px;
        box-shadow:0 4px 18px rgba(0,0,0,.22);
    }

    #robotToolsBar{
        position:fixed;
        right:16px;
        bottom:16px;
        z-index:50;
        display:flex;
        gap:8px;
        align-items:center;
    }

    .robotToolBtn{
        border:1px solid #333;
        border-radius:8px;
        background:#171717;
        color:#fff;
        padding:9px 13px;
        font:650 11px Segoe UI,Arial,sans-serif;
        cursor:pointer;
        box-shadow:0 4px 18px rgba(0,0,0,.22);
    }

    .robotToolBtn.accent{
        background:#df8c22;
        color:#111;
    }

    body.advanced-open #robotToolsBar,
    body.advanced-open #stateBadge{
        visibility:hidden;
    }

    #advancedOverlay{
        position:fixed;
        inset:0;
        z-index:100;
        display:none;
        background:rgba(0,0,0,.66);
        padding:16px;
        align-items:center;
        justify-content:center;
    }

    #advancedOverlay.show{
        display:flex;
    }

    #advancedPanel{
        width:min(1120px, calc(100vw - 32px));
        height:auto;
        max-height:calc(100vh - 32px);
        overflow:hidden;
        display:flex;
        flex-direction:column;
        background:#f2f2ed;
        border:2px solid #333;
        border-radius:18px;
        color:#171717;
        box-shadow:0 20px 70px rgba(0,0,0,.55);
    }

    .advHeader{
        flex:0 0 auto;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:16px;
        padding:14px 18px;
        background:#171717;
        color:#fff;
    }

    .advHeader h2{
        margin:0;
        min-width:0;
        font-size:17px;
        line-height:1.2;
        letter-spacing:1.8px;
    }

    #advClose{
        flex:0 0 auto;
        border:1px solid #777;
        border-radius:6px;
        background:#292929;
        color:#fff;
        padding:8px 14px;
        cursor:pointer;
    }

    .advTabs{
        flex:0 0 auto;
        display:flex;
        gap:6px;
        padding:10px 14px;
        overflow-x:auto;
        white-space:nowrap;
        background:#e5e5df;
        border-bottom:1px solid #aaa;
        scrollbar-width:thin;
    }

    .advTab{
        flex:0 0 auto;
        border:1px solid #777;
        border-radius:6px;
        background:#f7f7f2;
        padding:8px 11px;
        cursor:pointer;
        font-weight:700;
        font-size:12px;
    }

    .advTab.active{
        background:#171717;
        color:#fff;
    }

    .advPane{
        display:none;
        flex:1 1 auto;
        overflow:auto;
        padding:14px;
        min-height:0;
    }

    .advPane.active{
        display:block;
    }

    .advGrid{
        display:grid;
        grid-template-columns:repeat(3, minmax(0,1fr));
        gap:12px;
        align-items:start;
    }

    .advCard{
        min-width:0;
        border:1px solid #aaa;
        background:#fff;
        padding:12px;
        border-radius:10px;
        overflow:hidden;
    }

    .advCard h3{
        margin:0 0 9px;
        font-size:13px;
    }

    .advRow{
        display:grid;
        grid-template-columns:minmax(0,1fr) minmax(0,1fr);
        gap:8px;
        margin:7px 0;
        align-items:center;
    }

    .advRow > *{
        min-width:0;
    }

    .advRow input,
    .advRow select{
        width:100%;
        min-width:0;
        padding:7px;
        border:1px solid #999;
        background:#fff;
    }

    .advButton{
        max-width:100%;
        border:1px solid #333;
        border-radius:6px;
        background:#222;
        color:#fff;
        padding:9px 12px;
        cursor:pointer;
        margin:4px 4px 4px 0;
        white-space:normal;
        overflow-wrap:anywhere;
    }

    .advButton:disabled{
        opacity:.4;
        cursor:not-allowed;
    }

    .advButton.red{background:#9d2929}
    .advButton.orange{background:#df8c22;color:#111}
    .advButton.green{background:#287a50}

    .modeGrid{
        display:grid;
        grid-template-columns:repeat(3,minmax(0,1fr));
        gap:7px;
    }

    .modeChoice{
        min-width:0;
        min-height:58px;
        padding:10px 6px;
        border:2px solid #888;
        border-radius:6px;
        background:#eee;
        cursor:pointer;
        font-weight:700;
        font-size:11px;
        line-height:1.15;
        white-space:normal;
        overflow-wrap:anywhere;
    }

    .modeChoice.active{
        border-color:#111;
        background:#222;
        color:#fff;
    }

    .telemetryGrid{
        display:grid;
        grid-template-columns:repeat(3,minmax(0,1fr));
        gap:10px;
    }

    .telemetryCard{
        min-width:0;
        border:1px solid #bbb;
        background:#fff;
        padding:10px;
        border-radius:8px;
    }

    .telemetryCard strong{
        display:block;
        font-size:11px;
        margin-bottom:6px;
    }

    .telemetryValue{
        font:700 15px Consolas,monospace;
    }

    #robotConsole{
        background:#111;
        color:#ddd;
        min-height:220px;
        max-height:52vh;
        overflow:auto;
        padding:12px;
        font:12px/1.55 Consolas,monospace;
        border-radius:8px;
    }

    .logInfo{color:#b8e994}
    .logWarn{color:#ffd166}
    .logError{color:#ff7373}

    #sequenceList{
        display:flex;
        flex-direction:column;
        gap:8px;
    }

    .seqItem{
        min-width:0;
        border:1px solid #aaa;
        background:#fff;
        padding:9px;
        border-radius:8px;
        display:grid;
        grid-template-columns:minmax(90px,120px) minmax(0,1fr) auto;
        gap:8px;
        align-items:center;
    }

    .seqAngles{
        min-width:0;
        font:11px Consolas,monospace;
        white-space:nowrap;
        overflow:auto;
    }

    .precisionPad{
        display:grid;
        grid-template-columns:repeat(3,minmax(0,1fr));
        gap:8px;
        align-items:center;
    }

    .precisionPad button{
        width:100%;
        min-height:44px;
        margin:0;
    }

    .statusValue{
        min-width:0;
        font-family:Consolas,monospace;
        font-weight:700;
        overflow-wrap:anywhere;
    }

    .progressOuter{
        height:12px;
        background:#ddd;
        border:1px solid #888;
    }

    .progressInner{
        height:100%;
        width:0%;
        background:#222;
    }

    .warningBox{
        border:1px solid #b45;
        background:#fff0f0;
        padding:10px;
        border-radius:8px;
    }

    /* Medium laptops and tablets */
    @media (max-width:1050px){
        #advancedPanel{
            width:calc(100vw - 20px);
            max-height:calc(100vh - 20px);
        }

        #advancedOverlay{
            padding:10px;
        }

        .advGrid{
            grid-template-columns:repeat(2,minmax(0,1fr));
        }

        .telemetryGrid{
            grid-template-columns:repeat(2,minmax(0,1fr));
        }
    }

    /* Short laptop screens */
    @media (max-height:760px){
        #advancedOverlay{
            padding:8px;
        }

        #advancedPanel{
            max-height:calc(100vh - 16px);
        }

        .advHeader{
            padding:10px 14px;
        }

        .advHeader h2{
            font-size:15px;
        }

        .advTabs{
            padding:7px 10px;
        }

        .advTab{
            padding:6px 9px;
            font-size:11px;
        }

        .advPane{
            padding:10px;
        }

        .advCard{
            padding:10px;
        }

        .modeChoice{
            min-height:48px;
            font-size:10px;
        }
    }

    /* Phones / very narrow screens */
    @media (max-width:700px){
        #advancedOverlay{
            padding:0;
        }

        #advancedPanel{
            width:100vw;
            height:100vh;
            max-height:100vh;
            border:0;
            border-radius:0;
        }

        .advHeader h2{
            font-size:13px;
            letter-spacing:1px;
        }

        .advGrid,
        .telemetryGrid{
            grid-template-columns:1fr;
        }

        .modeGrid{
            grid-template-columns:1fr;
        }

        .modeChoice{
            min-height:42px;
        }

        .seqItem{
            grid-template-columns:1fr;
        }
    }

    /* Landscape phones */
    @media (orientation:landscape) and (max-height:550px){
        #advancedOverlay{
            padding:0;
        }

        #advancedPanel{
            width:100vw;
            height:100vh;
            max-height:100vh;
            border:0;
            border-radius:0;
        }

        .advHeader{
            padding:7px 10px;
        }

        .advHeader h2{
            font-size:12px;
        }

        #advClose{
            padding:5px 9px;
            font-size:10px;
        }

        .advTabs{
            padding:5px 7px;
            gap:4px;
        }

        .advTab{
            padding:5px 7px;
            font-size:9px;
        }

        .advPane{
            padding:7px;
        }

        .advGrid{
            grid-template-columns:repeat(3,minmax(0,1fr));
            gap:7px;
        }

        .advCard{
            padding:7px;
        }

        .advCard h3{
            font-size:10px;
        }

        .advRow{
            margin:4px 0;
            font-size:9px;
        }

        .advButton{
            padding:6px 7px;
            font-size:9px;
        }

        .modeChoice{
            min-height:38px;
            padding:5px 3px;
            font-size:8px;
        }
    }`;
    document.head.appendChild(style);
}
function createSliders() {
    JOINTS.forEach((name,i) => {
        const b = document.createElement("div");
        b.innerHTML = `
            <div class="jointName">${name}</div>
            <div class="shell">
                <div class="value">0.00</div>
                <div class="range">
                    <input type="range" min="-90" max="90" step="1" value="0">
                </div>
            </div>`;
        jointColumn.appendChild(b);

        const s = b.querySelector("input");
        const v = b.querySelector(".value");
        sliders.push(s);
        values.push(v);
        progress(s);

        s.addEventListener("pointerdown", pushUndo);
        s.addEventListener("input", e => apply(i, e.target.value, true, false));
        s.addEventListener("focus", () => {
            selectedJoint = i;
            updateSelectedJointUI();
        });
    });
}

function createAdvancedUI() {
    installStyles();

    const stateBadge = document.createElement("div");
    stateBadge.id = "stateBadge";
    stateBadge.textContent = "IDLE";
    document.body.appendChild(stateBadge);

    const tools = document.createElement("div");
    tools.id = "robotToolsBar";
    tools.innerHTML = `
        <button id="operatorModeBtn" class="robotToolBtn">MANUAL</button>
        <button id="advancedBtn" class="robotToolBtn accent">CONTROL CENTER</button>`;
    document.body.appendChild(tools);

    const overlay = document.createElement("div");
    overlay.id = "advancedOverlay";
    overlay.innerHTML = `
    <div id="advancedPanel">
        <div class="advHeader">
            <h2>ROBOT CREATOR V3 — CONTROL & DIGITAL TWIN</h2>
            <button id="advClose">CLOSE</button>
        </div>
        <div class="advTabs">
            <button class="advTab active" data-tab="control">CONTROL</button>
            <button class="advTab" data-tab="telemetry">TELEMETRY</button>
            <button class="advTab" data-tab="program">PROGRAM</button>
            <button class="advTab" data-tab="calibration">CALIBRATION</button>
            <button class="advTab" data-tab="safety">SAFETY</button>
            <button class="advTab" data-tab="diagnostics">DIAGNOSTICS</button>
            <button class="advTab" data-tab="console">CONSOLE</button>
            <button class="advTab" data-tab="system">SYSTEM</button>
        </div>

        <section class="advPane active" data-pane="control">
            <div class="advGrid">
                <div class="advCard">
                    <h3>Control Mode</h3>
                    <div class="modeGrid">
                        <button class="modeChoice" data-mode="SIMULATION">SIMULATION</button>
                        <button class="modeChoice" data-mode="HARDWARE">HARDWARE</button>
                        <button class="modeChoice" data-mode="DIGITAL TWIN">DIGITAL TWIN</button>
                    </div>
                    <p style="font-size:11px;margin-top:8px">Simulation updates only the 3D model. Hardware sends commands. Digital Twin does both.</p>
                </div>

                <div class="advCard">
                    <h3>Movement Speed</h3>
                    <div class="advRow"><span>Speed</span><span id="speedValue" class="statusValue">${speedPercent}%</span></div>
                    <input id="speedSlider" type="range" min="10" max="100" step="5" value="${speedPercent}">
                </div>

                <div class="advCard">
                    <h3>Precision Jog</h3>
                    <div class="advRow"><span>Selected Joint</span><select id="selectedJoint">${JOINTS.map((n,i)=>`<option value="${i}">${n}</option>`).join("")}</select></div>
                    <div class="advRow"><span>Step</span><select id="jogStep"><option>1</option><option selected>5</option><option>10</option></select></div>
                    <div class="precisionPad">
                        <button id="jogMinus" class="advButton">−</button>
                        <button id="jogZero" class="advButton">0°</button>
                        <button id="jogPlus" class="advButton">+</button>
                    </div>
                </div>

                <div class="advCard">
                    <h3>Presets</h3>
                    ${Object.keys(PRESETS).map(n=>`<button class="advButton presetBtn" data-preset="${n}">${n}</button>`).join("")}
                </div>

                <div class="advCard">
                    <h3>Pose History</h3>
                    <button id="undoPose" class="advButton">UNDO</button>
                    <button id="redoPose" class="advButton">REDO</button>
                </div>

                <div class="advCard">
                    <h3>Safety</h3>
                    <button id="advStop" class="advButton red">EMERGENCY STOP</button>
                    <button id="resumeRobot" class="advButton green">RESET / RESUME</button>
                </div>
            </div>
        </section>

        <section class="advPane" data-pane="telemetry">
            <div id="telemetryGrid" class="telemetryGrid"></div>
        </section>

        <section class="advPane" data-pane="program">
            <div class="advGrid">
                <div class="advCard">
                    <h3>Sequence Controls</h3>
                    <button id="seqSaveCurrent" class="advButton">ADD CURRENT POSE</button>
                    <button id="seqPlay" class="advButton green">PLAY</button>
                    <button id="seqPause" class="advButton">PAUSE</button>
                    <button id="seqClear" class="advButton red">CLEAR</button>
                    <div class="advRow"><span>Loop Count</span><input id="loopCount" type="number" min="1" max="50" value="${loopCount}"></div>
                    <div class="advRow"><span>Default Delay</span><span class="statusValue">${$("delay").value} ms</span></div>
                    <div class="progressOuter"><div id="sequenceProgress" class="progressInner"></div></div>
                    <div style="margin-top:6px;font-size:11px">Step <span id="sequenceStepText">0/0</span></div>
                </div>
                <div class="advCard">
                    <h3>Task Templates</h3>
                    <button id="loadPickPlace" class="advButton orange">LOAD PICK & PLACE</button>
                    <button id="loadDemoSweep" class="advButton">LOAD DEMO SWEEP</button>
                </div>
            </div>
            <div id="sequenceList" style="margin-top:12px"></div>
        </section>

        <section class="advPane" data-pane="calibration">
            <div class="warningBox">
                Wrist Roll is disabled by default until its physical command ID is identified. Use small test angles only.
            </div>
            <div id="calibrationGrid" class="advGrid" style="margin-top:10px"></div>
            <button id="saveCalibration" class="advButton green">SAVE CALIBRATION</button>
            <button id="resetCalibration" class="advButton">RESET DEFAULTS</button>
        </section>

        <section class="advPane" data-pane="safety">
            <div class="advGrid">
                <div class="advCard">
                    <h3>Workspace Limits</h3>
                    <p style="font-size:11px">Limits are applied before commands are sent to hardware.</p>
                    <div id="limitGrid"></div>
                </div>
                <div class="advCard">
                    <h3>Connection Loss Policy</h3>
                    <p style="font-size:12px">When serial disconnects, hardware commands are blocked and the digital twin remains available.</p>
                </div>
                <div class="advCard">
                    <h3>Emergency State</h3>
                    <div class="advRow"><span>Current State</span><span id="safetyState" class="statusValue">IDLE</span></div>
                </div>
            </div>
        </section>

        <section class="advPane" data-pane="diagnostics">
            <div class="advGrid">
                <div class="advCard">
                    <h3>Connection</h3>
                    <div class="advRow"><span>Status</span><span id="diagStatus" class="statusValue">OFFLINE</span></div>
                    <div class="advRow"><span>Transport</span><span id="diagTransport" class="statusValue">—</span></div>
                    <div class="advRow"><span>Baud</span><span id="diagBaud" class="statusValue">9600</span></div>
                    <div class="advRow"><span>Health</span><span id="diagHealth" class="statusValue">RED</span></div>
                </div>
                <div class="advCard">
                    <h3>Hardware</h3>
                    <div class="advRow"><span>Controller</span><span class="statusValue">Arduino Uno</span></div>
                    <div class="advRow"><span>Servo Driver</span><span class="statusValue">PCA9685</span></div>
                    <div class="advRow"><span>Joint Count</span><span class="statusValue">6</span></div>
                </div>
                <div class="advCard">
                    <h3>Runtime</h3>
                    <div class="advRow"><span>State</span><span id="diagState" class="statusValue">IDLE</span></div>
                    <div class="advRow"><span>Mode</span><span id="diagMode" class="statusValue">DIGITAL TWIN</span></div>
                    <div class="advRow"><span>Commands</span><span id="diagCommands" class="statusValue">0</span></div>
                    <div class="advRow"><span>Failures</span><span id="diagFailures" class="statusValue">0</span></div>
                    <div class="advRow"><span>Last Command</span><span id="diagLast" class="statusValue">—</span></div>
                </div>
            </div>
        </section>

        <section class="advPane" data-pane="console">
            <div id="robotConsole"></div>
            <button id="clearConsole" class="advButton">CLEAR CONSOLE</button>
        </section>

        <section class="advPane" data-pane="system">
            <div class="advGrid">
                <div class="advCard">
                    <h3>Project</h3>
                    <div class="advRow"><span>Software</span><span class="statusValue">Robot Creator V3</span></div>
                    <div class="advRow"><span>Build</span><span class="statusValue">2026.08.13</span></div>
                    <div class="advRow"><span>Frontend</span><span class="statusValue">HTML / CSS / JS</span></div>
                    <div class="advRow"><span>3D Engine</span><span class="statusValue">Three.js</span></div>
                    <div class="advRow"><span>Deployment</span><span class="statusValue">GitHub Pages</span></div>
                </div>
                <div class="advCard">
                    <h3>Configuration</h3>
                    <button id="exportConfig" class="advButton">EXPORT PROJECT CONFIG</button>
                    <button id="importConfigBtn" class="advButton">IMPORT PROJECT CONFIG</button>
                    <input id="configFile" type="file" accept=".json,application/json" style="display:none">
                </div>
                <div class="advCard">
                    <h3>Profiles</h3>
                    <div class="advRow"><span>Active</span><select id="profileSelect"><option>LAB</option><option>DEMO</option><option>MOBILE</option></select></div>
                    <button id="saveProfile" class="advButton">SAVE PROFILE</button>
                    <button id="loadProfile" class="advButton">LOAD PROFILE</button>
                </div>
                <div class="advCard">
                    <h3>Keyboard Shortcuts</h3>
                    <p style="font-size:12px;line-height:1.6">
                    1–6: select joint<br>
                    ← / →: jog selected joint<br>
                    0: center selected joint<br>
                    Space: emergency stop<br>
                    H: home<br>
                    Ctrl+Z / Ctrl+Y: undo / redo
                    </p>
                </div>
            </div>
        </section>
    </div>`;
    document.body.appendChild(overlay);

    $("advancedBtn").onclick = () => {
        overlay.classList.add("show");
        document.body.classList.add("advanced-open");
    };
    $("advClose").onclick = () => {
        overlay.classList.remove("show");
        document.body.classList.remove("advanced-open");
    };
    overlay.addEventListener("click", e => {
        if (e.target === overlay) {
            overlay.classList.remove("show");
            document.body.classList.remove("advanced-open");
        }
    });

    document.querySelectorAll(".advTab").forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll(".advTab").forEach(x=>x.classList.remove("active"));
            document.querySelectorAll(".advPane").forEach(x=>x.classList.remove("active"));
            btn.classList.add("active");
            document.querySelector(`[data-pane="${btn.dataset.tab}"]`)?.classList.add("active");
        };
    });

    document.querySelectorAll(".modeChoice").forEach(btn => {
        btn.onclick = () => setControlMode(btn.dataset.mode);
    });

    $("operatorModeBtn").onclick = () => {
        operatorMode = operatorMode === "MANUAL" ? "AUTO" : "MANUAL";
        $("operatorModeBtn").textContent = operatorMode;
        $("operatorModeBtn").classList.toggle("accent", operatorMode === "AUTO");
        saveSettings();
        robotLog(`Operator mode changed to ${operatorMode}.`);
    };

    $("speedSlider").oninput = e => {
        speedPercent = Number(e.target.value);
        $("speedValue").textContent = `${speedPercent}%`;
        saveSettings();
    };

    $("selectedJoint").onchange = e => {
        selectedJoint = Number(e.target.value);
        saveSettings();
        updateSelectedJointUI();
    };

    $("jogStep").onchange = e => {
        jogStep = Number(e.target.value);
        saveSettings();
    };

    $("jogMinus").onclick = () => jogSelected(-jogStep);
    $("jogPlus").onclick = () => jogSelected(jogStep);
    $("jogZero").onclick = () => jogToZero();

    document.querySelectorAll(".presetBtn").forEach(btn => {
        btn.onclick = async () => {
            pushUndo();
            await moveTo(PRESETS[btn.dataset.preset], true, btn.dataset.preset);
        };
    });

    $("undoPose").onclick = undoPose;
    $("redoPose").onclick = redoPose;
    $("advStop").onclick = emergencyStop;
    $("resumeRobot").onclick = resumeRobot;

    $("seqSaveCurrent").onclick = saveCurrentPosition;
    $("seqPlay").onclick = playSequence;
    $("seqPause").onclick = emergencyStop;
    $("seqClear").onclick = () => {
        saved = [];
        updateSaved();
        robotLog("Sequence cleared.", "warn");
    };
    $("loopCount").onchange = e => {
        loopCount = Math.max(1, Math.min(50, Number(e.target.value) || 1));
        saveSettings();
    };

    $("loadPickPlace").onclick = () => {
        saved = [
            namedStep("HOME", PRESETS.HOME, 500, 45),
            namedStep("READY", PRESETS.READY, 500, 50),
            namedStep("APPROACH", PRESETS.PICK, 600, 40),
            namedStep("LIFT", PRESETS.READY, 500, 45),
            namedStep("PLACE", PRESETS.PLACE, 600, 40),
            namedStep("HOME", PRESETS.HOME, 500, 50)
        ];
        updateSaved();
        robotLog("Pick-and-place template loaded.");
    };

    $("loadDemoSweep").onclick = () => {
        saved = [
            namedStep("CENTER", [0,0,0,0,0,0], 350, 55),
            namedStep("LEFT", [-25,-10,20,0,-20,-10], 350, 50),
            namedStep("RIGHT", [25,-10,20,0,20,-10], 350, 50),
            namedStep("CENTER", [0,0,0,0,0,0], 350, 55)
        ];
        updateSaved();
        robotLog("Demo sweep template loaded.");
    };

    $("saveCalibration").onclick = saveCalibrationFromUI;
    $("resetCalibration").onclick = () => {
        window.resetRobotCalibration?.();
        buildCalibrationUI();
        buildLimitUI();
    };

    $("clearConsole").onclick = () => $("robotConsole").innerHTML = "";

    $("exportConfig").onclick = exportProjectConfig;
    $("importConfigBtn").onclick = () => $("configFile").click();
    $("configFile").onchange = importProjectConfig;

    $("saveProfile").onclick = saveProfile;
    $("loadProfile").onclick = loadProfile;

    buildCalibrationUI();
    buildLimitUI();
    updateTelemetry();
    updateSaved();
    updateDiagnostics();
    setControlMode(mode);
    updateSelectedJointUI();
}

function setControlMode(next) {
    mode = next;
    document.querySelectorAll(".modeChoice").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    saveSettings();
    robotLog(`Control mode: ${mode}.`);
    updateDiagnostics();
}

function updateSelectedJointUI() {
    if ($("selectedJoint")) $("selectedJoint").value = String(selectedJoint);
}

async function jogSelected(delta) {
    pushUndo();
    const target = Number(sliders[selectedJoint].value) + delta;
    await apply(selectedJoint, target, true, true);
}

async function jogToZero() {
    pushUndo();
    await apply(selectedJoint, 0, true, true);
}

async function undoPose() {
    if (!undoStack.length) return;
    redoStack.push(current());
    const pose = undoStack.pop();
    await moveTo(pose, true, "UNDO");
    updateHistoryButtons();
}

async function redoPose() {
    if (!redoStack.length) return;
    undoStack.push(current());
    const pose = redoStack.pop();
    await moveTo(pose, true, "REDO");
    updateHistoryButtons();
}

function namedStep(name, angles, delay=500, speed=55) {
    return {name, angles:clonePose(angles), delay, speed};
}

function normalizeSavedEntry(entry, index) {
    if (Array.isArray(entry)) {
        return namedStep(`P${index+1}`, entry, Number($("delay").value)||1000, speedPercent);
    }
    return {
        name: String(entry.name || `P${index+1}`),
        angles: clonePose(entry.angles || [0,0,0,0,0,0]),
        delay: Math.max(0, Number(entry.delay ?? 500)),
        speed: Math.max(10, Math.min(100, Number(entry.speed ?? speedPercent)))
    };
}

function saveCurrentPosition() {
    saved.push(namedStep(
        `P${saved.length+1}`,
        current(),
        Number($("delay").value) || 1000,
        speedPercent
    ));
    updateSaved();
    robotLog(`Position ${saved.length} saved.`);
    msg(`Position ${saved.length} saved`);
}

async function playSequence() {
    if (playing) return msg("Movement is already playing");
    if (!saved.length) return msg("Save at least one position first");

    playing = true;
    stopped = false;
    window.emergencyStopped = false;
    operatorMode = "AUTO";
    $("operatorModeBtn").textContent = "AUTO";
    $("operatorModeBtn").classList.add("accent");
    setRobotState("MOVING");

    robotLog(`Sequence started: ${saved.length} steps × ${loopCount} loop(s).`);

    for (let loop=0; loop<loopCount && !stopped; loop++) {
        for (let i=0; i<saved.length && !stopped; i++) {
            sequenceStep = i + 1;
            const step = normalizeSavedEntry(saved[i], i);
            const oldSpeed = speedPercent;
            speedPercent = step.speed;
            updateSequenceProgress();

            await moveTo(step.angles, true, step.name);
            if (stopped) break;
            await new Promise(r => setTimeout(r, step.delay));
            speedPercent = oldSpeed;
        }
    }

    playing = false;
    operatorMode = "MANUAL";
    $("operatorModeBtn").textContent = "MANUAL";
    $("operatorModeBtn").classList.remove("accent");
    sequenceStep = 0;
    updateSequenceProgress();
    setRobotState(stopped ? "PAUSED" : "IDLE");
    robotLog(stopped ? "Sequence stopped." : "Sequence complete.", stopped ? "warn" : "info");
}

function updateSequenceProgress() {
    const total = saved.length;
    if ($("sequenceStepText")) $("sequenceStepText").textContent = `${sequenceStep}/${total}`;
    if ($("sequenceProgress")) {
        $("sequenceProgress").style.width = total ? `${(sequenceStep/total)*100}%` : "0%";
    }
}

function updateSaved() {
    count.textContent = String(saved.length);
    updateSequenceEditor();
    updateSequenceProgress();
    updateDiagnostics();
}

function updateSequenceEditor() {
    const list = $("sequenceList");
    if (!list) return;

    if (!saved.length) {
        list.innerHTML = `<div class="advCard">No programmed steps yet.</div>`;
        return;
    }

    list.innerHTML = saved.map((entry,index) => {
        const s = normalizeSavedEntry(entry,index);
        return `
        <div class="seqItem" data-index="${index}">
            <div>
                <input class="seqName" value="${s.name}" style="width:95px;padding:6px">
                <div style="font-size:10px;margin-top:4px">D:${s.delay}ms S:${s.speed}%</div>
            </div>
            <div class="seqAngles">${s.angles.map((v,i)=>`${JOINTS[i]}:${Math.round(v)}°`).join(" | ")}</div>
            <div>
                <button class="advButton seqGo">GO</button>
                <button class="advButton seqEdit">EDIT</button>
                <button class="advButton seqUp">↑</button>
                <button class="advButton seqDown">↓</button>
                <button class="advButton red seqDelete">×</button>
            </div>
        </div>`;
    }).join("");

    list.querySelectorAll(".seqItem").forEach(item => {
        const i = Number(item.dataset.index);
        item.querySelector(".seqGo").onclick = () => moveTo(normalizeSavedEntry(saved[i],i).angles, true, `P${i+1}`);
        item.querySelector(".seqDelete").onclick = () => { saved.splice(i,1); updateSaved(); };
        item.querySelector(".seqUp").onclick = () => {
            if (i<=0) return;
            [saved[i-1],saved[i]] = [saved[i],saved[i-1]];
            updateSaved();
        };
        item.querySelector(".seqDown").onclick = () => {
            if (i>=saved.length-1) return;
            [saved[i+1],saved[i]] = [saved[i],saved[i+1]];
            updateSaved();
        };
        item.querySelector(".seqEdit").onclick = () => {
            const s = normalizeSavedEntry(saved[i],i);
            const delay = prompt("Step delay (ms):", s.delay);
            const speed = prompt("Step speed (%):", s.speed);
            const name = item.querySelector(".seqName").value.trim() || s.name;
            saved[i] = {
                ...s,
                name,
                delay: Math.max(0, Number(delay ?? s.delay)),
                speed: Math.max(10, Math.min(100, Number(speed ?? s.speed)))
            };
            updateSaved();
        };
        item.querySelector(".seqName").onchange = e => {
            const s = normalizeSavedEntry(saved[i],i);
            saved[i] = {...s, name:e.target.value.trim() || s.name};
        };
    });
}

function buildCalibrationUI() {
    const grid = $("calibrationGrid");
    if (!grid) return;

    const cal = window.getRobotCalibration?.() || [];

    grid.innerHTML = cal.map((cfg,i) => `
    <div class="advCard calibrationCard" data-joint="${i}">
        <h3>${JOINTS[i]}</h3>
        <div class="advRow"><span>Enabled</span><input class="calEnabled" type="checkbox" ${cfg.enabled ? "checked" : ""}></div>
        <div class="advRow"><span>Arduino ID</span>
            <select class="calCommand">
                <option value="" ${cfg.commandId==null ? "selected":""}>UNASSIGNED</option>
                ${[1,2,3,4,5,6].map(id=>`<option value="${id}" ${Number(cfg.commandId)===id?"selected":""}>${id}</option>`).join("")}
            </select>
        </div>
        <div class="advRow"><span>UI Min</span><input class="calUiMin" type="number" min="-90" max="0" value="${cfg.uiMin ?? -90}"></div>
        <div class="advRow"><span>UI Max</span><input class="calUiMax" type="number" min="0" max="90" value="${cfg.uiMax ?? 90}"></div>
        <div class="advRow"><span>Servo Min</span><input class="calServoMin" type="number" min="0" max="180" value="${cfg.servoMin ?? 0}"></div>
        <div class="advRow"><span>Center</span><input class="calCenter" type="number" min="0" max="180" value="${cfg.center ?? 90}"></div>
        <div class="advRow"><span>Servo Max</span><input class="calServoMax" type="number" min="0" max="180" value="${cfg.servoMax ?? 180}"></div>
        <div class="advRow"><span>Reverse</span><input class="calReverse" type="checkbox" ${cfg.reverse ? "checked":""}></div>
        <button class="advButton calTestNeg">TEST −10°</button>
        <button class="advButton calTestZero">TEST 0°</button>
        <button class="advButton calTestPos">TEST +10°</button>
    </div>`).join("");

    grid.querySelectorAll(".calibrationCard").forEach(card => {
        const i = Number(card.dataset.joint);
        card.querySelector(".calTestNeg").onclick = () => apply(i,-10,true,true);
        card.querySelector(".calTestZero").onclick = () => apply(i,0,true,true);
        card.querySelector(".calTestPos").onclick = () => apply(i,10,true,true);
    });
}

function saveCalibrationFromUI() {
    const next = [...document.querySelectorAll(".calibrationCard")].map(card => {
        const command = card.querySelector(".calCommand").value;
        return {
            enabled: card.querySelector(".calEnabled").checked,
            commandId: command === "" ? null : Number(command),
            uiMin: Number(card.querySelector(".calUiMin").value),
            uiMax: Number(card.querySelector(".calUiMax").value),
            servoMin: Number(card.querySelector(".calServoMin").value),
            center: Number(card.querySelector(".calCenter").value),
            servoMax: Number(card.querySelector(".calServoMax").value),
            reverse: card.querySelector(".calReverse").checked
        };
    });
    window.saveRobotCalibration?.(next);
    buildLimitUI();
    msg("Calibration saved");
}

function buildLimitUI() {
    const root = $("limitGrid");
    if (!root) return;
    const cal = window.getRobotCalibration?.() || [];
    root.innerHTML = cal.map((cfg,i)=>`
        <div class="advRow">
            <span>${JOINTS[i]}</span>
            <span class="statusValue">${cfg.uiMin ?? -90}° to ${cfg.uiMax ?? 90}°</span>
        </div>`).join("");
}

function updateTelemetry() {
    const grid = $("telemetryGrid");
    if (!grid) return;

    const cal = window.getRobotCalibration?.() || [];
    grid.innerHTML = JOINTS.map((name,i)=>{
        const cfg = cal[i] || {};
        const app = Number(sliders[i]?.value || 0);
        const servo = Math.round(app + 90);
        return `
        <div class="telemetryCard">
            <strong>${name}</strong>
            <div class="telemetryValue">${formatAngle(app)}°</div>
            <div style="font-size:10px;margin-top:6px">Command ID: ${cfg.commandId ?? "—"}</div>
            <div style="font-size:10px">Servo target≈ ${servo}°</div>
            <div style="font-size:10px">Direction: ${cfg.reverse ? "REVERSED":"NORMAL"}</div>
            <div style="font-size:10px">Limit: ${cfg.uiMin ?? -90}° / ${cfg.uiMax ?? 90}°</div>
            <div style="font-size:10px">Status: ${cfg.enabled && cfg.commandId != null ? "ACTIVE":"DISABLED"}</div>
        </div>`;
    }).join("");
}

function updateDiagnostics() {
    if (!$("diagStatus")) return;

    $("diagStatus").textContent = window.serialConnected ? "ONLINE" : "OFFLINE";
    $("diagTransport").textContent = window.robotTransport || "—";
    $("diagBaud").textContent = String(window.robotBaudRate || 9600);
    $("diagHealth").textContent = window.serialConnected ? "GREEN" : mode === "SIMULATION" ? "YELLOW" : "RED";
    $("diagState").textContent = robotState;
    $("diagMode").textContent = mode;
    $("diagCommands").textContent = String(window.robotCommandCount || 0);
    $("diagFailures").textContent = String(window.robotFailedCommands || 0);
    $("diagLast").textContent = window.robotLastCommand
        ? `${window.robotLastCommand.joint} ${window.robotLastCommand.appAngle}°`
        : "—";
    if ($("safetyState")) $("safetyState").textContent = robotState;
}

function exportProjectConfig() {
    const payload = {
        application:"Robot Creator V3",
        exportedAt:new Date().toISOString(),
        mode, operatorMode, speedPercent, loopCount,
        calibration: window.getRobotCalibration?.() || [],
        sequence: saved,
        currentPose: current()
    };
    const blob = new Blob([JSON.stringify(payload,null,2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "robot-creator-project.json";
    a.click();
    URL.revokeObjectURL(url);
    robotLog("Project configuration exported.");
}

function importProjectConfig(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
        try {
            const d = JSON.parse(String(r.result));
            if (Array.isArray(d.calibration)) window.saveRobotCalibration?.(d.calibration);
            if (Array.isArray(d.sequence)) saved = d.sequence.map(normalizeSavedEntry);
            if (Number.isFinite(Number(d.speedPercent))) speedPercent = Number(d.speedPercent);
            if (Number.isFinite(Number(d.loopCount))) loopCount = Number(d.loopCount);
            if (d.mode) mode = d.mode;
            if (Array.isArray(d.currentPose) && d.currentPose.length === 6) {
                await moveTo(d.currentPose, false, "IMPORTED POSE");
            }
            updateSaved();
            buildCalibrationUI();
            buildLimitUI();
            setControlMode(mode);
            robotLog("Project configuration imported.");
            msg("Project configuration imported");
        } catch {
            msg("Invalid project configuration");
        }
    };
    r.readAsText(f);
    e.target.value = "";
}

function getProfiles() {
    try { return JSON.parse(localStorage.getItem(PROFILE_STORE_KEY) || "{}"); }
    catch { return {}; }
}

function saveProfile() {
    const name = $("profileSelect").value;
    const profiles = getProfiles();
    profiles[name] = {
        calibration: window.getRobotCalibration?.() || [],
        speedPercent,
        mode,
        currentPose: current(),
        sequence: saved
    };
    localStorage.setItem(PROFILE_STORE_KEY, JSON.stringify(profiles));
    activeProfile = name;
    saveSettings();
    robotLog(`Profile ${name} saved.`);
    msg(`Profile ${name} saved`);
}

async function loadProfile() {
    const name = $("profileSelect").value;
    const profiles = getProfiles();
    const p = profiles[name];
    if (!p) return msg(`Profile ${name} is empty`);

    if (Array.isArray(p.calibration)) window.saveRobotCalibration?.(p.calibration);
    if (Array.isArray(p.sequence)) saved = p.sequence;
    if (Number.isFinite(Number(p.speedPercent))) speedPercent = Number(p.speedPercent);
    if (p.mode) setControlMode(p.mode);
    if (Array.isArray(p.currentPose) && p.currentPose.length === 6) await moveTo(p.currentPose,false,`PROFILE ${name}`);

    activeProfile = name;
    updateSaved();
    buildCalibrationUI();
    buildLimitUI();
    saveSettings();
    robotLog(`Profile ${name} loaded.`);
    msg(`Profile ${name} loaded`);
}

connect.addEventListener("click", async () => {
    const ok = await window.connectArduino?.();
    connection(!!ok);
    msg(ok ? "Arduino connected at 9600 baud" : "Arduino connection cancelled");
});

disconnect.addEventListener("click", async () => {
    await window.disconnectArduino?.();
    connection(false);
    setRobotState("IDLE");
    msg("Arduino disconnected");
});

$("save").addEventListener("click", saveCurrentPosition);
$("play").addEventListener("click", playSequence);
$("stop").addEventListener("click", emergencyStop);

$("home").addEventListener("click", async () => {
    pushUndo();
    await moveTo(PRESETS.HOME, true, "HOME");
    msg("Robot returned home");
});

$("reset").addEventListener("click", async () => {
    saved = [];
    updateSaved();
    pushUndo();
    await moveTo(PRESETS.HOME, true, "RESET");
    msg("Saved positions reset");
});

$("export").addEventListener("click", () => {
    if (!saved.length) return msg("There are no saved positions");
    const blob = new Blob([JSON.stringify({
        application:"Robot Creator V3",
        exportedAt:new Date().toISOString(),
        positions:saved
    },null,2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "robot-sequence.json";
    a.click();
    URL.revokeObjectURL(url);
    robotLog("Sequence exported.");
});

$("import").addEventListener("click", ()=>importFile.click());
importFile.addEventListener("change", e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
        try {
            const d = JSON.parse(String(r.result));
            const p = Array.isArray(d) ? d : (d.positions || d.sequence);
            if (!Array.isArray(p)) throw new Error();
            saved = p.map(normalizeSavedEntry);
            updateSaved();
            robotLog(`${saved.length} sequence steps imported.`);
            msg(`${saved.length} positions imported`);
        } catch {
            msg("Invalid positions file");
        }
    };
    r.readAsText(f);
    e.target.value = "";
});

$("exit").addEventListener("click", () => {
    if (confirm("Exit Robot Creator?")) window.close();
});

document.addEventListener("keydown", async e => {
    if (["INPUT","SELECT","TEXTAREA"].includes(document.activeElement?.tagName)) return;

    if (e.key >= "1" && e.key <= "6") {
        selectedJoint = Number(e.key) - 1;
        updateSelectedJointUI();
        msg(`Selected ${JOINTS[selectedJoint]}`);
    }

    if (e.key === "ArrowLeft") {
        e.preventDefault();
        await jogSelected(-jogStep);
    }
    if (e.key === "ArrowRight") {
        e.preventDefault();
        await jogSelected(jogStep);
    }
    if (e.key === "0") {
        await jogToZero();
    }
    if (e.code === "Space") {
        e.preventDefault();
        emergencyStop();
    }
    if (e.key.toLowerCase() === "h") {
        pushUndo();
        await moveTo(PRESETS.HOME,true,"HOME");
    }
    if (e.ctrlKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        await undoPose();
    }
    if (e.ctrlKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        await redoPose();
    }
});

window.addEventListener("robot-command-sent", () => {
    updateTelemetry();
    updateDiagnostics();
});
window.addEventListener("robot-connection-changed", updateDiagnostics);
window.addEventListener("robot-calibration-changed", () => {
    buildCalibrationUI();
    buildLimitUI();
    updateTelemetry();
});

loadSettings();
createSliders();
createAdvancedUI();
connection(false);
setRobotState("IDLE");
robotLog("Robot Creator V3 initialized.");
robotLog("Wrist Roll remains disabled until its physical command ID is calibrated.", "warn");
})();