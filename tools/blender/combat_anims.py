"""Build the hero's combat animations on the Mixamo X Bot skeleton and export them.

Run from the project folder:
  "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --python tools/blender/combat_anims.py

Output:
  assets/anims/hero_combat.glb    animations only (armature + actions), loaded by the game
  assets/anims/hero_combat.blend  the same, with the character mesh, for editing by hand in Blender
  assets/anims/hero_combat.json   per-clip timing for the game (contact frames, combo cancel frames)

Poses are written as body-relative targets (hips, chest, hands, feet, knee / elbow directions,
palm direction, fist) and turned into bone rotations by aiming each bone at its target with simple
two-bone IK for arms and legs. Every pose becomes ordinary Blender keyframes, so everything can be
polished by hand afterwards.

Body coordinates used in the poses: x = the character's right, y = up, z = forward (metres, from the
ground under the hips). Angles are degrees. Yaw > 0 turns the body to its left.
"""
import json
import math
import os
import bpy
from mathutils import Matrix, Quaternion, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'assets', 'models', 'Xbot.glb')
OUT = os.path.join(ROOT, 'assets', 'anims')
FPS = 30
P = 'mixamorig:'

# ---------------------------------------------------------------------------------------- setup
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene
scene.render.fps = FPS
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
for a in list(bpy.data.actions):  # the model's own clips (idle / walk / run) stay in Xbot.glb
    bpy.data.actions.remove(a)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and o.parent is None:  # stray helper mesh in the source file
        bpy.data.objects.remove(o)
bones = arm.data.bones
S = 1.0 / arm.scale.x  # armature space units per metre (the rig is in centimetres)


def B(x, y, z):
    """Body coordinates (right, up, forward) -> Blender armature axes (character faces -Y)."""
    return Vector((-x, -z, y))


RIGHT, UP, FWD = B(1, 0, 0), B(0, 1, 0), B(0, 0, 1)


def rest(name):
    return bones[P + name].matrix_local


def head_rest(name):
    return rest(name).to_translation()


def body_q(yaw=0.0, lean=0.0, side=0.0):
    """Rotation of the body: yaw (turn left +), lean (forward +), side (lean to its right +)."""
    return (Quaternion(UP, math.radians(yaw)) @ Quaternion(Vector((1, 0, 0)), math.radians(lean))
            @ Quaternion(FWD, math.radians(side)))


# ---------------------------------------------------------------------------------------- posing
class Pose:
    """Builds armature-space matrices for one pose, parent before child, then keys the bases."""

    def __init__(self):
        self.M = {}

    def default(self, name):
        """Matrix the bone would have with no rotation of its own (it just follows its parent)."""
        b = bones[P + name]
        if b.parent is None:
            return b.matrix_local.copy()
        pn = b.parent.name[len(P):]
        if pn not in self.M:
            self.M[pn] = self.default(pn)
        return self.M[pn] @ b.parent.matrix_local.inverted() @ b.matrix_local

    def rotate(self, name, q):
        """Bone keeps its inherited pose, rotated by q (armature axes) about its head."""
        m0 = self.default(name)
        t = m0.to_translation()
        self.M[name] = Matrix.Translation(t) @ q.to_matrix().to_4x4() @ m0.to_3x3().to_4x4()
        return self.M[name]

    def head(self, name):
        return (self.M[name] if name in self.M else self.default(name)).to_translation()

    def bone_dir(self, name, child):
        """Current direction from this bone's head to its child's head."""
        m = self.M[name] if name in self.M else self.default(name)
        v = head_rest(child) - head_rest(name)
        return (m.to_3x3() @ rest(name).to_3x3().inverted() @ v).normalized()

    def aim(self, name, child, d):
        """Point the bone (head -> child head) along direction d, smallest rotation."""
        m0 = self.default(name)
        self.M[name] = m0
        q = self.bone_dir(name, child).rotation_difference(d.normalized())
        return self.rotate(name, q)

    def two_bone(self, a, b, c, target, pole):
        """IK: upper bone a, lower bone b, end bone c reaching target; joint bends toward pole."""
        root = self.head(a)
        l1 = (head_rest(b) - head_rest(a)).length
        l2 = (head_rest(c) - head_rest(b)).length
        to = target - root
        d = min(to.length, (l1 + l2) * 0.999)
        dirn = to.normalized()
        # cosine rule for the upper bone's angle off the root->target line
        cos_a = max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))
        side = (pole - dirn * pole.dot(dirn))
        side = side.normalized() if side.length > 1e-6 else dirn.orthogonal().normalized()
        joint = root + dirn * (l1 * cos_a) + side * (l1 * math.sqrt(max(0.0, 1 - cos_a * cos_a)))
        self.aim(a, b, joint - root)
        self.aim(b, c, (root + dirn * d) - joint)

    def basis(self, name):
        b = bones[P + name]
        if b.parent is None:
            return b.matrix_local.inverted() @ self.M[name]
        pn = b.parent.name[len(P):]
        mp = self.M[pn] if pn in self.M else self.default(pn)
        return b.matrix_local.inverted() @ b.parent.matrix_local @ mp.inverted() @ self.M[name]


FINGERS = ['Index', 'Middle', 'Ring', 'Pinky']


def build(spec):
    """spec -> Pose. See the module docstring for the coordinate conventions."""
    p = Pose()
    # Hips: position offset and body rotation
    hips = spec.get('hips', {})
    qh = body_q(*hips.get('rot', (0, 0, 0)))
    off = B(*hips.get('pos', (0, 0, 0))) * S
    m = rest('Hips')
    p.M['Hips'] = Matrix.Translation(m.to_translation() + off) @ qh.to_matrix().to_4x4() @ m.to_3x3().to_4x4()
    # Chest: extra yaw / lean / side bend relative to the hips, spread over the three spine bones
    cy, cl, cs = spec.get('chest', (0, 0, 0))
    for n in ('Spine', 'Spine1', 'Spine2'):
        p.rotate(n, qh @ body_q(cy / 3, cl / 3, cs / 3) @ qh.inverted())
    # Head: keeps looking at the opponent (straight ahead in the world); yaw / pitch (+ looks down) on top
    hy, hp = spec.get('head', (0, 0))
    want = Quaternion(UP, math.radians(hy)) @ Quaternion(Vector((1, 0, 0)), math.radians(hp)) @ FWD
    p.rotate('Neck', Quaternion())
    m0 = p.default('Head')
    face = (m0.to_3x3() @ rest('Head').to_3x3().inverted() @ FWD).normalized()
    p.rotate('Head', face.rotation_difference(want))
    # Arms: wrist targets relative to the ground point under the hips, in the hero's facing frame
    # (not turned with the hips, so "forward" is where the hero is facing / punching), elbow pole,
    # palm direction, fist
    for side, sx in (('Left', -1), ('Right', 1)):
        k = side[0].lower()
        a = spec.get(k + 'hand')
        reach = spec.get(k + 'reach')  # (direction, fraction of full arm length) from the shoulder
        if reach:
            arm_len = ((head_rest(side + 'ForeArm') - head_rest(side + 'Arm')).length
                       + (head_rest(side + 'Hand') - head_rest(side + 'ForeArm')).length)
            target = p.head(side + 'Arm') + B(*reach[0]).normalized() * arm_len * reach[1]
        elif a:
            target = B(*a) * S
        if reach or a:
            pole = B(*spec.get(k + 'elbow', (sx * 0.4, -1, -0.3)))
            p.two_bone(side + 'Arm', side + 'ForeArm', side + 'Hand', target, pole)
        # hand: straight wrist, rolled so the palm faces `palm`
        p.rotate(side + 'Hand', Quaternion())
        palm_want = B(*spec.get(k + 'palm', (0, -1, 0)))
        hd = p.bone_dir(side + 'Hand', side + 'HandMiddle1')
        palm_now = palm_normal(p, side)
        pn = (palm_now - hd * palm_now.dot(hd)).normalized()
        pw = (palm_want - hd * palm_want.dot(hd))
        if pw.length > 1e-4:
            ang = pn.angle(pw.normalized())
            ax = pn.cross(pw.normalized())
            q = Quaternion(hd, ang if ax.dot(hd) >= 0 else -ang)
            p.rotate(side + 'Hand', q)
        fist(p, side, spec.get(k + 'fist', 1.0))
    # Legs: ankle targets (and foot yaw), knee pole
    for side, sx in (('Left', -1), ('Right', 1)):
        k = side[0].lower()
        f = spec.get(k + 'foot')
        if not f:
            continue
        x, y, z, fyaw = (list(f) + [0])[:4]
        target = B(x, y, z) * S
        pole = B(*spec.get(k + 'knee', (sx * 0.15, 0, 1)))
        p.two_bone(side + 'UpLeg', side + 'Leg', side + 'Foot', target, pole)
        # keep the foot flat on the ground, turned by its yaw (heel lift tilts it forward)
        toe = head_rest(side + 'ToeBase') - head_rest(side + 'Foot')
        lift = spec.get(k + 'heel', 0)
        toe = Quaternion(UP, math.radians(fyaw)) @ Quaternion(Vector((1, 0, 0)), math.radians(lift)) @ toe
        p.aim(side + 'Foot', side + 'ToeBase', toe)
    return p


def palm_normal(p, side):
    """Direction the palm faces (in the T-pose rest pose both palms face straight down)."""
    name = side + 'Hand'
    m = p.M[name] if name in p.M else p.default(name)
    return (m.to_3x3() @ rest(name).to_3x3().inverted() @ Vector((0, 0, -1))).normalized()


def fist(p, side, amount):
    """Curl the fingers (amount 0 = open hand, 1 = tight fist)."""
    pn = palm_normal(p, side)
    hand_dir = p.bone_dir(side + 'Hand', side + 'HandMiddle1')
    curl_axis = hand_dir.cross(pn).normalized()  # rotating about this swings a finger toward the palm
    for f in FINGERS:
        for j, ang in ((1, 80), (2, 100), (3, 70)):
            p.rotate(f'{side}Hand{f}{j}', Quaternion(curl_axis, math.radians(ang * amount)))
    for j, ang in ((1, 25), (2, 35), (3, 30)):
        name = f'{side}HandThumb{j}'
        child = f'{side}HandThumb{j + 1}'
        d = p.bone_dir(name, child)
        ax = d.cross(pn).normalized()
        q = Quaternion(ax, math.radians(ang * amount))
        p.rotate(name, q)


def key(pose, frame):
    for name in pose.M:
        pb = arm.pose.bones[P + name]
        mb = pose.basis(name)
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = mb.to_quaternion()
        pb.keyframe_insert('rotation_quaternion', frame=frame)
        if name == 'Hips':
            pb.location = mb.to_translation()
            pb.keyframe_insert('location', frame=frame)


def clip(name, keys, loop=False):
    """keys: list of (frame, spec). Makes an action and keys every pose."""
    arm.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    for frame, spec in keys:
        key(build(spec), frame)
    if loop:
        act.use_cyclic = True
    act.use_frame_range = True
    act.frame_range = (keys[0][0], keys[-1][0])
    return act


def mix(a, b, t):
    """Blend two pose specs (numbers and tuples), for in-betweens and variations."""
    def lerp(x, y):
        if isinstance(x, (tuple, list)):
            return tuple(lerp(p, q) for p, q in zip(x, y))
        return x + (y - x) * t

    out = {}
    for k in set(a) | set(b):
        va, vb = a.get(k, b.get(k)), b.get(k, a.get(k))
        out[k] = mix(va, vb, t) if isinstance(va, dict) else lerp(va, vb)
    return out


def over(base, **changes):
    """A copy of a pose spec with some entries replaced (hips / dicts merged one level)."""
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in base.items()}
    for k, v in changes.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


# ---------------------------------------------------------------------------------------- ground
# Orthodox fighting stance: left foot forward, body turned a little to its right, knees bent,
# hands up (left lead hand in front of the face, right hand by the chin).
STANCE = {
    'hips': {'pos': (0.0, -0.11, 0.0), 'rot': (-25, 10, 0)},
    'chest': (-8, 8, 0),
    'head': (0, 10),
    'lfoot': (-0.20, 0.084, 0.26, -20), 'rfoot': (0.21, 0.084, -0.26, -50),
    'lknee': (-0.3, 0, 1), 'rknee': (0.45, 0, 1),
    'lhand': (-0.17, 1.40, 0.34), 'lelbow': (-0.5, -1, 0), 'lpalm': (1, 0, 0),
    'rhand': (0.11, 1.34, 0.20), 'relbow': (0.5, -1, 0), 'rpalm': (-1, 0, 0),
}
BREATHE = over(STANCE, hips={'pos': (0.0, -0.125, 0.0)}, chest=(-8, 10, 0),
               lhand=(-0.17, 1.38, 0.34), rhand=(0.11, 1.32, 0.20))

# Brawler hooks (DCUO-style wide haymakers): the fist travels a big curved path - cocked out wide to
# the side, swung round at head height with the elbow up, and carried through past the centre line -
# while the hips and shoulders whip round behind it.

# Left hook (lead hand): coil left, then the whole body turns right through the punch.
LHOOK_LOAD = over(STANCE, hips={'pos': (0.02, -0.14, -0.02), 'rot': (8, 12, -4)}, chest=(18, 10, -6),
                  lhand=(-0.60, 1.34, -0.02), lelbow=(-1, 0.1, -0.5), lpalm=(0, -1, 0),
                  rhand=(0.12, 1.34, 0.18), head=(0, 10))
LHOOK_MID = over(STANCE, hips={'pos': (0.0, -0.13, 0.03), 'rot': (-18, 13, 0)}, chest=(-6, 11, 0),
                 lhand=(-0.52, 1.44, 0.42), lelbow=(-1, 0.6, 0), lpalm=(0, -1, 0),
                 rhand=(0.12, 1.34, 0.18))
LHOOK_HIT = over(STANCE, hips={'pos': (-0.02, -0.12, 0.07), 'rot': (-50, 14, 4)}, chest=(-30, 12, 6),
                 lhand=(0.02, 1.46, 0.56), lelbow=(-1, 0.7, 0), lpalm=(0, -1, 0),
                 rhand=(0.14, 1.32, 0.12), lfoot=(-0.20, 0.10, 0.26, -45), lheel=25)
LHOOK_FOLLOW = over(LHOOK_HIT, hips={'pos': (-0.03, -0.12, 0.08), 'rot': (-62, 15, 5)}, chest=(-38, 12, 7),
                    lhand=(0.30, 1.42, 0.38))

# Right hook (rear hand, the big haymaker): coil far right, heel pivots, everything goes into it.
RHOOK_LOAD = over(STANCE, hips={'pos': (0.03, -0.15, -0.04), 'rot': (-52, 12, 4)}, chest=(-28, 10, 6),
                  rhand=(0.64, 1.34, -0.08), relbow=(1, 0.1, -0.5), rpalm=(0, -1, 0),
                  lhand=(-0.18, 1.40, 0.30), head=(0, 10))
RHOOK_MID = over(STANCE, hips={'pos': (0.0, -0.13, 0.04), 'rot': (-8, 14, 0)}, chest=(4, 12, 0),
                 rhand=(0.56, 1.46, 0.44), relbow=(1, 0.6, 0), rpalm=(0, -1, 0),
                 lhand=(-0.20, 1.38, 0.24), rfoot=(0.21, 0.11, -0.26, -30), rheel=25)
RHOOK_HIT = over(STANCE, hips={'pos': (-0.04, -0.11, 0.10), 'rot': (38, 16, -4)}, chest=(30, 13, -6),
                 rhand=(-0.04, 1.48, 0.60), relbow=(1, 0.75, 0), rpalm=(0, -1, 0),
                 lhand=(-0.22, 1.34, 0.12), lpalm=(1, 0, 0),
                 rfoot=(0.21, 0.14, -0.26, -5), rheel=45, rknee=(-0.3, 0, 1))
RHOOK_FOLLOW = over(RHOOK_HIT, hips={'pos': (-0.05, -0.11, 0.11), 'rot': (55, 17, -5)}, chest=(40, 13, -7),
                    rhand=(-0.36, 1.42, 0.36))

# Uppercut finisher (rear right): sink low, drive up off the back leg, fist rises through the chin.
UPPER_LOAD = over(STANCE, hips={'pos': (0.02, -0.24, -0.02), 'rot': (-30, 20, -6)}, chest=(-12, 16, -8),
                  rhand=(0.20, 1.00, 0.12), relbow=(0.3, -1, -0.3), rpalm=(-0.5, 0, -1),
                  lhand=(-0.15, 1.30, 0.28), head=(0, 14))
UPPER_HIT = over(STANCE, hips={'pos': (-0.02, -0.02, 0.06), 'rot': (15, -4, 4)}, chest=(22, -8, 6),
                 rhand=(0.0, 1.60, 0.42), relbow=(0.25, -1, 0.35), rpalm=(0, 0, -1),
                 lhand=(-0.20, 1.32, 0.12), rfoot=(0.21, 0.14, -0.26, -15), rheel=45, rknee=(-0.2, 0, 1),
                 head=(0, -8))
UPPER_FOLLOW = over(UPPER_HIT, hips={'pos': (-0.03, 0.0, 0.07), 'rot': (20, -8, 5)}, chest=(26, -12, 7),
                    rhand=(-0.04, 1.72, 0.36))

# Flying lunge (hold attack): crouch and spring, fly in flat like a missile with the right fist
# cocked back, then uncork a full-force right hook on arrival and drop back into the stance.
# (The game moves the hero; the clip stays in place.)
LUNGE_CROUCH = over(STANCE, hips={'pos': (0.0, -0.28, -0.04), 'rot': (-20, 30, 0)}, chest=(-10, 18, 0),
                    lhand=(-0.30, 1.05, -0.10), rhand=(0.40, 1.00, -0.25), relbow=(1, 0.2, -0.5),
                    head=(0, -10))
LUNGE_FLY = {
    'hips': {'pos': (0.0, 0.0, 0.0), 'rot': (-15, 72, 0)}, 'chest': (-10, 8, 0), 'head': (0, -5),
    'lreach': ((-0.05, -0.15, 1), 0.95), 'lelbow': (-1, -0.5, 0), 'lpalm': (0, -1, 0),
    'rhand': (0.62, 1.10, -0.35), 'relbow': (1, 0.4, -0.6), 'rpalm': (0, -1, 0),
    'lfoot': (-0.10, 0.95, -0.85, 0), 'rfoot': (0.12, 0.82, -0.80, 0),
    'lknee': (0, -1, 0), 'rknee': (0, -1, 0.3),
}
LUNGE_FLY2 = over(LUNGE_FLY, hips={'pos': (0.0, 0.02, 0.0), 'rot': (-18, 70, 0)},
                  rhand=(0.66, 1.14, -0.40), lfoot=(-0.10, 0.90, -0.86, 0), rfoot=(0.12, 0.88, -0.82, 0))
LUNGE_HIT = {
    'hips': {'pos': (-0.04, -0.02, 0.10), 'rot': (40, 28, -6)}, 'chest': (32, 10, -8), 'head': (0, 0),
    'rhand': (-0.05, 1.42, 0.68), 'relbow': (1, 0.75, 0), 'rpalm': (0, -1, 0),
    'lhand': (-0.30, 1.20, 0.05), 'lelbow': (-1, -0.5, 0), 'lpalm': (1, 0, 0),
    'lfoot': (-0.18, 0.45, 0.15, -20), 'rfoot': (0.20, 0.35, -0.45, -10),
    'lknee': (-0.2, 0, 1), 'rknee': (0.2, -0.5, 1),
}
LUNGE_FOLLOW = over(LUNGE_HIT, hips={'pos': (-0.05, -0.06, 0.12), 'rot': (58, 22, -7)}, chest=(42, 10, -9),
                    rhand=(-0.40, 1.36, 0.40), lfoot=(-0.18, 0.20, 0.20, -20), rfoot=(0.20, 0.18, -0.40, -15))

clip('g_stance', [(0, STANCE), (20, BREATHE), (40, STANCE)], loop=True)
clip('g_jab1', [(0, STANCE), (4, LHOOK_LOAD), (6, LHOOK_MID), (7, LHOOK_HIT), (10, LHOOK_FOLLOW), (18, STANCE)])
clip('g_jab2', [(0, STANCE), (5, RHOOK_LOAD), (8, RHOOK_MID), (9, RHOOK_HIT), (13, RHOOK_FOLLOW), (22, STANCE)])
clip('g_jab3', [(0, STANCE), (7, UPPER_LOAD), (10, UPPER_HIT), (14, UPPER_FOLLOW), (26, STANCE)])
clip('g_lunge', [(0, STANCE), (4, LUNGE_CROUCH), (7, LUNGE_FLY), (15, LUNGE_FLY2), (17, mix(LUNGE_FLY2, LUNGE_HIT, 0.4)),
                 (18, LUNGE_HIT), (22, LUNGE_FOLLOW), (32, STANCE)])

# ---------------------------------------------------------------------------------------- air
# The same punches in mid-air. The upper body is the ground version; the legs dangle (toes pointed)
# and swing as a counterweight to every punch instead of planting: knee drives up on the wind-up,
# legs scissor through the hook, tuck into a ball before the uppercut and snap straight as it lands.


def air(pose, l, r, y=0.0, lk=(0, 0, 1), rk=(0, 0, 1), heel=(55, 55)):
    """Ground pose -> air pose: hips at flying height, feet hanging at l / r (x, y, z, yaw)."""
    hp = dict(pose['hips'])
    hp['pos'] = (hp['pos'][0], y, hp['pos'][2])
    return over(pose, hips=hp, lfoot=l, rfoot=r, lknee=lk, rknee=rk, lheel=heel[0], rheel=heel[1])


HOVER_L, HOVER_R = (-0.12, 0.22, 0.06, -5), (0.13, 0.30, -0.14, 5)
A_IDLE = air(STANCE, HOVER_L, HOVER_R)

A_LHOOK_LOAD = air(LHOOK_LOAD, (-0.15, 0.30, -0.18, 0), (0.10, 0.50, 0.24, 0))          # right knee up
A_LHOOK_MID = air(LHOOK_MID, (-0.12, 0.30, 0.0, 0), (0.12, 0.42, 0.10, 0))
A_LHOOK_HIT = air(LHOOK_HIT, (-0.02, 0.42, 0.28, -20), (0.20, 0.22, -0.32, 10))          # scissor
A_LHOOK_FOLLOW = air(LHOOK_FOLLOW, (0.02, 0.44, 0.32, -25), (0.22, 0.20, -0.36, 12))

A_RHOOK_LOAD = air(RHOOK_LOAD, (-0.10, 0.50, 0.24, 0), (0.16, 0.26, -0.20, 0))           # left knee up
A_RHOOK_MID = air(RHOOK_MID, (-0.12, 0.42, 0.10, 0), (0.14, 0.30, 0.0, 0))
A_RHOOK_HIT = air(RHOOK_HIT, (-0.20, 0.22, -0.32, -10), (0.02, 0.44, 0.30, 20))          # scissor
A_RHOOK_FOLLOW = air(RHOOK_FOLLOW, (-0.22, 0.20, -0.36, -12), (-0.02, 0.46, 0.34, 25))

A_UPPER_LOAD = air(UPPER_LOAD, (-0.12, 0.56, 0.18, 0), (0.12, 0.52, 0.12, 0), y=-0.05)   # tucked
A_UPPER_HIT = air(UPPER_HIT, (-0.10, 0.06, -0.12, 0), (0.14, 0.04, -0.22, 0), y=0.05, heel=(70, 70))  # snapped straight
A_UPPER_FOLLOW = air(UPPER_FOLLOW, (-0.10, 0.08, -0.18, 0), (0.14, 0.06, -0.26, 0), y=0.06, heel=(70, 70))

clip('a_jab1', [(0, A_IDLE), (4, A_LHOOK_LOAD), (6, A_LHOOK_MID), (7, A_LHOOK_HIT), (10, A_LHOOK_FOLLOW), (18, A_IDLE)])
clip('a_jab2', [(0, A_IDLE), (5, A_RHOOK_LOAD), (8, A_RHOOK_MID), (9, A_RHOOK_HIT), (13, A_RHOOK_FOLLOW), (22, A_IDLE)])
clip('a_jab3', [(0, A_IDLE), (7, A_UPPER_LOAD), (10, A_UPPER_HIT), (14, A_UPPER_FOLLOW), (26, A_IDLE)])

TIMING = {
    'g_stance': {'loop': True},
    'g_jab1': {'hit': [7], 'cancel': 12, 'length': 18},
    'g_jab2': {'hit': [9], 'cancel': 15, 'length': 22},
    'g_jab3': {'hit': [10], 'cancel': 18, 'length': 26},
    'g_lunge': {'hit': [18], 'cancel': 26, 'length': 32, 'launch': 5},  # launch: frame the hero takes off
    'a_jab1': {'hit': [7], 'cancel': 12, 'length': 18},
    'a_jab2': {'hit': [9], 'cancel': 15, 'length': 22},
    'a_jab3': {'hit': [10], 'cancel': 18, 'length': 26},
}

# ---------------------------------------------------------------------------------------- export
os.makedirs(OUT, exist_ok=True)
arm.animation_data.action = bpy.data.actions['g_stance']
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'hero_combat.blend'))
# Animations-only file: select just the armature
for o in bpy.data.objects:
    o.select_set(o == arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.export_scene.gltf(
    filepath=os.path.join(OUT, 'hero_combat.glb'), export_format='GLB', use_selection=True,
    export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
    export_frame_range=False, export_skins=True, export_morph=False,
)
with open(os.path.join(OUT, 'hero_combat.json'), 'w') as fh:
    json.dump({'fps': FPS, 'clips': TIMING}, fh, indent=2)
print('BUILT', [a.name for a in bpy.data.actions])
