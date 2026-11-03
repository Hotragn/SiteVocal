"""Turns record-demo.mjs output into the demo video: H.264 at 30 fps with an AAC narration track.

    python store-assets/shots/make-demo.py <recording-dir> media/sitevocal-demo.mp4 [media/sitevocal-demo.webp]

Video: the kept time ranges of the screencast, joined, each frame held until the next one arrives.
Audio: every utterance spoken during those ranges, rendered with the Windows voice Microsoft David (the voice the
studio used while recording) and placed at the moment the studio started speaking it, cut where the studio stopped.
Optional third argument: an animated WebP preview of the first scene for the README.
Needs Windows (System.Speech), Pillow, NumPy and PyAV.
"""
import json
import os
import subprocess
import sys
import tempfile
import wave
from fractions import Fraction

import av
import numpy as np
from PIL import Image

FPS = 30
RATE = 24000
SIZE = (1920, 1080)

rec_dir, out_mp4 = sys.argv[1], sys.argv[2]
out_webp = sys.argv[3] if len(sys.argv) > 3 else ''
meta = json.load(open(os.path.join(rec_dir, 'meta.json'), encoding='utf-8'))
stamps = sorted(int(f[:-4]) for f in os.listdir(os.path.join(rec_dir, 'frames')) if f.endswith('.jpg'))


def frame_at(ms):
    """The last frame shown at or before ms (or the first one after, at the very start)."""
    lo, hi = 0, len(stamps)
    while lo < hi:
        mid = (lo + hi) // 2
        if stamps[mid] <= ms:
            lo = mid + 1
        else:
            hi = mid
    return stamps[max(lo - 1, 0)]


# Timeline: (video time in ms, recording time in ms) for every output frame.
timeline = []
offsets = []  # where each segment starts in the video, in ms
t_video = 0.0
for seg in meta['segments']:
    offsets.append(t_video)
    n = int((seg['end'] - seg['start']) * FPS / 1000)
    for i in range(n):
        timeline.append(seg['start'] + i * 1000 / FPS)
    t_video += n * 1000 / FPS
total_ms = t_video

# Narration: which utterances play, from when to when, in video time.
clips = []
for u in meta['utterances']:
    if not u['start'] or not u['text'].strip():
        continue
    for seg, off in zip(meta['segments'], offsets):
        if seg['start'] <= u['start'] < seg['end']:
            stop = min(u['end'] or seg['end'], seg['end'])
            clips.append({'text': u['text'], 'rate': u['rate'] or 1, 'at': off + u['start'] - seg['start'], 'until': off + stop - seg['start']})
            break

tmp = tempfile.mkdtemp(prefix='sv-voice-')
jobs = [{'path': os.path.join(tmp, f'{i}.wav'), 'text': c['text'], 'rate': max(-10, min(10, round((c['rate'] - 1) * 10)))} for i, c in enumerate(clips)]
json.dump(jobs, open(os.path.join(tmp, 'jobs.json'), 'w', encoding='utf-8'))
ps = (
    'Add-Type -AssemblyName System.Speech;'
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice("Microsoft David Desktop");'
    f'$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo({RATE}, 16, 1);'
    f'foreach ($j in (Get-Content -Raw -Encoding UTF8 "{os.path.join(tmp, "jobs.json")}" | ConvertFrom-Json)) {{'
    '$s.Rate = $j.rate; $s.SetOutputToWaveFile($j.path, $fmt); $s.Speak($j.text) }; $s.SetOutputToNull()'
)
subprocess.run(['powershell', '-NoProfile', '-Command', ps], check=True)

audio = np.zeros(int(total_ms * RATE / 1000) + RATE, dtype=np.float32)
report = []
for c, j in zip(clips, jobs):
    with wave.open(j['path']) as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    start = int(c['at'] * RATE / 1000)
    room = max(0, int((c['until'] - c['at']) * RATE / 1000))
    piece = pcm[:room]
    fade = min(len(piece), RATE // 50)  # 20 ms fade-out where a sentence is cut
    if len(piece) < len(pcm) and fade:
        piece = piece.copy()
        piece[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
    audio[start:start + len(piece)] += piece
    report.append((len(pcm) / RATE, (c['until'] - c['at']) / 1000))
audio = np.clip(audio[: int(total_ms * RATE / 1000)] * 0.9, -1, 1)

out = av.open(out_mp4, 'w', options={'movflags': '+faststart'})
vs = out.add_stream('libx264', rate=FPS)
vs.width, vs.height, vs.pix_fmt = SIZE[0], SIZE[1], 'yuv420p'
vs.options = {'crf': '20', 'preset': 'slow'}
aus = out.add_stream('aac', rate=48000)
aus.layout = 'mono'
aus.bit_rate = 128000

cache = {}
preview = []
first_seg_frames = int((meta['segments'][0]['end'] - meta['segments'][0]['start']) * FPS / 1000)
for i, t in enumerate(timeline):
    ms = frame_at(t)
    if ms not in cache:
        cache.clear()
        cache[ms] = Image.open(os.path.join(rec_dir, 'frames', f'{ms}.jpg')).convert('RGB').resize(SIZE, Image.LANCZOS)
    img = cache[ms]
    for packet in vs.encode(av.VideoFrame.from_image(img)):
        out.mux(packet)
    if out_webp and i < first_seg_frames and i % 3 == 0:  # 10 fps preview
        preview.append(img.resize((960, 540), Image.LANCZOS))
for packet in vs.encode():
    out.mux(packet)

resampler = av.AudioResampler(format='fltp', layout='mono', rate=48000)
pcm16 = (audio * 32767).astype(np.int16)
for start in range(0, len(pcm16), 4096):
    frame = av.AudioFrame.from_ndarray(pcm16[start:start + 4096].reshape(1, -1), format='s16', layout='mono')
    frame.sample_rate = RATE
    frame.pts = start
    frame.time_base = Fraction(1, RATE)
    for f in resampler.resample(frame):
        for packet in aus.encode(f):
            out.mux(packet)
for f in resampler.resample(None):
    for packet in aus.encode(f):
        out.mux(packet)
for packet in aus.encode():
    out.mux(packet)
out.close()

if out_webp and preview:
    preview[0].save(out_webp, save_all=True, append_images=preview[1:], duration=100, loop=0, quality=72, method=6)

print(f'{out_mp4}: {total_ms / 1000:.1f} s, {len(timeline)} frames, {len(clips)} narrated sentences')
print('voice length vs. time the studio spoke it (s):', ', '.join(f'{a:.1f}/{b:.1f}' for a, b in report))
