#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

const uint8_t SERVO_CHANNELS[6] = {
  7,  // Base
  1,  // Shoulder
  3,  // Elbow
  4,  // Wrist Roll
  5,  // Wrist Yaw
  0   // Gripper - test this
};

const uint8_t MIRROR_SERVO_CHANNEL = 8;
const int SERVO_FREQUENCY = 50;
const int SERVO_MIN_TICK = 120;
const int SERVO_MAX_TICK = 520;

int angleToTick(int angle) {
  angle = constrain(angle, 0, 180);
  return map(angle, 0, 180, SERVO_MIN_TICK, SERVO_MAX_TICK);
}

void writeServo(uint8_t channel, int angle) {
  pwm.setPWM(channel, 0, angleToTick(angle));
}

void setup() {
  Serial.begin(9600);
  Serial.setTimeout(50);
  Wire.begin();
  pwm.begin();
  pwm.setPWMFreq(SERVO_FREQUENCY);
  delay(10);
}

void loop() {
  if (Serial.available() <= 0) return;

  String input = Serial.readStringUntil('\n');
  input.trim();

  int separatorIndex = input.indexOf(' ');
  if (separatorIndex <= 0) return;

  int servoIndex = input.substring(0, separatorIndex).toInt();
  int servoValue = constrain(
    input.substring(separatorIndex + 1).toInt(),
    0,
    180
  );

  switch (servoIndex) {
    case 1:
      writeServo(SERVO_CHANNELS[0], servoValue);
      break;
    case 2:
      writeServo(SERVO_CHANNELS[1], servoValue);
      break;
    case 3:
      writeServo(SERVO_CHANNELS[2], servoValue);
      break;
    case 4:
      writeServo(SERVO_CHANNELS[3], servoValue);
      break;
    case 5:
      writeServo(SERVO_CHANNELS[4], servoValue);
      writeServo(MIRROR_SERVO_CHANNEL, 180 - servoValue);
      break;
    case 6:
      writeServo(SERVO_CHANNELS[5], servoValue);
      break;
    default:
      break;
  }
}
