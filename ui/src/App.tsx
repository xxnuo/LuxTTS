import { useState, useRef, useCallback, useEffect } from "react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  uploadPrompt,
  deletePrompt,
  listPrompts,
  generateSpeech,
  getStatus,
  type TTSParams,
} from "@/lib/api"
import {
  Microphone,
  Play,
  Pause,
  Trash,
  UploadSimple,
  SpeakerHigh,
  Waveform,
  DownloadSimple,
  Lightning,
  GearSix,
  X,
} from "@phosphor-icons/react"

interface PromptInfo {
  id: string
  name: string
}

interface GenerationResult {
  url: string
  time: number | null
  text: string
}

export default function App() {
  const [status, setStatus] = useState<{
    ready: boolean
    device: string
  } | null>(null)
  const [prompts, setPrompts] = useState<PromptInfo[]>([])
  const [selectedPrompt, setSelectedPrompt] = useState("")
  const [text, setText] = useState("")
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [results, setResults] = useState<GenerationResult[]>([])
  const [playingIdx, setPlayingIdx] = useState<number | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState("")

  const [numSteps, setNumSteps] = useState(4)
  const [guidanceScale, setGuidanceScale] = useState(3.0)
  const [tShift, setTShift] = useState(0.5)
  const [speed, setSpeed] = useState(1.0)
  const [returnSmooth, setReturnSmooth] = useState(false)
  const [refDuration, setRefDuration] = useState(5)
  const [promptRms, setPromptRms] = useState(0.01)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioRefs = useRef<Map<number, HTMLAudioElement>>(new Map())

  const refreshPrompts = useCallback(async () => {
    try {
      const list = await listPrompts()
      setPrompts(list)
      if (list.length > 0 && !list.find((p) => p.id === selectedPrompt)) {
        setSelectedPrompt(list[0].id)
      }
    } catch {
      /* ignore */
    }
  }, [selectedPrompt])

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getStatus()
      setStatus(s)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    refreshStatus()
    refreshPrompts()
    const iv = setInterval(refreshStatus, 5000)
    return () => clearInterval(iv)
  }, [refreshStatus, refreshPrompts])

  const handleFileUpload = async (file: File) => {
    if (!file.type.startsWith("audio/")) {
      setError("Please upload an audio file (WAV/MP3)")
      return
    }
    setUploading(true)
    setError("")
    try {
      const result = await uploadPrompt(file, {
        duration: refDuration,
        rms: promptRms,
        name: file.name.replace(/\.[^.]+$/, ""),
      })
      await refreshPrompts()
      setSelectedPrompt(result.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFileUpload(file)
  }

  const handleDeletePrompt = async (id: string) => {
    try {
      await deletePrompt(id)
      await refreshPrompts()
      if (selectedPrompt === id) setSelectedPrompt("")
    } catch {
      /* ignore */
    }
  }

  const handleGenerate = async () => {
    if (!text.trim() || !selectedPrompt) return
    setGenerating(true)
    setError("")
    try {
      const params: TTSParams = {
        text: text.trim(),
        prompt_id: selectedPrompt,
        num_steps: numSteps,
        guidance_scale: guidanceScale,
        t_shift: tShift,
        speed,
        return_smooth: returnSmooth,
        ref_duration: refDuration,
      }
      const { blob, generationTime } = await generateSpeech(params)
      const url = URL.createObjectURL(blob)
      setResults((prev) => [
        { url, time: generationTime, text: text.trim() },
        ...prev,
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed")
    } finally {
      setGenerating(false)
    }
  }

  const togglePlay = (idx: number) => {
    const audio = audioRefs.current.get(idx)
    if (!audio) return
    if (playingIdx === idx) {
      audio.pause()
      setPlayingIdx(null)
    } else {
      if (playingIdx !== null) {
        audioRefs.current.get(playingIdx)?.pause()
      }
      audio.currentTime = 0
      audio.play()
      setPlayingIdx(idx)
      audio.onended = () => setPlayingIdx(null)
    }
  }

  const removeResult = (idx: number) => {
    const r = results[idx]
    if (r) URL.revokeObjectURL(r.url)
    audioRefs.current.get(idx)?.pause()
    if (playingIdx === idx) setPlayingIdx(null)
    setResults((prev) => prev.filter((_, i) => i !== idx))
  }

  const ready = status?.ready ?? false

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/80 px-6 py-3 backdrop-blur-sm">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <div className="flex items-center gap-3">
            <Waveform className="size-5 text-primary" weight="duotone" />
            <h1 className="text-sm font-semibold tracking-tight">LuxTTS</h1>
          </div>
          <div className="flex items-center gap-3">
            <Badge
              variant={ready ? "default" : "outline"}
              className={
                ready
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : ""
              }
            >
              <span
                className={`mr-1 inline-block size-1.5 rounded-full ${ready ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`}
              />
              {ready ? `Ready · ${status?.device}` : "Connecting..."}
            </Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-6">
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Microphone className="size-4" weight="duotone" />
                  Voice Prompt
                </CardTitle>
                <CardDescription>
                  Upload a reference audio for voice cloning (min 3s)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div
                  role="button"
                  tabIndex={0}
                  className={`relative flex cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed p-8 transition-colors ${
                    dragOver
                      ? "border-primary bg-primary/5"
                      : "border-muted-foreground/20 hover:border-muted-foreground/40"
                  } ${uploading ? "pointer-events-none opacity-50" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOver(true)
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      fileInputRef.current?.click()
                    }
                  }}
                >
                  {uploading ? (
                    <Spinner className="size-6" />
                  ) : (
                    <UploadSimple
                      className="size-6 text-muted-foreground"
                      weight="duotone"
                    />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {uploading
                      ? "Encoding prompt..."
                      : "Drop audio here or click to browse"}
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) handleFileUpload(f)
                      e.target.value = ""
                    }}
                  />
                </div>

                {prompts.length > 0 && (
                  <div className="space-y-2">
                    <Label>Select Prompt</Label>
                    <div className="flex items-center gap-2">
                      <Select
                        value={selectedPrompt}
                        onValueChange={setSelectedPrompt}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Choose a voice prompt" />
                        </SelectTrigger>
                        <SelectContent>
                          {prompts.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selectedPrompt && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleDeletePrompt(selectedPrompt)}
                        >
                          <Trash className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <SpeakerHigh className="size-4" weight="duotone" />
                  Text to Speech
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Textarea
                  placeholder="Enter text to synthesize..."
                  className="min-h-28 resize-none"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      handleGenerate()
                    }
                  }}
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {text.length > 0 ? `${text.trim().split(/\s+/).length} words` : ""}
                  </span>
                  <Button
                    onClick={handleGenerate}
                    disabled={
                      !ready || !text.trim() || !selectedPrompt || generating
                    }
                    className="gap-2"
                  >
                    {generating ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <Lightning className="size-3.5" weight="fill" />
                    )}
                    {generating ? "Generating..." : "Generate"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {results.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Waveform className="size-4" weight="duotone" />
                    Results
                    <Badge variant="secondary" className="ml-auto">
                      {results.length}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {results.map((r, i) => (
                    <div
                      key={r.url}
                      className="group flex items-center gap-3 border p-3 transition-colors hover:bg-muted/30"
                    >
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => togglePlay(i)}
                        className="shrink-0"
                      >
                        {playingIdx === i ? (
                          <Pause className="size-4" weight="fill" />
                        ) : (
                          <Play className="size-4" weight="fill" />
                        )}
                      </Button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs">{r.text}</p>
                        {r.time !== null && (
                          <span className="text-[10px] text-muted-foreground">
                            {r.time.toFixed(2)}s
                          </span>
                        )}
                      </div>
                      <a href={r.url} download="output.wav">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                          asChild
                        >
                          <span>
                            <DownloadSimple className="size-3.5" />
                          </span>
                        </Button>
                      </a>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeResult(i)}
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <X className="size-3.5" />
                      </Button>
                      <audio
                        ref={(el) => {
                          if (el) audioRefs.current.set(i, el)
                          else audioRefs.current.delete(i)
                        }}
                        src={r.url}
                        preload="auto"
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>

          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <GearSix className="size-4" weight="duotone" />
                  Parameters
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <ParamSlider
                  label="Steps"
                  value={numSteps}
                  min={1}
                  max={16}
                  step={1}
                  onChange={setNumSteps}
                />
                <ParamSlider
                  label="T-Shift"
                  value={tShift}
                  min={0.1}
                  max={1.0}
                  step={0.05}
                  onChange={setTShift}
                />
                <ParamSlider
                  label="Speed"
                  value={speed}
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  onChange={setSpeed}
                />
                <ParamSlider
                  label="Ref Duration"
                  value={refDuration}
                  min={1}
                  max={30}
                  step={1}
                  onChange={setRefDuration}
                  unit="s"
                />

                <div className="flex items-center justify-between">
                  <Label htmlFor="smooth-switch" className="text-xs">
                    Smooth Mode
                  </Label>
                  <Switch
                    id="smooth-switch"
                    size="sm"
                    checked={returnSmooth}
                    onCheckedChange={setReturnSmooth}
                  />
                </div>

                <button
                  type="button"
                  className="w-full text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  {showAdvanced ? "- Hide" : "+ Show"} advanced
                </button>

                {showAdvanced && (
                  <div className="space-y-5 border-t pt-4">
                    <ParamSlider
                      label="Guidance Scale"
                      value={guidanceScale}
                      min={1.0}
                      max={10.0}
                      step={0.5}
                      onChange={setGuidanceScale}
                    />
                    <ParamSlider
                      label="Prompt RMS"
                      value={promptRms}
                      min={0.001}
                      max={0.1}
                      step={0.001}
                      onChange={setPromptRms}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {error && (
          <div className="mt-4 border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => setError("")}
            >
              dismiss
            </button>
          </div>
        )}
      </main>

      <footer className="border-t px-6 py-3 text-center text-[10px] text-muted-foreground">
        LuxTTS &middot; Apache-2.0 License
      </footer>
    </div>
  )
}

function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit = "",
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  unit?: string
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {step < 1 ? value.toFixed(step < 0.01 ? 3 : 2) : value}
          {unit}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  )
}
