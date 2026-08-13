(() => {
    "use strict";

    let port = null;
    let writer = null;
    let writeQueue = Promise.resolve();

    const encoder = new TextEncoder();

    window.serialConnected = false;

    async function connectArduino() {

        try {

            // Android:
            // Prefer WebUSB serial polyfill.
            // Laptop:
            // Use normal Web Serial.
            let serialAPI;

            if (
                /Android/i.test(navigator.userAgent) &&
                window.androidSerial
            ) {
                serialAPI = window.androidSerial;

                console.log(
                    "Using WebUSB serial on Android."
                );
            } else if ("serial" in navigator) {
                serialAPI = navigator.serial;

                console.log(
                    "Using native Web Serial."
                );
            } else {
                alert(
                    "USB serial is not supported by this browser."
                );

                return false;
            }

            port = await serialAPI.requestPort();

            await port.open({
                baudRate: 9600,
                dataBits: 8,
                stopBits: 1,
                parity: "none",
                flowControl: "none"
            });

            writer = port.writable.getWriter();

            window.serialConnected = true;
            window.emergencyStopped = false;

            // Give Arduino time after connection
            await new Promise(resolve => {
                setTimeout(resolve, 1800);
            });

            console.log(
                "Arduino connected at 9600 baud."
            );

            return true;

        } catch (error) {

            console.error(
                "Arduino connection failed:",
                error
            );

            window.serialConnected = false;

            if (error.name !== "NotFoundError") {
                alert(
                    "Arduino connection failed: " +
                    (error.message || error)
                );
            }

            return false;
        }
    }


    async function sendServoCommand(
        servoNumber,
        angle
    ) {

        if (
            !writer ||
            !window.serialConnected ||
            window.emergencyStopped
        ) {
            return false;
        }

        const safeServo = Math.max(
            1,
            Math.min(
                6,
                Math.round(Number(servoNumber))
            )
        );

        const safeAngle = Math.max(
            0,
            Math.min(
                180,
                Math.round(Number(angle))
            )
        );

        // Same format that worked
        // in Serial USB Terminal:
        // 1 90\n

        const command =
            `${safeServo} ${safeAngle}\n`;

        writeQueue = writeQueue.then(
            () =>
                writer.write(
                    encoder.encode(command)
                )
        );

        try {

            await writeQueue;

            console.log(
                "Sent:",
                command.trim()
            );

            return true;

        } catch (error) {

            console.error(
                "Serial write failed:",
                error
            );

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

            console.log(
                "Arduino disconnected."
            );

        } catch (error) {

            console.warn(
                "Disconnect warning:",
                error
            );
        }
    }


    window.connectArduino =
        connectArduino;

    window.sendServoCommand =
        sendServoCommand;

    window.disconnectArduino =
        disconnectArduino;

})();