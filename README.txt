ROBOT CREATOR V2

1. Install the Adafruit PWM Servo Driver Library in Arduino IDE.
2. Upload robot_arm_pca9685.ino to Arduino Uno on COM3.
3. Close Arduino Serial Monitor.
4. Open this folder in VS Code.
5. Right-click index.html and select Open with Live Server.
6. Use Microsoft Edge or Google Chrome.
7. Click CONNECT ARDUINO.
8. Select Arduino Uno / COM3.
9. Move the sliders.

The page includes:
- Live 3D industrial robot
- Mouse rotation and wheel zoom
- Six joint controls
- Save/play/stop movements
- Import/export positions
- Home and reset
- USB Arduino control at 9600 baud

Power note:
Do not power six servos from the Arduino 5V pin. Use an external 5-6V
servo power supply and connect the external supply ground, PCA9685 ground,
and Arduino ground together.
