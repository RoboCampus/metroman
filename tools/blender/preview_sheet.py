"""Render contact sheets of the combat clips (for checking poses and timing).

  blender --background assets/anims/hero_combat.blend --python tools/blender/preview_sheet.py -- [clip ...]

Writes assets/anims/preview/<clip>.png: two rows (3/4 front view, side view), one column per frame.
"""
import math
import os
import sys
import bpy
import numpy as np
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'anims', 'preview')
os.makedirs(OUT, exist_ok=True)
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
W, H = 260, 340

scene = bpy.context.scene
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'MATERIAL'
scene.display.shading.show_cavity = True
scene.render.resolution_x, scene.render.resolution_y = W, H
scene.render.film_transparent = False
scene.render.image_settings.file_format = 'PNG'
if scene.world is None:
    scene.world = bpy.data.worlds.new('World')
scene.world.color = (0.16, 0.17, 0.2)

# Ground grid so foot placement and height read clearly
bpy.ops.mesh.primitive_grid_add(x_subdivisions=12, y_subdivisions=12, size=4)
grid = bpy.context.active_object
grid.display_type = 'WIRE'
mat = bpy.data.materials.new('floor')
mat.diffuse_color = (0.35, 0.36, 0.4, 1)
bpy.ops.mesh.primitive_plane_add(size=4, location=(0, 0, -0.001))
bpy.context.active_object.data.materials.append(mat)

cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 2.6
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
VIEWS = {
    'front34': (Vector((-2.6, -3.4, 1.3)), Vector((0, -0.15, 0.95))),  # from the hero's front-right
    'side': (Vector((-4.0, -0.25, 1.1)), Vector((0, -0.25, 0.95))),    # from the hero's right side
}


def look(eye, target):
    cam.location = eye
    cam.rotation_euler = (target - eye).to_track_quat('-Z', 'Y').to_euler()


def render(path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)
    bpy.data.images.remove(img)
    return px


clips = argv or sorted(a.name for a in bpy.data.actions if a.name.startswith(('g_', 'a_')))
tmp = os.path.join(OUT, '_frame.png')
for name in clips:
    act = bpy.data.actions[name]
    arm.animation_data.action = act
    if arm.animation_data.action_slot is None and len(act.slots):
        arm.animation_data.action_slot = act.slots[0]
    f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
    frames = sorted(set([f0, f1] + list(range(f0, f1 + 1, max(1, (f1 - f0) // 7)))))
    rows = []
    for view, (eye, target) in VIEWS.items():
        look(eye, target)
        row = []
        for f in frames:
            scene.frame_set(f)
            row.append(render(tmp))
        rows.append(np.concatenate(row, axis=1))
    sheet = np.concatenate(rows[::-1], axis=0)  # images are stored bottom-up: first view on top
    out = bpy.data.images.new(name, sheet.shape[1], sheet.shape[0], alpha=True)
    out.pixels = sheet.ravel().tolist()
    out.filepath_raw = os.path.join(OUT, name + '.png')
    out.file_format = 'PNG'
    out.save()
    print('SHEET', name, 'frames', frames)
os.remove(tmp)
