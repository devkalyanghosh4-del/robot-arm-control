/*
  4-DOF Robot Arm Firmware  -  v3.1 (no-jump restarts + ESP32 Wi-Fi bridge)
  Arduino Uno + PCA9685 + MG996R / DS3120 / MG996R / MG90S
  Works with the Robot Arm Control web app (9600 baud).
  No extra libraries needed (talks to the PCA9685 directly with Wire).

  RESTART BEHAVIOUR (why the arm no longer jumps to 90)
    - Arduino restarts but the PCA9685 keeps running (the usual case):
      the firmware reads each servo's current position back from the
      PCA9685 and carries on. Nothing is reset, so the arm does not move.
    - Full power loss: the arm returns to the LAST SAVED position
      (saved automatically after every move settles), not to 90.
    - Very first start ever: soft start to START_ANGLE (90).

  COMMAND SOURCES (both work at the same time)
    - USB from the laptop/tablet (Serial, 9600 baud)
    - ESP32 Wi-Fi bridge, 9600 baud. Required wiring (no resistors needed):
              ESP32 GPIO17 (TX2) -> Uno D2
              ESP32 GND          -> Uno GND
      Optional reply line (needs a 5V -> 3.3V divider):
              Uno D11 -> 1k -> ESP32 GPIO16 (RX2), and GPIO16 -> 2k -> GND
    Replies (ARM READY, pos, ...) are sent to both.

  PROTOCOL (one command per line)
    <joint> <angle>   joint 1-4, angle 0-180     e.g.  "2 45"
    stop | home | pos | help
    trim | trim <joint> <deg> | trim reset      (zero-offset calibration)
*/

#include <Wire.h>
#include <EEPROM.h>
#include <SoftwareSerial.h>

// ESP32 Wi-Fi bridge link: RX = D2 (from ESP32 TX2), TX = D11 (optional reply line)
SoftwareSerial espSerial(2, 11);

// Everything the Arduino prints goes to USB and to the ESP32
class DualOut : public Print {
public:
  size_t write(uint8_t c) override {
    Serial.write(c);
    espSerial.write(c);
    return 1;
  }
};
DualOut OUT;

// ============================ SETTINGS ============================

const uint8_t NUM_JOINTS = 4;
const char* const NAMES[NUM_JOINTS] = {"Base", "Shoulder", "Elbow", "Gripper"};

const uint8_t CHANNEL[NUM_JOINTS] = {0, 1, 2, 3};   // PCA9685 channels

const int PULSE_MIN = 100;   // ticks at 0 deg
const int PULSE_MAX = 510;   // ticks at 180 deg

const int LIMIT_MIN[NUM_JOINTS] = {0,   0,   0,   40};
const int LIMIT_MAX[NUM_JOINTS] = {180, 180, 180, 140};

const bool REVERSED[NUM_JOINTS] = {false, true, false, false};

const float MAX_SPEED[NUM_JOINTS] = {90.0, 60.0, 70.0, 150.0};   // deg/s
const float ACCEL[NUM_JOINTS]     = {240.0, 160.0, 200.0, 500.0}; // deg/s^2

const int START_ANGLE = 90;     // only used on the very first start
const int HOME_ANGLE  = 90;

const unsigned long SAVE_AFTER_STILL_MS = 1500;  // save position once settled
const unsigned long MOTION_PERIOD_MS = 10;
const bool ECHO = false;

// ======================== PCA9685 (direct) ========================

const uint8_t PCA_ADDR   = 0x40;
const uint8_t REG_MODE1  = 0x00;
const uint8_t REG_MODE2  = 0x01;
const uint8_t REG_LED0   = 0x06;
const uint8_t REG_PRESCALE = 0xFE;
const uint8_t PRESCALE_50HZ = 131;   // same 50 Hz setting as firmware v2

bool pcaWrite8(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(PCA_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool pcaRead(uint8_t reg, uint8_t* buf, uint8_t n) {
  Wire.beginTransmission(PCA_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom(PCA_ADDR, n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

void pcaSetPWM(uint8_t ch, uint16_t on, uint16_t off) {
  Wire.beginTransmission(PCA_ADDR);
  Wire.write(REG_LED0 + 4 * ch);
  Wire.write(on & 0xFF);
  Wire.write(on >> 8);
  Wire.write(off & 0xFF);
  Wire.write(off >> 8);
  Wire.endTransmission();
}

// Full (cold) start of the PCA9685 at 50 Hz. All outputs off until written.
void pcaColdInit() {
  pcaWrite8(REG_MODE1, 0x10);            // sleep (needed to set prescale)
  pcaWrite8(REG_PRESCALE, PRESCALE_50HZ);
  pcaWrite8(REG_MODE2, 0x04);            // totem-pole outputs
  pcaWrite8(REG_MODE1, 0x20);            // wake, auto-increment
  delay(5);
  pcaWrite8(REG_MODE1, 0xA0);            // restart + auto-increment
}

// True if the PCA9685 is already awake and running at our 50 Hz setting,
// i.e. only the Arduino restarted and the servos are still being held.
bool pcaIsRunning() {
  uint8_t mode1, pre;
  if (!pcaRead(REG_MODE1, &mode1, 1)) return false;
  if (!pcaRead(REG_PRESCALE, &pre, 1)) return false;
  return !(mode1 & 0x10) && pre == PRESCALE_50HZ;
}

// Reads a channel's current pulse (OFF value). Returns -1 if not usable.
int pcaReadTick(uint8_t ch) {
  uint8_t b[4];
  if (!pcaRead(REG_LED0 + 4 * ch, b, 4)) return -1;
  if (b[3] & 0x10) return -1;                  // channel fully off
  int on  = b[0] | ((b[1] & 0x0F) << 8);
  int off = b[2] | ((b[3] & 0x0F) << 8);
  if (on != 0) return -1;
  if (off < PULSE_MIN - 5 || off > PULSE_MAX + 5) return -1;
  return off;
}

// ==================================================================

float pos[NUM_JOINTS], vel[NUM_JOINTS], target[NUM_JOINTS];
int   lastTick[NUM_JOINTS];
int8_t trim[NUM_JOINTS];

// One line buffer per input, so USB and Wi-Fi commands never mix
struct LineReader {
  char buf[24];
  uint8_t len;
  bool overflow;
};
LineReader usbIn = {{0}, 0, false};
LineReader espIn = {{0}, 0, false};
unsigned long lastMotion = 0;
unsigned long stillSince = 0;
uint8_t savedAngle[NUM_JOINTS];
bool haveSaved = false;

// ---------- trims (EEPROM bytes 0-4, same layout as v2.1) ----------

const int TRIM_LIMIT = 30;
const uint8_t TRIM_MAGIC = 0xA7;

void loadTrims() {
  bool valid = (EEPROM.read(0) == TRIM_MAGIC);
  for (uint8_t j = 0; j < NUM_JOINTS; j++) {
    int8_t t = valid ? (int8_t)EEPROM.read(1 + j) : 0;
    if (t < -TRIM_LIMIT || t > TRIM_LIMIT) t = 0;
    trim[j] = t;
  }
}

void saveTrims() {
  EEPROM.update(0, TRIM_MAGIC);
  for (uint8_t j = 0; j < NUM_JOINTS; j++) EEPROM.update(1 + j, (uint8_t)trim[j]);
}

void printTrims() {
  OUT.print(F("Trims (deg): "));
  for (uint8_t j = 0; j < NUM_JOINTS; j++) {
    OUT.print(NAMES[j]);
    OUT.print('=');
    OUT.print((int)trim[j]);
    OUT.print(j < NUM_JOINTS - 1 ? F("  ") : F("\n"));
  }
}

// ---------- saved position (EEPROM, 16 rotating slots) ----------
// Slot: [seq, a0, a1, a2, a3, check]. Rotating spreads wear (~1.6M saves).

const int SLOT_BASE = 16;
const uint8_t SLOT_COUNT = 16;
const uint8_t SLOT_SIZE = 6;
int8_t lastSlot = -1;
uint8_t lastSeq = 0;

uint8_t slotCheck(uint8_t seq, const uint8_t* a) {
  return (uint8_t)((seq + a[0] + a[1] + a[2] + a[3]) ^ 0x5A);
}

bool loadSavedPosition(uint8_t* out) {
  int8_t best = -1;
  uint8_t bestSeq = 0;
  for (uint8_t s = 0; s < SLOT_COUNT; s++) {
    int addr = SLOT_BASE + s * SLOT_SIZE;
    uint8_t seq = EEPROM.read(addr);
    uint8_t a[4];
    bool ok = true;
    for (uint8_t j = 0; j < 4; j++) { a[j] = EEPROM.read(addr + 1 + j); if (a[j] > 180) ok = false; }
    if (!ok || EEPROM.read(addr + 5) != slotCheck(seq, a)) continue;
    if (best < 0 || (int8_t)(seq - bestSeq) > 0) {
      best = s; bestSeq = seq;
      for (uint8_t j = 0; j < 4; j++) out[j] = a[j];
    }
  }
  if (best < 0) return false;
  lastSlot = best; lastSeq = bestSeq;
  return true;
}

void savePosition() {
  uint8_t a[4];
  for (uint8_t j = 0; j < NUM_JOINTS; j++) a[j] = (uint8_t)(pos[j] + 0.5);
  if (haveSaved && memcmp(a, savedAngle, 4) == 0) return;   // nothing new
  uint8_t slot = (lastSlot + 1) % SLOT_COUNT;
  uint8_t seq = lastSeq + 1;
  int addr = SLOT_BASE + slot * SLOT_SIZE;
  EEPROM.update(addr + 5, 0xFF);        // invalidate first (safe if power dies mid-write)
  for (uint8_t j = 0; j < 4; j++) EEPROM.update(addr + 1 + j, a[j]);
  EEPROM.update(addr, seq);
  EEPROM.update(addr + 5, slotCheck(seq, a));
  lastSlot = slot; lastSeq = seq;
  memcpy(savedAngle, a, 4);
  haveSaved = true;
}

// ---------- angle <-> pulse ----------

int angleToTick(uint8_t j, float angle) {
  if (REVERSED[j]) angle = 180.0 - angle;
  angle += trim[j];
  if (angle < 0) angle = 0;
  if (angle > 180) angle = 180;
  return (int)(PULSE_MIN + (angle / 180.0) * (PULSE_MAX - PULSE_MIN) + 0.5);
}

float tickToAngle(uint8_t j, int tick) {
  float a = (tick - PULSE_MIN) * 180.0 / (PULSE_MAX - PULSE_MIN);
  a -= trim[j];
  if (REVERSED[j]) a = 180.0 - a;
  return a;
}

float clampAngle(uint8_t j, float a) {
  if (a < LIMIT_MIN[j]) a = LIMIT_MIN[j];
  if (a > LIMIT_MAX[j]) a = LIMIT_MAX[j];
  return a;
}

void writeJoint(uint8_t j, bool force) {
  int tick = angleToTick(j, pos[j]);
  if (force || tick != lastTick[j]) {
    pcaSetPWM(CHANNEL[j], 0, tick);
    lastTick[j] = tick;
  }
}

// ---------- motion ----------

void updateMotion() {
  unsigned long now = millis();
  if (now - lastMotion < MOTION_PERIOD_MS) return;
  float dt = (now - lastMotion) / 1000.0;
  if (dt > 0.05) dt = 0.05;
  lastMotion = now;

  bool moving = false;
  for (uint8_t j = 0; j < NUM_JOINTS; j++) {
    float dist = target[j] - pos[j];
    if (fabs(dist) < 0.05 && fabs(vel[j]) < 1.0) {
      pos[j] = target[j]; vel[j] = 0;
      writeJoint(j, false);
      continue;
    }
    moving = true;
    float dir = (dist > 0) ? 1.0 : -1.0;
    float stopSpeed = sqrt(2.0 * ACCEL[j] * fabs(dist));
    float wanted = dir * min(MAX_SPEED[j], stopSpeed);
    float dv = wanted - vel[j];
    float maxDv = ACCEL[j] * dt;
    if (dv >  maxDv) dv =  maxDv;
    if (dv < -maxDv) dv = -maxDv;
    vel[j] += dv;
    float step = vel[j] * dt;
    if ((dist > 0 && step > dist) || (dist < 0 && step < dist)) { pos[j] = target[j]; vel[j] = 0; }
    else pos[j] += step;
    writeJoint(j, false);
  }

  // Save the position once the arm has been still for a moment
  if (moving) stillSince = now;
  else if (now - stillSince >= SAVE_AFTER_STILL_MS) savePosition();
}

// ---------- commands ----------

void printHelp() {
  OUT.println(F("Commands: <joint 1-4> <angle 0-180> | stop | home | pos | trim | trim <joint> <deg> | trim reset | help"));
}

void printPos() {
  for (uint8_t j = 0; j < NUM_JOINTS; j++) {
    OUT.print(j + 1); OUT.print(' '); OUT.print(NAMES[j]);
    OUT.print(F(": ")); OUT.print(pos[j], 1);
    OUT.print(F(" -> ")); OUT.println(target[j], 1);
  }
  printTrims();
}

void handleLine(char* s) {
  while (*s == ' ' || *s == '\t') s++;
  if (*s == '\0') return;

  if (strcasecmp(s, "stop") == 0) {
    for (uint8_t j = 0; j < NUM_JOINTS; j++) { target[j] = pos[j]; vel[j] = 0; }
    OUT.println(F("STOPPED"));
    return;
  }
  if (strcasecmp(s, "home") == 0) {
    for (uint8_t j = 0; j < NUM_JOINTS; j++) target[j] = clampAngle(j, HOME_ANGLE);
    OUT.println(F("HOMING"));
    return;
  }
  if (strcasecmp(s, "pos") == 0)  { printPos();  return; }
  if (strcasecmp(s, "help") == 0) { printHelp(); return; }

  if (strncasecmp(s, "trim", 4) == 0) {
    char* a = s + 4;
    while (*a == ' ') a++;
    if (*a == '\0') { printTrims(); return; }
    if (strcasecmp(a, "reset") == 0) {
      for (uint8_t j = 0; j < NUM_JOINTS; j++) { trim[j] = 0; writeJoint(j, true); }
      saveTrims();
      OUT.println(F("Trims reset to 0 (saved)"));
      return;
    }
    char* e1; long tj = strtol(a, &e1, 10);
    char* e2; long td = strtol(e1, &e2, 10);
    if (e1 == a || e2 == e1 || tj < 1 || tj > NUM_JOINTS) {
      OUT.println(F("ERR use: trim <joint 1-4> <deg -30..30>"));
      return;
    }
    if (td < -TRIM_LIMIT) td = -TRIM_LIMIT;
    if (td >  TRIM_LIMIT) td =  TRIM_LIMIT;
    trim[tj - 1] = (int8_t)td;
    writeJoint(tj - 1, true);
    saveTrims();
    OUT.print(NAMES[tj - 1]); OUT.print(F(" trim = "));
    OUT.print(td); OUT.println(F(" deg (saved)"));
    return;
  }

  char* end;
  long joint = strtol(s, &end, 10);
  if (end == s) { if (ECHO) OUT.println(F("ERR format")); return; }
  char* s2 = end;
  long angle = strtol(s2, &end, 10);
  if (end == s2) { if (ECHO) OUT.println(F("ERR format")); return; }
  if (joint < 1 || joint > NUM_JOINTS) { if (ECHO) OUT.println(F("ERR joint")); return; }
  if (angle < 0) angle = 0;
  if (angle > 180) angle = 180;
  uint8_t j = joint - 1;
  target[j] = clampAngle(j, angle);
  if (ECHO) { OUT.print(F("OK ")); OUT.print(joint); OUT.print(' '); OUT.println((int)target[j]); }
}

void feedChar(LineReader& r, char c) {
  if (c == '\n' || c == '\r') {
    if (!r.overflow) { r.buf[r.len] = '\0'; handleLine(r.buf); }
    r.len = 0; r.overflow = false;
  } else if (r.len < sizeof(r.buf) - 1) {
    r.buf[r.len++] = c;
  } else {
    r.overflow = true;
  }
}

void readInputs() {
  while (Serial.available() > 0)    feedChar(usbIn, Serial.read());
  while (espSerial.available() > 0) feedChar(espIn, espSerial.read());
}

// ---------- setup / loop ----------

void setup() {
  Serial.begin(9600);
  espSerial.begin(9600);
  Wire.begin();
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(3000, true);
#endif
  loadTrims();

  uint8_t saved[NUM_JOINTS];
  bool hasSaved = loadSavedPosition(saved);
  if (hasSaved) { memcpy(savedAngle, saved, 4); haveSaved = true; }

  const __FlashStringHelper* startMode;
  bool warm = pcaIsRunning();

  if (warm) {
    // Only the Arduino restarted: read where each servo is and keep it there.
    for (uint8_t j = 0; j < NUM_JOINTS; j++) {
      int tick = pcaReadTick(CHANNEL[j]);
      float a;
      if (tick >= 0) a = tickToAngle(j, tick);
      else a = hasSaved ? saved[j] : START_ANGLE;
      pos[j] = target[j] = clampAngle(j, a);
      vel[j] = 0;
      lastTick[j] = (tick >= 0) ? tick : -1;
      if (tick < 0) writeJoint(j, true);
    }
    startMode = F("resumed (no movement)");
  } else {
    // Power was off: start the PCA9685 and go to the last saved position.
    pcaColdInit();
    for (uint8_t j = 0; j < NUM_JOINTS; j++) {
      pos[j] = target[j] = clampAngle(j, hasSaved ? saved[j] : START_ANGLE);
      vel[j] = 0;
      writeJoint(j, true);
      delay(150);                        // one joint at a time
    }
    startMode = hasSaved ? F("last saved position") : F("start position 90");
  }

  lastMotion = millis();
  stillSince = millis();
  OUT.print(F("Start: "));
  OUT.println(startMode);
  OUT.println(F("ARM READY v3.1"));
  printTrims();
  printHelp();
}

void loop() {
  readInputs();
  updateMotion();
}

/*
  HARDWARE CHECKLIST (prevents the restarts in the first place):
  1. 1000uF 10V+ capacitor across PCA9685 V+ and GND (long leg = V+).
  2. Adapter wires tight in the V+/GND screw terminal; + to V+.
  3. Arduino powered by USB only; adapter NOT connected to Arduino 5V.
  4. Short wires Arduino<->PCA9685, away from servo cables.
  5. Windows: disable USB power saving; laptop on its charger.
*/
