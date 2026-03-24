import io
import os
import uuid
import time
import tempfile
from pathlib import Path
from contextlib import asynccontextmanager

import torch
import soundfile as sf
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from zipvoice.luxvoice import LuxTTS


def _detect_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


DEVICE = os.environ.get("LUXTTS_DEVICE", _detect_device())
THREADS = int(os.environ.get("LUXTTS_THREADS", "4"))

tts: LuxTTS | None = None
prompts: dict[str, dict] = {}

SAMPLES_DIR = Path(__file__).parent / "samples"

BUILTIN_VOICES: dict[str, dict] = {}

VOICE_TRANSCRIPTS: dict[str, str] = {
    "en_female": "Hello there! I hope you are having a wonderful day. The weather is absolutely beautiful today, perfect for a walk in the park.",
    "en_male": "Good morning everyone. Today we are going to discuss some really interesting topics about technology and innovation in the modern world.",
    "zh_female": "大家好，欢迎来到我们的节目。今天天气非常好，阳光明媚，万里无云，是个出门散步的好日子。",
    "zh_male": "各位朋友大家好，非常高兴能够在这里和大家见面。今天我们来聊一些有趣的话题，希望大家喜欢。",
}

RESPONSE_FORMATS = {
    "wav": ("audio/wav", "WAV"),
    "flac": ("audio/flac", "FLAC"),
    "pcm": ("audio/pcm", None),
    "mp3": ("audio/mpeg", None),
}


def _encode_audio(wav_np, fmt: str) -> tuple[io.BytesIO, str]:
    buf = io.BytesIO()
    if fmt == "pcm":
        import numpy as np
        pcm = (wav_np * 32767).astype(np.int16)
        buf.write(pcm.tobytes())
    elif fmt == "mp3":
        try:
            import lameenc
            import numpy as np
            encoder = lameenc.Encoder()
            encoder.set_bit_rate(192)
            encoder.set_in_sample_rate(48000)
            encoder.set_channels(1)
            encoder.set_quality(2)
            pcm = (wav_np * 32767).astype(np.int16).tobytes()
            buf.write(encoder.encode(pcm))
            buf.write(encoder.flush())
        except ImportError:
            sf.write(buf, wav_np, 48000, format="WAV")
            fmt = "wav"
    else:
        sf_fmt = RESPONSE_FORMATS.get(fmt, ("audio/wav", "WAV"))[1] or "WAV"
        sf.write(buf, wav_np, 48000, format=sf_fmt)
    buf.seek(0)
    mime = RESPONSE_FORMATS.get(fmt, ("audio/wav",))[0]
    return buf, mime


def _preload_voices():
    if tts is None or not SAMPLES_DIR.is_dir():
        return
    exts = {".wav", ".mp3", ".flac", ".ogg"}
    for f in sorted(SAMPLES_DIR.iterdir()):
        if f.suffix.lower() in exts and f.is_file():
            voice_name = f.stem
            transcript = VOICE_TRANSCRIPTS.get(voice_name, "")
            if not transcript:
                continue
            try:
                encoded = tts.encode_prompt(str(f), rms=0.01, prompt_text=transcript)
                BUILTIN_VOICES[voice_name] = {"encoded": encoded, "name": voice_name}
                print(f"  Voice loaded: {voice_name}")
            except Exception as e:
                print(f"  Failed to load voice {voice_name}: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global tts
    print(f"Loading LuxTTS model on {DEVICE}...")
    tts = LuxTTS("YatharthS/LuxTTS", device=DEVICE, threads=THREADS)
    print("Model loaded.")
    print("Pre-loading built-in voices...")
    _preload_voices()
    print(f"Voices ready: {list(BUILTIN_VOICES.keys())}")
    yield
    tts = None


app = FastAPI(title="LuxTTS API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Generation-Time"],
)

ui_dist = Path(__file__).parent / "ui" / "dist"

if SAMPLES_DIR.is_dir():
    app.mount("/api/samples/audio", StaticFiles(directory=str(SAMPLES_DIR)), name="samples_audio")
if ui_dist.is_dir():
    app.mount("/ui", StaticFiles(directory=str(ui_dist), html=True), name="ui")


def _resolve_voice(voice: str) -> dict | None:
    if voice in BUILTIN_VOICES:
        return BUILTIN_VOICES[voice]
    if voice in prompts:
        return prompts[voice]
    for v in BUILTIN_VOICES.values():
        if v["name"] == voice:
            return v
    for v in prompts.values():
        if v["name"] == voice:
            return v
    return None


def _generate_wav(text: str, encoded: dict, speed: float = 1.0, num_steps: int = 4,
                  guidance_scale: float = 3.0, t_shift: float = 0.5, return_smooth: bool = False):
    wav = tts.generate_speech(
        text, encoded,
        num_steps=num_steps,
        guidance_scale=guidance_scale,
        t_shift=t_shift,
        speed=speed,
        return_smooth=return_smooth,
    )
    return wav.numpy().squeeze()


# ── OpenAI-compatible API ──────────────────────────────────────────

class SpeechRequest(BaseModel):
    model: str = "luxtts"
    input: str
    voice: str = "en_female"
    response_format: str = "wav"
    speed: float = Field(default=1.0, ge=0.25, le=4.0)


@app.post("/v1/audio/speech")
async def openai_speech(req: SpeechRequest):
    if tts is None:
        raise HTTPException(503, detail="Model not loaded")

    voice_data = _resolve_voice(req.voice)
    if voice_data is None:
        available = list(BUILTIN_VOICES.keys()) + [v["name"] for v in prompts.values()]
        raise HTTPException(400, detail=f"Voice '{req.voice}' not found. Available: {available}")

    if not req.input.strip():
        raise HTTPException(400, detail="Input text is empty")

    fmt = req.response_format if req.response_format in RESPONSE_FORMATS else "wav"

    t0 = time.time()
    wav_np = _generate_wav(req.input, voice_data["encoded"], speed=req.speed)
    elapsed = time.time() - t0

    buf, mime = _encode_audio(wav_np, fmt)

    def stream():
        while True:
            chunk = buf.read(8192)
            if not chunk:
                break
            yield chunk

    return StreamingResponse(
        stream(),
        media_type=mime,
        headers={
            "X-Generation-Time": f"{elapsed:.3f}",
            "Content-Disposition": f"attachment; filename=speech.{fmt}",
        },
    )


@app.get("/v1/voices")
async def openai_list_voices():
    voices = []
    for name in BUILTIN_VOICES:
        voices.append({"voice_id": name, "name": name})
    for pid, pdata in prompts.items():
        voices.append({"voice_id": pid, "name": pdata["name"]})
    return {"voices": voices}


@app.get("/v1/models")
async def openai_list_models():
    return {
        "object": "list",
        "data": [
            {"id": "luxtts", "object": "model", "owned_by": "luxtts"},
        ],
    }


# ── Original UI API ──────────────────────────────────────────────

@app.get("/api/status")
async def status():
    return {
        "ready": tts is not None,
        "device": DEVICE,
        "prompts": list(prompts.keys()),
        "voices": list(BUILTIN_VOICES.keys()),
    }


@app.post("/api/prompt/upload")
async def upload_prompt(
    file: UploadFile = File(...),
    rms: float = Form(0.01),
    name: str = Form(""),
    prompt_text: str = Form(...),
):
    if tts is None:
        raise HTTPException(503, "Model not loaded")

    suffix = Path(file.filename or "audio.wav").suffix
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        content = await file.read()
        tmp.write(content)
        tmp.flush()
        tmp.close()

        encoded = tts.encode_prompt(tmp.name, rms=rms, prompt_text=prompt_text)
        prompt_id = uuid.uuid4().hex[:12]
        label = name.strip() or file.filename or prompt_id
        prompts[prompt_id] = {"encoded": encoded, "name": label}
        return {"id": prompt_id, "name": label}
    finally:
        os.unlink(tmp.name)


@app.delete("/api/prompt/{prompt_id}")
async def delete_prompt(prompt_id: str):
    if prompt_id not in prompts:
        raise HTTPException(404, "Prompt not found")
    del prompts[prompt_id]
    return {"ok": True}


@app.get("/api/prompts")
async def list_prompts():
    return [{"id": k, "name": v["name"]} for k, v in prompts.items()]


@app.post("/api/tts")
async def text_to_speech(
    text: str = Form(...),
    prompt_id: str = Form(...),
    num_steps: int = Form(4),
    guidance_scale: float = Form(3.0),
    t_shift: float = Form(0.5),
    speed: float = Form(1.0),
    return_smooth: bool = Form(False),
):
    if tts is None:
        raise HTTPException(503, "Model not loaded")
    voice_data = _resolve_voice(prompt_id)
    if voice_data is None:
        raise HTTPException(404, "Prompt not found, upload one first")

    encoded = voice_data["encoded"]
    t0 = time.time()
    wav_np = _generate_wav(text, encoded, speed=speed, num_steps=num_steps,
                           guidance_scale=guidance_scale, t_shift=t_shift, return_smooth=return_smooth)
    elapsed = time.time() - t0

    buf = io.BytesIO()
    sf.write(buf, wav_np, 48000, format="WAV")
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="audio/wav",
        headers={
            "X-Generation-Time": f"{elapsed:.3f}",
            "Content-Disposition": "attachment; filename=output.wav",
        },
    )


@app.get("/api/samples")
async def list_samples():
    if not SAMPLES_DIR.is_dir():
        return []
    exts = {".wav", ".mp3", ".flac", ".ogg"}
    items = []
    for f in sorted(SAMPLES_DIR.iterdir()):
        if f.suffix.lower() in exts and f.is_file():
            items.append({"file": f.name, "name": f.stem.replace("_", " ").title()})
    return items


@app.post("/api/prompt/sample")
async def upload_sample(
    file: str = Form(...),
    rms: float = Form(0.01),
    name: str = Form(""),
    prompt_text: str = Form(...),
):
    if tts is None:
        raise HTTPException(503, "Model not loaded")
    path = SAMPLES_DIR / file
    if not path.is_file() or not path.resolve().is_relative_to(SAMPLES_DIR.resolve()):
        raise HTTPException(404, "Sample not found")
    encoded = tts.encode_prompt(str(path), rms=rms, prompt_text=prompt_text)
    prompt_id = uuid.uuid4().hex[:12]
    label = name.strip() or path.stem.replace("_", " ").title()
    prompts[prompt_id] = {"encoded": encoded, "name": label}
    return {"id": prompt_id, "name": label}
