(() => {
    "use strict";

    let port = null;
    let writer = null;
    let reader = null;
    let readLoopDone = Promise.resolve();
    let writeQueue = Promise.resolve();
    const encoder = new TextEncoder();

    // Set to true by the app once the arm has been synced after connecting.
    // After that, an "ARM READY" message means the Arduino restarted by itself.
    window.robotSyncReady = false;
    window.robotArduinoRestarts = 0;

    function handleArduinoLine(line) {
        const garbled = /[^\x20-\x7E]/.test(line);
        if (garbled) {
            log(`Arduino sent unreadable data (${line.length} chars) - the USB speed may not match. Driver: ${window.robotTransport}`, "warn");
        } else {
            log(`Arduino: ${line}`);
        }
        if (/ARM READY/i.test(line) || /^READY$/i.test(line)) {
            if (window.robotSyncReady) {
                window.robotArduinoRestarts++;
                log(`Arduino restarted by itself (#${window.robotArduinoRestarts}) - usually a power dip from the servos. Restoring slider positions.`, "warn");
                window.dispatchEvent(new CustomEvent("robot-arduino-restarted"));
            }
        }
    }

    // Reads messages from the Arduino in the background.
    async function readLoop(p) {
        if (!p || !p.readable) return;
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            reader = p.readable.getReader();
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buffer.search(/[\r\n]/)) >= 0) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (line) handleArduinoLine(line);
                }
                if (buffer.length > 200) buffer = "";
            }
        } catch (error) {
            console.warn("Serial read stopped:", error);
        } finally {
            try { reader?.releaseLock(); } catch (e) {}
            reader = null;
        }
    }

    window.serialConnected = false;
    window.robotTransport = "—";
    window.robotBaudRate = 9600;
    window.robotLastCommand = null;
    window.robotCommandCount = 0;
    window.robotFailedCommands = 0;

    const JOINT_NAMES = [
        "Base",
        "Shoulder",
        "Elbow",
        "Gripper"
    ];

    // Command IDs match robot_arm_pca9685.ino: 1 Base, 2 Shoulder, 3 Elbow, 4 Gripper.
    const DEFAULT_CALIBRATION = [
        { commandId: 1, uiMin: 0, uiMax: 180, servoMin: 0, center: 90, servoMax: 180, reverse: false, enabled: true },
        { commandId: 2, uiMin: 0, uiMax: 180, servoMin: 0, center: 90, servoMax: 180, reverse: false, enabled: true },
        { commandId: 3, uiMin: 0, uiMax: 180, servoMin: 0, center: 90, servoMax: 180, reverse: false, enabled: true },
        { commandId: 4, uiMin: 0, uiMax: 180, servoMin: 40, center: 90, servoMax: 140, reverse: false, enabled: true }
    ];

    // Old 6-joint calibration -> keep Base, Shoulder, Elbow, Gripper.
    function toFourJoints(list) {
        if (Array.isArray(list) && list.length === 6) {
            return [list[0], list[1], list[2], list[5]];
        }
        return list;
    }

    function defaults() {
        return DEFAULT_CALIBRATION.map(x => ({...x}));
    }

    function log(message, level="info") {
        const fn = level === "error" ? "error" : level === "warn" ? "warn" : "log";
        console[fn](message);
        window.robotLog?.(message, level);
    }

    function loadCalibration() {
        try {
            const raw = localStorage.getItem("robotCreatorV3Calibration4DOF_v3");
            const parsed = toFourJoints(raw ? JSON.parse(raw) : null);
            if (Array.isArray(parsed) && parsed.length === 4) {
                return parsed.map((x,i) => ({...defaults()[i], ...x}));
            }
        } catch (e) {
            console.warn(e);
        }
        return defaults();
    }

    let calibration = loadCalibration();

    function getRobotCalibration() {
        return calibration.map(x => ({...x}));
    }

    function saveRobotCalibration(next) {
        calibration = defaults().map((d,i) => ({...d, ...(toFourJoints(next)[i] || {})}));
        localStorage.setItem("robotCreatorV3Calibration4DOF_v3", JSON.stringify(calibration));
        window.dispatchEvent(new CustomEvent("robot-calibration-changed"));
        log("Calibration profile saved.");
    }

    function resetRobotCalibration() {
        calibration = defaults();
        localStorage.setItem("robotCreatorV3Calibration4DOF_v3", JSON.stringify(calibration));
        window.dispatchEvent(new CustomEvent("robot-calibration-changed"));
        log("Calibration reset to defaults.", "warn");
    }



    // ================================================================
    // CH340 / CH341 USB-serial driver over WebUSB (Arduino clones on
    // Android phones). Behaves like a Web Serial port: open(),
    // readable, writable, close().
    // ================================================================
    const CH34X_VENDOR = 0x1A86;
    const CH34X_BAUD = {            // [reg 0x1312 value, reg 0x0F2C value]
        9600:   [0xB202, 0x0013],
        19200:  [0xD902, 0x000D],
        38400:  [0x6403, 0x000A],
        57600:  [0x9803, 0x0010],
        115200: [0xCC03, 0x0008]
    };

    // Opens the device and claims an interface. If Android reports the
    // interface is busy (left over from an earlier attempt), it resets the
    // device and tries again.
    async function openAndClaim(d, ifaceNums) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                if (!d.opened) await d.open();
                if (d.configuration === null) await d.selectConfiguration(1);
                for (const n of ifaceNums()) {
                    const iface = d.configuration.interfaces.find(i => i.interfaceNumber === n);
                    if (!iface || !iface.claimed) await d.claimInterface(n);
                }
                return;
            } catch (e) {
                log(`USB claim attempt ${attempt} failed: ${e.message}`, "warn");
                if (attempt === 3) throw e;
                try { await d.reset(); } catch (_) {}
                try { await d.close(); } catch (_) {}
                await new Promise(r => setTimeout(r, 400 * attempt));
            }
        }
    }

    function makeStreams(self, d) {
        self.readable = new ReadableStream({
            async pull(controller) {
                while (!self.closed) {
                    let r;
                    try {
                        r = await d.transferIn(self.inEp, 64);
                    } catch (e) {
                        if (!self.closed) controller.error(e);
                        return;
                    }
                    if (r.data && r.data.byteLength) {
                        controller.enqueue(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
                        return;
                    }
                }
                controller.close();
            },
            cancel() { self.closed = true; }
        });
        self.writable = new WritableStream({
            async write(chunk) {
                const r = await d.transferOut(self.outEp, chunk);
                if (r.status !== "ok") throw new Error("USB write failed");
            }
        });
    }

    // Standard USB-serial (CDC-ACM): genuine Arduinos, 16U2 clones,
    // CH9102/CH343 and similar chips.
    class CdcAcmPort {
        constructor(device) {
            this.device = device;
            this.readable = null;
            this.writable = null;
            this.closed = false;
        }

        findInterfaces() {
            const ifaces = this.device.configuration.interfaces;
            const alt = i => i.alternate || i.alternates[0];
            const data = ifaces.find(i => alt(i).interfaceClass === 10 &&
                alt(i).endpoints.some(e => e.type === "bulk"));
            const ctrl = ifaces.find(i => alt(i).interfaceClass === 2);
            if (!data) throw new Error("No USB serial data interface found");
            this.dataIface = data.interfaceNumber;
            this.ctrlIface = ctrl ? ctrl.interfaceNumber : null;
            const eps = alt(data).endpoints;
            this.inEp  = eps.find(e => e.direction === "in"  && e.type === "bulk").endpointNumber;
            this.outEp = eps.find(e => e.direction === "out" && e.type === "bulk").endpointNumber;
        }

        async open(options = {}) {
            const d = this.device;
            const baud = options.baudRate || 9600;
            await openAndClaim(d, () => {
                this.findInterfaces();
                return this.ctrlIface === null ? [this.dataIface] : [this.ctrlIface, this.dataIface];
            });

            const ifaceIndex = this.ctrlIface ?? this.dataIface;
            const coding = new Uint8Array([baud & 0xFF, (baud >> 8) & 0xFF, (baud >> 16) & 0xFF, (baud >> 24) & 0xFF, 0, 0, 8]);
            try {
                await d.controlTransferOut({ requestType: "class", recipient: "interface", request: 0x20, value: 0, index: ifaceIndex }, coding); // line coding
                await d.controlTransferOut({ requestType: "class", recipient: "interface", request: 0x22, value: 0x03, index: ifaceIndex });        // DTR + RTS
            } catch (e) {
                log(`USB line setup warning: ${e.message}`, "warn");
            }
            makeStreams(this, d);
        }

        async close() {
            this.closed = true;
            try { await this.device.releaseInterface(this.dataIface); } catch (e) {}
            if (this.ctrlIface !== null) { try { await this.device.releaseInterface(this.ctrlIface); } catch (e) {} }
            try { await this.device.close(); } catch (e) {}
        }
    }

    class CH34xPort {
        constructor(device) {
            this.device = device;
            this.readable = null;
            this.writable = null;
            this.closed = false;
        }

        async ctrlOut(request, value, index) {
            const r = await this.device.controlTransferOut({
                requestType: "vendor", recipient: "device",
                request, value: value & 0xFFFF, index: index & 0xFFFF
            });
            if (r.status !== "ok") throw new Error(`CH340 control 0x${request.toString(16)} failed`);
        }

        async ctrlIn(request, value, index, length) {
            return this.device.controlTransferIn({
                requestType: "vendor", recipient: "device",
                request, value, index
            }, length);
        }

        async setBaud(baud) {
            const v = CH34X_BAUD[baud];
            if (!v) throw new Error(`CH340: unsupported baud ${baud}`);
            // Bit 7 = send received bytes immediately (as the Linux driver does)
            await this.ctrlOut(0x9A, 0x1312, this.version > 0x27 ? (v[0] | 0x80) : v[0]);
            await this.ctrlOut(0x9A, 0x0F2C, v[1]);
        }

        async open(options = {}) {
            const d = this.device;
            const baud = options.baudRate || 9600;
            await openAndClaim(d, () => [0]);

            const eps = d.configuration.interfaces[0].alternate.endpoints;
            this.inEp  = eps.find(e => e.direction === "in"  && e.type === "bulk").endpointNumber;
            this.outEp = eps.find(e => e.direction === "out" && e.type === "bulk").endpointNumber;

            const ver = await this.ctrlIn(0x5F, 0, 0, 2);   // read version
            this.version = (ver && ver.data && ver.data.byteLength) ? ver.data.getUint8(0) : 0;
            log(`CH340 chip version 0x${this.version.toString(16)}`);
            await this.ctrlOut(0xA1, 0, 0);            // serial init
            await this.setBaud(baud);
            await this.ctrlIn(0x95, 0x2518, 0, 2);
            await this.ctrlOut(0x9A, 0x2518, 0x00C3);  // 8 data bits, RX+TX on
            await this.ctrlIn(0x95, 0x0706, 0, 2);
            await this.ctrlOut(0xA1, 0x501F, 0xD90A);
            await this.setBaud(baud);
            await this.ctrlOut(0xA4, ~(0x20 | 0x40), 0); // DTR + RTS on

            makeStreams(this, d);
        }

        async close() {
            this.closed = true;
            try { await this.device.releaseInterface(0); } catch (e) {}
            try { await this.device.close(); } catch (e) {}
        }
    }

    // Android: list every USB device the phone can see, then pick the right driver.
    async function requestAndroidPort() {
        const device = await navigator.usb.requestDevice({ filters: [] });
        const vid = device.vendorId.toString(16).padStart(4, "0").toUpperCase();
        const pid = device.productId.toString(16).padStart(4, "0").toUpperCase();
        window.robotUsbId = `${vid}:${pid}`;
        log(`USB device selected: ${vid}:${pid} "${device.productName || "unknown"}"`);
        if (device.opened) { try { await device.close(); } catch (e) {} }

        if (device.vendorId === CH34X_VENDOR) {
            window.robotTransport = "WebUSB (CH340)";
            return new CH34xPort(device);
        }

        const isStandardSerial =
            device.vendorId === 0x2341 || device.vendorId === 0x2A03 ||
            device.deviceClass === 2 ||
            (device.configuration?.interfaces || []).some(i =>
                i.alternates?.some(a => a.interfaceClass === 2 || a.interfaceClass === 10));

        if (isStandardSerial) {
            window.robotTransport = "WebUSB (standard serial)";
            return new CdcAcmPort(device);
        }
        throw new Error(`This USB chip is not supported yet (ID ${vid}:${pid}, "${device.productName || "unknown"}"). Send this ID to get it added.`);
    }

    // Android phones/tablets, including Chrome/Edge in "desktop site" mode,
    // which hide "Android" and pretend to be a Linux PC.
    function isAndroidLike() {
        const ua = navigator.userAgent;
        if (/Android/i.test(ua)) return true;
        if (navigator.userAgentData?.platform === "Android") return true;
        return /Linux/i.test(ua) && !/CrOS/i.test(ua) && navigator.maxTouchPoints > 0;
    }

    // ================================================================
    // Wi-Fi link through the ESP32 bridge (WebSocket on port 81).
    // Used automatically when the app is opened from the ESP32 itself.
    // ================================================================
    function isServedByEsp32() {
        const h = location.hostname;
        return location.protocol === "http:" && h !== "" &&
            h !== "localhost" && h !== "127.0.0.1";
    }

    class WifiPort {
        constructor(url) {
            this.url = url;
            this.ws = null;
            this.readable = null;
            this.writable = null;
        }

        open() {
            return new Promise((resolve, reject) => {
                let controller;
                let opened = false;
                const ws = new WebSocket(this.url);
                this.ws = ws;

                this.readable = new ReadableStream({
                    start(c) { controller = c; },
                    cancel() { try { ws.close(); } catch (e) {} }
                });
                this.writable = new WritableStream({
                    write(chunk) {
                        if (ws.readyState !== WebSocket.OPEN) throw new Error("Wi-Fi link to the arm is not open");
                        ws.send(new TextDecoder().decode(chunk));
                    }
                });

                ws.onopen = () => { opened = true; resolve(); };
                ws.onmessage = e => {
                    if (typeof e.data === "string") controller.enqueue(new TextEncoder().encode(e.data));
                };
                ws.onerror = () => {
                    if (!opened) reject(new Error(`Could not reach the arm over Wi-Fi (${this.url}). Is the ESP32 on and are you on its network?`));
                };
                ws.onclose = () => {
                    try { controller.close(); } catch (e) {}
                    if (opened && window.serialConnected) {
                        window.serialConnected = false;
                        log("Wi-Fi connection to the arm was lost.", "warn");
                        window.connection?.(false);
                        window.dispatchEvent(new CustomEvent("robot-connection-changed"));
                    }
                };
            });
        }

        async close() {
            try { this.ws?.close(); } catch (e) {}
        }
    }

    async function connectArduino() {
        try {
            if (isServedByEsp32()) {
                window.robotTransport = "Wi-Fi (ESP32)";
                port = new WifiPort(`ws://${location.hostname}:81/`);
            } else
            // Use the USB driver on Android, including tablets in Chrome's
            // "desktop site" mode (which hides "Android"), and on any browser
            // that has WebUSB but no Web Serial.
            if ("usb" in navigator && (isAndroidLike() || !("serial" in navigator))) {
                port = await requestAndroidPort();
            } else if ("serial" in navigator) {
                window.robotTransport = "Web Serial";
                try {
                    port = await navigator.serial.requestPort();
                } catch (e) {
                    // Tablet browsers in "desktop site" mode can land here and
                    // find nothing. If USB access exists, offer the USB driver.
                    if (e.name === "NotFoundError" && "usb" in navigator &&
                        navigator.maxTouchPoints > 0 &&
                        confirm("No serial port selected. Try connecting with the tablet/phone USB driver instead?")) {
                        port = await requestAndroidPort();
                    } else {
                        throw e;
                    }
                }
            } else {
                alert("USB serial is not supported by this browser.");
                return false;
            }

            await port.open({
                baudRate: window.robotBaudRate,
                dataBits: 8,
                stopBits: 1,
                parity: "none",
                flowControl: "none"
            });

            writer = port.writable.getWriter();
            window.robotSyncReady = false;
            readLoopDone = readLoop(port);
            window.serialConnected = true;
            window.emergencyStopped = false;

            // USB connections restart the Arduino, so give it time to boot.
            // Over Wi-Fi the Arduino keeps running, so a short pause is enough.
            await new Promise(resolve => setTimeout(resolve,
                window.robotTransport === "Wi-Fi (ESP32)" ? 300 : 2500));

            log(`Arduino connected at ${window.robotBaudRate} baud via ${window.robotTransport}.`);
            window.dispatchEvent(new CustomEvent("robot-connection-changed"));
            return true;
        } catch (error) {
            window.serialConnected = false;
            window.robotFailedCommands++;
            window.dispatchEvent(new CustomEvent("robot-connection-changed"));
            console.error(error);
            if (error.name !== "NotFoundError") {
                const info = window.robotUsbId ? `\n\nUSB chip: ${window.robotUsbId}\nDriver: ${window.robotTransport}` : "";
                const tip = /claim/i.test(String(error.message))
                    ? "\n\nTip: close other tabs/apps using the Arduino, unplug it for 5 seconds, plug it back in and try again."
                    : "";
                alert("Arduino connection failed: " + (error.message || error) + info + tip);
            }
            return false;
        }
    }

    // Slider value (0-180) -> servo angle (0-180). Straight 1:1 by default.
    function mapAngle(config, angle) {
        const uiMin = Number(config.uiMin ?? 0);
        const uiMax = Number(config.uiMax ?? 180);
        let appAngle = Math.max(uiMin, Math.min(uiMax, Number(angle)));
        const originalAppAngle = appAngle;

        if (config.reverse) {
            appAngle = uiMin + uiMax - appAngle;
        }

        const servoMin = Number(config.servoMin ?? 0);
        const servoMax = Number(config.servoMax ?? 180);
        const t = (appAngle - uiMin) / ((uiMax - uiMin) || 1);
        const servoAngle = servoMin + t * (servoMax - servoMin);

        return {
            appAngle: Math.round(originalAppAngle),
            effectiveAngle: Math.round(appAngle),
            servoAngle: Math.round(Math.max(0, Math.min(180, servoAngle)))
        };
    }

    async function sendRawLine(text) {
        if (!writer || !window.serialConnected) {
            log("Arduino is not connected.", "warn");
            return false;
        }
        writeQueue = writeQueue.then(() => writer.write(encoder.encode(text + "\n")));
        try { await writeQueue; log(`Sent to Arduino: ${text}`); return true; }
        catch (e) { log(`Send failed: ${e.message}`, "error"); return false; }
    }
    window.sendRawLine = sendRawLine;

    async function sendServoCommand(jointNumber, angle) {
        const joint = Math.max(1, Math.min(4, Math.round(Number(jointNumber))));
        const cfg = calibration[joint - 1];

        if (!cfg || !cfg.enabled || cfg.commandId == null) {
            log(`${JOINT_NAMES[joint-1]} command blocked: joint is not calibrated/enabled.`, "warn");
            return false;
        }

        if (!writer || !window.serialConnected) {
            log(`${JOINT_NAMES[joint-1]} simulated only: hardware is offline.`, "warn");
            return false;
        }

        if (window.emergencyStopped) {
            log("Command blocked by emergency stop.", "error");
            return false;
        }

        const mapped = mapAngle(cfg, angle);
        const command = `${cfg.commandId} ${mapped.servoAngle}\n`;

        writeQueue = writeQueue.then(() => writer.write(encoder.encode(command)));

        try {
            await writeQueue;
            window.robotCommandCount++;

            window.robotLastCommand = {
                joint: JOINT_NAMES[joint-1],
                jointNumber: joint,
                commandId: cfg.commandId,
                appAngle: mapped.appAngle,
                effectiveAngle: mapped.effectiveAngle,
                servoAngle: mapped.servoAngle,
                time: new Date().toLocaleTimeString()
            };

            window.dispatchEvent(new CustomEvent("robot-command-sent", {
                detail: window.robotLastCommand
            }));

            log(
                `${JOINT_NAMES[joint-1]}: ${mapped.appAngle}° → ID ${cfg.commandId} → ${mapped.servoAngle}°`
            );
            return true;
        } catch (error) {
            window.robotFailedCommands++;
            log("Serial write failed: " + (error.message || error), "error");
            await disconnectArduino();
            return false;
        }
    }

    async function disconnectArduino() {
        window.serialConnected = false;
        window.robotSyncReady = false;
        try {
            await writeQueue.catch(() => {});
            if (reader) {
                try { await reader.cancel(); } catch (e) {}
            }
            await readLoopDone.catch(() => {});
            if (writer) {
                writer.releaseLock();
                writer = null;
            }
            if (port) {
                await port.close();
                port = null;
            }
            log("Arduino disconnected.");
        } catch (error) {
            console.warn(error);
        }
        window.dispatchEvent(new CustomEvent("robot-connection-changed"));
    }

    window.connectArduino = connectArduino;
    window.sendServoCommand = sendServoCommand;
    window.disconnectArduino = disconnectArduino;
    window.getRobotCalibration = getRobotCalibration;
    window.saveRobotCalibration = saveRobotCalibration;
    window.resetRobotCalibration = resetRobotCalibration;
})();