/*
  4-DOF Robot Arm - FINAL
  Arduino Uno + PCA9685, works with the Robot Arm Control web app.

  Hardware settings are from the version proven on this arm:
    PCA9685 channels: 0 = Base, 1 = Shoulder, 2 = Elbow, 3 = Gripper (MG90S)
    Pulse range 100-510 ticks, gripper limited to 40-140 deg,
    shoulder direction inverted (0 = forward pickup, 90 = upright).

  The app sends "<joint> <angle>" lines at 9600 baud, e.g. "2 45".
  Every command is kept (none are thrown away), and motion stays smooth.

  Serial Monitor (9600 baud, close it before using the app):
    1 90 / 2 45 / 3 45 / 4 100  -> move a joint
    pos                          -> show current angles
*/

#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

const int NUM_SERVOS = 4;
const int CH_MAP[NUM_SERVOS] = {0, 1, 2, 3};
const char* NAMES[NUM_SERVOS] = {"Base", "Shoulder", "Elbow", "Gripper"};

const int SERVO_FREQ = 50;
const int SERVO_MIN = 100;   // pulse ticks at 0 deg
const int SERVO_MAX = 510;   // pulse ticks at 180 deg

// Angle limits per joint: {MIN, MAX}
const int ANGLE_LIMITS[NUM_SERVOS][2] = {
  {0, 180},   // Base
  {0, 180},   // Shoulder
  {0, 180},   // Elbow
  {40, 140}   // Gripper (MG90S safe range)
};

// Start position when the Arduino powers up or the app connects.
// The app then moves the arm smoothly to match its sliders.
const int START_ANGLE = 90;

// Smooth motion: 1 degree every STEP_INTERVAL_MS (12 ms = ~83 deg/s).
const unsigned long STEP_INTERVAL_MS = 12;

// true = reply to every command (Serial Monitor testing). Keep false for the app.
const bool ECHO_COMMANDS = false;

int currentAngle[NUM_SERVOS];
int targetAngle[NUM_SERVOS];
unsigned long lastStepTime = 0;

char lineBuf[32];
uint8_t lineLen = 0;

int angleToTick(int angle) {
  return map(angle, 0, 180, SERVO_MIN, SERVO_MAX);
}

int limitAngle(int j, int angle) {
  return constrain(angle, ANGLE_LIMITS[j][0], ANGLE_LIMITS[j][1]);
}

void writeServo(int j, int angle) {
  angle = limitAngle(j, angle);
  int outputAngle = angle;
  if (j == 1) outputAngle = 180 - angle;        // inverted shoulder
  pwm.setPWM(CH_MAP[j], 0, angleToTick(outputAngle));
  currentAngle[j] = angle;
}

void updateServosSmooth() {
  if (millis() - lastStepTime < STEP_INTERVAL_MS) return;
  lastStepTime = millis();

  for (int j = 0; j < NUM_SERVOS; j++) {
    if (currentAngle[j] < targetAngle[j])      writeServo(j, currentAngle[j] + 1);
    else if (currentAngle[j] > targetAngle[j]) writeServo(j, currentAngle[j] - 1);
  }
}

void showPos() {
  for (int j = 0; j < NUM_SERVOS; j++) {
    Serial.print(j + 1);
    Serial.print(' ');
    Serial.print(NAMES[j]);
    Serial.print(F(": "));
    Serial.print(currentAngle[j]);
    Serial.println(F(" deg"));
  }
}

void processLine(char* s) {
  while (*s == ' ' || *s == '\t') s++;
  if (*s == '\0') return;

  if (strcasecmp(s, "pos") == 0) { showPos(); return; }

  int joint = -1, angle = -1;
  if (sscanf(s, "%d %d", &joint, &angle) != 2) {
    if (ECHO_COMMANDS) Serial.println(F("Error: use [JOINT] [ANGLE], e.g. 1 90"));
    return;
  }
  if (joint < 1 || joint > NUM_SERVOS) {
    if (ECHO_COMMANDS) Serial.println(F("Error: joint must be 1-4"));
    return;
  }

  int j = joint - 1;
  targetAngle[j] = limitAngle(j, angle);

  if (ECHO_COMMANDS) {
    Serial.print(NAMES[j]);
    Serial.print(F(" -> "));
    Serial.println(targetAngle[j]);
  }
}

void setup() {
  Serial.begin(9600);
  Wire.begin();

  pwm.begin();
  pwm.setPWMFreq(SERVO_FREQ);
  delay(10);

  // Go to the start position one joint at a time (avoids a current surge).
  for (int j = 0; j < NUM_SERVOS; j++) {
    writeServo(j, START_ANGLE);
    targetAngle[j] = currentAngle[j];
    delay(150);
  }

  Serial.println(F("4-DOF ARM READY (1 Base, 2 Shoulder, 3 Elbow, 4 Gripper)"));
}

void loop() {
  // Read every waiting character; run each command when its line ends.
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      lineBuf[lineLen] = '\0';
      processLine(lineBuf);
      lineLen = 0;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineLen = 0;   // line too long - discard
    }
  }

  updateServosSmooth();
}
