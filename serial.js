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
            await this.ctrlOut(0x9A, 0x1312, v[0]);
            await this.ctrlOut(0x9A, 0x0F2C, v[1]);
        }

        async open(options = {}) {
            const d = this.device;
            const baud = options.baudRate || 9600;
            await d.open();
            if (d.configuration === null) await d.selectConfiguration(1);
            await d.claimInterface(0);

            const eps = d.configuration.interfaces[0].alternate.endpoints;
            this.inEp  = eps.find(e => e.direction === "in"  && e.type === "bulk").endpointNumber;
            this.outEp = eps.find(e => e.direction === "out" && e.type === "bulk").endpointNumber;

            await this.ctrlIn(0x5F, 0, 0, 2);          // read version
            await this.ctrlOut(0xA1, 0, 0);            // serial init
            await this.setBaud(baud);
            await this.ctrlIn(0x95, 0x2518, 0, 2);
            await this.ctrlOut(0x9A, 0x2518, 0x00C3);  // 8 data bits, RX+TX on
            await this.ctrlIn(0x95, 0x0706, 0, 2);
            await this.ctrlOut(0xA1, 0x501F, 0xD90A);
            await this.setBaud(baud);
            await this.ctrlOut(0xA4, ~(0x20 | 0x40), 0); // DTR + RTS on

            const self = this;
            this.readable = new ReadableStream({
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

            this.writable = new WritableStream({
                async write(chunk) {
                    const r = await d.transferOut(self.outEp, chunk);
                    if (r.status !== "ok") throw new Error("CH340 write failed");
                }
            });
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

        if (device.vendorId === CH34X_VENDOR) {
            window.robotTransport = "WebUSB (CH340)";
            return new CH34xPort(device);
        }

        const isStandardSerial =
            device.vendorId === 0x2341 || device.vendorId === 0x2A03 ||
            device.deviceClass === 2 ||
            (device.configuration?.interfaces || []).some(i =>
                i.alternates?.some(a => a.interfaceClass === 2 || a.interfaceClass === 10));

        if (isStandardSerial && window.AndroidSerialPortClass) {
            window.robotTransport = "WebUSB Serial";
            return new window.AndroidSerialPortClass(device);
        }
        if (isStandardSerial && window.androidSerial) {
            window.robotTransport = "WebUSB Serial";
            return window.androidSerial.requestPort();
        }
        const vid = device.vendorId.toString(16).padStart(4, "0").toUpperCase();
        const pid = device.productId.toString(16).padStart(4, "0").toUpperCase();
        throw new Error(`This USB chip is not supported yet (ID ${vid}:${pid}, "${device.productName || "unknown"}"). Send this ID to get it added.`);
    }

    async function connectArduino() {
        try {
            // Use the USB driver on Android, including tablets in Chrome's
            // "desktop site" mode (which hides "Android"), and on any browser
            // that has WebUSB but no Web Serial.
            const isAndroid = /Android/i.test(navigator.userAgent) ||
                navigator.userAgentData?.platform === "Android";
            if ("usb" in navigator && (isAndroid || !("serial" in navigator))) {
                port = await requestAndroidPort();
            } else if ("serial" in navigator) {
                window.robotTransport = "Web Serial";
                port = await navigator.serial.requestPort();
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

            await new Promise(resolve => setTimeout(resolve, 2500));

            log(`Arduino connected at ${window.robotBaudRate} baud via ${window.robotTransport}.`);
            window.dispatchEvent(new CustomEvent("robot-connection-changed"));
            return true;
        } catch (error) {
            window.serialConnected = false;
            window.robotFailedCommands++;
            window.dispatchEvent(new CustomEvent("robot-connection-changed"));
            console.error(error);
            if (error.name !== "NotFoundError") {
                alert("Arduino connection failed: " + (error.message || error));
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