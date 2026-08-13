(() => {
    "use strict";

    let port = null;
    let writer = null;
    let writeQueue = Promise.resolve();

    const encoder = new TextEncoder();

    window.serialConnected = false;


    // =====================================================
    // CONNECT TO ARDUINO
    // =====================================================

    async function connectArduino() {

        try {

            let serialAPI;

            // Android → WebUSB serial polyfill
            if (
                /Android/i.test(navigator.userAgent) &&
                window.androidSerial
            ) {

                serialAPI = window.androidSerial;

                console.log(
                    "Using WebUSB serial on Android."
                );

            }

            // Laptop/Desktop → normal Web Serial
            else if ("serial" in navigator) {

                serialAPI = navigator.serial;

                console.log(
                    "Using native Web Serial."
                );

            }

            else {

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


            // Arduino Uno normally resets when
            // serial connection is opened.
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



    // =====================================================
    // SEND INDIVIDUAL SERVO COMMAND
    //
    // WEB APP:
    //
    // -90 = backward
    //   0 = center
    // +90 = forward
    //
    // ARDUINO:
    //
    // -90 →   0
    //   0 →  90
    // +90 → 180
    //
    // =====================================================

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


        // ---------------------------------------------
        // SERVO NUMBER
        // ---------------------------------------------

        const safeServo = Math.max(
            1,
            Math.min(
                6,
                Math.round(
                    Number(servoNumber)
                )
            )
        );


        // ---------------------------------------------
        // APPLICATION ANGLE
        // -90 → +90
        // ---------------------------------------------

        const appAngle = Math.max(
            -90,
            Math.min(
                90,
                Math.round(
                    Number(angle)
                )
            )
        );


        // ---------------------------------------------
        // CONVERT TO ARDUINO ANGLE
        //
        // -90 + 90 =   0
        //   0 + 90 =  90
        // +90 + 90 = 180
        // ---------------------------------------------

        const servoAngle =
            appAngle + 90;


        // ---------------------------------------------
        // ONE JOINT → ONE SERVO
        //
        // Servo 1 = Base
        // Servo 2 = Shoulder
        // Servo 3 = Elbow
        // Servo 4 = Wrist Roll
        // Servo 5 = Wrist Yaw
        // Servo 6 = Gripper
        // ---------------------------------------------

        const command =
            `${safeServo} ${servoAngle}\n`;


        writeQueue =
            writeQueue.then(
                () =>
                    writer.write(
                        encoder.encode(command)
                    )
            );


        try {

            await writeQueue;


            console.log(
                `Joint ${safeServo}: ` +
                `${appAngle}° → ` +
                `Servo ${servoAngle}°`
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



    // =====================================================
    // DISCONNECT
    // =====================================================

    async function disconnectArduino() {

        window.serialConnected = false;


        try {

            await writeQueue.catch(
                () => {}
            );


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



    // =====================================================
    // EXPOSE FUNCTIONS TO UI.JS
    // =====================================================

    window.connectArduino =
        connectArduino;

    window.sendServoCommand =
        sendServoCommand;

    window.disconnectArduino =
        disconnectArduino;

})();