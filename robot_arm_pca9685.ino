#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

const int NUM_SERVOS = 4;

// PCA9685 channel for each servo: {Base, Shoulder, Elbow, Gripper}
// >>> Set these to match how your servos are actually wired. <<<
const int CH_MAP[NUM_SERVOS] = {0, 1, 2, 3};
const char* SERVO_NAMES[NUM_SERVOS] = {"Base", "Shoulder", "Elbow", "Gripper"};

const int SERVO_FREQ = 50;
const int SERVO_MIN = 150;   // previous sketch used 120
const int SERVO_MAX = 600;   // previous sketch used 520

// true  = print a reply for every command (good for Serial Monitor testing)
// false = stay quiet (recommended when using the web app)
const bool ECHO_COMMANDS = false;

int currentServo = 1;
int currentAngle[NUM_SERVOS] = {0, 0, 0, 0};
String buffer = "";          // FIX: was used but never declared

void processCommand(String cmd);
void showPos();

int angleToTick(int angle) {
  angle = constrain(angle, 0, 180);
  return map(angle, 0, 180, SERVO_MIN, SERVO_MAX);
}

void setServoAngle(int servoIdx, int angle) {
  if (servoIdx < 1 || servoIdx > NUM_SERVOS) return;

  int ch = CH_MAP[servoIdx - 1];
  pwm.setPWM(ch, 0, angleToTick(angle));
  currentAngle[servoIdx - 1] = angle;
}

void i2cScan() {
  Serial.println(F("Scanning I2C..."));
  int found = 0;

  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print(F("  found 0x"));
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
      found++;
    }
  }

  if (found == 0) {
    Serial.println(F("  !! no I2C device found"));
  } else {
    Serial.print(F("  total: "));
    Serial.println(found);
  }
}

void setup() {
  Serial.begin(9600);
  Wire.begin();

  Serial.println();
  Serial.println(F("=== PCA9685 Servo Test (4 servos) ==="));

  // Printed from CH_MAP so it always matches the real channels
  for (int i = 0; i < NUM_SERVOS; i++) {
    Serial.print(i + 1);
    Serial.print(' ');
    Serial.print(SERVO_NAMES[i]);
    Serial.print(F(" -> ch "));
    Serial.println(CH_MAP[i]);
  }

  i2cScan();

  pwm.begin();
  pwm.setPWMFreq(SERVO_FREQ);
  delay(10);

  Serial.println(F("\nCommands:"));
  Serial.println(F("  1 90   -> base to 90 deg"));
  Serial.println(F("  2 90   -> shoulder to 90 deg"));
  Serial.println(F("  3 90   -> elbow to 90 deg"));
  Serial.println(F("  4 90   -> gripper to 90 deg"));
  Serial.println(F("  c 2    -> select servo 2"));
  Serial.println(F("  90     -> selected servo to 90 deg"));
  Serial.println(F("  all 90 -> all servos to 90 deg"));
  Serial.println(F("  pos    -> show last commanded angles"));
  Serial.println(F("  scan   -> I2C scan"));
  Serial.print(F("current servo = "));
  Serial.println(currentServo);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();

    if (c == '\n' || c == '\r') {
      processCommand(buffer);
      buffer = "";
    } else {
      buffer += c;
    }
  }
}

void processCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd.equalsIgnoreCase("scan")) {
    i2cScan();
    return;
  }

  if (cmd.equalsIgnoreCase("pos")) {
    showPos();
    return;
  }

  if (cmd.startsWith("c ") || cmd.startsWith("C ")) {
    int s = cmd.substring(2).toInt();

    if (s < 1 || s > NUM_SERVOS) {
      Serial.println(F("!! servo 1-4"));
      return;
    }

    currentServo = s;
    Serial.print(F("current servo = "));
    Serial.println(currentServo);
    return;
  }

  if (cmd.startsWith("all ") || cmd.startsWith("ALL ")) {
    int angle = cmd.substring(4).toInt();

    if (angle < 0 || angle > 180) {
      Serial.println(F("!! angle 0-180"));
      return;
    }

    for (int i = 1; i <= NUM_SERVOS; i++) {
      setServoAngle(i, angle);
      delay(30);
    }

    Serial.print(F("all -> "));
    Serial.print(angle);
    Serial.println(F(" deg"));
    return;
  }

  int spaceIdx = cmd.indexOf(' ');
  int servoIdx;
  int angle;

  if (spaceIdx > 0) {
    servoIdx = cmd.substring(0, spaceIdx).toInt();
    angle = cmd.substring(spaceIdx + 1).toInt();
  } else {
    servoIdx = currentServo;
    angle = cmd.toInt();
  }

  if (servoIdx < 1 || servoIdx > NUM_SERVOS) {
    if (ECHO_COMMANDS) Serial.println(F("!! servo 1-4"));
    return;
  }

  if (angle < 0 || angle > 180) {
    if (ECHO_COMMANDS) Serial.println(F("!! angle 0-180"));
    return;
  }

  setServoAngle(servoIdx, angle);

  if (ECHO_COMMANDS) {
    Serial.print(F("servo "));
    Serial.print(servoIdx);
    Serial.print(F(" (ch "));
    Serial.print(CH_MAP[servoIdx - 1]);
    Serial.print(F(") -> "));
    Serial.print(angle);
    Serial.println(F(" deg"));
  }
}

void showPos() {
  for (int i = 1; i <= NUM_SERVOS; i++) {
    Serial.print(F("servo "));
    Serial.print(i);
    Serial.print(F(" (ch "));
    Serial.print(CH_MAP[i - 1]);
    Serial.print(F("): "));
    Serial.print(currentAngle[i - 1]);
    Serial.println(F(" deg"));
  }
}
