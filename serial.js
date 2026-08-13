(() => {
    "use strict";

    let port = null;
    let writer = null;
    let writeQueue = Promise.resolve();

    const encoder = new TextEncoder();

    window.serialConnected = false;


    // =====================================================
    // WEB JOINT -> ARDUINO COMMAND MAPPING
    // =====================================================
    //
    // UI:
    // 1 = Base
    // 2 = Shoulder
    // 3 = Elbow
    // 4 = Wrist Roll
    // 5 = Wrist Yaw
    // 6 = Gripper
    //
    // TESTED PHYSICAL RESPONSE:
    //
    // Arduino 1 = Base
    // Arduino 2 = Shoulder
    // Arduino 4 = Elbow
    // Arduino 6 = Wrist Yaw
    // Arduino 5 = Gripper
    //
    // Wrist Roll is still unknown.
    // We DISABLE it instead of allowing it to move
    // the wrong motor.
    // =====================================================

    const JOINT_MAP = {
        1: 1,       // BASE
        2: 2,       // SHOULDER
        3: 4,       // ELBOW
        4: null,    // WRIST ROLL - not identified yet
        5: 6,       // WRIST YAW
        6: 5        // GRIPPER
    };


    // =====================================================
    // CONNECT
    // =====================================================

    async function connectArduino() {

        try {

            let serialAPI;


            // Android
            if (
                /Android/i.test(navigator.userAgent) &&
                window.androidSerial
            ) {

                serialAPI = window.androidSerial;

                console.log(
                    "Using WebUSB serial on Android."
                );

            }

            // Laptop / desktop
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


            // Allow Arduino Uno to reset
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
    // SEND JOINT COMMAND
    //
    // APPLICATION:
    //
    // -90° = reverse / left
    //   0° = center
    // +90° = forward / right
    //
    // ARDUINO:
    //
    // -90° ->   0°
    //   0° ->  90°
    // +90° -> 180°
    //
    // =====================================================

    async function sendServoCommand(
        jointNumber,
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
        // WEB JOINT NUMBER
        // ---------------------------------------------

        const safeJoint = Math.max(
            1,
            Math.min(
                6,
                Math.round(
                    Number(jointNumber)
                )
            )
        );


        // ---------------------------------------------
        // FIND PHYSICAL ARDUINO COMMAND ID
        // ---------------------------------------------

        const arduinoServo =
            JOINT_MAP[safeJoint];


        // Wrist Roll is intentionally blocked until
        // its real motor/channel is identified.
        if (arduinoServo == null) {

            console.warn(
                "Wrist Roll is currently unassigned."
            );

            return false;
        }


        // ---------------------------------------------
        // APPLICATION ANGLE
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
        // -90..+90 -> 0..180
        // ---------------------------------------------

        const servoAngle =
            appAngle + 90;


        // ---------------------------------------------
        // SEND ONLY ONE COMMAND
        // ---------------------------------------------

        const command =
            `${arduinoServo} ${servoAngle}\n`;


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
                `UI Joint ${safeJoint}` +
                ` -> Arduino ${arduinoServo}` +
                ` | ${appAngle}°` +
                ` -> ${servoAngle}°`
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
    // EXPOSE FUNCTIONS
    // =====================================================

    window.connectArduino =
        connectArduino;

    window.sendServoCommand =
        sendServoCommand;

    window.disconnectArduino =
        disconnectArduino;

})();