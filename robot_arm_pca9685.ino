/*
  4-DOF Robot Arm - PCA9685 + Arduino Uno
  For the Robot Arm Control web app (GitHub Pages).

  The app sends "<id> <angle>\n" at 9600 baud, angle 0-180:
    1 = Base      (MG996R)  -> PCA9685 channel 0
    2 = Shoulder  (DS3120, 180 deg) -> channel 1
    3 = Elbow     (MG996R)  -> channel 2
    4 = Gripper   (MG90S)   -> channel 3

  Wiring:
    Arduino 5V  -> PCA9685 VCC      Arduino GND -> PCA9685 GND
    Arduino A4  -> PCA9685 SDA      Arduino A5  -> PCA9685 SCL
    5V 10A adapter -> PCA9685 screw terminal (+ to V+, - to GND)
    Arduino is powered by USB only.

  Serial Monitor tests (9600 baud, close it before using the web app):
    scan      -> check PCA9685 is found at 0x40
    1 90      -> Base to 90   (2 Shoulder, 3 Elbow, 4 Gripper)
    all 90    -> all joints to 90
    ch 0 90   -> raw PCA9685 channel 0 to 90
    pos       -> show current angles
    health    -> how many times the PCA9685 had to be restored
    help      -> list commands
*/

#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

// ======================= SETTINGS =======================

const int NUM_JOINTS = 4;
const char* JOINT_NAMES[NUM_JOINTS] = {"Base", "Shoulder", "Elbow", "Gripper"};

// PCA9685 channel for each joint {Base, Shoulder, Elbow, Gripper}
const uint8_t CH_MAP[NUM_JOINTS] = {0, 1, 2, 3};

// Pulse range per joint in PCA9685 ticks at 50 Hz (1 tick = ~4.9 us).
// 110 = ~0.54 ms (0 deg), 490 = ~2.39 ms (180 deg). Safe for MG996R, DS3120, MG90S.
// If a servo buzzes at an end of travel, move that number ~10 toward 300.
const int PULSE_MIN[NUM_JOINTS] = {110, 110, 110, 110};
const int PULSE_MAX[NUM_JOINTS] = {490, 490, 490, 490};

// Mechanical safety limits per joint (degrees 0-180).
// Narrow these if a joint hits the frame, e.g. gripper {40, 140}.
const int ANGLE_MIN[NUM_JOINTS] = {0, 0, 0, 0};
const int ANGLE_MAX[NUM_JOINTS] = {180, 180, 180, 180};

// Start-up position. Matches the app: sliders start at 0 = HOME.
const int START_ANGLE = 0;

// Smooth motion: max degrees moved every SMOOTH_INTERVAL_MS.
// 2 deg / 10 ms = 200 deg/s. Lower = gentler, higher = snappier.
const int SMOOTH_STEP_DEG = 2;
const unsigned long SMOOTH_INTERVAL_MS = 10;

// Wiggle each servo on start-up (useful for testing). The Arduino restarts
// every time the web app connects, so keep this false for normal use.
const bool SELF_TEST_ON_START = false;

// Print a reply for every move (Serial Monitor only). Keep false for the app.
const bool ECHO_MOVES = false;

// Self-healing against electrical noise from big servos:
// re-send every joint's position regularly, and restore the PCA9685 if it resets.
const unsigned long REFRESH_INTERVAL_MS = 100;
const unsigned long HEALTH_CHECK_MS = 250;

// ========================================================

const int LED = LED_BUILTIN;   // "L" LED blinks when a command arrives

int currentAngle[NUM_JOINTS];
int targetAngle[NUM_JOINTS];
char lineBuf[32];
uint8_t lineLen = 0;
unsigned long lastSmooth = 0;
unsigned long lastRefresh = 0;
unsigned long lastHealth = 0;
unsigned long ledOffAt = 0;
uint8_t expectedPrescale = 0;
unsigned int recoveries = 0;


int limitAngle(int j, int angle) {                 // j = 0..3
  return constrain(angle, ANGLE_MIN[j], ANGLE_MAX[j]);
}

void writeJoint(int j, int angle) {                // immediate write, j = 0..3
  angle = limitAngle(j, angle);
  int tick = map(angle, 0, 180, PULSE_MIN[j], PULSE_MAX[j]);
  pwm.setPWM(CH_MAP[j], 0, tick);
  currentAngle[j] = angle;
}

void setTarget(int jointNumber, int angle) {       // jointNumber = 1..4
  if (jointNumber < 1 || jointNumber > NUM_JOINTS) return;
  targetAngle[jointNumber - 1] = limitAngle(jointNumber - 1, angle);
}

void updateSmoothMotion() {
  if (millis() - lastSmooth < SMOOTH_INTERVAL_MS) return;
  lastSmooth = millis();

  for (int j = 0; j < NUM_JOINTS; j++) {
    int diff = targetAngle[j] - currentAngle[j];
    if (diff == 0) continue;
    int step = constrain(diff, -SMOOTH_STEP_DEG, SMOOTH_STEP_DEG);
    writeJoint(j, currentAngle[j] + step);
  }
}

void startDriver() {
  pwm.begin();
  pwm.setOscillatorFrequency(27000000);
  pwm.setPWMFreq(50);
  Wire.setClock(100000);                 // standard, noise-tolerant I2C speed
  delay(10);
  expectedPrescale = pwm.readPrescale();
}

void refreshAllJoints() {                // re-send every position
  for (int j = 0; j < NUM_JOINTS; j++) writeJoint(j, currentAngle[j]);
}

void keepDriverHealthy() {
  if (millis() - lastRefresh >= REFRESH_INTERVAL_MS) {
    lastRefresh = millis();
    refreshAllJoints();
  }

  if (millis() - lastHealth >= HEALTH_CHECK_MS) {
    lastHealth = millis();
    // After a reset/brown-out the PCA9685 loses its 50 Hz setting.
    if (pwm.readPrescale() != expectedPrescale) {
      startDriver();
      refreshAllJoints();
      recoveries++;
      Serial.print(F("!! PCA9685 reset detected - restored ("));
      Serial.print(recoveries);
      Serial.println(F(")"));
    }
  }
}

void blink() {
  digitalWrite(LED, HIGH);
  ledOffAt = millis() + 40;
}

void i2cScan() {
  Serial.println(F("Scanning I2C..."));
  bool found40 = false;
  int found = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print(F("  found 0x"));
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
      if (addr == 0x40) found40 = true;
      found++;
    }
  }
  if (found == 0)      Serial.println(F("  !! no I2C device - check SDA(A4), SCL(A5), VCC, GND"));
  else if (!found40)   Serial.println(F("  !! PCA9685 not at 0x40 - check address jumpers"));
  else                 Serial.println(F("  PCA9685 OK at 0x40"));
}

void showHelp() {
  Serial.println(F("Commands: scan | 1 90 | 2 90 | 3 90 | 4 90 | all 90 | ch 0 90 | pos | health | help"));
}

void showPos() {
  for (int j = 0; j < NUM_JOINTS; j++) {
    Serial.print(j + 1);
    Serial.print(' ');
    Serial.print(JOINT_NAMES[j]);
    Serial.print(F(" (ch "));
    Serial.print((int)CH_MAP[j]);
    Serial.print(F("): "));
    Serial.print(currentAngle[j]);
    Serial.println(F(" deg"));
  }
}

void processLine(char* s) {
  while (*s == ' ' || *s == '\t') s++;
  if (*s == '\0') return;

  blink();

  if (strcasecmp(s, "scan") == 0) { i2cScan();  return; }
  if (strcasecmp(s, "pos") == 0)  { showPos();  return; }
  if (strcasecmp(s, "help") == 0) { showHelp(); return; }
  if (strcasecmp(s, "health") == 0) {
    Serial.print(F("PCA9685 recoveries since start: "));
    Serial.println(recoveries);
    return;
  }

  if (strncasecmp(s, "all ", 4) == 0) {
    int a = atoi(s + 4);
    for (int j = 1; j <= NUM_JOINTS; j++) setTarget(j, a);
    Serial.print(F("all -> "));
    Serial.println(constrain(a, 0, 180));
    return;
  }

  if (strncasecmp(s, "ch ", 3) == 0) {             // raw channel test
    int ch = -1, a = -1;
    if (sscanf(s + 3, "%d %d", &ch, &a) == 2 && ch >= 0 && ch <= 15) {
      a = constrain(a, 0, 180);
      pwm.setPWM(ch, 0, map(a, 0, 180, 110, 490));
      Serial.print(F("raw ch "));
      Serial.print(ch);
      Serial.print(F(" -> "));
      Serial.println(a);
    } else {
      Serial.println(F("!! use: ch <0-15> <0-180>"));
    }
    return;
  }

  // Command from the web app: "<id> <angle>"
  int id = -1, a = -1;
  if (sscanf(s, "%d %d", &id, &a) == 2) {
    if (id >= 1 && id <= NUM_JOINTS) {
      setTarget(id, a);
      if (ECHO_MOVES) {
        Serial.print(JOINT_NAMES[id - 1]);
        Serial.print(F(" -> "));
        Serial.println(targetAngle[id - 1]);
      }
    } else if (ECHO_MOVES) {
      Serial.println(F("!! joint 1-4"));
    }
    return;
  }

  Serial.println(F("?? unknown command - type help"));
}

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
  Wire.begin();
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(3000, true);       // never freeze on an I2C glitch
#endif

  Serial.println();
  Serial.println(F("=== 4-DOF Robot Arm (PCA9685) ==="));
  i2cScan();

  startDriver();

  // Go to the start position one joint at a time (limits current surge).
  for (int j = 0; j < NUM_JOINTS; j++) {
    writeJoint(j, START_ANGLE);
    targetAngle[j] = currentAngle[j];
    delay(200);
  }

  if (SELF_TEST_ON_START) {
    for (int j = 0; j < NUM_JOINTS; j++) {
      Serial.print(F("self-test: "));
      Serial.println(JOINT_NAMES[j]);
      writeJoint(j, START_ANGLE - 20);
      delay(300);
      writeJoint(j, START_ANGLE);
      delay(200);
    }
  }

  showPos();
  showHelp();
  Serial.println(F("READY"));
}

void loop() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      lineBuf[lineLen] = '\0';
      processLine(lineBuf);
      lineLen = 0;
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineLen = 0;
    }
  }

  updateSmoothMotion();
  keepDriverHealthy();

  if (ledOffAt && millis() > ledOffAt) {
    digitalWrite(LED, LOW);
    ledOffAt = 0;
  }
}
