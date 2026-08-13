(() => {
    "use strict";

    let port = null;
    let writer = null;
    let writeQueue = Promise.resolve();
    const encoder = new TextEncoder();

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
        "Wrist Roll",
        "Wrist Yaw",
        "Gripper"
    ];

    // Known working command mapping from physical tests.
    // Wrist Roll remains disabled until identified/calibrated.
    const DEFAULT_CALIBRATION = [
        { commandId: 1, uiMin: -90, uiMax: 90, servoMin: 0, center: 90, servoMax: 180, reverse: false, enabled: true },
        { commandId: 2, uiMin: -90, uiMax: 90, servoMin: 0, center: 90, servoMax: 180, reverse: false, enabled: true },
        { commandId: 4, uiMin: -90, uiMax: 90, servoMin: 0, center: 90, servoMax: 180, reverse: false, enabled: true },
        { commandId: null, uiMin: -90, uiMax: 90, servoMin: 0, center: 90, servoMax: 180, reverse: false, enabled: false },
        { commandId: 6, uiMin: -90, uiMax: 90, servoMin: 0, center: 90, servoMax: 180, reverse: false, enabled: true },
        { commandId: 5, uiMin: -90, uiMax: 90, servoMin: 0, center: 90, servoMax: 180, reverse: false, enabled: true }
    ];

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
            const raw = localStorage.getItem("robotCreatorV3Calibration");
            const parsed = raw ? JSON.parse(raw) : null;
            if (Array.isArray(parsed) && parsed.length === 6) {
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
        calibration = next.map((x,i) => ({...defaults()[i], ...x}));
        localStorage.setItem("robotCreatorV3Calibration", JSON.stringify(calibration));
        window.dispatchEvent(new CustomEvent("robot-calibration-changed"));
        log("Calibration profile saved.");
    }

    function resetRobotCalibration() {
        calibration = defaults();
        localStorage.setItem("robotCreatorV3Calibration", JSON.stringify(calibration));
        window.dispatchEvent(new CustomEvent("robot-calibration-changed"));
        log("Calibration reset to defaults.", "warn");
    }

    async function connectArduino() {
        try {
            let serialAPI;

            if (/Android/i.test(navigator.userAgent) && window.androidSerial) {
                serialAPI = window.androidSerial;
                window.robotTransport = "WebUSB Serial";
            } else if ("serial" in navigator) {
                serialAPI = navigator.serial;
                window.robotTransport = "Web Serial";
            } else {
                alert("USB serial is not supported by this browser.");
                return false;
            }

            port = await serialAPI.requestPort();

            await port.open({
                baudRate: window.robotBaudRate,
                dataBits: 8,
                stopBits: 1,
                parity: "none",
                flowControl: "none"
            });

            writer = port.writable.getWriter();
            window.serialConnected = true;
            window.emergencyStopped = false;

            await new Promise(resolve => setTimeout(resolve, 1800));

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

    function mapAngle(config, angle) {
        const uiMin = Number(config.uiMin ?? -90);
        const uiMax = Number(config.uiMax ?? 90);
        let appAngle = Math.max(uiMin, Math.min(uiMax, Number(angle)));

        const originalAppAngle = appAngle;

        if (config.reverse) {
            appAngle = -appAngle;
        }

        const center = Number(config.center ?? 90);
        const servoMin = Number(config.servoMin ?? 0);
        const servoMax = Number(config.servoMax ?? 180);

        let servoAngle;
        if (appAngle <= 0) {
            const t = (appAngle - uiMin) / (0 - uiMin || 1);
            servoAngle = servoMin + t * (center - servoMin);
        } else {
            const t = appAngle / (uiMax || 1);
            servoAngle = center + t * (servoMax - center);
        }

        return {
            appAngle: Math.round(originalAppAngle),
            effectiveAngle: Math.round(appAngle),
            servoAngle: Math.round(Math.max(0, Math.min(180, servoAngle)))
        };
    }

    async function sendServoCommand(jointNumber, angle) {
        const joint = Math.max(1, Math.min(6, Math.round(Number(jointNumber))));
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
        try {
            await writeQueue.catch(() => {});
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