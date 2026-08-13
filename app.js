import * as THREE from "https://unpkg.com/three@0.179.1/build/three.module.js";

// ======================================================
// HTML ELEMENTS
// ======================================================

const viewer = document.getElementById("viewer");
const xyzPanel = document.getElementById("xyz");

if (!viewer) {
    throw new Error("The #viewer element was not found.");
}

// ======================================================
// SCENE
// ======================================================

const scene = new THREE.Scene();

scene.background = new THREE.Color(0x10231f);

// Soft green background glow
const backgroundGlow = new THREE.Mesh(
    new THREE.CircleGeometry(11, 64),
    new THREE.MeshBasicMaterial({
        color: 0x087b5a,
        transparent: true,
        opacity: 0.24
    })
);

backgroundGlow.position.set(0, 6, -8);
scene.add(backgroundGlow);

// ======================================================
// CAMERA
// ======================================================

const camera = new THREE.PerspectiveCamera(
    45,
    viewer.clientWidth / Math.max(viewer.clientHeight, 1),
    0.1,
    1000
);

let cameraYaw = 0.72;
let cameraPitch = 0.35;
let cameraDistance = 24;

const cameraFocus = new THREE.Vector3(0, 4.8, 0);

function updateResponsiveCameraDistance() {

    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;

    const isLandscape =
        screenWidth > screenHeight;

    const isPhone =
        isLandscape &&
        screenHeight <= 550;

    const isTablet =
        isLandscape &&
        screenWidth <= 1200 &&
        screenHeight > 550;

    if (isPhone) {

        // Pull farther back on phones
        // so base + full arm + gripper are visible.
        cameraDistance = 29;

    } else if (isTablet) {

        // Tablet landscape
        cameraDistance = 26;

    } else {

        // Laptop / desktop
        cameraDistance = 23;
    }

    updateCamera();
}
// ======================================================
// RENDERER
// ======================================================

const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true
});

renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, 2)
);

renderer.setSize(
    viewer.clientWidth,
    viewer.clientHeight
);

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

renderer.outputColorSpace = THREE.SRGBColorSpace;

renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

viewer.appendChild(renderer.domElement);

// ======================================================
// LIGHTS
// ======================================================

const hemisphereLight = new THREE.HemisphereLight(
    0xffffff,
    0x172724,
    1.8
);

scene.add(hemisphereLight);

const keyLight = new THREE.DirectionalLight(
    0xffffff,
    3.2
);

keyLight.position.set(8, 15, 10);
keyLight.castShadow = true;

keyLight.shadow.mapSize.set(2048, 2048);

scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(
    0x8fc4ff,
    1.4
);

fillLight.position.set(-9, 8, 5);

scene.add(fillLight);

const greenLight = new THREE.PointLight(
    0x00b978,
    9,
    24
);

greenLight.position.set(0, 5, -4);

scene.add(greenLight);

const rimLight = new THREE.DirectionalLight(
    0xffc987,
    1
);

rimLight.position.set(4, 8, -10);

scene.add(rimLight);

// ======================================================
// FLOOR
// ======================================================

const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(45, 45),
    new THREE.MeshStandardMaterial({
        color: 0x1c2522,
        roughness: 0.88,
        metalness: 0.08
    })
);

floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;

scene.add(floor);

const grid = new THREE.GridHelper(
    45,
    45,
    0x385a50,
    0x263d37
);

grid.position.y = 0.003;

scene.add(grid);

// ======================================================
// MATERIALS
// ======================================================

const whiteMaterial = new THREE.MeshStandardMaterial({
    color: 0xe9e7de,
    metalness: 0.35,
    roughness: 0.32
});

const blueMaterial = new THREE.MeshStandardMaterial({
    color: 0x172a58,
    metalness: 0.58,
    roughness: 0.28
});

const blueLightMaterial = new THREE.MeshStandardMaterial({
    color: 0x26457e,
    metalness: 0.52,
    roughness: 0.3
});

const blackMaterial = new THREE.MeshStandardMaterial({
    color: 0x101116,
    metalness: 0.65,
    roughness: 0.27
});

const metalMaterial = new THREE.MeshStandardMaterial({
    color: 0x8f949b,
    metalness: 0.85,
    roughness: 0.2
});

const orangeMaterial = new THREE.MeshStandardMaterial({
    color: 0xe87522,
    metalness: 0.38,
    roughness: 0.34
});

const rubberMaterial = new THREE.MeshStandardMaterial({
    color: 0x252525,
    roughness: 0.86
});

// ======================================================
// HELPERS
// ======================================================

function roundedBox(
    width,
    height,
    depth,
    radius,
    material
) {
    const shape = new THREE.Shape();

    const x = -width / 2;
    const y = -height / 2;

    shape.moveTo(x + radius, y);
    shape.lineTo(x + width - radius, y);

    shape.quadraticCurveTo(
        x + width,
        y,
        x + width,
        y + radius
    );

    shape.lineTo(
        x + width,
        y + height - radius
    );

    shape.quadraticCurveTo(
        x + width,
        y + height,
        x + width - radius,
        y + height
    );

    shape.lineTo(
        x + radius,
        y + height
    );

    shape.quadraticCurveTo(
        x,
        y + height,
        x,
        y + height - radius
    );

    shape.lineTo(x, y + radius);

    shape.quadraticCurveTo(
        x,
        y,
        x + radius,
        y
    );

    const geometry = new THREE.ExtrudeGeometry(
        shape,
        {
            depth,
            bevelEnabled: true,
            bevelSegments: 3,
            steps: 1,
            bevelSize: radius * 0.3,
            bevelThickness: radius * 0.3
        }
    );

    geometry.center();

    return new THREE.Mesh(
        geometry,
        material
    );
}

function cylinder(
    radius,
    height,
    material,
    segments = 48
) {
    return new THREE.Mesh(
        new THREE.CylinderGeometry(
            radius,
            radius,
            height,
            segments
        ),
        material
    );
}

function enableShadows(object) {
    object.traverse(child => {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });
}

function addMotorDisc(
    parent,
    position,
    radius,
    rotationAxis = "z"
) {
    const outerDisc = cylinder(
        radius,
        0.2,
        blueMaterial,
        48
    );

    const innerDisc = cylinder(
        radius * 0.63,
        0.23,
        blackMaterial,
        48
    );

    const centerDisc = cylinder(
        radius * 0.25,
        0.25,
        metalMaterial,
        40
    );

    if (rotationAxis === "z") {
        outerDisc.rotation.z = Math.PI / 2;
        innerDisc.rotation.z = Math.PI / 2;
        centerDisc.rotation.z = Math.PI / 2;
    }

    outerDisc.position.copy(position);
    innerDisc.position.copy(position);
    centerDisc.position.copy(position);

    outerDisc.position.x += 0.03;
    innerDisc.position.x += 0.14;
    centerDisc.position.x += 0.27;

    parent.add(
        outerDisc,
        innerDisc,
        centerDisc
    );
}

// ======================================================
// ROBOT ROOT
// ======================================================

const robot = new THREE.Group();

robot.rotation.y = -0.18;

scene.add(robot);

// ======================================================
// BASE FEET
// ======================================================

const footPositions = [
    [1.75, 0, 0],
    [-1.75, 0, 0],
    [0, 0, 1.75],
    [0, 0, -1.75]
];

for (const [x, y, z] of footPositions) {
    const foot = roundedBox(
        2.1,
        0.28,
        0.68,
        0.15,
        whiteMaterial
    );

    foot.position.set(x, 0.16, z);

    if (z !== 0) {
        foot.rotation.y = Math.PI / 2;
    }

    robot.add(foot);

    const footTip = roundedBox(
        0.7,
        0.18,
        0.74,
        0.1,
        blueMaterial
    );

    footTip.position.copy(foot.position);

    if (x > 0) footTip.position.x += 0.8;
    if (x < 0) footTip.position.x -= 0.8;
    if (z > 0) footTip.position.z += 0.8;
    if (z < 0) footTip.position.z -= 0.8;

    if (z !== 0) {
        footTip.rotation.y = Math.PI / 2;
    }

    robot.add(footTip);
}

// ======================================================
// BASE PEDESTAL
// ======================================================

const bottomBase = new THREE.Mesh(
    new THREE.CylinderGeometry(
        1.65,
        1.85,
        0.45,
        64
    ),
    blueMaterial
);

bottomBase.position.y = 0.35;

robot.add(bottomBase);

const whiteBase = new THREE.Mesh(
    new THREE.CylinderGeometry(
        1.5,
        1.65,
        1.25,
        64
    ),
    whiteMaterial
);

whiteBase.position.y = 1.15;

robot.add(whiteBase);

const topBaseRing = new THREE.Mesh(
    new THREE.TorusGeometry(
        1.22,
        0.14,
        20,
        64
    ),
    blueMaterial
);

topBaseRing.rotation.x = Math.PI / 2;
topBaseRing.position.y = 1.81;

robot.add(topBaseRing);

// ======================================================
// JOINT 1 — BASE ROTATION
// ======================================================

const joint1 = new THREE.Group();

joint1.position.y = 1.78;

robot.add(joint1);

const baseNeck = roundedBox(
    1.35,
    1.85,
    1.45,
    0.28,
    blueMaterial
);

baseNeck.position.y = 1;

joint1.add(baseNeck);

const baseSidePanel = roundedBox(
    1.42,
    1.15,
    1.51,
    0.23,
    blueLightMaterial
);

baseSidePanel.position.y = 1.15;

joint1.add(baseSidePanel);

// ======================================================
// JOINT 2 — SHOULDER
// ======================================================

const joint2 = new THREE.Group();

joint2.position.set(
    0,
    1.88,
    0
);

joint1.add(joint2);

const shoulderMotor = cylinder(
    0.92,
    1.75,
    blueMaterial,
    56
);

shoulderMotor.rotation.z = Math.PI / 2;

joint2.add(shoulderMotor);

addMotorDisc(
    joint2,
    new THREE.Vector3(0.82, 0, 0),
    0.72
);

// Upper link
const upperArmGroup = new THREE.Group();

joint2.add(upperArmGroup);

const upperWhiteLink = roundedBox(
    1.05,
    3.7,
    0.95,
    0.2,
    whiteMaterial
);

upperWhiteLink.position.y = 1.95;
upperWhiteLink.rotation.z = -0.12;

upperArmGroup.add(upperWhiteLink);

const upperBlueSide = roundedBox(
    0.42,
    3,
    1.02,
    0.14,
    blueMaterial
);

upperBlueSide.position.set(
    -0.33,
    1.95,
    0
);

upperBlueSide.rotation.z = -0.12;

upperArmGroup.add(upperBlueSide);

// Decorative cutout
const upperInset = roundedBox(
    0.22,
    1.7,
    1.06,
    0.08,
    orangeMaterial
);

upperInset.position.set(
    0.34,
    2.05,
    0
);

upperInset.rotation.z = -0.12;

upperArmGroup.add(upperInset);

// ======================================================
// JOINT 3 — ELBOW
// ======================================================

const joint3 = new THREE.Group();

joint3.position.set(
    -0.48,
    3.86,
    0
);

joint2.add(joint3);

const elbowHousing = cylinder(
    0.83,
    1.6,
    blueMaterial,
    56
);

elbowHousing.rotation.z = Math.PI / 2;

joint3.add(elbowHousing);

addMotorDisc(
    joint3,
    new THREE.Vector3(0.74, 0, 0),
    0.63
);

// Forearm
const forearmWhite = roundedBox(
    0.94,
    3.05,
    0.85,
    0.18,
    whiteMaterial
);

forearmWhite.position.y = 1.65;
forearmWhite.rotation.z = 0.18;

joint3.add(forearmWhite);

const forearmBlue = roundedBox(
    0.36,
    2.55,
    0.92,
    0.12,
    blueMaterial
);

forearmBlue.position.set(
    0.31,
    1.66,
    0
);

forearmBlue.rotation.z = 0.18;

joint3.add(forearmBlue);

// ======================================================
// JOINT 4 — WRIST PITCH
// ======================================================

const joint4 = new THREE.Group();

joint4.position.set(
    0.58,
    3.06,
    0
);

joint3.add(joint4);

const wristPitchMotor = cylinder(
    0.58,
    1.15,
    blueMaterial,
    48
);

wristPitchMotor.rotation.z = Math.PI / 2;

joint4.add(wristPitchMotor);

addMotorDisc(
    joint4,
    new THREE.Vector3(0.53, 0, 0),
    0.4
);

const wristConnector = roundedBox(
    0.62,
    1.25,
    0.67,
    0.15,
    whiteMaterial
);

wristConnector.position.y = 0.75;

joint4.add(wristConnector);

// ======================================================
// JOINT 5 — WRIST ROTATION
// ======================================================

const joint5 = new THREE.Group();

joint5.position.y = 1.42;

joint4.add(joint5);

const wristRotateMotor = cylinder(
    0.47,
    0.82,
    blueMaterial,
    48
);

joint5.add(wristRotateMotor);

const wristRing = new THREE.Mesh(
    new THREE.TorusGeometry(
        0.39,
        0.08,
        16,
        40
    ),
    metalMaterial
);

wristRing.rotation.x = Math.PI / 2;
wristRing.position.y = 0.42;

joint5.add(wristRing);

// ======================================================
// JOINT 6 — GRIPPER
// ======================================================

const joint6 = new THREE.Group();

joint6.position.y = 0.58;

joint5.add(joint6);

const gripperMount = roundedBox(
    1.05,
    0.38,
    0.58,
    0.1,
    blueMaterial
);

gripperMount.position.y = 0.25;

joint6.add(gripperMount);

const gripperCenter = roundedBox(
    0.65,
    0.62,
    0.52,
    0.11,
    blackMaterial
);

gripperCenter.position.y = 0.62;

joint6.add(gripperCenter);

// Left jaw
const leftJawGroup = new THREE.Group();

leftJawGroup.position.set(
    -0.42,
    0.62,
    0
);

joint6.add(leftJawGroup);

const leftJaw = roundedBox(
    0.3,
    1.25,
    0.36,
    0.08,
    whiteMaterial
);

leftJaw.position.y = 0.65;

leftJawGroup.add(leftJaw);

const leftJawPad = roundedBox(
    0.18,
    0.42,
    0.43,
    0.05,
    rubberMaterial
);

leftJawPad.position.set(
    0.08,
    1.18,
    0
);

leftJawGroup.add(leftJawPad);

// Right jaw
const rightJawGroup = new THREE.Group();

rightJawGroup.position.set(
    0.42,
    0.62,
    0
);

joint6.add(rightJawGroup);

const rightJaw = roundedBox(
    0.3,
    1.25,
    0.36,
    0.08,
    whiteMaterial
);

rightJaw.position.y = 0.65;

rightJawGroup.add(rightJaw);

const rightJawPad = roundedBox(
    0.18,
    0.42,
    0.43,
    0.05,
    rubberMaterial
);

rightJawPad.position.set(
    -0.08,
    1.18,
    0
);

rightJawGroup.add(rightJawPad);

enableShadows(robot);

// ======================================================
// JOINT CONTROL STATE
// ======================================================

window.robotAngles = [
    0,
    0,
    0,
    0,
    0,
    0
];

window.robotTargets = {
    base: 0,
    shoulder: -0.55,
    elbow: 1.05,
    wristPitch: -0.45,
    wristRotation: 0,
    gripperGap: 0.42
};

window.emergencyStopped = false;

// ======================================================
// SERVO → VIRTUAL ROBOT MAPPING
// ======================================================

window.setRobotJoint = function (
    jointIndex,
    degrees
) {
    if (
        !Number.isInteger(jointIndex) ||
        jointIndex < 0 ||
        jointIndex > 5
    ) {
        return;
    }

    const value = THREE.MathUtils.clamp(
        Number(degrees),
        -90,
        90
    );

    window.robotAngles[jointIndex] = value;
    const angle = THREE.MathUtils.degToRad(value);

    switch (jointIndex) {
        case 0:
            window.robotTargets.base = angle;
            break;
        case 1:
            window.robotTargets.shoulder =
                THREE.MathUtils.clamp(
                    -angle - 0.55,
                    -1.55,
                    0.65
                );
            break;
        case 2:
            window.robotTargets.elbow =
                THREE.MathUtils.clamp(
                    angle + 1.05,
                    -0.25,
                    2.15
                );
            break;
        case 3:
            window.robotTargets.wristPitch =
                THREE.MathUtils.clamp(
                    -angle - 0.45,
                    -1.65,
                    1.15
                );
            break;
        case 4:
            window.robotTargets.wristRotation = angle;
            break;
        case 5:
            window.robotTargets.gripperGap =
                THREE.MathUtils.mapLinear(
                    value,
                    -90,
                    90,
                    0.18,
                    0.62
                );
            break;
    }
};

// ======================================================
// CAMERA CONTROLS
// ======================================================

function updateCamera() {
    cameraPitch = THREE.MathUtils.clamp(
        cameraPitch,
        -0.05,
        1.15
    );

    cameraDistance = THREE.MathUtils.clamp(
        cameraDistance,
        12,
        32
    );

    camera.position.set(
        Math.sin(cameraYaw) *
            Math.cos(cameraPitch) *
            cameraDistance,

        Math.sin(cameraPitch) *
            cameraDistance +
            1.8,

        Math.cos(cameraYaw) *
            Math.cos(cameraPitch) *
            cameraDistance
    );

    camera.lookAt(cameraFocus);
}

let dragging = false;
let previousPointerX = 0;
let previousPointerY = 0;

viewer.addEventListener(
    "pointerdown",
    event => {
        dragging = true;

        previousPointerX = event.clientX;
        previousPointerY = event.clientY;

        viewer.setPointerCapture(
            event.pointerId
        );
    }
);

viewer.addEventListener(
    "pointermove",
    event => {
        if (!dragging) return;

        const deltaX =
            event.clientX -
            previousPointerX;

        const deltaY =
            event.clientY -
            previousPointerY;

        previousPointerX =
            event.clientX;

        previousPointerY =
            event.clientY;

        cameraYaw -= deltaX * 0.006;
        cameraPitch -= deltaY * 0.006;

        updateCamera();
    }
);

viewer.addEventListener(
    "pointerup",
    () => {
        dragging = false;
    }
);

viewer.addEventListener(
    "pointercancel",
    () => {
        dragging = false;
    }
);

viewer.addEventListener(
    "wheel",
    event => {
        event.preventDefault();

        cameraDistance +=
            event.deltaY * 0.012;

        updateCamera();
    },
    {
        passive: false
    }
);

updateResponsiveCameraDistance();

// ======================================================
// ANIMATION
// ======================================================

const endEffectorPosition =
    new THREE.Vector3();

const smoothing = 0.085;

function smoothValue(
    current,
    target,
    speed
) {
    return current +
        (target - current) *
        speed;
}

function animate() {
    requestAnimationFrame(animate);

    if (!window.emergencyStopped) {
        joint1.rotation.y = smoothValue(
            joint1.rotation.y,
            window.robotTargets.base,
            smoothing
        );

        joint2.rotation.z = smoothValue(
            joint2.rotation.z,
            window.robotTargets.shoulder,
            smoothing
        );

        joint3.rotation.z = smoothValue(
            joint3.rotation.z,
            window.robotTargets.elbow,
            smoothing
        );

        joint4.rotation.z = smoothValue(
            joint4.rotation.z,
            window.robotTargets.wristPitch,
            smoothing
        );

        joint5.rotation.y = smoothValue(
            joint5.rotation.y,
            window.robotTargets.wristRotation,
            smoothing
        );

        leftJawGroup.position.x =
            smoothValue(
                leftJawGroup.position.x,
                -window.robotTargets.gripperGap,
                smoothing
            );

        rightJawGroup.position.x =
            smoothValue(
                rightJawGroup.position.x,
                window.robotTargets.gripperGap,
                smoothing
            );
    }

    joint6.getWorldPosition(
        endEffectorPosition
    );

    if (xyzPanel) {
        xyzPanel.innerHTML = `
            X: ${endEffectorPosition.x.toFixed(2)}<br>
            Y: ${endEffectorPosition.y.toFixed(2)}<br>
            Z: ${endEffectorPosition.z.toFixed(2)}
        `;
    }

    renderer.render(
        scene,
        camera
    );
}

animate();

// ======================================================
// RESIZE
// ======================================================

// ======================================================
// RESPONSIVE RESIZE
// ======================================================

window.addEventListener(
    "resize",
    () => {

        const width = viewer.clientWidth;

        const height = Math.max(
            viewer.clientHeight,
            1
        );

        camera.aspect = width / height;

        camera.updateProjectionMatrix();

        renderer.setSize(
            width,
            height
        );

        updateResponsiveCameraDistance();
    }
);
    