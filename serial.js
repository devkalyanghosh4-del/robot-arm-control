(() => {
    "use strict";

    let port = null;
    let writer = null;
    let writeQueue = Promise.resolve();

    const encoder = new TextEncoder();

    window.serialConnected = false;

    async function connectArduino() {
        if (!("serial" in navigator)) {
            alert(
                "Web Serial is not supported. Use Google Chrome or Microsoft Edge on the laptop."
            );

            return false;
        }

        try {
            port = await navigator.serial.requestPort();

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

            // Arduino Uno usually resets when the serial port opens.
            await new Promise(resolve => {
                setTimeout(resolve, 1800);
            });

            console.log("Arduino connected at 9600 baud.");

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
                Math.round(
                    Number(servoNumber)
                )
            )
        );

        const safeAngle = Math.max(
            0,
            Math.min(
                180,
                Math.round(
                    Number(angle)
                )
            )
        );

        const command =
            `${safeServo} ${safeAngle}\n`;

        writeQueue = writeQueue.then(
            () => writer.write(
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

            console.log("Arduino disconnected.");

        } catch (error) {
            console.warn(
                "Disconnect warning:",
                error
            );
        }
    }

    window.connectArduino = connectArduino;
    window.sendServoCommand = sendServoCommand;
    window.disconnectArduino = disconnectArduino;
})();