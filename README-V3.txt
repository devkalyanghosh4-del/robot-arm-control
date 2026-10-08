ROBOT CREATOR V3 — COMPLETE SOFTWARE PLATFORM
Build: 2026-08-13
Cache version: v=30

FILES TO REPLACE
- index.html
- app.js
- serial.js
- ui.js

MAJOR FEATURES
1. Manual and Auto operator modes
2. Simulation / Hardware / Digital Twin control modes
3. Six-joint -90° to +90° coordinate system
4. Per-joint calibration:
   - enable/disable
   - Arduino command ID
   - UI min/max
   - servo min/center/max
   - reverse direction
5. Precision jog controls (1°, 5°, 10°)
6. Desktop keyboard shortcuts
7. Preset positions: HOME, READY, PICK, PLACE, REST
8. Pose undo / redo
9. Movement speed control
10. Task/sequence programmer:
    - named steps
    - per-step delay
    - per-step speed
    - reorder
    - delete
    - play individual step
    - loop count
    - progress indicator
11. Pick-and-place template
12. Demo sweep template
13. Emergency stop and reset/resume
14. Workspace/joint software limits
15. Live joint telemetry
16. Diagnostics dashboard:
    - connection state
    - transport
    - baud rate
    - health
    - command count
    - failure count
    - last command
17. Timestamped system console
18. Project configuration import/export
19. LAB / DEMO / MOBILE browser-stored profiles
20. Existing 3D Three.js visualization preserved
21. Existing save/play/import/export controls preserved
22. GitHub Pages / responsive mobile architecture preserved

IMPORTANT PHYSICAL MAPPING
Known from current tests:
- Base -> Arduino command ID 1
- Shoulder -> Arduino command ID 2
- Elbow -> Arduino command ID 4
- Wrist Yaw -> Arduino command ID 6
- Gripper -> Arduino command ID 5
- Wrist Roll -> UNKNOWN / DISABLED

Wrist Roll is intentionally blocked by default.
When its physical command ID is identified:
CONTROL CENTER -> CALIBRATION -> WRIST ROLL
1. Enable it
2. Select its Arduino ID
3. Use TEST +/-10 degrees
4. Save calibration

SAFETY
Always test physical joints with small values first.
Do not use full +/-90° travel until mechanical limits are confirmed.
The software safety limits do not replace correct servo power, wiring, or mechanical stops.

KEYBOARD SHORTCUTS
1-6 = select joint
Left/Right arrow = jog selected joint
0 = center selected joint
Space = emergency stop
H = home
Ctrl+Z = undo pose
Ctrl+Y = redo pose


UI FIX v31
- Control Center now fits laptop screens without clipping.
- Modal content scrolls internally instead of extending under the viewport.
- Tabs scroll horizontally if needed.
- Control cards change from 3 columns -> 2 columns -> 1 column depending on screen size.
- Digital Twin / Hardware / Simulation buttons no longer get cut off.
- Floating bottom buttons are hidden while the Control Center is open.
- Landscape phone layout now uses the full screen safely.
